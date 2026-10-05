# Auftrag: Zombie-Baby-Angeln in den TaxiTon-Chat einbauen

In diesem Ordner liegen zwei fertige Dateien:
- `zombie-angeln.html` – das komplette Spiel (Frontend, Persisch, Bilder sind eingebettet)
- `fishing.js` – der Server-Teil (Express-Routen unter /api/fishing/...)

## Wichtig
- Übernimm beide Dateien 1:1. Ändere NICHTS am Design, an Texten, Bildern, Animationen, Farben, Chancen oder Gewinnen.
- Baue das Spiel nicht nach und schreibe es nicht um. Nur einbinden.
- Die Gewinne werden ausschließlich auf dem Server ausgelost (fishing.js). Diese Logik nicht in den Client verschieben.

## Schritte
1. `fishing.js` neben `server.js` legen.
2. `zombie-angeln.html` in den Ordner legen, aus dem die Mini-App ihre statischen Dateien ausliefert (z.B. `public/`).
3. In `server.js` nach der Erstellung von `app` (und nach `express.json()`) einbinden:

```js
const registerFishing = require('./fishing');
registerFishing(app, {
  botToken: process.env.BOT_TOKEN, // denselben Bot-Token nehmen, mit dem die Mini-App geöffnet wird
  credit: async (telegramUserId, currency, amount, meta) => {
    // HIER die bestehende Balance-Funktion des Projekts aufrufen.
    // currency ist 'TT' oder 'TON', amount eine Zahl (z.B. 250 oder 0.5).
    // telegramUserId ist die Telegram-User-ID als String.
    // Optional: neue Balance zurückgeben.
  },
});
app.get('/angeln', (req, res) =>
  res.sendFile(require('path').join(__dirname, 'public', 'zombie-angeln.html')));
```

4. Suche im Projekt die vorhandene Funktion, mit der TT- und TON-Balance gutgeschrieben wird (so wie bei den anderen Spielen, z.B. Boss Fight), und rufe sie in `credit` auf. Wenn es dafür keine Funktion gibt, frag mich, bevor du eine neue Balance-Logik erfindest.
5. Füge im Chat / in der Mini-App einen Einstieg zum Spiel hinzu (Button oder Menüpunkt wie bei den anderen Spielen), der `/angeln` öffnet. Das Spiel muss als Telegram-WebApp geöffnet werden, damit `Telegram.WebApp.initData` vorhanden ist – sonst läuft es nur im Demo-Modus.
6. Die Tageszähler in `fishing.js` liegen standardmäßig nur im Arbeitsspeicher (nach Railway-Neustart weg). Wenn das Projekt eine Datenbank hat, übergib `registerFishing` eine `store`-Option mit diesen Funktionen, gespeichert in der DB:
   - `getUser(uid, day)` → `{ catches, tonWins }` (Standard `{ catches: 0, tonWins: 0 }`)
   - `saveUser(uid, day, data)`
   - `getGlobal(day)` → `{ tonPaid }` (Standard `{ tonPaid: 0 }`)
   - `saveGlobal(day, data)`

## Test
- `/angeln` im Browser öffnen → Demo-Modus mit Banner (richtig so, ohne Telegram).
- In Telegram öffnen → kein Demo-Banner, Angel werfen, nach 15 Sek. Ergebnis, Balance prüfen.
- Server-Log: bei Fehlern erscheint `[fishing] credit FAILED` mit User und Gewinn.

Sag mir am Ende, welche Dateien du geändert hast und welche Balance-Funktion du verwendet hast.
