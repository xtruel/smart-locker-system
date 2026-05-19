-- ============================================================================
-- 002_locker_channel_device.sql
-- ============================================================================
-- Aggiunge al locker il mapping al canale fisico (CH1..CH12) della board
-- relè e l'identificativo del tablet che la controlla. Questo sposta la
-- "verità" del mapping locker → CH dal frontend localStorage al database,
-- cosi' che il backend possa risolverlo autonomamente sul flusso customer.
-- ============================================================================

ALTER TABLE lockers
  ADD COLUMN IF NOT EXISTS channel TEXT
    CHECK (channel IS NULL OR channel ~ '^CH([1-9]|1[0-2])$'),
  ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT 'tablet-main';

-- Index per lookup veloce per tablet
CREATE INDEX IF NOT EXISTS idx_lockers_device_id ON lockers(device_id);

-- Imposta CH8 per il locker di test "Ingresso Principale".
-- Sostituire l'UUID con quello reale del proprio ambiente se diverso.
UPDATE lockers
   SET channel = 'CH8',
       device_id = 'tablet-main'
 WHERE id = 'cdc5d5ea-aca7-42e1-b765-8fe3c899a96e';
