Baue in meine TaxiTon Mini-App das Chat-Spiel „جزیره کتاب‌ها“ (Bücherinsel) ein.

Im Ordner `bucherinsel/` findest du:
- `SPEC.md`: die verbindlichen Spielregeln, Server-Logik, Datenmodell, UI-Positionen und Texte
- `prototype/index.html`: ein klickbarer Prototyp, der genau zeigt, wie es aussehen und funktionieren soll (die Mitspieler darin sind nur simuliert)
- `prototype/b1.png`, `b2.png`, `b3.png`, `prototype/island/*.jpg`: alle Bilder

Lies zuerst `SPEC.md` komplett und öffne den Prototyp. Danach:

1. **Server:** Baue die komplette Spiellogik in meinem bestehenden Backend, nicht im Client:
   - Rundenplan: 30 Min. offen, 10 Min. zu
   - Suchen à 5 Min., max. eine aktive Suche pro User
   - Zufall serverseitig: Buch 1 = 70 %, Buch 2 = 10 %, Buch 3 = 2 %, nichts = 18 %; erst nach Ablauf der 5 Min. würfeln
   - Inventar mit Zählern, doppelte Bücher zählen
   - Gewinn bei mindestens 1 von jedem Buch: 0,5 TON über meine bestehende TON-Auszahlungslogik, danach von jedem Buch 1 abziehen
   - Transaktionen idempotent, Rate-Limit
   - Echtzeit-Events über meinen bestehenden Chat-Websocket
2. **Chat-Header:** Setze den Insel-Button neben den Schloss-Button. Das Schloss bleibt nur für Admins; den Insel-Button sehen alle. Er zeigt die Restminuten oder `بسته`.
3. **Spielfenster:** Baue es als Bottom-Sheet **1:1 wie im Prototyp**: `island/base2.jpg` als Hintergrund, die Live-Elemente genau an den Prozent-Positionen aus `SPEC.md`. Das Design darf nicht verändert werden.
4. **Online-Tab:** Neben jedem Usernamen kommen die 3 Buch-Badges (grau, wenn nicht vorhanden, mit Zahl ab 2), dazu die Statuszeile (sucht gerade mit Countdown, letzter Fund oder Gewinn).
5. **Chat-Systemnachrichten:** Insel öffnet (mit Button „🔍 برو به جزیره“), Insel schließt, Fund von Buch 2/3, Gewinn. Texte stehen in `SPEC.md`.
6. Alle Texte auf Persisch, Zahlen in persischen Ziffern, Schriften Lalezar und Vazirmatn.

Halte dich an meinen vorhandenen Code-Stil, meine Ordnerstruktur und meine vorhandenen Komponenten. Sag mir vor dem Umsetzen kurz, welche Dateien du anlegst oder änderst und wo die TON-Auszahlung angeschlossen wird.
