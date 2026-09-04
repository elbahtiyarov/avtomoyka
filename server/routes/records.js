const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const pool = require("../db");
const { requireAdmin } = require("../middleware/auth");
const { normalizePhone } = require("./clients");

// Список записей. Фильтры (все необязательные, можно комбинировать):
//   date        — конкретная дата
//   date_from, date_to — диапазон дат
//   q           — текстовый поиск по марке, номеру, «кто принял» и названию бокса
router.get("/", async (req, res, next) => {
  try {
    const { date, date_from, date_to, q } = req.query;
    const baseQuery = `
      SELECT r.*, u.name AS staff_name, b.name AS bay_name, c.name AS client_name, c.phone AS client_phone,
        COALESCE((
          SELECT json_agg(json_build_object('id', rs.service_id, 'name', rs.service_name, 'price', rs.service_price) ORDER BY rs.id)
          FROM record_services rs WHERE rs.record_id = r.id
        ), '[]') AS services
      FROM records r
      LEFT JOIN users u ON u.id = r.staff_id
      LEFT JOIN bays b ON b.id = r.bay_id
      LEFT JOIN clients c ON c.id = r.client_id
    `;

    const conditions = [];
    const params = [];
    let i = 1;

    if (date) { conditions.push(`r.service_date = $${i++}`); params.push(date); }
    if (date_from) { conditions.push(`r.service_date >= $${i++}`); params.push(date_from); }
    if (date_to) { conditions.push(`r.service_date <= $${i++}`); params.push(date_to); }
    if (q && q.trim()) {
      conditions.push(
        `(r.car_brand ILIKE $${i} OR r.car_number ILIKE $${i} OR r.received_by ILIKE $${i} OR b.name ILIKE $${i})`
      );
      params.push(`%${q.trim()}%`);
      i++;
    }

    const whereSql = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const { rows } = await pool.query(
      `${baseQuery} ${whereSql} ORDER BY r.service_date DESC, r.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Итоги за сегодня (машин, выручка, средний чек)
router.get("/summary/today", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*)                AS cars_count,
         COALESCE(SUM(price), 0) AS total_revenue,
         COALESCE(AVG(price), 0) AS avg_check
       FROM records
       WHERE service_date = CURRENT_DATE`
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Новая запись. Сотрудник ("кто принял") берётся из токена — вводить вручную не нужно.
//
// Бонусная программа (необязательна для каждой записи — работает, только если указан
// телефон клиента). Всё, что влияет на сумму и баллы, пересчитывается и проверяется
// на сервере из актуальных данных в базе — цифры, присланные с фронтенда
// (доступные баллы), не принимаются на веру. Это и есть защита от
// того, чтобы кто-то использовал чужой бонус: подобрать номер телефона другого
// клиента гораздо сложнее, чем номер его машины, который виден всем во дворе. А для
// самого списания баллов дополнительно нужен одноразовый SMS-код — это доказывает,
// что телефон прямо сейчас в руках у клиента, а не просто известен третьему лицу.
router.post("/", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      service_date, car_brand, car_number, price, signature, service_ids, bay_id, received_by,
      client_phone, client_name, redeem_points, otp_code, amount_cash, amount_qr,
    } = req.body;

    if (!service_date || !car_brand || !car_number || price == null || !bay_id || !Array.isArray(service_ids) || service_ids.length === 0) {
      return res.status(400).json({
        error: "Обязательны: service_date, car_brand, car_number, price, bay_id, хотя бы одна услуга",
      });
    }

    await client.query("BEGIN");

    // --- Бонусная программа: баллы накапливаются и списываются, без привязки к числу визитов ---
    let loyaltyClient = null;
    let finalPrice = Number(price);
    let actualRedeemed = 0;
    let pointsEarned = 0;

    const phone = normalizePhone(client_phone);
    if (phone) {
      const { rows: settingsRows } = await client.query("SELECT * FROM loyalty_settings WHERE id = 1");
      const settings = settingsRows[0];

      const { rows: clientRows } = await client.query(
        `INSERT INTO clients (phone)
         VALUES ($1)
         ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
         RETURNING *`,
        [phone]
      );
      loyaltyClient = clientRows[0];

      const requestedRedeem = Number(redeem_points) || 0;
      let otpConsumed = false;

      if (requestedRedeem > 0) {
        if (!loyaltyClient.otp_code_hash || !loyaltyClient.otp_expires_at) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Сначала запросите SMS-код для списания баллов" });
        }
        if (new Date(loyaltyClient.otp_expires_at) < new Date()) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Код истёк, запросите новый" });
        }
        if (loyaltyClient.otp_attempts >= 5) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Слишком много попыток, запросите новый код" });
        }
        const codeMatches = otp_code && (await bcrypt.compare(String(otp_code), loyaltyClient.otp_code_hash));
        if (!codeMatches) {
          await client.query("UPDATE clients SET otp_attempts = otp_attempts + 1 WHERE id = $1", [loyaltyClient.id]);
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Неверный код из SMS" });
        }
        otpConsumed = true;
      }

      actualRedeemed = Math.max(0, Math.min(requestedRedeem, Number(loyaltyClient.points_balance), finalPrice));
      finalPrice = Math.max(0, finalPrice - actualRedeemed);

      pointsEarned = Math.round(finalPrice * (settings.points_percent / 100) * 100) / 100;

      await client.query(
        `UPDATE clients
           SET visit_count = visit_count + 1,
               points_balance = points_balance - $1 + $2,
               name = COALESCE($3, name)
               ${otpConsumed ? ", otp_code_hash = NULL, otp_expires_at = NULL, otp_attempts = 0" : ""}
         WHERE id = $4`,
        [actualRedeemed, pointsEarned, (client_name && client_name.trim()) || null, loyaltyClient.id]
      );
    }

    // Наличные + QR должны в сумме сходиться с итоговой суммой к оплате (после
    // возможного списания баллов) — сервер это проверяет, а не полагается на фронтенд.
    const cash = Math.max(0, Number(amount_cash) || 0);
    const qr = Math.max(0, Number(amount_qr) || 0);
    if (Math.abs(cash + qr - finalPrice) > 1) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `Сумма наличных и QR (${cash + qr}) не совпадает с итоговой суммой к оплате (${finalPrice})`,
      });
    }

    const { rows: recRows } = await client.query(
      `INSERT INTO records
         (service_date, car_brand, car_number, price, staff_id, received_by, bay_id, signature,
          client_id, points_earned, points_redeemed, amount_cash, amount_qr)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        service_date,
        car_brand.trim(),
        car_number.trim(),
        finalPrice,
        req.user.id,
        (received_by && received_by.trim()) || req.user.name,
        bay_id,
        signature || null,
        loyaltyClient ? loyaltyClient.id : null,
        pointsEarned,
        actualRedeemed,
        cash,
        qr,
      ]
    );
    const record = recRows[0];

    const { rows: services } = await client.query(
      "SELECT id, name, price FROM services WHERE id = ANY($1::int[])",
      [service_ids]
    );
    for (const s of services) {
      await client.query(
        `INSERT INTO record_services (record_id, service_id, service_name, service_price)
         VALUES ($1,$2,$3,$4)`,
        [record.id, s.id, s.name, s.price]
      );
    }

    await client.query("COMMIT");
    req.app.get("broadcast")();
    res.status(201).json({ ...record, services });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

// Изменить запись целиком (только администратор)
router.put("/:id", requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { service_date, car_brand, car_number, price, signature, service_ids, bay_id, received_by, amount_cash, amount_qr } = req.body;

    if (!service_date || !car_brand || !car_number || price == null || !bay_id || !received_by ||
        !Array.isArray(service_ids) || service_ids.length === 0) {
      return res.status(400).json({
        error: "Обязательны: service_date, car_brand, car_number, price, bay_id, received_by, хотя бы одна услуга",
      });
    }

    const cash = Math.max(0, Number(amount_cash) || 0);
    const qr = Math.max(0, Number(amount_qr) || 0);
    if (Math.abs(cash + qr - Number(price)) > 1) {
      return res.status(400).json({
        error: `Сумма наличных и QR (${cash + qr}) не совпадает с ценой (${price})`,
      });
    }

    await client.query("BEGIN");

    const hasSignature = Object.prototype.hasOwnProperty.call(req.body, "signature");
    const { rows: recRows } = await client.query(
      hasSignature
        ? `UPDATE records
             SET service_date=$1, car_brand=$2, car_number=$3, price=$4, bay_id=$5, received_by=$6, signature=$7, amount_cash=$8, amount_qr=$9
           WHERE id=$10 RETURNING *`
        : `UPDATE records
             SET service_date=$1, car_brand=$2, car_number=$3, price=$4, bay_id=$5, received_by=$6, amount_cash=$7, amount_qr=$8
           WHERE id=$9 RETURNING *`,
      hasSignature
        ? [service_date, car_brand.trim(), car_number.trim(), price, bay_id, received_by.trim(), signature || null, cash, qr, req.params.id]
        : [service_date, car_brand.trim(), car_number.trim(), price, bay_id, received_by.trim(), cash, qr, req.params.id]
    );
    if (recRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Запись не найдена" });
    }
    const record = recRows[0];

    await client.query("DELETE FROM record_services WHERE record_id = $1", [record.id]);
    const { rows: services } = await client.query(
      "SELECT id, name, price FROM services WHERE id = ANY($1::int[])",
      [service_ids]
    );
    for (const s of services) {
      await client.query(
        `INSERT INTO record_services (record_id, service_id, service_name, service_price)
         VALUES ($1,$2,$3,$4)`,
        [record.id, s.id, s.name, s.price]
      );
    }

    await client.query("COMMIT");
    req.app.get("broadcast")();
    res.json({ ...record, services });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

// Удаление записи
router.delete("/:id", async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM records WHERE id = $1", [req.params.id]);
    const record = rows[0];
    if (record && record.client_id) {
      // возвращаем клиенту списанные баллы и отменяем начисленные/визит,
      // чтобы удаление ошибочной записи не искажало его бонусный баланс
      await client.query(
        `UPDATE clients
           SET visit_count = GREATEST(0, visit_count - 1),
               points_balance = points_balance + $1 - $2
         WHERE id = $3`,
        [record.points_redeemed, record.points_earned, record.client_id]
      );
    }
    await client.query("DELETE FROM records WHERE id = $1", [req.params.id]);
    await client.query("COMMIT");
    req.app.get("broadcast")();
    res.status(204).send();
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
