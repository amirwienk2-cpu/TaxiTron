# AGENTS.md — Projekt „Zombie Taxi“

## 1. Übersicht & Zielsetzung
- **Projekt:** Mobile Portrait-Runner „Zombie Taxi“
- **Core Loop:** Taxi lenken, Zombies überfahren, Coins/Münzen sammeln, überleben und Upgrades im Shop kaufen.
- **Plattform / Format:** Mobile First (Portrait-Modus, HTML5 Canvas).

---

## 2. Projektstruktur & Wichtige Dateien
- `/index.html`: Hauptdatei für das responsive UI, Layout-Container und Menü-Overlays.
- `/main.js`: Kern-Spiellogik, Canvas-Rendering, Menüsteuerung, Speichersystem (`localStorage`) und Audio-Management.
- `assets/`: Asset-Verzeichnis für Texturen, Sprites und Audio-Dateien.

---

## 3. Medien & Asset-Handhabung
- **Visuelle Assets:**
  - Taxi: `assets/blood-taxi-topdown.webp`
  - Gegner: Zombie- & Brute-Sprites
  - Hintergrund: Asphalt-Textur
- **Audio Assets:**
  - Audio-Dateien liegen unter `assets/audio/`.
  - **Playback-Regel:** Sound-Wiedergabe startet erst nach der ersten Nutzerinteraktion (First Touch / Click).
  - **Mute-Funktion:** Ein Stummschalt-Schalter (Mute Toggle) steht global zur Verfügung.
- **Asset-Inspektion & Kollision:**
  - Asset-Metadaten dienen nur als Orientierung.
  - Bei Bedarf zur exakten visuellen Platzierung `view_asset` nutzen.
  - Maßstab, Hitboxen und Kollisionsgrenzen müssen stets dynamisch aus dem Spielkontext abgeleitet werden.

---

## 4. Steuerung & Navigation
- **In-Game Steuerung:** Touch-Steuerung direkt auf der Straße (horizontal ziehen, um das Taxi zu lenken).
- **Hauptnavigation:** Feste Navigationsleiste mit folgenden Abschnitten:
  - **Home:** Hauptbildschirm / Start
  - **Shop:** Upgrades für das Taxi kaufen
  - **Play:** Spiel starten
  - **Tasks:** Aufgaben & Challenges
  - **Earn:** Belohnungssystem / Bonus-Coins

---

## 5. Systemstatus & Qualitätssicherung
- **ESM-Validierung:** Browser-ESM-Validierung erfolgreich bestanden.
- **Runtime:** Laufzeitstabil ohne Konsolen- oder Startfehler.
