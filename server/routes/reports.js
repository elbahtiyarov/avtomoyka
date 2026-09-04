const express = require("express");
const router = express.Router();
const pool = require("../db");

// Отчёт по кассе за период (по умолчанию — за сегодня, если ничего не передано).
// Все проценты и суммы считает сервер из актуальных данных в базе.
router.get("/shift", async (req, res, next) => {
  try {
    const { date, date_from, date_to } = req.query;
    const conditions = [];
    const params = [];
    let i = 1;

    if (date) { conditions.push(`service_date = $${i++}`); params.push(date); }
    if (date_from) { conditions.push(`service_date >= $${i++}`); params.push(date_from); }
    if (date_to) { conditions.push(`service_date <= $${i++}`); params.push(date_to); }
    if (!date && !date_from && !date_to) {
      conditions.push(`service_date = CURRENT_DATE`);
    }
    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const { rows: totalsRows } = await pool.query(
      `SELECT
         COUNT(*)                        AS cars_count,
         COALESCE(SUM(price), 0)         AS total_revenue,
         COALESCE(SUM(amount_cash), 0)   AS total_cash,
         COALESCE(SUM(amount_qr), 0)     AS total_qr,
         COALESCE(SUM(points_redeemed), 0) AS total_bonus_redeemed
       FROM records ${where}`,
      params
    );
    const t = totalsRows[0];

    const { rows: byWasher } = await pool.query(
      `SELECT COALESCE(NULLIF(received_by, ''), '—') AS name,
              COUNT(*)                AS cars_count,
              COALESCE(SUM(price), 0) AS revenue
       FROM records ${where}
       GROUP BY name
       ORDER BY revenue DESC`,
      params
    );

    const { rows: settingsRows } = await pool.query("SELECT * FROM payroll_settings WHERE id = 1");
    const settings = settingsRows[0];

    const washerBreakdown = byWasher.map(w => ({
      name: w.name,
      cars_count: Number(w.cars_count),
      revenue: Number(w.revenue),
      salary: Math.round(Number(w.revenue) * (settings.washer_percent / 100) * 100) / 100,
    }));
    const washerTotal = Math.round(washerBreakdown.reduce((sum, w) => sum + w.salary, 0) * 100) / 100;
    const adminCut = Math.round(Number(t.total_revenue) * (settings.admin_percent / 100) * 100) / 100;
    const cashToHandover = Math.round((Number(t.total_cash) - washerTotal - adminCut) * 100) / 100;

    res.json({
      cars_count: Number(t.cars_count),
      total_revenue: Number(t.total_revenue),
      total_cash: Number(t.total_cash),
      total_qr: Number(t.total_qr),
      total_bonus_redeemed: Number(t.total_bonus_redeemed),
      admin_percent: Number(settings.admin_percent),
      admin_cut: adminCut,
      washer_percent: Number(settings.washer_percent),
      washer_breakdown: washerBreakdown,
      washer_total: washerTotal,
      cash_to_handover: cashToHandover,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
