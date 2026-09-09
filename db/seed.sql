-- Демо-данные для журнала автомойки
-- Пароли: admin / admin123 и ерлан / user123 (обязательно смените после первого входа)

INSERT INTO users (name, username, password_hash, role) VALUES
    ('Администратор', 'admin',  '$2b$10$cC//reRxrOiReODOcumAnedkGMDgnYBvMIkA9JXRcqk5DWmIDAvvq', 'admin'),
    ('Ерлан',          'erlan', '$2b$10$K.aitRyEI9GLPfk8tYLsKuK1NTlquK.a.HugvsQq5IWphH9pmtJJC', 'user')
ON CONFLICT (username) DO NOTHING;

INSERT INTO services (name, price) VALUES
    ('Комплексная мойка', 3500),
    ('Мойка кузова',      2000),
    ('Химчистка салона',  8000),
    ('Полировка',         6000),
    ('Чистка двигателя',  2500)
ON CONFLICT (name) DO NOTHING;

INSERT INTO washers (name) VALUES
    ('Ерлан'), ('Динара')
ON CONFLICT (name) DO NOTHING;

INSERT INTO bays (name) VALUES
    ('Бокс 1'), ('Бокс 2'), ('Бокс 3'), ('Бокс 4')
ON CONFLICT (name) DO NOTHING;

-- Демо-клиент бонусной программы: 5 визитов позади, 6-й (следующий) — со скидкой
INSERT INTO clients (phone, name, visit_count, points_balance) VALUES
    ('77071234567', 'Айгуль Ахметова', 5, 320)
ON CONFLICT (phone) DO NOTHING;

-- Демо-записи (Ерлан принял две машины сегодня)
WITH erlan AS (SELECT id FROM users WHERE username = 'erlan'),
     bay1 AS (SELECT id FROM bays WHERE name = 'Бокс 1'),
     bay2 AS (SELECT id FROM bays WHERE name = 'Бокс 2'),
     aigul AS (SELECT id FROM clients WHERE phone = '77071234567'),
     r1 AS (
       INSERT INTO records (service_date, car_brand, car_number, price, staff_id, received_by, bay_id, client_id, points_earned, amount_cash, amount_qr)
       SELECT CURRENT_DATE, 'Toyota Camry', '123 ABC 02', 5500, erlan.id, 'Ерлан', bay1.id, aigul.id, 275, 0, 5500 FROM erlan, bay1, aigul
       RETURNING id
     ),
     r2 AS (
       INSERT INTO records (service_date, car_brand, car_number, price, staff_id, received_by, bay_id, amount_cash, amount_qr)
       SELECT CURRENT_DATE, 'Hyundai Tucson', '456 KZE 05', 2000, erlan.id, 'Динара', bay2.id, 2000, 0 FROM erlan, bay2
       RETURNING id
     )
INSERT INTO record_services (record_id, service_id, service_name, service_price)
SELECT r1.id, s.id, s.name, s.price FROM r1, services s WHERE s.name IN ('Комплексная мойка', 'Химчистка салона')
UNION ALL
SELECT r2.id, s.id, s.name, s.price FROM r2, services s WHERE s.name = 'Мойка кузова';

-- Демо-расход (например, вызвали мастера починить пылесос)
INSERT INTO expenses (expense_date, description, amount, staff_id)
SELECT CURRENT_DATE, 'Ремонт пылесоса', 4000, id FROM users WHERE username = 'erlan';
