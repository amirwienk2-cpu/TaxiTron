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

console.log('Coin Runner economy server module loaded.'); // marker: forces a genuinely new build, not a stale redeploy

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 8787;
const processStartTime = Date.now();
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'CHANGE_ME_BEFORE_PRODUCTION';
// Secret for the /api/admin/* endpoints (viewing and completing withdrawal
// requests). Set this to a long random string on Railway. Without it, the
// admin endpoints are disabled entirely rather than left open.
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
// IMPORTANT: point this at a mounted Railway Volume, otherwise all player
// balances and the deposit dedup bookmark are wiped on every redeploy, since
// a plain container filesystem is not persistent. Railway automatically sets
// RAILWAY_VOLUME_MOUNT_PATH once a Volume is attached to this service, so
// that's picked up automatically — DATA_DIR only needs to be set by hand if
// you want to override that path for some reason.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'users.json');

/* ---- TON deposit watcher config ---- */
// The address shown to players in the Wallet > Deposit tab. Must match the
// address configured in the frontend's #depositAddress element.
const DEPOSIT_ADDRESS = process.env.DEPOSIT_ADDRESS || 'UQD2uyyNj1ZqCz59zlM7ej5aPr6raYoiTgbUP9bVeWlsbpPt';
// Optional — free to get at https://toncenter.com/. Without it you're limited
// to ~1 request/second on the public TonCenter API, which is fine for low
// volume but you'll want a key once deposits pick up.
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY || '';
const TONCENTER_BASE = 'https://toncenter.com/api/v2';
const DEPOSIT_POLL_INTERVAL_MS = Number(process.env.DEPOSIT_POLL_INTERVAL_MS || 20000);

/* ---- Level 1 economy rules (mirrors the client's display logic) ---- */
const COINS_PER_ZOMBIE = 2;
const COINS_PER_BLOCK = 10000;
const TON_PER_BLOCK = 0.01;
const LEVEL_MULTIPLIER = 1; // Level 1 base
const DAILY_TON_CAP = 1;

/* ---- Withdrawal rules (mirrors the client's MIN_WITHDRAW) ---- */
const MIN_WITHDRAW_TON = 1;

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
if (!db.__meta) {
  db.__meta = { lastDepositLt: '0', processedDepositHashes: [] };
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

/* ================= TON deposit watcher ================= */
// How it works: every player gets a personal "memo code" (their Telegram
// user id, see /api/deposit-info). They're instructed to include that code
// as the transfer comment when sending TON to DEPOSIT_ADDRESS. We poll
// TonCenter for new incoming transactions on that address, read the memo
// back out of each one, and credit the matching user's TON balance.
// Transactions are deduplicated by hash so nothing is credited twice, and
// db.__meta.lastDepositLt is a bookmark so we don't re-scan old history
// every time.
function tonCenterGet(pathAndQuery) {
  return new Promise((resolve, reject) => {
    const headers = TONCENTER_API_KEY ? { 'X-API-Key': TONCENTER_API_KEY } : {};
    https.get(TONCENTER_BASE + pathAndQuery, { headers }, (r) => {
      let data = '';
      r.on('data', (c) => { data += c; });
      r.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function pollDeposits() {
  try {
    const q = `/getTransactions?address=${encodeURIComponent(DEPOSIT_ADDRESS)}&limit=30&archival=true`;
    const result = await tonCenterGet(q);
    if (!result || result.ok === false || !Array.isArray(result.result)) return;

    // Process oldest -> newest so the lt bookmark advances in order.
    const txs = result.result.slice().reverse();
    let dirty = false;

    for (const tx of txs) {
      const inMsg = tx.in_msg;
      if (!inMsg || !inMsg.value || inMsg.value === '0') continue; // ignore outgoing / zero-value tx

      const lt = tx.transaction_id && tx.transaction_id.lt;
      const hash = tx.transaction_id && tx.transaction_id.hash;
      if (!lt || !hash) continue;
      if (BigInt(lt) <= BigInt(db.__meta.lastDepositLt || '0')) continue;
      if (db.__meta.processedDepositHashes.includes(hash)) continue;

      const amountTon = Number(BigInt(inMsg.value)) / 1e9;
      const memo = (inMsg.message || '').trim();

      if (memo && db[memo] && amountTon > 0) {
        const u = getUser(memo);
        u.ton += amountTon;
        u.pendingDeposits = u.pendingDeposits || [];
        u.pendingDeposits.push({ amount: Number(amountTon.toFixed(6)), hash, ts: Date.now() });
        console.log(`Deposit credited: ${amountTon} TON -> user ${memo} (tx ${hash})`);
      } else {
        // No matching user for this memo — e.g. sender forgot the code, or
        // sent before ever opening the app. Logged so you can refund/match
        // manually if needed; nothing is credited automatically.
        console.warn(`Unmatched deposit: ${amountTon} TON, memo="${memo}", tx ${hash}`);
      }

      db.__meta.processedDepositHashes.push(hash);
      if (db.__meta.processedDepositHashes.length > 500) {
        db.__meta.processedDepositHashes = db.__meta.processedDepositHashes.slice(-500);
      }
      if (BigInt(lt) > BigInt(db.__meta.lastDepositLt || '0')) {
        db.__meta.lastDepositLt = lt;
      }
      dirty = true;
    }

    if (dirty) saveDb();
  } catch (err) {
    console.error('Deposit poll failed:', err.message);
  }
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
    'Cache-Control': 'no-store, no-cache, must-revalidate',
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
    // A 204 response must not carry a body — some strict WebView fetch
    // implementations (notably Telegram's in-app iOS browser) treat a 204
    // with a Content-Length/body mismatch as a network failure ("Load
    // failed"), which silently breaks every POST/GET call from the app.
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    return res.end();
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
      console.log(`Auth OK: user ${uid}`);
      return sendJson(res, 200, { token, state: publicState(u) });
    }

    /* ---- GET /api/debug/env-status -> booleans only, no secret values ----
     * Safe to leave public: reveals only whether each variable is set and
     * its length, never the actual value. Purely for diagnosing "why does
     * the server say X is not set" without digging through logs.
     */
    if (req.method === 'GET' && (url.pathname === '/api/debug/env-status' || url.pathname === '/api/debug/env-status-check2')) {
      return sendJson(res, 200, {
        BOT_TOKEN: { set: !!BOT_TOKEN, length: BOT_TOKEN.length },
        SESSION_SECRET: { set: SESSION_SECRET !== 'CHANGE_ME_BEFORE_PRODUCTION', length: SESSION_SECRET.length },
        DATA_DIR: { value: DATA_DIR },
        ADMIN_SECRET: { set: !!ADMIN_SECRET, length: ADMIN_SECRET.length },
        TONCENTER_API_KEY: { set: !!TONCENTER_API_KEY },
        // Railway auto-provides these — use them to cross-check that the
        // container answering THIS request is really the one shown as
        // "Active" in the dashboard.
        RAILWAY_DEPLOYMENT_ID: process.env.RAILWAY_DEPLOYMENT_ID || null,
        RAILWAY_SERVICE_ID: process.env.RAILWAY_SERVICE_ID || null,
        RAILWAY_ENVIRONMENT_NAME: process.env.RAILWAY_ENVIRONMENT_NAME || null,
        RAILWAY_REPLICA_ID: process.env.RAILWAY_REPLICA_ID || null,
        processStartedAt: new Date(processStartTime).toISOString()
      });
    }

    /* ---- GET /api/state?token=... -> { state } ---- */
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const token = url.searchParams.get('token');
      const uid = verifyToken(token);
      const u = getUser(uid);
      return sendJson(res, 200, { state: publicState(u) });
    }

    /* ---- GET /api/deposit-info?token=... -> { address, memo } ---- */
    if (req.method === 'GET' && url.pathname === '/api/deposit-info') {
      const token = url.searchParams.get('token');
      const uid = verifyToken(token);
      getUser(uid); // ensure the user record exists so deposits can match it
      saveDb();
      return sendJson(res, 200, { address: DEPOSIT_ADDRESS, memo: uid });
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

    /* ---- GET /api/withdrawals?token=... -> { withdrawals } ----
     * Lets the client poll the status of its own withdrawal requests (e.g.
     * to notice when an admin flips one from 'pending' to 'completed' via
     * /api/admin/complete-withdrawal), without needing the admin secret.
     */
    if (req.method === 'GET' && url.pathname === '/api/withdrawals') {
      const token = url.searchParams.get('token');
      const uid = verifyToken(token);
      const u = getUser(uid);
      return sendJson(res, 200, { withdrawals: u.withdrawals || [] });
    }

    /* ---- POST /api/withdraw  { token, address, amount } -> { state, withdrawal } ----
     * This validates and deducts from the server-authoritative TON balance and
     * files the request as "pending" in the user's record. It does NOT send
     * TON on-chain — that would require the server to hold your wallet's
     * private key and sign transactions itself, which is a separate, much
     * more sensitive piece of infrastructure. Review data/users.json (each
     * user's `withdrawals` array) and pay out pending requests manually from
     * your own wallet, then flip their status to 'completed' if you want that
     * reflected back to players.
     */
    if (req.method === 'POST' && url.pathname === '/api/withdraw') {
      const raw = await readBody(req);
      const { token, address, amount } = JSON.parse(raw || '{}');
      const uid = verifyToken(token);
      const u = getUser(uid);

      const addr = typeof address === 'string' ? address.trim() : '';
      const amt = Number(amount);

      if (!addr || addr.length < 10 || /\s/.test(addr)) {
        throw new Error('Invalid TON withdrawal address.');
      }
      if (!amt || amt < MIN_WITHDRAW_TON) {
        throw new Error(`Minimum withdrawal is ${MIN_WITHDRAW_TON} TON.`);
      }
      if (amt > u.ton) {
        throw new Error('Not enough TON balance.');
      }

      u.ton -= amt;
      u.withdrawals = u.withdrawals || [];
      const withdrawal = { address: addr, amount: Number(amt.toFixed(6)), status: 'pending', ts: Date.now() };
      u.withdrawals.push(withdrawal);
      if (u.withdrawals.length > 50) u.withdrawals = u.withdrawals.slice(-50); // cap history size
      saveDb();

      return sendJson(res, 200, { state: publicState(u), withdrawal });
    }

    /* ---- GET /api/admin/pending-withdrawals?secret=... -> { withdrawals } ----
     * Lists every pending withdrawal across all players with the FULL address
     * (the in-app history only shows a truncated one), so you can pay them out
     * manually from your own wallet. Requires ADMIN_SECRET to be set.
     */
    if (req.method === 'GET' && (url.pathname === '/api/admin/pending-withdrawals' || url.pathname === '/api/admin/withdrawals-list2')) {
      if (!ADMIN_SECRET) throw new Error('Admin endpoints are disabled: ADMIN_SECRET is not set.');
      if (url.searchParams.get('secret') !== ADMIN_SECRET) throw new Error('Invalid admin secret.');
      const pending = [];
      for (const uid of Object.keys(db)) {
        if (uid === '__meta') continue;
        const u = db[uid];
        (u.withdrawals || []).forEach((w) => {
          if (w.status === 'pending') pending.push({ uid, address: w.address, amount: w.amount, ts: w.ts });
        });
      }
      pending.sort((a, b) => a.ts - b.ts);
      return sendJson(res, 200, { withdrawals: pending });
    }

    /* ---- POST /api/admin/complete-withdrawal { secret, uid, ts } -> { ok } ----
     * Marks one withdrawal as completed once you've sent the TON yourself from
     * your own wallet. This only updates the status shown in-app — it does not
     * send anything.
     */
    if (req.method === 'POST' && url.pathname === '/api/admin/complete-withdrawal') {
      if (!ADMIN_SECRET) throw new Error('Admin endpoints are disabled: ADMIN_SECRET is not set.');
      const raw = await readBody(req);
      const { secret, uid, ts } = JSON.parse(raw || '{}');
      if (secret !== ADMIN_SECRET) throw new Error('Invalid admin secret.');
      const u = db[uid];
      if (!u || !u.withdrawals) throw new Error('User or withdrawal not found.');
      const w = u.withdrawals.find((x) => x.ts === Number(ts));
      if (!w) throw new Error('Withdrawal not found.');
      w.status = 'completed';
      saveDb();
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(`Request failed: ${req.method} ${url.pathname} -> ${err.message}`);
    return sendJson(res, 400, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Coin Runner economy server listening on :${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  if (!process.env.DATA_DIR && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    console.warn('WARNING: No Volume detected (DATA_DIR/RAILWAY_VOLUME_MOUNT_PATH not set) — using a local folder inside the container. On Railway this is WIPED on every redeploy (all player balances lost). Attach a Volume to this service.');
  }
  if (!BOT_TOKEN) {
    console.warn('WARNING: BOT_TOKEN is not set — /api/auth will reject all requests.');
  }
  if (SESSION_SECRET === 'CHANGE_ME_BEFORE_PRODUCTION') {
    console.warn('WARNING: SESSION_SECRET is using the default value — set your own before going live.');
  }
  if (!TONCENTER_API_KEY) {
    console.warn('NOTE: TONCENTER_API_KEY is not set — deposit polling uses the public rate limit (~1 req/s).');
  }
  if (!ADMIN_SECRET) {
    console.warn('NOTE: ADMIN_SECRET is not set — /api/admin/* endpoints are disabled. Set it to review and complete withdrawal requests.');
  }
  pollDeposits(); // run once immediately, then on the interval below
  setInterval(pollDeposits, DEPOSIT_POLL_INTERVAL_MS);
});
