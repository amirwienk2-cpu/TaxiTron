# جزیره کتاب‌ها (Bücherinsel) – Integrations-Spezifikation für den TaxiTon-Chat

Der Ordner `prototype/` enthält einen **fertigen, klickbaren Prototyp** (`index.html`), der genau zeigt, wie das Spiel aussehen und sich verhalten soll. Die 40 Spieler darin sind **simuliert**, und alle Spielregeln laufen im Browser.

Im echten Chat muss die **gesamte Spiellogik auf dem Server** laufen: Zeitplan, Zufall, Inventar und Auszahlung. Der Client zeigt nur an.

---

## 1. Spielregeln (verbindlich)

| Regel | Wert |
|---|---|
| Insel offen | 30 Minuten |
| Insel geschlossen | 10 Minuten (danach öffnet sie wieder, Zyklus 40 Min.) |
| Dauer einer Suche | 5 Minuten |
| Suchen pro Öffnung | unbegrenzt hintereinander (max. 1 aktive Suche pro User gleichzeitig, also praktisch max. 6) |
| Suche starten | nur solange die Insel offen ist; eine Suche, die vor Schließung gestartet wurde, darf zu Ende laufen |
| Ergebnis pro Suche | Buch 1 = **70 %**, Buch 2 = **10 %**, Buch 3 = **2 %**, nichts = 18 % |
| Doppelte | werden gezählt (z. B. Buch 1 ×3) |
| Gewinn | sobald ein User von jedem Buch mindestens 1 hat → **0,5 TON**, und von jedem Buch wird **genau 1 abgezogen** (Überschuss bleibt) |
| Prozentwerte | werden den Usern **nicht** angezeigt |

Buchnamen (Persisch):
- Buch 1 = `نقشه قدیمی` → Bild `b1.png` (braunes Lederbuch)
- Buch 2 = `دفتر ناخدا` → Bild `b2.png` (blau-gold)
- Buch 3 = `کتاب طلایی` → Bild `b3.png` (lila-gold, leuchtend)

---

## 2. Server (Pflicht – nichts davon im Client entscheiden)

### Datenmodell (Vorschlag, an bestehende DB anpassen)
```
island_rounds     (id, opens_at, closes_at)                       -- global, ein Zyklus = 40 Min.
island_searches   (id, user_id, round_id, spot, started_at, ends_at,
                   result NULL|0|1|2|3, resolved_at)              -- 0 = nichts
island_inventory  (user_id PK, book1, book2, book3, wins, paid_ton)
island_payouts    (id, user_id, amount_ton, status pending|sent|failed, tx_hash, created_at)
```

### Ablauf
1. **Rundenplan:** Der Server legt die Runden fest (z. B. alle 40 Min. an der Server-Uhr ausgerichtet). Die Clients bekommen `opens_at`/`closes_at` und zählen nur herunter.
2. **Suche starten** `POST /island/search {spot}`:
   - Ablehnen, wenn die Insel zu ist oder der User schon eine aktive Suche hat.
   - Sonst einen Eintrag mit `ends_at = now + 5 min` anlegen.
   - Das **Ergebnis noch nicht würfeln**, damit niemand es vorher auslesen kann.
3. **Suche auflösen**, wenn `ends_at` erreicht ist (Job/Worker oder beim nächsten Abruf):
   - Mit sicherem Zufall (`crypto`) würfeln: 70 / 10 / 2 / 18.
   - Inventar erhöhen.
   - Wenn `book1>=1 && book2>=1 && book3>=1`: alle drei um 1 senken, `wins+1`, Auszahlung 0,5 TON über die bestehende TON-Wallet-Logik anlegen.
   - Alles in **einer Transaktion** und **idempotent**: eine Suche darf nur einmal aufgelöst werden.
4. **Echtzeit-Events** über den vorhandenen Chat-Websocket:
   - `island:round` (offen/zu, Zeiten)
   - `island:search_started` (user_id, ends_at)
   - `island:search_result` (user_id, result, neues Inventar, won)
   - Chat-Systemnachrichten (siehe 4.)
5. **Online-Liste:** Pro User werden `book1..3`-Zähler, `searching_until` (falls aktiv) und das letzte Ergebnis mitgeliefert.

### Sicherheit
- Zufall, Zeit und Auszahlung nur auf dem Server.
- Rate-Limit auf den Endpunkt.
- Das Ergebnis erst nach `ends_at` an den Client senden.
- Auszahlungen protokollieren. Optional ein Tageslimit pro User, Admin-Schalter zum Pausieren und ein Budget-Limit.

---

## 3. UI im Chat (1:1 wie im Prototyp)

### a) Insel-Button im Chat-Header
- Neben dem Schloss-Button (das Schloss bleibt admin-only). Den Insel-Button sehen **alle** User.
- **Offen:** blau, kleines gelbes Schild oben mit Restminuten (z. B. `22′`), leichtes Leuchten, solange der User nicht sucht.
- **Zu:** grau, Schild `بسته`.
- Antippen öffnet das Spielfenster als Bottom-Sheet.

### b) Spielfenster (Bottom-Sheet)
- Hintergrund ist das Bild `prototype/island/base2.jpg` (954×1462 px, `aspect-ratio: 954/1462`, ohne Ränder, volle Breite). **Das Design nicht verändern.**
- Darüber liegen absolut positionierte Live-Elemente. Positionen in % der Bildfläche, genau so wie in `index.html`:

| Element | left | top | width | height | Inhalt |
|---|---|---|---|---|---|
| Schließen (unsichtbarer Button über dem ✕) | 3.7% | 1.58% | 9.4% | 6.09% | – |
| Timer im Holzschild | 11.7% | 14.21% | 14.7% | 6.32% | Label `تا بسته شدن` / `تا باز شدن` + `mm:ss` (gold) |
| Sucher-Zähler im rechten Schild | 67.3% | 13.53% | 22.9% | 3.38% | `N نفر در حال جستجو` |
| Inselbereich (Nacht-Overlay, Ergebnis-Anzeige) | 3.1% | 12.18% | 93.9% | 33.27% | – |
| Großer blauer Button (Text) | 11.5% | 47.94% | 77.6% | 9.47% | `بگرد!` / `در حال جستجو mm:ss` / `جزیره بسته است` |
| Hinweiszeile | 19.7% | 57.52% | 60.8% | 3.05% | z. B. `این دور: ۲ جستجو · هر جستجو ۵ دقیقه` |
| 3 Fortschrittsbalken | 4.7% | 62.71% | 18.9% | 0.90% | Anzahl verschiedener Bücher (0–3) |
| Grau-Overlay Buch 1 (rechte Karte) `g1.jpg` | 65.72% | 64.98% | 30.82% | 18.06% | sichtbar, wenn book1 = 0 |
| Grau-Overlay Buch 2 (mittlere Karte) `g2.jpg` | 36.58% | 64.98% | 26.94% | 18.06% | sichtbar, wenn book2 = 0 |
| Grau-Overlay Buch 3 (linke Karte) `g3.jpg` | 3.56% | 64.98% | 30.61% | 18.06% | sichtbar, wenn book3 = 0 |
| Zähler-Schild `×N` | 67.5% / 38% / 5% | 65.87% | 8% | 2.93% | sichtbar, wenn Anzahl ≥ 2 |

- **Grabstellen** (SVG-Overlay mit `viewBox="0 0 954 1462"`), antippbar, solange die Insel offen ist und der User nicht sucht. Mittelpunkte:
  `(226,555) (336,573) (410,548) (474,582) (518,548) (607,596) (694,540)`
- **Beim Graben** an der gewählten Stelle: dunkles Loch, goldener Ring, der sich über 5 Min. füllt, wackelnde Schaufel, fliegender Sand, darüber eine dunkle Timer-Pille `mm:ss`.
- **Andere Sucher** stehen als kleine runde Avatare mit Schaufel auf dem Strand.
- **Ergebnis-Anzeige** im Inselbereich, 6 Sek. sichtbar oder bis zum Antippen:
  - Buch gefunden: Buchbild groß mit goldenem Strahlenkranz, Name, darunter `کتاب N به کلکشن اضافه شد` bzw. `حالا N تا از این کتاب داری`.
  - Nichts gefunden: 🐚 und `چیزی پیدا نشد`.
  - Gewinn: `🏆 0.5 TON` und `هر ۳ کتاب کامل شد!`
- **Insel zu:** Der Inselbereich wird nachtblau, in der Mitte steht `🔒 جزیره بسته است` mit Countdown.
- Schriften: `Lalezar` (Titel/Zahlen) und `Vazirmatn` (Text), alle Zahlen in persischen Ziffern.

### c) Online-Tab
- Neben jedem Usernamen ein Kästchen mit den **3 Buch-Badges** (`b1/b2/b3.png`, ca. 30×27 px).
  - Fehlendes Buch: grau und blass.
  - Ab 2 Stück: kleine gelbe Zahl unten links am Badge.
  - Ein neu gefundenes Buch springt kurz animiert auf.
- Statuszeile statt `online` / `Driving now`, solange Spielstatus vorhanden:
  - während der Suche: `🔍 در حال جستجو… mm:ss`
  - danach z. B. `📖 نقشه قدیمی پیدا کرد! (۱/۳)`, `📖 نقشه قدیمی ×۲`, `🌊 چیزی پیدا نکرد`, `🏆 ۰٫۵ TON برد!`
- Kopfzeile: `N نفر در حال جستجو`.

### d) Chat-Systemnachrichten (Absender „جزیره کتاب‌ها“, eigene Karte)
- Insel öffnet: `جزیره باز شد! ۳۰ دقیقه وقت دارید، هر ۵ دقیقه یک جستجو. ۳ کتاب متفاوت = 0.5 TON` + Button `🔍 برو به جزیره`, der das Spielfenster öffnet.
- Insel schließt: `جزیره بسته شد · N نفر گشتند. ۱۰ دقیقه دیگر دوباره باز می‌شود.`
- Fund von Buch 2 oder 3 (nicht Buch 1, sonst Spam): kleines Buchbild + `USER کتاب طلایی را پیدا کرد (۲/۳)`
- Gewinn (goldene Karte): `🏆 USER هر ۳ کتاب را پیدا کرد و 0.5 TON گرفت!`

---

## 4. Dateien
```
prototype/index.html        klickbarer Prototyp (Referenz für Aussehen & Verhalten; Bots sind simuliert)
prototype/b1.png b2.png b3.png    Buch-Badges (Buch 1, 2, 3)
prototype/island/base2.jpg  Hintergrundbild des Spielfensters (954×1462)
prototype/island/g1.jpg g2.jpg g3.jpg   Grau-Overlays für noch nicht gefundene Bücher
```
Prototyp lokal ansehen: `prototype/index.html` im Browser öffnen und oben im Chat-Header auf den Insel-Button tippen.
