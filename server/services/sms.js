// Отправка SMS. Провайдер выбирается переменной окружения SMS_PROVIDER:
//   console — ничего никуда не отправляет, просто печатает код в консоль сервера
//             (по умолчанию — удобно для разработки, пока не подключён платный шлюз)
//   mobizon — https://mobizon.kz
//   smsc    — https://smsc.kz
//
// Для реальной отправки заполните SMS_API_KEY (и SMS_API_LOGIN для smsc) в .env
// и поменяйте SMS_PROVIDER на нужного провайдера.

async function sendSms(phone, text) {
  const provider = (process.env.SMS_PROVIDER || "console").toLowerCase();

  if (provider === "console") {
    console.log(`[SMS → +${phone}] ${text}`);
    return { ok: true, provider: "console" };
  }

  if (provider === "mobizon") {
    const apiKey = process.env.SMS_API_KEY;
    const domain = process.env.SMS_API_DOMAIN || "api.mobizon.kz";
    if (!apiKey) throw new Error("Не задан SMS_API_KEY для Mobizon");

    const params = new URLSearchParams({ recipient: phone, text, apiKey });
    const res = await fetch(`https://${domain}/service/message/sendsmsmessage?${params.toString()}`);
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.message || "Ошибка отправки SMS (Mobizon)");
    return { ok: true, provider: "mobizon", raw: data };
  }

  if (provider === "smsc") {
    const login = process.env.SMS_API_LOGIN;
    const password = process.env.SMS_API_KEY;
    if (!login || !password) throw new Error("Не заданы SMS_API_LOGIN/SMS_API_KEY для SMSC");

    const params = new URLSearchParams({
      login, psw: password, phones: phone, mes: text, fmt: "3", charset: "utf-8",
    });
    const res = await fetch(`https://smsc.kz/sys/send.php?${params.toString()}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return { ok: true, provider: "smsc", raw: data };
  }

  throw new Error(`Неизвестный провайдер SMS: ${provider}`);
}

module.exports = { sendSms };
