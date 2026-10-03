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

    // Услуги по каждой записи за период — нужны, чтобы посчитать зарплату мойщика
    // с учётом личного % по отдельным услугам (например, химчистка — 40%, а не
    // общий процент). Процент берётся из ТЕКУЩЕГО каталога услуг (как и общий
    // washer_percent — он тоже не замораживается на момент записи).
    const { rows: recordRows } = await pool.query(
      `SELECT id, price, service_date, car_brand, car_number, COALESCE(NULLIF(received_by, ''), '—') AS washer_name
       FROM records ${where}`,
      dateParams
    );
    const { rows: recServiceRows } = recordRows.length ? await pool.query(
      `SELECT rs.record_id, rs.service_name, rs.service_price, s.washer_percent_override
       FROM record_services rs
       LEFT JOIN services s ON s.id = rs.service_id
       WHERE rs.record_id = ANY($1::bigint[])`,
      [recordRows.map(r => r.id)]
    ) : { rows: [] };

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

    // Зарплата мойщика по каждой записи: КАЖДАЯ услуга считается по своей цене и
    // своему проценту — личному (washer_percent_override), если он задан именно
    // у этой услуги в каталоге, иначе по общему проценту. Раньше все услуги без
    // личного % сваливались в одну общую сумму "ЗП по общим услугам" — из-за этого
    // было не видно, что, например, у "Химчистка полная" процент не задан, хотя у
    // "Химчистка сидений" задан 40% (разные строки в каталоге услуг — процент не
    // "наследуется" по похожему названию). Теперь каждая услуга — отдельная
    // видимая колонка со своим процентом, ничего не скрыто.
    const servicesByRecord = new Map();
    for (const rs of recServiceRows) {
      if (!servicesByRecord.has(rs.record_id)) servicesByRecord.set(rs.record_id, []);
      servicesByRecord.get(rs.record_id).push(rs);
    }
    const globalPercent = Number(settings.washer_percent);
    const salaryByWasher = new Map();
    // Разбивка "сколько по какой услуге" — ключ: мойщик||название услуги||процент,
    // суммируем по всем записям периода, чтобы построить колонки отчёта.
    const serviceBreakdownByWasher = new Map();
    // Список отдельных колонок (услуга+процент), которые встретились хоть у кого-то
    // за период — чтобы построить одинаковую таблицу для всех мойщиков.
    const serviceColumnsSeen = new Map(); // key "название||процент" -> {name, percent}
    // Детали по каждой записи — чтобы в отчёте можно было раскрыть колонку и
    // посмотреть, какая именно машина/дата дала эту сумму (а не верить цифре
    // на слово, когда она кажется подозрительной).
    const recordDetailsByWasher = new Map();

    function addServiceAmount(washerName, svcName, percent, amount) {
      const key = `${washerName}||${svcName}||${percent}`;
      const prev = serviceBreakdownByWasher.get(key) || { washer: washerName, name: svcName, percent, amount: 0 };
      prev.amount += amount;
      serviceBreakdownByWasher.set(key, prev);
      serviceColumnsSeen.set(`${svcName}||${percent}`, { name: svcName, percent });
    }

    for (const r of recordRows) {
      const price = Number(r.price);
      const svcList = servicesByRecord.get(r.id) || [];
      const svcSum = svcList.reduce((sum, s) => sum + Number(s.service_price), 0);
      let recordSalary = 0;
      const items = [];

      for (const s of svcList) {
        const svcName = s.service_name || "Услуга";
        const percent = s.washer_percent_override != null ? Number(s.washer_percent_override) : globalPercent;
        const amount = Number(s.service_price) * (percent / 100);
        recordSalary += amount;
        addServiceAmount(r.washer_name, svcName, percent, amount);
        items.push({ name: svcName, price: Number(s.service_price), percent, amount: Math.round(amount * 100) / 100 });
      }

      // Если итоговая цена записи вручную отличается от суммы цен выбранных услуг
      // (скидка/наценка в поле "Цена") — на разницу начисляем зарплату по общему
      // проценту отдельной видимой строкой-услугой, а не молча растворяем её внутри
      // какой-то из обычных колонок.
      const leftover = price - svcSum;
      if (Math.round(leftover * 100) !== 0) {
        const leftoverSalary = leftover * (globalPercent / 100);
        recordSalary += leftoverSalary;
        addServiceAmount(r.washer_name, "Корректировка цены (скидка/наценка)", globalPercent, leftoverSalary);
        items.push({ name: "Корректировка цены (скидка/наценка)", price: Math.round(leftover * 100) / 100, percent: globalPercent, amount: Math.round(leftoverSalary * 100) / 100 });
      }

      salaryByWasher.set(r.washer_name, (salaryByWasher.get(r.washer_name) || 0) + recordSalary);
      if (!recordDetailsByWasher.has(r.washer_name)) recordDetailsByWasher.set(r.washer_name, []);
      recordDetailsByWasher.get(r.washer_name).push({
        service_date: r.service_date,
        car_brand: r.car_brand,
        car_number: r.car_number,
        price,
        items,
        salary: Math.round(recordSalary * 100) / 100,
      });
    }

    const overrideColumns = [...serviceColumnsSeen.values()];
    const washerBreakdown = byWasher.map(w => {
      const overrides = [...serviceBreakdownByWasher.values()]
        .filter(o => o.washer === w.name)
        .map(o => ({ name: o.name, percent: o.percent, amount: Math.round(o.amount * 100) / 100 }));
      const records = (recordDetailsByWasher.get(w.name) || [])
        .slice()
        .sort((a, b) => new Date(a.service_date) - new Date(b.service_date));
      return {
        name: w.name,
        cars_count: Number(w.cars_count),
        revenue: Number(w.revenue),
        salary: Math.round((salaryByWasher.get(w.name) || 0) * 100) / 100,
        overrides,
        records,
      };
    });
    const washerTotal = Math.round(washerBreakdown.reduce((sum, w) => sum + w.salary, 0) * 100) / 100;
    const adminCut = Math.round(Number(t.total_revenue) * (settings.admin_percent / 100) * 100) / 100;
    // Остаток кассы: из общей выручки вычитаем всё, что из неё уже "ушло" —
    // долю администратора, зарплату мойщикам, оплаты через QR и по счёту (это не
    // наличные деньги в кассе), бонусы, которыми клиенты расплатились, и расходы.
    const cashToHandover = Math.round(
      (Number(t.total_revenue) - adminCut - washerTotal - Number(t.total_qr) - Number(t.total_invoice) - Number(t.total_bonus_redeemed) - totalExpenses) * 100
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
      override_columns: overrideColumns,
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
