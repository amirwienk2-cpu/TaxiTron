# Shop-Tab „جزیره“ – Schaufeln & Bücher-Tausch (finale Version)

Erweiterung des bereits eingebauten Inselspiels „جزیره کتاب‌ها“.
**Diese Version ersetzt jede frühere Shop- oder Schaufel-Version komplett.** Silber-, Gold- und Platin-Schaufeln von früher, „Fund ×2“, „Gewinn ×2“ und „Suche 2:30“ werden entfernt.

Referenz: `prototype/index.html` öffnen → unten in der Leiste **Shop** → Tab **جزیره**. Wie es aussehen soll, zeigen die Bilder in `screenshots/`.

---

## 1. Platzierung
- In **Shop** einen neuen Tab **„جزیره“** zwischen **Packs** und **Items** einfügen. Icon: `b1.png`.
- Levels, Packs und Items bleiben unverändert.
- Der ganze Tab ist **Persisch, RTL**, mit den Schriften Vazirmatn (Text) und Lalezar (Titel/Zahlen). Buchzahlen in persischen Ziffern, TON-Beträge lateinisch (z. B. `0.2 TON`).

## 2. Aufbau des Tabs (von oben nach unten)
1. **Guthaben-Leiste:** 3 Buch-Bilder mit Anzahl + TON-Logo mit Wallet-Guthaben.
2. **Karte „بیل شما“** (Rahmen in der Farbe der stärksten aktiven Schaufel):
   - großes Bild der stärksten aktiven Schaufel (schwebt leicht), Name (oder `هنوز بیل نداری`)
   - Kräfte als Pillen (aktiv hell, inaktiv blass)
   - kleine Icons aller Schaufeln (nicht besessene grau)
   - Resttage aller aktiven Schaufeln, z. B. `⏳ طلایی: ۱۸ روز · آمتیست: ۳۰ روز`
3. **Reset-Leiste:** `⏰ ریست روزانه` / `هر شب ساعت ۰۰:۰۰ به وقت برلین` + Live-Countdown `HH:MM:SS` bis Mitternacht Berlin.
4. Überschrift `بیل‌ها` + `۳۰ روز تقویمی · قدرت‌ها با هم جمع می‌شوند`
5. **4 Schaufel-Karten im 2er-Raster** (siehe Tabelle unten). Jede Karte enthält:
   - Rahmen und Glow in der Seltenheitsfarbe
   - Bild auf radialem Hintergrund mit langsam drehendem Strahlenkranz
   - Seltenheits-Chip oben rechts, Stufen-Kreis (۱–۴) oben links
   - unten am Bild ein Schild:
     - `✓ فعال · N روز` (besessen)
     - `فقط N عدد باقی` (verfügbar; ab ≤3 rot pulsierend)
     - `تمام شد` (ausverkauft; Bild grau)
   - Name, Wirkungs-Box
   - `👥 فروخته شد X/Limit` mit Balken
   - **nicht besessen:** Preis-Zeile (TON-Logo, Preis, `Guthaben/Preis`, grün wenn genug) + Balken, Button `خرید` / `کافی نیست` / `تمام شد`
   - **besessen:** `امروز X/N جستجو` (grüner Balken; nach Auszahlung `✓ 0.2 TON`), `⏳ N روز باقی · تا <Datum>` (blauer Balken; Datum im persischen Kalender), Button `✓ فعال` (deaktiviert)
6. **Kauf-Bestätigung** (Overlay): Bild, Name, Wirkung, Preis, Buttons `خرید` und `انصراف`. Nach dem Kauf Toast `<Name> خریداری شد! 🎉`.
7. Überschrift `تبادل کتاب` / `کتاب‌های اضافه را عوض کن` + **3 Tauschkarten** (siehe 5.).
8. Fußnote: `کتاب‌ها را در جزیره‌ی چت پیدا می‌کنی 🏝️`

## 3. Schaufeln (verbindlich)
| ID | Name | Bild | Seltenheit / Farbe | Preis | Wirkung | Dauer | Limit |
|---|---|---|---|---|---|---|---|
| s1 | `بیل طلایی` | `sh1.png` | `کمیاب` / gelb `#f2b81c` | **1 TON** | **0.067 TON** pro Tag, sobald der User an dem Tag **15 Suchen** gemacht hat | 30 Kalendertage | **30 User** |
| s2 | `بیل آمتیست` | `sh2.png` | `حماسی` / lila `#b45cff` | **3 TON** | **0.2 TON** pro Tag bei **20 Suchen** | 30 Kalendertage | **20 User** |
| s3 | `بیل آتشین` | `sh3.png` | `افسانه‌ای` / orange `#ff5a1f` | **5 TON** | **0.33 TON** pro Tag bei **30 Suchen** + bei **jeder Suche 1 % Chance auf 0.2 TON** | 30 Kalendertage | **10 User** |
| s4 | `بیل یخی` | `sh4.png` | `اسطوره‌ای` / blau `#38bdf8` | – | `قدرت مخفی…` | – | **nicht kaufbar**: Schloss + `به‌زودی` |

Texte auf den Karten:
- s1: `روزانه 0.067 TON با ۱۵ جستجو · ۳۰ روز`
- s2: `روزانه 0.2 TON با ۲۰ جستجو · ۳۰ روز`
- s3: `هر جستجو شانس 0.2 TON + روزانه 0.33 TON با ۳۰ جستجو · ۳۰ روز`
- **Die 1 % werden den Usern NIRGENDS angezeigt.**

Regeln:
- Ein User kann alle drei gleichzeitig besitzen; alle wirken parallel und zählen **dieselben** Suchen. Beispiel mit allen drei: 15. Suche → +0.067, 20. → +0.2, 30. → +0.33 TON.
- Jeder Tagesbonus wird **einmal pro Tag** ausgezahlt, **sofort** beim Erreichen der Zahl, direkt ins Wallet.
- Die Feuer-Chance (0.2 TON) wird ebenfalls sofort gutgeschrieben.
- Pro Schaufel-Typ kann ein User nur **eine aktive** besitzen. Nach Ablauf kann er sie neu kaufen.
- **Limit** = maximal so viele **gleichzeitig aktive** Besitzer. Läuft eine Schaufel ab, wird der Platz frei.

## 4. Kalender & Reset (Server)
- **Zeitzone immer `Europe/Berlin`** (nicht UTC), damit die Sommer-/Winterzeit stimmt.
- **Tagesreset um 00:00 Berlin:** Suchzähler `searches_today = 0`, Tagesbonus-Flags zurücksetzen.
- **30 Kalendertage:** Der Kauftag ist Tag 1. `expires_on = kauf_datum + 30 Tage` (Berliner Datum). Die Schaufel ist aktiv, solange `heute < expires_on`. Resttage = `expires_on − heute`. Sie läuft um Mitternacht ab, auch wenn der User nicht spielt.
- Eine Suche zählt für den Tag, an dem sie **abgeschlossen** wird.

## 5. Bücher-Tausch
| Tausch | Farbe |
|---|---|
| **50× Buch 1 → 1× Buch 2** | blau |
| **150× Buch 1 → 1× Buch 3** | lila |
| **25× Buch 2 → 1× Buch 3** | lila |

- Jede Karte zeigt: Quellbuch-Bild mit `×Menge`, Pfeil, Zielbuch-Bild mit `×Menge`, den Text `۵۰ نقشه قدیمی ← ۱ دفتر ناخدا`, `داری: X · تا N بار` (bzw. `کافی نیست`) + Balken, Mengenwähler `− N +` und Button `تبادل` / `کافی نیست`.
- Nach dem Tausch: Toast `N <Buchname> گرفتی! 📖`, Kollektion und Online-Badges sofort aktualisieren.
- Hat der User danach **alle 3 Bücher**, wird der normale Gewinn sofort ausgelöst: 0.5 TON, je 1 Buch abziehen, Chat-Nachricht, Toast `🏆 هر ۳ کتاب کامل شد! +0.5 TON`.

## 6. Anzeige im Inselspiel & Online (Design sonst unverändert)
- **Beim Graben:** im goldenen Ring das Bild der stärksten aktiven Schaufel statt der Standard-Schaufel.
- **Hinweiszeile** unter dem großen Button, z. B. `⭐ امروز ۹/۱۵ → 0.067 TON · 💜 امروز ۹/۲۰ → 0.2 TON · 🔥 امروز ۹/۳۰ → 0.33 TON`; nach der Auszahlung `⭐ جایزه‌ی امروز ✓`.
- **Ergebnis-Anzeige:** zusätzliche Zeilen `🔥 بیل آتشین: +0.2 TON` bzw. `⭐ جایزه‌ی روزانه: +0.2 TON`.
- **Chat-Nachrichten** (goldene Karte):
  - `🔥 USER با بیل آتشین 0.2 TON پیدا کرد!`
  - `USER ۳۰ جستجوی امروز را کامل کرد و 0.33 TON جایزه‌ی روزانه گرفت!`
- **Online-Tab:** neben den 3 Buch-Badges, hinter einem senkrechten Strich, die Icons aller aktiven Schaufeln des Users (ca. 28 px).

## 7. Server (Pflicht – nichts davon im Client entscheiden)
Datenmodell (an die bestehende DB anpassen):
```
island_shovels   (id, user_id, type s1|s2|s3, bought_on DATE, expires_on DATE, price_ton, created_at)
island_inventory += searches_today INT, day DATE, bonus_paid_s1/s2/s3 BOOL
island_exchanges (id, user_id, type, qty, books_in, books_out, created_at)
island_payouts   (bestehend) + reason: win|fire_drop|daily_s1|daily_s2|daily_s3
```
Endpunkte:
- `POST /island/shop/buy {type}`: in **einer Transaktion mit Lock**
  - prüfen: nicht schon aktiv, Limit (`count(aktive) < limit`), TON-Guthaben reicht
  - TON abziehen, Schaufel anlegen
  - idempotent: ein Doppelklick darf nicht doppelt kaufen, und zwei User dürfen nicht gleichzeitig den letzten Platz bekommen
- `POST /island/exchange {type, qty}`: Bücher prüfen und tauschen, danach den Gewinn prüfen; alles in einer Transaktion.
- `GET /island/shop`: Guthaben, eigene Schaufeln (Resttage, Tagesfortschritt), verkaufte Anzahl pro Typ, Sekunden bis zum Reset.

Bei der Auflösung jeder Suche (bestehender Job):
1. `searches_today + 1` (vorher Tageswechsel nach Berliner Zeit prüfen)
2. Wenn s3 aktiv: mit sicherem Zufall 1 % → 0.2 TON gutschreiben
3. Für jede aktive Schaufel: wenn `searches_today` die Schwelle erreicht und der Bonus heute noch nicht gezahlt ist, Tagesbonus gutschreiben und das Flag setzen

Außerdem:
- Alle Auszahlungen über die bestehende TON-Wallet-Logik.
- Alles protokollieren.
- Admin-Schalter, um den Shop zu pausieren.

## 8. Dateien
```
assets/sh1.png … sh4.png        Schaufel-Bilder (transparent)
screenshots/1_shop_komplett.png  ganzer Tab
screenshots/2_kauf_bestaetigen.png
screenshots/3_tausch.png
screenshots/4_insel_mit_schaufel.png
screenshots/5_online_schaufeln.png
prototype/index.html            klickbarer Prototyp mit Beispieldaten (Bots simuliert)
```
