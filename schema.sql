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
  reefer NUMERIC(10,2) NOT NULL DEFAULT 0,
  detention NUMERIC(10,2) NOT NULL DEFAULT 0,
  overweight NUMERIC(10,2) NOT NULL DEFAULT 0,
  fsc NUMERIC(10,2) NOT NULL DEFAULT 0,
  miles NUMERIC(10,2) NOT NULL DEFAULT 0,
  progress TEXT NOT NULL DEFAULT 'scheduled' CHECK (progress IN ('scheduled', 'picked', 'delivered', 'returned')),
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
  expires_on DATE,
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

-- Migrations for databases created before the 2026-11 redesign.
-- seed.js runs this whole file at every boot, so these idempotent
-- statements migrate the production database on deploy.
ALTER TABLE loads ADD COLUMN IF NOT EXISTS reefer NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS detention NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS progress TEXT NOT NULL DEFAULT 'scheduled';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS expires_on DATE;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS weekend_applied BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS weekend_net NUMERIC(10,2) NOT NULL DEFAULT 0;

-- Rebuild round 2 (2026-11-14): evidence layer + invoice module +
-- tenure ladder + detention claims + change log.
-- Tenure ladder: hire date drives the 45/50/55 split; ladder_exempt
-- drivers (Sanders, Harrell) stay on their flat pay_split.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS hire_date DATE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS ladder_exempt BOOLEAN NOT NULL DEFAULT FALSE;

-- Detention claim flow: driver-entered detention starts 'pending' and is
-- excluded from settlement until the owner approves it. Existing rows
-- default to 'approved' (they were owner-entered).
ALTER TABLE loads ADD COLUMN IF NOT EXISTS detention_status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE loads DROP CONSTRAINT IF EXISTS loads_detention_status_check;
ALTER TABLE loads ADD CONSTRAINT loads_detention_status_check
  CHECK (detention_status IN ('none', 'pending', 'approved', 'rejected'));
-- Container size/type as printed on the EIR (e.g. 40RF) and the actual
-- empty-return date (stamped when progress reaches 'returned').
ALTER TABLE loads ADD COLUMN IF NOT EXISTS size TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS returned_on DATE;

-- The split actually used when a settlement was closed (audit trail for
-- the tenure ladder + weekend rule).
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS split_applied NUMERIC(5,2);

-- Per-stage evidence photos for a load. Photo bytes live in the database
-- (photo_data) so evidence survives Render redeploys; photo_path keeps
-- the legacy on-disk location for older rows.
CREATE TABLE IF NOT EXISTS load_evidence (
  id SERIAL PRIMARY KEY,
  load_id INTEGER NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('load_out', 'pod', 'empty_in', 'detention', 'other')),
  photo_path TEXT,
  photo_data BYTEA,
  mime_type TEXT,
  ocr_text TEXT,
  extracted JSONB,
  uploaded_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_evidence_load ON load_evidence (load_id);

-- Change log for load edits (correction policy, 2026-11-13/14): who
-- changed what on a load, old -> new.
CREATE TABLE IF NOT EXISTS load_changes (
  id SERIAL PRIMARY KEY,
  load_id INTEGER NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  changed_by TEXT,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_changes_load ON load_changes (load_id);

-- PierLink invoice module. A line is the CLAIM for one load (components
-- copied from the load, then owner-adjustable — claims can differ from
-- driver settlement, e.g. an overweight the driver was not paid).
-- Payments are recorded per week; a line's unpaid balance carries into
-- later invoices (the "Mty Not Return" holdback chain).
CREATE TABLE IF NOT EXISTS invoice_lines (
  id SERIAL PRIMARY KEY,
  load_id INTEGER UNIQUE REFERENCES loads(id) ON DELETE SET NULL,
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  claim_week DATE NOT NULL,
  description TEXT,
  rate NUMERIC(10,2) NOT NULL DEFAULT 0,
  prepull NUMERIC(10,2) NOT NULL DEFAULT 0,
  reefer NUMERIC(10,2) NOT NULL DEFAULT 0,
  detention NUMERIC(10,2) NOT NULL DEFAULT 0,
  overweight NUMERIC(10,2) NOT NULL DEFAULT 0,
  fsc NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_week ON invoice_lines (claim_week, driver_id);

CREATE TABLE IF NOT EXISTS invoice_payments (
  id SERIAL PRIMARY KEY,
  line_id INTEGER NOT NULL REFERENCES invoice_lines(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_week ON invoice_payments (week_start);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_line ON invoice_payments (line_id);

-- Per-week invoice header state: help-insurance override, the $500/week
-- advance repayment chain, and the amount actually received.
CREATE TABLE IF NOT EXISTS invoice_weeks (
  week_start DATE PRIMARY KEY,
  help_ins_override NUMERIC(10,2),
  advance_before NUMERIC(10,2),
  advance_deduct NUMERIC(10,2) NOT NULL DEFAULT 500,
  received NUMERIC(10,2) NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ,
  notes TEXT
);

-- Safety training acknowledgments: one row per driver per topic, written
-- when the driver taps "I have read and understand" on the Safety page.
CREATE TABLE IF NOT EXISTS safety_acks (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  acked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (driver_id, topic)
);
CREATE INDEX IF NOT EXISTS idx_safety_acks_driver ON safety_acks (driver_id);

-- Load-flow redesign (2026-11-14, Eric): staged owner approvals.
-- A load is created from the dispatch capture (skeleton), the owner
-- approves the dispatch, the tickets are uploaded (money facts come
-- from the tickets), the owner approves the tickets, and only then can
-- the load be confirmed for settlement. empty_container records the
-- empty this driver returns alongside the job (the dispatch's EMPTY
-- RETURN leg — container number only).
ALTER TABLE loads ADD COLUMN IF NOT EXISTS empty_container TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS dispatch_ok BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS tickets_ok BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE loads SET dispatch_ok = TRUE, tickets_ok = TRUE WHERE status = 'confirmed';
-- Dispatch PINs (Eric's flow sheet, 2026-11-14): the driver needs the
-- gate PIN for both legs, so the skeleton keeps them next to the
-- container numbers.
ALTER TABLE loads ADD COLUMN IF NOT EXISTS empty_pin TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS load_pin TEXT;
-- Job types (Eric, 2026-11-14): every job is a pair of gate moves.
-- standard = Empty in + Load out (default); in_out_empty = Load in +
-- Empty out; in_out_load = Load in + Load out.
ALTER TABLE loads ADD COLUMN IF NOT EXISTS job_type TEXT NOT NULL DEFAULT 'standard';

-- Prepull work (Eric, 2026-11-14): a driver who does ANOTHER driver's
-- leg (returns their empty +$60 / pulls their load out +$75) submits
-- it here WITH the terminal ticket photo — no ticket, no credit. The
-- owner approves; the credit joins the worker's week income (split
-- like everything else) and the matching deduction lands on the
-- owner's load. Exceptions are handled off-system (Zelle), by design.
CREATE TABLE IF NOT EXISTS prepulls (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  work_date DATE NOT NULL,
  kind TEXT NOT NULL,
  container_no TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  load_id INTEGER REFERENCES loads(id),
  status TEXT NOT NULL DEFAULT 'pending',
  photo_data BYTEA,
  photo_mime TEXT,
  ocr_text TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

-- Driver address/phone for the statement letterhead (Eric's Excel
-- statement format, 2026-11-14). Drivers will maintain these
-- themselves in the profile build; admin can enter them meanwhile.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS phone TEXT;

-- My File build (2026-11-14, Eric): the driver's own section of the
-- portal — profile self-edit with owner review (the approval chain:
-- driver submits, owner confirms), a DQF document center whose files
-- live IN the database (disk uploads were lost on every redeploy),
-- training records, and company-record status lines. Driver uploads
-- land as 'pending' until the owner confirms them; documents that
-- were already on file stay 'confirmed'.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS emergency_name TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS emergency_phone TEXT;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_data BYTEA;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'confirmed';

-- In-portal signing (2026-11-15, Eric): a signed copy is a NEW document
-- row stamped from the original; signed_by / signed_at record who put
-- the signature on and when, so the folder keeps its audit trail.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS signed_by TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_category_check;
ALTER TABLE documents ADD CONSTRAINT documents_category_check
  CHECK (category IN ('mvr','medical_card','cdl','registration','contract','twic','w9','drug_test','clearinghouse','road_test','application','annual_review','clearinghouse_consent','safety_history','other'));

CREATE TABLE IF NOT EXISTS profile_changes (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  address TEXT,
  phone TEXT,
  emergency_name TEXT,
  emergency_phone TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

-- My Truck build (2026-11-14, Eric): a top-level section per truck —
-- vehicle documents register plus repair history. Vehicle documents
-- live IN the database (registration, annual inspection, insurance,
-- permits, title/lease) with expiry tracking; the originals ride in
-- the truck, the portal holds the copies.
CREATE TABLE IF NOT EXISTS vehicle_docs (
  id SERIAL PRIMARY KEY,
  truck_number TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('registration','annual_inspection','insurance','permit','title_lease','other')),
  original_name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  file_data BYTEA,
  expires_on DATE,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Repair records grow up: where the work was done, who paid, the
-- odometer, the invoice photo, and who entered the record. Entries
-- from drivers and outside shops wait as 'pending' until the owner
-- reviews them — his word for that step is Reviewed & Recorded, not
-- Approved: he confirms the record, he did not approve the repair.
-- Rows that predate this build keep the default 'recorded'.
ALTER TABLE mechanic_logs ADD COLUMN IF NOT EXISTS odometer INTEGER;
ALTER TABLE mechanic_logs ADD COLUMN IF NOT EXISTS shop TEXT;
ALTER TABLE mechanic_logs ADD COLUMN IF NOT EXISTS paid_by TEXT;
ALTER TABLE mechanic_logs ADD COLUMN IF NOT EXISTS photo_data BYTEA;
ALTER TABLE mechanic_logs ADD COLUMN IF NOT EXISTS photo_mime TEXT;
ALTER TABLE mechanic_logs ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'recorded';
ALTER TABLE mechanic_logs ADD COLUMN IF NOT EXISTS entered_by TEXT;
ALTER TABLE mechanic_logs ADD COLUMN IF NOT EXISTS driver_id INTEGER REFERENCES drivers(id);
ALTER TABLE mechanic_logs ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- Mechanic entry (2026-11-14, Eric): one shared shop login. Any shop
-- that repairs a truck can enter the record; the account sees only
-- the repair-entry page. The shop name is required on every entry —
-- that, not the login, is the accountability.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','driver','mechanic','cpa'));

-- Driver Overview profile fields (2026-11-15): date of birth, email and
-- the license (CDL) number + issuing state live ON the driver record —
-- the FMCSA driver roster asks for exactly these.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS dob DATE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS license_no TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS license_state TEXT;

-- Vehicle documents gain the approval chain (2026-11-15): a driver can
-- upload his own truck's registration / annual inspection; the upload
-- waits as 'pending' until the owner confirms it. Existing rows and
-- owner uploads are 'confirmed'. The roadside copy is always the
-- newest CONFIRMED document.
ALTER TABLE vehicle_docs ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'confirmed';
ALTER TABLE vehicle_docs ADD COLUMN IF NOT EXISTS uploaded_by TEXT;

-- Public website messages (contact form on the public home page).
-- Stored in the portal only — never emailed, never shown publicly.
-- Eric reads them on the admin dashboard (Nov 15, 2026).
CREATE TABLE IF NOT EXISTS contact_messages (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  contact     TEXT NOT NULL,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'new',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ
);

-- Vehicle register: one row per truck (unit number is the key).
-- VIN and plate live here — not on the driver — and are read by the
-- dashboard roster and the audit page. (Eric, 2026-11-15.)
CREATE TABLE IF NOT EXISTS vehicles (
  truck_number TEXT PRIMARY KEY,
  vin          TEXT,
  plate        TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Documents: duplicate flag (2026-11-15). A duplicate upload is kept for
-- the record but never becomes the checklist record for its category.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS is_duplicate BOOLEAN NOT NULL DEFAULT FALSE;

-- Issued items (2026-11-15): company property handed to a driver —
-- Amex card, TCS fuel card, tablet, phone, keys — with issue/return
-- tracking. Holder may be a former driver (name only, no driver row).
CREATE TABLE IF NOT EXISTS issued_items (
  id          SERIAL PRIMARY KEY,
  driver_id   INTEGER REFERENCES drivers(id),
  holder_name TEXT,
  item_type   TEXT NOT NULL,
  detail      TEXT,
  issued_on   DATE NOT NULL DEFAULT CURRENT_DATE,
  returned_on DATE,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Yard drops + CPA role (2026-11-16, Eric): a driver who finishes a
-- delivery may drop the empty at the S&L yard instead of returning it
-- to the terminal. His job ENDS at the yard drop: the $60 empty-return
-- amount is not paid on that load (yard_fee = -60, his return leg was
-- not run). The yard -> terminal move is a SEPARATE dispatched job:
-- whoever runs it claims it as a prepull empty return (+$60, ticket
-- required, "picked up at yard" marked on the claim) — the money
-- follows the work, as always. There is deliberately NO yard
-- inventory page: the yard is shared with other companies, so the
-- portal tracks only the drop/pickup functions, not the yard itself.
-- Approving a yard pickup closes the drop record (yard_cleared_on).
ALTER TABLE loads ADD COLUMN IF NOT EXISTS yard_drop BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS yard_drop_on DATE;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS yard_fee NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS yard_cleared_on DATE;
ALTER TABLE prepulls ADD COLUMN IF NOT EXISTS from_yard BOOLEAN NOT NULL DEFAULT FALSE;

-- CPA role: the company's accountant gets his own login, fenced by the
-- server middleware to read-only accounting sections (settlement,
-- invoice, fuel + his overview page). He never sees driver files.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','driver','mechanic','cpa'));
-- Downtime / other pay (Eric, 2026-11-21): when a truck is down for
-- repairs the driver still gets paid (e.g. $200/day). This is NOT load
-- revenue: it is added to the driver's week pay in full, after the
-- split, with the reason recorded so the payment explains itself.
CREATE TABLE IF NOT EXISTS downtime_pay (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  pay_date DATE NOT NULL,
  amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Business documents (Eric, 2026-11-22): bank/card statements and other
-- company financial documents, uploaded by the owner and readable by
-- the CPA (read-only, fenced in server.js). Files live in the database.
CREATE TABLE IF NOT EXISTS business_documents (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Bank Statement',
  period_label TEXT,
  original_name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  file_data BYTEA,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- Ledger: categorized bank/card transactions for the CPA view.
-- Amounts: income positive, money out negative. basket separates
-- income / expense / transfer / personal / capital / review so card
-- payments (transfers) never double-count as expenses.
CREATE TABLE IF NOT EXISTS ledger_transactions (
  id SERIAL PRIMARY KEY,
  txn_date DATE NOT NULL,
  account TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  amount NUMERIC(12,2) NOT NULL,
  eric_label TEXT NOT NULL DEFAULT '',
  basket TEXT NOT NULL DEFAULT 'review',
  category TEXT NOT NULL DEFAULT 'Needs Review',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_transactions_date_idx ON ledger_transactions (txn_date);


-- Driver/truck split (Eric, 2026-11-23): fuel and loads record the truck
-- PER TRANSACTION, frozen at entry time. drivers.truck_number remains
-- only the CURRENT assignment (driver overview + entry-form default).
-- Backfill freezes each existing row at the truck the pages displayed
-- for it — except Sterling Green (driver_id 1), who switched
-- #101 -> #100 on 2026-11-23: his earlier rows belong to #101.
ALTER TABLE fuel ADD COLUMN IF NOT EXISTS truck_number TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS truck_number TEXT;
UPDATE fuel f
   SET truck_number = CASE WHEN f.driver_id = 1 AND f.fuel_date < DATE '2026-11-23'
                           THEN '101'
                           ELSE regexp_replace(COALESCE(d.truck_number, ''), '^#', '') END
  FROM drivers d
 WHERE d.id = f.driver_id AND f.truck_number IS NULL;
UPDATE loads l
   SET truck_number = CASE WHEN l.driver_id = 1 AND l.load_date < DATE '2026-11-23'
                           THEN '101'
                           ELSE regexp_replace(COALESCE(d.truck_number, ''), '^#', '') END
  FROM drivers d
 WHERE d.id = l.driver_id AND l.truck_number IS NULL;
