const express = require("express");
const router = express.Router();
const pool = require("../db");
const { requireAdminOrManager } = require("../middleware/auth");

router.get("/settings", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM loyalty_settings WHERE id = 1");
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put("/settings", requireAdminOrManager, async (req, res, next) => {
  try {
    const { points_percent } = req.body;
    if (points_percent == null || points_percent < 0) {
      return res.status(400).json({ error: "Укажите процент баллов" });
    }
    const { rows } = await pool.query(
      `UPDATE loyalty_settings SET points_percent = $1 WHERE id = 1 RETURNING *`,
      [points_percent]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
