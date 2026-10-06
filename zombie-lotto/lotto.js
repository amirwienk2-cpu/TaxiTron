// lotto.js – Zombie-Lotto 6 aus 49 (Server-Teil)
// ------------------------------------------------------------
// Ablauf:
//   - Alle 10 Minuten eine Ziehung, Teilnahme kostenlos
//   - Jeder User tippt 6 aus 49 (1 Tipp pro Ziehung)
//   - 30 Sekunden vor der Ziehung ist Annahmeschluss
//   - Der Server zieht 6 Zahlen, wertet alle Tipps aus und schreibt
//     die Gewinne gut
//   - Alle sehen, wer welche Zahlen getippt hat (Telegram-Name) und
//     wer wie viele Richtige hatte / was gewonnen hat
//
// Einbinden in server.js (Express, nach app.use(express.json())):
//
//   const path = require('path');
//   const registerLotto = require('./lotto');
//   registerLotto(app, {
//     botToken: process.env.BOT_TOKEN,
//     credit: async (telegramUserId, currency, amount, meta) => {
//       // bestehende Balance-Funktion aufrufen (currency 'TON' oder 'TT')
//     },
//   });
//   app.get('/lotto', (req, res) =>
//     res.sendFile(path.join(__dirname, 'public', 'zombie-lotto.html')));
// ------------------------------------------------------------

const crypto = require('crypto');

const DEFAULTS = {
  DRAW_EVERY_MS: 10 * 60 * 1000, // alle 10 Minuten eine Ziehung
  CLOSE_BEFORE_MS: 30 * 1000,    // Annahmeschluss 30 s vor der Ziehung
  NUMBERS: 49,
  PICK: 6,
  MAX_LIST: 300,                 // max. Einträge in der öffentlichen Tippliste
  // Gewinn nach Anzahl Richtiger. currency 'TON' oder 'TT'.
  PRIZES: {
    2: { currency: 'TON', amount: 0.05 },
    3: { currency: 'TON', amount: 0.5 },
    4: { currency: 'TON', amount: 2 },
    5: { currency: 'TON', amount: 10 },
    6: { currency: 'TON', amount: 50 },
  },
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

function drawNumbers(max, count) {
  const pool = Array.from({ length: max }, (_, i) => i + 1);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count); // Reihenfolge = Ziehungsreihenfolge
}

module.exports = function registerLotto(app, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts.config || {}) };
  if (!opts.botToken) throw new Error('lotto: botToken fehlt');
  if (typeof opts.credit !== 'function') throw new Error('lotto: credit() fehlt');

  const drawIdOf = (t) => Math.floor(t / cfg.DRAW_EVERY_MS);
  const drawAt = (id) => (id + 1) * cfg.DRAW_EVERY_MS;
  const isOpen = (t) => t < drawAt(drawIdOf(t)) - cfg.CLOSE_BEFORE_MS;
  const prizeFor = (m) => (cfg.PRIZES[m] ? { ...cfg.PRIZES[m] } : null);

  // drawId -> { tickets: Map(uid -> [zahlen]), resolving, numbers, results: Map, counts }
  // Achtung: nur im Arbeitsspeicher. Bei einem Neustart vor der Ziehung
  // gehen die Tipps dieser Ziehung verloren.
  const draws = new Map();
  let lastResolvedId = -1;
  const getDraw = (id) => {
    if (!draws.has(id)) draws.set(id, { tickets: new Map(), resolving: null, numbers: null, results: null, counts: null });
    return draws.get(id);
  };

  async function resolveDraw(id) {
    const d = getDraw(id);
    if (d.resolving) return d.resolving;
    d.resolving = (async () => {
      const numbers = drawNumbers(cfg.NUMBERS, cfg.PICK);
      const set = new Set(numbers);
      const results = new Map();
      const counts = Object.fromEntries(Array.from({ length: cfg.PICK + 1 }, (_, i) => [i, 0]));
      for (const [uid, t] of d.tickets) {
        const ticket = t.numbers;
        const matches = ticket.filter((n) => set.has(n)).length;
        const prize = prizeFor(matches);
        results.set(uid, { matches, prize });
        counts[matches]++;
        if (prize) {
          try {
            await opts.credit(uid, prize.currency, prize.amount, { game: 'lotto', draw: id, matches });
          } catch (e) {
            console.error('[lotto] credit FAILED', { uid, draw: id, matches, prize }, e);
          }
        }
      }
      d.numbers = numbers;
      d.results = results;
      d.counts = counts;
      if (id > lastResolvedId) lastResolvedId = id;
      console.log(`[lotto] Ziehung ${id}: ${numbers.join(', ')} – ${d.tickets.size} Tipps`);
    })();
    return d.resolving;
  }

  // Jede Sekunde: fällige Ziehungen auswerten, alte aufräumen
  setInterval(() => {
    const now = Date.now();
    for (const [id, d] of draws) {
      if (!d.resolving && now >= drawAt(id)) resolveDraw(id);
      if (id < drawIdOf(now) - 3) draws.delete(id);
    }
  }, 1000).unref?.();

  function authUser(req, res) {
    const user = verifyInitData(req.get('X-Telegram-Init-Data') || '', opts.botToken);
    if (!user || !user.id) { res.status(401).json({ error: 'auth' }); return null; }
    return user;
  }
  function auth(req, res) { const u = authUser(req, res); return u ? String(u.id) : null; }
  function displayName(u) {
    const full = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
    const name = full || (u.username ? '@' + u.username : 'User ' + String(u.id).slice(-4));
    return name.length > 22 ? name.slice(0, 21) + '…' : name;
  }
  // Öffentliche Liste: wer hat welche Zahlen (ohne Telegram-ID)
  function playerList(d, me, withResult) {
    const list = [...d.tickets].map(([uid, t]) => {
      const row = { name: t.name, numbers: t.numbers, me: uid === me };
      if (withResult && d.results) {
        const r = d.results.get(uid);
        row.matches = r ? r.matches : 0;
        row.prize = r ? r.prize : null;
      }
      return row;
    });
    if (withResult) list.sort((a, b) => b.matches - a.matches || (b.me - a.me));
    else list.sort((a, b) => b.me - a.me);
    return list.slice(0, cfg.MAX_LIST);
  }

  function publicResult(id, uid) {
    const d = draws.get(id);
    if (!d || !d.numbers) return null;
    const r = d.results.get(uid);
    return {
      drawId: id,
      numbers: d.numbers,
      ticket: d.tickets.has(uid) ? d.tickets.get(uid).numbers : null,
      matches: r ? r.matches : null,
      prize: r ? r.prize : null,
      participants: d.tickets.size,
      counts: d.counts,
      players: playerList(d, uid, true),
    };
  }

  app.get('/api/lotto/state', (req, res) => {
    const uid = auth(req, res); if (!uid) return;
    const now = Date.now();
    const id = drawIdOf(now);
    const d = draws.get(id);
    res.json({
      serverNow: now,
      everyMs: cfg.DRAW_EVERY_MS,
      closeMs: cfg.CLOSE_BEFORE_MS,
      numbers: cfg.NUMBERS,
      pick: cfg.PICK,
      drawId: id,
      participants: d ? d.tickets.size : 0,
      myTicket: d && d.tickets.has(uid) ? d.tickets.get(uid).numbers : null,
      players: d ? playerList(d, uid, false) : [],
      prizes: cfg.PRIZES,
      last: lastResolvedId >= 0 ? publicResult(lastResolvedId, uid) : null,
    });
  });

  app.post('/api/lotto/ticket', (req, res) => {
    const user = authUser(req, res); if (!user) return;
    const uid = String(user.id);
    const now = Date.now();
    if (!isOpen(now)) return res.status(409).json({ error: 'closed' });
    const nums = Array.isArray(req.body && req.body.numbers) ? req.body.numbers.map(Number) : [];
    const valid = nums.length === cfg.PICK &&
      new Set(nums).size === cfg.PICK &&
      nums.every((n) => Number.isInteger(n) && n >= 1 && n <= cfg.NUMBERS);
    if (!valid) return res.status(400).json({ error: 'invalid' });
    const id = drawIdOf(now);
    const d = getDraw(id);
    if (d.tickets.has(uid)) return res.status(409).json({ error: 'already' });
    d.tickets.set(uid, { numbers: nums.slice().sort((a, b) => a - b), name: displayName(user) });
    res.json({ drawId: id, ticket: d.tickets.get(uid).numbers, participants: d.tickets.size });
  });

  app.get('/api/lotto/result', async (req, res) => {
    const uid = auth(req, res); if (!uid) return;
    try {
      const id = Number(req.query.drawId);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid' });
      if (Date.now() < drawAt(id)) return res.status(425).json({ error: 'not_yet' });
      if (id < drawIdOf(Date.now()) - 3) return res.status(410).json({ error: 'expired' });
      await resolveDraw(id); // auch ohne Tipps ziehen, damit Zuschauer die Kugeln sehen
      res.json(publicResult(id, uid));
    } catch (e) {
      console.error('[lotto] result', e);
      res.status(500).json({ error: 'server' });
    }
  });
};

module.exports.verifyInitData = verifyInitData;
module.exports.DEFAULTS = DEFAULTS;
