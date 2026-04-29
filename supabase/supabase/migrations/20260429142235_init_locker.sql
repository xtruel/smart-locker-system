-- Abilita l'estensione UUID (solitamente già attiva in Supabase)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Tabella LOCKERS (Armadietti)
CREATE TABLE lockers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available', -- 'available', 'in_use', 'maintenance'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Tabella BOOKINGS (Prenotazioni)
CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  locker_id UUID REFERENCES lockers(id) ON DELETE CASCADE,
  user_id UUID, -- Riferimento a auth.users se usi Supabase Auth (opzionale)
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  pin_code VARCHAR(10) NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- 'active', 'completed', 'cancelled'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Tabella ACCESS_LOGS (Log di accesso)
CREATE TABLE access_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  locker_id UUID REFERENCES lockers(id) ON DELETE CASCADE,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  result TEXT NOT NULL, -- 'success', 'failed_invalid_pin', 'failed_expired'
  pin_used VARCHAR(10)
);

-- INDICI PER PERFORMANCE
CREATE INDEX idx_bookings_locker_id ON bookings(locker_id);
CREATE INDEX idx_bookings_pin_code ON bookings(pin_code);
CREATE INDEX idx_access_logs_locker_id ON access_logs(locker_id);

-- ROW LEVEL SECURITY (RLS)
ALTER TABLE lockers ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_logs ENABLE ROW LEVEL SECURITY;

-- Sicurezza: Il backend usa la "service_role key" quindi bypasserà queste policy.
-- Le policy qui sotto servono per permettere ad eventuali frontend web/app di leggere
-- in modo sicuro e per evitare che utenti non autenticati modifichino i dati.

-- Lettura pubblica (o per utenti autenticati) degli armadietti
CREATE POLICY "Allow read access to lockers" ON lockers FOR SELECT USING (true);

-- Gli utenti possono vedere solo le loro prenotazioni (se autenticati via Supabase Auth)
CREATE POLICY "Users view own bookings" ON bookings FOR SELECT USING (auth.uid() = user_id);

-- Insert solo tramite backend o utenti autenticati
CREATE POLICY "Users insert own bookings" ON bookings FOR INSERT WITH CHECK (auth.uid() = user_id);
