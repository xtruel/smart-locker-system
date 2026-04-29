const API_URL = window.location.origin;
let lockersList = [];

// Funzione chiamata al caricamento della pagina
async function fetchLockers() {
  const container = document.getElementById('lockers-container');
  const simSelect = document.getElementById('sim-locker-id');
  container.innerHTML = '<div class="text-gray-500 animate-pulse col-span-full">Caricamento armadietti...</div>';
  
  try {
    const res = await fetch(`${API_URL}/lockers`);
    lockersList = await res.json();
    
    container.innerHTML = '';
    simSelect.innerHTML = '';

    if(lockersList.length === 0) {
      container.innerHTML = '<div class="text-gray-500 col-span-full">Nessun armadietto trovato. Usa lo script di test per crearne uno.</div>';
      return;
    }

    lockersList.forEach(locker => {
      // Crea card armadietto
      const div = document.createElement('div');
      div.className = 'glass-panel locker-card p-6 rounded-2xl flex flex-col justify-between';
      div.innerHTML = `
        <div>
          <div class="flex justify-between items-start mb-4">
            <h3 class="font-bold text-lg text-white">Cella ${locker.location}</h3>
            <span class="px-2 py-1 text-xs font-semibold rounded bg-emerald-500/20 text-emerald-400">Disponibile</span>
          </div>
          <p class="text-xs text-gray-400 font-mono break-all mb-6">ID: ${locker.id}</p>
        </div>
        <button onclick="bookLocker('${locker.id}')" class="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-2 rounded-lg transition">
          Prenota Ora
        </button>
      `;
      container.appendChild(div);

      // Popola select del simulatore
      const option = document.createElement('option');
      option.value = locker.id;
      option.textContent = `Cella ${locker.location} (${locker.id.split('-')[0]}...)`;
      simSelect.appendChild(option);
    });

  } catch (error) {
    console.error(error);
    container.innerHTML = '<div class="text-red-500 col-span-full">Errore di connessione al server. Assicurati che sia avviato (npm run dev).</div>';
  }
}

// Funzione per prenotare
async function bookLocker(lockerId) {
  try {
    const res = await fetch(`${API_URL}/generate-booking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: '00000000-0000-0000-0000-000000000000', // Utente demo
        locker_id: lockerId,
        duration_hours: 2
      })
    });
    
    const data = await res.json();
    
    if(data.success) {
      document.getElementById('no-booking').classList.add('hidden');
      document.getElementById('active-booking').classList.remove('hidden');
      document.getElementById('pin-display').innerText = data.pin;

      // Pre-compila il simulatore per comodità
      document.getElementById('sim-locker-id').value = lockerId;
      document.getElementById('sim-pin').value = data.pin;
      
      // Resetta eventuali messaggi precedenti
      document.getElementById('sim-result').classList.add('hidden');
    } else {
      alert("Errore durante la prenotazione.");
    }
  } catch (error) {
    console.error(error);
    alert("Errore di connessione al server.");
  }
}

// Funzione simulatore ESP32
async function simulateEsp32() {
  const lockerId = document.getElementById('sim-locker-id').value;
  const pin = document.getElementById('sim-pin').value;
  const resultDiv = document.getElementById('sim-result');
  const btn = document.getElementById('sim-btn');
  
  if(!pin) {
    alert("Inserisci un PIN!");
    return;
  }

  // Animazione pulsante
  btn.innerText = "Verifica in corso...";
  btn.classList.add('opacity-50', 'cursor-not-allowed');

  try {
    const res = await fetch(`${API_URL}/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locker_id: lockerId,
        pin_code: pin
      })
    });
    
    const data = await res.json();
    
    resultDiv.classList.remove('hidden', 'bg-emerald-500/20', 'text-emerald-400', 'bg-red-500/20', 'text-red-400');
    
    if(data.success) {
      resultDiv.classList.add('bg-emerald-500/20', 'text-emerald-400');
      resultDiv.innerText = "🔓 ACCESSO CONSENTITO! Il relè scatta e la porta si apre.";
      
      // Reset dashboard dopo l'apertura
      setTimeout(() => {
        document.getElementById('active-booking').classList.add('hidden');
        document.getElementById('no-booking').classList.remove('hidden');
        document.getElementById('pin-display').innerText = '----';
        document.getElementById('sim-pin').value = '';
        resultDiv.classList.add('hidden');
      }, 5000);

    } else {
      resultDiv.classList.add('bg-red-500/20', 'text-red-400');
      resultDiv.innerText = "❌ ACCESSO NEGATO! PIN errato o scaduto.";
    }

  } catch (error) {
    console.error(error);
    resultDiv.classList.remove('hidden');
    resultDiv.classList.add('bg-red-500/20', 'text-red-400');
    resultDiv.innerText = "⚠️ Errore di connessione (L'ESP32 è offline o il server non risponde).";
  }

  btn.innerText = "Sblocca Armadietto";
  btn.classList.remove('opacity-50', 'cursor-not-allowed');
}

// Inizializza
window.onload = fetchLockers;
