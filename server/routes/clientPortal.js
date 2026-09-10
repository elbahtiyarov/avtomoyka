const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const { requireClientAuth, SECRET } = require("../middleware/auth");
const { sendSms } = require("../services/sms");
const { normalizePhone } = require("./clients");

// Клиент запрашивает код для входа в личный кабинет — приходит по SMS.
// Работает только для номеров, которые уже есть в базе (то есть клиент хотя бы раз
// был на мойке и указывал телефон) — иначе смотреть там пока нечего.
router.post("/request-code", async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: "Укажите телефон" });

    const { rows } = await pool.query("SELECT * FROM clients WHERE phone = $1", [phone]);
    const client = rows[0];
    if (!client) {
      return res.status(404).json({ error: "Клиент с таким номером не найден. Обратитесь на мойку, чтобы завести бонусный счёт." });
    }

    const code = String(Math.floor(1000 + Math.random() * 9000));
    const hash = await bcrypt.hash(code, 8);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await pool.query(
      `UPDATE clients SET portal_otp_code_hash = $1, portal_otp_expires_at = $2, portal_otp_attempts = 0 WHERE id = $3`,
      [hash, expiresAt, client.id]
    );

    const smsResult = await sendSms(
      phone,
      `Автомойка: код для входа в личный кабинет — ${code}. Никому его не сообщайте.`
    );

    const response = { sent: true };
    if (smsResult.provider === "console") response.dev_code = code; // видно только без реального SMS-шлюза
    res.json(response);
  } catch (err) {
    next(err);
  }
});

// Проверка кода — при успехе выдаётся токен личного кабинета (отдельный от токена сотрудников)
router.post("/verify", async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const code = req.body.code;
    if (!phone || !code) return res.status(400).json({ error: "Укажите телефон и код" });

    const { rows } = await pool.query("SELECT * FROM clients WHERE phone = $1", [phone]);
    const client = rows[0];
    if (!client || !client.portal_otp_code_hash || !client.portal_otp_expires_at) {
      return res.status(400).json({ error: "Сначала запросите код" });
    }
    if (new Date(client.portal_otp_expires_at) < new Date()) {
      return res.status(400).json({ error: "Код истёк, запросите новый" });
    }
    if (client.portal_otp_attempts >= 5) {
      return res.status(400).json({ error: "Слишком много попыток, запросите новый код" });
    }

    const matches = await bcrypt.compare(String(code), client.portal_otp_code_hash);
    if (!matches) {
      await pool.query("UPDATE clients SET portal_otp_attempts = portal_otp_attempts + 1 WHERE id = $1", [client.id]);
      return res.status(400).json({ error: "Неверный код" });
    }

    await pool.query(
      `UPDATE clients SET portal_otp_code_hash = NULL, portal_otp_expires_at = NULL, portal_otp_attempts = 0 WHERE id = $1`,
      [client.id]
    );

    const token = jwt.sign(
      { clientId: client.id, phone: client.phone, name: client.name, type: "client" },
      SECRET,
      { expiresIn: "90d" }
    );
    res.json({ token });
  } catch (err) {
    next(err);
  }
});

// Данные своего личного кабинета — имя, визиты, баланс баллов
router.get("/me", requireClientAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM clients WHERE id = $1", [req.client.clientId]);
    const client = rows[0];
    if (!client) return res.status(404).json({ error: "Клиент не найден" });
    res.json({
      name: client.name,
      phone: client.phone,
      visit_count: client.visit_count,
      points_balance: Number(client.points_balance),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
