# جزیره کتاب‌ها – Neues Piraten-Design für das Spielfenster

**Diese Version ersetzt das alte Design des Spielfensters (Bottom-Sheet) komplett.**
Spielregeln, Server, Shop und Schaufeln bleiben gleich. Es gibt **eine Regeländerung:** der Gewinn für 3 verschiedene Bücher ist jetzt **0.25 TON** statt 0.5 TON.

Wie es aussehen soll, zeigen die Bilder in `screenshots/`:
- `1_insel_offen.png`: Insel offen
- `2_suche_laeuft.png`: Suche läuft
- `3_insel_zu.png`: Insel zu

Zum Ausprobieren `prototype/index.html` öffnen und im Chat-Header auf den Insel-Button tippen.

---

## 1. Grundaufbau
- Hintergrund: `assets/island/base4.jpg` (**1024 × 1536 px**, `aspect-ratio: 1024/1536`, volle Breite, keine Ränder). **Das Design wird nicht verändert.** Alle wechselnden Texte sind aus dem Bild entfernt und werden live darübergelegt.
- Alle Overlays werden **absolut in Prozent** der Bildfläche positioniert (unten in der Tabelle). Schriftgrößen in `cqw` (Container-Query-Breite), damit alles mit der Breite skaliert.
- Für Grabstellen, Graben und Avatare liegt ein SVG-Overlay mit `viewBox="0 0 1024 1536"` über dem ganzen Bild.
- Schriften: `Lalezar` (Zahlen, Button) und `Vazirmatn` (Text). Zahlen in persischen Ziffern.

## 2. Live-Elemente (Positionen in % von 1024 × 1536)
| Element | left | top | width | height | Inhalt |
|---|---|---|---|---|---|
| Schließen (unsichtbar über dem gemalten ✕) | 3.4% | 1.6% | 9.8% | 6.5% | schließt das Fenster |
| Sucher-Text im Schild oben rechts | 84.6% | 3.78% | 13.2% | 2.21% | `N نفر در حال جستجو` (weiß, ~1.6cqw) |
| Timer im Uhr-Schild | 84.8% | 9.11% | 12.9% | 5.73% | Zeile 1: `تا بسته شدن:` / `تا باز شدن:` (weiß) · Zeile 2: `mm:ss` (gold, Verlauf, ~5.4cqw) |
| Statuszeile (Pille) | 56% | 55.7% | 42% | 2.5% | z. B. `👆 روی یک ✕ بزن یا «بگرد»`, `⛏️ در حال جستجو… ۰۴:۵۹`, Fundergebnis, `جزیره ۱۰ دقیقه بسته است` |
| Roter Button „بگرد“ (Klickfläche) | 4.9% | 58.6% | 50.8% | 7.5% | Text sitzt rechts vom gemalten Schaufel-Icon: innerhalb des Buttons `left 33.8%, width 57.3%`, gelb `#ffd84d` mit dunkelrotem Schatten |
| Buch-Rahmen 1 (rechts, Kronen-Buch) | 68.36% | 68.49% | 28.32% | 17.32% | siehe 3. |
| Buch-Rahmen 2 (Mitte, lila) | 37.11% | 68.49% | 27.54% | 17.32% | siehe 3. |
| Buch-Rahmen 3 (links, blau) | 4.1% | 68.49% | 29.59% | 17.32% | siehe 3. |
| „Insel zu“-Banner | 3% | 21% | 94% | auto | `assets/island/closed.png` (951 × 414); siehe 5. |
| Ergebnis-Anzeige | 1% | 16% | 98% | 41% | gefundenes Buch groß mit Strahlenkranz (wie bisher) |

**Button-Texte:**
- Insel offen: `بگرد`
- Suche läuft: `⛏️ mm:ss` (Countdown, deaktiviert)
- Insel zu: `جزیره بسته است` (deaktiviert, leicht entsättigt)
- Antippen startet die Suche an einer zufälligen ✕-Stelle.

## 3. Kollektion (die drei Rahmen)
Die Bücher sind im Bild schon gemalt. Live wird nur Folgendes ergänzt:
- **Buch fehlt (Anzahl 0):** Über den Rahmen-Inhalt wird die graue Version gelegt (`assets/island/h1.jpg`, `h2.jpg`, `h3.jpg`, exakt auf die Rahmenposition). Darauf steht mittig der Buchname + `؟` (beige, Lalezar).
- **Anzahl ≥ 2:** oben links im Rahmen ein goldenes Schild `×N` (Lalezar, dunkelbraune Schrift, Goldverlauf).
- **Anzahl 1:** nur das gemalte Buch.
- **Neu gefunden:** kurze Pop-Animation des Rahmens.

Zuordnung:
- **rechts = Buch 1 `نقشه قدیمی`** (braun mit Krone, `b1.png`)
- **Mitte = Buch 2 `دفتر ناخدا`** (lila, `b2.png`)
- **links = Buch 3 `کتاب طلایی`** (blau, `b3.png`)

Die Bilder `b1/b2/b3.png` ersetzen die alten Buch-Bilder **überall**: Online-Badges, Shop, Tausch, Chat-Nachrichten, Ergebnis-Anzeige.

## 4. Grabstellen (SVG, Koordinaten in 1024 × 1536)
Die 6 roten ✕ sind ins Bild gemalt. Live kommt pro Stelle eine unsichtbare Klickfläche (Radius ~30) dazu, plus ein pulsierender weiß-goldener Ring, solange man suchen darf.
```
(595,315) Vulkan/Felsen oben
(405,447) Weg links
(622,447) Wasserfall
(858,465) Weg rechts
(115,510) Piratenschiff
(735,718) vor dem Steg
```
- **Beim Graben:** an der Stelle dunkles Loch, goldener Ring füllt sich über die Suchdauer, Bild der aktiven Schaufel (oder Standard-Schaufel) wackelt, Sand fliegt, darüber eine dunkle Timer-Pille `mm:ss`.
- **Andere Sucher:** kleine runde Avatare (Anfangsbuchstabe, Kontur weiß) mit Schaufel auf den Wegen/Stränden, z. B. an
```
(330,420) (470,470) (700,380) (760,430) (890,520) (560,520) (640,700) (800,640) (470,560) (905,440) (690,760) (380,500)
```

## 5. Insel zu
- Über dem Inselbereich (y 240–890) liegt ein dunkles Nacht-Overlay (`#030714`, ca. 70 % → 55 % Deckkraft).
- Das Banner `closed.png` wird mit Ein-/Ausblend-Animation (opacity + scale 0.9 → 1) eingeblendet.
- Im leeren Kasten des Banners steht der Live-Countdown bis zur Öffnung: Position im Banner `left 53.1%, width 22.6%, top 61.1%, height 14.2%`, weiß, Lalezar, ~7cqw, persische Ziffern.
- Timer oben rechts zeigt `تا باز شدن:` + dieselbe Zeit. ✕-Stellen nicht antippbar, Button `جزیره بسته است`.

## 6. Regeländerung Gewinn
- **3 verschiedene Bücher = 0.25 TON** (vorher 0.5). Der Server zahlt 0.25 TON aus und zieht von jedem Buch 1 ab.
- Chat-Texte:
  - `جزیره باز شد! ۳۰ دقیقه وقت دارید، هر ۵ دقیقه یک جستجو. ۳ کتاب متفاوت = 0.25 TON`
  - `🏆 USER هر ۳ کتاب را پیدا کرد و 0.25 TON گرفت!`
- Gilt auch, wenn der Gewinn durch einen Tausch im Shop ausgelöst wird.

## 7. Dateien
```
assets/island/base4.jpg     Hintergrund (Texte entfernt)
assets/island/closed.png    "Insel zu"-Banner (Countdown entfernt, transparent)
assets/island/h1-h3.jpg     graue Rahmen für fehlende Bücher
assets/b1.png b2.png b3.png neue Buch-Badges
screenshots/                Zielbilder
prototype/                  klickbarer Prototyp
```
