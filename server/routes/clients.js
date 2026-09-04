const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const pool = require("../db");
const { requireAdmin } = require("../middleware/auth");
const { sendSms } = require("../services/sms");

function normalizePhone(raw) {
  return (raw || "").replace(/\D/g, "");
}

// Список клиентов бонусной программы (поиск по имени/телефону: /clients?q=...)
router.get("/", async (req, res, next) => {
  try {
    const { q } = req.query;
    const { rows } = q && q.trim()
      ? await pool.query(
          "SELECT * FROM clients WHERE name ILIKE $1 OR phone ILIKE $1 ORDER BY visit_count DESC, name",
          [`%${q.trim()}%`]
        )
      : await pool.query("SELECT * FROM clients ORDER BY visit_count DESC, name");
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Ручная правка карточки клиента — исправление ошибок (только администратор)
router.put("/:id", requireAdmin, async (req, res, next) => {
  try {
    const { name, visit_count, points_balance } = req.body;
    if (visit_count == null || visit_count < 0 || points_balance == null || points_balance < 0) {
      return res.status(400).json({ error: "Проверьте количество визитов и баллы" });
    }
    const { rows } = await pool.query(
      `UPDATE clients SET name = $1, visit_count = $2, points_balance = $3 WHERE id = $4
       RETURNING *`,
      [(name && name.trim()) || null, visit_count, points_balance, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Клиент не найден" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Запросить SMS-код для списания баллов. Код на 5 минут, одноразовый, с ограничением
// на число попыток ввода — так подтверждается, что телефон сейчас у клиента в руках.
router.post("/request-redeem-code", async (req, res, next) => {
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

    const smsResult = await sendSms(
      phone,
      `Автомойка: код для списания баллов — ${code}. Никому не сообщайте его, кроме сотрудника мойки.`
    );

    const response = { sent: true };
    // Код виден в ответе, только если реальный SMS-шлюз не настроен (режим разработки) —
    // это чтобы можно было проверять списание баллов локально без платного SMS-провайдера.
    if (smsResult.provider === "console") response.dev_code = code;
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
module.exports.normalizePhone = normalizePhone;
