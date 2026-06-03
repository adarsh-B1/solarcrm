-- SolarCRM SaaS Database Schema for Supabase

-- ── Vendors (companies using SolarCRM) ──
CREATE TABLE IF NOT EXISTS vendors (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  company TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  plan TEXT DEFAULT 'trial' CHECK (plan IN ('trial', 'pro', 'expired')),
  trial_ends_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'),
  subscription_ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Sessions ──
CREATE TABLE IF NOT EXISTS sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  vendor_id UUID REFERENCES vendors(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days'),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Customers ──
CREATE TABLE IF NOT EXISTS customers (
  id TEXT NOT NULL,
  vendor_id UUID REFERENCES vendors(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  kw NUMERIC DEFAULT 0,
  loc TEXT,
  agr TEXT DEFAULT 'pending',
  fin TEXT DEFAULT 'pending',
  dcr TEXT DEFAULT 'pending',
  insp TEXT DEFAULT 'pending',
  inst TEXT DEFAULT 'pending',
  sub_req TEXT DEFAULT 'pending',
  sub_disb TEXT DEFAULT 'pending',
  sub TEXT DEFAULT 'pending',
  sub_amt NUMERIC DEFAULT 0,
  sub_recv NUMERIC DEFAULT 0,
  loan NUMERIC DEFAULT 0,
  bank TEXT,
  dcr_no TEXT,
  dcr_date TEXT,
  inst_date TEXT,
  consumer_acc TEXT,
  sanctioned_load NUMERIC DEFAULT 0,
  status_raw TEXT,
  app_no TEXT,
  discom TEXT,
  submitted_on TEXT,
  notes TEXT,
  remind TEXT,
  remind_time TEXT DEFAULT '10:00',
  docs JSONB DEFAULT '{}',
  doc_inputs JSONB DEFAULT '{}',
  panel_serials JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (id, vendor_id)
);

-- ── Row Level Security ──
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

-- Allow all operations via service role (our backend handles auth)
CREATE POLICY "service_all" ON vendors FOR ALL USING (true);
CREATE POLICY "service_all" ON sessions FOR ALL USING (true);
CREATE POLICY "service_all" ON customers FOR ALL USING (true);

-- ── Indexes ──
CREATE INDEX IF NOT EXISTS idx_customers_vendor ON customers(vendor_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_vendor ON sessions(vendor_id);
