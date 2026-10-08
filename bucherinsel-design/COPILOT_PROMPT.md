Das Inselspiel „جزیره کتاب‌ها“ bekommt ein neues Design. Ersetze das alte Design des Spielfensters komplett durch dieses. Spiellogik, Server, Shop und Schaufeln bleiben, wie sie sind.

Im Ordner `bucherinsel-design/` findest du:
- `DESIGN_SPEC.md`: alle Positionen, Texte und Zustände
- `screenshots/`: genau so soll es aussehen (Insel offen, Suche läuft, Insel zu)
- `assets/`: Hintergrund, „Insel zu“-Banner, graue Buch-Rahmen und die neuen Buch-Bilder
- `prototype/index.html`: klickbarer Prototyp

Lies `DESIGN_SPEC.md` komplett und schau dir die Screenshots an. Dann:

1. **Spielfenster 1:1 nach Design:** `assets/island/base4.jpg` als Hintergrund (1024×1536, volle Breite). Alle Live-Elemente kommen absolut in Prozent an die Positionen aus der Spec:
   - Sucher-Zahl
   - Timer
   - Statuszeile
   - roter Button „بگرد“ mit Countdown
   - die drei Buch-Rahmen
   Das Design selbst darf nicht verändert werden.
2. **Grabstellen:** die 6 gemalten ✕ antippbar machen (Koordinaten in der Spec). Graben mit goldenem Ring, Schaufel und Timer an der Stelle, andere Sucher als kleine Avatare.
3. **Kollektion:** Fehlt ein Buch, kommt das graue Overlay (`h1–h3.jpg`) mit Name und „؟“ darüber. Ab 2 Stück erscheint ein goldenes „×N“-Schild. Rechts liegt Buch 1, in der Mitte Buch 2, links Buch 3.
4. **Insel zu:** Nacht-Overlay plus Banner `closed.png` mit Live-Countdown im Kasten. Der Button zeigt „جزیره بسته است“.
5. **Neue Buch-Bilder** `b1/b2/b3.png` überall einsetzen: Online-Badges, Shop, Tausch, Chat, Ergebnis-Anzeige.
6. **Regeländerung:** Der Gewinn für 3 verschiedene Bücher ist jetzt **0.25 TON** statt 0.5 TON, auf dem Server und in allen Texten.

Halte dich an meinen bestehenden Code und meine Komponenten. Sag mir vorher kurz, welche Dateien du änderst.
