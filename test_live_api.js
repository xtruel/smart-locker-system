

const LIVE_URL = 'https://smart-locker-system-4gn6.onrender.com';
// const LIVE_URL = 'http://localhost:3000'; // Usa questo per test locali

async function runTests() {
  console.log('🚀 AVVIO TEST END-TO-END SULLA PRODUZIONE (RENDER + SUPABASE)...\n');

  try {
    // TEST 1: Get Lockers
    console.log('⏳ TEST 1: Recupero armadietti (GET /lockers)...');
    let res = await fetch(`${LIVE_URL}/lockers`);
    let lockers = await res.json();
    
    if (lockers.length === 0) {
      console.log('⚠️ Nessun armadietto trovato. Mi fermo qui. Assicurati che Supabase abbia dei record nella tabella "lockers".');
      return;
    }
    console.log(`✅ OK! Trovati ${lockers.length} armadietti.`);
    const targetLocker = lockers[0].id;
    console.log(`   ➔ Useremo l'armadietto con ID: ${targetLocker}\n`);

    // TEST 2: Generate Booking
    console.log('⏳ TEST 2: Generazione Prenotazione (POST /generate-booking)...');
    res = await fetch(`${LIVE_URL}/generate-booking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: '00000000-0000-0000-0000-000000000000',
        locker_id: targetLocker,
        duration_hours: 1
      })
    });
    const bookingData = await res.json();
    if (!bookingData.success) throw new Error('Generazione fallita');
    const validPin = bookingData.pin;
    console.log(`✅ OK! Prenotazione creata. PIN generato: [${validPin}]\n`);

    // TEST 3: Verify PIN (Fallimento Atteso)
    console.log('⏳ TEST 3: Verifica PIN Errato (POST /verify-pin)...');
    res = await fetch(`${LIVE_URL}/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locker_id: targetLocker,
        pin_code: '0000' // PIN palesemente sbagliato
      })
    });
    const failData = await res.json();
    if (failData.success === false) {
      console.log('✅ OK! Il server ha negato l\'accesso correttamente per un PIN errato.\n');
    } else {
      throw new Error('Il server ha accettato un PIN falso!');
    }

    // TEST 4: Verify PIN (Successo Atteso)
    console.log('⏳ TEST 4: Verifica PIN Corretto (POST /verify-pin)...');
    res = await fetch(`${LIVE_URL}/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locker_id: targetLocker,
        pin_code: validPin // PIN vero
      })
    });
    const successData = await res.json();
    if (successData.success === true) {
      console.log('✅ OK! Il server ha AUTORIZZATO l\'accesso con il PIN corretto!\n');
    } else {
      throw new Error('Il server ha rifiutato il PIN corretto!');
    }

    console.log('🎉 TUTTI I TEST PASSATI CON SUCCESSO!');
    console.log('Il cloud è pronto per interfacciarsi con il tablet industriale e l\'USB.');

  } catch (err) {
    console.error('❌ ERRORE DURANTE I TEST:', err.message);
  }
}

runTests();
