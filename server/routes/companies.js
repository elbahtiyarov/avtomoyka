const express = require("express");
const router = express.Router();
const pool = require("../db");
const { requireAdmin } = require("../middleware/auth");

// Список компаний (только активные)
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, balance FROM companies WHERE active = true ORDER BY name"
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// История начислений/оплат по одной компании
router.get("/:id/ledger", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.*, u.name AS staff_name
       FROM company_ledger l
       LEFT JOIN users u ON u.id = l.staff_id
       WHERE l.company_id = $1
       ORDER BY l.created_at DESC
       LIMIT 50`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Новая компания
router.post("/", async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Укажите название компании" });
    }
    const { rows } = await pool.query(
      `INSERT INTO companies (name)
       VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET active = true
       RETURNING id, name, balance`,
      [name.trim()]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Начислить сумму компании (например, за мойку в течение месяца)
router.post("/:id/charge", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { amount, note } = req.body;
    if (amount == null || amount <= 0) {
      return res.status(400).json({ error: "Укажите сумму начисления" });
    }
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE companies SET balance = balance + $1 WHERE id = $2 RETURNING id, name, balance`,
      [amount, req.params.id]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Компания не найдена" });
    }
    await client.query(
      `INSERT INTO company_ledger (company_id, kind, amount, note, staff_id) VALUES ($1,'charge',$2,$3,$4)`,
      [req.params.id, amount, (note && note.trim()) || null, req.user.id]
    );
    await client.query("COMMIT");
    res.json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

// Отметить компанию оплаченной — обнуляет долг (бухгалтерия закрыла счёт за месяц).
// Только администратор — это финансово чувствительное действие, менеджер может
// только начислять (/charge), но не обнулять долг.
router.post("/:id/pay", requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT balance FROM companies WHERE id = $1", [req.params.id]);
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Компания не найдена" });
    }
    const paidAmount = Number(rows[0].balance);
    const { rows: updated } = await client.query(
      `UPDATE companies SET balance = 0 WHERE id = $1 RETURNING id, name, balance`,
      [req.params.id]
    );
    if (paidAmount > 0) {
      await client.query(
        `INSERT INTO company_ledger (company_id, kind, amount, note, staff_id) VALUES ($1,'payment',$2,'Оплата по счёту',$3)`,
        [req.params.id, paidAmount, req.user.id]
      );
    }
    await client.query("COMMIT");
    res.json(updated[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

// Скрыть компанию из списка — только админ
router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    await pool.query("UPDATE companies SET active = false WHERE id = $1", [req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
