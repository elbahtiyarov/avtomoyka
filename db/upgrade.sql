-- Безопасное обновление структуры базы — НИЧЕГО не удаляет и не пересоздаёт
-- существующие таблицы, только добавляет то, чего не хватает. Можно запускать
-- сколько угодно раз, в том числе на базе с реальными данными.
--
-- Логика: сначала применяется обычная schema.sql (она использует
-- CREATE TABLE IF NOT EXISTS — новые таблицы создаст, существующие не тронет),
-- а этот файл донастраивает те таблицы, что уже существовали до появления
-- новых полей.

-- users: поле "active" появилось после первой версии
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

-- records: набор полей рос по мере добавления функций (боксы, мойщики,
-- бонусы, способ оплаты)
ALTER TABLE records ADD COLUMN IF NOT EXISTS received_by TEXT;
ALTER TABLE records ADD COLUMN IF NOT EXISTS bay_id INTEGER REFERENCES bays(id);
ALTER TABLE records ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id);
ALTER TABLE records ADD COLUMN IF NOT EXISTS points_earned NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE records ADD COLUMN IF NOT EXISTS points_redeemed NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE records ADD COLUMN IF NOT EXISTS amount_cash NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE records ADD COLUMN IF NOT EXISTS amount_qr NUMERIC(12, 2) NOT NULL DEFAULT 0;
-- поле было в одной из промежуточных версий и больше не используется — просто убираем,
-- на остальные данные это не влияет
ALTER TABLE records DROP COLUMN IF EXISTS visit_discount_applied;

-- clients: поля для SMS-кода на списание баллов
ALTER TABLE clients ADD COLUMN IF NOT EXISTS otp_code_hash TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS otp_attempts INTEGER NOT NULL DEFAULT 0;
-- clients: отдельные поля для входа в личный кабинет клиента (не путать с кодом на списание)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS portal_otp_code_hash TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS portal_otp_expires_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS portal_otp_attempts INTEGER NOT NULL DEFAULT 0;

-- loyalty_settings: упростили до одного процента баллов, убрали скидку за визиты
ALTER TABLE loyalty_settings DROP COLUMN IF EXISTS visits_threshold;
ALTER TABLE loyalty_settings DROP COLUMN IF EXISTS visit_discount_percent;

-- На случай, если каких-то индексов ещё нет (не критично, но не помешает)
CREATE INDEX IF NOT EXISTS idx_records_date ON records (service_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_record_services_record ON record_services (record_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses (expense_date DESC, id DESC);
