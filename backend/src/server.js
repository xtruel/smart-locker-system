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

// Health check endpoint (utile per Render per verificare che il server sia vivo)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
