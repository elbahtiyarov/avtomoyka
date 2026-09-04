const express = require("express");
const router = express.Router();
const pool = require("../db");
const { requireAdmin } = require("../middleware/auth");

router.get("/settings", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM payroll_settings WHERE id = 1");
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put("/settings", requireAdmin, async (req, res, next) => {
  try {
    const { admin_percent, washer_percent } = req.body;
    if (admin_percent == null || washer_percent == null || admin_percent < 0 || washer_percent < 0) {
      return res.status(400).json({ error: "Заполните оба процента" });
    }
    const { rows } = await pool.query(
      `UPDATE payroll_settings SET admin_percent = $1, washer_percent = $2 WHERE id = 1 RETURNING *`,
      [admin_percent, washer_percent]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
