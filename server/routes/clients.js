const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const pool = require("../db");
const { requireAdmin } = require("../middleware/auth");
const { sendCode } = require("../services/notify");
const { normalizePhone } = require("../utils/phone");

// Список клиентов бонусной программы (поиск по имени/телефону: /clients?q=...)
router.get("/", async (req, res, next) => {
  try {
    const { q } = req.query;
    const { rows } = q && q.trim()
      ? await pool.query(
          "SELECT * FROM clients WHERE active = true AND (name ILIKE $1 OR phone ILIKE $1) ORDER BY visit_count DESC, name",
          [`%${q.trim()}%`]
        )
      : await pool.query("SELECT * FROM clients WHERE active = true ORDER BY visit_count DESC, name");
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Скрыть клиента из списка (не удаляем — на него могут ссылаться старые записи
// в журнале, а сам номер остаётся рабочим для бонусов, если понадобится)
router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    await pool.query("UPDATE clients SET active = false WHERE id = $1", [req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Добавить клиента вручную (имя + телефон) — не дожидаясь первой записи в журнале
router.post("/", async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const { name } = req.body;
    if (!phone) return res.status(400).json({ error: "Укажите телефон" });

    const { rows } = await pool.query(
      `INSERT INTO clients (phone, name)
       VALUES ($1, $2)
       ON CONFLICT (phone) DO UPDATE SET name = COALESCE(EXCLUDED.name, clients.name), active = true
       RETURNING *`,
      [phone, (name && name.trim()) || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Ручная правка карточки клиента — исправление ошибок (только администратор)
router.put("/:id", requireAdmin, async (req, res, next) => {
  try {
    const { name, visit_count, points_balance, points_percent_override } = req.body;
    if (visit_count == null || visit_count < 0 || points_balance == null || points_balance < 0) {
      return res.status(400).json({ error: "Проверьте количество визитов и баллы" });
    }
    const override = points_percent_override === "" || points_percent_override == null
      ? null
      : Number(points_percent_override);
    if (override != null && (Number.isNaN(override) || override < 0)) {
      return res.status(400).json({ error: "Проверьте личный процент баллов" });
    }
    const { rows } = await pool.query(
      `UPDATE clients SET name = $1, visit_count = $2, points_balance = $3, points_percent_override = $4 WHERE id = $5
       RETURNING *`,
      [(name && name.trim()) || null, visit_count, points_balance, override, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Клиент не найден" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Запросить SMS-код для списания баллов. Код на 5 минут, одноразовый, с ограничением
// на число попыток ввода — так подтверждается, что телефон сейчас у клиента в руках.
// Списывать баллы может только администратор — менеджер и сотрудник видят баланс
// и могут пополнять его новыми визитами, но не имеют права его тратить.
router.post("/request-redeem-code", requireAdmin, async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: "Укажите телефон" });

    const { rows } = await pool.query("SELECT * FROM clients WHERE phone = $1", [phone]);
    const c = rows[0];
    if (!c) return res.status(404).json({ error: "Клиент не найден" });
    if (Number(c.points_balance) <= 0) {
      return res.status(400).json({ error: "У клиента нет баллов для списания" });
    }

    const code = String(Math.floor(1000 + Math.random() * 9000));
    const hash = await bcrypt.hash(code, 8);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await pool.query(
      `UPDATE clients SET otp_code_hash = $1, otp_expires_at = $2, otp_attempts = 0 WHERE id = $3`,
      [hash, expiresAt, c.id]
    );

    const result = await sendCode(
      phone,
      `Автомойка: код для списания баллов — ${code}. Никому не сообщайте его, кроме сотрудника мойки.`
    );

    const response = { sent: true, channel: result.channel };
    // Код виден в ответе, только если реальный SMS-шлюз не настроен (режим разработки) —
    // это чтобы можно было проверять списание баллов локально без платного SMS-провайдера.
    if (result.channel === "sms" && result.provider === "console") response.dev_code = code;
    res.json(response);
  } catch (err) {
    next(err);
  }
});

// Найти клиента по телефону и показать его бонусный статус.
// Телефон — приватный идентификатор (в отличие от номера авто, который виден
// любому на парковке), поэтому именно по нему привязываются баллы и скидки.
router.get("/lookup", async (req, res, next) => {
  try {
    const phone = normalizePhone(req.query.phone);
    if (!phone) return res.status(400).json({ error: "Укажите телефон" });

    const { rows } = await pool.query("SELECT * FROM clients WHERE phone = $1", [phone]);
    const { rows: settingsRows } = await pool.query("SELECT * FROM loyalty_settings WHERE id = 1");
    const settings = settingsRows[0];

    if (rows.length === 0) {
      return res.json({ found: false, settings });
    }
    res.json({ found: true, client: rows[0], settings });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
