-- Схема базы данных: журнал автомойки
-- PostgreSQL 14+

CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS services (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    price       NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (price >= 0),
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
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Настройки бонусной программы — одна строка, редактируется администратором
CREATE TABLE IF NOT EXISTS loyalty_settings (
    id               SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    points_percent   NUMERIC(5, 2) NOT NULL DEFAULT 5   -- % от суммы визита начисляется баллами
);
INSERT INTO loyalty_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

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
