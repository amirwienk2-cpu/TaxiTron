# Coin Runner 3D — Client

Neu aufgebautes Frontend für dein bestehendes `server.js` (Telegram-Mini-App,
server-authoritative Economy). Der Client rechnet **nie** selbst Coins/TON
hoch — er zeigt nur, was der Server zurückgibt, und meldet nach jedem Lauf
`distance` + `zombies` an `/api/run` bzw. `/api/submit-score`.

## Struktur

```
coin-runner-client/
├── index.html
├── css/style.css
├── js/
│   ├── main.js          Einstiegspunkt: Telegram-Auth, Bootstrapping
│   ├── api.js            Wrapper um alle server.js-Endpunkte
│   ├── telegram.js       Telegram WebApp SDK (initData, Haptics, BackButton)
│   ├── state.js           kleiner Store für Coins/TON/Best etc.
│   ├── ui.js              Screens: Menü, HUD, Summary, Wallet, Rangliste
│   └── game/
│       ├── Game.js        Loop, Szene, Kamera, Laufsteuerung
│       ├── Road.js         Straße als eine Plane mit scrollender Textur
│       ├── Scenery.js      Straßenrand-Deko als InstancedMesh (1 Draw-Call)
│       ├── Car.js          Spieler-Fahrzeug, Spurwechsel
│       ├── ZombiePool.js  Objektpool für Zombies (keine Allokationen im Loop)
│       └── Input.js        Swipe-Steuerung (+ Pfeiltasten als Desktop-Bonus)
└── README.md
```

Kein Build-Schritt nötig: reine ES-Module, Three.js kommt per `importmap`
von unpkg. Einfach als statische Dateien hosten.

## Warum es nicht laggt

- **Straße:** eine einzige Plane, "Bewegung" ist nur ein Textur-Offset —
  keine Geometrie wird pro Frame neu gebaut oder verschoben.
- **Deko am Straßenrand:** ein `InstancedMesh` mit 26 Instanzen = 1 Draw-Call
  statt 26 einzelner Meshes.
- **Zombies:** fester Objektpool (24 Stück), die recycelt statt neu erzeugt
  werden. Kein `new`/GC-Druck während des Laufs.
- **Kein Echtzeit-Schattenwurf:** stattdessen ein billiger "Blob-Schatten"
  unter dem Auto (eine transparente Textur).
- **Delta-Zeit gekappt** (max. 1/20 s) und die Render-Loop pausiert komplett,
  wenn der Tab/die App im Hintergrund ist (`visibilitychange`).
- `devicePixelRatio` ist auf max. 2 gedeckelt, damit hochauflösende Handys
  nicht unnötig viele Pixel rendern müssen.

## Setup

1. **API-Basis-URL setzen** — in `index.html`:
   ```html
   <script>
     window.__COIN_RUNNER_API_BASE__ = "https://DEIN-SERVER.up.railway.app";
   </script>
   ```
   Läuft der Client auf exakt derselben Domain wie `server.js` (z.B. weil
   `server.js` die statischen Dateien selbst ausliefert), kann das auch ein
   leerer String `""` bleiben.

2. **Statisch hosten**, z.B.:
   - Als eigener Vercel/Netlify/Cloudflare-Pages-Deploy (empfohlen — Backend
     bleibt separat auf Railway), oder
   - Von `server.js` selbst mitausgeliefert (dazu müsstest du in `server.js`
     einen kleinen Static-File-Handler ergänzen, der `index.html`/`css`/`js`
     ausliefert; aktuell tut `server.js` das nicht, es beantwortet nur
     `/api/*`).

3. **Telegram-Bot konfigurieren** (BotFather):
   - `/newapp` bzw. `/setmenubutton` → Web-App-URL = die Domain, unter der du
     den Client in Schritt 2 hostest.

4. **Lokal testen:** Die App braucht ein echtes, von Telegram signiertes
   `initData` (siehe `verifyTelegramInitData` in `server.js`) — außerhalb von
   Telegram öffnen zeigt bewusst nur einen Hinweis statt einen Fake-Login
   zuzulassen, damit die Auth so streng bleibt wie im Server vorgesehen.
   Zum Testen also entweder direkt über den Telegram-Bot öffnen (z.B. via
   ngrok-Tunnel auf deinen lokalen Client), oder Telegram Desktop mit einer
   Test-Bot-Web-App verwenden.

## Spielablauf

1. **Fahren** → 42 Sekunden Lauf, Tempo steigt über die Zeit. Wischen
   links/rechts wechselt die Spur, Zombies in der eigenen Spur werden
   automatisch eingesammelt.
2. Nach Laufende wird die erreichte **Distanz + Zombie-Zahl** sofort per
   `/api/submit-score` fürs Wochenturnier gemeldet — unabhängig davon, ob du
   einlöst.
3. Auf dem Summary-Screen löst **„Einlösen“** den Lauf über `/api/run` ein
   und schreibt die vom Server berechneten Coins/TON gut.
4. **Wallet** zeigt Ein-/Auszahlung (`/api/deposit-info`, `/api/withdraw`,
   `/api/withdrawals`), **Rangliste** zeigt `/api/leaderboard`.

## Tuning

Die wichtigsten Stellschrauben für das Spielgefühl:

- `RUN_DURATION_S`, `BASE_SPEED`, `MAX_SPEED` in `js/game/Game.js`
- `METERS_PER_SPAWN_BASE` in `js/game/ZombiePool.js` (Sammelrate — bewusst
  so gewählt, dass sie deutlich unter dem serverseitigen Plausibilitäts-Cap
  `MAX_ZOMBIES_PER_METER = 0.3` aus `server.js` bleibt, damit gute Spieler
  nicht durch das Anti-Cheat-Clamping ausgebremst werden)
- Farben/Look in `css/style.css` (`:root`-Variablen) und den `Material`-Farben
  in `Car.js` / `ZombiePool.js` / `Scenery.js`
