require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const { WebSocketServer } = require("ws");

const authRouter = require("./routes/auth");
const recordsRouter = require("./routes/records");
const expensesRouter = require("./routes/expenses");
const servicesRouter = require("./routes/services");
const baysRouter = require("./routes/bays");
const washersRouter = require("./routes/washers");
const companiesRouter = require("./routes/companies");
const clientsRouter = require("./routes/clients");
const loyaltyRouter = require("./routes/loyalty");
const payrollRouter = require("./routes/payroll");
const reportsRouter = require("./routes/reports");
const clientPortalRouter = require("./routes/clientPortal");
const { initTelegramBot } = require("./services/telegramBot");
const errorHandler = require("./middleware/errorHandler");
const { requireAuth } = require("./middleware/auth");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" })); // лимит увеличен — подпись хранится как base64-картинка

// Отдаём фронтенд из /public
app.use(express.static(path.join(__dirname, "..", "public")));

// Бесплатное распознавание номера авто по фото (Tesseract.js) работает прямо в
// браузере/телефоне. Все нужные файлы (скрипт, воркер, wasm-ядро и языковые
// данные) раздаём с нашего же сервера из node_modules — без внешних CDN, поэтому
// сканер не зависит от того, доступны ли сторонние сайты. Файлы не меняются между
// версиями, поэтому браузер может надолго кэшировать их (скачиваются один раз).
const nm = path.join(__dirname, "..", "node_modules");
const vendorOpts = { maxAge: "30d", immutable: true };
app.use("/vendor/tesseract", express.static(path.join(nm, "tesseract.js", "dist"), vendorOpts));
app.use("/vendor/tesseract-core", express.static(path.join(nm, "tesseract.js-core"), vendorOpts));
app.use("/vendor/tessdata", express.static(path.join(nm, "@tesseract.js-data", "eng", "4.0.0_best_int"), vendorOpts));

app.use("/api/auth", authRouter);              // логин — без авторизации
app.use("/api/records", requireAuth, recordsRouter);
app.use("/api/expenses", requireAuth, expensesRouter);
app.use("/api/services", requireAuth, servicesRouter);
app.use("/api/bays", requireAuth, baysRouter);
app.use("/api/washers", requireAuth, washersRouter);
app.use("/api/companies", requireAuth, companiesRouter);
app.use("/api/clients", requireAuth, clientsRouter);
app.use("/api/loyalty", requireAuth, loyaltyRouter);
app.use("/api/payroll", requireAuth, payrollRouter);
app.use("/api/reports", requireAuth, reportsRouter);
app.use("/api/client-portal", clientPortalRouter);

app.use(errorHandler);

const PORT = process.env.PORT || 3002;
const server = app.listen(PORT, () => {
  console.log(`Автомойка запущена: http://localhost:${PORT}`);
  initTelegramBot();
});

// --- WebSocket: живые обновления, если несколько администраторов работают одновременно ---
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

function broadcast() {
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "updated" }));
  }
}
app.set("broadcast", broadcast);

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/ws")) return;
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
  });
});
