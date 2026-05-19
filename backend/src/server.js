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

// ============================================================================
// CORS — whitelist invece di wildcard *
// ============================================================================
// Origini permesse: dominio frontend produzione + localhost per dev.
// La env var CORS_EXTRA_ORIGINS permette aggiungere domini al volo
// (es. anteprime Render, CI, staging), formato: "https://a.com,https://b.com".
// ============================================================================
const DEFAULT_ALLOWED_ORIGINS = [
  'https://cyber-lock-charm.onrender.com',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
];
const EXTRA_ORIGINS = (process.env.CORS_EXTRA_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOWED_ORIGINS = new Set([...DEFAULT_ALLOWED_ORIGINS, ...EXTRA_ORIGINS]);

app.use(
  cors({
    origin: (origin, cb) => {
      // origin null = stessa origine (server-to-server, curl) → permesso
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
      console.warn(`[cors] origine bloccata: ${origin}`);
      return cb(new Error('CORS: origine non permessa'));
    },
    credentials: false,
  })
);
app.use(express.json());

// ============================================================================
// RATE LIMIT — protezione anti brute-force / abuso
// ============================================================================
// In-memory sliding window per IP. Non sopravvive a riavvio Render (free
// tier cold start ogni ~15 min) ma e' sufficiente come barriera anti-script
// senza dipendenze extra. Per produzione serie sostituire con Redis.
// ============================================================================
const rateLimitHits = new Map(); // key="ip|bucket" → array<ts>
function rateLimit(bucket, maxPerMinute) {
  return (req, res, next) => {
    const ip = (
      req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      'unknown'
    );
    const key = `${ip}|${bucket}`;
    const now = Date.now();
    const windowStart = now - 60_000;
    const hits = (rateLimitHits.get(key) || []).filter((t) => t > windowStart);
    if (hits.length >= maxPerMinute) {
      console.warn(`[rate-limit] ${ip} ha superato ${maxPerMinute}/min su ${bucket}`);
      return res.status(429).json({
        success: false,
        error: `Troppe richieste. Riprova fra qualche secondo.`,
      });
    }
    hits.push(now);
    rateLimitHits.set(key, hits);
    next();
  };
}
// Cleanup periodico per non far crescere la Map
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [k, arr] of rateLimitHits.entries()) {
    const kept = arr.filter((t) => t > cutoff);
    if (kept.length === 0) rateLimitHits.delete(k);
    else rateLimitHits.set(k, kept);
  }
}, 60_000).unref?.();

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
 *
 * SICUREZZA — verifica PIN server-side:
 *   - source="customer-unlock" → PIN obbligatorio, validato su Supabase
 *     contro una booking attiva per quel locker. PIN errato/scaduto = 403.
 *   - source admin/test/release → bypass (chi opera in console e' gia'
 *     autenticato e ha gia' verificato lo stato locker).
 */
app.post('/command/push', rateLimit('push', 60), requireApiKey, async (req, res) => {
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

  // Verifica PIN per richieste customer. Se Supabase non e' configurato
  // fallback permissivo (dev mode) ma logga l'evento.
  const requirePinCheck = (source || 'web') === 'customer-unlock';
  // Effective channel + device: il client puo' suggerirli, ma in
  // customer-unlock la verita' viene dal DB. In test/admin usiamo
  // quelli del client.
  let effectiveChannel = channel;
  let effectiveDevice = device;
  if (requirePinCheck) {
    if (!pin || !lockerId) {
      return res.status(400).json({
        success: false,
        error: 'pin e lockerId obbligatori per customer-unlock',
      });
    }
    if (!SUPABASE_CONFIGURED) {
      console.warn('[command/push] customer-unlock con Supabase non configurato — accetto in dev mode');
    } else {
      const nowIso = new Date().toISOString();
      const { data: bookings, error: bErr } = await supabase
        .from('bookings')
        .select('id, status, start_time, end_time')
        .eq('locker_id', lockerId)
        .eq('pin_code', pin)
        .eq('status', 'active')
        .lte('start_time', nowIso)
        .gte('end_time', nowIso);
      if (bErr) {
        console.error('[command/push] verify-pin db error:', bErr.message || bErr);
        return res.status(500).json({ success: false, error: 'PIN verification failed' });
      }
      if (!bookings || bookings.length === 0) {
        logAuditEvent({
          event_type: 'command_push_denied',
          actor: 'customer-unlock',
          subject: lockerId,
          result: 'failed',
          message: 'PIN invalid or expired',
          metadata: { channel, pin },
        });
        await supabase.from('access_logs').insert([{
          locker_id: lockerId,
          result: 'failed_invalid_pin',
          pin_used: pin,
        }]);
        return res.status(403).json({
          success: false,
          error: 'PIN non valido o prenotazione scaduta',
        });
      }
      // Override channel/device dal DB (single source of truth). Query
      // separata per essere tolleranti al cache di PostgREST quando si
      // aggiungono colonne nuove a lockers.
      try {
        const { data: lk } = await supabase
          .from('lockers')
          .select('channel, device_id')
          .eq('id', lockerId)
          .maybeSingle();
        if (lk?.channel && VALID_CHANNELS.has(lk.channel)) {
          effectiveChannel = lk.channel;
        }
        if (lk?.device_id && VALID_DEVICE_ID.test(lk.device_id)) {
          effectiveDevice = lk.device_id;
        }
      } catch (e) {
        console.warn('[command/push] no channel column yet, fallback to client value');
      }
    }
  }

  const now = Date.now();
  const lastForDev = lastPushAtByDevice.get(effectiveDevice) || 0;
  if (now - lastForDev < PUSH_COOLDOWN_MS) {
    return res.status(429).json({
      success: false,
      error: `Cooldown ${PUSH_COOLDOWN_MS}ms anti-raffica per ${effectiveDevice}`,
    });
  }
  lastPushAtByDevice.set(effectiveDevice, now);

  const cmd = {
    id: `cmd-${now}-${Math.random().toString(36).slice(2, 7)}`,
    channel: effectiveChannel,
    deviceId: effectiveDevice,
    lockerId: lockerId || null,
    pin: pin || null,
    source: source || 'web',
    pushedAt: new Date(now).toISOString(),
  };
  const q = getQueue(effectiveDevice);
  q.push(cmd);
  if (q.length > MAX_QUEUE_PER_DEVICE) q.shift();

  console.log(
    `📤 [command/push] ${effectiveChannel} → ${effectiveDevice} · src=${cmd.source} · queue=${q.length}`
  );
  logAuditEvent({
    event_type: 'command_push',
    actor: cmd.source,
    subject: effectiveDevice,
    result: 'info',
    message: `${effectiveChannel} queued for ${effectiveDevice}`,
    metadata: { channel: effectiveChannel, lockerId: cmd.lockerId, cmdId: cmd.id },
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
app.post('/verify-pin', rateLimit('verify', 30), async (req, res) => {
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

// ============================================================================
// CUSTOMER ENDPOINTS — Portale clienti finali
// ============================================================================
// Design note: Supabase Auth gestisce email+password (tramite GoTrue REST).
// Il frontend cliente si autentica direttamente con Supabase e ottiene un
// access_token JWT che invia in Authorization: Bearer <token> ad ogni
// chiamata ai nostri endpoint protetti. Noi validiamo il JWT chiamando
// l'endpoint /auth/v1/user di Supabase (che riconosce la anon key + token).
// ============================================================================

/**
 * Valida un JWT Supabase estraendo l'utente. Ritorna null se non valido.
 * Cache-less (per semplicita'); accettabile perche' le chiamate customer
 * sono poche e non time-critical.
 */
async function resolveSupabaseUser(req) {
  const auth = req.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  if (!process.env.SUPABASE_URL) return null;
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Middleware: richiede utente autenticato. Popola req.user. */
async function requireUser(req, res, next) {
  const user = await resolveSupabaseUser(req);
  if (!user || !user.id) {
    return res.status(401).json({ error: 'Unauthorized: JWT mancante o scaduto' });
  }
  req.user = user;
  next();
}

/** Middleware: richiede ruolo (admin|operator). Usa user_roles dal DB. */
function requireRole(allowed) {
  return async (req, res, next) => {
    const user = await resolveSupabaseUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const { data, error } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) throw error;
      const role = data?.role || 'customer';
      if (!allowed.includes(role)) {
        return res.status(403).json({ error: `Ruolo ${role} non autorizzato` });
      }
      req.user = user;
      req.role = role;
      next();
    } catch (err) {
      console.error('[requireRole]', err);
      return res.status(500).json({ error: 'Role check failed' });
    }
  };
}

/**
 * POST /customer/register
 * Body: { email, password, full_name? }
 * Crea un utente Supabase Auth + assegna role='customer' in user_roles.
 * Se Supabase Auth non configurato, ritorna 503 (feature non disponibile).
 */
app.post('/customer/register', async (req, res) => {
  const { email, password, full_name } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email e password richiesti' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(503).json({
      error: 'Registrazione non disponibile: Supabase non configurato',
    });
  }
  try {
    // Crea utente auth con admin API (auto-confirmed per semplicita' demo)
    const createRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: full_name ? { full_name } : undefined,
      }),
    });
    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({}));
      return res.status(400).json({
        error: err.msg || err.error || `Registrazione fallita (HTTP ${createRes.status})`,
      });
    }
    const newUser = await createRes.json();
    // Assegna ruolo customer (best-effort, la tabella potrebbe non esistere in dev)
    try {
      await supabase
        .from('user_roles')
        .upsert({ user_id: newUser.id, role: 'customer' }, { onConflict: 'user_id' });
    } catch {
      /* ignore */
    }
    logAuditEvent({
      event_type: 'customer_register',
      actor: email,
      subject: newUser.id,
      result: 'success',
      message: `New customer registered: ${email}`,
    });
    return res.json({ success: true, user: { id: newUser.id, email: newUser.email } });
  } catch (err) {
    console.error('[customer/register]', err);
    return res.status(500).json({ error: 'Registrazione fallita' });
  }
});

/**
 * GET /customer/lockers/available
 * Elenco celle disponibili (status='available'). Pubblico: serve per la
 * landing customer senza login. In futuro filtrare per site/zone.
 */
app.get('/customer/lockers/available', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('lockers')
      .select('id, location, status')
      .eq('status', 'available');
    if (error) throw error;
    res.json({ lockers: data || [] });
  } catch (err) {
    console.error('[customer/lockers/available]', err);
    res.status(500).json({ error: 'Failed to fetch lockers' });
  }
});

/**
 * POST /customer/book
 * Body: { locker_id, duration_hours }
 * Crea booking per l'utente loggato. Ritorna PIN.
 * Richiede JWT Supabase valido.
 */
app.post('/customer/book', requireUser, async (req, res) => {
  const { locker_id, duration_hours } = req.body || {};
  if (!locker_id || !duration_hours) {
    return res.status(400).json({ error: 'locker_id e duration_hours richiesti' });
  }
  const hrs = Math.min(Math.max(parseFloat(duration_hours) || 0, 0.5), 48);
  if (hrs <= 0) return res.status(400).json({ error: 'duration_hours non valida' });

  try {
    const pin = generatePin();
    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + hrs * 60 * 60 * 1000);

    const { data, error } = await supabase
      .from('bookings')
      .insert([
        {
          user_id: req.user.id,
          locker_id,
          start_time: startTime.toISOString(),
          end_time: endTime.toISOString(),
          pin_code: pin,
          status: 'active',
        },
      ])
      .select()
      .single();
    if (error) throw error;

    logAuditEvent({
      event_type: 'customer_book',
      actor: req.user.email,
      subject: locker_id,
      result: 'success',
      message: `Customer booked locker for ${hrs}h`,
      metadata: { bookingId: data.id, pin },
    });

    res.json({ success: true, booking: data, pin });
  } catch (err) {
    console.error('[customer/book]', err);
    res.status(500).json({ error: 'Booking failed' });
  }
});

/**
 * GET /customer/bookings
 * Ritorna le prenotazioni dell'utente loggato (active + history).
 */
app.get('/customer/bookings', requireUser, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bookings')
      .select('*, lockers(location)')
      .eq('user_id', req.user.id)
      .order('start_time', { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json({ bookings: data || [] });
  } catch (err) {
    console.error('[customer/bookings]', err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

/**
 * POST /customer/bookings/:id/cancel
 * Cancella una prenotazione attiva dell'utente. Solo il proprietario.
 */
app.post('/customer/bookings/:id/cancel', requireUser, async (req, res) => {
  const { id } = req.params;
  try {
    // Verifica ownership
    const { data: b, error: e1 } = await supabase
      .from('bookings')
      .select('user_id, status')
      .eq('id', id)
      .maybeSingle();
    if (e1) throw e1;
    if (!b) return res.status(404).json({ error: 'Booking non trovata' });
    if (b.user_id !== req.user.id) return res.status(403).json({ error: 'Non autorizzato' });
    if (b.status !== 'active') return res.status(400).json({ error: 'Booking gia\' chiusa' });

    const { error } = await supabase
      .from('bookings')
      .update({ status: 'cancelled' })
      .eq('id', id);
    if (error) throw error;
    logAuditEvent({
      event_type: 'customer_cancel',
      actor: req.user.email,
      subject: id,
      result: 'success',
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[customer/bookings/:id/cancel]', err);
    res.status(500).json({ error: 'Cancel failed' });
  }
});

// ============================================================================
// ADMIN ENDPOINTS — protetti da ruolo admin via JWT
// ============================================================================

/** GET /admin/bookings — tutte le prenotazioni. */
app.get('/admin/bookings', requireRole(['admin', 'operator']), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bookings')
      .select('*, lockers(location), users:user_id')
      .order('start_time', { ascending: false })
      .limit(500);
    if (error) throw error;
    res.json({ bookings: data || [] });
  } catch (err) {
    console.error('[admin/bookings]', err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// ============================================================================
// RESERVATION LOOKUP — codice LCK pubblico per cliente (no login)
// ============================================================================
// Il codice "LCK-XXXX" e' derivato dal booking.id (UUID): si prendono gli
// ultimi 4 char esadecimali e si maiuscolizzano. E' una proiezione stateless
// del booking — niente migrazione DB. In futuro, se serve un codice
// completamente disaccoppiato (Nayax voucher, ecc.), si aggiunge una colonna
// reservation_code e si modifica la lookup.
// ============================================================================

const RESERVATION_CODE_RE = /^LCK-[A-F0-9]{4}$/i;

/**
 * GET /reservation/:code
 * Ritorna la prenotazione che termina con quel suffix. Se ci sono collisioni
 * (raro, 1 su 65535) prende la piu' recente attiva. Endpoint pubblico —
 * la "sicurezza" e' che servono i 4 hex giusti.
 */
app.get('/reservation/:code', rateLimit('reservation', 20), async (req, res) => {
  const code = (req.params.code || '').trim().toUpperCase();
  if (!RESERVATION_CODE_RE.test(code)) {
    return res.status(400).json({ error: 'Codice non valido. Formato: LCK-XXXX' });
  }
  if (!SUPABASE_CONFIGURED) {
    return res.status(503).json({ error: 'Database non configurato' });
  }
  const suffix = code.slice(4).toLowerCase();
  try {
    // Cerca tutte le bookings il cui id finisce col suffix.
    // Postgres ilike '%xxxx' su UUID ::text. Limit 5, ordina per piu' recente.
    // Usiamo una funzione SQL helper perche' ILIKE su colonna UUID richiede
    // cast a text (non supportato direttamente da PostgREST/supabase-js).
    // La funzione find_booking_by_code(text) fa SELECT ... WHERE id::text
    // ILIKE '%suffix'.
    const { data, error } = await supabase.rpc('find_booking_by_code', {
      code_suffix: suffix,
    });
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Prenotazione non trovata' });
    }
    const b = data.find(x => x.status === 'active') || data[0];

    // Lookup locker separato — tollerante se colonne non esistono ancora
    let lockerLocation = null;
    let lockerChannel = null;
    let lockerDeviceId = null;
    try {
      const { data: lk } = await supabase
        .from('lockers')
        .select('location, channel, device_id')
        .eq('id', b.locker_id)
        .maybeSingle();
      if (lk) {
        lockerLocation = lk.location || null;
        lockerChannel = lk.channel || null;
        lockerDeviceId = lk.device_id || null;
      }
    } catch (e) {
      // Probabile colonna non esistente — fallback su solo location
      try {
        const { data: lk2 } = await supabase
          .from('lockers')
          .select('location')
          .eq('id', b.locker_id)
          .maybeSingle();
        if (lk2) lockerLocation = lk2.location || null;
      } catch { /* ignore */ }
    }

    res.json({
      reservation_code: code,
      booking_id: b.id,
      locker_id: b.locker_id,
      locker_location: lockerLocation,
      locker_channel: lockerChannel,
      locker_device_id: lockerDeviceId,
      pin_code: b.pin_code,
      start_time: b.start_time,
      end_time: b.end_time,
      status: b.status,
    });
  } catch (err) {
    console.error('[reservation/:code]', err);
    res.status(500).json({ error: 'Lookup fallita' });
  }
});

// ============================================================================
// NAYAX WEBHOOK — placeholder per integrazione futura
// ============================================================================
// Quando il cliente di Eugenio sistemera' Nayax, qui arriveranno i webhook
// di conferma pagamento. Per ora accetta qualunque payload, logga, e
// risponde 200 (cosi' Nayax non riprova). La logica di creazione booking
// + PIN andra' qui.
// ============================================================================
app.post('/nayax/webhook', async (req, res) => {
  console.log('[nayax/webhook] payload ricevuto:', JSON.stringify(req.body || {}));
  logAuditEvent({
    event_type: 'nayax_webhook',
    actor: 'nayax',
    result: 'info',
    message: 'Webhook ricevuto (placeholder, nessuna azione)',
    metadata: { body: req.body || {} },
  });
  // TODO: validare firma Nayax, creare booking, generare PIN+codice LCK,
  //       inviare email/SMS al cliente.
  res.status(200).json({ received: true });
});

// Fallback: serve index.html per qualsiasi route non trovata (SPA-style)
app.get('*', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🔒 Smart Locker Backend running on port ${PORT}`);
});
