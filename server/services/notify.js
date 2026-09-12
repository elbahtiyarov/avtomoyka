const { sendTelegramCode } = require("./telegramBot");
const { sendSms } = require("./sms");

// Пробует отправить код в Telegram (бесплатно, если номер уже привязан к боту),
// и только если это не получилось — обычной SMS. Возвращает, каким каналом
// реально ушло сообщение, чтобы вызывающий код мог показать это пользователю.
async function sendCode(phone, text) {
  const sentViaTelegram = await sendTelegramCode(phone, text);
  if (sentViaTelegram) return { channel: "telegram" };

  const smsResult = await sendSms(phone, text);
  return { channel: "sms", provider: smsResult.provider };
}

module.exports = { sendCode };
