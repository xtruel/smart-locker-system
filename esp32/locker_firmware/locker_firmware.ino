#include <WiFi.h>
#include <HTTPClient.h>
#include <Keypad.h>
#include <ArduinoJson.h> // Assicurati di installare questa libreria (versione 6.x o 7.x)

// ================= IMPOSTAZIONI =================
const char* ssid = "IL_TUO_WIFI";
const char* password = "LA_TUA_PASSWORD_WIFI";
// L'IP del tuo server backend Node.js, es: http://192.168.1.100:3000/verify-pin
const char* backendUrl = "https://smart-locker-system-4gn6.onrender.com/verify-pin";

// L'ID del locker deve corrispondere esattamente all'UUID su Supabase
const String lockerId = "INSERISCI-UUID-DEL-LOCKER-QUI";

const int RELAY_PIN = 26; // Pin che controlla il relè della serratura
const int UNLOCK_DURATION = 5000; // Tempo di apertura in millisecondi (5 secondi)

// ================= KEYPAD SETUP (4x4) =================
const byte ROWS = 4;
const byte COLS = 4;
char keys[ROWS][COLS] = {
  {'1','2','3','A'},
  {'4','5','6','B'},
  {'7','8','9','C'},
  {'*','0','#','D'}
};
// Connetti le righe ai pin seguenti (modifica in base al tuo cablaggio)
byte rowPins[ROWS] = {19, 18, 5, 17};
// Connetti le colonne ai pin seguenti (modifica in base al tuo cablaggio)
byte colPins[COLS] = {16, 4, 2, 15};
Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, ROWS, COLS);

String inputPin = "";

void setup() {
  Serial.begin(115200);
  
  // Setup Relè
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW); // Di default la serratura è chiusa

  // Connessione WiFi
  WiFi.begin(ssid, password);
  Serial.print("Connessione al WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nConnesso al WiFi con IP: ");
  Serial.println(WiFi.localIP());
}

void loop() {
  char key = keypad.getKey();

  if (key) {
    Serial.print("Tasto premuto: ");
    Serial.println(key);

    if (key == '#') {
      // '#' = Invio (Conferma PIN)
      if(inputPin.length() > 0) {
        Serial.println("Invio PIN al backend: " + inputPin);
        verifyPin(inputPin);
        inputPin = ""; // Reset dopo l'invio
      }
    } else if (key == '*') {
      // '*' = Cancella
      inputPin = "";
      Serial.println("PIN cancellato.");
    } else {
      inputPin += key;
      // Limitiamo la lunghezza del PIN a 8 caratteri per sicurezza
      if (inputPin.length() > 8) {
        inputPin = "";
        Serial.println("PIN troppo lungo, resettato.");
      }
    }
  }
}

// Funzione per validare il PIN contattando il Backend Node.js
void verifyPin(String pin) {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(backendUrl);
    http.addHeader("Content-Type", "application/json");

    // Creazione del payload JSON in modo sicuro con ArduinoJson
    StaticJsonDocument<200> doc;
    doc["locker_id"] = lockerId;
    doc["pin_code"] = pin;
    
    String jsonPayload;
    serializeJson(doc, jsonPayload);

    // Invio richiesta POST
    int httpResponseCode = http.POST(jsonPayload);

    if (httpResponseCode > 0) {
      String response = http.getString();
      Serial.print("Codice Risposta HTTP: ");
      Serial.println(httpResponseCode);
      
      // Controllo semplice della stringa di risposta. 
      // Se c'è "success":true, apri!
      if (response.indexOf("\"success\":true") >= 0) {
        Serial.println("ACCESSO CONSENTITO! Sblocco in corso...");
        unlockLocker();
      } else {
        Serial.println("ACCESSO NEGATO! PIN errato o scaduto.");
      }
    } else {
      Serial.print("Errore nella richiesta HTTP: ");
      Serial.println(httpResponseCode);
    }
    http.end();
  } else {
    Serial.println("Errore: WiFi disconnesso!");
  }
}

// Funzione che pilota il relè per aprire fisicamente l'armadietto
void unlockLocker() {
  digitalWrite(RELAY_PIN, HIGH); // Attiva il relè (Sblocca)
  delay(UNLOCK_DURATION);
  digitalWrite(RELAY_PIN, LOW);  // Disattiva il relè (Blocca)
  Serial.println("Armadietto bloccato di nuovo.");
}
