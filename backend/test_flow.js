import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function runTest() {
  console.log("🔄 1. Creazione di un armadietto di test nel Database Supabase...");
  const { data: locker, error: lockerErr } = await supabase
    .from('lockers')
    .insert([{ location: 'Ingresso Principale', status: 'available' }])
    .select()
    .single();
  
  if (lockerErr) {
    console.error("❌ Errore creazione locker:", lockerErr);
    return;
  }
  console.log("✅ Armadietto creato con successo! ID:", locker.id);

  console.log("\n🔄 2. Chiamata API per generare una prenotazione e un PIN...");
  const bookRes = await fetch('http://localhost:3000/generate-booking', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: '00000000-0000-0000-0000-000000000000', // UUID utente fittizio
      locker_id: locker.id,
      duration_hours: 2
    })
  });
  const bookData = await bookRes.json();
  console.log("✅ Risposta API Prenotazione:");
  console.log(bookData);
  
  const generatedPin = bookData.pin;

  console.log("\n🔄 3. Simulazione ESP32: Inserimento del PIN CORRETTO...");
  const verifyRes = await fetch('http://localhost:3000/verify-pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      locker_id: locker.id,
      pin_code: generatedPin
    })
  });
  const verifyData = await verifyRes.json();
  console.log("✅ Risposta API (PIN Corretto):");
  console.log(verifyData);

  console.log("\n🔄 4. Simulazione ESP32: Inserimento di un PIN ERRATO...");
  const wrongRes = await fetch('http://localhost:3000/verify-pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      locker_id: locker.id,
      pin_code: '0000'
    })
  });
  const wrongData = await wrongRes.json();
  console.log("✅ Risposta API (PIN Errato):");
  console.log(wrongData);

  console.log("\n🎉 Test completato con successo!");
  process.exit(0);
}

runTest();
