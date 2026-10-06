# Auftrag: Zombie-Lotto (6 aus 49) in den TaxiTon-Chat einbauen

Dieses Lotto ERSETZT das Zombie-Baby-Angeln. In diesem Ordner liegen:
- `zombie-lotto.html` – das komplette Spiel (Frontend, Persisch)
- `lotto.js` – der Server-Teil (Express-Routen unter /api/lotto/...)

## Wichtig
- Übernimm beide Dateien 1:1. Ändere NICHTS am Design, an Texten, Bildern, Animationen, Farben, Gewinnen oder Zeiten.
- Nichts nachbauen oder umschreiben, nur einbinden.
- Die Ziehung passiert ausschließlich auf dem Server (lotto.js). Diese Logik nicht in den Client verschieben.

## Schritte
1. Falls das Angel-Spiel schon eingebaut ist: `registerFishing(...)`, die Route `/angeln`, `fishing.js`, `zombie-angeln.html` und den Button/Menüpunkt dazu entfernen.
2. `lotto.js` neben `server.js` legen, `zombie-lotto.html` in den Ordner der statischen Dateien (z.B. `public/`).
3. In `server.js` nach `app.use(express.json())` einbinden:

```js
const registerLotto = require('./lotto');
registerLotto(app, {
  botToken: process.env.BOT_TOKEN, // derselbe Bot-Token wie bei der Mini-App
  credit: async (telegramUserId, currency, amount, meta) => {
    // HIER die bestehende Balance-Funktion des Projekts aufrufen.
    // currency ist 'TON' oder 'TT', amount eine Zahl (z.B. 0.05).
    // telegramUserId ist die Telegram-User-ID als String.
  },
});
app.get('/lotto', (req, res) =>
  res.sendFile(require('path').join(__dirname, 'public', 'zombie-lotto.html')));
```

4. Suche die vorhandene Funktion, mit der TON- und TT-Balance gutgeschrieben wird (wie bei den anderen Spielen), und rufe sie in `credit` auf. Gibt es keine, frag mich, bevor du eine neue Balance-Logik erfindest.
5. Füge im Chat / in der Mini-App einen Einstieg zum Spiel hinzu (Button oder Menüpunkt wie bei den anderen Spielen), der `/lotto` öffnet. Das Spiel muss als Telegram-WebApp geöffnet werden, sonst läuft es nur im Demo-Modus.
6. Die Mini-App läuft über https://taxiton.org/ – das Spiel muss dort unter https://taxiton.org/lotto erreichbar sein.

## Test
- `/lotto` im Browser öffnen → Demo-Modus mit Banner (richtig so ohne Telegram).
- In Telegram öffnen → kein Demo-Banner, 6 Zahlen wählen, Tipp abgeben, Ziehung abwarten, Balance prüfen.
- Server-Log: jede Ziehung erscheint als `[lotto] Ziehung ...`, Fehler bei der Gutschrift als `[lotto] credit FAILED`.

Sag mir am Ende, welche Dateien du geändert hast und welche Balance-Funktion du verwendet hast.
