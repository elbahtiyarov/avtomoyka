const express = require("express");
const router = express.Router();
const pool = require("../db");

// Список активных боксов (для выпадающего списка)
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name FROM bays WHERE active = true ORDER BY name"
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Новый бокс — добавить может любой вошедший сотрудник
router.post("/", async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Укажите название бокса" });
    }
    const { rows } = await pool.query(
      `INSERT INTO bays (name)
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

// Скрыть бокс (не удаляем — он может быть в старых записях)
router.delete("/:id", async (req, res, next) => {
  try {
    await pool.query("UPDATE bays SET active = false WHERE id = $1", [req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
