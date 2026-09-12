const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET || "change-me-in-env";

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Требуется вход в систему" });

  try {
    const payload = jwt.verify(token, SECRET); // { id, name, role, username }
    if (payload.type === "client") {
      return res.status(401).json({ error: "Недействительный токен" });
    }
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Сессия истекла, войдите заново" });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Доступно только администратору" });
  }
  next();
}

// Для разделов, куда пустили и менеджера (Пользователи, Бонусы) — но не обычного
// сотрудника. Конкретные ограничения "менеджер не может трогать админов" проверяются
// отдельно внутри самих роутов, там, где это важно.
function requireAdminOrManager(req, res, next) {
  if (!req.user || (req.user.role !== "admin" && req.user.role !== "manager")) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  next();
}

// Отдельная проверка для личного кабинета клиента — токен клиента (по SMS-коду,
// без пароля) не должен давать доступ к сотруднической части, и наоборот, поэтому
// проверяем метку type: "client" в самом токене.
function requireClientAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Требуется вход в систему" });

  try {
    const payload = jwt.verify(token, SECRET);
    if (payload.type !== "client") {
      return res.status(401).json({ error: "Недействительный токен" });
    }
    req.client = payload; // { clientId, phone, name, type: "client" }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Сессия истекла, войдите заново" });
  }
}

module.exports = { requireAuth, requireAdmin, requireAdminOrManager, requireClientAuth, SECRET };
