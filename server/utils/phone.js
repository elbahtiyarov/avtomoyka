// Нормализация номера телефона — вынесено в отдельный модуль без зависимостей,
// чтобы его могли использовать routes/clients.js, routes/records.js,
// routes/clientPortal.js и services/telegramBot.js без циклических require().

function normalizePhone(raw) {
  let digits = (raw || "").replace(/\D/g, "");
  // В Казахстане номер часто пишут с "8" в начале (внутренний формат), а не с "+7" —
  // это один и тот же номер, поэтому приводим оба варианта к единому виду (с 7).
  if (digits.length === 11 && digits.startsWith("8")) {
    digits = "7" + digits.slice(1);
  }
  return digits;
}

module.exports = { normalizePhone };
