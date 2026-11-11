-- S&L Trucking LLC — settlement portal schema
-- PostgreSQL 18. Run once:  psql "$DATABASE_URL" -f schema.sql
-- (The app also creates these tables automatically on first start via seed.js
--  if they do not exist, but schema.sql is the authoritative definition.)

CREATE TABLE IF NOT EXISTS drivers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  truck_number TEXT,
  pay_split NUMERIC(5,2) NOT NULL DEFAULT 50,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'driver')),
  driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loads (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  load_date DATE NOT NULL,
  container_no TEXT,
  bol_ref TEXT,
  pickup TEXT,
  delivery TEXT,
  appointment TIMESTAMPTZ,
  rate NUMERIC(10,2) NOT NULL DEFAULT 0,
  prepull NUMERIC(10,2) NOT NULL DEFAULT 0,
  overweight NUMERIC(10,2) NOT NULL DEFAULT 0,
  fsc NUMERIC(10,2) NOT NULL DEFAULT 0,
  miles NUMERIC(10,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),
  ticket_photo TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fuel (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  fuel_date DATE NOT NULL,
  gallons NUMERIC(10,2) NOT NULL,
  pump_price NUMERIC(6,3) NOT NULL,
  tcs_price NUMERIC(6,3) NOT NULL,
  cost NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS receipts (
  id SERIAL PRIMARY KEY,
  receipt_date DATE NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  reference TEXT,
  payer TEXT NOT NULL DEFAULT 'PierLink',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settlements (
  id SERIAL PRIMARY KEY,
  week_start DATE NOT NULL,
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  revenue NUMERIC(10,2) NOT NULL DEFAULT 0,
  fuel_cost NUMERIC(10,2) NOT NULL DEFAULT 0,
  insurance NUMERIC(10,2) NOT NULL DEFAULT 0,
  net NUMERIC(10,2) NOT NULL DEFAULT 0,
  driver_pay NUMERIC(10,2) NOT NULL DEFAULT 0,
  company_net NUMERIC(10,2) NOT NULL DEFAULT 0,
  miles NUMERIC(10,2) NOT NULL DEFAULT 0,
  gallons NUMERIC(10,2) NOT NULL DEFAULT 0,
  mpg NUMERIC(6,2),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at TIMESTAMPTZ,
  UNIQUE (week_start, driver_id)
);

CREATE TABLE IF NOT EXISTS odometer_readings (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  reading_date DATE NOT NULL,
  odometer NUMERIC(10,1) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  category TEXT NOT NULL CHECK (category IN ('mvr', 'medical_card', 'cdl', 'registration', 'contract', 'other')),
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dvir (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  inspection_date DATE NOT NULL,
  truck_number TEXT,
  defects TEXT,
  safe_to_operate BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mechanic_logs (
  id SERIAL PRIMARY KEY,
  truck_number TEXT NOT NULL,
  log_date DATE NOT NULL,
  description TEXT NOT NULL,
  cost NUMERIC(10,2) NOT NULL DEFAULT 0,
  mechanic TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loads_driver_date ON loads (driver_id, load_date);
CREATE INDEX IF NOT EXISTS idx_loads_status ON loads (status);
CREATE INDEX IF NOT EXISTS idx_fuel_driver_date ON fuel (driver_id, fuel_date);
CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts (receipt_date);
CREATE INDEX IF NOT EXISTS idx_settlements_week ON settlements (week_start);
CREATE INDEX IF NOT EXISTS idx_documents_driver ON documents (driver_id);
CREATE INDEX IF NOT EXISTS idx_dvir_driver_date ON dvir (driver_id, inspection_date);
CREATE INDEX IF NOT EXISTS idx_mechanic_truck_date ON mechanic_logs (truck_number, log_date);
