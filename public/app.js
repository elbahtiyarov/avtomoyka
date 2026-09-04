// Автомойка — фронтенд: вход по логину/паролю (JWT), журнал записей, каталог услуг

let token = localStorage.getItem("token") || null;
let currentUser = null;
let records = [];
let services = [];
let bays = [];
let ws = null;
let hasSignature = false;

const fmt = n => new Intl.NumberFormat("ru-RU").format(Math.round(n || 0)) + " ₸";
const todayStr = () => new Date().toISOString().slice(0, 10);

async function api(path, base, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(base + path, { ...options, headers });
  if (res.status === 401) {
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
const apiClients = (path, opts) => api(path, "/api/clients", opts);
const apiLoyalty = (path, opts) => api(path, "/api/loyalty", opts);
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

  await loadServices();
  await loadBays();
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
  el.innerHTML = services.map(s => `
    <div class="svc-edit-row">
      <input type="text" id="svcName-${s.id}" value="${escapeHtml(s.name)}">
      <input type="number" id="svcPrice-${s.id}" value="${s.price}" min="0">
      <button type="button" class="svc-save" onclick="saveService(${s.id})">Сохранить</button>
      <button type="button" class="svc-hide" onclick="hideService(${s.id})">Скрыть</button>
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
    document.getElementById("kpiAvg").textContent = fmt(s.avg_check);
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
      <td style="color:var(--muted)">${escapeHtml(r.received_by || r.staff_name || "—")}</td>
      <td>${sigCell}</td>
      <td>
        ${currentUser.role === "admin" ? `<button class="del-btn" onclick="openForm(${r.id})">✏️</button>` : ""}
        <button class="del-btn" onclick="removeRecord(${r.id})">🗑</button>
      </td>
    </tr>`;
  }).join("");

  cardList.innerHTML = records.map(r => {
    const dateFmt = new Date(r.service_date).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
    const svcText = (r.services || []).map(s => s.name).join(", ") || "—";
    return `<div class="rec-card">
      <div class="rec-icon">🚙</div>
      <div class="rec-info">
        <div class="rec-title">${escapeHtml(r.car_brand)} · ${escapeHtml(r.car_number)}</div>
        <div class="rec-meta">
          <span>${dateFmt}</span>
          <span>· ${escapeHtml(r.bay_name || "—")}</span>
          <span>· ${escapeHtml(svcText)}</span>
          <span>· ${escapeHtml(r.received_by || r.staff_name || "—")}</span>
        </div>
      </div>
      <div class="rec-amount">${fmt(r.price)}</div>
      ${currentUser.role === "admin" ? `<button class="del-btn" onclick="openForm(${r.id})">✏️</button>` : ""}
      <button class="del-btn" onclick="removeRecord(${r.id})">🗑</button>
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
    records = records.filter(r => r.id !== id);
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
  const record = editingRecordId ? records.find(r => r.id === editingRecordId) : null;

  document.getElementById("modalTitle").textContent = record ? "Редактировать запись" : "Новая запись";
  document.getElementById("saveBtnLabel").textContent = record ? "Сохранить изменения" : "Сохранить запись";

  document.getElementById("fDate").value = record ? record.service_date.slice(0, 10) : todayStr();
  document.getElementById("fPrice").value = record ? record.price : "";
  document.getElementById("fBrand").value = record ? record.car_brand : "";
  document.getElementById("fNumber").value = record ? record.car_number : "";
  document.getElementById("fReceivedBy").value = record ? record.received_by : currentUser.name;
  document.getElementById("newServiceName").value = "";
  document.getElementById("newServicePrice").value = "";
  document.getElementById("newBayName").value = "";
  document.getElementById("fClientPhone").value = "";
  document.getElementById("clientCard").style.display = "none";
  loyaltyLookup = null;
  document.getElementById("loyaltySection").style.display = record ? "none" : "block";
  clearSignature();
  if (record && record.signature) {
    hasSignature = true;
    const img = new Image();
    img.onload = () => sigCanvas.getContext("2d").drawImage(img, 0, 0, sigCanvas.width, sigCanvas.height);
    img.src = record.signature;
  }
  renderServiceCheckboxes();
  renderBayOptions();
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
        ${u.id === currentUser.id ? "" : `<button class="u-del" onclick="deleteUser(${u.id})">Удалить</button>`}
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

async function deleteUser(id) {
  if (!confirm("Удалить этого пользователя?")) return;
  try {
    await apiAuth(`/users/${id}`, { method: "DELETE" });
    await loadUsers();
  } catch (err) {
    alert("Не удалось удалить: " + err.message);
  }
}

boot();
