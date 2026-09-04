const express = require("express");
const router = express.Router();
const pool = require("../db");

// Список активных услуг (для чекбоксов)
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, price FROM services WHERE active = true ORDER BY name"
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Новая услуга — добавить в каталог может любой вошедший сотрудник
router.post("/", async (req, res, next) => {
  try {
    const { name, price } = req.body;
    if (!name || !name.trim() || price == null || price < 0) {
      return res.status(400).json({ error: "Укажите название и цену услуги" });
    }
    const { rows } = await pool.query(
      `INSERT INTO services (name, price)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET price = EXCLUDED.price, active = true
       RETURNING id, name, price`,
      [name.trim(), price]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Изменить существующую услугу (название/цена)
router.put("/:id", async (req, res, next) => {
  try {
    const { name, price } = req.body;
    if (!name || !name.trim() || price == null || price < 0) {
      return res.status(400).json({ error: "Укажите название и цену услуги" });
    }
    const { rows } = await pool.query(
      `UPDATE services SET name = $1, price = $2 WHERE id = $3
       RETURNING id, name, price`,
      [name.trim(), price, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Услуга не найдена" });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Услуга с таким названием уже есть" });
    }
    next(err);
  }
});

// Скрыть услугу из списка (не удаляем — она может быть в старых записях)
router.delete("/:id", async (req, res, next) => {
  try {
    await pool.query("UPDATE services SET active = false WHERE id = $1", [req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
