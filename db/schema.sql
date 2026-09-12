-- Схема базы данных: журнал автомойки
-- PostgreSQL 14+

CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'manager', 'user')),
    active        BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Расходы (мастер, ремонт, закупки и т.п.) — списываются из наличной кассы,
-- поэтому учитываются в отчёте при расчёте суммы к сдаче
CREATE TABLE IF NOT EXISTS expenses (
    id            BIGSERIAL PRIMARY KEY,
    expense_date  DATE NOT NULL,
    description   TEXT NOT NULL,
    amount        NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
    staff_id      INTEGER REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses (expense_date DESC, id DESC);

CREATE TABLE IF NOT EXISTS services (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    price       NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (price >= 0),
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Мойщики (кто принял машину) — настраиваемый список, можно добавлять новых прямо из формы
-- Связь телефона с чатом в Telegram — клиент один раз нажимает "Поделиться номером"
-- в боте, дальше код для входа/списания баллов можно слать туда вместо SMS (бесплатно)
CREATE TABLE IF NOT EXISTS telegram_links (
    id          SERIAL PRIMARY KEY,
    phone       TEXT NOT NULL UNIQUE,
    chat_id     BIGINT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Компании, которые платят раз в месяц через бухгалтерию (безналичный расчёт по
-- счёту) — отдельный, независимый от журнала записей учёт задолженности
CREATE TABLE IF NOT EXISTS companies (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    balance     NUMERIC(12, 2) NOT NULL DEFAULT 0,  -- текущий долг компании
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- История начислений и оплат по каждой компании — для истории/сверки
CREATE TABLE IF NOT EXISTS company_ledger (
    id           BIGSERIAL PRIMARY KEY,
    company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('charge', 'payment')),
    amount       NUMERIC(12, 2) NOT NULL,
    note         TEXT,
    staff_id     INTEGER REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_company_ledger_company ON company_ledger (company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS washers (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Боксы (посты мойки) — настраиваемый список, можно добавлять новые прямо из формы
CREATE TABLE IF NOT EXISTS bays (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Бонусная программа: клиент опознаётся по телефону, а не по номеру авто.
-- Номер авто виден любому на парковке, телефон знает только сам клиент —
-- поэтому подставить чужой номер и «увести» скидку заметно сложнее.
CREATE TABLE IF NOT EXISTS clients (
    id              SERIAL PRIMARY KEY,
    phone           TEXT NOT NULL UNIQUE,      -- нормализованный номер, только цифры
    name            TEXT,
    visit_count     INTEGER NOT NULL DEFAULT 0,
    points_balance  NUMERIC(12, 2) NOT NULL DEFAULT 0,
    otp_code_hash   TEXT,                       -- хэш текущего SMS-кода на списание баллов
    otp_expires_at  TIMESTAMPTZ,
    otp_attempts    INTEGER NOT NULL DEFAULT 0,
    portal_otp_code_hash   TEXT,                 -- отдельный код — для входа в личный кабинет клиента
    portal_otp_expires_at  TIMESTAMPTZ,
    portal_otp_attempts    INTEGER NOT NULL DEFAULT 0,
    points_percent_override NUMERIC(5, 2),  -- личный % баллов вместо общего (например, для старых клиентов с картами на 10%)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Настройки бонусной программы — одна строка, редактируется администратором
CREATE TABLE IF NOT EXISTS loyalty_settings (
    id               SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    points_percent   NUMERIC(5, 2) NOT NULL DEFAULT 5   -- % от суммы визита начисляется баллами
);
INSERT INTO loyalty_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Настройки для отчёта смены/кассы — одна строка, редактируется администратором
CREATE TABLE IF NOT EXISTS payroll_settings (
    id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    admin_percent   NUMERIC(5, 2) NOT NULL DEFAULT 10,  -- % от общей кассы — доля администратора
    washer_percent  NUMERIC(5, 2) NOT NULL DEFAULT 30   -- % от суммы каждой мойки — зарплата мойщика
);
INSERT INTO payroll_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS records (
    id                      BIGSERIAL PRIMARY KEY,
    service_date            DATE NOT NULL,
    car_brand               TEXT NOT NULL,
    car_number               TEXT NOT NULL,
    price                    NUMERIC(12, 2) NOT NULL CHECK (price >= 0),  -- итоговая сумма, с учётом бонусов
    staff_id                 INTEGER REFERENCES users(id),  -- кто вошёл в систему и создал запись (для учёта)
    received_by              TEXT,                          -- кто принял машину — заполняется вручную, можно поправить
    bay_id                   INTEGER REFERENCES bays(id),
    client_id                INTEGER REFERENCES clients(id),
    points_earned            NUMERIC(12, 2) NOT NULL DEFAULT 0,
    points_redeemed          NUMERIC(12, 2) NOT NULL DEFAULT 0,
    amount_cash              NUMERIC(12, 2) NOT NULL DEFAULT 0,  -- сколько из price оплачено наличными
    amount_qr                NUMERIC(12, 2) NOT NULL DEFAULT 0,  -- сколько из price оплачено через QR
    amount_invoice           NUMERIC(12, 2) NOT NULL DEFAULT 0,  -- сколько оплачено безналично по счёту (компании)
    company_id               INTEGER REFERENCES companies(id),  -- какая компания платит по счёту (если способ оплаты — "по счёту")
    is_paid                  BOOLEAN NOT NULL DEFAULT true,      -- оплачено сейчас или клиент заплатит позже
    signature                TEXT,                     -- подпись клиента, PNG в формате base64 data URL
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_records_date ON records (service_date DESC, id DESC);

-- Услуги, выбранные для конкретной записи (чекбоксы) — название/цена сохраняются
-- на момент записи, чтобы изменение каталога услуг не искажало прошлые записи
CREATE TABLE IF NOT EXISTS record_services (
    id             BIGSERIAL PRIMARY KEY,
    record_id      BIGINT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    service_id     INTEGER REFERENCES services(id) ON DELETE SET NULL,
    service_name   TEXT NOT NULL,
    service_price  NUMERIC(12, 2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_record_services_record ON record_services (record_id);

CREATE OR REPLACE VIEW daily_totals AS
SELECT
    service_date,
    COUNT(*)                    AS cars_count,
    COALESCE(SUM(price), 0)     AS total_revenue,
    COALESCE(AVG(price), 0)     AS avg_check
FROM records
GROUP BY service_date;
