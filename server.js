/**
 * TaxiTron economy server
 * ------------------------------------------------------------------
 * Implements exactly the API surface the client (index.html) calls:
 *
 *   POST /api/auth                 { initData }
 *   GET  /api/deposit-info         ?token=
 *   POST /api/run                  { token, distance, zombies }
 *   POST /api/withdraw             { token, address, amount }
 *   GET  /api/withdrawals          ?token=
 *   POST /api/submit-score         { token, distance, zombies }
 *   GET  /api/leaderboard          ?token=   (token optional)
 *
 * Plus a couple of small admin endpoints (protected by ADMIN_SECRET)
 * so payouts and the tournament can be managed by hand:
 *
 *   GET  /admin/stats
 *   GET  /admin/withdrawals?status=pending
 *   POST /admin/withdrawals/complete   { uid, ts }
 *
 * Storage: a single JSON file on disk (DATA_DIR/users.json), meant to
 * live on a Railway Volume. Writes are serialised through a tiny
 * in-process queue so concurrent requests can't corrupt the file.
 *
 * Persistence safeguards (added to stop data loss on restarts):
 *  - Uses DATA_DIR, or automatically the Railway volume mount path
 *    (RAILWAY_VOLUME_MOUNT_PATH) if DATA_DIR isn't set.
 *  - Loudly reports when running on Railway WITHOUT a volume, both in
 *    the logs and on GET / ("storage" field), since that wipes all data
 *    on every restart / redeploy.
 *  - Never silently starts fresh over a broken data file: a corrupt
 *    users.json is kept aside and the last good backup is loaded.
 *  - Write errors are logged instead of being swallowed.
 *  - On shutdown (SIGTERM from Railway) pending data is flushed to disk.
 * ------------------------------------------------------------------
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const DEPOSIT_ADDRESS = process.env.DEPOSIT_ADDRESS || '';

const ON_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);
const RAILWAY_VOLUME_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
const DATA_DIR = process.env.DATA_DIR || RAILWAY_VOLUME_PATH || path.join(__dirname, 'data');

const DATA_FILE = path.join(DATA_DIR, 'users.json');
const BACKUP_FILE = path.join(DATA_DIR, 'users.backup.json');

// On Railway, data only survives restarts if it is written inside the attached volume.
const STORAGE_PERSISTENT = !ON_RAILWAY || (
  !!RAILWAY_VOLUME_PATH &&
  path.resolve(DATA_DIR + path.sep).startsWith(path.resolve(RAILWAY_VOLUME_PATH + path.sep))
);

// Must mirror the client's economy constants (index.html) exactly.
const COINS_PER_ZOMBIE = 2;
const COINS_PER_BLOCK = 10000;
const PTS_PER_BLOCK = 0.01;
const LEVEL_MULTIPLIER = 1; // server only ever applies the Level 1 base rate
const DAILY_PTS_CAP = 1; // TON per day
const MIN_WITHDRAW = 1; // TON
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const INIT_DATA_MAX_AGE_MS = 24 * 60 * 60 * 1000; // reject stale Telegram auth payloads
const MAX_ZOMBIES_PER_CALL = 2000; // basic anti-cheat ceiling
const MAX_DISTANCE_PER_CALL = 1000000;

// ---------------------------------------------------------------
// Storage: load once, keep in memory, persist through a write queue
// ---------------------------------------------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });

function readJsonFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('unexpected data format');
  }
  return parsed;
}

function loadUsers() {
  if (!fs.existsSync(DATA_FILE)) {
    // Main file missing: try the backup before starting fresh
    if (fs.existsSync(BACKUP_FILE)) {
      try {
        const fromBackup = readJsonFile(BACKUP_FILE);
        console.warn('[storage] users.json missing, restored ' + Object.keys(fromBackup).length + ' users from backup.');
        return fromBackup;
      } catch (e) {
        console.error('[storage] backup unreadable: ' + e.message);
      }
    }
    console.log('[storage] no data file yet, starting with an empty user list.');
    return {};
  }

  try {
    return readJsonFile(DATA_FILE);
  } catch (e) {
    // Don't overwrite a broken file with an empty user list: keep it aside for recovery
    const corruptName = path.join(DATA_DIR, 'users.corrupt-' + Date.now() + '.json');
    try { fs.renameSync(DATA_FILE, corruptName); } catch (e2) { /* ignore */ }
    console.error('[storage] users.json is unreadable (' + e.message + '), moved to ' + corruptName);
    try {
      const fromBackup = readJsonFile(BACKUP_FILE);
      console.warn('[storage] restored ' + Object.keys(fromBackup).length + ' users from backup.');
      return fromBackup;
    } catch (e3) {
      console.error('[storage] no usable backup, starting with an empty user list.');
      return {};
    }
  }
}

let users = loadUsers(); // keyed by Telegram user id (string)

// Keep a copy of the last good state from startup as a safety net
try {
  if (Object.keys(users).length > 0) fs.writeFileSync(BACKUP_FILE, JSON.stringify(users));
} catch (e) {
  console.error('[storage] could not write backup: ' + e.message);
}

let writeQueue = Promise.resolve();
let shuttingDown = false;

function persist() {
  if (shuttingDown) return writeQueue;
  writeQueue = writeQueue.then(() => new Promise((resolve) => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(users), (err) => {
      if (err) {
        console.error('[storage] write failed: ' + err.message);
        resolve();
        return;
      }
      fs.rename(tmp, DATA_FILE, (err2) => {
        if (err2) console.error('[storage] rename failed: ' + err2.message);
        resolve();
      });
    });
  }));
  return writeQueue;
}

function flushSync() {
  try {
    const tmp = DATA_FILE + '.shutdown.tmp';
    fs.writeFileSync(tmp, JSON.stringify(users));
    fs.renameSync(tmp, DATA_FILE);
    console.log('[storage] data flushed to disk (' + Object.keys(users).length + ' users).');
  } catch (e) {
    console.error('[storage] final flush failed: ' + e.message);
  }
}

function newUser(id, name) {
  return {
    id,
    name: name || ('Player ' + id),
    coins: 0,
    ton: 0,
    tonToday: 0,
    tonDate: '',
    best: 0,
    runs: 0,
    tournamentBest: 0,
    tournamentDistance: 0,
    tournamentWeekKey: '',
    withdrawals: [],
  };
}

function getOrCreateUser(id, name) {
  const key = String(id);
  if (!users[key]) {
    users[key] = newUser(key, name);
  } else if (name && users[key].name !== name) {
    users[key].name = name; // keep display name fresh
  }
  return users[key];
}

// ---------------------------------------------------------------
// Berlin-time day/week keys (mirrors the client's reset logic)
// ---------------------------------------------------------------
function berlinNow(date) {
  const d = date || new Date();
  const berlinStr = d.toLocaleString('en-US', { timeZone: 'Europe/Berlin' });
  return new Date(berlinStr);
}
function berlinDayKey(date) {
  const b = berlinNow(date);
  return b.getFullYear() + '-' + String(b.getMonth() + 1).padStart(2, '0') + '-' + String(b.getDate()).padStart(2, '0');
}
function berlinWeekKey(date) {
  // The tournament resets Sunday midnight Berlin time,
  // so we key on "the most recent Sunday 00:00 Berlin".
  const b = berlinNow(date);
  const dow = b.getDay(); // 0 = Sunday
  const start = new Date(b.getFullYear(), b.getMonth(), b.getDate() - dow);
  return start.getFullYear() + '-' + String(start.getMonth() + 1).padStart(2, '0') + '-' + String(start.getDate()).padStart(2, '0');
}

function ensureDailyReset(user) {
  const today = berlinDayKey();
  if (user.tonDate !== today) {
    user.tonDate = today;
    user.tonToday = 0;
  }
}
function ensureTournamentReset(user) {
  const week = berlinWeekKey();
  if (user.tournamentWeekKey !== week) {
    user.tournamentWeekKey = week;
    user.tournamentBest = 0;
    user.tournamentDistance = 0;
  }
}

function publicState(user) {
  return {
    coins: user.coins,
    ton: user.ton,
    tonToday: user.tonToday,
    best: user.best,
    runs: user.runs,
  };
}

// ---------------------------------------------------------------
// Telegram WebApp initData verification
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
// ---------------------------------------------------------------
function verifyInitData(initData) {
  if (!BOT_TOKEN) return { ok: false, error: 'server-missing-bot-token' };
  if (!initData || typeof initData !== 'string') return { ok: false, error: 'missing-init-data' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, error: 'missing-hash' };
  params.delete('hash');

  const pairs = [];
  for (const [key, value] of params.entries()) pairs.push(key + '=' + value);
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return { ok: false, error: 'invalid-hash' };

  const authDate = parseInt(params.get('auth_date') || '0', 10) * 1000;
  if (!authDate || Date.now() - authDate > INIT_DATA_MAX_AGE_MS) {
    return { ok: false, error: 'stale-init-data' };
  }

  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch (e) { /* ignore */ }
  if (!user || !user.id) return { ok: false, error: 'missing-user' };

  const name = user.username || [user.first_name, user.last_name].filter(Boolean).join(' ') || ('Player ' + user.id);
  return { ok: true, id: user.id, name };
}

// ---------------------------------------------------------------
// Session tokens: small signed payload, no server-side session store
// needed, so a restart never logs anyone out.
// ---------------------------------------------------------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}
function signToken(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('hex');
  return body + '.' + sig;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('hex');
  if (sig !== expected) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(body).toString('utf8')); } catch (e) { return null; }
  if (!payload || !payload.uid || !payload.iat) return null;
  if (Date.now() - payload.iat > SESSION_MAX_AGE_MS) return null;
  return payload;
}

function requireUser(getToken) {
  return (req, res, next) => {
    const token = getToken(req);
    const payload = verifyToken(token);
    if (!payload) return res.status(401).json({ error: 'invalid-or-expired-token' });
    req.uid = String(payload.uid);
    req.user = users[req.uid];
    if (!req.user) return res.status(401).json({ error: 'unknown-user' });
    next();
  };
}
const requireUserFromBody = requireUser((req) => req.body && req.body.token);
const requireUserFromQuery = requireUser((req) => req.query && req.query.token);

function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET) return res.status(503).json({ error: 'admin-not-configured' });
  if (req.get('x-admin-secret') !== ADMIN_SECRET) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ---------------------------------------------------------------
// App
// ---------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

// Health check. Open this URL in a browser to see if data is stored safely.
app.get('/', (req, res) => res.json({
  ok: true,
  service: 'taxitron-server',
  storage: STORAGE_PERSISTENT ? 'persistent' : 'NOT PERSISTENT - data is lost on every restart (no Railway volume)',
}));

// ---- Auth ----
app.post('/api/auth', (req, res) => {
  const { initData } = req.body || {};
  const result = verifyInitData(initData);
  if (!result.ok) return res.status(401).json({ error: result.error });

  const user = getOrCreateUser(result.id, result.name);
  ensureDailyReset(user);
  ensureTournamentReset(user);
  persist();

  const token = signToken({ uid: user.id, iat: Date.now() });
  res.json({ token, state: publicState(user) });
});

// ---- Deposit info ----
app.get('/api/deposit-info', requireUserFromQuery, (req, res) => {
  res.json({
    memo: 'TT-' + req.uid,
    address: DEPOSIT_ADDRESS || undefined,
  });
});

// ---- Exchange a run's zombies for coins + (capped) TON ----
app.post('/api/run', requireUserFromBody, (req, res) => {
  const user = req.user;
  let { distance, zombies } = req.body || {};
  zombies = Math.max(0, Math.min(MAX_ZOMBIES_PER_CALL, Math.floor(Number(zombies) || 0)));
  distance = Math.max(0, Math.min(MAX_DISTANCE_PER_CALL, Math.floor(Number(distance) || 0)));

  ensureDailyReset(user);

  const coinsGained = zombies * COINS_PER_ZOMBIE;
  user.coins += coinsGained;

  const rawGain = (coinsGained / COINS_PER_BLOCK) * PTS_PER_BLOCK * LEVEL_MULTIPLIER;
  const allowed = Math.max(0, DAILY_PTS_CAP - user.tonToday);
  const gain = Math.min(rawGain, allowed);
  user.ton += gain;
  user.tonToday += gain;

  user.runs += 1;
  user.best = Math.max(user.best, zombies);

  persist();
  // acceptedZombies tells the client how many were actually credited, so anything
  // above the per-call ceiling stays pending on the client instead of being lost
  res.json({ state: publicState(user), acceptedZombies: zombies });
});

// ---- Withdraw ----
function isPlausibleTonAddress(addr) {
  return typeof addr === 'string' && addr.trim().length >= 10 && !/\s/.test(addr.trim());
}
app.post('/api/withdraw', requireUserFromBody, (req, res) => {
  const user = req.user;
  const { address, amount } = req.body || {};
  const amt = Number(amount);

  if (!isPlausibleTonAddress(address)) return res.status(400).json({ error: 'invalid-address' });
  if (!amt || amt < MIN_WITHDRAW) return res.status(400).json({ error: 'amount-too-small' });
  if (amt > user.ton) return res.status(400).json({ error: 'insufficient-funds' });

  user.ton -= amt;
  const withdrawal = { ts: Date.now(), address: String(address).trim(), amount: amt, status: 'pending' };
  user.withdrawals.push(withdrawal);
  if (user.withdrawals.length > 200) user.withdrawals = user.withdrawals.slice(-200);

  persist();
  res.json({ state: publicState(user), withdrawal });
});

// ---- Withdrawal history / status polling ----
app.get('/api/withdrawals', requireUserFromQuery, (req, res) => {
  res.json({ withdrawals: req.user.withdrawals.slice(-50) });
});

// ---- Tournament score submission (separate from the coin economy) ----
app.post('/api/submit-score', requireUserFromBody, (req, res) => {
  const user = req.user;
  let { distance, zombies } = req.body || {};
  zombies = Math.max(0, Math.min(MAX_ZOMBIES_PER_CALL, Math.floor(Number(zombies) || 0)));
  distance = Math.max(0, Math.min(MAX_DISTANCE_PER_CALL, Math.floor(Number(distance) || 0)));

  ensureTournamentReset(user);
  if (zombies > user.tournamentBest) {
    user.tournamentBest = zombies;
    user.tournamentDistance = distance;
  }
  persist();
  res.json({ ok: true });
});

// ---- Weekly tournament leaderboard ----
app.get('/api/leaderboard', (req, res) => {
  const week = berlinWeekKey();
  const ranked = Object.values(users)
    .map((u) => ({
      id: u.id,
      name: u.name,
      best: u.tournamentWeekKey === week ? u.tournamentBest : 0,
      distance: u.tournamentWeekKey === week ? u.tournamentDistance : 0,
    }))
    .filter((e) => e.best > 0)
    .sort((a, b) => (b.best - a.best) || (b.distance - a.distance));

  const top = ranked.slice(0, 10).map((e) => ({ name: e.name, best: e.best }));

  let you;
  const token = req.query && req.query.token;
  const payload = token ? verifyToken(token) : null;
  if (payload && users[String(payload.uid)]) {
    const uid = String(payload.uid);
    const me = users[uid];
    const myBest = me.tournamentWeekKey === week ? me.tournamentBest : 0;
    const rank = ranked.findIndex((e) => String(e.id) === uid) + 1;
    you = { rank: rank || (ranked.length + 1), best: myBest };
  }

  res.json({ top, you });
});

// ---------------------------------------------------------------
// Admin (manual payout / oversight) — protected by ADMIN_SECRET
// ---------------------------------------------------------------
app.get('/admin/stats', requireAdmin, (req, res) => {
  const all = Object.values(users);
  const pendingWithdrawals = [];
  all.forEach((u) => u.withdrawals.forEach((w) => {
    if (w.status === 'pending') pendingWithdrawals.push({ uid: u.id, name: u.name, ...w });
  }));
  res.json({
    storage: { dataDir: DATA_DIR, persistent: STORAGE_PERSISTENT, volumeMountPath: RAILWAY_VOLUME_PATH || null },
    totalUsers: all.length,
    totalCoins: all.reduce((s, u) => s + u.coins, 0),
    totalTon: all.reduce((s, u) => s + u.ton, 0),
    totalRuns: all.reduce((s, u) => s + u.runs, 0),
    pendingWithdrawals,
  });
});

app.get('/admin/withdrawals', requireAdmin, (req, res) => {
  const status = req.query.status;
  const out = [];
  Object.values(users).forEach((u) => u.withdrawals.forEach((w) => {
    if (!status || w.status === status) out.push({ uid: u.id, name: u.name, ...w });
  }));
  out.sort((a, b) => b.ts - a.ts);
  res.json({ withdrawals: out });
});

app.post('/admin/withdrawals/complete', requireAdmin, (req, res) => {
  const { uid, ts } = req.body || {};
  const user = users[String(uid)];
  if (!user) return res.status(404).json({ error: 'unknown-user' });
  const w = user.withdrawals.find((w) => w.ts === ts);
  if (!w) return res.status(404).json({ error: 'unknown-withdrawal' });
  w.status = 'completed';
  persist();
  res.json({ ok: true, withdrawal: w });
});

// ---------------------------------------------------------------
// Graceful shutdown: Railway sends SIGTERM before restarts/redeploys
// ---------------------------------------------------------------
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[server] ' + signal + ' received, saving data before exit...');
  const force = setTimeout(() => { flushSync(); process.exit(0); }, 3000);
  writeQueue.then(() => {
    clearTimeout(force);
    flushSync();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

app.listen(PORT, () => {
  console.log('TaxiTron server listening on port ' + PORT);
  console.log('[storage] data file: ' + DATA_FILE + ' (' + Object.keys(users).length + ' users loaded)');
  if (!STORAGE_PERSISTENT) {
    console.error('==================================================================');
    console.error('[storage] WARNING: running on Railway WITHOUT a volume for ' + DATA_DIR);
    console.error('[storage] All coins, TON and tournament data will be LOST on restart.');
    console.error('[storage] Attach a volume to THIS service (mount path /data).');
    console.error('==================================================================');
  }
  if (!BOT_TOKEN) console.warn('WARNING: BOT_TOKEN not set — /api/auth will always fail.');
  if (SESSION_SECRET === 'dev-insecure-secret-change-me') console.warn('WARNING: using the default SESSION_SECRET — set a real one in production.');
});
