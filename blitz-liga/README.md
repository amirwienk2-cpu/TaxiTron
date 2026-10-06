# لیگ برق‌آسا (Blitz-Liga) – Paket für das Chat-Event

Virtuelles Fußball-Tippspiel auf Persisch: alle 3½ Minuten ein Spiel (60 s Einlauf + Tippphase, 120 s Spiel, 25 s Auswertung), 10 Spiele pro Saison, Tipp Über/Unter 2,5 Tore, richtig = 3 Punkte, Auszahlung nach Spiel 10.

## Inhalt
| Datei | Zweck |
|---|---|
| `index.html` | Das komplette Spiel (UI, 3D-Stadion mit three.js, 2D-Fallback, Tabelle, Persisch/RTL). Läuft ohne Backend im Einzelspieler-Modus. |
| `blitz-api.js` | Verbindung zum Backend. Wenn eingebunden, nutzt `index.html` automatisch euren Server (Tipps, Tabelle, Namen, Serverzeit). |
| `server/server.js` | Beispiel-Backend (Node/Express, speichert in `data.json`). Als Vorlage gedacht. |
| `server/liga-core.js` | Gemeinsame Spiellogik (Teams, Zeitplan, Ergebnisse, Tabelle) – identisch zur Logik in `index.html`. |
| `AGENT_PROMPT.md` | Auftrag für den Entwickler/Agenten. |

## Schnellstart (lokal)
```
cd server
npm install
npm start
```
Dann `index.html` öffnen über `http://localhost:3000/index.html` – vorher in `index.html` direkt nach `<body>` die Zeile `<script src="blitz-api.js"></script>` einfügen.

## Schnittstelle (window.BLITZ_API)
`index.html` erwartet optional ein Objekt `window.BLITZ_API`:
- `userId(): Promise<string>` – ID des eingeloggten Users
- `loadMe(): Promise<{tips, paid, won}>` – eigene Daten
- `saveMe(doc): Promise` – eigene Tipps speichern (`doc.tips = { [matchId]: { ou: "over"|"under", ts } }`)
- `names(ids): Promise<{[id]: name}>` – Anzeigenamen
- `subscribe(cb)` – ruft `cb({ [uid]: {tips, paid, won} })` bei jeder Änderung auf (Beispiel: Polling alle 3 s)

## Regeln (bitte serverseitig durchsetzen)
- Spiel-ID = `floor(Serverzeit / 205000)`, Saison = `floor(ID / 10)`.
- Tipp nur in den ersten 60 s eines Zyklus, ein Tipp pro Spiel, Zeitstempel setzt der Server.
- Punkte: richtig = 3. Gleichstand: wer im Schnitt früher getippt hat, liegt vorne.
- Preise: Platz 1 = 2 TON, Platz 2 = 1 TON, Platz 3 = 0,5 TON, Platz 4–10 = je 0,1 TON (4,2 TON pro Saison).

## Wichtig vor echtem Geld
Die Ergebnisse werden aktuell aus der Spiel-ID berechnet. Wer den Code liest, kann sie vorher ausrechnen. Für echte TON-Auszahlung muss das Ergebnis mit einem geheimen Server-Seed erzeugt und erst beim Anpfiff an die Clients geschickt werden (Details in `AGENT_PROMPT.md`).
