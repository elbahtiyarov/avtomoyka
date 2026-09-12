// Личный кабинет клиента — вход по SMS-коду (без пароля), просмотр своих баллов.
// Полностью отдельно от входа сотрудников: свой токен, свой формат, никакого
// пересечения с server/middleware/auth.js requireAuth.

// --- Тема (та же логика, что и в app.js, но независимая копия — страницы разные) ---
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
  const isDark = theme === "dark";
  document.querySelectorAll('.theme-toggle-btn[data-compact="true"]').forEach(el => {
    el.textContent = isDark ? "☀️" : "🌙";
  });
}
function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  applyTheme(current === "dark" ? "light" : "dark");
}
applyTheme(localStorage.getItem("theme") || "light");

if (/Android|iPhone|iPod/i.test(navigator.userAgent)) {
  document.documentElement.classList.add("force-mobile");
}
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

const fmt = n => new Intl.NumberFormat("ru-RU").format(Math.round(n || 0)) + " ₸";

let clientToken = localStorage.getItem("clientToken") || null;
let pendingPhone = "";

async function portalApi(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (clientToken) headers["Authorization"] = "Bearer " + clientToken;
  const res = await fetch("/api/client-portal" + path, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Ошибка запроса: ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function showError(msg) {
  const el = document.getElementById("portalError");
  el.textContent = msg;
  el.style.display = "block";
}
function clearError() {
  document.getElementById("portalError").style.display = "none";
}

async function boot() {
  document.getElementById("phoneForm").addEventListener("submit", submitPhone);
  document.getElementById("codeForm").addEventListener("submit", submitCode);

  if (clientToken) {
    try {
      await showDashboard();
      return;
    } catch (err) {
      clientToken = null;
      localStorage.removeItem("clientToken");
    }
  }
  document.getElementById("portalScreen").style.display = "flex";
}

async function submitPhone(e) {
  e.preventDefault();
  clearError();
  pendingPhone = document.getElementById("pPhone").value.trim();
  try {
    const res = await portalApi("/request-code", { method: "POST", body: JSON.stringify({ phone: pendingPhone }) });
    document.getElementById("phoneForm").style.display = "none";
    document.getElementById("codeForm").style.display = "block";
    document.getElementById("pCode").value = "";
    const hint = document.getElementById("devCodeHint");
    if (res.dev_code) {
      hint.textContent = `Тестовый режим (SMS-шлюз не настроен) — код: ${res.dev_code}`;
      hint.style.display = "block";
    } else if (res.channel === "telegram") {
      hint.textContent = "Код отправлен в Telegram.";
      hint.style.display = "block";
    } else {
      hint.style.display = "none";
    }
  } catch (err) {
    showError(err.message);
  }
}

function backToPhone() {
  clearError();
  document.getElementById("codeForm").style.display = "none";
  document.getElementById("phoneForm").style.display = "block";
}

async function submitCode(e) {
  e.preventDefault();
  clearError();
  const code = document.getElementById("pCode").value.trim();
  try {
    const res = await portalApi("/verify", { method: "POST", body: JSON.stringify({ phone: pendingPhone, code }) });
    clientToken = res.token;
    localStorage.setItem("clientToken", clientToken);
    await showDashboard();
  } catch (err) {
    showError(err.message);
  }
}

async function showDashboard() {
  const me = await portalApi("/me");
  document.getElementById("portalScreen").style.display = "none";
  document.getElementById("dashboardScreen").style.display = "flex";
  document.getElementById("dName").textContent = me.name || "Клиент";
  document.getElementById("dPhone").textContent = "+" + me.phone;
  document.getElementById("dVisits").textContent = me.visit_count;
  document.getElementById("dPoints").textContent = fmt(me.points_balance);
}

function portalLogout() {
  clientToken = null;
  localStorage.removeItem("clientToken");
  document.getElementById("dashboardScreen").style.display = "none";
  document.getElementById("phoneForm").style.display = "block";
  document.getElementById("codeForm").style.display = "none";
  document.getElementById("pPhone").value = "";
  document.getElementById("portalScreen").style.display = "flex";
}

boot();
