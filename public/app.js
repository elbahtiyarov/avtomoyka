// Aquazone — фронтенд: вход по логину/паролю (JWT), журнал записей, каталог услуг

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
    desktop: "1. В адресной строке справа найдите значок установки (обычно ⊕ или экран со стрелкой).\n2. Нажмите его и подтвердите установку.\n\nЕсли значка нет — откройте меню браузера (⋮) → «Установить Aquazone…».",
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
let companiesList = [];
let ws = null;
let hasSignature = false;

const fmt = n => new Intl.NumberFormat("ru-RU").format(Math.round(n || 0)) + " ₸";
function roleLabel(role) {
  if (role === "admin") return "Администратор";
  if (role === "manager") return "Менеджер";
  return "Сотрудник";
}
function canModifyRecord(r) {
  if (currentUser.role === "admin") return true;
  if (currentUser.role === "manager") return r.staff_role !== "admin";
  return false;
}
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
const apiCompanies = (path, opts) => api(path, "/api/companies", opts);
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
  document.getElementById("currentUserRole").textContent = roleLabel(currentUser.role);
  const isAdminOrManager = currentUser.role === "admin" || currentUser.role === "manager";
  document.getElementById("usersNavItem").style.display = isAdminOrManager ? "flex" : "none";
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
  document.getElementById("newBayForm").addEventListener("submit", submitNewBay);
  document.getElementById("newExpenseForm").addEventListener("submit", submitNewExpense);
  document.getElementById("newCompanyForm").addEventListener("submit", submitNewCompany);
  document.getElementById("newClientForm").addEventListener("submit", submitNewClient);

  await loadServices();
  await loadBays();
  await loadWashers();
  await loadCompaniesForForm();
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
      <input type="number" id="svcWasherPercent-${s.id}" value="${s.washer_percent_override != null ? s.washer_percent_override : ""}" min="0" max="100" step="0.5" placeholder="общий %" title="Личный % мойщику за эту услугу — пусто означает общий процент" style="max-width:80px;">
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
  const wpInput = document.getElementById(`svcWasherPercent-${id}`).value.trim();
  const washer_percent_override = wpInput === "" ? null : Number(wpInput);
  if (!name || price < 0) return alert("Проверьте название и цену");
  try {
    const updated = await apiServices(`/${id}`, { method: "PUT", body: JSON.stringify({ name, price, washer_percent_override }) });
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
  const wpInput = document.getElementById("svcNewWasherPercent").value.trim();
  const washer_percent_override = wpInput === "" ? null : Number(wpInput);
  if (!name || price < 0) return alert("Укажите название и цену");
  try {
    const svc = await apiServices("", { method: "POST", body: JSON.stringify({ name, price, washer_percent_override }) });
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

// --- Управление боксами (список, переименование, скрытие — только админ) ---
async function openBaysPanel() {
  document.getElementById("baysOverlay").style.display = "flex";
  await loadBays();
  renderBaysPanel();
}
function closeBaysPanel() { document.getElementById("baysOverlay").style.display = "none"; }

function renderBaysPanel() {
  const el = document.getElementById("baysEditList");
  if (bays.length === 0) {
    el.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:8px 0;">Пока нет боксов</div>`;
    return;
  }
  const isAdmin = currentUser.role === "admin";
  el.innerHTML = bays.map(b => isAdmin ? `
    <div class="svc-edit-row">
      <input type="text" id="bayName-${b.id}" value="${escapeHtml(b.name)}">
      <button type="button" class="svc-save" onclick="saveBay(${b.id})">Сохранить</button>
      <button type="button" class="svc-hide" onclick="hideBay(${b.id})">Скрыть</button>
    </div>
  ` : `
    <div class="svc-edit-row">
      <span>${escapeHtml(b.name)}</span>
    </div>
  `).join("");
}

async function saveBay(id) {
  const name = document.getElementById(`bayName-${id}`).value.trim();
  if (!name) return alert("Укажите название");
  try {
    const updated = await apiBays(`/${id}`, { method: "PUT", body: JSON.stringify({ name }) });
    bays = bays.map(b => b.id === id ? updated : b);
    renderBaysPanel();
    renderBayOptions();
  } catch (err) {
    alert("Не удалось сохранить: " + err.message);
  }
}

async function hideBay(id) {
  if (!confirm("Скрыть этот бокс из списка? Старые записи он не затронет.")) return;
  try {
    await apiBays(`/${id}`, { method: "DELETE" });
    bays = bays.filter(b => b.id !== id);
    renderBaysPanel();
    renderBayOptions();
  } catch (err) {
    alert("Не удалось скрыть: " + err.message);
  }
}

async function submitNewBay(e) {
  e.preventDefault();
  const name = document.getElementById("bayNewName").value.trim();
  if (!name) return alert("Укажите название");
  try {
    const b = await apiBays("", { method: "POST", body: JSON.stringify({ name }) });
    bays = bays.filter(x => x.id !== b.id);
    bays.push(b);
    bays.sort((a, c) => a.name.localeCompare(c.name, "ru"));
    renderBaysPanel();
    renderBayOptions();
    document.getElementById("newBayForm").reset();
  } catch (err) {
    alert("Не удалось добавить: " + err.message);
  }
}

// --- Компания-плательщик в форме записи (для способа оплаты "Безнал по счёту") ---
async function loadCompaniesForForm() {
  try {
    companiesList = await apiCompanies("");
    renderCompanyOptions();
  } catch (err) {
    companiesList = [];
  }
}

function renderCompanyOptions() {
  const el = document.getElementById("fCompany");
  if (!el) return;
  const current = el.value;
  el.innerHTML = companiesList.length === 0
    ? `<option value="">Нет компаний — добавьте ниже</option>`
    : companiesList.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  if (current && companiesList.some(c => String(c.id) === current)) el.value = current;
}

async function addCompanyInline() {
  const name = document.getElementById("newCompanyNameInline").value.trim();
  if (!name) return alert("Укажите название компании");
  try {
    const c = await apiCompanies("", { method: "POST", body: JSON.stringify({ name }) });
    companiesList = companiesList.filter(x => x.id !== c.id);
    companiesList.push(c);
    companiesList.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    renderCompanyOptions();
    document.getElementById("fCompany").value = c.id;
    document.getElementById("newCompanyNameInline").value = "";
  } catch (err) {
    alert("Не удалось добавить компанию: " + err.message);
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
        ${currentUser.role === "admin" ? `<button class="exp-del" onclick="deleteExpense(${e.id})">🗑</button>` : ""}
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

// --- Компании (безналичный расчёт по счёту, оплата раз в месяц) ---
async function openCompaniesPanel() {
  document.getElementById("companiesOverlay").style.display = "flex";
  await loadCompaniesPanel();
}
function closeCompaniesPanel() { document.getElementById("companiesOverlay").style.display = "none"; }

async function loadCompaniesPanel() {
  const el = document.getElementById("companiesList");
  el.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:8px 0;">Загрузка…</div>`;
  try {
    const list = await apiCompanies("");
    if (list.length === 0) {
      el.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:8px 0;">Пока нет компаний</div>`;
      return;
    }
    el.innerHTML = list.map(c => `
      <div class="company-row">
        <div class="company-row-view">
          <span class="cp-name">${escapeHtml(c.name)}</span>
          <span class="cp-balance">${fmt(c.balance)}</span>
        </div>
        <div class="company-actions">
          <input type="number" id="compCharge-${c.id}" min="0" placeholder="Сумма">
          <button type="button" class="company-charge-btn" onclick="chargeCompany(${c.id})">+ Начислить</button>
          ${currentUser.role === "admin" ? `<button type="button" class="company-pay-btn" onclick="payCompany(${c.id})">✓ Оплачено</button>` : ""}
        </div>
      </div>
    `).join("");
  } catch (err) {
    el.innerHTML = `<div style="color:var(--danger);font-size:13px;">${err.message}</div>`;
  }
}

async function submitNewCompany(e) {
  e.preventDefault();
  const name = document.getElementById("compNewName").value.trim();
  if (!name) return alert("Укажите название компании");
  try {
    await apiCompanies("", { method: "POST", body: JSON.stringify({ name }) });
    document.getElementById("newCompanyForm").reset();
    await loadCompaniesPanel();
    await loadCompaniesForForm();
  } catch (err) {
    alert("Не удалось добавить компанию: " + err.message);
  }
}

async function chargeCompany(id) {
  const input = document.getElementById(`compCharge-${id}`);
  const amount = Number(input.value);
  if (!amount || amount <= 0) return alert("Укажите сумму начисления");
  try {
    await apiCompanies(`/${id}/charge`, { method: "POST", body: JSON.stringify({ amount }) });
    await loadCompaniesPanel();
  } catch (err) {
    alert("Не удалось начислить: " + err.message);
  }
}

async function payCompany(id) {
  if (!confirm("Отметить долг этой компании как полностью оплаченный?")) return;
  try {
    await apiCompanies(`/${id}/pay`, { method: "POST" });
    await loadCompaniesPanel();
  } catch (err) {
    alert("Не удалось отметить оплату: " + err.message);
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
    const unpaidOnly = document.getElementById("filterUnpaid")?.checked;
    if (from) params.set("date_from", from);
    if (to) params.set("date_to", to);
    if (q) params.set("q", q);
    if (unpaidOnly) params.set("unpaid_only", "true");
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
  document.getElementById("filterUnpaid").checked = false;
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
  if (!r.is_paid) return "⏳";
  const cash = Number(r.amount_cash) || 0;
  const qr = Number(r.amount_qr) || 0;
  const invoice = Number(r.amount_invoice) || 0;
  if (invoice > 0) return "🧾";
  if (cash > 0 && qr > 0) return "💵📱";
  if (qr > 0) return "📱";
  if (cash > 0) return "💵";
  return "—";
}

function paymentLabel(r) {
  if (!r.is_paid) return "⏳ Не оплачено";
  const cash = Number(r.amount_cash) || 0;
  const qr = Number(r.amount_qr) || 0;
  const invoice = Number(r.amount_invoice) || 0;
  if (invoice > 0) return `🧾 По счёту${r.company_name ? " (" + escapeHtml(r.company_name) + ")" : ""}`;
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
        ${canModifyRecord(r) ? `<button class="del-btn" onclick="openForm(${r.id})">✏️</button>` : ""}
        ${canModifyRecord(r) ? `<button class="del-btn" onclick="removeRecord(${r.id})">🗑</button>` : ""}
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
        <span class="${r.is_paid ? "rec-badge" : "unpaid-badge"}">${paymentLabel(r)}</span>
      </div>
      <div class="rec-services">🧴 ${escapeHtml(svcText)}</div>
      <div class="rec-card-footer">
        <span class="rec-staff">👤 ${escapeHtml(r.received_by || r.staff_name || "—")}</span>
        <div class="rec-actions">
          ${canModifyRecord(r) ? `<button class="rec-action-btn" onclick="openForm(${r.id})">✏️</button>` : ""}
          ${canModifyRecord(r) ? `<button class="rec-action-btn" onclick="removeRecord(${r.id})">🗑</button>` : ""}
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
  document.getElementById("plateScanStatus").textContent = "";
  document.getElementById("fClientPhone").value = "";
  document.getElementById("fClientPhone").style.display = "";
  document.getElementById("clientCard").style.display = "none";
  document.getElementById("loyaltyLockedNote").style.display = "none";
  loyaltyLookup = null;
  document.getElementById("loyaltySection").style.display = "block";

  if (record && record.client_id) {
    // Клиент уже был привязан при создании записи — баллы уже начислены.
    // Менять телефон задним числом нельзя (задвоило бы начисление), поэтому
    // просто показываем, кто привязан, без возможности редактировать.
    document.getElementById("fClientPhone").style.display = "none";
    const noteEl = document.getElementById("loyaltyLockedNote");
    noteEl.style.display = "block";
    noteEl.innerHTML = `
      <div class="cc-name">${escapeHtml(record.client_name || "Без имени")}</div>
      <div class="cc-row"><span>Телефон</span><span>${escapeHtml(record.client_phone || "")}</span></div>
      <div style="color:var(--muted);font-size:12px;margin-top:6px;">AquaCoin уже начислены при создании записи — телефон нельзя изменить при редактировании.</div>
    `;
  }

  if (record) {
    const method = Number(record.amount_invoice) > 0
      ? "invoice"
      : Number(record.amount_qr) > 0 && Number(record.amount_cash) > 0
        ? "mixed"
        : Number(record.amount_qr) > 0 ? "qr" : "cash";
    document.querySelector(`input[name="paymentMethod"][value="${method}"]`).checked = true;
    document.getElementById("fAmountCash").value = record.amount_cash || "";
    document.getElementById("fAmountQr").value = record.amount_qr || "";
    renderCompanyOptions();
    if (record.company_id) document.getElementById("fCompany").value = record.company_id;
  } else {
    document.querySelector('input[name="paymentMethod"][value="cash"]').checked = true;
    document.getElementById("fAmountCash").value = "";
    document.getElementById("fAmountQr").value = "";
    renderCompanyOptions();
  }
  document.getElementById("newCompanyNameInline").value = "";
  document.getElementById("fUnpaid").checked = record ? !record.is_paid : false;
  onUnpaidToggle();
  onPaymentMethodChange();

  clearSignature();
  if (record && record.signature) {
    hasSignature = true;
    const img = new Image();
    img.onload = () => sigCanvas.getContext("2d").drawImage(img, 0, 0, sigCanvas.width, sigCanvas.height);
    img.src = record.signature;
  }
  selectedServiceIds = new Set((record ? record.services || [] : []).map(s => s.id));
  document.getElementById("serviceSearch").value = "";
  renderServiceCheckboxes();
  renderBayOptions();
  renderWasherOptions();
  document.getElementById("fReceivedBy").value = record ? record.received_by : currentUser.name;
  if (record) {
    document.getElementById("fBay").value = String(record.bay_id || "");
  }
  document.getElementById("modalOverlay").style.display = "flex";
}
function closeForm() { document.getElementById("modalOverlay").style.display = "none"; editingRecordId = null; }

// Услуги выбираются не мелкими чекбоксами, а крупными тап-карточками (удобнее
// нажимать пальцем на телефоне/планшете) — выбранные id храним отдельно, а
// карточки просто перерисовываем при каждом изменении.
let selectedServiceIds = new Set();

function renderServiceCheckboxes() {
  const el = document.getElementById("servicesList");
  if (!el) return;

  const countEl = document.getElementById("svcSelectedCount");
  if (countEl) countEl.textContent = selectedServiceIds.size > 0 ? `· выбрано ${selectedServiceIds.size}` : "";

  if (services.length === 0) {
    el.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:8px;">Пока нет услуг — добавьте первую ниже</div>`;
    return;
  }

  // Поиск фильтрует только то, что показано — выбор при этом не теряется,
  // даже если отфильтровать услугу из вида (поэтому и нужен счётчик "выбрано").
  const searchEl = document.getElementById("serviceSearch");
  const query = searchEl ? searchEl.value.trim().toLowerCase() : "";
  const filtered = query ? services.filter(s => s.name.toLowerCase().includes(query)) : services;

  if (filtered.length === 0) {
    el.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:8px;">Ничего не найдено по «${escapeHtml(searchEl.value.trim())}»</div>`;
    return;
  }

  el.innerHTML = filtered.map(s => `
    <div class="service-chip ${selectedServiceIds.has(s.id) ? "selected" : ""}" onclick="toggleService(${s.id})">
      <div class="svc-top">
        <span class="svc-check">✓</span>
        <span class="svc-name">${escapeHtml(s.name)}</span>
      </div>
      <span class="svc-price">${fmt(s.price)}</span>
    </div>
  `).join("");
}

function toggleService(id) {
  if (selectedServiceIds.has(id)) selectedServiceIds.delete(id);
  else selectedServiceIds.add(id);
  renderServiceCheckboxes();
  recalcPrice();
}

function recalcPrice() {
  const sum = services
    .filter(s => selectedServiceIds.has(s.id))
    .reduce((acc, s) => acc + Number(s.price), 0);
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
    // сразу отмечаем добавленную услугу
    selectedServiceIds.add(svc.id);
    renderServiceCheckboxes();
    recalcPrice();
    document.getElementById("newServiceName").value = "";
    document.getElementById("newServicePrice").value = "";
  } catch (err) {
    alert("Не удалось добавить услугу: " + err.message);
  }
}

// --- Сканирование госномера по фото ---
// Бесплатное распознавание прямо на устройстве (Tesseract.js): фото никуда не
// отправляется и нигде не сохраняется, текст читается в самом браузере. Умеет только
// номер — марку машины по фото так не определить, её выбирают вручную. Тяжёлые файлы
// распознавания подгружаются только при первом сканировании (и дальше кэшируются).
let ocrWorker = null;
let ocrWorkerPromise = null;
let ocrIdleTimer = null;

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Не удалось загрузить модуль распознавания"));
    document.head.appendChild(s);
  });
}

async function getOcrWorker() {
  clearTimeout(ocrIdleTimer);
  if (ocrWorker) return ocrWorker;
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      if (!window.Tesseract) await loadScriptOnce("/vendor/tesseract/tesseract.min.js");
      const worker = await Tesseract.createWorker("eng", 1, {
        workerPath: "/vendor/tesseract/worker.min.js",
        corePath: "/vendor/tesseract-core",
        langPath: "/vendor/tessdata",
        gzip: true,
        workerBlobURL: false,
      });
      ocrWorker = worker; // режим чтения задаётся перед каждым проходом (см. onPlateFileChosen)
      return worker;
    })().catch(err => {
      ocrWorkerPromise = null;
      throw err;
    });
  }
  return ocrWorkerPromise;
}

// Освобождаем память телефона, если сканер давно не нужен
function scheduleOcrShutdown() {
  clearTimeout(ocrIdleTimer);
  ocrIdleTimer = setTimeout(async () => {
    const w = ocrWorker;
    ocrWorker = null;
    ocrWorkerPromise = null;
    if (w) { try { await w.terminate(); } catch (e) { /* уже закрыт */ } }
  }, 2 * 60 * 1000);
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Не удалось открыть фото")); };
    img.src = url;
  });
}

// Растягиваем контраст (по яркости обрезаем 2% самых тёмных и светлых пикселей).
// Цвет НЕ убираем: на «чистом сером» кадре Tesseract заметно хуже читает номер
// (проверено на тестовых снимках), а на цветном — стабильно читает.
function enhanceCanvas(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    hist[(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0]++;
  }
  const total = canvas.width * canvas.height;
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.02) { hi = v; break; } }
  if (hi - lo < 30) return; // кадр почти однотонный — растягивать нечего
  const k = 255 / (hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.max(0, Math.min(255, (d[i] - lo) * k));
    d[i + 1] = Math.max(0, Math.min(255, (d[i + 1] - lo) * k));
    d[i + 2] = Math.max(0, Math.min(255, (d[i + 2] - lo) * k));
  }
  ctx.putImageData(img, 0, 0);
}

// Медиана из 9 значений (сеть сравнений — быстро, без сортировки массива)
function med9(a0, a1, a2, a3, a4, a5, a6, a7, a8) {
  let t;
  const s = (x, y) => (x > y ? [y, x] : [x, y]);
  [a1, a2] = s(a1, a2); [a4, a5] = s(a4, a5); [a7, a8] = s(a7, a8);
  [a0, a1] = s(a0, a1); [a3, a4] = s(a3, a4); [a6, a7] = s(a6, a7);
  [a1, a2] = s(a1, a2); [a4, a5] = s(a4, a5); [a7, a8] = s(a7, a8);
  [a0, a3] = s(a0, a3); [a5, a8] = s(a5, a8); [a4, a7] = s(a4, a7);
  [a3, a6] = s(a3, a6); [a1, a4] = s(a1, a4); [a2, a5] = s(a2, a5);
  [a4, a7] = s(a4, a7); [a4, a2] = s(a4, a2); [a6, a4] = s(a6, a4);
  [a4, a2] = s(a4, a2);
  return a4;
}

// Лёгкое «медианное» сглаживание 3×3: убирает точечный шум (тёмные кадры, зерно),
// не размывая штрихи символов так, как это делает обычное размытие
function denoiseCanvas(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const w = canvas.width, h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const s = img.data;
  const o = new Uint8ClampedArray(s.length);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
      const i = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) {
        o[i + k] = med9(
          s[(y0 * w + x0) * 4 + k], s[(y0 * w + x) * 4 + k], s[(y0 * w + x1) * 4 + k],
          s[(y * w + x0) * 4 + k], s[i + k], s[(y * w + x1) * 4 + k],
          s[(y1 * w + x0) * 4 + k], s[(y1 * w + x) * 4 + k], s[(y1 * w + x1) * 4 + k]
        );
      }
      o[i + 3] = 255;
    }
  }
  img.data.set(o);
  ctx.putImageData(img, 0, 0);
}

// Вырезает рамку {x, y, w, h} из кадра ПЛОТНО (с минимальным запасом: лишний фон
// вокруг таблички заметно мешает OCR) и приводит высоту к targetH. Для строки номера
// хорошо работает около 200 px по высоте. Обработку (шум/контраст) делает finishCrop.
function cropBoxRaw(source, box, targetH) {
  const mx = box.w * 0.02 + 3, my = box.h * 0.06 + 3;
  const sx = Math.max(0, Math.round(box.x - mx)), sy = Math.max(0, Math.round(box.y - my));
  const sw = Math.min(source.width - sx, Math.round(box.w + 2 * mx));
  const sh = Math.min(source.height - sy, Math.round(box.h + 2 * my));
  const k = targetH / sh;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sw * k));
  c.height = Math.max(1, Math.round(sh * k));
  c.getContext("2d").drawImage(source, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

function finishCrop(canvas) {
  denoiseCanvas(canvas);
  enhanceCanvas(canvas);
  return canvas;
}

// Угол наклона строки номера (в градусах, -10…+10): перебираем углы и берём тот, при
// котором тёмные штрихи лучше всего «выстраиваются» по строкам (резкий профиль по
// вертикали). Если выигрыш у нулевого угла незаметный — считаем, что наклона нет.
function estimateTiltDeg(canvas) {
  const w = 260, h = Math.max(24, Math.round(canvas.height * (260 / canvas.width)));
  const small = document.createElement("canvas");
  small.width = w; small.height = h;
  const sctx = small.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(canvas, 0, 0, w, h);
  const px = sctx.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  let mean = 0;
  for (let i = 0, j = 0; i < px.length; i += 4, j++) { lum[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; mean += lum[j]; }
  mean /= lum.length;
  const mask = document.createElement("canvas");
  mask.width = w; mask.height = h;
  const mctx = mask.getContext("2d", { willReadFrequently: true });
  const md = mctx.createImageData(w, h);
  for (let j = 0, i = 0; j < lum.length; j++, i += 4) {
    const v = lum[j] < mean * 0.7 ? 0 : 255; // тёмное — штрихи символов и рамка
    md.data[i] = md.data[i + 1] = md.data[i + 2] = v; md.data[i + 3] = 255;
  }
  mctx.putImageData(md, 0, 0);
  const work = document.createElement("canvas");
  work.width = w; work.height = h;
  const wctx = work.getContext("2d", { willReadFrequently: true });
  const score = (deg) => {
    wctx.fillStyle = "#fff"; wctx.fillRect(0, 0, w, h);
    wctx.save();
    wctx.translate(w / 2, h / 2); wctx.rotate((deg * Math.PI) / 180); wctx.translate(-w / 2, -h / 2);
    wctx.drawImage(mask, 0, 0);
    wctx.restore();
    const d = wctx.getImageData(0, 0, w, h).data;
    let prev = 0, sc = 0;
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) if (d[(y * w + x) * 4] < 128) row++;
      if (y > 0) sc += (row - prev) * (row - prev);
      prev = row;
    }
    return sc;
  };
  const base = score(0);
  let bestDeg = 0, best = base;
  for (let deg = -10; deg <= 10; deg += 1) {
    if (deg === 0) continue;
    const sc = score(deg);
    if (sc > best) { best = sc; bestDeg = deg; }
  }
  return best > base * 1.08 ? bestDeg : 0;
}

// Поворачивает вырезку на deg градусов (выравнивает наклон), фон по углам — цвета краёв
function rotateCrop(canvas, deg) {
  const c = document.createElement("canvas");
  c.width = canvas.width; c.height = canvas.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const e = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, 1, 1).data;
  ctx.fillStyle = `rgb(${e[0]},${e[1]},${e[2]})`;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.translate(-c.width / 2, -c.height / 2);
  ctx.drawImage(canvas, 0, 0);
  return c;
}

// Уменьшенный серый кадр для поиска таблички
function toSmallGray(source, maxW) {
  const k = Math.min(1, maxW / source.width);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(source.width * k));
  c.height = Math.max(1, Math.round(source.height * k));
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, c.width, c.height);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  const gray = new Uint8Array(c.width * c.height);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    gray[j] = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) | 0;
  }
  return { gray, w: c.width, h: c.height, k };
}

async function onPlateFileChosen(input) {
  const file = input.files && input.files[0];
  input.value = ""; // чтобы можно было снова выбрать тот же снимок
  if (!file) return;

  const btn = document.getElementById("plateScanBtn");
  const statusEl = document.getElementById("plateScanStatus");
  const setStatus = (text, cls) => { statusEl.className = "plate-scan-status" + (cls ? " " + cls : ""); statusEl.textContent = text; };

  btn.disabled = true;
  try {
    setStatus("Готовлю фото…");
    const img = await loadImageFromFile(file);
    const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    const full = document.createElement("canvas");
    full.width = Math.round(img.naturalWidth * scale);
    full.height = Math.round(img.naturalHeight * scale);
    full.getContext("2d").drawImage(img, 0, 0, full.width, full.height);

    setStatus("Загружаю распознавание… (в первый раз это занимает несколько секунд)");
    const worker = await getOcrWorker();
    const WL = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const texts = [];
    const previews = []; // для каждого прочтения — вырезка, из которой оно получено (для сверки глазами)

    // Шаг 1: находим на кадре места, похожие на табличку с номером, вырезаем каждое
    // и читаем как одну строку — так читается заметно точнее, чем весь кадр целиком.
    setStatus("Ищу номер на фото…");
    const small = toSmallGray(full, 640);
    const boxes = PlateParser.findPlateBoxes(small.gray, small.w, small.h, 3)
      .map(b => ({ x: b.x / small.k, y: b.y / small.k, w: b.w / small.k, h: b.h / small.k }));
    await worker.setParameters({ tessedit_char_whitelist: WL, tessedit_pageseg_mode: "7" });
    for (let i = 0; i < boxes.length; i++) {
      setStatus(`Читаю номер… (${i + 1} из ${boxes.length})`);
      // Несколько вариантов одной и той же вырезки (разный масштаб, выровненный
      // наклон) — номер, который совпал в разных прочтениях, надёжнее одного прочтения
      const raw = cropBoxRaw(full, boxes[i], 200);
      const variants = [finishCrop(cropBoxRaw(full, boxes[i], 200)), finishCrop(cropBoxRaw(full, boxes[i], 140))];
      const tilt = estimateTiltDeg(raw);
      if (Math.abs(tilt) >= 2) variants.push(finishCrop(rotateCrop(raw, tilt)));
      for (const v of variants) {
        const { data } = await worker.recognize(v);
        texts.push(data.text || "");
        previews.push(raw);
      }
    }

    // Шаг 2: если уверенного совпадения нет — читаем ещё и кадр целиком (когда номер
    // снят крупно, он сам занимает почти весь кадр и отдельно искать его не нужно)
    let best = PlateParser.pickBest(texts);
    if (!best || best.count < 2) {
      setStatus("Читаю весь кадр…");
      await worker.setParameters({ tessedit_char_whitelist: "", tessedit_pageseg_mode: "3" });
      const whole = document.createElement("canvas");
      whole.width = full.width; whole.height = full.height;
      whole.getContext("2d").drawImage(full, 0, 0);
      enhanceCanvas(whole);
      const { data } = await worker.recognize(whole);
      texts.push(data.text || "");
      previews.push(null);
      best = PlateParser.pickBest(texts);
    }

    if (!best) {
      setStatus("Не удалось уверенно прочитать номер. Сфотографируйте номер крупнее и ровнее (без бликов) или введите вручную.", "err");
      return;
    }
    const numberEl = document.getElementById("fNumber");
    numberEl.value = best.plate;
    numberEl.dispatchEvent(new Event("input", { bubbles: true }));

    // Уверенность: совпало ли прочтение в нескольких вариантах вырезки. Если нет —
    // честно предупреждаем, что номер мог быть прочитан с ошибкой в символе.
    if (best.count >= 2) {
      setStatus(`Номер распознан: ${best.plate}. Сверьте с фото — если ошибка, поправьте вручную.`, "ok");
    } else {
      setStatus(`Номер прочитан неуверенно: ${best.plate}. Обязательно сверьте каждый символ с фото и поправьте вручную.`, "warn");
    }
    // Под результатом показываем саму вырезанную табличку (а если её не нашли —
    // уменьшенный кадр), чтобы можно было сразу сверить символы глазами
    const winner = texts.findIndex(t => { const r = PlateParser.parse(t); return r && r.plate === best.plate; });
    const src = (winner >= 0 && previews[winner]) || full;
    const thumb = document.createElement("canvas");
    const k = Math.min(1, 360 / src.width);
    thumb.width = Math.round(src.width * k);
    thumb.height = Math.round(src.height * k);
    thumb.getContext("2d").drawImage(src, 0, 0, thumb.width, thumb.height);
    const im = document.createElement("img");
    im.src = thumb.toDataURL("image/jpeg", 0.8);
    im.alt = "Снимок номера";
    statusEl.appendChild(im);
  } catch (err) {
    setStatus("Сканер не сработал: " + err.message + ". Введите номер вручную.", "err");
  } finally {
    btn.disabled = false;
    scheduleOcrShutdown();
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

async function submitNewClient(e) {
  e.preventDefault();
  const name = document.getElementById("clNewName").value.trim();
  const phone = document.getElementById("clNewPhone").value.trim();
  if (!phone) return alert("Укажите телефон");
  try {
    await apiClients("", { method: "POST", body: JSON.stringify({ name, phone }) });
    document.getElementById("newClientForm").reset();
    await loadClientsList();
  } catch (err) {
    alert("Не удалось добавить клиента: " + err.message);
  }
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
    let standardPercent = null;
    try { standardPercent = (await apiLoyalty("/settings")).points_percent; } catch (err) { /* не критично */ }

    const isAdmin = currentUser.role === "admin";
    listEl.innerHTML = list.map(c => {
      const isVip = c.points_percent_override != null &&
        (standardPercent == null || Number(c.points_percent_override) > Number(standardPercent));
      return `
      <div class="client-row">
        <div class="client-row-view">
          <div>
            <div class="cr-name">${escapeHtml(c.name || "Без имени")}${isVip ? ` <span class="vip-badge">⭐ VIP ${c.points_percent_override}%</span>` : ""}</div>
            <div class="cr-phone">+${escapeHtml(c.phone)}</div>
          </div>
          <div class="cr-stats">${c.visit_count} визитов · ${fmt(c.points_balance)} AquaCoin</div>
        </div>
        ${isAdmin ? `
          <div class="client-edit-row">
            <input type="text" id="clName-${c.id}" value="${escapeHtml(c.name || "")}" placeholder="Имя">
            <input type="number" id="clVisits-${c.id}" value="${c.visit_count}" min="0">
            <input type="number" id="clPoints-${c.id}" value="${c.points_balance}" min="0">
            <input type="number" id="clVipPercent-${c.id}" value="${c.points_percent_override != null ? c.points_percent_override : ""}" placeholder="Обычный %" min="0" step="0.5" title="Личный % AquaCoin — пусто или как у всех означает обычный тариф, без VIP">
            <button type="button" onclick="saveClient(${c.id})">Сохранить</button>
            <button type="button" class="client-del-btn" onclick="deleteClient(${c.id})">Удалить</button>
          </div>
        ` : ""}
      </div>
    `;
    }).join("");
  } catch (err) {
    listEl.innerHTML = `<div style="color:var(--danger);font-size:13px;">${err.message}</div>`;
  }
}

async function deleteClient(id) {
  if (!confirm("Удалить этого клиента из списка? Старые записи в журнале не пострадают.")) return;
  try {
    await apiClients(`/${id}`, { method: "DELETE" });
    await loadClientsList();
  } catch (err) {
    alert("Не удалось удалить: " + err.message);
  }
}

async function saveClient(id) {
  const name = document.getElementById(`clName-${id}`).value.trim();
  const visit_count = Number(document.getElementById(`clVisits-${id}`).value);
  const points_balance = Number(document.getElementById(`clPoints-${id}`).value);
  const vipInput = document.getElementById(`clVipPercent-${id}`).value.trim();
  const points_percent_override = vipInput === "" ? null : Number(vipInput);
  try {
    await apiClients(`/${id}`, { method: "PUT", body: JSON.stringify({ name, visit_count, points_balance, points_percent_override }) });
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
  const effectivePercent = c.points_percent_override != null
    ? c.points_percent_override
    : loyaltyLookup.settings.points_percent;
  const isVip = c.points_percent_override != null && Number(c.points_percent_override) > Number(loyaltyLookup.settings.points_percent);

  let redeemBlock = "";
  if (Number(c.points_balance) > 0) {
    if (editingRecordId) {
      redeemBlock = `<div style="color:var(--muted);font-size:12px;margin-top:6px;">Списание AquaCoin доступно только при создании новой записи.</div>`;
    } else if (currentUser.role === "admin") {
      redeemBlock = `
        <div class="cc-redeem">
          <input type="number" id="fRedeemPoints" min="0" max="${c.points_balance}" placeholder="Списать AquaCoin">
          <button type="button" onclick="document.getElementById('fRedeemPoints').value=${c.points_balance}">Списать всё</button>
        </div>
        <div class="cc-redeem" style="margin-top:6px;">
          <button type="button" onclick="requestRedeemCode()">📩 Запросить SMS-код</button>
          <input type="text" id="fOtpCode" placeholder="Код из SMS" maxlength="4" inputmode="numeric">
        </div>
        <div id="otpStatus" class="otp-status"></div>
      `;
    } else {
      redeemBlock = `<div style="color:var(--muted);font-size:12px;margin-top:6px;">Списывать AquaCoin может только администратор.</div>`;
    }
  }

  cardEl.innerHTML = `
    <div class="cc-name">${escapeHtml(c.name || "Без имени")}${isVip ? ` <span class="vip-badge">⭐ VIP</span>` : ""}</div>
    <div class="cc-row"><span>Визитов</span><span>${c.visit_count}</span></div>
    <div class="cc-row"><span><img src="icons/aquacoin-32.png" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:3px;">AquaCoin</span><span>${fmt(c.points_balance)}</span></div>
    <div class="cc-row"><span>Процент начисления</span><span>${effectivePercent}%</span></div>
    ${redeemBlock}
  `;
}

async function requestRedeemCode() {
  const phone = document.getElementById("fClientPhone").value.trim();
  const statusEl = document.getElementById("otpStatus");
  statusEl.textContent = "Отправляем код…";
  try {
    const res = await apiClients("/request-redeem-code", { method: "POST", body: JSON.stringify({ phone }) });
    if (res.dev_code) {
      statusEl.textContent = `Тестовый режим (SMS-шлюз не настроен) — код: ${res.dev_code}`;
    } else if (res.channel === "telegram") {
      statusEl.textContent = "Код отправлен в Telegram, действует 5 минут.";
    } else {
      statusEl.textContent = "Код отправлен по SMS, действует 5 минут.";
    }
  } catch (err) {
    statusEl.textContent = "Не удалось отправить код: " + err.message;
  }
}

// --- Способ оплаты в форме записи ---
function onUnpaidToggle() {
  const unpaid = document.getElementById("fUnpaid").checked;
  document.getElementById("paymentMethodField").style.display = unpaid ? "none" : "block";
}

function onPaymentMethodChange() {
  const method = document.querySelector('input[name="paymentMethod"]:checked').value;
  document.getElementById("mixedPaymentRow").style.display = method === "mixed" ? "flex" : "none";
  document.getElementById("invoiceCompanyRow").style.display = method === "invoice" ? "block" : "none";
}

function computePaymentAmounts(finalAmount) {
  const method = document.querySelector('input[name="paymentMethod"]:checked').value;
  if (method === "cash") return { amount_cash: finalAmount, amount_qr: 0, amount_invoice: 0 };
  if (method === "qr") return { amount_cash: 0, amount_qr: finalAmount, amount_invoice: 0 };
  if (method === "invoice") return { amount_cash: 0, amount_qr: 0, amount_invoice: finalAmount };
  return {
    amount_cash: Number(document.getElementById("fAmountCash").value) || 0,
    amount_qr: Number(document.getElementById("fAmountQr").value) || 0,
    amount_invoice: 0,
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

// Разбивка по мойщикам в модалке — карточки, а не широкая таблица. На телефоне
// таблица с колонкой на каждую услугу не помещается и обрезается сбоку, поэтому
// суммы по услугам показаны чипами, которые переносятся на новую строку, а не
// уезжают за край экрана. Нажатие на карточку мойщика раскрывает список его
// записей за период (buildWasherDetailCardsHtml) — дата, машина, цена и из каких
// услуг (с какой ценой и процентом) сложилась зарплата именно за эту запись.
function buildWasherCardsHtml(r, mutedColor) {
  const muted = mutedColor || "var(--muted)";
  const cards = r.washer_breakdown.map((w, idx) => {
    const chips = (w.overrides || [])
      .map(o => `<span class="wc-chip">${escapeHtml(o.name)} <b>${o.percent}%</b> · ${fmt(o.amount)}</span>`)
      .join("");
    const rowId = `washerDetail-${idx}`;
    return `
      <div class="washer-card">
        <div class="washer-card-head" onclick="toggleWasherDetail('${rowId}', this)">
          <span class="wc-name">${escapeHtml(w.name)} <span class="wc-arrow">▾</span></span>
          <span class="wc-total">${fmt(w.salary)}</span>
        </div>
        <div class="wc-meta">${w.cars_count} машин · выручка ${fmt(w.revenue)}</div>
        ${chips ? `<div class="wc-chips">${chips}</div>` : ""}
        <div class="wc-detail" id="${rowId}" style="display:none;">
          ${buildWasherDetailCardsHtml(w, muted)}
        </div>
      </div>
    `;
  }).join("");
  return `
    <div class="washer-cards">
      ${cards || `<div style="color:${muted};font-size:13px;padding:12px 0;">Записей нет</div>`}
    </div>
    ${r.washer_breakdown.length ? `
      <div class="washer-total-row"><span>Итого зарплата мойщикам</span><span>${fmt(r.washer_total)}</span></div>
      <div style="color:${muted};font-size:11px;margin-top:6px;margin-bottom:10px;">
        Процент — свой у каждой услуги (настраивается в разделе «Услуги»). Нажмите на мойщика, чтобы увидеть, какая запись что дала.
      </div>
    ` : ""}
  `;
}

function buildWasherDetailCardsHtml(w, muted) {
  const recs = w.records || [];
  if (recs.length === 0) {
    return `<div style="color:${muted};font-size:12px;padding:4px 0;">Нет записей</div>`;
  }
  return recs.map(rec => {
    const items = (rec.items || []).map(it => `
      <div class="wc-item"><span>${escapeHtml(it.name)}</span><span>${fmt(it.price)} × ${it.percent}% = ${fmt(it.amount)}</span></div>
    `).join("");
    return `
      <div class="wc-record">
        <div class="wc-record-head">
          <span>${new Date(rec.service_date).toLocaleDateString("ru-RU")} · ${escapeHtml(rec.car_brand)} ${escapeHtml(rec.car_number)}</span>
          <span>${fmt(rec.price)}</span>
        </div>
        <div class="wc-record-items">${items || `<div class="wc-item"><span>—</span></div>`}</div>
        <div class="wc-record-total">ЗП за запись: ${fmt(rec.salary)}</div>
      </div>
    `;
  }).join("");
}

function toggleWasherDetail(rowId, headEl) {
  const el = document.getElementById(rowId);
  if (!el) return;
  const opening = el.style.display === "none";
  el.style.display = opening ? "flex" : "none";
  const arrow = headEl && headEl.querySelector(".wc-arrow");
  if (arrow) arrow.textContent = opening ? "▴" : "▾";
}

// Таблица для PDF — там страница статична (печатается через диалог браузера),
// карточки с раскрытием там не нужны, а широкая таблица на листе A4 помещается
// нормально. Детали по записям в PDF не нужны — это сводка для печати.
function buildWasherTableHtml(r, mutedColor) {
  const muted = mutedColor || "var(--muted)";
  const cols = r.override_columns || [];
  const headExtra = cols.map(c => `<th>${escapeHtml(c.name)} (${c.percent}%)</th>`).join("");
  const totalCols = 4 + cols.length;
  const rows = r.washer_breakdown.map(w => {
    const cells = cols.map(c => {
      const found = (w.overrides || []).find(o => o.name === c.name && o.percent === c.percent);
      return `<td>${found ? fmt(found.amount) : "—"}</td>`;
    }).join("");
    return `
      <tr>
        <td>${escapeHtml(w.name)}</td>
        <td>${w.cars_count}</td>
        <td>${fmt(w.revenue)}</td>
        ${cells}
        <td><b>${fmt(w.salary)}</b></td>
      </tr>
    `;
  }).join("");
  return `
    <table class="washer-table">
      <thead><tr>
        <th>Мойщик</th><th>Машин</th><th>Выручка</th>
        ${headExtra}
        <th>Итого ЗП</th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="${totalCols}" style="color:${muted};">Записей нет</td></tr>`}</tbody>
      <tfoot><tr><td colspan="${totalCols - 1}">Итого зарплата мойщикам</td><td><b>${fmt(r.washer_total)}</b></td></tr></tfoot>
    </table>
    ${cols.length ? `
      <div style="color:${muted};font-size:11px;margin-top:-8px;margin-bottom:10px;">
        Каждая колонка — отдельная услуга со своим процентом (настраивается в разделе «Услуги»). Проценты не совпадают у похожих услуг, если заданы по-разному в каталоге.
      </div>
    ` : ""}
  `;
}

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

    const washerCardsHtml = buildWasherCardsHtml(r);

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
        <div class="report-kpi"><div class="rk-label">Безнал по счёту</div><div class="rk-value">${fmt(r.total_invoice)}</div></div>
        <div class="report-kpi"><div class="rk-label">Бонусами оплачено</div><div class="rk-value">${fmt(r.total_bonus_redeemed)}</div></div>
        <div class="report-kpi"><div class="rk-label">Процент админа (${r.admin_percent}%)</div><div class="rk-value">${fmt(r.admin_cut)}</div></div>
        <div class="report-kpi"><div class="rk-label">Расходы</div><div class="rk-value" style="color:var(--danger);">−${fmt(r.total_expenses)}</div></div>
      </div>

      ${washerCardsHtml}

      ${(r.expenses || []).length > 0 ? `
        <table class="washer-table">
          <thead><tr><th>Дата</th><th>За что</th><th>Кто внёс</th><th>Сумма</th></tr></thead>
          <tbody>${expenseRows}</tbody>
          <tfoot><tr><td colspan="3">Итого расходов</td><td>${fmt(r.total_expenses)}</td></tr></tfoot>
        </table>
      ` : ""}

      <div class="report-highlight">
        <div class="rk-label">Остаток кассы — сдать директору (касса − админ % − ЗП мойщиков − QR − безнал − AquaCoin − расходы)</div>
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

  const washerTableHtml = buildWasherTableHtml(r, "#6C86A6");

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
  .final{margin-top:22px;padding:16px;background:#1657A6;color:#fff;border-radius:8px;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  .final .kpi-label{color:rgba(255,255,255,.8);}
  .final .kpi-value{color:#fff;font-size:20px;}
  .signoff{margin-top:26px;padding-top:14px;border-top:1px dashed #D9E7F6;break-inside:avoid;page-break-inside:avoid;}
  .signoff-final{font-weight:700;font-size:18px;color:#1657A6;letter-spacing:.02em;}
  /* Не даём странице разрезать таблицы/итоговую плашку пополам — если не влезает,
     переносим блок целиком на следующую страницу, а не разрываем его */
  table, tr, .kpi, .final, .kpi-row{ break-inside: avoid; page-break-inside: avoid; }
  thead{ display: table-header-group; }
  tfoot{ display: table-row-group; }
  @media print{
    @page{ margin:14mm; }
    body{ padding:0; }
  }
</style></head>
<body>
  <h1>Aquazone — отчёт по кассе</h1>
  <div class="sub">Период: ${escapeHtml(lastReportPeriod)}</div>
  <div class="kpi-row">
    <div class="kpi"><div class="kpi-label">Машин</div><div class="kpi-value">${r.cars_count}</div></div>
    <div class="kpi"><div class="kpi-label">Общая касса</div><div class="kpi-value">${fmt(r.total_revenue)}</div></div>
    <div class="kpi"><div class="kpi-label">Наличными</div><div class="kpi-value">${fmt(r.total_cash)}</div></div>
    <div class="kpi"><div class="kpi-label">QR</div><div class="kpi-value">${fmt(r.total_qr)}</div></div>
    <div class="kpi"><div class="kpi-label">Безнал по счёту</div><div class="kpi-value">${fmt(r.total_invoice)}</div></div>
    <div class="kpi"><div class="kpi-label">Бонусами оплачено</div><div class="kpi-value">${fmt(r.total_bonus_redeemed)}</div></div>
    <div class="kpi"><div class="kpi-label">Процент админа (${r.admin_percent}%)</div><div class="kpi-value">${fmt(r.admin_cut)}</div></div>
    <div class="kpi"><div class="kpi-label">Расходы</div><div class="kpi-value">−${fmt(r.total_expenses)}</div></div>
  </div>
  ${washerTableHtml}
  ${expenseRows ? `
  <table>
    <thead><tr><th>Дата</th><th>За что</th><th>Кто внёс</th><th>Сумма</th></tr></thead>
    <tbody>${expenseRows}</tbody>
    <tfoot><tr><td colspan="3">Итого расходов</td><td>${fmt(r.total_expenses)}</td></tr></tfoot>
  </table>
  ` : ""}
  <div class="final">
    <div class="kpi-label">Остаток кассы — сдать директору (касса − админ % − ЗП мойщиков − QR − безнал − AquaCoin − расходы)</div>
    <div class="kpi-value">${fmt(r.cash_to_handover)}</div>
  </div>
  <div class="signoff">
    <div class="signoff-final">СДАНО: ${fmt(r.cash_to_handover)}</div>
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

  const portalUrl = `${location.origin}/client.html`;
  document.getElementById("portalLinkText").value = portalUrl;
  document.getElementById("portalQrCode").src =
    `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(portalUrl)}`;
}
function closeLoyaltySettings() { document.getElementById("loyaltyOverlay").style.display = "none"; }

function copyPortalLink() {
  const input = document.getElementById("portalLinkText");
  input.select();
  navigator.clipboard?.writeText(input.value).catch(() => {});
  document.execCommand?.("copy");
}

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

  const service_ids = [...selectedServiceIds];
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

  {
    // В форме редактирования поле телефона скрыто и пустое, если клиент уже был
    // привязан при создании записи (баллы уже начислены — задвоить нельзя), но
    // доступно и может быть заполнено, если записи телефон не был указан сразу —
    // тогда баллы начислятся задним числом вместе с сохранением изменений.
    const phoneRaw = document.getElementById("fClientPhone").value.trim();
    if (phoneRaw) {
      payload.client_phone = phoneRaw;
      const nameEl = document.getElementById("fClientName");
      if (nameEl && nameEl.value.trim()) payload.client_name = nameEl.value.trim();
      if (!editingRecordId) {
        const redeemEl = document.getElementById("fRedeemPoints");
        payload.redeem_points = redeemEl ? Number(redeemEl.value) || 0 : 0;
        if (payload.redeem_points > 0) {
          const otpEl = document.getElementById("fOtpCode");
          payload.otp_code = otpEl ? otpEl.value.trim() : "";
          if (!payload.otp_code) return alert("Введите код из SMS, чтобы списать AquaCoin");
        }
      }
    }
  }

  const isUnpaid = document.getElementById("fUnpaid").checked;
  payload.is_paid = !isUnpaid;

  if (isUnpaid) {
    payload.amount_cash = 0;
    payload.amount_qr = 0;
    payload.amount_invoice = 0;
  } else {
    // Наличные/QR считаются от суммы, которая реально перейдёт из рук в руки —
    // то есть цена минус баллы, которые клиент, возможно, списывает.
    const estimatedFinal = Math.max(0, price - (payload.redeem_points || 0));
    Object.assign(payload, computePaymentAmounts(estimatedFinal));

    if (document.querySelector('input[name="paymentMethod"]:checked').value === "invoice") {
      const companyId = document.getElementById("fCompany").value;
      if (!companyId) return alert("Выберите компанию для оплаты по счёту");
      payload.company_id = Number(companyId);
    }
  }

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
  document.getElementById("uRoleAdminOption").style.display = currentUser.role === "manager" ? "none" : "block";
  await loadUsers();
}
function closeUsers() { document.getElementById("usersOverlay").style.display = "none"; }

async function loadUsers() {
  try {
    const users = await apiAuth("/users");
    const isAdmin = currentUser.role === "admin";
    document.getElementById("usersList").innerHTML = users.map(u => `
      <div class="user-row">
        <div class="user-row-top">
          <div>
            <div>${escapeHtml(u.name)} <span style="color:var(--muted);">(${escapeHtml(u.username)})</span></div>
            <div class="u-role">${roleLabel(u.role)}</div>
          </div>
          ${isAdmin && u.id !== currentUser.id ? `<button class="u-del" onclick="hideUser(${u.id})">Скрыть</button>` : ""}
        </div>
        ${isAdmin ? `
          <div class="user-password-row">
            <input type="text" id="uPwd-${u.id}" placeholder="Новый пароль">
            <button type="button" onclick="changeUserPassword(${u.id})">Сменить пароль</button>
          </div>
        ` : ""}
      </div>
    `).join("") || `<div style="color:var(--muted);font-size:13px;">Пока никого нет</div>`;
  } catch (err) {
    document.getElementById("usersList").innerHTML = `<div style="color:var(--danger);font-size:13px;">${err.message}</div>`;
  }
}

async function changeUserPassword(id) {
  const input = document.getElementById(`uPwd-${id}`);
  const password = input.value.trim();
  if (!password) return alert("Введите новый пароль");
  if (password.length < 4) return alert("Пароль должен быть не короче 4 символов");
  try {
    await apiAuth(`/users/${id}/password`, { method: "PUT", body: JSON.stringify({ password }) });
    input.value = "";
    alert("Пароль изменён");
  } catch (err) {
    alert("Не удалось сменить пароль: " + err.message);
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
