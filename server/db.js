// Подключение к PostgreSQL.
// Поддерживает два варианта, чтобы работать одинаково локально и на хостинге:
//   - DATABASE_URL (единая строка подключения) — так параметры базы передают
//     Railway, Render, Heroku и подобные платформы после подключения Postgres
//   - раздельные DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME — для локального
//     запуска и .env, как было раньше
const { Pool } = require("pg");

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      // Управляемые Postgres (Railway и т.п.) обычно требуют SSL, но с
      // самоподписанным сертификатом — поэтому rejectUnauthorized: false
      ssl: { rejectUnauthorized: false },
    })
  : new Pool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    });

module.exports = pool;
