// Применяет schema.sql и (опционально) seed.sql к базе, заданной в .env
// Запуск: node db/migrate.js                 — только схема
//         node db/migrate.js --seed          — схема + демо-данные
//         node db/migrate.js --reset --seed  — удалить старые таблицы, создать заново + демо-данные
//         (--reset нужен, если структура таблиц менялась — CREATE TABLE IF NOT EXISTS
//          не добавляет новые колонки в уже существующие таблицы)

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("../server/db");

async function run() {
  if (process.argv.includes("--reset")) {
    console.log("Удаляю старые таблицы (--reset)...");
    await pool.query(
      "DROP TABLE IF EXISTS record_services, records, services, bays, washers, clients, loyalty_settings, payroll_settings, users CASCADE;" +
      "DROP VIEW IF EXISTS daily_totals;"
    );
    console.log("Старые таблицы удалены.");
  }

  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  console.log("Применяю schema.sql...");
  await pool.query(schema);
  console.log("Схема готова.");

  if (process.argv.includes("--seed")) {
    const seed = fs.readFileSync(path.join(__dirname, "seed.sql"), "utf8");
    console.log("Загружаю seed.sql...");
    await pool.query(seed);
    console.log("Демо-данные загружены.");
  }

  await pool.end();
}

run().catch((err) => {
  console.error("Ошибка миграции:", err);
  process.exit(1);
});
