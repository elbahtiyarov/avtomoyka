const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET || "change-me-in-env";

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Требуется вход в систему" });

  try {
    req.user = jwt.verify(token, SECRET); // { id, name, role, username }
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

module.exports = { requireAuth, requireAdmin, SECRET };
