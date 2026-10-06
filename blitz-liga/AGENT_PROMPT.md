# Auftrag: „لیگ برق‌آسا" (Blitz-Liga) als Event im Chat-Bereich einbauen

Im Anhang ist ein fertiges Spiel (`index.html`) plus Beispiel-Backend. Bitte baue es als neues Event in unseren Chat-Bereich ein.

## 1. Design und Spiel nicht verändern
- `index.html` 1:1 übernehmen: Design, Texte (Persisch, RTL), 3D-Stadion, Ablauf und Zeiten bleiben exakt so.
- Einbinden als eigene Seite/WebView im Bereich „Events" (z. B. Event-Karte „لیگ برق‌آسا" → öffnet die Seite im Vollbild).
- three.js wird von `cdnjs.cloudflare.com` geladen; wenn das bei uns blockiert ist, die Datei `three.min.js` (r128) lokal hosten und den Pfad anpassen.

## 2. Backend anbinden
- `blitz-api.js` in `index.html` direkt nach `<body>` einbinden. Darüber spricht das Spiel mit dem Server (Schnittstelle in README).
- Die Endpunkte aus `server/server.js` in unser Backend übernehmen (`GET /api/time`, `GET /api/me`, `PUT /api/me`, `GET /api/docs`), aber mit unserer Datenbank statt `data.json`.
- Login: den User aus unserem bestehenden Login nehmen. Bei Telegram: `initData` an den Server schicken und per HMAC mit dem Bot-Token prüfen. Den Header `X-User-Id` aus dem Beispiel NICHT in Produktion verwenden.
- Anzeigename = Name aus unserem Chat-Profil.

## 3. Regeln serverseitig erzwingen
- Spiel-ID = `floor(Serverzeit_ms / 205000)`; Zyklus: 60 s Tippen, 120 s Spiel, 25 s Pause. Saison = 10 Spiele (`floor(ID/10)`).
- Tipps nur in der Tippphase des aktuellen Spiels annehmen, nur `over`/`under`, Zeitstempel vom Server. `paid`/`won` vom Client ignorieren.
- Wertung: richtig = 3 Punkte. Gleichstand → wer im Schnitt früher getippt hat, liegt vorne. Logik in `server/liga-core.js` (`table()`).
- Rate-Limit auf `PUT /api/me`.

## 4. Auszahlung nach jeder Saison
- Nach Spiel 10 die Tabelle berechnen und auszahlen: Platz 1 = 2 TON, Platz 2 = 1 TON, Platz 3 = 0,5 TON, Platz 4–10 = je 0,1 TON.
- Über unser bestehendes TON-Wallet-System gutschreiben, jede Saison nur einmal (idempotent), mit Log (Saison, User, Platz, Punkte, Betrag, Status).
- Im Spiel unter „TON" (oben rechts) den gesamten Gewinn des Users aus der Datenbank anzeigen (`won`).

## 5. Ergebnisse gegen Betrug absichern (Pflicht vor echtem Geld)
Aktuell berechnet `match(id)` in `index.html` das Ergebnis aus der Spiel-ID – man könnte es vorher ausrechnen. Bitte umbauen:
- Teams/Trikots dürfen weiter aus der Spiel-ID kommen (öffentlich).
- Tore, Ereignisse und Spielverlauf mit einem geheimen Zufalls-Seed pro Spiel erzeugen, der nur auf dem Server liegt.
- Seed (oder das fertige Ergebnis) erst ab Anpfiff an die Clients ausliefern (`GET /api/match/:id` liefert vor Anpfiff nur die Teams).
- Die Wertung/Auszahlung nutzt das Server-Ergebnis.

## Abnahme
- 2 Testgeräte sehen gleichzeitig dasselbe Spiel (gleiche Minute, gleicher Spielstand).
- Tipp nach Anpfiff wird abgelehnt.
- Tabelle stimmt auf allen Geräten überein; nach Spiel 10 wird genau einmal ausgezahlt.
- Ergebnis eines Spiels ist vor Anpfiff nicht aus Netzwerk oder Code ablesbar.
