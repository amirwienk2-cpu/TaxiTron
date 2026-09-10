# Coin Runner 3D – aufgeteilte Version

Die App ist jetzt in mehrere Dateien aufgeteilt (Shop, Wallet, Spiel usw. getrennt),
funktioniert aber weiterhin exakt wie vorher als **eine zusammenhängende App**.

## Struktur

```
index.html          Grundgerüst (HTML), bindet alle Dateien ein
style.css            Alle Styles
js/i18n.js           Übersetzungen (EN/FA) + Sprachumschaltung
js/store.js          Spielstand / localStorage / tägliche Resets
js/shop.js           Zombie-Gear-Shop + Taxi-Skin-Shop
js/tournament.js     Turnier / Bestenliste
js/wallet.js         Wallet: Server-Sync, Deposit, Withdraw, Exchange
js/navigation.js     Bildschirmwechsel (Home/Shop/Spiel/Turnier/Wallet)
js/game.js           Das eigentliche 3D-Spiel (Three.js)
js/main.js           Start des Spiels (wird zum Schluss geladen)
```

## Wichtig zum Verständnis

Die Dateien in `js/` teilen sich **einen gemeinsamen globalen Gültigkeitsbereich**
(so wie vorher alles in einer `<script>`-Datei). Sie müssen deshalb **genau in
dieser Reihenfolge** geladen werden – das ist in `index.html` bereits so
eingetragen und sollte nicht geändert werden.

## Hochladen auf GitHub

1. Neues Repository anlegen (z. B. `coin-runner-3d`).
2. Diesen kompletten Ordnerinhalt (index.html, style.css, js/-Ordner) hochladen,
   die Ordnerstruktur dabei beibehalten.
3. Falls du GitHub Pages nutzen willst: In den Repo-Einstellungen unter
   „Pages“ den `main`-Branch als Quelle wählen. Danach ist die App unter
   `https://<dein-username>.github.io/coin-runner-3d/` erreichbar.

## Etwas ändern

- Nur der Shop soll geändert werden? → nur `js/shop.js` bearbeiten.
- Nur das Wallet? → nur `js/wallet.js` bearbeiten.
- Das Spiel selbst (Three.js-Logik) steckt komplett in `js/game.js`.

Die Datei wurde 1:1 aus deiner ursprünglichen Datei extrahiert (geprüft per
Diff) – es wurde nichts am Code selbst verändert, nur aufgeteilt.
