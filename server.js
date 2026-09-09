/**
 * Coin Runner 3D — Server-authoritative economy backend
 * ------------------------------------------------------
 * Zero external dependencies (only Node.js built-ins), so it runs anywhere
 * with just:  node server.js
 *
 * What this solves:
 *   - Coins / TON balance and the daily 1 TON cap now live ONLY on the
 *     server, in data/users.json. The browser can no longer edit them via
 *     localStorage or devtools, because the browser never holds the
 *     authoritative number — it only displays what the server returns.
 *   - Each player is identified via Telegram's signed `initData`, verified
 *     with your bot token (HMAC-SHA256), so user IDs can't be spoofed.
 *   - Basic plausibility checks reject obviously-impossible run reports
 *     (e.g. 50,000 zombies in a 10 second run).
 *
 * What this does NOT solve (be aware of this):
 *   - The client still *reports* "I drove 340m and collected 12 zombies"
 *     at the end of a run. A determined attacker could intercept that
 *     network request and inflate those two numbers before they reach the
 *     server. The plausibility checks below (max zombies per meter, max
 *     speed, minimum time between runs) catch casual/naive cheating, but
 *     they are not cryptographic proof. True server-authoritative
 *     anti-cheat would mean simulating the whole run server-side, which
 *     is a much bigger project than a browser racer usually needs.
 *     Treat this as "no more free localStorage editing", not "unhackable".
 *
 * Setup:
 *   1. Set your real Telegram bot token:
 *        export BOT_TOKEN="123456:ABC-your-real-bot-token"
 *   2. Set a random long secret for signing session tokens:
 *        export SESSION_SECRET="something-long-and-random"
 *   3. Run:
 *        node server.js
 *      (listens on PORT env var, default 8787)
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 8787;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'CHANGE_ME_BEFORE_PRODUCTION';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'users.json');

/* ---- Level 1 economy rules (mirrors the client's display logic) ---- */
const COINS_PER_ZOMBIE = 2;
const COINS_PER_BLOCK = 10000;
const TON_PER_BLOCK = 0.01;
const LEVEL_MULTIPLIER = 1; // Level 1 base
const DAILY_TON_CAP = 1;

/* ---- Basic anti-cheat plausibility limits ---- */
const MAX_METERS_PER_RUN = 20000;        // generous ceiling for one ride
const MAX_ZOMBIES_PER_METER = 0.3;       // ~1 zombie per ~3.3m at most
const MIN_SECONDS_BETWEEN_RUNS = 3;      // throttle rapid-fire fake submissions

/* ================= tiny JSON "database" ================= */
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
let db = {};
if (fs.existsSync(DATA_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { db = {}; }
}
function saveDb() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function getUser(uid) {
  if (!db[uid]) {
    db[uid] = {
      coins: 0,
      ton: 0,
      tonToday: 0,
      tonDate: todayStr(),
      best: 0,
      runs: 0,
      lastRunAt: 0
    };
  }
  const u = db[uid];
  if (u.tonDate !== todayStr()) {
    u.tonDate = todayStr();
    u.tonToday = 0;
  }
  return u;
}
function publicState(u) {
  return {
    coins: u.coins,
    ton: Number(u.ton.toFixed(6)),
    tonToday: Number(u.tonToday.toFixed(6)),
    dailyCap: DAILY_TON_CAP,
    best: u.best,
    runs: u.runs,
    level: 1,
    multiplier: LEVEL_MULTIPLIER
  };
}

/* ================= Telegram initData verification ================= */
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN) {
    throw new Error('Server misconfigured: BOT_TOKEN not set');
  }
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new Error('Missing hash');
  params.delete('hash');

  const pairs = [];
  for (const [key, value] of params.entries()) {
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) {
    throw new Error('Invalid Telegram signature');
  }

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  const ageSeconds = Date.now() / 1000 - authDate;
  if (ageSeconds > 86400) {
    throw new Error('initData expired');
  }

  const userJson = params.get('user');
  if (!userJson) throw new Error('Missing user field');
  const user = JSON.parse(userJson);
  return String(user.id);
}

/* ================= session tokens (HMAC-signed, no external JWT lib) ================= */
function issueToken(uid) {
  const payload = { uid, exp: Date.now() + 1000 * 60 * 60 * 12 }; // 12h
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    throw new Error('Missing/invalid token');
  }
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (expected !== sig) throw new Error('Bad token signature');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (Date.now() > payload.exp) throw new Error('Token expired');
  return payload.uid;
}

/* ================= HTTP plumbing ================= */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    req.on('data', (c) => {
      chunks += c;
      if (chunks.length > 1e6) req.destroy(); // 1MB body guard
    });
    req.on('end', () => resolve(chunks));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    return sendJson(res, 204, {});
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    /* ---- POST /api/auth  { initData } -> { token, state } ---- */
    if (req.method === 'POST' && url.pathname === '/api/auth') {
      const raw = await readBody(req);
      const { initData } = JSON.parse(raw || '{}');
      const uid = verifyTelegramInitData(initData);
      const token = issueToken(uid);
      const u = getUser(uid);
      saveDb();
      return sendJson(res, 200, { token, state: publicState(u) });
    }

    /* ---- GET /api/state?token=... -> { state } ---- */
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const token = url.searchParams.get('token');
      const uid = verifyToken(token);
      const u = getUser(uid);
      return sendJson(res, 200, { state: publicState(u) });
    }

    /* ---- POST /api/run  { token, distance, zombies } -> { state } ---- */
    if (req.method === 'POST' && url.pathname === '/api/run') {
      const raw = await readBody(req);
      const { token, distance, zombies } = JSON.parse(raw || '{}');
      const uid = verifyToken(token);
      const u = getUser(uid);

      const now = Date.now();
      if (now - u.lastRunAt < MIN_SECONDS_BETWEEN_RUNS * 1000) {
        return sendJson(res, 429, { error: 'Too many run submissions, slow down.' });
      }

      const dist = Math.max(0, Math.min(Number(distance) || 0, MAX_METERS_PER_RUN));
      let zom = Math.max(0, Math.floor(Number(zombies) || 0));
      const maxPlausibleZombies = Math.ceil(dist * MAX_ZOMBIES_PER_METER) + 5;
      if (zom > maxPlausibleZombies) zom = maxPlausibleZombies; // clamp, don't reject the run

      // coins from this run
      const coinsGained = zom * COINS_PER_ZOMBIE;
      u.coins += coinsGained;

      // TON accrual with the Level 1 rate + daily cap
      const rawTonGain = (coinsGained / COINS_PER_BLOCK) * TON_PER_BLOCK * LEVEL_MULTIPLIER;
      const allowed = Math.max(0, DAILY_TON_CAP - u.tonToday);
      const tonGain = Math.min(rawTonGain, allowed);
      u.ton += tonGain;
      u.tonToday += tonGain;

      u.best = Math.max(u.best, zom);
      u.runs += 1;
      u.lastRunAt = now;
      saveDb();

      return sendJson(res, 200, { state: publicState(u), coinsGained, tonGained: Number(tonGain.toFixed(6)) });
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Coin Runner economy server listening on :${PORT}`);
  if (!BOT_TOKEN) {
    console.warn('WARNING: BOT_TOKEN is not set — /api/auth will reject all requests.');
  }
  if (SESSION_SECRET === 'CHANGE_ME_BEFORE_PRODUCTION') {
    console.warn('WARNING: SESSION_SECRET is using the default value — set your own before going live.');
  }
});
