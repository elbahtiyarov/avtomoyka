// Применяет schema.sql и (опционально) seed.sql к базе, заданной в .env
// Запуск: node db/migrate.js                   — только схема (для новой пустой базы)
//         node db/migrate.js --seed            — схема + демо-данные
//         node db/migrate.js --upgrade         — БЕЗОПАСНО довести существующую базу
//                                                 до актуальной структуры, ничего не удаляя
//         node db/migrate.js --reset --seed    — РАЗРУШИТЕЛЬНО: удалить все таблицы и
//                                                 создать заново с демо-данными

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("../server/db");

async function run() {
  if (process.argv.includes("--reset")) {
    console.log("Удаляю старые таблицы (--reset)...");
    await pool.query(
      "DROP TABLE IF EXISTS record_services, records, services, bays, washers, expenses, clients, loyalty_settings, payroll_settings, telegram_links, companies, company_ledger, users CASCADE;" +
      "DROP VIEW IF EXISTS daily_totals;"
    );
    console.log("Старые таблицы удалены.");
  }

  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  console.log("Применяю schema.sql...");
  await pool.query(schema);
  console.log("Схема готова.");

  if (process.argv.includes("--upgrade")) {
    const upgrade = fs.readFileSync(path.join(__dirname, "upgrade.sql"), "utf8");
    console.log("Применяю upgrade.sql (безопасно, без потери данных)...");
    await pool.query(upgrade);
    console.log("База обновлена, старые данные на месте.");
  }

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
