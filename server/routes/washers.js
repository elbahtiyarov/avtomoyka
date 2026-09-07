const express = require("express");
const router = express.Router();
const pool = require("../db");

// Список активных мойщиков (для выпадающего списка в форме записи)
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name FROM washers WHERE active = true ORDER BY name"
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Новый мойщик — добавить может любой вошедший сотрудник
router.post("/", async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Укажите имя мойщика" });
    }
    const { rows } = await pool.query(
      `INSERT INTO washers (name)
       VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET active = true
       RETURNING id, name`,
      [name.trim()]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Переименовать мойщика
router.put("/:id", async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Укажите имя мойщика" });
    }
    const { rows } = await pool.query(
      `UPDATE washers SET name = $1 WHERE id = $2 RETURNING id, name`,
      [name.trim(), req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Мойщик не найден" });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Мойщик с таким именем уже есть" });
    }
    next(err);
  }
});

// Скрыть мойщика из списка (не удаляем — он может быть в старых записях)
router.delete("/:id", async (req, res, next) => {
  try {
    await pool.query("UPDATE washers SET active = false WHERE id = $1", [req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
