# TaxiTron – Telegram Mini App (Frontend)

```
index.html              Seitenstruktur (Tabs + Seiten)
css/style.css           Design, Leiste unten, Flaggen
js/app.js               Tab-Wechsel, Sprache (FA/EN), Countdown
assets/images/          Turnier-Grafik
assets/icons/           Icons der Leiste, Zombie, TT-Logo, Flaggen
```

Lokal testen: `npx serve .` im Ordner ausführen und die angezeigte Adresse öffnen.

- Wochen-Reset: in `js/app.js` über `RESET_DAY` (0 = Sonntag, 1 = Montag …) und `RESET_HOUR` (UTC).
- Texte/Übersetzungen: Objekt `I18N` in `js/app.js`.
- In Telegram: den gehosteten Link (https) im BotFather als Mini-App-URL eintragen.

## Fortschrittsbalken (Home)

Balken und Prozentzahl oben auf Home sind live. Wert von 0–100 setzen:

```js
TT.setProgress(42);   // absolut setzen
TT.addProgress(5);    // +5 addieren
TT.getProgress();     // aktuellen Wert lesen
// aus einem Spiel-iframe:  parent.postMessage({type:'tt-progress', value:42}, '*')
```

Der Wert wird im Browser gespeichert (`tt_progress`). Später vom Server laden: nach `fetch('/api/me')` einfach `TT.setProgress(data.progress)` aufrufen.

## Tasks „Kanal beitreten" (Wallet → Tasks)

Kanäle stehen in der Liste `TASKS` in `js/app.js` (id, `channel`, `reward`, Beschreibungs-Text, Speicher-Key). Aktuell: `@TaxitonWithdraw`, `@TaxiiTon` und `@taxiiiton`.
Alle Kanäle stehen als Zeilen in EINER Karte. Weiteren Kanal hinzufügen = einen Eintrag in `TASKS` ergänzen (neue Zeile erscheint automatisch).

- Der Kanal-Button (Telegram-Icon + @Name) öffnet `https://t.me/<channel>` (in Telegram über `openTelegramLink`).
- „Mitgliedschaft prüfen": bei `TASK.demo=true` gilt die Aufgabe sofort als erledigt (nur zum Testen).
  Für den Live-Betrieb `TASK.demo=false` setzen und `TT.verifyMembership = async (channel) => true/false` bereitstellen,
  das deinen Server fragt (Bot `getChatMember`; der Bot muss im Kanal Admin sein). Die Belohnung bitte auf dem Server gutschreiben;
  danach ruft die Seite `TT.onTaskComplete(id, reward, channel)` auf.
- Jeder Kanal speichert seinen Status einzeln im Browser.

## Task „Freunde einladen" (Wallet → Tasks)

Konfiguration im Block `INVITE` in `js/app.js`:

- `bot`: Benutzername deines Bots. Der persönliche Link ist `https://t.me/<bot>?start=ref_<Telegram-User-ID>`.
  Der Button öffnet den Telegram-Teilen-Dialog mit diesem Link. Den `ref_<id>`-Parameter musst du im Bot/Backend auswerten, um Einladungen zu zählen.
  Eigenen Link setzen: `TT.inviteLink = () => 'https://t.me/...'`.
- `endsAt`: Ende der Kampagne (ISO-Datum). `null` = wöchentlicher Reset wie beim Turnier (Montag 00:00 UTC).
- Die Preise (20/10/5 TON) sind im Bild `assets/images/task-invite.jpg` fest eingemalt.

## Zahlen auf Home ändern

Die Zahlen bei Rekord, Fahrten, Level, Guthaben, „tries left" und der Fortschrittsbalken sind live.
In den Kacheln und im Text wechseln die Ziffern mit der Sprache (Persisch: ۱۲۳, sonst 123). Guthaben und Fortschritt bleiben lateinisch.

```js
TT.setStats({ best: 1200, routes: 8, level: '2-3', levelNo: 2, gram: 0.0012, tonLeft: 1, tries: 5, triesMax: 10, progress: 40 });
```

Alle Felder sind optional. Später vom Server: nach `fetch('/api/me')` einfach `TT.setStats(data)` aufrufen.

## Chat: Online-Nutzer

Oben im Chat steht „Nutzer online: N" und darunter jeder Nutzer einzeln nebeneinander (Avatar mit grünem Punkt + Name, seitlich scrollbar). Ist die Anzahl größer als die Liste, folgt am Ende „+N".
Daten setzen:

```js
TT.setOnline(128);                                   // nur die Anzahl
TT.setOnline(['Ali', 'Sara', 'Max']);                // Liste (Anzahl = Länge)
TT.setOnline({ count: 342, users: ['Ali', 'Sara'] }); // Anzahl + die Namen, die gezeigt werden sollen
```

Die Werte kommen aus deinem Server (z. B. über WebSocket); das Frontend rechnet nicht selbst.

### Admin-Abzeichen im Chat

Rollen-Abzeichen stehen neben dem Namen, in den Chat-Nachrichten und in der Online-Spalte: `boy` und `girl` (Admin) sowie `designer` (GHOST-Abzeichen).

```js
TT.setOnline([{ name: 'TaxiBoss', badge: 'boy' }, { name: 'Sara', badge: 'girl' }, { name: 'Mika', badge: 'designer' }, 'Max']);
TT.addMessage({ name: 'Mika', text: 'Hallo!', badge: 'designer' });   // badge: 'boy' | 'girl' | 'designer' | weglassen (früher: admin)
```

Das Wort im Abzeichen wird übersetzt (ادمین / Admin). Beim Designer steht „GHOST" im Bild. Bilder: `assets/images/adm-boy.png`, `adm-girl.png`, `badge-designer.png`.

## Admin-Funktionen im Chat

Als Admin auf eine Nachricht oder einen User in der Online-Liste tippen → unten öffnet sich ein Fenster mit:

- **چت نکن** – Chat sperren (seine Nachrichten werden ausgeblendet). Danach wird der Button zu **چت بکن** (Sperre aufheben).
- **حذف چت** – alle Nachrichten dieses Users löschen (mit Nachfrage).

Einstellungen im Block `ADMIN` in `js/app.js`:

- `demo:true` → jeder ist Admin (nur zum Testen!). Live: `demo:false` und die Telegram-User-IDs der Admins in `ids:[...]` eintragen.
- Server anbinden: `TT.adminAction = async (action, user) => { … return true; }` – `action` ist `chatOff | chatOn | delete`.
  Der Server muss selbst prüfen, dass der Absender wirklich Admin ist (Telegram-initData), und die Sperre durchsetzen.
- Beim bestraften User: `TT.setMyChatState({banned:true})` sperrt sein Eingabefeld.
- Vom Server Status setzen: `TT.setUserMod('Sara', {banned:true})`, Nachrichten löschen: `TT.deleteUserMessages('Sara')`.
- Bilder: `assets/images/adm-chat-off.png`, `adm-chat-on.png`, `adm-del.png`.

## Antworten (Reply) im Chat

- Auf das kleine ↩ oben in einer Nachricht tippen **oder** die Nachricht zur Seite wischen → über dem Eingabefeld erscheint „Antwort an …“ (✕ bricht ab).
- Die gesendete Nachricht zeigt das Zitat; Tippen auf das Zitat springt zur Original-Nachricht.
- Server: `TT.onSendMessage = ({text, mid, replyTo}) => { … }` wird beim Senden aufgerufen (`replyTo` = `{mid, name, text}` oder `null`).
- Eingehende Antwort anzeigen: `TT.addMessage({name:'Sara', text:'Ja!', mid:'42', reply:{mid:'41', name:'Ali', text:'Jemand da?'}})`.

## Suche in der Online-Liste (Chat)

- Suchfeld oben in der Online-Spalte filtert die User beim Tippen nach Namen (Groß/klein egal, ی/ي und ک/ك gleich, persische Ziffern gehen auch). Esc oder ✕ leert die Suche.
- Optional Server-Suche (für User, die nicht in der Liste stehen): `TT.searchOnline = async (q) => [{name:'Sara'}, …]`.

## Eigene Nachricht bearbeiten (Chat)

- Eigene Nachrichten haben ein ✏️ neben dem ↩. Antippen → der Text kommt ins Eingabefeld, oben steht „ویرایش پیام“, der Button heißt „ذخیره“ (Speichern). ✕ oder Esc bricht ab.
- Nach dem Speichern steht unter der Nachricht „ویرایش شد“ (bearbeitet); Zitate dieser Nachricht in Antworten werden mit aktualisiert.
- Server: `TT.onEditMessage = ({mid, text}) => { … }`. Bearbeitung von anderen anzeigen: `TT.editMessage(mid, 'neuer Text')`.

## Emoji-Reaktionen (Chat)

- Jede Nachricht hat ein ☺ neben dem ↩ – antippen (oder Nachricht kurz gedrückt halten) → Leiste mit 👍 ❤️ 😂 😮 😢 🔥 👏 😡.
- Reaktionen erscheinen als kleine Chips unter der Nachricht mit Anzahl; die eigene ist gelb. Chip antippen = mit diesem Emoji reagieren, nochmal = entfernen. Pro User eine Reaktion pro Nachricht.
- Emojis ändern: Liste `RX_EMOJIS` in `js/app.js`.
- Server: `TT.onReact = ({mid, emoji, on}) => { … }`. Vom Server setzen: `TT.setReactions(mid, {'👍':3,'❤️':1}, '👍')`.
- Die Demo-Reaktionen auf den Beispiel-Nachrichten (Block „demo reactions“) später löschen.

## Datum + Uhrzeit unter jeder Nachricht (Chat)

- Jede Nachricht zeigt unten Datum und Uhrzeit (Farsi: persischer Kalender, z. B. ۱۴۰۵/۰۶/۲۹ ۱۴:۳۲; Deutsch: 20.09.2026 14:32; Englisch: 20/09/2026 14:32). Wechselt mit der Sprache.
- Eigene Nachrichten bekommen die Sendezeit automatisch. Bearbeitete zeigen zusätzlich „ویرایش شد“ davor.
- Vom Server: `TT.addMessage({name:'Sara', text:'Hi', time:'2026-09-20T14:32:00Z'})` (ISO-Text oder Millisekunden).

## Wallet: Zombies gegen Münzen tauschen

- Karte oben in Wallet: links gesammelte Zombies (noch nicht getauscht), rechts wie viele Münzen es dafür gibt, darunter der Button „معاوضه“ und das Münz-Guthaben.
- Kurs: `EX.rate` in `js/app.js` (jetzt 100 Münzen pro Zombie; Anleitungstext ebenfalls auf 100 geändert).
- Demo-Startwert 10000 Zombies (im Browser gespeichert: `tt_zombies`, `tt_coins`).
- Live: `TT.setWallet({zombies, coins})` nach dem Laden vom Server; Tausch über `TT.exchange = async (zombies) => ({zombies:0, coins:neuesGuthaben})` – der Server rechnet, nicht die Seite.
- `TT.addZombies(n)` fügt Zombies hinzu (Task-Belohnungen machen das schon automatisch).
- Bilder: `assets/images/ex-art.jpg`, `ex-zombie.png`, `ex-coin.png`.

## Wallet: TON einzahlen

- Karte unter dem Zombie-Tausch: Adresse + „کپی آدرس“, Memo-Code, Feld für die Transaktions-ID + „بررسی واریز“, Hinweis.
- **Adresse eintragen:** in `js/app.js` → `DEPOSIT.address = 'UQ…'` (deine echte Adresse aus Tonkeeper!) oder `TT.setDeposit({address:'UQ…'})`. Ohne Adresse zeigt die Karte „آدرس هنوز تنظیم نشده“ und Kopieren ist gesperrt.
- Memo = `TT` + Telegram-User-ID (z. B. TT6003831978). Antippen kopiert den Code. Damit ordnet dein Server die Einzahlung dem Spieler zu.
- Prüfen: `TT.checkDeposit = async (hash, memo) => ({ok:true, amount:1.5})` – der Server sucht die Transaktion (z. B. über toncenter) und schreibt das Guthaben gut.
- Bild: `assets/images/dep-art.jpg`.

## Wallet: TON auszahlen (Withdraw)

- Oben im zweiten Rahmen umschalten: „واریز“ (Einzahlen) / „برداشت“ (Auszahlen).
- Auszahlen: TON-Adresse + Betrag (MAX-Button), Anzeige „Du erhältst … TON“ nach 1 % Gebühr, Button „درخواست برداشت“, darunter Mindestbetrag, gekürzte Adresse, Status (بدون درخواست / در حال بررسی / انجام شد / رد شد).
- Prüft: gültige TON-Adresse (UQ…/EQ…), Mindestbetrag, genug Guthaben.
- Einstellungen im Block `WD` in `js/app.js`: `min` (1 TON), `fee` (0.01 = 1 %).
- Live: `TT.setWithdraw({balance, status})` vom Server; `TT.requestWithdraw = async ({address, amount, fee, receive}) => ({ok:true, balance, status:'pending'})`.
  **Der Server muss Guthaben prüfen und die TON selbst senden** – der Seite nie vertrauen.
- Bild: `assets/images/wd-art.jpg`.
