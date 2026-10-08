Baue das Chat-Spiel „جزیره کتاب‌ها“ (Bücherinsel) in meiner TaxiTon Mini-App fertig, und zwar **exakt** in dem Style, den ich dir mitgebe. Diese Version ersetzt alle früheren Versionen von Spiel, Design, Shop, Bubble und Header-Button.

Im Ordner `bucherinsel-final/` findest du:
- `MASTER_SPEC.md`: die **einzige gültige Spezifikation** (Regeln, Positionen, Texte, Farben, Shop, Server)
- `screenshots/`: 11 Zielbilder; **genau so muss es am Ende aussehen**
- `assets/`: alle Bilder (Hintergrund, Banner, Bubble, Icon, Bücher, Schaufeln)
- `prototype/index.html`: klickbarer Prototyp, öffne ihn und probier alles aus

So gehst du vor:
1. Lies `MASTER_SPEC.md` komplett. Öffne den Prototyp und schau dir **jeden** Screenshot an.
2. Sag mir, bevor du anfängst, kurz, welche Dateien du anlegst oder änderst und wo die TON-Auszahlung angeschlossen wird.
3. Baue alles nach der Spec:
   - Header-Button
   - Spielfenster (offen, Suche läuft, zu = komplett schwarz mit Banner, öffnet = Banner 3,5 s)
   - Kollektion, Online-Tab, Fund-Bubble im Chat
   - Shop-Tab „جزیره“ mit Schaufeln, Limits, Berliner Kalender und Tausch
   - Server-Logik
4. Halte dich an diese **Style-Regeln**:
   - Die gelieferten Bilder werden **1:1** verwendet. Nichts nachzeichnen, umfärben, beschneiden oder mit CSS nachbauen.
   - Live-Texte kommen **absolut in Prozent** genau an die Positionen aus der Spec, mit Schrift in `cqw`.
   - Schriften Lalezar, Vazirmatn und Lilita One, persische Ziffern. Farben genau wie in der Spec.
   - Nichts darf aus den gemalten Schildern oder Buttons herauslaufen. Wenn etwas nicht passt, nur die Schrift kleiner machen.
   - Oben im Spielfenster steht nur „N نفر“, ohne Such-Timer. Den Countdown gibt es **nur** im roten Button (mit „در حال جستجو“ darüber). Auf der Insel gibt es **keine** Avatare oder Namen anderer User und keinen Timer über der Grabstelle.
   - Prozent-Chancen werden **nirgends** angezeigt.
5. Zufall, Zeit, Inventar, Limits, Käufe, Tausch und Auszahlungen laufen **nur auf dem Server**, transaktionssicher und idempotent. Zeitzone für alle Tage und Resets ist `Europe/Berlin`.
6. **Prüfe dich am Ende selbst:** Mach Screenshots von deinem Ergebnis in denselben 11 Zuständen und vergleiche sie Bild für Bild mit `screenshots/`. Korrigiere jede Abweichung bei Position, Größe, Farbe, Text oder Umbruch, bevor du fertig meldest.

Halte dich an meinen bestehenden Code und meine Komponenten, ändere aber nichts außerhalb dieses Spiels.
