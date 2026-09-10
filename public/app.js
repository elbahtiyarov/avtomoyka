// Автомойка — фронтенд: вход по логину/паролю (JWT), журнал записей, каталог услуг

// Принудительно включаем мобильный вид на реальных Android/iPhone — даже если в
// браузере включён режим "Версия для компьютера" и он выдаёт себя за широкий экран.
// Обычные CSS-медиазапросы реагируют только на ширину окна, а это её обманывает.
if (/Android|iPhone|iPod/i.test(navigator.userAgent)) {
  document.documentElement.classList.add("force-mobile");
}

// Регистрируем service worker — без него браузер не предложит "Установить приложение"
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => { /* не критично */ });
  });
}

// --- Кнопка "Скачать приложение" на экране входа ---
// Chrome/Edge (Android и компьютер) сами присылают это событие и позволяют показать
// системное окно установки по клику. iOS Safari так не умеет — там показываем
// текстовую инструкцию (Apple не даёт запускать установку из кода страницы).
let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

function openInstallOptions() {
  document.getElementById("installInstructionsBlock").style.display = "none";
  document.getElementById("installIncognitoWarning").style.display = "none";
  document.getElementById("installOverlay").style.display = "flex";
  checkLikelyIncognito();
}

// Надёжного способа спросить браузер "я в инкогнито?" не существует — это скрывается
// намеренно. Используем известный побочный признак: Chrome в обычном режиме даёт сайту
// квоту хранилища в сотни МБ/несколько ГБ, а в инкогнито — обычно не больше ~120 МБ.
// На iPhone эту проверку не делаем: там "На экран «Домой»" — ручное действие через
// Safari, а не через это API браузера, и оно работает даже в приватном режиме.
async function checkLikelyIncognito() {
  if (/iPhone|iPod|iPad/i.test(navigator.userAgent)) return;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { quota } = await navigator.storage.estimate();
      if (quota && quota < 120 * 1024 * 1024) {
        document.getElementById("installIncognitoWarning").style.display = "block";
      }
    }
  } catch (err) { /* признак недоступен — просто не показываем предупреждение */ }
}
function closeInstallOptions() {
  document.getElementById("installOverlay").style.display = "none";
}

async function installFor(platform) {
  if (platform !== "ios" && deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    closeInstallOptions();
    return;
  }
  const instructions = {
    ios: "1. Нажмите кнопку «Поделиться» (квадрат со стрелкой вверх) внизу экрана Safari.\n2. Выберите «На экран «Домой»».\n3. Нажмите «Добавить» в правом верхнем углу.",
    android: "1. Откройте меню браузера (⋮) в правом верхнем углу Chrome.\n2. Выберите «Установить приложение» или «Добавить на главный экран».\n3. Подтвердите установку.",
    desktop: "1. В адресной строке справа найдите значок установки (обычно ⊕ или экран со стрелкой).\n2. Нажмите его и подтвердите установку.\n\nЕсли значка нет — откройте меню браузера (⋮) → «Установить Автомойка…».",
  };
  document.getElementById("installInstructionsText").textContent = instructions[platform] || instructions.desktop;
  document.getElementById("installInstructionsBlock").style.display = "block";
}

// --- Светлая/тёмная тема — применяется сразу, до входа, чтобы не было "мигания" ---
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
  const isDark = theme === "dark";
  document.querySelectorAll(".theme-toggle-full").forEach(el => {
    el.textContent = isDark ? "☀️ Светлая тема" : "🌙 Тёмная тема";
  });
  document.querySelectorAll('.theme-toggle-btn[data-compact="true"]').forEach(el => {
    el.textContent = isDark ? "☀️" : "🌙";
  });
}
function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  applyTheme(current === "dark" ? "light" : "dark");
}
applyTheme(localStorage.getItem("theme") || "light");

// --- Мобильное меню (гамбургер) — сайдбар выезжает поверх контента ---
function toggleMobileMenu() {
  document.getElementById("sidebar").classList.toggle("mobile-open");
  document.getElementById("sidebarBackdrop").classList.toggle("open");
}
function closeMobileMenu() {
  document.getElementById("sidebar").classList.remove("mobile-open");
  document.getElementById("sidebarBackdrop").classList.remove("open");
}
// Любой пункт меню, кроме переключателя темы, закрывает выезжающее меню после нажатия —
// как в мобильных приложениях (тема — исключение, чтобы можно было сразу посмотреть результат)
document.querySelectorAll(".sidebar .nav-item, .sidebar .logout-btn").forEach(el => {
  el.addEventListener("click", closeMobileMenu);
});

let token = localStorage.getItem("token") || null;
let currentUser = null;
let records = [];
let services = [];
let bays = [];
let washers = [];
let ws = null;
let hasSignature = false;

const fmt = n => new Intl.NumberFormat("ru-RU").format(Math.round(n || 0)) + " ₸";
const todayStr = () => new Date().toISOString().slice(0, 10);

async function api(path, base, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const hadToken = !!token;
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(base + path, { ...options, headers });
  if (res.status === 401 && hadToken) {
    logout();
    throw new Error("Сессия истекла, войдите заново");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Ошибка запроса: ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}
const apiRecords = (path, opts) => api(path, "/api/records", opts);
const apiServices = (path, opts) => api(path, "/api/services", opts);
const apiBays = (path, opts) => api(path, "/api/bays", opts);
const apiWashers = (path, opts) => api(path, "/api/washers", opts);
const apiExpenses = (path, opts) => api(path, "/api/expenses", opts);
const apiClients = (path, opts) => api(path, "/api/clients", opts);
const apiLoyalty = (path, opts) => api(path, "/api/loyalty", opts);
const apiPayroll = (path, opts) => api(path, "/api/payroll", opts);
const apiReports = (path, opts) => api(path, "/api/reports", opts);
const apiAuth = (path, opts) => api(path, "/api/auth", opts);

async function boot() {
  document.getElementById("loginForm").addEventListener("submit", submitLogin);

  if (token) {
    try {
      currentUser = await apiAuth("/me");
      showApp();
      return;
    } catch (err) {
      token = null;
      localStorage.removeItem("token");
    }
  }
  showLogin();
}

function showLogin() {
  document.getElementById("loginScreen").style.display = "flex";
  document.getElementById("appLayout").style.display = "none";
}

async function submitLogin(e) {
  e.preventDefault();
  const username = document.getElementById("lUsername").value.trim();
  const password = document.getElementById("lPassword").value;
  const errEl = document.getElementById("loginError");
  errEl.style.display = "none";
  try {
    const data = await apiAuth("/login", { method: "POST", body: JSON.stringify({ username, password }) });
    token = data.token;
    currentUser = data.user;
    localStorage.setItem("token", token);
    showApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = "block";
  }
}

function logout() {
  token = null;
  currentUser = null;
  localStorage.removeItem("token");
  if (ws) { ws.close(); ws = null; }
  document.getElementById("lUsername").value = "";
  document.getElementById("lPassword").value = "";
  showLogin();
}

async function showApp() {
  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("appLayout").style.display = "flex";
  document.getElementById("currentUserName").textContent = currentUser.name;
  document.getElementById("currentUserRole").textContent = currentUser.role === "admin" ? "Администратор" : "Сотрудник";
  document.getElementById("usersNavItem").style.display = currentUser.role === "admin" ? "flex" : "none";
  document.getElementById("loyaltyNavItem").style.display = currentUser.role === "admin" ? "flex" : "none";
  document.getElementById("dateLabel").textContent =
    new Date().toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric" });

  setupSignaturePad();
  document.getElementById("recForm").addEventListener("submit", submitForm);
  document.getElementById("userForm").addEventListener("submit", submitUser);
  document.getElementById("newServiceForm").addEventListener("submit", submitNewService);
  document.getElementById("loyaltyForm").addEventListener("submit", submitLoyaltySettings);
  document.getElementById("payrollForm").addEventListener("submit", submitPayrollSettings);
  document.getElementById("newWasherForm").addEventListener("submit", submitNewWasher);
  document.getElementById("newExpenseForm").addEventListener("submit", submitNewExpense);

  await loadServices();
  await loadBays();
  await loadWashers();
  await loadRecords();
  await loadSummary();
  connectWebSocket();
}

function showError(msg) {
  const el = document.getElementById("errorState");
  el.textContent = msg;
  el.style.display = "block";
  document.getElementById("loadingState").style.display = "none";
}

async function loadServices() {
  try {
    services = await apiServices("");
    renderServiceCheckboxes();
  } catch (err) {
    services = [];
  }
}

async function loadBays() {
  try {
    bays = await apiBays("");
    renderBayOptions();
  } catch (err) {
    bays = [];
  }
}

function renderBayOptions() {
  const el = document.getElementById("fBay");
  if (!el) return;
  const current = el.value;
  el.innerHTML = bays.length === 0
    ? `<option value="">Нет боксов — добавьте ниже</option>`
    : bays.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join("");
  if (current && bays.some(b => String(b.id) === current)) el.value = current;
}

// --- Панель управления услугами (список, редактирование, скрытие, добавление) ---
async function openServicesPanel() {
  document.getElementById("servicesOverlay").style.display = "flex";
  await loadServices();
  renderServicesPanel();
}
function closeServicesPanel() { document.getElementById("servicesOverlay").style.display = "none"; }

function renderServicesPanel() {
  const el = document.getElementById("servicesEditList");
  if (services.length === 0) {
    el.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:8px 0;">Пока нет услуг</div>`;
    return;
  }
  const isAdmin = currentUser.role === "admin";
  el.innerHTML = services.map(s => isAdmin ? `
    <div class="svc-edit-row">
      <input type="text" id="svcName-${s.id}" value="${escapeHtml(s.name)}">
      <input type="number" id="svcPrice-${s.id}" value="${s.price}" min="0">
      <button type="button" class="svc-save" onclick="saveService(${s.id})">Сохранить</button>
      <button type="button" class="svc-hide" onclick="hideService(${s.id})">Скрыть</button>
    </div>
  ` : `
    <div class="svc-edit-row">
      <span style="flex:2;">${escapeHtml(s.name)}</span>
      <span style="color:var(--muted);">${fmt(s.price)}</span>
    </div>
  `).join("");
}

async function saveService(id) {
  const name = document.getElementById(`svcName-${id}`).value.trim();
  const price = Number(document.getElementById(`svcPrice-${id}`).value);
  if (!name || price < 0) return alert("Проверьте название и цену");
  try {
    const updated = await apiServices(`/${id}`, { method: "PUT", body: JSON.stringify({ name, price }) });
    services = services.map(s => s.id === id ? updated : s);
    renderServicesPanel();
    renderServiceCheckboxes();
  } catch (err) {
    alert("Не удалось сохранить услугу: " + err.message);
  }
}

async function hideService(id) {
  if (!confirm("Скрыть эту услугу из списка? Старые записи она не затронет.")) return;
  try {
    await apiServices(`/${id}`, { method: "DELETE" });
    services = services.filter(s => s.id !== id);
    renderServicesPanel();
    renderServiceCheckboxes();
  } catch (err) {
    alert("Не удалось скрыть услугу: " + err.message);
  }
}

async function submitNewService(e) {
  e.preventDefault();
  const name = document.getElementById("svcNewName").value.trim();
  const price = Number(document.getElementById("svcNewPrice").value);
  if (!name || price < 0) return alert("Укажите название и цену");
  try {
    const svc = await apiServices("", { method: "POST", body: JSON.stringify({ name, price }) });
    services = services.filter(s => s.id !== svc.id);
    services.push(svc);
    services.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    renderServicesPanel();
    renderServiceCheckboxes();
    document.getElementById("newServiceForm").reset();
  } catch (err) {
    alert("Не удалось добавить услугу: " + err.message);
  }
}

async function addBay() {
  const name = document.getElementById("newBayName").value.trim();
  if (!name) return alert("Укажите название бокса");
  try {
    const bay = await apiBays("", { method: "POST", body: JSON.stringify({ name }) });
    bays = bays.filter(b => b.id !== bay.id);
    bays.push(bay);
    bays.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    renderBayOptions();
    document.getElementById("fBay").value = bay.id;
    document.getElementById("newBayName").value = "";
  } catch (err) {
    alert("Не удалось добавить бокс: " + err.message);
  }
}

// --- Мойщики (кто принял машину) — выпадающий список в форме + отдельная панель управления ---
async function loadWashers() {
  try {
    washers = await apiWashers("");
    renderWasherOptions();
  } catch (err) {
    washers = [];
  }
}

function renderWasherOptions() {
  const el = document.getElementById("fReceivedBy");
  if (!el) return;
  const current = el.value;
  el.innerHTML = washers.length === 0
    ? `<option value="">Нет мойщиков — добавьте ниже</option>`
    : washers.map(w => `<option value="${escapeHtml(w.name)}">${escapeHtml(w.name)}</option>`).join("");
  if (current && washers.some(w => w.name === current)) el.value = current;
}

async function addWasherInline() {
  const name = document.getElementById("newWasherName").value.trim();
  if (!name) return alert("Укажите имя мойщика");
  try {
    const w = await apiWashers("", { method: "POST", body: JSON.stringify({ name }) });
    washers = washers.filter(x => x.id !== w.id);
    washers.push(w);
    washers.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    renderWasherOptions();
    document.getElementById("fReceivedBy").value = w.name;
    document.getElementById("newWasherName").value = "";
  } catch (err) {
    alert("Не удалось добавить мойщика: " + err.message);
  }
}

async function openWashersPanel() {
  document.getElementById("washersOverlay").style.display = "flex";
  await loadWashers();
  renderWashersPanel();
}
function closeWashersPanel() { document.getElementById("washersOverlay").style.display = "none"; }

function renderWashersPanel() {
  const el = document.getElementById("washersEditList");
  if (washers.length === 0) {
    el.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:8px 0;">Пока нет мойщиков</div>`;
    return;
  }
  const isAdmin = currentUser.role === "admin";
  el.innerHTML = washers.map(w => isAdmin ? `
    <div class="svc-edit-row">
      <input type="text" id="wshName-${w.id}" value="${escapeHtml(w.name)}">
      <button type="button" class="svc-save" onclick="saveWasher(${w.id})">Сохранить</button>
      <button type="button" class="svc-hide" onclick="hideWasher(${w.id})">Скрыть</button>
    </div>
  ` : `
    <div class="svc-edit-row">
      <span>${escapeHtml(w.name)}</span>
    </div>
  `).join("");
}

async function saveWasher(id) {
  const name = document.getElementById(`wshName-${id}`).value.trim();
  if (!name) return alert("Укажите имя");
  try {
    const updated = await apiWashers(`/${id}`, { method: "PUT", body: JSON.stringify({ name }) });
    washers = washers.map(w => w.id === id ? updated : w);
    renderWashersPanel();
    renderWasherOptions();
  } catch (err) {
    alert("Не удалось сохранить: " + err.message);
  }
}

async function hideWasher(id) {
  if (!confirm("Скрыть этого мойщика из списка? Старые записи он не затронет.")) return;
  try {
    await apiWashers(`/${id}`, { method: "DELETE" });
    washers = washers.filter(w => w.id !== id);
    renderWashersPanel();
    renderWasherOptions();
  } catch (err) {
    alert("Не удалось скрыть: " + err.message);
  }
}

async function submitNewWasher(e) {
  e.preventDefault();
  const name = document.getElementById("wshNewName").value.trim();
  if (!name) return alert("Укажите имя");
  try {
    const w = await apiWashers("", { method: "POST", body: JSON.stringify({ name }) });
    washers = washers.filter(x => x.id !== w.id);
    washers.push(w);
    washers.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    renderWashersPanel();
    renderWasherOptions();
    document.getElementById("newWasherForm").reset();
  } catch (err) {
    alert("Не удалось добавить: " + err.message);
  }
}

// --- Расходы (мастер, ремонт, закупки и т.п.) — списываются из наличной кассы ---
async function openExpensesPanel() {
  document.getElementById("expensesOverlay").style.display = "flex";
  document.getElementById("expNewDate").value = todayStr();
  await loadExpensesPanel();
}
function closeExpensesPanel() { document.getElementById("expensesOverlay").style.display = "none"; }

async function loadExpensesPanel() {
  const el = document.getElementById("expensesList");
  el.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:8px 0;">Загрузка…</div>`;
  try {
    const list = await apiExpenses("");
    if (list.length === 0) {
      el.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:8px 0;">Пока нет расходов</div>`;
      return;
    }
    el.innerHTML = list.map(e => `
      <div class="expense-row">
        <div class="exp-desc">
          <div>${escapeHtml(e.description)}</div>
          <div class="exp-date">${new Date(e.expense_date).toLocaleDateString("ru-RU")} · ${escapeHtml(e.staff_name || "—")}</div>
        </div>
        <div class="exp-amount">−${fmt(e.amount)}</div>
        <button class="exp-del" onclick="deleteExpense(${e.id})">🗑</button>
      </div>
    `).join("");
  } catch (err) {
    el.innerHTML = `<div style="color:var(--danger);font-size:13px;">${err.message}</div>`;
  }
}

async function submitNewExpense(e) {
  e.preventDefault();
  const payload = {
    expense_date: document.getElementById("expNewDate").value,
    description: document.getElementById("expNewDescription").value.trim(),
    amount: Number(document.getElementById("expNewAmount").value),
  };
  if (!payload.description || payload.amount == null || payload.amount < 0) {
    return alert("Заполните дату, описание и сумму");
  }
  try {
    await apiExpenses("", { method: "POST", body: JSON.stringify(payload) });
    document.getElementById("newExpenseForm").reset();
    document.getElementById("expNewDate").value = todayStr();
    await loadExpensesPanel();
  } catch (err) {
    alert("Не удалось добавить расход: " + err.message);
  }
}

async function deleteExpense(id) {
  if (!confirm("Удалить этот расход?")) return;
  try {
    await apiExpenses(`/${id}`, { method: "DELETE" });
    await loadExpensesPanel();
  } catch (err) {
    alert("Не удалось удалить: " + err.message);
  }
}

async function loadRecords(silent) {
  if (!silent) {
    document.getElementById("loadingState").style.display = "block";
    document.getElementById("errorState").style.display = "none";
    document.getElementById("tableWrap").style.display = "none";
    document.getElementById("emptyState").style.display = "none";
  }
  try {
    const params = new URLSearchParams();
    const from = document.getElementById("filterFrom")?.value;
    const to = document.getElementById("filterTo")?.value;
    const q = document.getElementById("filterQuery")?.value.trim();
    if (from) params.set("date_from", from);
    if (to) params.set("date_to", to);
    if (q) params.set("q", q);
    const qs = params.toString();
    records = await apiRecords(qs ? `?${qs}` : "");
    render();
  } catch (err) {
    if (!silent) showError("Не удалось загрузить записи: " + err.message);
  }
  if (!silent) document.getElementById("loadingState").style.display = "none";
}

let filterDebounceTimer = null;
function applyFilters() { loadRecords(); }
function applyFiltersDebounced() {
  clearTimeout(filterDebounceTimer);
  filterDebounceTimer = setTimeout(() => loadRecords(), 350);
}
function clearFilters() {
  document.getElementById("filterFrom").value = "";
  document.getElementById("filterTo").value = "";
  document.getElementById("filterQuery").value = "";
  loadRecords();
}

async function loadSummary() {
  try {
    const s = await apiRecords("/summary/today");
    document.getElementById("kpiCars").textContent = s.cars_count;
    document.getElementById("kpiRevenue").textContent = fmt(s.total_revenue);
  } catch (err) { /* сводка необязательна */ }
}

function connectWebSocket() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  try {
    ws = new WebSocket(`${protocol}//${location.host}/ws`);
    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === "updated") { loadRecords(true); loadSummary(); }
    };
  } catch (err) { /* без realtime — не критично */ }
}

function paymentIcon(r) {
  const cash = Number(r.amount_cash) || 0;
  const qr = Number(r.amount_qr) || 0;
  if (cash > 0 && qr > 0) return "💵📱";
  if (qr > 0) return "📱";
  if (cash > 0) return "💵";
  return "—";
}

function paymentLabel(r) {
  const cash = Number(r.amount_cash) || 0;
  const qr = Number(r.amount_qr) || 0;
  if (cash > 0 && qr > 0) return "💳 Смешанно";
  if (qr > 0) return "📱 QR";
  if (cash > 0) return "💵 Наличные";
  return "—";
}

function render() {
  const tableWrap = document.getElementById("tableWrap");
  const cardList = document.getElementById("cardList");
  const emptyState = document.getElementById("emptyState");

  if (records.length === 0) {
    tableWrap.style.display = "none";
    cardList.innerHTML = "";
    emptyState.style.display = "block";
    return;
  }
  emptyState.style.display = "none";
  tableWrap.style.display = "block";

  document.getElementById("tableBody").innerHTML = records.map(r => {
    const dateFmt = new Date(r.service_date).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
    const svcText = (r.services || []).map(s => s.name).join(", ") || "—";
    const sigCell = r.signature ? `<img class="sig-thumb" src="${r.signature}" alt="подпись">` : `<span class="sig-none">—</span>`;
    return `<tr>
      <td>${dateFmt}</td>
      <td>${escapeHtml(r.car_brand)}</td>
      <td>${escapeHtml(r.car_number)}</td>
      <td>${escapeHtml(r.bay_name || "—")}</td>
      <td>${escapeHtml(svcText)}</td>
      <td class="price-cell">${fmt(r.price)}</td>
      <td>${paymentIcon(r)}</td>
      <td style="color:var(--muted)">${escapeHtml(r.received_by || r.staff_name || "—")}</td>
      <td>${sigCell}</td>
      <td>
        ${currentUser.role === "admin" ? `<button class="del-btn" onclick="openForm(${r.id})">✏️</button>` : ""}
        ${currentUser.role === "admin" ? `<button class="del-btn" onclick="removeRecord(${r.id})">🗑</button>` : ""}
      </td>
    </tr>`;
  }).join("");

  cardList.innerHTML = records.map(r => {
    const dateFmt = new Date(r.service_date).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
    const svcText = (r.services || []).map(s => s.name).join(", ") || "—";
    return `<div class="rec-card">
      <div class="rec-card-top">
        <div class="rec-title">${escapeHtml(r.car_brand)} · ${escapeHtml(r.car_number)}</div>
        <div class="rec-amount">${fmt(r.price)}</div>
      </div>
      <div class="rec-badges">
        <span class="rec-badge">📅 ${dateFmt}</span>
        <span class="rec-badge">📍 ${escapeHtml(r.bay_name || "—")}</span>
        <span class="rec-badge">${paymentLabel(r)}</span>
      </div>
      <div class="rec-services">🧴 ${escapeHtml(svcText)}</div>
      <div class="rec-card-footer">
        <span class="rec-staff">👤 ${escapeHtml(r.received_by || r.staff_name || "—")}</span>
        <div class="rec-actions">
          ${currentUser.role === "admin" ? `<button class="rec-action-btn" onclick="openForm(${r.id})">✏️</button>` : ""}
          ${currentUser.role === "admin" ? `<button class="rec-action-btn" onclick="removeRecord(${r.id})">🗑</button>` : ""}
        </div>
      </div>
    </div>`;
  }).join("");
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str == null ? "" : str;
  return d.innerHTML;
}

async function removeRecord(id) {
  if (!confirm("Удалить эту запись?")) return;
  try {
    await apiRecords(`/${id}`, { method: "DELETE" });
    records = records.filter(r => String(r.id) !== String(id));
    render();
    loadSummary();
  } catch (err) {
    alert("Не удалось удалить: " + err.message);
  }
}

// --- Форма новой/редактируемой записи ---
let editingRecordId = null;

function openForm(recordId) {
  editingRecordId = recordId || null;
  const record = editingRecordId ? records.find(r => String(r.id) === String(editingRecordId)) : null;

  document.getElementById("modalTitle").textContent = record ? "Редактировать запись" : "Новая запись";
  document.getElementById("saveBtnLabel").textContent = record ? "Сохранить изменения" : "Сохранить запись";

  document.getElementById("fDate").value = record ? record.service_date.slice(0, 10) : todayStr();
  document.getElementById("fPrice").value = record ? record.price : "";
  document.getElementById("fBrand").value = record ? record.car_brand : "";
  document.getElementById("fNumber").value = record ? record.car_number : "";
  document.getElementById("newServiceName").value = "";
  document.getElementById("newServicePrice").value = "";
  document.getElementById("newBayName").value = "";
  document.getElementById("newWasherName").value = "";
  document.getElementById("fClientPhone").value = "";
  document.getElementById("clientCard").style.display = "none";
  loyaltyLookup = null;
  document.getElementById("loyaltySection").style.display = record ? "none" : "block";

  if (record) {
    const method = Number(record.amount_qr) > 0 && Number(record.amount_cash) > 0
      ? "mixed"
      : Number(record.amount_qr) > 0 ? "qr" : "cash";
    document.querySelector(`input[name="paymentMethod"][value="${method}"]`).checked = true;
    document.getElementById("fAmountCash").value = record.amount_cash || "";
    document.getElementById("fAmountQr").value = record.amount_qr || "";
  } else {
    document.querySelector('input[name="paymentMethod"][value="cash"]').checked = true;
    document.getElementById("fAmountCash").value = "";
    document.getElementById("fAmountQr").value = "";
  }
  onPaymentMethodChange();

  clearSignature();
  if (record && record.signature) {
    hasSignature = true;
    const img = new Image();
    img.onload = () => sigCanvas.getContext("2d").drawImage(img, 0, 0, sigCanvas.width, sigCanvas.height);
    img.src = record.signature;
  }
  renderServiceCheckboxes();
  renderBayOptions();
  renderWasherOptions();
  document.getElementById("fReceivedBy").value = record ? record.received_by : currentUser.name;
  if (record) {
    document.getElementById("fBay").value = String(record.bay_id || "");
    const selectedIds = new Set((record.services || []).map(s => String(s.id)));
    document.querySelectorAll('#servicesList input[type="checkbox"]').forEach(cb => {
      cb.checked = selectedIds.has(cb.value);
    });
  }
  document.getElementById("modalOverlay").style.display = "flex";
}
function closeForm() { document.getElementById("modalOverlay").style.display = "none"; editingRecordId = null; }

function renderServiceCheckboxes() {
  const el = document.getElementById("servicesList");
  if (!el) return;
  if (services.length === 0) {
    el.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:8px;">Пока нет услуг — добавьте первую ниже</div>`;
    return;
  }
  el.innerHTML = services.map(s => `
    <label class="service-item">
      <input type="checkbox" value="${s.id}" data-price="${s.price}" onchange="recalcPrice()">
      <span class="svc-name">${escapeHtml(s.name)}</span>
      <span class="svc-price">${fmt(s.price)}</span>
    </label>
  `).join("");
}

function recalcPrice() {
  const checked = [...document.querySelectorAll('#servicesList input[type="checkbox"]:checked')];
  const sum = checked.reduce((acc, c) => acc + Number(c.dataset.price), 0);
  document.getElementById("fPrice").value = sum;
}

async function addService() {
  const name = document.getElementById("newServiceName").value.trim();
  const price = Number(document.getElementById("newServicePrice").value);
  if (!name || !price || price < 0) return alert("Укажите название и цену новой услуги");
  try {
    const svc = await apiServices("", { method: "POST", body: JSON.stringify({ name, price }) });
    services = services.filter(s => s.id !== svc.id);
    services.push(svc);
    services.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    renderServiceCheckboxes();
    document.getElementById("newServiceName").value = "";
    document.getElementById("newServicePrice").value = "";
    // сразу отмечаем добавленную услугу
    const checkbox = document.querySelector(`#servicesList input[value="${svc.id}"]`);
    if (checkbox) { checkbox.checked = true; recalcPrice(); }
  } catch (err) {
    alert("Не удалось добавить услугу: " + err.message);
  }
}

// --- Панель клиентов бонусной программы ---
let clientsSearchTimer = null;

async function openClientsPanel() {
  document.getElementById("clientsOverlay").style.display = "flex";
  document.getElementById("clientsSearch").value = "";
  await loadClientsList();
}
function closeClientsPanel() { document.getElementById("clientsOverlay").style.display = "none"; }

function searchClientsDebounced() {
  clearTimeout(clientsSearchTimer);
  clientsSearchTimer = setTimeout(loadClientsList, 300);
}

async function loadClientsList() {
  const listEl = document.getElementById("clientsList");
  listEl.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:8px 0;">Загрузка…</div>`;
  try {
    const q = document.getElementById("clientsSearch").value.trim();
    const list = await apiClients(q ? `?q=${encodeURIComponent(q)}` : "");
    if (list.length === 0) {
      listEl.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:8px 0;">Клиентов пока нет — они появятся здесь после первой записи с указанным телефоном.</div>`;
      return;
    }
    const isAdmin = currentUser.role === "admin";
    listEl.innerHTML = list.map(c => `
      <div class="client-row">
        <div class="client-row-view">
          <div>
            <div class="cr-name">${escapeHtml(c.name || "Без имени")}</div>
            <div class="cr-phone">+${escapeHtml(c.phone)}</div>
          </div>
          <div class="cr-stats">${c.visit_count} визитов · ${fmt(c.points_balance)}</div>
        </div>
        ${isAdmin ? `
          <div class="client-edit-row">
            <input type="text" id="clName-${c.id}" value="${escapeHtml(c.name || "")}" placeholder="Имя">
            <input type="number" id="clVisits-${c.id}" value="${c.visit_count}" min="0">
            <input type="number" id="clPoints-${c.id}" value="${c.points_balance}" min="0">
            <button type="button" onclick="saveClient(${c.id})">Сохранить</button>
          </div>
        ` : ""}
      </div>
    `).join("");
  } catch (err) {
    listEl.innerHTML = `<div style="color:var(--danger);font-size:13px;">${err.message}</div>`;
  }
}

async function saveClient(id) {
  const name = document.getElementById(`clName-${id}`).value.trim();
  const visit_count = Number(document.getElementById(`clVisits-${id}`).value);
  const points_balance = Number(document.getElementById(`clPoints-${id}`).value);
  try {
    await apiClients(`/${id}`, { method: "PUT", body: JSON.stringify({ name, visit_count, points_balance }) });
    await loadClientsList();
  } catch (err) {
    alert("Не удалось сохранить: " + err.message);
  }
}

// --- Бонусная программа: поиск клиента по телефону, скидка за визиты, баллы ---
let loyaltyLookup = null; // последний результат поиска клиента
let loyaltyDebounceTimer = null;

function lookupClientDebounced() {
  clearTimeout(loyaltyDebounceTimer);
  loyaltyDebounceTimer = setTimeout(lookupClient, 400);
}

async function lookupClient() {
  const raw = document.getElementById("fClientPhone").value;
  const digits = raw.replace(/\D/g, "");
  const cardEl = document.getElementById("clientCard");
  if (digits.length < 7) {
    loyaltyLookup = null;
    cardEl.style.display = "none";
    return;
  }
  try {
    const data = await apiClients(`/lookup?phone=${encodeURIComponent(digits)}`);
    loyaltyLookup = data;
    renderClientCard();
  } catch (err) {
    cardEl.style.display = "none";
  }
}

function renderClientCard() {
  const cardEl = document.getElementById("clientCard");
  if (!loyaltyLookup) { cardEl.style.display = "none"; return; }
  cardEl.style.display = "block";

  if (!loyaltyLookup.found) {
    cardEl.innerHTML = `
      <div class="cc-new">Новый клиент — будет создан после сохранения записи.</div>
      <input type="text" id="fClientName" placeholder="Имя клиента (необязательно)" style="width:100%;margin-top:6px;padding:7px 9px;border-radius:7px;background:var(--surface);border:1px solid var(--border);font-size:13px;">
    `;
    return;
  }

  const c = loyaltyLookup.client;
  cardEl.innerHTML = `
    <div class="cc-name">${escapeHtml(c.name || "Без имени")}</div>
    <div class="cc-row"><span>Визитов</span><span>${c.visit_count}</span></div>
    <div class="cc-row"><span>Баллов</span><span>${fmt(c.points_balance)}</span></div>
    ${Number(c.points_balance) > 0 ? `
      <div class="cc-redeem">
        <input type="number" id="fRedeemPoints" min="0" max="${c.points_balance}" placeholder="Списать баллов">
        <button type="button" onclick="document.getElementById('fRedeemPoints').value=${c.points_balance}">Списать всё</button>
      </div>
      <div class="cc-redeem" style="margin-top:6px;">
        <button type="button" onclick="requestRedeemCode()">📩 Запросить SMS-код</button>
        <input type="text" id="fOtpCode" placeholder="Код из SMS" maxlength="4" inputmode="numeric">
      </div>
      <div id="otpStatus" class="otp-status"></div>
    ` : ""}
  `;
}

async function requestRedeemCode() {
  const phone = document.getElementById("fClientPhone").value.trim();
  const statusEl = document.getElementById("otpStatus");
  statusEl.textContent = "Отправляем код…";
  try {
    const res = await apiClients("/request-redeem-code", { method: "POST", body: JSON.stringify({ phone }) });
    statusEl.textContent = res.dev_code
      ? `Тестовый режим (SMS-шлюз не настроен) — код: ${res.dev_code}`
      : "Код отправлен по SMS, действует 5 минут.";
  } catch (err) {
    statusEl.textContent = "Не удалось отправить код: " + err.message;
  }
}

// --- Способ оплаты в форме записи ---
function onPaymentMethodChange() {
  const method = document.querySelector('input[name="paymentMethod"]:checked').value;
  document.getElementById("mixedPaymentRow").style.display = method === "mixed" ? "flex" : "none";
}

function computePaymentAmounts(finalAmount) {
  const method = document.querySelector('input[name="paymentMethod"]:checked').value;
  if (method === "cash") return { amount_cash: finalAmount, amount_qr: 0 };
  if (method === "qr") return { amount_cash: 0, amount_qr: finalAmount };
  return {
    amount_cash: Number(document.getElementById("fAmountCash").value) || 0,
    amount_qr: Number(document.getElementById("fAmountQr").value) || 0,
  };
}

// --- Отчёт по кассе (смена/период) ---
let lastReportData = null;
let lastReportPeriod = "";

async function openReportPanel() {
  document.getElementById("reportOverlay").style.display = "flex";
  document.getElementById("repFrom").value = todayStr();
  document.getElementById("repTo").value = todayStr();

  const isAdmin = currentUser.role === "admin";
  document.getElementById("payrollSettingsBlock").style.display = isAdmin ? "block" : "none";
  if (isAdmin) {
    try {
      const s = await apiPayroll("/settings");
      document.getElementById("ppAdminPercent").value = s.admin_percent;
      document.getElementById("ppWasherPercent").value = s.washer_percent;
    } catch (err) { /* тихо игнорируем */ }
  }

  await loadReport();
}
function closeReportPanel() { document.getElementById("reportOverlay").style.display = "none"; }

async function loadReport() {
  const bodyEl = document.getElementById("reportBody");
  bodyEl.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:12px 0;">Загрузка…</div>`;
  try {
    const from = document.getElementById("repFrom").value;
    const to = document.getElementById("repTo").value;
    const params = new URLSearchParams();
    if (from) params.set("date_from", from);
    if (to) params.set("date_to", to);
    const r = await apiReports(`/shift?${params.toString()}`);
    lastReportData = r;
    lastReportPeriod = from === to ? from : `${from} — ${to}`;

    const washerRows = r.washer_breakdown.map(w => `
      <tr>
        <td>${escapeHtml(w.name)}</td>
        <td>${w.cars_count}</td>
        <td>${fmt(w.revenue)}</td>
        <td>${fmt(w.salary)}</td>
      </tr>
    `).join("");

    const expenseRows = (r.expenses || []).map(e => `
      <tr>
        <td>${new Date(e.expense_date).toLocaleDateString("ru-RU")}</td>
        <td>${escapeHtml(e.description)}</td>
        <td>${escapeHtml(e.staff_name || "—")}</td>
        <td>${fmt(e.amount)}</td>
      </tr>
    `).join("");

    bodyEl.innerHTML = `
      <div class="report-kpi-grid">
        <div class="report-kpi"><div class="rk-label">Машин</div><div class="rk-value">${r.cars_count}</div></div>
        <div class="report-kpi"><div class="rk-label">Общая касса</div><div class="rk-value">${fmt(r.total_revenue)}</div></div>
        <div class="report-kpi"><div class="rk-label">Наличными</div><div class="rk-value">${fmt(r.total_cash)}</div></div>
        <div class="report-kpi"><div class="rk-label">QR</div><div class="rk-value">${fmt(r.total_qr)}</div></div>
        <div class="report-kpi"><div class="rk-label">Бонусами оплачено</div><div class="rk-value">${fmt(r.total_bonus_redeemed)}</div></div>
        <div class="report-kpi"><div class="rk-label">Процент админа (${r.admin_percent}%)</div><div class="rk-value">${fmt(r.admin_cut)}</div></div>
        <div class="report-kpi"><div class="rk-label">Расходы</div><div class="rk-value" style="color:var(--danger);">−${fmt(r.total_expenses)}</div></div>
      </div>

      <table class="washer-table">
        <thead><tr><th>Мойщик</th><th>Машин</th><th>Выручка</th><th>ЗП (${r.washer_percent}%)</th></tr></thead>
        <tbody>${washerRows || `<tr><td colspan="4" style="color:var(--muted);">Записей нет</td></tr>`}</tbody>
        <tfoot><tr><td colspan="3">Итого зарплата мойщикам</td><td>${fmt(r.washer_total)}</td></tr></tfoot>
      </table>

      ${(r.expenses || []).length > 0 ? `
        <table class="washer-table">
          <thead><tr><th>Дата</th><th>За что</th><th>Кто внёс</th><th>Сумма</th></tr></thead>
          <tbody>${expenseRows}</tbody>
          <tfoot><tr><td colspan="3">Итого расходов</td><td>${fmt(r.total_expenses)}</td></tr></tfoot>
        </table>
      ` : ""}

      <div class="report-highlight">
        <div class="rk-label">Наличными сдать (наличные − ЗП мойщиков − процент админа − расходы)</div>
        <div class="rk-value">${fmt(r.cash_to_handover)}</div>
      </div>
    `;
  } catch (err) {
    bodyEl.innerHTML = `<div style="color:var(--danger);font-size:13px;">${err.message}</div>`;
  }
}

// Печатает отчёт в новой вкладке — пользователь сохраняет как PDF через системный
// диалог печати браузера (Ctrl+P → «Сохранить как PDF»). Это не требует ни
// серверных PDF-библиотек, ни отдельных шрифтов для кириллицы — просто HTML,
// который браузер сам умеет превращать в PDF.
function downloadReportPdf() {
  if (!lastReportData) return alert("Сначала дождитесь загрузки отчёта");
  const r = lastReportData;

  const washerRows = r.washer_breakdown.map(w => `
    <tr><td>${escapeHtml(w.name)}</td><td>${w.cars_count}</td><td>${fmt(w.revenue)}</td><td>${fmt(w.salary)}</td></tr>
  `).join("");

  const expenseRows = (r.expenses || []).map(e => `
    <tr><td>${new Date(e.expense_date).toLocaleDateString("ru-RU")}</td><td>${escapeHtml(e.description)}</td><td>${escapeHtml(e.staff_name || "—")}</td><td>${fmt(e.amount)}</td></tr>
  `).join("");

  const html = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><title>Отчёт по кассе — ${escapeHtml(lastReportPeriod)}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;color:#122642;padding:28px;}
  h1{font-size:20px;margin:0 0 2px;}
  .sub{color:#6C86A6;font-size:13px;margin-bottom:20px;}
  .kpi-row{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:18px;}
  .kpi{border:1px solid #D9E7F6;border-radius:8px;padding:10px 14px;min-width:150px;}
  .kpi-label{color:#6C86A6;font-size:11px;}
  .kpi-value{font-weight:700;font-size:16px;color:#1657A6;}
  table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px;}
  th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #D9E7F6;}
  tfoot td{font-weight:700;border-top:2px solid #D9E7F6;border-bottom:none;}
  .final{margin-top:22px;padding:16px;background:#1657A6;color:#fff;border-radius:8px;}
  .final .kpi-label{color:rgba(255,255,255,.8);}
  .final .kpi-value{color:#fff;font-size:20px;}
  @media print{ @page{ margin:16mm; } }
</style></head>
<body>
  <h1>Автомойка — отчёт по кассе</h1>
  <div class="sub">Период: ${escapeHtml(lastReportPeriod)}</div>
  <div class="kpi-row">
    <div class="kpi"><div class="kpi-label">Машин</div><div class="kpi-value">${r.cars_count}</div></div>
    <div class="kpi"><div class="kpi-label">Общая касса</div><div class="kpi-value">${fmt(r.total_revenue)}</div></div>
    <div class="kpi"><div class="kpi-label">Наличными</div><div class="kpi-value">${fmt(r.total_cash)}</div></div>
    <div class="kpi"><div class="kpi-label">QR</div><div class="kpi-value">${fmt(r.total_qr)}</div></div>
    <div class="kpi"><div class="kpi-label">Бонусами оплачено</div><div class="kpi-value">${fmt(r.total_bonus_redeemed)}</div></div>
    <div class="kpi"><div class="kpi-label">Процент админа (${r.admin_percent}%)</div><div class="kpi-value">${fmt(r.admin_cut)}</div></div>
    <div class="kpi"><div class="kpi-label">Расходы</div><div class="kpi-value">−${fmt(r.total_expenses)}</div></div>
  </div>
  <table>
    <thead><tr><th>Мойщик</th><th>Машин</th><th>Выручка</th><th>ЗП (${r.washer_percent}%)</th></tr></thead>
    <tbody>${washerRows || `<tr><td colspan="4">Записей нет</td></tr>`}</tbody>
    <tfoot><tr><td colspan="3">Итого зарплата мойщикам</td><td>${fmt(r.washer_total)}</td></tr></tfoot>
  </table>
  ${expenseRows ? `
  <table>
    <thead><tr><th>Дата</th><th>За что</th><th>Кто внёс</th><th>Сумма</th></tr></thead>
    <tbody>${expenseRows}</tbody>
    <tfoot><tr><td colspan="3">Итого расходов</td><td>${fmt(r.total_expenses)}</td></tr></tfoot>
  </table>
  ` : ""}
  <div class="final">
    <div class="kpi-label">Наличными сдать (наличные − ЗП мойщиков − процент админа − расходы)</div>
    <div class="kpi-value">${fmt(r.cash_to_handover)}</div>
  </div>
</body></html>`;

  const win = window.open("", "_blank");
  if (!win) return alert("Браузер заблокировал открытие окна — разрешите всплывающие окна для этого сайта");
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}

async function submitPayrollSettings(e) {
  e.preventDefault();
  const payload = {
    admin_percent: Number(document.getElementById("ppAdminPercent").value),
    washer_percent: Number(document.getElementById("ppWasherPercent").value),
  };
  try {
    await apiPayroll("/settings", { method: "PUT", body: JSON.stringify(payload) });
    await loadReport();
  } catch (err) {
    alert("Не удалось сохранить настройки: " + err.message);
  }
}

// --- Настройки бонусной программы (только админ) ---
async function openLoyaltySettings() {
  document.getElementById("loyaltyOverlay").style.display = "flex";
  try {
    const s = await apiLoyalty("/settings");
    document.getElementById("lsPointsPercent").value = s.points_percent;
  } catch (err) {
    alert("Не удалось загрузить настройки: " + err.message);
  }
}
function closeLoyaltySettings() { document.getElementById("loyaltyOverlay").style.display = "none"; }

async function submitLoyaltySettings(e) {
  e.preventDefault();
  const payload = { points_percent: Number(document.getElementById("lsPointsPercent").value) };
  try {
    await apiLoyalty("/settings", { method: "PUT", body: JSON.stringify(payload) });
    closeLoyaltySettings();
  } catch (err) {
    alert("Не удалось сохранить настройки: " + err.message);
  }
}

// --- Подпись на canvas (мышь и палец) ---
let sigCtx, sigCanvas, drawing = false;

function setupSignaturePad() {
  sigCanvas = document.getElementById("sigPad");
  resizeSignaturePad();

  const pos = (evt) => {
    const rect = sigCanvas.getBoundingClientRect();
    const point = evt.touches ? evt.touches[0] : evt;
    return { x: point.clientX - rect.left, y: point.clientY - rect.top };
  };

  const start = (evt) => { evt.preventDefault(); drawing = true; const p = pos(evt); const ctx = sigCanvas.getContext("2d"); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
  const move = (evt) => {
    if (!drawing) return;
    evt.preventDefault();
    const p = pos(evt);
    const ctx = sigCanvas.getContext("2d");
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    hasSignature = true;
  };
  const end = () => { drawing = false; };

  sigCanvas.addEventListener("mousedown", start);
  sigCanvas.addEventListener("mousemove", move);
  window.addEventListener("mouseup", end);
  sigCanvas.addEventListener("touchstart", start, { passive: false });
  sigCanvas.addEventListener("touchmove", move, { passive: false });
  sigCanvas.addEventListener("touchend", end);

  window.addEventListener("resize", resizeSignaturePad);
}

function resizeSignaturePad() {
  const canvas = document.getElementById("sigPad");
  const ratio = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 380;
  const h = canvas.clientHeight || 140;
  canvas.width = w * ratio;
  canvas.height = h * ratio;
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  ctx.strokeStyle = "#1657A6";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
}

function clearSignature() {
  if (!sigCanvas) sigCanvas = document.getElementById("sigPad");
  const ctx = sigCanvas.getContext("2d");
  ctx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
  hasSignature = false;
}

async function submitForm(e) {
  e.preventDefault();
  const price = Number(document.getElementById("fPrice").value);
  if (price == null || price < 0) return alert("Укажите корректную цену");

  const service_ids = [...document.querySelectorAll('#servicesList input[type="checkbox"]:checked')]
    .map(c => Number(c.value));
  if (service_ids.length === 0) return alert("Выберите хотя бы одну услугу");

  const bay_id = Number(document.getElementById("fBay").value);
  if (!bay_id) return alert("Выберите бокс");

  const received_by = document.getElementById("fReceivedBy").value.trim();
  if (!received_by) return alert("Укажите, кто принял машину");

  const payload = {
    service_date: document.getElementById("fDate").value,
    car_brand: document.getElementById("fBrand").value.trim(),
    car_number: document.getElementById("fNumber").value.trim(),
    price,
    bay_id,
    received_by,
    service_ids,
    signature: hasSignature ? sigCanvas.toDataURL("image/png") : null,
  };

  if (!editingRecordId) {
    const phoneRaw = document.getElementById("fClientPhone").value.trim();
    if (phoneRaw) {
      payload.client_phone = phoneRaw;
      const nameEl = document.getElementById("fClientName");
      if (nameEl && nameEl.value.trim()) payload.client_name = nameEl.value.trim();
      const redeemEl = document.getElementById("fRedeemPoints");
      payload.redeem_points = redeemEl ? Number(redeemEl.value) || 0 : 0;
      if (payload.redeem_points > 0) {
        const otpEl = document.getElementById("fOtpCode");
        payload.otp_code = otpEl ? otpEl.value.trim() : "";
        if (!payload.otp_code) return alert("Введите код из SMS, чтобы списать баллы");
      }
    }
  }

  // Наличные/QR считаются от суммы, которая реально перейдёт из рук в руки —
  // то есть цена минус баллы, которые клиент, возможно, списывает.
  const estimatedFinal = Math.max(0, price - (payload.redeem_points || 0));
  Object.assign(payload, computePaymentAmounts(estimatedFinal));

  try {
    if (editingRecordId) {
      await apiRecords(`/${editingRecordId}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await apiRecords("", { method: "POST", body: JSON.stringify(payload) });
    }
    await loadRecords(true);
    await loadSummary();
    closeForm();
  } catch (err) {
    alert("Не удалось сохранить: " + err.message);
  }
}

// --- Пользователи (только админ) ---
async function openUsers() {
  document.getElementById("usersOverlay").style.display = "flex";
  await loadUsers();
}
function closeUsers() { document.getElementById("usersOverlay").style.display = "none"; }

async function loadUsers() {
  try {
    const users = await apiAuth("/users");
    document.getElementById("usersList").innerHTML = users.map(u => `
      <div class="user-row">
        <div>
          <div>${escapeHtml(u.name)} <span style="color:var(--muted);">(${escapeHtml(u.username)})</span></div>
          <div class="u-role">${u.role === "admin" ? "Администратор" : "Сотрудник"}</div>
        </div>
        ${u.id === currentUser.id ? "" : `<button class="u-del" onclick="hideUser(${u.id})">Скрыть</button>`}
      </div>
    `).join("") || `<div style="color:var(--muted);font-size:13px;">Пока никого нет</div>`;
  } catch (err) {
    document.getElementById("usersList").innerHTML = `<div style="color:var(--danger);font-size:13px;">${err.message}</div>`;
  }
}

async function submitUser(e) {
  e.preventDefault();
  const payload = {
    name: document.getElementById("uName").value.trim(),
    username: document.getElementById("uUsername").value.trim(),
    password: document.getElementById("uPassword").value,
    role: document.getElementById("uRole").value,
  };
  try {
    await apiAuth("/users", { method: "POST", body: JSON.stringify(payload) });
    document.getElementById("userForm").reset();
    await loadUsers();
  } catch (err) {
    alert("Не удалось добавить пользователя: " + err.message);
  }
}

async function hideUser(id) {
  if (!confirm("Скрыть этого пользователя? Он больше не сможет войти, но его старые записи в журнале останутся.")) return;
  try {
    await apiAuth(`/users/${id}`, { method: "DELETE" });
    await loadUsers();
  } catch (err) {
    alert("Не удалось скрыть: " + err.message);
  }
}

boot();
