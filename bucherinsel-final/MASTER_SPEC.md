# جزیره کتاب‌ها (Bücherinsel) – FINALE Gesamt-Spezifikation

**Diese Datei ersetzt ALLE früheren Specs** (SPEC.md, SHOP_SPEC.md, DESIGN_SPEC.md, Bubble- und Header-Texte).
Wo etwas früher anders war, gilt **nur noch diese Datei**.

Referenz für Aussehen und Verhalten:
- `prototype/index.html` (klickbar, Mitspieler simuliert)
- `screenshots/` – **das Ergebnis muss pixelgenau so aussehen.**

| Screenshot | Zeigt |
|---|---|
| 00_chat.png | Chat mit Insel-Button und Fund-Bubble |
| 01_insel_offen.png | Spielfenster, Insel offen |
| 02_suche_laeuft.png | Spielfenster, eigene Suche läuft |
| 03_insel_zu.png | Insel geschlossen (alles schwarz, nur Banner) |
| 04_insel_oeffnet.png | Moment der Öffnung (Banner „جزیره باز شد“) |
| 05_online_tab.png | Online-Liste mit Buch- und Schaufel-Badges |
| 06_chat_fund_bubble.png | Fund-Nachricht im Chat |
| 07_header_button.png | Insel-Button: offen / sucht / zu |
| 08_shop_komplett.png | Shop-Tab „جزیره“ |
| 09_shop_kauf_bestaetigen.png | Kauf-Bestätigung |
| 10_shop_tausch.png | Bücher-Tausch |

---

## 0. Stil-Regeln (gelten überall)
1. **Gelieferte Bilder 1:1 verwenden.** Nicht nachzeichnen, nicht neu einfärben, nicht beschneiden, nicht mit CSS „nachbauen“.
2. Live-Texte liegen **absolut in Prozent** über den Bildern. Schriftgrößen in `cqw` (Container hat `container-type:inline-size`), damit alles mit der Breite skaliert.
3. Schriften:
   - **Lalezar** für Zahlen, Buttons und Titel
   - **Vazirmatn** für Text
   - **Lilita One** für kleine Zahlen-Schilder
   - Alle Zahlen in **persischen Ziffern**, nur TON-Beträge lateinisch (`0.25 TON`).
4. Farben:
   - Gold `#ffd84d` / `#f6c62b`
   - Navy `#0a2263` / `#071a4d`
   - Rot-Button-Text `#ffd84d` mit dunkelrotem Schatten `#6b1a05`
5. Texte einzeilig, wo angegeben (`white-space:nowrap`). Nichts darf aus den gemalten Schildern herauslaufen.
6. Wenn etwas nicht passt, die Schrift verkleinern. Niemals das Bild ändern.

---

## 1. Spielregeln (Server ist die einzige Wahrheit)
| Regel | Wert |
|---|---|
| Insel offen / zu | **30 Min. offen, 10 Min. zu**, Zyklus 40 Min. |
| Suchdauer | **5 Minuten** |
| Suchen pro Öffnung | unbegrenzt hintereinander, max. **1 aktive Suche pro User** |
| Suche starten | nur wenn offen; eine laufende Suche darf über das Schließen hinaus fertig laufen |
| Fund-Chancen | Buch 1 **25 %**, Buch 2 **3 %**, Buch 3 **0.5 %**; andernfalls **50–150 TT** als Zufallsbonus direkt dem TT-Guthaben gutschreiben. **Prozente nirgends anzeigen.** |
| Würfeln | erst bei Ablauf der 5 Min., serverseitig mit sicherem Zufall |
| Doppelte | zählen (Inventar mit Zählern) |
| Gewinn | sobald von jedem Buch ≥ 1: **0.25 TON** auszahlen, von jedem Buch **1 abziehen** |

Bücher:
- **Buch 1** `نقشه قدیمی` = `books/b1.png` (braun, Krone)
- **Buch 2** `دفتر ناخدا` = `books/b2.png` (lila)
- **Buch 3** `کتاب طلایی` = `books/b3.png` (blau)

Diese Bilder werden **überall** verwendet: Spiel, Online, Shop, Tausch, Chat.

---

## 2. Chat-Header: Insel-Button (`07_header_button.png`)
- Position: neben dem Schloss-Button. Das Schloss bleibt admin-only, den Insel-Button sehen alle.
- Maße und Grundstil:
  - **62×48 px**, Radius 15 px
  - Hintergrund: Verlauf `#123a8c → #0a2263 → #071a4d`
  - innen 2 px Goldrand `#f6c62b`, oben innen weiße Kante 18 %
  - 3D-Kante unten `0 4px 0 #b8860b`, Schatten `0 6px 12px rgba(0,0,0,.45)`
- Icon `island/isl_icon.png`, 38 px, mittig.
- Schild unten mittig, halb überstehend (`bottom:-9px`):
  - Lilita One 11 px, Radius 8 px, 1.5 px Rand `#0a2263`
  - zeigt einen Live-Countdown `mm:ss`
- Zustände:

| Zustand | Button | Schild |
|---|---|---|
| Offen | Goldring pulsiert nach außen (1.8 s), Icon wippt leicht | grün `#3fdc6a→#20a64a`, Restzeit bis Schließung |
| User sucht | normal | gelb `#ffe066→#f2b81c`, dunkle Schrift, eigener Such-Countdown |
| Zu | dunkel `#1c2340→#121731`, Goldrand gedämpft, Icon grau, Badge 🔒 oben rechts (20 px, navy, Goldrand) | grau `#5a6077→#3d4257`, Zeit bis Öffnung |

- Antippen öffnet das Spielfenster (Bottom-Sheet).

---

## 3. Spielfenster (`01`–`04`)
- Hintergrund `island/base5.jpg`:
  - **1024 × 1536**, `aspect-ratio:1024/1536`, volle Breite, `background-size:100% 100%`
  - alle wechselnden Texte sind entfernt und werden live darübergelegt.

### 3.1 Live-Elemente (Prozent von 1024 × 1536)
| Element | left | top | width | height | Inhalt / Stil |
|---|---|---|---|---|---|
| Schließen (unsichtbar über gemaltem ✕) | 3.9% | 2.3% | 9.8% | 6.5% | schließt das Sheet |
| Sucher-Zahl im Schild oben rechts | 79.7% | 3.26% | 17.4% | 3.1% | **nur** `N نفر` (z. B. `۱ نفر`), weiß, fett, ~2.6cqw, mittig. **Kein** „در حال جستجو“, **kein** Timer |
| Insel-Timer im Uhr-Schild | 83.8% | 8.46% | 13.5% | 6.12% | Zeile 1 `تا بسته شدن:` / `تا باز شدن:` (weiß, ~2cqw, nowrap) · Zeile 2 `mm:ss` (gold, Lalezar ~5.4cqw, nowrap, `direction:ltr`) |
| Statuszeile (kleine Pille) | 62% | 57.6% | 35% | 2.5% | navy halbtransparent, Goldrand, ~2.1cqw. Inhalt: `👆 روی یک ✕ بزن یا «بگرد»` / Fundergebnis / `جزیره ۱۰ دقیقه بسته است`. **Während der Suche leer.** |
| Roter Button (Klickfläche) | 3.7% | 60.2% | 56.05% | 9.1% | Text zwischen gemalter Schaufel und gemaltem Pfeil: im Button `left 30.8%, width 47.9%` |
| Kollektion Buch 1 (rechts) | 67.58% | 71.48% | 27.54% | 13.15% | siehe 3.3 |
| Kollektion Buch 2 (Mitte) | 36.52% | 71.48% | 27.34% | 13.15% | |
| Kollektion Buch 3 (links) | 5.47% | 71.48% | 27.54% | 13.15% | |
| Ergebnis-Anzeige | 1% | 16% | 98% | 42% | siehe 3.5 |

### 3.2 Roter Button
| Zustand | Inhalt |
|---|---|
| offen, keine Suche | `بگرد` (Lalezar ~6.6cqw, gelb `#ffd84d`, Schatten `0 .45cqw 0 #6b1a05`) |
| Suche läuft | **zweizeilig:** oben klein `در حال جستجو` (Vazirmatn fett ~2.4cqw, `#fff3c4`), darunter **groß der Countdown** `۰۴:۵۹` (Lalezar ~6.4cqw), tickt jede Sekunde, Button deaktiviert |
| Insel zu | `بسته است` (~4.6cqw), Button leicht entsättigt, deaktiviert |

Antippen startet die Suche an einer zufälligen ✕-Stelle.

### 3.3 Kollektion
- **0 Stück:** graues Overlay `island/k1.jpg` / `k2.jpg` / `k3.jpg` exakt auf die Fläche, darauf mittig der Buchname + `؟` (Lalezar ~3.2cqw, `#bcd0ff`).
- **1 Stück:** nur das gemalte Buch.
- **≥ 2 Stück:** goldenes Schild `×N` oben links (Lalezar ~3.4cqw, Goldverlauf `#ffe680→#f3b917`, Rand `#7a5a12`, Schrift `#2a1f00`).
- **Neu gefunden:** kurze Pop-Animation (scale 1 → 1.12 → 1, 0.6 s).

### 3.4 Grabstellen (SVG-Overlay `viewBox="0 0 1024 1536"`)
Die roten ✕ sind gemalt, live kommen nur Klickflächen dazu (Radius 30) plus ein pulsierender gelber Ring, solange gesucht werden darf:
```
(577,345)  (405,515)  (608,500)  (855,508)  (130,545)  (865,785)
```
- **Graben (nur die eigene Stelle):**
  - dunkles Loch, Radius 40
  - goldener Ring, Strichstärke 9, Verlauf `#ffe680→#f3b917→#b9800b`, füllt sich über 5 Min.
  - Bild der stärksten aktiven Schaufel (sonst eine Standard-Schaufel), wackelnd
  - fliegender Sand
  - **Kein Timer über der Stelle.**
- **Keine Avatare, Namen oder Buchstaben anderer User auf der Insel.**

### 3.5 Ergebnis-Anzeige (6 s oder bis Antippen)
- **Buch gefunden:**
  - Buchbild groß mit drehendem goldenem Strahlenkranz
  - Name (Lalezar, gold)
  - darunter `کتاب N به کلکشن اضافه شد` bzw. `حالا N تا از این کتاب داری`
- **Kein Buch:** 🪙 + `+N TT` und `به موجودی TT اضافه شد`; die serverseitig zufällig bestimmten 50–150 TT werden direkt dem TT-Guthaben gutgeschrieben.
- **Gewinn:** `🏆 0.25 TON` + `هر ۳ کتاب کامل شد!`
- **Zusatzzeilen bei Schaufel-Boni:** `🔥 بیل آتشین: +0.2 TON`, `⭐ جایزه‌ی روزانه: +X TON`

### 3.6 Insel zu (`03_insel_zu.png`)
- Das **gesamte Spielfenster wird komplett schwarz** (`#000`, 100 % deckend, Einblendung 0.6 s). Titel, Timer, Button und Kollektion sind nicht zu sehen.
- Sichtbar ist **nur** das Banner `island/closed2.png`:
  - horizontal und vertikal mittig, 94 % Breite
  - Ein-Animation: scale 0.9 → 1
  - Live-Countdown im leeren Kasten des Banners: `left 48.6%, width 26.3%, top 59%, height 19.6%` (relativ zum Banner), weiß, Lalezar ~7cqw
- Die unsichtbare Schließen-Fläche oben links bleibt antippbar.

### 3.7 Insel öffnet (`04_insel_oeffnet.png`)
- Das Schwarz blendet in 0.6 s aus, alles ist wieder sichtbar.
- Das Banner `island/opened.png` erscheint mittig, 94 % Breite, Pop-Animation (scale 0.6 → 1), bleibt **3.5 s** sichtbar und blendet dann wieder aus.

---

## 4. Online-Tab (`05_online_tab.png`)
- Neben dem Usernamen ein Kästchen `#262a3a` (Radius 10 px) mit:
  - den 3 Buch-Badges (`b1/b2/b3.png`, ca. 30×27 px); fehlendes Buch grau mit 18 % Deckkraft; ab 2 Stück eine gelbe Zahl unten links
  - hinter einem senkrechten Strich die Icons der **aktiven Schaufeln** des Users (28 px)
- Statuszeile während der Suche: `🔍 در حال جستجو… mm:ss`; danach letzter Fund oder Gewinn.
- Kopfzeile: `N نفر در حال جستجو`.

---

## 5. Chat-Nachrichten
### 5.1 Fund-Bubble (`06_chat_fund_bubble.png`)
- Hintergrund `island/bubble.png`:
  - Seitenverhältnis **1862:845**, `background-size:100% 100%`
  - **max. 260 px** breit (bzw. 78 % der Chatbreite)
  - links ausgerichtet wie eine normale Nachricht
  - leichter Schatten
- Der Titel `جزیره کتاب‌ها 🏝️` ist schon im Bild und wird **nicht** nochmal geschrieben.
- Inhalt (RTL) im Bereich `left 6%, right 6%, top 31%, bottom 14%`:
  - rechts das Bild in voller Bereichshöhe
  - daneben der Username (Lalezar ~6.2cqw, weiß, einzeilig)
  - darunter gelb `#ffd84d` der Text (~4.4cqw)
  - darunter hellblau `#bcd0ff` die Zusatzzeile (~3.6cqw)
  - Uhrzeit klein unten links (`left 6%, bottom 5.5%`)
- Verwendet für:

| Ereignis | Bild | Text | Zusatz |
|---|---|---|---|
| Fund Buch 2 | b2.png | `دفتر ناخدا را پیدا کرد!` | `کلکسیون: X/۳` |
| Fund Buch 3 | b3.png | `✨ کتاب طلایی را پیدا کرد!` | `کلکسیون: X/۳` |
| Feuer-Fund | shovels/sh3.png | `🔥 با بیل آتشین 0.2 TON پیدا کرد!` | – |
| Gewinn | b3.png | `🏆 هر ۳ کتاب را پیدا کرد و 0.25 TON گرفت!` | – |

- **Buch-1-Funde bekommen keine Chat-Nachricht** (sonst Spam).

### 5.2 System-Karten (Stil wie bisher)
- Insel öffnet: `جزیره باز شد! ۳۰ دقیقه وقت دارید، هر ۵ دقیقه یک جستجو. ۳ کتاب متفاوت = 0.25 TON` + Button `🔍 برو به جزیره` (öffnet das Spielfenster)
- Insel schließt: `جزیره بسته شد · N نفر گشتند. ۱۰ دقیقه دیگر دوباره باز می‌شود.`
- Tagesbonus: `USER N جستجوی امروز را کامل کرد و X TON جایزه‌ی روزانه گرفت!`

---

## 6. Shop-Tab „جزیره“ (`08`–`10`)
Platzierung: in **Shop** zwischen **Packs** und **Items**, Icon `b1.png`. Levels, Packs und Items bleiben unverändert. Persisch, RTL.

Aufbau von oben nach unten:
1. **Guthaben-Leiste:** 3 Bücher mit Anzahl + TON-Guthaben.
2. **Karte „بیل شما“:**
   - Rahmen in der Farbe der stärksten aktiven Schaufel
   - Bild der Schaufel (schwebt leicht)
   - Kräfte-Pillen
   - Icons aller Schaufeln (nicht besessene grau)
   - Resttage
3. **Reset-Leiste:** `⏰ ریست روزانه` / `هر شب ساعت ۰۰:۰۰ به وقت برلین` + Live-Countdown `HH:MM:SS`.
4. **4 Schaufel-Karten im 2er-Raster**, mit:
   - Seltenheitsfarbe, Strahlenkranz, Seltenheits-Chip, Stufe ۱–۴
   - Schild unten am Bild: `✓ فعال · N روز` / `فقط N عدد باقی` (≤ 3 rot pulsierend) / `تمام شد`
   - Wirkungs-Box, `👥 فروخته شد X/Limit`
   - Preis mit TON-Logo und `Guthaben/Preis` + Balken
   - Button `خرید` / `کافی نیست` / `تمام شد` / `✓ فعال`
   - wenn besessen: `امروز X/N جستجو` (grüner Balken) und `⏳ N روز باقی · تا <persisches Datum>` (blauer Balken)
5. **Kauf-Bestätigung** (Overlay): Bild, Name, Wirkung, Preis, `خرید` / `انصراف`. Danach Toast `<Name> خریداری شد! 🎉`.
6. **Bücher-Tausch** `تبادل کتاب`:

| Tausch |
|---|
| 50× Buch 1 → 1× Buch 2 |
| 150× Buch 1 → 1× Buch 3 |
| 25× Buch 2 → 1× Buch 3 |

   - Mengenwähler `− N +`, Button `تبادل` / `کافی نیست`
   - danach den Gewinn prüfen (0.25 TON)

### Schaufeln
| ID | Name | Bild | Seltenheit / Farbe | Preis | Wirkung | Dauer | Limit |
|---|---|---|---|---|---|---|---|
| s1 | `بیل طلایی` | sh1.png | `کمیاب` `#f2b81c` | **1 TON** | 0.067 TON pro Tag bei **15** Suchen | 30 Kalendertage | **30** aktive |
| s2 | `بیل آمتیست` | sh2.png | `حماسی` `#b45cff` | **3 TON** | 0.2 TON pro Tag bei **20** Suchen | 30 Kalendertage | **20** aktive |
| s3 | `بیل آتشین` | sh3.png | `افسانه‌ای` `#ff5a1f` | **5 TON** | 0.33 TON pro Tag bei **30** Suchen **+ jede Suche 1 % Chance auf 0.2 TON** (Prozent NIE anzeigen) | 30 Kalendertage | **10** aktive |
| s4 | `بیل یخی` | sh4.png | `اسطوره‌ای` `#38bdf8` | – | `قدرت مخفی…` | – | gesperrt, `به‌زودی` |

Regeln:
- Alle Schaufeln können gleichzeitig aktiv sein und zählen **dieselben** Suchen.
- Boni werden **sofort** beim Erreichen der Schwelle ins Wallet gezahlt, jeder einmal pro Tag.
- Pro Typ kann ein User nur 1 aktive Schaufel haben.
- Limit = gleichzeitig aktive Besitzer; nach Ablauf wird der Platz frei.
- Die stärkste aktive Schaufel erscheint im Grab-Ring.

---

## 7. Kalender
- Zeitzone **`Europe/Berlin`**.
- **Tagesreset 00:00 Berlin:** Suchzähler und Bonus-Flags zurücksetzen.
- 30 Kalendertage, der Kauftag ist Tag 1; `expires_on = kauf_datum + 30`; aktiv, solange `heute < expires_on`.
- Eine Suche zählt für den Tag, an dem sie **abgeschlossen** wird.

---

## 8. Server (Pflicht)
Zufall, Zeit, Inventar, Limits, Käufe, Tausch und **alle Auszahlungen** laufen nur auf dem Server: transaktionssicher, idempotent, mit Lock beim Kauf (Limit) und Rate-Limit. Alles wird protokolliert, und es gibt einen Admin-Schalter, um Spiel und Shop zu pausieren.

Datenmodell (Vorschlag):
```
island_rounds(id, opens_at, closes_at)
island_searches(id, user_id, round_id, spot, started_at, ends_at, result, resolved_at)
island_inventory(user_id, book1, book2, book3, wins, paid_ton, searches_today, day, bonus_paid_s1/s2/s3)
island_shovels(id, user_id, type, bought_on, expires_on, price_ton)
island_exchanges(id, user_id, type, qty, books_in, books_out)
island_payouts(id, user_id, amount_ton, reason win|fire_drop|daily_s1|daily_s2|daily_s3, status, tx_hash)
```
Echtzeit über den bestehenden Websocket: `island:round`, `island:search_started`, `island:search_result`, Chat-Nachrichten, Online-Status.

---

## 9. Dateien
```
assets/island/base5.jpg       Hintergrund Spielfenster (1024×1536, Texte entfernt)
assets/island/closed2.png     Banner "Insel zu" (Countdown-Kasten leer)
assets/island/opened.png      Banner "Insel offen"
assets/island/k1.jpg k2.jpg k3.jpg  graue Kollektions-Flächen
assets/island/bubble.png      Chat-Fund-Bubble (1862:845)
assets/island/isl_icon.png    Icon für den Header-Button
assets/books/b1.png b2.png b3.png
assets/shovels/sh1.png sh2.png sh3.png sh4.png
screenshots/                  Zielbilder
prototype/                    klickbarer Prototyp
```
