const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const { requireAuth, requireAdmin, requireAdminOrManager, SECRET } = require("../middleware/auth");

// Вход в систему
router.post("/login", async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Укажите логин и пароль" });
    }

    const { rows } = await pool.query(
      "SELECT * FROM users WHERE username = $1",
      [username.trim().toLowerCase()]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Неверный логин или пароль" });
    }
    if (!user.active) {
      return res.status(401).json({ error: "Учётная запись отключена" });
    }

    const payload = { id: user.id, name: user.name, username: user.username, role: user.role };
    const token = jwt.sign(payload, SECRET, { expiresIn: "30d" });
    res.json({ token, user: payload });
  } catch (err) {
    next(err);
  }
});

// Текущий пользователь (проверка токена при загрузке страницы)
router.get("/me", requireAuth, (req, res) => {
  res.json(req.user);
});

// Список пользователей (админ и менеджер)
router.get("/users", requireAuth, requireAdminOrManager, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, username, role, created_at FROM users WHERE active = true ORDER BY name"
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Новый пользователь (админ и менеджер — но менеджер не может создать администратора)
router.post("/users", requireAuth, requireAdminOrManager, async (req, res, next) => {
  try {
    const { name, username, password, role } = req.body;
    if (!name || !username || !password) {
      return res.status(400).json({ error: "Обязательны: name, username, password" });
    }
    if (req.user.role === "manager") {
      if (role === "admin") {
        return res.status(403).json({ error: "Менеджер не может создавать администраторов" });
      }
      const { rows: existing } = await pool.query(
        "SELECT role FROM users WHERE username = $1",
        [username.trim().toLowerCase()]
      );
      if (existing[0] && existing[0].role === "admin") {
        return res.status(403).json({ error: "Менеджер не может изменять учётную запись администратора" });
      }
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, username, password_hash, role)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (username) DO UPDATE
         SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash,
             role = EXCLUDED.role, active = true
       RETURNING id, name, username, role, created_at`,
      [
        name.trim(),
        username.trim().toLowerCase(),
        hash,
        ["admin", "manager"].includes(role) ? role : "user",
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Скрыть пользователя — не удаляем насовсем, только администратор (менеджер может
// добавлять сотрудников/менеджеров, но не удалять — это оставлено только админу
// в целях безопасности). Нельзя скрыть самого себя.
// Если удалить по-настоящему, Postgres не даст: на пользователя ссылаются его старые
// записи в журнале (records.staff_id), и удаление сломало бы историю операций.
router.delete("/users/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    if (Number(req.params.id) === req.user.id) {
      return res.status(400).json({ error: "Нельзя скрыть свою же учётную запись" });
    }
    await pool.query("UPDATE users SET active = false WHERE id = $1", [req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Сменить пароль пользователю — только администратор (например, если сотрудник забыл свой)
router.put("/users/:id/password", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 4) {
      return res.status(400).json({ error: "Пароль должен быть не короче 4 символов" });
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      "UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id",
      [hash, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Пользователь не найден" });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
