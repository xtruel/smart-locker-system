-- ============================================================================
-- Migration 001: Audit log esteso + ruoli utente + device registry persistente
-- ============================================================================
-- Applicare su Supabase (SQL Editor). Idempotente: usa IF NOT EXISTS ovunque.
-- Obiettivi:
--   1. access_logs arricchita con source, channel, device_id, message, metadata
--   2. nuova tabella audit_events per eventi non legati a un locker specifico
--      (login, cambio config, errori sistema, heartbeat device)
--   3. tabella user_roles per RBAC (admin/operator/customer)
--   4. tabella devices per registrare i tablet fisici (hub) nel DB
-- ============================================================================

-- === 1. access_logs estesa ===
ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS channel TEXT;
ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS message TEXT;
ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS metadata JSONB;

CREATE INDEX IF NOT EXISTS idx_access_logs_timestamp
  ON access_logs (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_access_logs_device_id
  ON access_logs (device_id);

-- === 2. user_roles (RBAC leggero sopra Supabase Auth) — creato prima perche'
--         audit_events fa riferimento a questa tabella nelle policy. ===
CREATE TABLE IF NOT EXISTS user_roles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'customer')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user reads own role" ON user_roles;
CREATE POLICY "user reads own role" ON user_roles FOR SELECT USING (
  auth.uid() = user_id
);
DROP POLICY IF EXISTS "admin reads all roles" ON user_roles;
CREATE POLICY "admin reads all roles" ON user_roles FOR SELECT USING (
  EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = auth.uid() AND ur.role = 'admin')
);

-- === 3. audit_events (eventi generici di sistema) ===
CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts TIMESTAMPTZ DEFAULT NOW(),
  event_type TEXT NOT NULL,           -- 'login', 'logout', 'config_change',
                                       -- 'tx_failed', 'heartbeat', 'api_401', ...
  actor TEXT,                          -- email/deviceId/source
  subject TEXT,                        -- id dell'oggetto (locker_id, deviceId)
  result TEXT,                         -- 'success' | 'failed' | 'info'
  message TEXT,
  metadata JSONB
);
CREATE INDEX IF NOT EXISTS idx_audit_events_ts
  ON audit_events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_type
  ON audit_events (event_type);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
-- Backend usa service_role key -> bypassa RLS. Nessun utente normale scrive.
DROP POLICY IF EXISTS "no public write audit" ON audit_events;
CREATE POLICY "no public write audit" ON audit_events FOR INSERT WITH CHECK (false);
DROP POLICY IF EXISTS "admins read audit" ON audit_events;
CREATE POLICY "admins read audit" ON audit_events FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'admin'
  )
);

-- === 4. devices (registro tablet fisici / hub) ===
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  site_id TEXT,                        -- opzionale, per multi-sito
  label TEXT,                          -- es. "Tablet Hall Nord"
  api_key_hash TEXT,                   -- opzionale: hash SHA256 per per-device key
  first_seen TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ,
  last_pull TIMESTAMPTZ,
  last_ack TIMESTAMPTZ,
  total_pulls BIGINT DEFAULT 0,
  total_acks_ok BIGINT DEFAULT 0,
  total_acks_failed BIGINT DEFAULT 0,
  metadata JSONB
);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen
  ON devices (last_seen DESC);

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read devices" ON devices;
CREATE POLICY "public read devices" ON devices FOR SELECT USING (true);
