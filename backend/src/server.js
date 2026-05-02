import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';

// Carica .env (utile solo in locale, su Render le env vars sono iniettate automaticamente)
dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), 'backend/.env') });

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend files - cerca la cartella public in vari percorsi possibili
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Prova prima relativo a server.js (../../public), poi relativo al cwd (./public)
const publicPath = path.join(__dirname, '../../public');
app.use(express.static(publicPath));
app.use(express.static(path.join(process.cwd(), 'public')));

// Controlla variabili d'ambiente
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('⚠️  ATTENZIONE: SUPABASE_URL o SUPABASE_SERVICE_KEY non configurate!');
  console.error('   Il server partirà ma le chiamate al database falliranno.');
}

// Inizializza Supabase con SERVICE ROLE KEY per bypassare RLS e agire come Admin
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'placeholder'
);

// Helper: Genera un PIN a 4 cifre random
const generatePin = () => Math.floor(1000 + Math.random() * 9000).toString();

// ============================================================================
// API KEY MIDDLEWARE — Protegge /command/*
// ============================================================================
// Se la env var COMMAND_API_KEY NON e' impostata, gli endpoint sono aperti
// (comportamento storico — backward compat per migrazione graduale). Appena
// la key viene settata su Render, TUTTI i client (frontend + tablet) devono
// inviarla via header `x-api-key` oppure query string `?key=...`.
//
// Anti-brute-force leggero: timing-safe compare + log dei tentativi falliti.
// ============================================================================
const API_KEY = (process.env.COMMAND_API_KEY || '').trim();
const API_KEY_REQUIRED = API_KEY.length > 0;

function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function requireApiKey(req, res, next) {
  if (!API_KEY_REQUIRED) return next();
  const provided = (
    req.get('x-api-key') ||
    req.query.key ||
    ''
  ).toString();
  if (provided && timingSafeEqualStr(provided, API_KEY)) return next();
  console.warn(
    `🔐 [auth] Rifiutata richiesta ${req.method} ${req.path} da ${req.ip} (key ${provided ? 'errata' : 'mancante'})`
  );
  return res.status(401).json({
    success: false,
    error: 'Unauthorized: x-api-key header mancante o errato',
  });
}

console.log(
  API_KEY_REQUIRED
    ? '🔐 API key richiesta su /command/* (COMMAND_API_KEY configurata)'
    : '⚠️  API key NON configurata — /command/* aperti a tutti (dev mode)'
);

// ============================================================================
// AUDIT LOG PERSISTENTE (Supabase) — opt-in, degrada gracefully
// ============================================================================
// Se la tabella `audit_events` e le colonne estese di `access_logs` esistono
// (migration 001_audit_and_roles.sql applicata), i log vengono scritti anche
// su DB. Altrimenti fail silenziosamente e si continua con i log in-memory.
// ============================================================================

const SUPABASE_CONFIGURED = !!(
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
);

/** Scrive un evento su audit_events. Best-effort, non blocca mai. */
async function logAuditEvent(event) {
  if (!SUPABASE_CONFIGURED) return;
  try {
    await supabase.from('audit_events').insert([
      {
        event_type: event.event_type,
        actor: event.actor || null,
        subject: event.subject || null,
        result: event.result || 'info',
        message: event.message || null,
        metadata: event.metadata || null,
      },
    ]);
  } catch (err) {
    // Log fallito — probabilmente tabella non ancora creata. Skip.
    if (process.env.DEBUG_AUDIT) {
      console.warn('[audit] insert failed:', err.message || err);
    }
  }
}

/** Upsert del device registry su DB. Best-effort. */
async function persistDeviceState(deviceId, patch) {
  if (!SUPABASE_CONFIGURED) return;
  try {
    const d = deviceRegistry.get(deviceId);
    if (!d) return;
    await supabase.from('devices').upsert(
      {
        device_id: deviceId,
        last_seen: d.lastSeen ? new Date(d.lastSeen).toISOString() : null,
        last_pull: d.lastPull ? new Date(d.lastPull).toISOString() : null,
        last_ack: d.lastAck ? new Date(d.lastAck).toISOString() : null,
        total_pulls: d.pulls,
        total_acks_ok: d.acksOk,
        total_acks_failed: d.acksFailed,
      },
      { onConflict: 'device_id' }
    );
  } catch (err) {
    if (process.env.DEBUG_AUDIT) {
      console.warn('[audit] device upsert failed:', err.message || err);
    }
  }
}

// ============================================================================
// COMMAND QUEUE — Ponte Web UI ⇄ Tablet Android (RS485 relay board)
// ============================================================================
// Architettura multi-tablet:
//   - Ogni tablet si identifica con un deviceId (es. "tablet-main",
//     "tablet-hub-roma", "tablet-cold-zone").
//   - POST /command/push include deviceId target (default "tablet-main" per
//     backward compat con vecchi client che non lo specificano).
//   - GET /command/pull?deviceId=xyz consuma SOLO i comandi destinati a quel
//     deviceId. Chi non specifica deviceId riceve la coda "tablet-main".
//   - Heartbeat automatico: ogni /command/pull aggiorna lastSeen del device.
//     GET /devices mostra lo stato online/offline di tutti i tablet noti.
//   - POST /command/ack registra il risultato effettivo (TX-USB riuscito?).
//   - Nessuna persistenza: tutto in memoria, resiste solo a piccoli riavvi.
// ============================================================================

// Coda partizionata per deviceId.  Map<deviceId, Array<Command>>.
const commandQueues = new Map();
const MAX_QUEUE_PER_DEVICE = 100;
const VALID_CHANNELS = new Set(
  Array.from({ length: 12 }, (_, i) => `CH${i + 1}`)
);
const VALID_DEVICE_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_DEVICE_ID = 'tablet-main';

// Cooldown per-device (non globale) così due tablet non si blocchino a vicenda.
const lastPushAtByDevice = new Map();
const PUSH_COOLDOWN_MS = 500;

// Device registry. Map<deviceId, { firstSeen, lastSeen, lastPull, lastAck,
//   pulls, acksOk, acksFailed }>
const deviceRegistry = new Map();
const DEVICE_OFFLINE_MS = 15_000; // considero offline dopo 15s senza pull

// Storico ultimi 50 comandi consumati (globale, con deviceId dentro).
const commandHistory = [];
const MAX_HISTORY = 50;

function touchDevice(deviceId, kind) {
  const now = Date.now();
  let d = deviceRegistry.get(deviceId);
  if (!d) {
    d = {
      deviceId,
      firstSeen: now,
      lastSeen: now,
      lastPull: null,
      lastAck: null,
      pulls: 0,
      acksOk: 0,
      acksFailed: 0,
    };
    deviceRegistry.set(deviceId, d);
  }
  d.lastSeen = now;
  if (kind === 'pull') { d.lastPull = now; d.pulls++; }
  if (kind === 'ack-ok') { d.lastAck = now; d.acksOk++; }
  if (kind === 'ack-failed') { d.lastAck = now; d.acksFailed++; }
}

function getQueue(deviceId) {
  if (!commandQueues.has(deviceId)) commandQueues.set(deviceId, []);
  return commandQueues.get(deviceId);
}

/**
 * POST /command/push
 * Body: { channel, deviceId?, lockerId?, pin?, source? }
 * Se deviceId non specificato → "tablet-main" (back-compat).
 */
app.post('/command/push', requireApiKey, (req, res) => {
  const { channel, deviceId, lockerId, pin, source } = req.body || {};
  if (!channel || !VALID_CHANNELS.has(channel)) {
    return res.status(400).json({
      success: false,
      error: 'channel richiesto: CH1..CH12',
    });
  }
  const device = deviceId || DEFAULT_DEVICE_ID;
  if (!VALID_DEVICE_ID.test(device)) {
    return res.status(400).json({
      success: false,
      error: 'deviceId non valido (a-z A-Z 0-9 _ - 1..64 char)',
    });
  }
  const now = Date.now();
  const lastForDev = lastPushAtByDevice.get(device) || 0;
  if (now - lastForDev < PUSH_COOLDOWN_MS) {
    return res.status(429).json({
      success: false,
      error: `Cooldown ${PUSH_COOLDOWN_MS}ms anti-raffica per ${device}`,
    });
  }
  lastPushAtByDevice.set(device, now);

  const cmd = {
    id: `cmd-${now}-${Math.random().toString(36).slice(2, 7)}`,
    channel,
    deviceId: device,
    lockerId: lockerId || null,
    pin: pin || null,
    source: source || 'web',
    pushedAt: new Date(now).toISOString(),
  };
  const q = getQueue(device);
  q.push(cmd);
  if (q.length > MAX_QUEUE_PER_DEVICE) q.shift();

  console.log(
    `📤 [command/push] ${channel} → ${device} · src=${cmd.source} · queue=${q.length}`
  );
  // Audit (non-blocking)
  logAuditEvent({
    event_type: 'command_push',
    actor: cmd.source,
    subject: device,
    result: 'info',
    message: `${channel} queued for ${device}`,
    metadata: { channel, lockerId: cmd.lockerId, cmdId: cmd.id },
  });
  res.json({ success: true, queued: cmd, queueLength: q.length });
});

/**
 * GET /command/pull?deviceId=xyz
 * Il tablet specifica chi è. Serve il suo comando in testa alla coda.
 * Aggiorna anche lastSeen (usato da /devices per stato online/offline).
 */
app.get('/command/pull', requireApiKey, (req, res) => {
  const device = (req.query.deviceId || DEFAULT_DEVICE_ID).toString();
  if (!VALID_DEVICE_ID.test(device)) {
    return res.status(400).json({ command: null, error: 'deviceId non valido' });
  }
  touchDevice(device, 'pull');
  const q = getQueue(device);
  if (q.length === 0) {
    return res.json({ command: null });
  }
  const cmd = q.shift();
  const consumed = {
    ...cmd,
    pulledAt: new Date().toISOString(),
  };
  commandHistory.unshift(consumed);
  if (commandHistory.length > MAX_HISTORY) commandHistory.pop();
  console.log(`📥 [command/pull] ${device} ha consumato ${cmd.channel}`);
  // Audit + persist device state (non-blocking)
  logAuditEvent({
    event_type: 'command_pull',
    actor: device,
    subject: cmd.lockerId,
    result: 'info',
    message: `${device} pulled ${cmd.channel}`,
    metadata: { channel: cmd.channel, cmdId: cmd.id },
  });
  persistDeviceState(device);
  res.json({ command: consumed });
});

/**
 * GET /command/status
 * Stato globale: code per-device + history recente + devices noti.
 */
app.get('/command/status', requireApiKey, (req, res) => {
  const queues = {};
  for (const [dev, q] of commandQueues.entries()) queues[dev] = q;
  res.json({
    queues,
    history: commandHistory.slice(0, 20),
    devices: Array.from(deviceRegistry.values()).map(snapshotDevice),
  });
});

/**
 * POST /command/ack
 * Tablet conferma esito reale. Body:
 *   { id, channel, deviceId, result: "success"|"failed"|"invalid", message? }
 */
app.post('/command/ack', requireApiKey, (req, res) => {
  const { id, channel, deviceId, result, message } = req.body || {};
  const device = deviceId || DEFAULT_DEVICE_ID;
  const ok = result === 'success';
  touchDevice(device, ok ? 'ack-ok' : 'ack-failed');
  console.log(
    `${ok ? '✅' : '❌'} [command/ack] ${device} · ${channel || id} · ${result || 'ok'} · ${message || ''}`
  );
  // Audit + persist (non-blocking)
  logAuditEvent({
    event_type: 'command_ack',
    actor: device,
    subject: channel,
    result: ok ? 'success' : 'failed',
    message: message || null,
    metadata: { cmdId: id, channel },
  });
  persistDeviceState(device);
  res.json({ success: true });
});

/**
 * GET /devices
 * Ritorna la lista di tutti i tablet che si sono collegati almeno una volta,
 * con lo stato online/offline calcolato dall'ultimo pull.
 */
app.get('/devices', (req, res) => {
  res.json({
    devices: Array.from(deviceRegistry.values()).map(snapshotDevice),
  });
});

function snapshotDevice(d) {
  const now = Date.now();
  const age = d.lastSeen ? now - d.lastSeen : null;
  return {
    deviceId: d.deviceId,
    online: age !== null && age < DEVICE_OFFLINE_MS,
    lastSeenMs: age,
    firstSeen: new Date(d.firstSeen).toISOString(),
    lastSeen: d.lastSeen ? new Date(d.lastSeen).toISOString() : null,
    lastPull: d.lastPull ? new Date(d.lastPull).toISOString() : null,
    lastAck: d.lastAck ? new Date(d.lastAck).toISOString() : null,
    pulls: d.pulls,
    acksOk: d.acksOk,
    acksFailed: d.acksFailed,
    queued: (commandQueues.get(d.deviceId) || []).length,
  };
}

/**
 * POST /audit/log
 * Permette a frontend / tablet di registrare un evento nel DB (persistente).
 * Se Supabase non configurata ritorna success:false ma non 500.
 * Protetto da API key (se configurata).
 */
app.post('/audit/log', requireApiKey, async (req, res) => {
  if (!SUPABASE_CONFIGURED) {
    return res.json({ success: false, persisted: false, reason: 'supabase-not-configured' });
  }
  const { event_type, actor, subject, result, message, metadata } = req.body || {};
  if (!event_type) {
    return res.status(400).json({ success: false, error: 'event_type required' });
  }
  await logAuditEvent({ event_type, actor, subject, result, message, metadata });
  res.json({ success: true, persisted: true });
});

/**
 * GET /audit/logs?limit=100&eventType=command_ack&since=2026-05-01
 * Legge gli eventi persistenti. Protetto da API key.
 * NOTA: in futuro, sostituire API key con JWT Supabase + role-check admin.
 */
app.get('/audit/logs', requireApiKey, async (req, res) => {
  if (!SUPABASE_CONFIGURED) {
    return res.json({ events: [], reason: 'supabase-not-configured' });
  }
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const eventType = req.query.eventType;
    const since = req.query.since;
    let q = supabase
      .from('audit_events')
      .select('*')
      .order('ts', { ascending: false })
      .limit(limit);
    if (eventType) q = q.eq('event_type', eventType);
    if (since) q = q.gte('ts', since);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ events: data || [] });
  } catch (err) {
    console.error('[audit/logs] error:', err.message || err);
    res.status(500).json({ error: 'Failed to read audit logs' });
  }
});

// Health check endpoint (utile per Render per verificare che il server sia vivo)
app.get('/health', (req, res) => {
  let totalQueued = 0;
  for (const q of commandQueues.values()) totalQueued += q.length;
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    queuedCommands: totalQueued,
    knownDevices: deviceRegistry.size,
  });
});

/**
 * 1. POST /generate-booking
 * Chiamato dall'App Utente o Web Dashboard per creare una prenotazione
 */
app.post('/generate-booking', async (req, res) => {
  try {
    const { user_id, locker_id, duration_hours } = req.body;
    
    if (!locker_id || !duration_hours) {
      return res.status(400).json({ error: 'Missing locker_id or duration_hours' });
    }

    const pin = generatePin();
    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + duration_hours * 60 * 60 * 1000);

    const { data, error } = await supabase
      .from('bookings')
      .insert([
        {
          user_id,
          locker_id,
          start_time: startTime.toISOString(),
          end_time: endTime.toISOString(),
          pin_code: pin,
          status: 'active'
        }
      ])
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, booking: data, pin });
  } catch (err) {
    console.error('Error generating booking:', err);
    res.status(500).json({ error: 'Failed to generate booking' });
  }
});

/**
 * 2. POST /verify-pin
 * Chiamato dal dispositivo ESP32 quando l'utente inserisce il PIN fisico
 */
app.post('/verify-pin', async (req, res) => {
  try {
    const { locker_id, pin_code } = req.body;

    if (!locker_id || !pin_code) {
      return res.status(400).json({ error: 'Missing locker_id or pin_code' });
    }

    const now = new Date().toISOString();

    // Cerca prenotazioni attive per questo locker, con il PIN fornito e nel range di tempo
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('locker_id', locker_id)
      .eq('pin_code', pin_code)
      .eq('status', 'active')
      .lte('start_time', now)
      .gte('end_time', now);

    if (error) throw error;

    const isValid = bookings && bookings.length > 0;

    // Registra il tentativo nel log di accesso
    await supabase.from('access_logs').insert([
      {
        locker_id,
        result: isValid ? 'success' : 'failed_invalid_pin',
        pin_used: pin_code
      }
    ]);

    if (isValid) {
      res.json({ success: true, message: 'Access granted' });
    } else {
      res.status(403).json({ success: false, message: 'Access denied. PIN invalid or expired.' });
    }
  } catch (err) {
    console.error('Error verifying PIN:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

/**
 * 3. POST /log-access
 * Endpoint extra per registrare log di errori hardware o altro dall'ESP32
 */
app.post('/log-access', async (req, res) => {
  try {
    const { locker_id, result, pin_used } = req.body;
    
    await supabase.from('access_logs').insert([
      { locker_id, result, pin_used }
    ]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error logging access:', err);
    res.status(500).json({ error: 'Logging failed' });
  }
});

/**
 * 4. GET /lockers
 * Endpoint per la dashboard per ottenere la lista di tutti gli armadietti
 */
app.get('/lockers', async (req, res) => {
  try {
    const { data: lockers, error } = await supabase.from('lockers').select('*');
    if (error) throw error;
    res.json(lockers);
  } catch (err) {
    console.error('Error fetching lockers:', err);
    res.status(500).json({ error: 'Failed to fetch lockers' });
  }
});

// Fallback: serve index.html per qualsiasi route non trovata (SPA-style)
app.get('*', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🔒 Smart Locker Backend running on port ${PORT}`);
});
