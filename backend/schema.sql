-- ============================================================================
-- LockerPRO — Schema Supabase (PostgreSQL)
-- Da eseguire nell'SQL Editor di Supabase (una volta).
-- Idempotente: si puo' rieseguire senza rompere nulla.
--
-- Il backend usa la SERVICE_ROLE key (bypassa RLS), quindi non servono policy
-- per farlo funzionare. RLS e' comunque abilitata come default sicuro:
-- l'accesso diretto anon/authenticated e' bloccato, tutto passa dal backend.
-- ============================================================================

-- ------------------------------------------------------------------ lockers
-- 12 celle fisiche. id testuale (es. LCK-01), mappato al canale relè CHx.
create table if not exists public.lockers (
  id          text primary key,            -- es. 'LCK-01'
  name        text,                        -- es. 'Cella 01'
  location    text,                        -- es. 'Cella 01'
  channel     text not null,               -- es. 'CH1' (relè fisico)
  device_id   text not null default 'tablet-main',
  status      text not null default 'available',  -- available|reserved|occupied|maintenance
  size        text default 'M',
  zone        text default 'Locker',
  created_at  timestamptz not null default now()
);

-- Seed / aggiornamento delle 12 celle -> canali CH1..CH12 su tablet-main.
insert into public.lockers (id, name, location, channel, device_id, status)
select
  'LCK-' || lpad(g::text, 2, '0'),
  'Cella '  || lpad(g::text, 2, '0'),
  'Cella '  || lpad(g::text, 2, '0'),
  'CH' || g,
  'tablet-main',
  'available'
from generate_series(1, 12) as g
on conflict (id) do update
  set channel   = excluded.channel,
      device_id = excluded.device_id;

-- ----------------------------------------------------------------- bookings
create table if not exists public.bookings (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid,                        -- auth.users.id (nullable per booking admin/test)
  locker_id   text references public.lockers(id) on delete set null,
  pin_code    text,
  status      text not null default 'active',  -- active|cancelled|completed|expired
  start_time  timestamptz,
  end_time    timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists idx_bookings_lookup
  on public.bookings (locker_id, pin_code, status);
create index if not exists idx_bookings_user on public.bookings (user_id);

-- -------------------------------------------------------------- access_logs
create table if not exists public.access_logs (
  id          uuid primary key default gen_random_uuid(),
  locker_id   text,
  result      text,                        -- success|failed_invalid_pin|...
  pin_used    text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_access_logs_locker on public.access_logs (locker_id, created_at desc);

-- --------------------------------------------------------------- user_roles
create table if not exists public.user_roles (
  user_id     uuid primary key,            -- auth.users.id
  role        text not null default 'customer',  -- customer|operator|admin
  created_at  timestamptz not null default now()
);

-- --------------------------------------------------------------- audit_logs
create table if not exists public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  event_type  text,
  actor       text,
  subject     text,
  result      text,
  message     text,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_audit_created on public.audit_logs (created_at desc);

-- --------------------------------------------------------------------- RLS
alter table public.lockers      enable row level security;
alter table public.bookings     enable row level security;
alter table public.access_logs  enable row level security;
alter table public.user_roles   enable row level security;
alter table public.audit_logs   enable row level security;

-- Nota: il backend (service_role) bypassa la RLS, quindi funziona senza policy.
-- Se in futuro il frontend leggesse Supabase direttamente, aggiungere qui le
-- policy per anon/authenticated.

-- ============================================================================
-- Verifica veloce dopo l'esecuzione:
--   select id, channel, device_id, status from public.lockers order by id;
--   -> deve mostrare LCK-01..LCK-12 con CH1..CH12.
-- ============================================================================
