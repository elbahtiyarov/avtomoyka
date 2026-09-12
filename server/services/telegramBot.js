// Telegram-бот как бесплатная альтернатива SMS для кода подтверждения.
//
// Как это работает для клиента:
//   1. Находит бота в Telegram (по имени, которое вы получили от @BotFather) и
//      нажимает /start
//   2. Бот показывает кнопку "Поделиться номером" — клиент нажимает её один раз
//   3. Telegram сам присылает боту номер телефона вместе с chat_id — мы их связываем
//   4. С этого момента код для входа/списания баллов можно слать в Telegram вместо SMS
//
// Важно: бот НЕ МОЖЕТ написать пользователю первым — это ограничение самого
// Telegram, а не наше. Пока клиент не нажал /start и не поделился номером,
// для него будет использоваться обычная SMS (см. server/services/sms.js).
//
// Настройка: получите токен у @BotFather в Telegram, впишите его в .env как
// TELEGRAM_BOT_TOKEN. Если токен не задан — бот просто не запускается, ничего
// не ломается, работает только SMS.

const pool = require("../db");
const { normalizePhone } = require("../utils/phone");

let bot = null;

function initTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("TELEGRAM_BOT_TOKEN не задан — Telegram-бот отключён, коды идут только по SMS.");
    return;
  }

  const TelegramBot = require("node-telegram-bot-api");
  bot = new TelegramBot(token, { polling: true });

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "Привет! Это бот автомойки для получения кода подтверждения вместо SMS.\n\nНажмите кнопку ниже, чтобы привязать номер телефона.", {
      reply_markup: {
        keyboard: [[{ text: "📱 Поделиться номером", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
  });

  bot.on("contact", async (msg) => {
    try {
      const phone = normalizePhone(msg.contact.phone_number);
      const chatId = msg.chat.id;
      await pool.query(
        `INSERT INTO telegram_links (phone, chat_id)
         VALUES ($1, $2)
         ON CONFLICT (phone) DO UPDATE SET chat_id = EXCLUDED.chat_id`,
        [phone, chatId]
      );
      bot.sendMessage(chatId, "Готово! Теперь коды подтверждения будут приходить сюда, в Telegram, вместо SMS.", {
        reply_markup: { remove_keyboard: true },
      });
    } catch (err) {
      console.error("Ошибка привязки Telegram:", err);
    }
  });

  bot.on("polling_error", (err) => {
    console.error("Telegram polling error:", err.message);
  });

  console.log("Telegram-бот запущен.");
}

// Пытается отправить код в Telegram. Возвращает true, если для этого номера есть
// привязка и сообщение отправлено; false — значит, номер не привязан, нужно
// использовать обычную SMS.
async function sendTelegramCode(phone, text) {
  if (!bot) return false;
  try {
    const normalized = normalizePhone(phone);
    const { rows } = await pool.query("SELECT chat_id FROM telegram_links WHERE phone = $1", [normalized]);
    if (rows.length === 0) return false;
    await bot.sendMessage(rows[0].chat_id, text);
    return true;
  } catch (err) {
    console.error("Не удалось отправить код в Telegram:", err.message);
    return false;
  }
}

module.exports = { initTelegramBot, sendTelegramCode };
