Das Inselspiel „جزیره کتاب‌ها“ ist schon eingebaut. Jetzt soll der Shop dafür kommen. Falls du schon eine frühere Shop- oder Schaufel-Version eingebaut hast, ersetze sie komplett durch diese.

Im Ordner `bucherinsel-shop/` findest du:
- `SHOP_SPEC.md`: alle Regeln, Preise, Limits, Kalender-Logik, Server-Endpunkte und Texte
- `screenshots/`: genau so soll es aussehen
- `prototype/index.html`: klickbarer Prototyp (unten Shop antippen, dann Tab „جزیره“)
- `assets/sh1.png` bis `sh4.png`: die Schaufel-Bilder

Lies `SHOP_SPEC.md` komplett und schau dir alle Screenshots an. Dann baue:

1. **Shop-Tab „جزیره“** zwischen Packs und Items. Levels, Packs und Items nicht verändern. Der Tab wird 1:1 wie auf den Screenshots gebaut, auf Persisch und RTL.
2. **4 Schaufeln** (Bezahlung nur in TON, jeweils 30 Kalendertage gültig):
   - بیل طلایی: 1 TON → 0.067 TON täglich bei 15 Suchen, max. 30 aktive User
   - بیل آمتیست: 3 TON → 0.2 TON täglich bei 20 Suchen, max. 20 aktive User
   - بیل آتشین: 5 TON → 0.33 TON täglich bei 30 Suchen + bei jeder Suche 1 % Chance auf 0.2 TON (die Prozentzahl nirgends anzeigen), max. 10 aktive User
   - بیل یخی: gesperrt, „به‌زودی“
   - Alle Schaufeln können gleichzeitig aktiv sein und zählen dieselben Suchen. Boni werden sofort beim Erreichen der Zahl ins Wallet gutgeschrieben, jeder einmal pro Tag.
3. **Kalender:** Zeitzone `Europe/Berlin`, täglicher Reset um 00:00 Uhr Berlin. Die 30 Tage zählen nach Kalender ab dem Kauftag. Im Tab werden ein Live-Countdown bis zum Reset, die Resttage und das Ablaufdatum angezeigt.
4. **Limits:** Anzeige „فروخته شد X/Limit“, „فقط N عدد باقی“ und „تمام شد“. Der Kauf wird mit Lock in einer Transaktion geprüft, damit niemand über das Limit kaufen kann.
5. **Bücher-Tausch** unten im Tab:
   - 50× Buch 1 → 1× Buch 2
   - 150× Buch 1 → 1× Buch 3
   - 25× Buch 2 → 1× Buch 3
   - mit Mengenwähler; danach den 0,5-TON-Gewinn prüfen
6. **Im Inselspiel:**
   - beim Graben das Bild der stärksten aktiven Schaufel im Ring zeigen
   - Hinweiszeile mit dem Tagesfortschritt
   - Bonus- und Feuer-Gewinne in der Ergebnis-Anzeige und als Chat-Nachricht
7. **Im Online-Tab:** neben den Buch-Badges die Icons der aktiven Schaufeln jedes Users.

Zufall, Zeit, Limits, Zähler und alle Auszahlungen laufen nur auf dem Server, transaktionssicher und idempotent.

Halte dich an meinen bestehenden Code, meine Komponenten und meine TON-Wallet-Logik. Sag mir vorher kurz, welche Dateien du anlegst oder änderst.
