const express = require("express");
const router = express.Router();
const pool = require("../db");

// Список расходов. Фильтры (необязательные, можно комбинировать):
//   date, date_from, date_to
router.get("/", async (req, res, next) => {
  try {
    const { date, date_from, date_to } = req.query;
    const conditions = [];
    const params = [];
    let i = 1;

    if (date) { conditions.push(`e.expense_date = $${i++}`); params.push(date); }
    if (date_from) { conditions.push(`e.expense_date >= $${i++}`); params.push(date_from); }
    if (date_to) { conditions.push(`e.expense_date <= $${i++}`); params.push(date_to); }
    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const { rows } = await pool.query(
      `SELECT e.*, u.name AS staff_name
       FROM expenses e
       LEFT JOIN users u ON u.id = e.staff_id
       ${where}
       ORDER BY e.expense_date DESC, e.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Новый расход — записать может любой вошедший сотрудник (например, вызвали мастера
// и оплатили из кассы наличными)
router.post("/", async (req, res, next) => {
  try {
    const { expense_date, description, amount } = req.body;
    if (!expense_date || !description || !description.trim() || amount == null || amount < 0) {
      return res.status(400).json({ error: "Заполните дату, описание и сумму" });
    }
    const { rows } = await pool.query(
      `INSERT INTO expenses (expense_date, description, amount, staff_id)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [expense_date, description.trim(), amount, req.user.id]
    );
    req.app.get("broadcast")();
    res.status(201).json({ ...rows[0], staff_name: req.user.name });
  } catch (err) {
    next(err);
  }
});

// Удаление расхода (например, внесли по ошибке)
router.delete("/:id", async (req, res, next) => {
  try {
    await pool.query("DELETE FROM expenses WHERE id = $1", [req.params.id]);
    req.app.get("broadcast")();
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
