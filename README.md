# Coin Runner 3D — Economy Server

Verwaltet Coins & TON-Guthaben serverseitig. Keine externen Pakete nötig —
läuft mit nacktem Node.js.

## 1. Server starten

```bash
export BOT_TOKEN="123456:dein-echter-telegram-bot-token"
export SESSION_SECRET="ein-langer-zufälliger-string"
export PORT=8787   # optional, Standard ist 8787
node server.js
```

Die Daten liegen danach in `data/users.json` (wird automatisch angelegt).

## 2. Server irgendwo hosten

Jeder Ort, an dem `node server.js` laufen kann, reicht: z. B. ein kleiner
VPS (Hetzner, DigitalOcean, Contabo …), Railway, Render, Fly.io. Wichtig:
die Umgebungsvariablen `BOT_TOKEN` und `SESSION_SECRET` dort setzen, nicht
im Code hart hinterlegen.

Für HTTPS brauchst du davor einen Reverse Proxy (z. B. Nginx + Let's
Encrypt) oder eine Plattform, die HTTPS automatisch bereitstellt — Telegram
Mini Apps verlangen HTTPS.

## 3. Spiel mit dem Server verbinden

In `coin_runner_3d.html` gibt es die Zeile:

```js
const SERVER_URL = "";
```

Trage dort deine Server-Adresse ein, z. B.:

```js
const SERVER_URL = "https://dein-server.example.com";
```

Sobald das gesetzt ist:
- Beim Start der Mini App authentifiziert sich das Spiel automatisch über
  Telegrams `initData` beim Server.
- Beim Umtausch im Wallet (`exchangePersons`) wird nicht mehr lokal
  gerechnet, sondern der Server gefragt — er ist die einzige Quelle für
  Coins/TON-Stand und das Tages-Limit.
- Ohne gesetzte `SERVER_URL` (oder außerhalb von Telegram getestet) läuft
  das Spiel weiterhin im bisherigen rein lokalen Modus, damit du es auch
  im normalen Browser testen kannst.

## Was das bringt — und was nicht

**Verhindert:** beliebiges Hochsetzen des Guthabens über die
Browser-Konsole/localStorage, da der Browser den Kontostand nie selbst
besitzt, sondern nur anzeigt, was der Server zurückgibt.

**Verhindert nicht:** dass jemand die Netzwerk-Anfrage an `/api/run`
abfängt und dort die gemeldete Distanz/Zombie-Zahl manipuliert, bevor sie
beim Server ankommt. Der Server prüft nur auf Plausibilität (max. Zombies
pro Meter, Mindestabstand zwischen Einreichungen, Obergrenze pro Fahrt) —
das fängt naive Cheats ab, ist aber kein kryptographischer Beweis. Ein
wirklich manipulationssicheres System müsste die komplette Fahrt
serverseitig simulieren; das ist ein deutlich größeres Projekt.
