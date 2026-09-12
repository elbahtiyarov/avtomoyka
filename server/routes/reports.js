const express = require("express");
const router = express.Router();
const pool = require("../db");

// Отчёт по кассе за период (по умолчанию — за сегодня, если ничего не передано).
// Все проценты и суммы считает сервер из актуальных данных в базе.
router.get("/shift", async (req, res, next) => {
  try {
    const { date, date_from, date_to } = req.query;

    // Строим фильтр один раз для обеих таблиц — колонка с датой называется по-разному
    const dateParams = [];
    let j = 1;
    const recCond = [];
    const expCond = [];
    if (date) { dateParams.push(date); recCond.push(`service_date = $${j}`); expCond.push(`expense_date = $${j}`); j++; }
    if (date_from) { dateParams.push(date_from); recCond.push(`service_date >= $${j}`); expCond.push(`expense_date >= $${j}`); j++; }
    if (date_to) { dateParams.push(date_to); recCond.push(`service_date <= $${j}`); expCond.push(`expense_date <= $${j}`); j++; }
    if (!date && !date_from && !date_to) {
      recCond.push(`service_date = CURRENT_DATE`);
      expCond.push(`expense_date = CURRENT_DATE`);
    }
    const where = recCond.length ? "WHERE " + recCond.join(" AND ") : "";
    const expWhere = expCond.length ? "WHERE " + expCond.join(" AND ") : "";

    const { rows: totalsRows } = await pool.query(
      `SELECT
         COUNT(*)                        AS cars_count,
         COALESCE(SUM(price), 0)         AS total_revenue,
         COALESCE(SUM(amount_cash), 0)   AS total_cash,
         COALESCE(SUM(amount_qr), 0)     AS total_qr,
         COALESCE(SUM(amount_invoice), 0) AS total_invoice,
         COALESCE(SUM(points_redeemed), 0) AS total_bonus_redeemed
       FROM records ${where}`,
      dateParams
    );
    const t = totalsRows[0];

    const { rows: byWasher } = await pool.query(
      `SELECT COALESCE(NULLIF(received_by, ''), '—') AS name,
              COUNT(*)                AS cars_count,
              COALESCE(SUM(price), 0) AS revenue
       FROM records ${where}
       GROUP BY name
       ORDER BY revenue DESC`,
      dateParams
    );

    const { rows: expenseRows } = await pool.query(
      `SELECT e.*, u.name AS staff_name
       FROM expenses e
       LEFT JOIN users u ON u.id = e.staff_id
       ${expWhere}
       ORDER BY e.expense_date DESC, e.id DESC`,
      dateParams
    );
    const totalExpenses = Math.round(
      expenseRows.reduce((sum, e) => sum + Number(e.amount), 0) * 100
    ) / 100;

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
    const cashToHandover = Math.round(
      (Number(t.total_cash) - washerTotal - adminCut - totalExpenses) * 100
    ) / 100;

    res.json({
      cars_count: Number(t.cars_count),
      total_revenue: Number(t.total_revenue),
      total_cash: Number(t.total_cash),
      total_qr: Number(t.total_qr),
      total_invoice: Number(t.total_invoice),
      total_bonus_redeemed: Number(t.total_bonus_redeemed),
      admin_percent: Number(settings.admin_percent),
      admin_cut: adminCut,
      washer_percent: Number(settings.washer_percent),
      washer_breakdown: washerBreakdown,
      washer_total: washerTotal,
      total_expenses: totalExpenses,
      expenses: expenseRows.map(e => ({
        id: e.id,
        expense_date: e.expense_date,
        description: e.description,
        amount: Number(e.amount),
        staff_name: e.staff_name,
      })),
      cash_to_handover: cashToHandover,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
