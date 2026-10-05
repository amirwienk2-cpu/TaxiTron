// fishing.js – Zombie-Baby-Angeln (Server-Teil), gemeinsame Runden
// ------------------------------------------------------------
// Ablauf jeder Runde (alle 2 Minuten):
//   0–15 s : Babys schwimmen, alle werfen ihre Angel aus (Teilnahme)
//   ab 15 s: Server zieht für ALLE gleichzeitig die Gewinne und schreibt sie gut
//   danach : jeder sieht sein Baby + wie viele Leute was gezogen haben
//
// Einbinden in server.js (Express):
//
//   const path = require('path');
//   const registerFishing = require('./fishing');
//   registerFishing(app, {
//     botToken: process.env.BOT_TOKEN,
//     // currency ist 'TT' oder 'TON'
//     credit: async (telegramUserId, currency, amount, meta) => {
//       // z.B. await db.addBalance(telegramUserId, currency, amount, meta);
//     },
//   });
//   app.get('/angeln', (req, res) =>
//     res.sendFile(path.join(__dirname, 'public', 'zombie-angeln.html')));
// ------------------------------------------------------------

const crypto = require('crypto');

const DEFAULTS = {
  ROUND_EVERY_MS: 2 * 60 * 1000, // alle 2 Minuten eine Runde
  CAST_WINDOW_MS: 15 * 1000,     // 15 s Zeit zum Angel-Werfen
  SHOW_MS: 45 * 1000,            // bis hier bleiben Babys + Ergebnis sichtbar
  MAX_CATCHES_PER_DAY: 20,       // Teilnahmen pro User und Tag (UTC)
  MAX_TON_WINS_PER_USER_DAY: 1,  // max. TON-Gewinne pro User und Tag
  MAX_TON_PER_DAY: 2.0,          // TON-Budget für alle User zusammen pro Tag
  PRIZES: [
    { id: 'sleep', currency: 'TT',  amount: 250,  weight: 43 },
    { id: 'love',  currency: 'TT',  amount: 100,  weight: 28 },
    { id: 'cry',   currency: 'TT',  amount: 500,  weight: 17 },
    { id: 'arms',  currency: 'TT',  amount: 1500, weight: 10 },
    { id: 'punch', currency: 'TON', amount: 0.5,  weight: 2 },  // 2 %
  ],
};

function verifyInitData(initData, botToken, maxAgeSec = 86400) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (Date.now() / 1000 - authDate > maxAgeSec) return null;
  try { return JSON.parse(params.get('user')); } catch { return null; }
}

function pick(pool) {
  const total = pool.reduce((s, p) => s + p.weight, 0);
  let r = crypto.randomInt(0, total);
  for (const p of pool) { if (r < p.weight) return p; r -= p.weight; }
  return pool[pool.length - 1];
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Achtung: nur im Arbeitsspeicher – nach einem Railway-Neustart sind die
// Tageszähler weg. Für Echtgeld besser eigenen store (DB) übergeben.
function memoryStore() {
  const users = new Map();
  const global = new Map();
  return {
    async getUser(uid, day) {
      return users.get(`${day}:${uid}`) || { catches: 0, tonWins: 0 };
    },
    async saveUser(uid, day, data) { users.set(`${day}:${uid}`, data); },
    async getGlobal(day) { return global.get(day) || { tonPaid: 0 }; },
    async saveGlobal(day, data) { global.set(day, data); },
  };
}

module.exports = function registerFishing(app, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts.config || {}) };
  if (!opts.botToken) throw new Error('fishing: botToken fehlt');
  if (typeof opts.credit !== 'function') throw new Error('fishing: credit() fehlt');
  const store = opts.store || memoryStore();

  const roundOf = (t) => Math.floor(t / cfg.ROUND_EVERY_MS);
  const roundStart = (id) => id * cfg.ROUND_EVERY_MS;
  const windowEnd = (id) => roundStart(id) + cfg.CAST_WINDOW_MS;
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
  const publicPrize = (p) => p && ({ id: p.id, currency: p.currency, amount: p.amount });

  // roundId -> { participants: Set, resolving: Promise|null, results: Map, counts: {} }
  const rounds = new Map();
  const getRound = (id) => {
    if (!rounds.has(id)) rounds.set(id, { participants: new Set(), resolving: null, results: null, counts: null });
    return rounds.get(id);
  };

  async function resolveRound(id) {
    const r = getRound(id);
    if (r.resolving) return r.resolving;
    r.resolving = (async () => {
      const day = dayOf(roundStart(id));
      const results = new Map();
      const counts = Object.fromEntries(cfg.PRIZES.map((p) => [p.id, 0]));
      // Zufällige Reihenfolge, damit das TON-Budget fair verteilt wird
      for (const uid of shuffle([...r.participants])) {
        let prize = null;
        try {
          const s = await store.getUser(uid, day);
          const g = await store.getGlobal(day);
          const pool = cfg.PRIZES.filter((p) =>
            p.currency !== 'TON' ||
            (s.tonWins < cfg.MAX_TON_WINS_PER_USER_DAY && g.tonPaid + p.amount <= cfg.MAX_TON_PER_DAY));
          prize = pick(pool);
          if (prize.currency === 'TON') {
            await store.saveUser(uid, day, { ...s, tonWins: s.tonWins + 1 });
            await store.saveGlobal(day, { tonPaid: g.tonPaid + prize.amount });
          }
          results.set(uid, prize);
          counts[prize.id]++;
          await opts.credit(uid, prize.currency, prize.amount, { game: 'zombie_fishing', round: id, prizeId: prize.id });
        } catch (e) {
          // Hier steht, wem was fehlt, falls die Gutschrift scheitert.
          console.error('[fishing] credit FAILED', { uid, round: id, prize: publicPrize(prize) }, e);
        }
      }
      r.results = results;
      r.counts = counts;
    })();
    return r.resolving;
  }

  // Jede Sekunde: Runden mit abgelaufener Wurfzeit ziehen, alte aufräumen
  setInterval(() => {
    const now = Date.now();
    for (const [id, r] of rounds) {
      if (!r.resolving && now >= windowEnd(id) && r.participants.size) resolveRound(id);
      if (id < roundOf(now) - 5) rounds.delete(id);
    }
  }, 1000).unref?.();

  function auth(req, res) {
    const user = verifyInitData(req.get('X-Telegram-Init-Data') || '', opts.botToken);
    if (!user || !user.id) { res.status(401).json({ error: 'auth' }); return null; }
    return String(user.id);
  }

  app.get('/api/fishing/state', async (req, res) => {
    const uid = auth(req, res); if (!uid) return;
    try {
      const now = Date.now();
      const id = roundOf(now);
      const r = rounds.get(id);
      const s = await store.getUser(uid, dayOf(now));
      res.json({
        serverNow: now,
        everyMs: cfg.ROUND_EVERY_MS,
        castMs: cfg.CAST_WINDOW_MS,
        showMs: cfg.SHOW_MS,
        roundId: id,
        casters: r ? r.participants.size : 0,
        castThisRound: !!(r && r.participants.has(uid)),
        catchesLeftToday: Math.max(0, cfg.MAX_CATCHES_PER_DAY - s.catches),
        prizes: cfg.PRIZES.map(publicPrize),
      });
    } catch (e) {
      console.error('[fishing] state', e);
      res.status(500).json({ error: 'server' });
    }
  });

  app.post('/api/fishing/cast', async (req, res) => {
    const uid = auth(req, res); if (!uid) return;
    try {
      const now = Date.now();
      const id = roundOf(now);
      if (now >= windowEnd(id)) return res.status(409).json({ error: 'round_closed' });
      const r = getRound(id);
      if (r.participants.has(uid)) return res.status(409).json({ error: 'already_cast' });
      const day = dayOf(roundStart(id));
      const s = await store.getUser(uid, day);
      if (s.catches >= cfg.MAX_CATCHES_PER_DAY) return res.status(409).json({ error: 'daily_limit' });
      if (r.participants.has(uid)) return res.status(409).json({ error: 'already_cast' }); // Doppelklick
      r.participants.add(uid);
      await store.saveUser(uid, day, { ...s, catches: s.catches + 1 });
      res.json({
        roundId: id,
        casters: r.participants.size,
        catchesLeftToday: Math.max(0, cfg.MAX_CATCHES_PER_DAY - s.catches - 1),
      });
    } catch (e) {
      console.error('[fishing] cast', e);
      res.status(500).json({ error: 'server' });
    }
  });

  app.get('/api/fishing/result', async (req, res) => {
    const uid = auth(req, res); if (!uid) return;
    try {
      const id = Number(req.query.roundId);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'server' });
      if (Date.now() < windowEnd(id)) return res.status(425).json({ error: 'not_yet' });
      const r = rounds.get(id);
      if (!r || !r.participants.size) return res.json({ prize: null, participants: 0, counts: {} });
      await resolveRound(id);
      res.json({
        prize: publicPrize(r.results.get(uid)) || null,
        participants: r.participants.size,
        counts: r.counts,
      });
    } catch (e) {
      console.error('[fishing] result', e);
      res.status(500).json({ error: 'server' });
    }
  });
};

module.exports.verifyInitData = verifyInitData;
module.exports.DEFAULTS = DEFAULTS;
