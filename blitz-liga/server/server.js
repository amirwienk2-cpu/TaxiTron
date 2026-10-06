// Beispiel-Backend für die Blitz-Liga (Node.js + Express, speichert in data.json).
// Ersetzt die claude.ai-Speicherung. Für Produktion: echte Datenbank + echte Anmeldung.
const express = require("express");
const fs = require("fs");
const path = require("path");
const core = require("./liga-core");

const app = express();
app.use(express.json({ limit: "64kb" }));
const DATA = path.join(__dirname, "data.json");
let db = { users: {}, payouts: [], paidSeasons: [] };
try { db = JSON.parse(fs.readFileSync(DATA, "utf8")); } catch (e) {}
const persist = () => fs.writeFileSync(DATA, JSON.stringify(db));

// TODO: echte Anmeldung. Bei Telegram: initData im Header schicken und serverseitig per HMAC prüfen.
function auth(req, res, next) {
  const uid = req.get("X-User-Id");
  const name = req.get("X-User-Name") || "";
  if (!uid) return res.status(401).json({ error: "not logged in" });
  req.uid = String(uid);
  db.users[req.uid] = db.users[req.uid] || { name, tips: {}, won: 0, paid: {} };
  if (name) db.users[req.uid].name = name;
  next();
}

app.get("/api/time", (req, res) => res.json({ now: Date.now() }));

app.get("/api/me", auth, (req, res) => {
  const u = db.users[req.uid];
  res.json({ uid: req.uid, doc: { tips: u.tips, paid: u.paid, won: u.won } });
});

// Tipp speichern – nur Über/Unter, nur während der offenen Tippphase, Zeitstempel vom Server
app.put("/api/me", auth, (req, res) => {
  const u = db.users[req.uid];
  const c = core.clock(Date.now());
  const sent = (req.body && req.body.tips) || {};
  const t = sent[c.id];
  if (c.ph === "tips") {
    if (t && (t.ou === "over" || t.ou === "under")) {
      const old = u.tips[c.id];
      u.tips[c.id] = { ou: t.ou, ts: old && old.ou === t.ou ? old.ts : Date.now() };
    } else if (!t) delete u.tips[c.id];
  }
  // alte Tipps aufräumen (die letzten 30 behalten)
  const keys = Object.keys(u.tips).map(Number).sort((a, b) => b - a);
  for (const k of keys.slice(30)) delete u.tips[k];
  persist();
  res.json({ ok: true, doc: { tips: u.tips, paid: u.paid, won: u.won } });
});

// Alle Tipps (für Tabelle + "So tippt der Chat")
app.get("/api/docs", auth, (req, res) => {
  const docs = {}, names = {};
  for (const [id, u] of Object.entries(db.users)) {
    docs[id] = { tips: u.tips, paid: u.paid, won: u.won };
    names[id] = u.name || "";
  }
  res.json({ docs, names });
});

// Saison-Auszahlung: läuft jede Minute, schreibt Gewinne in db.payouts (Auszahlung per TON-Wallet erledigt euer System)
function settleSeasons() {
  const now = Date.now(), c = core.clock(now), S = core.seasonOf(c.id);
  const lastMatchDone = c.id === core.firstOf(S) + core.SEASON - 1 && c.ph === "post";
  const done = lastMatchDone ? S : S - 1;
  if (db.paidSeasons.includes(done)) return;
  const docs = {};
  for (const [id, u] of Object.entries(db.users)) docs[id] = { tips: u.tips };
  const rows = core.table(done, docs, now);
  for (const r of rows.slice(0, 10)) {
    const ton = core.PRIZES[r.rank - 1];
    const u = db.users[r.id];
    u.won = Math.round(((u.won || 0) + ton) * 10) / 10;
    u.paid[done] = ton;
    db.payouts.push({ season: done, uid: r.id, rank: r.rank, points: r.pts, ton, status: "pending", at: now });
  }
  db.paidSeasons.push(done);
  db.paidSeasons = db.paidSeasons.slice(-50);
  persist();
  console.log(`Saison ${done} abgerechnet:`, rows.slice(0, 10).map(r => `${r.rank}. ${r.id} ${r.pts}P`).join(", "));
}
setInterval(settleSeasons, 30000);

app.use(express.static(path.join(__dirname, "..")));
app.listen(process.env.PORT || 3000, () => console.log("Blitz-Liga läuft auf Port", process.env.PORT || 3000));
