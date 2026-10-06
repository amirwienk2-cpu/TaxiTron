/**
 * TaxiTron economy server
 * ------------------------------------------------------------------
 * Implements exactly the API surface the client (index.html) calls:
 *
 *   POST /api/auth                 { initData }
 *   GET  /api/deposit-info         ?token=
 *   POST /api/run/start            { token, level }
  *   POST /api/run/crash            { token, level }
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
 *   POST /admin/withdrawals/reject     { uid, ts }
 *   POST /admin/withdrawals/restore    { uid, ts }
 *   GET  /admin/deposits
 *   GET  /admin/purchases
 *
 * Set ADMIN_CHAT_ID (your personal Telegram user id) to receive a
 * private Telegram DM from the bot every time a deposit is credited.
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
const http = require('http');
const { attachMonsterCrash } = require('./monster-crash/monster-crash');
const treasury = require('./ton-treasury');
const { Address: TonAddress } = require('@ton/core');

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL || 'https://taxiton.org/telegram/webhook';
const WITHDRAWAL_CHANNEL_ID = process.env.WITHDRAWAL_CHANNEL_ID || '-1004440778638';
const PLAY_GAME_URL = process.env.PLAY_GAME_URL || 'https://t.me/TaxiiTonBot';
const NEWS_CHANNEL_URL = process.env.NEWS_CHANNEL_URL || 'https://t.me/TaxiiTon';
const TON_EXPLORER_URL = process.env.TON_EXPLORER_URL || 'https://tonviewer.com/transaction/';
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://taxiton.org';
const TELEGRAM_MINI_APP_URL = new URL('/TaxiTonUpdate/indexup.html?v=taxiton-admin-badges-20261001', MINI_APP_URL).toString();
const TON_USD_RATE = Number(process.env.TON_USD_RATE || 0);
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || '').trim();
const PLATFORM_USER_ID = String(process.env.PLATFORM_USER_ID || '');
const DEPOSIT_ADDRESS = process.env.DEPOSIT_ADDRESS || '';
const TONAPI_URL = process.env.TONAPI_URL || 'https://tonapi.io/v2';
const DEPOSIT_POLL_MS = Number(process.env.DEPOSIT_POLL_MS || 30000);

// ---- TT jetton withdrawals (on-chain payouts to a user's own TON wallet) ----
// SECURITY: TREASURY_MNEMONIC must only ever come from this Railway env var -
// never hardcode it, never log it, never send it to the client. This repo is
// public, so this file must never contain real secrets.
const TREASURY_MNEMONIC = process.env.TREASURY_MNEMONIC || '';
const TT_JETTON_MASTER = process.env.TT_JETTON_MASTER || '';
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || '';
const TT_DECIMALS = Number(process.env.TT_DECIMALS || 9);
const TONCENTER_URL = process.env.TONCENTER_URL || 'https://toncenter.com/api/v2/jsonRPC';
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY || '';
// Default OFF on purpose: TT withdrawals must be explicitly turned on once the
// treasury is configured and tested.
const TT_WITHDRAW_ENABLED = String(process.env.TT_WITHDRAW_ENABLED || 'false').toLowerCase() === 'true';
// Default ON on purpose: while admin-only mode is active, only Telegram IDs in
// TT_WITHDRAW_ALLOWLIST (comma-separated) may withdraw TT, so the feature can
// be tested live with a single real account before opening it to everyone.
const TT_WITHDRAW_ADMIN_ONLY = String(process.env.TT_WITHDRAW_ADMIN_ONLY || 'true').toLowerCase() === 'true';
const TT_WITHDRAW_ALLOWLIST = new Set(
  String(process.env.TT_WITHDRAW_ALLOWLIST || '').split(',').map((id) => id.trim()).filter(Boolean)
);
const TT_MIN_WITHDRAW = Number(process.env.TT_MIN_WITHDRAW || 30000);
const TT_WITHDRAW_COOLDOWN_MS = Number(process.env.TT_WITHDRAW_COOLDOWN_MS || 24 * 60 * 60 * 1000);
const TT_GLOBAL_DAILY_LIMIT = Number(process.env.TT_GLOBAL_DAILY_LIMIT || 500000);
// Safety reserves checked right before every single send.
const TT_WITHDRAW_GAS_TON = Number(process.env.TT_WITHDRAW_GAS_TON || 0.08);
const TT_MIN_TREASURY_TON_RESERVE = Number(process.env.TT_MIN_TREASURY_TON_RESERVE || 1); // 1 whole TON ("1 GRAM")
const TT_WITHDRAW_ACCEPT_TIMEOUT_MS = Number(process.env.TT_WITHDRAW_ACCEPT_TIMEOUT_MS || 90000);
const TT_WITHDRAW_CONFIRM_TIMEOUT_MS = Number(process.env.TT_WITHDRAW_CONFIRM_TIMEOUT_MS || 120000);
const TT_INTEGRITY_EPSILON = 0.01; // TT - rounding slack for the ttBalance <= ttCreditedLifetime sanity check
const INVITE_EVENT_ENDS_AT = Date.parse(process.env.INVITE_EVENT_ENDS_AT || '2026-09-19T13:50:22.986Z');
if (!Number.isFinite(INVITE_EVENT_ENDS_AT)) throw new Error('INVITE_EVENT_ENDS_AT must be a valid date');
const RANDOM_BOT_INTERVAL_MS = Number(process.env.RANDOM_BOT_INTERVAL_MS);
const RANDOM_BOT_MIN_INTERVAL_MS = 15 * 60 * 1000;
const RANDOM_BOT_MAX_INTERVAL_MS = 45 * 60 * 1000;
const RANDOM_BOT_UID = 'random-bot';
const RANDOM_BOT_NAME = 'ZombieBot';
const RANDOM_BOT_IS_ZOMBIEBOT = true;
const RANDOM_PROMO_START_MS = Date.parse('2026-09-22T22:30:00+02:00');
const RANDOM_PROMO_END_MS = RANDOM_PROMO_START_MS + 72 * 60 * 60 * 1000;
const RANDOM_GIFT_EVENT_START_MS = Date.parse(
  process.env.RANDOM_GIFT_EVENT_START_AT || new Date(RANDOM_PROMO_END_MS).toISOString()
);
const RANDOM_GIFT_EVENT_END_MS = RANDOM_GIFT_EVENT_START_MS + 72 * 60 * 60 * 1000;
if (!Number.isFinite(RANDOM_GIFT_EVENT_START_MS)) throw new Error('RANDOM_GIFT_EVENT_START_AT must be a valid date');
const CHAT_LIKE_EVENT_START_MS = Date.parse(
  process.env.CHAT_LIKE_EVENT_START_AT || new Date(RANDOM_GIFT_EVENT_END_MS).toISOString()
);
const CHAT_LIKE_EVENT_END_MS = Date.parse(
  process.env.CHAT_LIKE_EVENT_END_AT || new Date(CHAT_LIKE_EVENT_START_MS + 72 * 60 * 60 * 1000).toISOString()
);
if (!Number.isFinite(CHAT_LIKE_EVENT_START_MS)) throw new Error('CHAT_LIKE_EVENT_START_AT must be a valid date');
if (!Number.isFinite(CHAT_LIKE_EVENT_END_MS)) throw new Error('CHAT_LIKE_EVENT_END_AT must be a valid date');
if (CHAT_LIKE_EVENT_END_MS - CHAT_LIKE_EVENT_START_MS !== 72 * 60 * 60 * 1000) {
  throw new Error('Like event must last exactly 72 hours');
}
// ---- "Invite leaderboard" campaign: whoever invites the most new users
// starting from INVITE_LEADERBOARD_STARTS_AT wins TON once the campaign ends.
// Only invites completed inside this window count (existing referralCount
// from before the campaign is untouched).
const INVITE_LEADERBOARD_STARTS_AT = Date.parse(
  process.env.INVITE_LEADERBOARD_CAMPAIGN_STARTS_AT ||
  process.env.INVITE_LEADERBOARD_STARTS_AT ||
  '2026-10-06T21:07:01.362Z'
);
const INVITE_LEADERBOARD_ENDS_AT = Date.parse(
  process.env.INVITE_LEADERBOARD_CAMPAIGN_ENDS_AT ||
  process.env.INVITE_LEADERBOARD_ENDS_AT ||
  '2026-10-13T21:07:01.362Z'
);
if (!Number.isFinite(INVITE_LEADERBOARD_STARTS_AT)) throw new Error('Invite leaderboard campaign start must be a valid date');
if (!Number.isFinite(INVITE_LEADERBOARD_ENDS_AT)) throw new Error('Invite leaderboard campaign end must be a valid date');
if (INVITE_LEADERBOARD_ENDS_AT <= INVITE_LEADERBOARD_STARTS_AT) throw new Error('Invite leaderboard campaign end must be after its start');
const INVITE_LEADERBOARD_REWARDS = [20, 10, 5]; // TON for rank 1 / 2 / 3
const ON_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);
const RAILWAY_VOLUME_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
const DATA_DIR = process.env.DATA_DIR || RAILWAY_VOLUME_PATH || path.join(__dirname, 'data');

if (ON_RAILWAY && SESSION_SECRET === 'dev-insecure-secret-change-me') {
  throw new Error('SESSION_SECRET must be configured in production');
}

function runRandomDraw() {
  const now = Date.now();
  if (now >= RANDOM_GIFT_EVENT_START_MS && now < RANDOM_GIFT_EVENT_END_MS) {
    runRandomGiftDrop(now);
    return;
  }
  const candidates = Object.values(users).filter((user) => (
    now - Number(user.lastSeenAt || 0) < ONLINE_WINDOW_MS
  ));
  if (!candidates.length) {
    console.log('[random-bot] no online user available');
    return null;
  }

  const winner = candidates[Math.floor(Math.random() * candidates.length)];
  const prizeTon = randomPrizeTon(now);
  winner.ton = Number((Number(winner.ton || 0) + prizeTon).toFixed(9));
  persist();

  const winnerName = winner.name || ('Player ' + winner.id);
  const message = {
    id: chatNextId++,
    uid: RANDOM_BOT_UID,
    name: RANDOM_BOT_NAME,
    room: 'fa',
    text: winnerName + ' hat random gewonnen: ' + prizeTon + ' TON 🎉',
    ts: now,
    isAdmin: false,
    isDesigner: false,
    chatMuted: false,
    replyTo: null,
    randomWinner: true,
    randomWinnerName: winnerName,
    randomPrizeTon: prizeTon,
  };
  chatMessages.push(message);
  if (chatMessages.length > CHAT_MAX_STORED) chatMessages = chatMessages.slice(-CHAT_MAX_STORED);
  persistChat();
  broadcastChatEvent('message', {
    randomWinnerUid: String(winner.id),
    randomWinnerTon: winner.ton,
  });
  return { message, winner };
}

const DATA_FILE = path.join(DATA_DIR, 'users.json');
const BACKUP_FILE = path.join(DATA_DIR, 'users.backup.json');
const RPS_FILE = path.join(DATA_DIR, 'rps-games.json');
const MAGIC_TOWER_FILE = path.join(DATA_DIR, 'magic-tower-games.json');
const ZOMBIE_TOWER_FILE = path.join(DATA_DIR, 'zombie-tower-games.json');
const INVITE_CAMPAIGN_FILE = path.join(DATA_DIR, 'invite-campaign.json');
const CHAT_LIKE_EVENT_FILE = path.join(DATA_DIR, 'chat-like-event.json');

// On Railway, data only survives restarts if it is written inside the attached volume.
const STORAGE_PERSISTENT = !ON_RAILWAY || (
  !!RAILWAY_VOLUME_PATH &&
  path.resolve(DATA_DIR + path.sep).startsWith(path.resolve(RAILWAY_VOLUME_PATH + path.sep))
);

// Must mirror the client's economy constants (index.html) exactly.
const COINS_PER_ZOMBIE = 1;
const LEVEL_TWO_COINS_PER_ZOMBIE = 7;
const LEVEL_THREE_COINS_PER_ZOMBIE = 20;
const LEVEL_FOUR_COINS_PER_ZOMBIE = 100;
const LEVEL_FIVE_COINS_PER_ZOMBIE = 332;
const COINS_PER_BLOCK = 10000;
const PTS_PER_BLOCK = 0.01;
const LEVEL_MULTIPLIER = 1; // server only ever applies the Level 1 base rate
const DAILY_PTS_CAP = 1; // TON per day at level 1
const LEVEL_TWO_DAILY_PTS_CAP = 0.067;
const LEVEL_THREE_DAILY_PTS_CAP = 0.2;
const LEVEL_FOUR_DAILY_PTS_CAP = 0.67;
const LEVEL_FIVE_DAILY_PTS_CAP = 1.66;
// Levels 2-5 pay out their full daily TON cap as a single flat reward once this many
// zombies have been killed that calendar day at that level (set to match the
// in-game "Zombies today" goal shown to players) - NOT via the per-zombie coin rate,
// which (especially at level 4) no longer lines up 1:1 with these goals.
const LEVEL_ZOMBIE_GOALS = { 2: 7500, 3: 7000, 4: 6000, 5: 5000 };
const LIMITED_SKIN_OFFERS = { luna: { price: 25, level: 5, dailyReward: 1.67, rewardDays: 30, max: 20 } };
// Level 1 doesn't use the calendar-day TON cap the other levels use: instead, every
// 2-hour attempt window (the same cooldown that refills their 10 free tries - see
// ATTEMPT_COOLDOWN_LEVEL_ONE_MS) gives one flat TON reward once enough zombies have
// been killed since that window started.
const LEVEL_ONE_WINDOW_ZOMBIE_GOAL = 4000;
const LEVEL_ONE_WINDOW_TON_REWARD = 0.01;
const FIGURE_PACKS = {
  red: { price: 0.5, weights: { sara: 800, nova: 120, zero: 75, berlin: 5, luna: 0 } },
  purple: { price: 1, weights: { sara: 700, nova: 149, zero: 130, berlin: 20, luna: 1 } },
  gold: { price: 2, weights: { sara: 100, nova: 4620, zero: 4950, berlin: 264, luna: 66 } },
};
const FIGURE_IDS = ['sara', 'nova', 'zero', 'berlin', 'luna'];
const FIGURE_MINING_RATES = { sara: 100, nova: 250, zero: 600, berlin: 1200, luna: 2500 };
const LUNA_MINING_BONUS = 5000;
// Fixed total on-chain supply of the TT jetton (see TT_JETTON_MASTER) - used
// only to show "given out vs. remaining" in /admin, never to limit anything
// in-game. Override via env var if the real on-chain total supply ever
// changes, so this doesn't need a code change + redeploy to stay accurate.
const TT_TOTAL_SUPPLY = Number(process.env.TT_TOTAL_SUPPLY || 100000000);
const TT_PER_USD = 10000;
const TT_SHOP_AMOUNTS_USD = [3, 5, 10, 25];
const TT_SHOP_COINS = new Set(['ton', 'usdt', 'trx', 'bnb', 'ltc', 'shib']);
const TT_SHOP_TON_ADDRESS = /^(?:[EU]Q[A-Za-z0-9_-]{46}|-?[0-9]:[0-9a-fA-F]{64})$/;
const TT_SHOP_TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const TT_SHOP_EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const TT_SHOP_LTC_ADDRESS = /^(?:[LM3][1-9A-HJ-NP-Za-km-z]{25,34}|ltc1[ac-hj-np-z02-9]{39,59})$/i;
const TT_CHAT_ITEMS = {
  bub: { classic: 0, autumn: 2000, cozy: 2000, fox: 2000, shadows: 2000 },
  frm: { none: 0, autumn: 2000, cozy: 2000, fox: 2000, shadows: 2000 },
  ban: { classic: 0, autumn: 2000, cozy: 2000, fox: 2000, shadows: 2000 },
  stk: { sara: 5000, berlin: 5000, zero: 5000, nova: 5000, luna: 5000, nikto: 5000, zombie: 5000, autumn: 5000 },
};
function dailyTonCapForLevel(level) {
  const normalized = Number(level) || 1;
  return normalized >= 5 ? LEVEL_FIVE_DAILY_PTS_CAP
    : normalized >= 4 ? LEVEL_FOUR_DAILY_PTS_CAP
      : normalized >= 3 ? LEVEL_THREE_DAILY_PTS_CAP
        : normalized >= 2 ? LEVEL_TWO_DAILY_PTS_CAP : DAILY_PTS_CAP;
}
const MIN_WITHDRAW = 1; // TON
const WITHDRAWAL_FEE_RATE = 0.01;
const WITHDRAWAL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const INIT_DATA_MAX_AGE_MS = 24 * 60 * 60 * 1000; // reject stale Telegram auth payloads
const MAX_ZOMBIES_PER_CALL = 10000; // basic anti-cheat ceiling
const MAX_DISTANCE_PER_CALL = 1000000;
// Anti-cheat for tournament submissions: the server (not the client) times how
// long a run actually lasted since /api/run/start was called, so a forged or
// instant request can no longer claim an implausibly high zombie count.
// The in-game speed (and therefore the zombie spawn rate) keeps ramping up
// the longer a run lasts, so this must stay generous enough for a skilled,
// long-lasting run to not get falsely clamped.
const MIN_MS_PER_TOURNAMENT_ZOMBIE = 40; // ceiling: 25 zombies/sec sustained
const TOURNAMENT_PLAUSIBILITY_BUFFER = 300; // slack for bursts/high-speed late-game stretches
const MAX_TOURNAMENT_SCORE_MULTIPLIER = 32; // weapon x2 * hack x4 * level-4 booster x4
// Without an upper bound, a forged client could call /api/run/start, sit idle for an
// arbitrarily long time (no real gameplay at all), then submit a huge zombie count that
// still passes the elapsed-time check above. Capping how much elapsed time can be
// "cashed in" closes that gap while still comfortably covering any real, skilled run:
// even a very long, very fast run realistically ends within a couple of minutes once a
// crash becomes unavoidable, and legitimate top scores on this leaderboard have stayed
// well under the ~4800 ceiling this cap still allows.
const MAX_MS_CREDITED_PER_TOURNAMENT_RUN = 3 * 60 * 1000; // 3 minutes
// Anti-cheat for the coin/TON economy: /api/run pays out coins and TON for a
// finished run's zombie count. Unlike /api/submit-score it has no per-request
// timing check, which let a script call it back-to-back to farm the daily TON
// cap in seconds. This enforces a minimum real-world gap between two payouts
// per account; legitimate players never exchange runs faster than this.
const MIN_MS_BETWEEN_RUN_EXCHANGES = 4000;

// ---- Global chat (shown on Home, under the online-player count) ----
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');
const CHAT_SETTINGS_FILE = path.join(DATA_DIR, 'chat-settings.json');
const TT_SHOP_SETTINGS_FILE = path.join(DATA_DIR, 'tt-shop-settings.json');
const CARD_EVENT_FILE = path.join(DATA_DIR, 'card-event.json');
const CARD_EVENT_DURATION_MS = 30 * 1000;
const CARD_EVENT_MIN_INTERVAL_MS = 10 * 60 * 1000;
const CARD_EVENT_MAX_INTERVAL_MS = 20 * 60 * 1000;
const CHAT_MAX_STORED = 200; // how many messages are kept on disk/in memory
const CHAT_MAX_LEN = 300; // characters per message
const CHAT_MIN_INTERVAL_MS = 2000; // basic anti-spam: one message per user every 2s
const RANDOM_GIFT_GUESS_COOLDOWN_MS = 5000;

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

// Backfill TT accounting fields for users written before the TT withdrawal
// feature existed. Their historical ttBalance is treated as already
// "credited" (we have no finer-grained ledger for anything earned before
// this field existed), so the integrity check below doesn't false-flag
// every pre-existing player the first time it runs.
Object.values(users).forEach((user) => {
  if (!Array.isArray(user.ttLedger)) user.ttLedger = [];
  if (!Array.isArray(user.ttWithdrawals)) user.ttWithdrawals = [];
  if (!Number.isFinite(Number(user.ttWithdrawnLifetime))) user.ttWithdrawnLifetime = 0;
  if (!Number.isFinite(Number(user.lastTtWithdrawalAt))) user.lastTtWithdrawalAt = 0;
  if (!Number.isFinite(Number(user.ttCreditedLifetime))) {
    user.ttCreditedLifetime = Number(user.ttBalance || 0) + Number(user.ttWithdrawnLifetime || 0);
  }
});

let rpsGames = {};
try {
  if (fs.existsSync(RPS_FILE)) rpsGames = readJsonFile(RPS_FILE);
} catch (e) {
  console.error('[rps] games file unreadable: ' + e.message);
}
let magicTowerGames = {};
try {
  if (fs.existsSync(MAGIC_TOWER_FILE)) magicTowerGames = readJsonFile(MAGIC_TOWER_FILE);
} catch (e) {
  console.error('[magic-tower] games file unreadable: ' + e.message);
}
let zombieTowerGames = {};
try {
  if (fs.existsSync(ZOMBIE_TOWER_FILE)) zombieTowerGames = readJsonFile(ZOMBIE_TOWER_FILE);
} catch (e) {
  console.error('[zombie-tower] games file unreadable: ' + e.message);
}

let chatMessages = [];
try {
  if (fs.existsSync(CHAT_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'));
    if (Array.isArray(loaded)) chatMessages = loaded.slice(-CHAT_MAX_STORED);
  }
} catch (e) {
  console.error('[chat] messages file unreadable: ' + e.message);
}
let migratedZombieBotRooms = false;
chatMessages.forEach((message) => {
  if (String(message.uid) === RANDOM_BOT_UID && message.room !== 'fa') {
    message.room = 'fa';
    migratedZombieBotRooms = true;
  }
});
if (migratedZombieBotRooms) persistChat();
let cardEventState = null;
try {
  if (fs.existsSync(CARD_EVENT_FILE)) {
    const loaded = readJsonFile(CARD_EVENT_FILE);
    if (loaded && typeof loaded.id === 'string' && ['active','settling','complete'].includes(loaded.status)) {
      cardEventState = {
        id: loaded.id,
        status: loaded.status,
        startedAt: Number(loaded.startedAt) || 0,
        endsAt: Number(loaded.endsAt) || 0,
        rewards: Array.isArray(loaded.rewards) ? loaded.rewards.slice(0,3).map((value) => Number(value) || 0) : [500,1000,0],
        votes: loaded.votes && typeof loaded.votes === 'object' ? loaded.votes : {},
        voterNames: Array.isArray(loaded.voterNames) ? loaded.voterNames : [[],[],[]],
        announcementMessageId: Number(loaded.announcementMessageId) || 0,
        completedAt: Number(loaded.completedAt) || 0,
      };
    }
  }
} catch (error) {
  console.error('[card-event] state file unreadable: ' + error.message);
}
let chatNextId = chatMessages.reduce((max, m) => Math.max(max, Number(m.id) || 0), 0) + 1;
const chatLastSentAt = {}; // uid -> timestamp, in-memory only (anti-spam)
const chatLastGiftGuessAt = {}; // uid -> timestamp, in-memory only (number-gift guess cooldown)
const chatEventClients = new Set();
const CHAT_REACTION_EMOJIS = new Set(['👍', '❤️', '😂', '😮', '😢', '🔥', '👏', '😡']);

function publicChatReactions(message, uid) {
  const reactions = message.reactions && typeof message.reactions === 'object' ? message.reactions : {};
  const counts = {};
  let mine = null;
  Object.entries(reactions).forEach(([emoji, usersForEmoji]) => {
    if (!CHAT_REACTION_EMOJIS.has(emoji) || !Array.isArray(usersForEmoji)) return;
    const uniqueUsers = [...new Set(usersForEmoji.map(String))];
    if (uniqueUsers.length) counts[emoji] = uniqueUsers.length;
    if (uid != null && uniqueUsers.includes(String(uid))) mine = emoji;
  });
  return { counts, mine };
}

function broadcastChatEvent(type, details = {}) {
  const payload = 'event: chat-update\ndata: ' + JSON.stringify({ type, ...details }) + '\n\n';
  chatEventClients.forEach((response) => {
    try {
      response.write(payload);
    } catch (error) {
      chatEventClients.delete(response);
    }
  });
}

// Global on/off switch an admin can flip from the /admin panel. When off,
// regular users cannot send, while chat admins can still moderate the chat.
let chatEnabled = true;
// Stricter lockdown the "Amir" (isDeveloper) badge holder can flip themselves
// from inside the chat: while on, nobody but a developer-badge account can
// send messages (chat-admins/supporters/designers are NOT exempt here,
// unlike the broader chatEnabled switch above).
let chatLockedToDeveloper = false;
try {
  if (fs.existsSync(CHAT_SETTINGS_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(CHAT_SETTINGS_FILE, 'utf8'));
    if (loaded && typeof loaded.enabled === 'boolean') chatEnabled = loaded.enabled;
    if (loaded && typeof loaded.developerLock === 'boolean') chatLockedToDeveloper = loaded.developerLock;
  }
} catch (e) {
  console.error('[chat] settings file unreadable: ' + e.message);
}
function persistChatSettings() {
  try { fs.writeFileSync(CHAT_SETTINGS_FILE, JSON.stringify({ enabled: chatEnabled, developerLock: chatLockedToDeveloper })); }
  catch (e) { console.error('[chat] could not write settings: ' + e.message); }
}

// Global on/off switch for TT Shop payouts (cashing TT out for crypto),
// flippable from the /admin panel. Starts OFF: payouts are temporarily
// paused while a known issue is being looked at - requests are rejected
// server-side (not just hidden in the UI). The real Wallet TON withdrawal
// (/api/withdraw) is unaffected by this.
let ttShopEnabled = false;
try {
  if (fs.existsSync(TT_SHOP_SETTINGS_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(TT_SHOP_SETTINGS_FILE, 'utf8'));
    if (loaded && typeof loaded.enabled === 'boolean') ttShopEnabled = loaded.enabled;
  }
} catch (e) {
  console.error('[tt-shop] settings file unreadable: ' + e.message);
}
function persistTtShopSettings() {
  try { fs.writeFileSync(TT_SHOP_SETTINGS_FILE, JSON.stringify({ enabled: ttShopEnabled })); }
  catch (e) { console.error('[tt-shop] could not write settings: ' + e.message); }
}

// One-time settlement state for the invite leaderboard campaign (payout only
// happens once, tracked outside of any single user so it survives restarts).
let inviteCampaignState = { campaignId: null, settled: false, winners: [] };
try {
  if (fs.existsSync(INVITE_CAMPAIGN_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(INVITE_CAMPAIGN_FILE, 'utf8'));
    if (loaded && typeof loaded === 'object') {
      inviteCampaignState = {
        campaignId: typeof loaded.campaignId === 'string' ? loaded.campaignId : null,
        settled: !!loaded.settled,
        winners: Array.isArray(loaded.winners) ? loaded.winners : [],
      };
    }
  }
} catch (e) {
  console.error('[invite-campaign] settings file unreadable: ' + e.message);
}
function persistInviteCampaignState() {
  try { fs.writeFileSync(INVITE_CAMPAIGN_FILE, JSON.stringify(inviteCampaignState)); }
  catch (e) { console.error('[invite-campaign] could not write settings: ' + e.message); }
}
let chatLikeEventState = {
  campaignId: null,
  rounds: [],
  nextDropAt: 0,
  immediateDropDeployment: null,
};
let chatLikeEventDropTimer = null;
try {
  if (fs.existsSync(CHAT_LIKE_EVENT_FILE)) {
    const loaded = readJsonFile(CHAT_LIKE_EVENT_FILE);
    chatLikeEventState = {
      campaignId: typeof loaded.campaignId === 'string' ? loaded.campaignId : null,
      rounds: Array.isArray(loaded.rounds) ? loaded.rounds.map((round) => ({
        roundId: String(round.roundId || round.messageId || ''),
        target: Number.isSafeInteger(round.target) ? round.target : 0,
        likers: Array.isArray(round.likers) ? [...new Set(round.likers.map(String))] : [],
        entryCounts: round.entryCounts && typeof round.entryCounts === 'object'
          ? Object.fromEntries(Object.entries(round.entryCounts).map(([uid, count]) => [String(uid), Math.max(0, Number(count) || 0)]))
          : Object.fromEntries((Array.isArray(round.likers) ? [...new Set(round.likers.map(String))] : []).map((uid) => [uid, 1])),
        likes: Number.isSafeInteger(round.likes) ? round.likes : (Array.isArray(round.likers) ? [...new Set(round.likers.map(String))].length : 0),
        settled: round.settled === true,
        winners: Array.isArray(round.winners) ? round.winners : [],
        messageId: Number.isSafeInteger(round.messageId) ? round.messageId : 0,
        winnerMessageId: Number.isSafeInteger(round.winnerMessageId) ? round.winnerMessageId : 0,
        legacyRewardKey: round.legacyRewardKey === true,
      })).filter((round) => round.roundId && round.messageId) : [],
      nextDropAt: Number.isSafeInteger(loaded.nextDropAt) ? loaded.nextDropAt : 0,
      immediateDropDeployment: typeof loaded.immediateDropDeployment === 'string'
        ? loaded.immediateDropDeployment : null,
    };
    if (!chatLikeEventState.rounds.length && Number.isSafeInteger(loaded.messageId) && loaded.messageId > 0) {
      chatLikeEventState.rounds.push({
        roundId: String(loaded.messageId),
        target: Number.isSafeInteger(loaded.target) ? loaded.target : 0,
        likers: Array.isArray(loaded.likers) ? [...new Set(loaded.likers.map(String))] : [],
        entryCounts: Object.fromEntries((Array.isArray(loaded.likers) ? [...new Set(loaded.likers.map(String))] : []).map((uid) => [uid, 1])),
        likes: Array.isArray(loaded.likers) ? [...new Set(loaded.likers.map(String))].length : 0,
        settled: loaded.settled === true,
        winners: Array.isArray(loaded.winners) ? loaded.winners : [],
        messageId: loaded.messageId,
        winnerMessageId: Number.isSafeInteger(loaded.winnerMessageId) ? loaded.winnerMessageId : 0,
        legacyRewardKey: true,
      });
    }
  }
} catch (e) {
  console.error('[chat-like-event] state file unreadable: ' + e.message);
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

function persistChatLikeEventState() {
  const tmp = CHAT_LIKE_EVENT_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(chatLikeEventState));
    fs.renameSync(tmp, CHAT_LIKE_EVENT_FILE);
    return true;
  } catch (e) {
    console.error('[chat-like-event] state write failed: ' + e.message);
    return false;
  }
}

function publicChatLikeRound(round, uid) {
  const now = Date.now();
  const status = round.settled
    ? 'complete'
    : now >= CHAT_LIKE_EVENT_END_MS ? 'expired' : 'active';
  return {
    roundId: round.roundId,
    startsAt: CHAT_LIKE_EVENT_START_MS,
    endsAt: CHAT_LIKE_EVENT_END_MS,
    status,
    target: round.target,
    likes: Number.isSafeInteger(round.likes) ? round.likes : round.likers.length,
    messageId: round.messageId,
    winners: round.winners.map((winner) => ({
      name: winner.name,
      photoUrl: winner.photoUrl || '',
      reward: Number(winner.reward) || 0.2,
    })),
  };
}

function publicChatLikeEvent(uid) {
  const now = Date.now();
  const chatLocked = now >= CHAT_LIKE_EVENT_START_MS && now < CHAT_LIKE_EVENT_END_MS &&
    chatLikeEventState.rounds.some((round) => !round.settled);
  const currentRound = [...chatLikeEventState.rounds].reverse()
    .find((round) => !round.settled) || chatLikeEventState.rounds[chatLikeEventState.rounds.length - 1] || null;
  const currentRoundData = currentRound ? publicChatLikeRound(currentRound, uid) : null;
  return {
    startsAt: CHAT_LIKE_EVENT_START_MS,
    endsAt: CHAT_LIKE_EVENT_END_MS,
    status: now < CHAT_LIKE_EVENT_START_MS ? 'scheduled' : now < CHAT_LIKE_EVENT_END_MS ? 'active' : 'expired',
    chatLocked,
    nextDropAt: chatLikeEventState.nextDropAt,
    target: currentRoundData ? currentRoundData.target : 0,
    likes: currentRoundData ? currentRoundData.likes : 0,
    messageId: currentRoundData ? currentRoundData.messageId : 0,
    winners: currentRoundData ? currentRoundData.winners : [],
    rounds: chatLikeEventState.rounds.map((round) => publicChatLikeRound(round, uid)),
  };
}

function ensureChatLikeEventDrop() {
  if (
    Date.now() < CHAT_LIKE_EVENT_START_MS ||
    Date.now() < chatLikeEventState.nextDropAt ||
    Date.now() >= CHAT_LIKE_EVENT_END_MS ||
    chatLikeEventState.rounds.some((round) => !round.settled)
  ) return;
  const now = Date.now();
  const messageId = chatNextId++;
  const round = {
    roundId: String(messageId),
    target: crypto.randomInt(100, 1001),
    likers: [],
    entryCounts: {},
    likes: 0,
    settled: false,
    winners: [],
    messageId,
    winnerMessageId: 0,
  };
  const previousNextDropAt = chatLikeEventState.nextDropAt;
  chatLikeEventState.rounds.push(round);
  chatLikeEventState.nextDropAt = now + crypto.randomInt(15 * 60 * 1000, 45 * 60 * 1000 + 1);
  if (!persistChatLikeEventState()) {
    chatLikeEventState.rounds.pop();
    chatLikeEventState.nextDropAt = Math.max(previousNextDropAt, now + 60 * 1000);
    chatNextId = messageId;
    return;
  }
  const message = {
    id: messageId,
    uid: RANDOM_BOT_UID,
    name: RANDOM_BOT_NAME,
    room: 'fa',
    text: 'ZombieBot hat eine Like-Challenge gestartet!',
    ts: now,
    isAdmin: false,
    isDesigner: false,
    chatMuted: false,
    replyTo: null,
    likeEventBar: true,
    likeEventRoundId: round.roundId,
    isZombieBot: RANDOM_BOT_IS_ZOMBIEBOT,
  };
  chatMessages.push(message);
  if (chatMessages.length > CHAT_MAX_STORED) chatMessages = chatMessages.slice(-CHAT_MAX_STORED);
  persistChat();
  broadcastChatEvent('message');
  broadcastChatEvent('like-event', { event: publicChatLikeEvent(null) });
}

function scheduleChatLikeEventDrop() {
  if (chatLikeEventDropTimer) clearTimeout(chatLikeEventDropTimer);
  chatLikeEventDropTimer = null;
  if (
    Date.now() >= CHAT_LIKE_EVENT_END_MS ||
    chatLikeEventState.rounds.some((round) => !round.settled)
  ) return;
  const delay = Math.max(0, Math.min(
    chatLikeEventState.nextDropAt - Date.now(),
    CHAT_LIKE_EVENT_END_MS - Date.now()
  ));
  chatLikeEventDropTimer = setTimeout(() => {
    chatLikeEventDropTimer = null;
    ensureChatLikeEventDrop();
    if (Date.now() < CHAT_LIKE_EVENT_END_MS) scheduleChatLikeEventDrop();
  }, delay);
}

function applyChatLikeEventPayouts() {
  let changed = false;
  chatLikeEventState.rounds.forEach((round) => {
    if (!round.settled) return;
    round.winners.forEach((winner) => {
      const user = users[String(winner.uid)];
      if (!user) {
        console.error('[chat-like-event] winning user missing: ' + winner.uid);
        return;
      }
      if (!user.chatLikeEventRewards || typeof user.chatLikeEventRewards !== 'object') {
        user.chatLikeEventRewards = {};
      }
      const rewardId = round.legacyRewardKey
        ? chatLikeEventState.campaignId
        : chatLikeEventState.campaignId + ':' + round.roundId;
      if (user.chatLikeEventRewards[rewardId] === true) return;
      user.ton = Number((Number(user.ton || 0) + 0.2).toFixed(9));
      user.chatLikeEventRewards[rewardId] = true;
      changed = true;
    });
  });
  if (changed) persist();
}

function ensureChatLikeEventWinnerMessage(round) {
  if (!round.settled || !round.winners.length || round.winnerMessageId) return;
  const names = round.winners.map((winner) => winner.name).join(', ');
  const message = {
    id: chatNextId++,
    uid: RANDOM_BOT_UID,
    name: RANDOM_BOT_NAME,
    room: 'fa',
    text: 'Like-Event voll! ' + names + ' gewinnen je 0.2 TON 🎉',
    ts: Date.now(),
    isAdmin: false,
    isDesigner: false,
    chatMuted: false,
    replyTo: null,
    likeEventWinner: true,
    likeEventRoundId: round.roundId,
    likeEventWinners: round.winners.map(({ name, photoUrl, reward }) => ({
      name,
      photoUrl: photoUrl || '',
      reward,
    })),
    isZombieBot: RANDOM_BOT_IS_ZOMBIEBOT,
  };
  chatMessages.push(message);
  if (chatMessages.length > CHAT_MAX_STORED) chatMessages = chatMessages.slice(-CHAT_MAX_STORED);
  round.winnerMessageId = message.id;
  persistChatLikeEventState();
  persistChat();
  broadcastChatEvent('message');
}

const chatLikeEventCampaignId = String(CHAT_LIKE_EVENT_START_MS);
const CHAT_LIKE_IMMEDIATE_DROP_DEPLOYMENT = '2026-09-28-like-live-lock-immediate-2330';
if (chatLikeEventState.campaignId !== chatLikeEventCampaignId) {
  chatLikeEventState = {
    campaignId: chatLikeEventCampaignId,
    rounds: [],
    nextDropAt: CHAT_LIKE_EVENT_START_MS,
    immediateDropDeployment: null,
  };
  persistChatLikeEventState();
}
if (!chatLikeEventState.nextDropAt) {
  chatLikeEventState.nextDropAt = CHAT_LIKE_EVENT_START_MS;
}
if (chatLikeEventState.immediateDropDeployment !== CHAT_LIKE_IMMEDIATE_DROP_DEPLOYMENT) {
  chatLikeEventState.immediateDropDeployment = CHAT_LIKE_IMMEDIATE_DROP_DEPLOYMENT;
  chatLikeEventState.nextDropAt = Math.max(CHAT_LIKE_EVENT_START_MS, Date.now());
  persistChatLikeEventState();
}
applyChatLikeEventPayouts();
chatLikeEventState.rounds.forEach(ensureChatLikeEventWinnerMessage);
ensureChatLikeEventDrop();
scheduleChatLikeEventDrop();

const inviteCampaignId = String(INVITE_LEADERBOARD_STARTS_AT);
if (inviteCampaignState.campaignId !== inviteCampaignId) {
  Object.values(users).forEach((user) => {
    user.campaignInvites = 0;
    user.campaignLastInviteAt = 0;
    if (user.referredBy) user.campaignInviteCounted = true;
  });
  inviteCampaignState = { campaignId: inviteCampaignId, settled: false, winners: [] };
  persistInviteCampaignState();
  persist();
  console.log('[invite-campaign] new campaign started; invite counts reset.');
}

try {
  if (Object.keys(users).length > 0) fs.writeFileSync(BACKUP_FILE, JSON.stringify(users));
} catch (e) {
  console.error('[storage] could not write backup: ' + e.message);
}

function persistRpsGames() {
  const tmp = RPS_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(rpsGames));
    fs.renameSync(tmp, RPS_FILE);
  } catch (e) {
    console.error('[rps] write failed: ' + e.message);
  }
}
function persistMagicTowerGames() {
  const tmp = MAGIC_TOWER_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(magicTowerGames));
    fs.renameSync(tmp, MAGIC_TOWER_FILE);
  } catch (e) {
    console.error('[magic-tower] write failed: ' + e.message);
  }
}
function persistZombieTowerGames() {
  const tmp = ZOMBIE_TOWER_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(zombieTowerGames));
    fs.renameSync(tmp, ZOMBIE_TOWER_FILE);
  } catch (e) {
    console.error('[zombie-tower] write failed: ' + e.message);
  }
}
setInterval(expireRpsGames, 30000);
setInterval(expireMagicTowerGames, 30000);

function persistChat() {
  const tmp = CHAT_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(chatMessages));
    fs.renameSync(tmp, CHAT_FILE);
  } catch (e) {
    console.error('[chat] write failed: ' + e.message);
  }
}

let cardEventStartTimer = null;
let cardEventFinishTimer = null;
let cardEventNextStartAt = 0;
function persistCardEventState() {
  const tmp = CARD_EVENT_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(cardEventState));
    fs.renameSync(tmp, CARD_EVENT_FILE);
    return true;
  } catch (error) {
    console.error('[card-event] state write failed: ' + error.message);
    return false;
  }
}
const CARD_EVENT_SETTINGS_FILE = path.join(DATA_DIR, 'card-event-settings.json');
// Admin on/off switch (mirrors chatEnabled). Defaults to disabled on a fresh
// deploy of this feature; persisted so the choice survives restarts.
let cardEventEnabled = false;
try {
  if (fs.existsSync(CARD_EVENT_SETTINGS_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(CARD_EVENT_SETTINGS_FILE, 'utf8'));
    if (loaded && typeof loaded.enabled === 'boolean') cardEventEnabled = loaded.enabled;
  }
} catch (e) {
  console.error('[card-event] settings file unreadable: ' + e.message);
}
function persistCardEventSettings() {
  try { fs.writeFileSync(CARD_EVENT_SETTINGS_FILE, JSON.stringify({ enabled: cardEventEnabled })); }
  catch (e) { console.error('[card-event] could not write settings: ' + e.message); }
}
function publicCardEvent(uid) {
  const event = cardEventState;
  if (!event) return (cardEventEnabled && cardEventNextStartAt) ? { status: 'scheduled', nextStartAt: cardEventNextStartAt, counts: [0, 0, 0], choice: 0 } : null;
  const counts = [0, 0, 0];
  Object.values(event.votes || {}).forEach((card) => {
    const index = Number(card) - 1;
    if (index >= 0 && index < 3) counts[index]++;
  });
  const result = {
    id: event.id,
    status: event.status,
    startedAt: event.startedAt,
    endsAt: event.endsAt,
    counts,
    choice: uid ? Number(event.votes && event.votes[String(uid)]) || 0 : 0,
  };
  if (cardEventEnabled && cardEventNextStartAt) result.nextStartAt = cardEventNextStartAt;
  if (event.status === 'complete') {
    result.rewards = event.rewards.slice();
    result.voterNames = event.voterNames.map((names) => names.slice());
    result.announcement = event.announcement || '';
    result.completedAt = event.completedAt;
  }
  return result;
}
function isCardEventActive() {
  return !!(cardEventState && cardEventState.status === 'active' && Date.now() < Number(cardEventState.endsAt || 0));
}
function shuffledCardRewards() {
  const rewards = [500, 1000, 0];
  for (let index = rewards.length - 1; index > 0; index--) {
    const swap = crypto.randomInt(index + 1);
    [rewards[index], rewards[swap]] = [rewards[swap], rewards[index]];
  }
  return rewards;
}
function scheduleNextCardEvent() {
  if (cardEventStartTimer) clearTimeout(cardEventStartTimer);
  if (!cardEventEnabled) { cardEventNextStartAt = 0; return; }
  const delay = crypto.randomInt(CARD_EVENT_MIN_INTERVAL_MS, CARD_EVENT_MAX_INTERVAL_MS + 1);
  cardEventNextStartAt = Date.now() + delay;
  cardEventStartTimer = setTimeout(startScheduledCardEvent, delay);
}
function startScheduledCardEvent() {
  if (!cardEventEnabled || isCardEventActive()) return;
  cardEventNextStartAt = 0;
  const now = Date.now();
  const event = cardEventState = {
    id: 'card-' + now + '-' + crypto.randomBytes(6).toString('hex'),
    status: 'active',
    startedAt: now,
    endsAt: now + CARD_EVENT_DURATION_MS,
    rewards: shuffledCardRewards(),
    votes: {},
    voterNames: [[], [], []],
    announcementMessageId: 0,
    completedAt: 0,
    announcement: '',
  };
  const message = {
    id: chatNextId++, uid: RANDOM_BOT_UID, name: RANDOM_BOT_NAME,
    room: 'fa', text: 'ZombieBot یک رویداد کارت شروع کرد! ۳۰ ثانیه فرصت دارید یک کارت انتخاب کنید.',
    ts: now, isAdmin: false, isDesigner: false, chatMuted: false, replyTo: null,
    cardEventId: event.id, isZombieBot: RANDOM_BOT_IS_ZOMBIEBOT,
  };
  event.announcementMessageId = message.id;
  chatMessages.push(message);
  if (chatMessages.length > CHAT_MAX_STORED) chatMessages = chatMessages.slice(-CHAT_MAX_STORED);
  persistCardEventState();
  persistChat();
  broadcastChatEvent('message');
  broadcastChatEvent('card-event', { event: publicCardEvent(null) });
  if (cardEventFinishTimer) clearTimeout(cardEventFinishTimer);
  cardEventFinishTimer = setTimeout(() => { void finishCardEvent(event.id); }, CARD_EVENT_DURATION_MS);
}
async function finishCardEvent(eventId) {
  const event = cardEventState;
  if (!event || String(event.id) !== String(eventId) || !['active', 'settling'].includes(event.status)) return;
  if (event.status === 'active' && Date.now() < event.endsAt) {
    if (cardEventFinishTimer) clearTimeout(cardEventFinishTimer);
    cardEventFinishTimer = setTimeout(() => { void finishCardEvent(event.id); }, event.endsAt - Date.now());
    return;
  }
  event.status = 'settling';
  persistCardEventState();
  const voterNames = [[], [], []];
  Object.entries(event.votes || {}).forEach(([uid, card]) => {
    const index = Number(card) - 1, user = users[String(uid)];
    if (index < 0 || index > 2 || !user) return;
    const reward = Number(event.rewards[index]) || 0;
    if (!user.cardEventRewards || typeof user.cardEventRewards !== 'object') user.cardEventRewards = {};
    if (!Object.hasOwn(user.cardEventRewards, event.id)) {
      user.cardEventRewards[event.id] = reward;
      if (reward > 0) creditTT(user, reward, 'card-event-vote');
    }
    voterNames[index].push(user.name || ('Player ' + uid));
  });
  await persist();
  event.voterNames = voterNames;
  event.status = 'complete';
  event.completedAt = Date.now();
  event.announcement = voterNames.map((names, index) => {
    const reward = Number(event.rewards[index]) || 0;
    return `کارت ${index + 1}: ${names.length ? names.join('، ') : 'کسی انتخاب نکرد'} · ${reward ? '+' + reward + ' TT' : 'باخت'}`;
  }).join(' | ');
  const announcement = chatMessages.find((message) => String(message.cardEventId || '') === String(event.id));
  if (announcement) {
    announcement.text = 'نتیجه رویداد کارت: ' + event.announcement;
    announcement.cardEventResult = publicCardEvent(null);
  }
  persistCardEventState();
  persistChat();
  scheduleNextCardEvent();
  broadcastChatEvent('card-event-finished', { event: publicCardEvent(null) });
  broadcastChatEvent('message');
}
function startCardEventScheduler() {
  if (cardEventState && ['active', 'settling'].includes(cardEventState.status)) {
    const delay = cardEventState.status === 'active' ? Math.max(0, cardEventState.endsAt - Date.now()) : 0;
    cardEventFinishTimer = setTimeout(() => { void finishCardEvent(cardEventState.id); }, delay);
    return;
  }
  scheduleNextCardEvent();
}

// ---------------------------------------------------------------------------
// Taxi Race: a recurring 5-player mini-race, broadcast to every connected chat
// client over the same SSE channel as the chat/card-event updates. The server
// is the sole authority on scheduling, player selection and the winner - it
// runs the entire ~30s simulation up front and sends the finished timeline;
// clients only replay it, never decide anything themselves.
// ---------------------------------------------------------------------------
// Event ended (see chat request) - scheduling is disabled below (see
// TAXI_RACE_ENABLED); the simulation/scheduling code is left in place in case
// the event is brought back later.
const TAXI_RACE_ENABLED = false;
const TAXI_RACE_FILE = path.join(DATA_DIR, 'taxi-race.json');
const TAXI_RACE_ROOM = 'fa'; // the race (and its bot messages) only ever appear in the Farsi room
const TAXI_RACE_INTERVAL_MS = 5 * 60 * 1000;
const TAXI_RACE_PICK_AHEAD_MS = 60 * 1000; // drivers are drawn/announced 1 minute before the race actually starts, to allow predictions
const TAXI_RACE_MAX_DURATION_MS = 90 * 1000; // safety cap in case nobody reaches the finish line quickly
const TAXI_RACE_TICK_MS = 500; // one simulation sample every 500ms
const TAXI_RACE_MIN_PLAYERS = 2;
const TAXI_RACE_MAX_PLAYERS = 5;
const TAXI_RACE_REWARD_TT = 250;
const TAXI_RACE_TIP_TT = 100; // reward for a spectator correctly predicting the winner
// Occasionally a race is a "bonus race" with a much bigger prize (random, roughly
// 1-in-10 races on average, but never two bonus races back-to-back - see
// rollTaxiRaceBonus()).
const TAXI_RACE_BONUS_CHANCE = 0.1;
const TAXI_RACE_BONUS_MIN_GAP = 3; // at least this many normal races must happen between two bonus races
const TAXI_RACE_BONUS_WINNER_MULT = 10;
const TAXI_RACE_BONUS_TIP_MULT = 5;
// Bump this number to force the very next race (after the next deploy/restart)
// to be a guaranteed bonus race, regardless of how much race history already
// exists in the persisted state file. Each version is only "spent" once.
const TAXI_RACE_FORCE_BONUS_VERSION = 3;

let taxiRaceState = null; // null = no race has happened yet (or none kept around) - see taxiRaceNextStartAt for the countdown
let taxiRaceNextStartAt = 0;
let taxiRaceRacesSinceBonus = TAXI_RACE_BONUS_MIN_GAP; // allow a bonus race right away on first boot
let taxiRaceForcedBonusVersion = 0; // last TAXI_RACE_FORCE_BONUS_VERSION that was already "spent" forcing a bonus race
let taxiRaceGridTimer = null; // fires when the drivers for the next race are drawn/announced
let taxiRaceRunTimer = null; // fires when a drawn race actually starts running
let taxiRaceFinishTimer = null;
try {
  if (fs.existsSync(TAXI_RACE_FILE)) {
    const loaded = readJsonFile(TAXI_RACE_FILE);
    if (loaded && typeof loaded === 'object') {
      taxiRaceNextStartAt = Number(loaded.nextStartAt) || 0;
      taxiRaceRacesSinceBonus = Number.isFinite(Number(loaded.racesSinceBonus)) ? Number(loaded.racesSinceBonus) : TAXI_RACE_BONUS_MIN_GAP;
      taxiRaceForcedBonusVersion = Number(loaded.forcedBonusVersion) || 0;
      if (loaded.race && typeof loaded.race.id === 'string') taxiRaceState = loaded.race;
    }
  }
} catch (error) {
  console.error('[taxi-race] state file unreadable: ' + error.message);
}
function persistTaxiRaceState() {
  try {
    const tmp = TAXI_RACE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ nextStartAt: taxiRaceNextStartAt, racesSinceBonus: taxiRaceRacesSinceBonus, forcedBonusVersion: taxiRaceForcedBonusVersion, race: taxiRaceState }));
    fs.renameSync(tmp, TAXI_RACE_FILE);
  } catch (error) {
    console.error('[taxi-race] state write failed: ' + error.message);
  }
}
// Decides whether the next race is a bonus race (bigger prize). If
// TAXI_RACE_FORCE_BONUS_VERSION was just bumped in a deploy (and hasn't been
// "spent" yet on this persisted state), the next race is always a bonus race
// - this is how we guarantee a bonus race right after a deploy, regardless of
// whatever race history already exists on the server. Otherwise, keeps the
// random 1-in-10 feel but guarantees a cooldown so it can never fire twice in
// a row (or too frequently) - see TAXI_RACE_BONUS_MIN_GAP.
function rollTaxiRaceBonus() {
  if (taxiRaceForcedBonusVersion < TAXI_RACE_FORCE_BONUS_VERSION) {
    taxiRaceForcedBonusVersion = TAXI_RACE_FORCE_BONUS_VERSION;
    taxiRaceRacesSinceBonus = 0;
    return true;
  }
  taxiRaceRacesSinceBonus++;
  if (taxiRaceRacesSinceBonus >= TAXI_RACE_BONUS_MIN_GAP && Math.random() < TAXI_RACE_BONUS_CHANCE) {
    taxiRaceRacesSinceBonus = 0;
    return true;
  }
  return false;
}
function isTaxiRaceActive() {
  return !!(taxiRaceState && taxiRaceState.status === 'running');
}
// viewerUid (optional) adds the viewer's own prediction/racing-status, which is
// only meaningful for a direct, authenticated poll - SSE broadcasts go out to
// everyone at once so they only ever carry the shared, viewer-agnostic fields.
function publicTaxiRace(viewerUid) {
  if (!TAXI_RACE_ENABLED) return null;
  if (!taxiRaceState) return taxiRaceNextStartAt ? { status: 'scheduled', nextStartAt: taxiRaceNextStartAt } : null;
  const race = taxiRaceState;
  const predictionCounts = {};
  Object.values(race.predictions || {}).forEach((pick) => { predictionCounts[pick] = (predictionCounts[pick] || 0) + 1; });
  const result = {
    id: race.id,
    status: race.status, // 'grid' (drivers drawn, predictions open) | 'running' | 'finished'
    startsAt: race.startsAt,
    startedAt: race.startedAt,
    endsAt: race.endsAt,
    drivers: race.drivers.map((d) => ({ uid: d.uid, name: d.name, photoUrl: d.photoUrl, events: d.events, samples: d.samples, finalPos: d.finalPos })),
    winnerUid: race.winnerUid,
    winnerName: race.winnerName,
    predictionCounts,
    totalPredictions: Object.keys(race.predictions || {}).length,
    correctNames: race.correctNames || null,
    isBonus: race.isBonus === true,
    tipRewardTT: race.tipRewardTT || TAXI_RACE_TIP_TT,
    rewardTT: race.rewardTT || TAXI_RACE_REWARD_TT,
  };
  if (viewerUid != null) {
    result.myPrediction = (race.predictions || {})[String(viewerUid)] || null;
    result.amRacing = race.drivers.some((d) => String(d.uid) === String(viewerUid));
  }
  if (taxiRaceNextStartAt) result.nextStartAt = taxiRaceNextStartAt;
  return result;
}
// Runs the whole race up front: per driver, a tick-by-tick progress curve (0 to
// 100) with randomly placed boosts (⚡ speed up) and breakdowns (💨 slow down).
// The race ends the instant the first driver crosses the 100 finish line -
// that driver is the winner, purely as a result of the simulation (nothing is
// decided in advance). Typically takes ~30s, same as a real 30-second-ish
// drive, but is not a fixed duration - a safety cap just prevents a pathological
// all-breakdowns run from never finishing.
function simulateTaxiRace(players) {
  const dt = TAXI_RACE_TICK_MS / 1000;
  const maxTicks = Math.round(TAXI_RACE_MAX_DURATION_MS / TAXI_RACE_TICK_MS);
  const drivers = players.map((p) => ({
    uid: p.uid, name: p.name, photoUrl: p.photoUrl,
    pos: 0, fx: null, fxUntil: 0, finished: false,
    events: [],
    samples: [{ t: 0, pos: 0 }],
  }));
  let winner = null;
  let finishedAtMs = TAXI_RACE_MAX_DURATION_MS;
  for (let tick = 1; tick <= maxTicks && !winner; tick++) {
    const t = tick * TAXI_RACE_TICK_MS;
    drivers.forEach((driver) => {
      if (driver.finished) return;
      if (driver.fx && t >= driver.fxUntil) driver.fx = null;
      if (!driver.fx) {
        const roll = Math.random();
        if (roll < 0.09) { driver.fx = 'boost'; driver.fxUntil = t + 1500; driver.events.push({ t, type: 'boost' }); }
        else if (roll < 0.16) { driver.fx = 'breakdown'; driver.fxUntil = t + 1500; driver.events.push({ t, type: 'breakdown' }); }
      }
      const mult = driver.fx === 'boost' ? 2.2 : driver.fx === 'breakdown' ? 0.15 : 1;
      driver.pos = Math.min(100, driver.pos + (2.3 + Math.random() * 1.6) * mult * dt);
      driver.samples.push({ t, pos: Math.round(driver.pos * 100) / 100 });
      if (driver.pos >= 100 && !driver.finished) {
        driver.finished = true;
        if (!winner) { winner = driver; finishedAtMs = t; }
      }
    });
  }
  if (!winner) {
    winner = drivers.reduce((best, d) => (!best || d.pos > best.pos ? d : best), null);
  }
  drivers.forEach((driver) => {
    driver.finalPos = driver.samples[driver.samples.length - 1].pos;
    delete driver.pos; delete driver.fx; delete driver.fxUntil; delete driver.finished;
  });
  return { drivers, winnerUid: winner.uid, winnerName: winner.name, durationMs: finishedAtMs };
}
function postTaxiRaceBotMessage(text, raceId, kind) {
  chatMessages.push({
    id: chatNextId++, uid: RANDOM_BOT_UID, name: RANDOM_BOT_NAME, room: TAXI_RACE_ROOM, text,
    ts: Date.now(), isAdmin: false, isDesigner: false, chatMuted: false, replyTo: null,
    taxiRaceId: raceId, taxiRaceKind: kind, isZombieBot: RANDOM_BOT_IS_ZOMBIEBOT,
  });
  if (chatMessages.length > CHAT_MAX_STORED) chatMessages = chatMessages.slice(-CHAT_MAX_STORED);
  persistChat();
}
function scheduleNextTaxiRace() {
  if (taxiRaceGridTimer) clearTimeout(taxiRaceGridTimer);
  if (taxiRaceRunTimer) clearTimeout(taxiRaceRunTimer);
  taxiRaceNextStartAt = Date.now() + TAXI_RACE_INTERVAL_MS;
  taxiRaceGridTimer = setTimeout(drawTaxiRaceGrid, Math.max(0, TAXI_RACE_INTERVAL_MS - TAXI_RACE_PICK_AHEAD_MS));
  persistTaxiRaceState();
  broadcastChatEvent('taxi-race', { event: publicTaxiRace() });
}
// Draws the 5 (or fewer) drivers ~1 minute before the race actually starts, and
// announces them so everyone else online can freely predict the winner.
function drawTaxiRaceGrid() {
  if (isTaxiRaceActive()) {
    // A previous race is still running past this scheduling point - retry shortly instead of overlapping.
    taxiRaceGridTimer = setTimeout(drawTaxiRaceGrid, 5000);
    return;
  }
  const now = Date.now();
  const onlineUsers = Object.values(users).filter((u) => now - Number(u.lastSeenAt || 0) < ONLINE_WINDOW_MS && u.isBanned !== true);
  if (onlineUsers.length < TAXI_RACE_MIN_PLAYERS) {
    taxiRaceState = null;
    scheduleNextTaxiRace();
    return;
  }
  const shuffled = onlineUsers.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const players = shuffled.slice(0, TAXI_RACE_MAX_PLAYERS).map((u) => ({
    uid: String(u.id), name: u.name || ('Player ' + u.id), photoUrl: u.profileImage || u.photoUrl || '',
  }));
  const raceId = 'race-' + now + '-' + crypto.randomBytes(5).toString('hex');
  const startsAt = Math.max(taxiRaceNextStartAt, now + 1000);
  const isBonus = rollTaxiRaceBonus();
  const rewardTT = isBonus ? TAXI_RACE_REWARD_TT * TAXI_RACE_BONUS_WINNER_MULT : TAXI_RACE_REWARD_TT;
  const tipRewardTT = isBonus ? TAXI_RACE_TIP_TT * TAXI_RACE_BONUS_TIP_MULT : TAXI_RACE_TIP_TT;
  taxiRaceState = {
    id: raceId,
    status: 'grid',
    startsAt,
    drivers: players.map((p) => ({ uid: p.uid, name: p.name, photoUrl: p.photoUrl, events: [], samples: [] })),
    predictions: {}, // uid -> picked driver uid
    winnerUid: null,
    winnerName: null,
    correctNames: null,
    isBonus,
    rewardTT,
    tipRewardTT,
    payoutDone: false,
  };
  persistTaxiRaceState();
  const bonusPrefix = isBonus ? '🔥 رنس بونوس امروز! جایزه x10 ' : '';
  postTaxiRaceBotMessage(bonusPrefix + '🔮 رانندگان مشخص شدند: ' + players.map((p) => p.name).join('، ') + '. برنده را رایگان حدس بزن — حدس درست ' + tipRewardTT + ' TT جایزه دارد!', raceId, 'grid');
  broadcastChatEvent('taxi-race', { event: publicTaxiRace() });
  broadcastChatEvent('message');
  if (taxiRaceRunTimer) clearTimeout(taxiRaceRunTimer);
  taxiRaceRunTimer = setTimeout(() => startDrawnTaxiRace(raceId), Math.max(0, startsAt - Date.now()));
}
function startDrawnTaxiRace(raceId) {
  const race = taxiRaceState;
  if (!race || race.id !== raceId || race.status !== 'grid') return;
  const sim = simulateTaxiRace(race.drivers);
  const startedAt = Date.now();
  race.status = 'running';
  race.startedAt = startedAt;
  race.endsAt = startedAt + sim.durationMs;
  race.drivers = sim.drivers;
  race.winnerUid = sim.winnerUid;
  race.winnerName = sim.winnerName;
  persistTaxiRaceState();
  const tipCount = Object.keys(race.predictions || {}).length;
  const startBonusPrefix = race.isBonus ? '🔥 ' : '';
  postTaxiRaceBotMessage(startBonusPrefix + '🚦 شروع شد! پیش‌بینی‌ها بسته شدند (' + tipCount + ' پیش‌بینی). برنده ' + (race.rewardTT || TAXI_RACE_REWARD_TT) + ' TT می‌گیرد!', raceId, 'start');
  broadcastChatEvent('taxi-race', { event: publicTaxiRace() });
  broadcastChatEvent('message');
  if (taxiRaceFinishTimer) clearTimeout(taxiRaceFinishTimer);
  // Capture raceId by value now - reading taxiRaceState.id from inside the
  // callback instead would re-evaluate the (mutable) global at fire time,
  // which could by then be null or a different race.
  taxiRaceFinishTimer = setTimeout(() => finishTaxiRace(raceId), sim.durationMs);
  scheduleNextTaxiRace();
}
function finishTaxiRace(raceId) {
  const race = taxiRaceState;
  if (!race || race.id !== raceId || race.status !== 'running') return;
  race.status = 'finished';
  race.completedAt = Date.now();
  const rewardTT = race.rewardTT || TAXI_RACE_REWARD_TT;
  const tipRewardTT = race.tipRewardTT || TAXI_RACE_TIP_TT;
  if (!race.payoutDone) {
    race.payoutDone = true; // set before the async persist() call so a near-simultaneous restart can't double-pay
    const winner = users[String(race.winnerUid)];
    if (winner) {
      creditTT(winner, rewardTT, 'taxi-race-winner');
    }
    const correctUids = Object.entries(race.predictions || {}).filter(([, pick]) => String(pick) === String(race.winnerUid)).map(([uid]) => uid);
    race.correctNames = correctUids.map((uid) => (users[uid] && users[uid].name) || ('Player ' + uid));
    correctUids.forEach((uid) => {
      const predictor = users[uid];
      if (predictor) creditTT(predictor, tipRewardTT, 'taxi-race-tip');
    });
    persist();
  }
  persistTaxiRaceState();
  const tipLine = race.correctNames && race.correctNames.length
    ? ' 🔮 ' + race.correctNames.length + ' نفر درست حدس زدند و هرکدام ' + tipRewardTT + ' TT گرفتند: ' + race.correctNames.join('، ') + '.'
    : '';
  const finishBonusPrefix = race.isBonus ? '🔥 ' : '';
  postTaxiRaceBotMessage(finishBonusPrefix + '🏆 ' + race.winnerName + ' اول به خط پایان رسید و ' + rewardTT + ' TT برد!' + tipLine + ' مسابقه بعدی تا ۵ دقیقه دیگر.', race.id, 'winner');
  broadcastChatEvent('taxi-race', { event: publicTaxiRace() });
  broadcastChatEvent('message');
}
function startTaxiRaceScheduler() {
  if (taxiRaceState && taxiRaceState.status === 'running') {
    taxiRaceFinishTimer = setTimeout(() => finishTaxiRace(taxiRaceState.id), Math.max(0, taxiRaceState.endsAt - Date.now()));
    // scheduleNextTaxiRace() was already called when this race started running,
    // so taxiRaceNextStartAt correctly points to the *next* race's grid draw -
    // but a restart destroys every in-memory timer, including that one, so it
    // must be re-armed here too. Without this, the whole cycle would stall
    // forever (stuck showing the old countdown) the instant this race ends.
    const gridAt = taxiRaceNextStartAt - TAXI_RACE_PICK_AHEAD_MS;
    if (taxiRaceNextStartAt && gridAt > Date.now()) {
      taxiRaceGridTimer = setTimeout(drawTaxiRaceGrid, gridAt - Date.now());
    } else if (taxiRaceNextStartAt && taxiRaceNextStartAt > Date.now()) {
      taxiRaceGridTimer = setTimeout(drawTaxiRaceGrid, 0);
    } else {
      scheduleNextTaxiRace();
    }
    return;
  }
  if (taxiRaceState && taxiRaceState.status === 'grid') {
    // taxiRaceNextStartAt still refers to *this* grid's own start time here
    // (scheduleNextTaxiRace() for the race after it only runs once this grid
    // turns into a running race), so only the run timer needs resuming - the
    // following grid draw gets scheduled naturally once that happens.
    const raceId = taxiRaceState.id;
    taxiRaceRunTimer = setTimeout(() => startDrawnTaxiRace(raceId), Math.max(0, taxiRaceState.startsAt - Date.now()));
    return;
  }
  const gridAt = taxiRaceNextStartAt - TAXI_RACE_PICK_AHEAD_MS;
  if (taxiRaceNextStartAt && gridAt > Date.now()) {
    taxiRaceGridTimer = setTimeout(drawTaxiRaceGrid, gridAt - Date.now());
  } else if (taxiRaceNextStartAt && taxiRaceNextStartAt > Date.now()) {
    // We're already past the normal draw point but the race hasn't started yet - draw right away.
    taxiRaceGridTimer = setTimeout(drawTaxiRaceGrid, 0);
  } else {
    scheduleNextTaxiRace();
  }
}

// ---------------------------------------------------------------------------
// Monster-Boss-Event ("Raid"): every MONSTER_INTERVAL_MS a boss shows up in the
// chat (Farsi room, same convention as the taxi race) with HP scaled to how
// many users are online. Everyone online can tap/hit it together within a
// fixed time limit; the server is authoritative for HP, damage rolls, the
// shield-penalty phases, and the one-time TON payout (clients only render
// what the server broadcasts and never decide anything themselves).
// Disabled on purpose: replaced by chat events further below (Zombie-Lotto,
// since removed; "لیگ برق‌آسا"/Blitz-Liga is the current one). Code kept
// intact in case the Monster-Boss event ever comes back.
const MONSTER_EVENT_ENABLED = false;
const MONSTER_ROOM = 'fa'; // same room convention as the taxi race
const MONSTER_FILE = path.join(DATA_DIR, 'monster-event.json');
const MONSTER_INTERVAL_MS = 20 * 60 * 1000; // a new boss every 20 minutes
const MONSTER_WARN_MS = 60 * 1000; // "boss in 1 minute" heads-up
const MONSTER_INTRO_MS = 3000; // 3..2..1..fight countdown
const MONSTER_FIGHT_MS = 180 * 1000; // 3 minutes to kill it
const MONSTER_HP_PER_PLAYER = 1750;
const MONSTER_MIN_PLAYERS = 1;
const MONSTER_REWARD_TOP = [0.2, 0.1, 0.1]; // TON for the top 3 damage dealers
const MONSTER_REWARD_ALL = 0.01; // TON for every other attacker, once the boss dies
const MONSTER_SHIELD_PENALTY = 150; // damage subtracted from YOUR OWN total if you hit a shielded boss
const MONSTER_TAP_RATE_LIMIT = 8; // max taps/second counted per user (anti-spam)
const MONSTER_BROADCAST_MS = 200; // coalesce rapid hits into one SSE update every 200ms

let monsterState = null; // null = no fight in progress
let monsterNextStartAt = 0;
let monsterWarnTimer = null;
let monsterIntroTimer = null;
let monsterFightTimer = null;
let monsterShieldTimer = null;
let monsterBroadcastTimer = null;
let monsterDirty = false;
try {
  if (fs.existsSync(MONSTER_FILE)) {
    const loaded = readJsonFile(MONSTER_FILE);
    if (loaded && typeof loaded === 'object') monsterNextStartAt = Number(loaded.nextStartAt) || 0;
  }
} catch (error) {
  console.error('[monster] state read failed: ' + error.message);
}
function persistMonsterState() {
  try {
    const tmp = MONSTER_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ nextStartAt: monsterNextStartAt }));
    fs.renameSync(tmp, MONSTER_FILE);
  } catch (error) {
    console.error('[monster] state write failed: ' + error.message);
  }
}
function postMonsterBotMessage(text) {
  chatMessages.push({
    id: chatNextId++, uid: RANDOM_BOT_UID, name: RANDOM_BOT_NAME, room: MONSTER_ROOM, text,
    ts: Date.now(), isAdmin: false, isDesigner: false, chatMuted: false, replyTo: null, isZombieBot: RANDOM_BOT_IS_ZOMBIEBOT,
  });
  if (chatMessages.length > CHAT_MAX_STORED) chatMessages = chatMessages.slice(-CHAT_MAX_STORED);
  persistChat();
}
function publicMonster(viewerUid) {
  if (!MONSTER_EVENT_ENABLED) return null;
  if (!monsterState) return monsterNextStartAt ? { status: 'scheduled', nextStartAt: monsterNextStartAt } : null;
  const m = monsterState;
  const ranking = Object.entries(m.dmg)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([uid, v]) => ({ uid, name: m.names[uid] || ('Player ' + uid), dmg: Math.round(v) }));
  const result = {
    id: m.id,
    status: m.status, // 'intro' | 'fight' | 'finished'
    introEndsAt: m.introEndsAt || null,
    startedAt: m.startedAt || null,
    endsAt: m.endsAt || null,
    maxHp: m.maxHp,
    hp: Math.max(0, Math.round(m.hp)),
    rage: m.hp <= m.maxHp * 0.25,
    shield: !!m.shield,
    ranking: ranking.slice(0, 10),
    won: m.status === 'finished' ? m.won : null,
  };
  if (viewerUid != null) result.myDamage = Math.round(m.dmg[String(viewerUid)] || 0);
  if (monsterNextStartAt) result.nextStartAt = monsterNextStartAt;
  return result;
}
function scheduleMonsterBroadcast() {
  monsterDirty = true;
  if (monsterBroadcastTimer) return;
  monsterBroadcastTimer = setTimeout(() => {
    monsterBroadcastTimer = null;
    if (!monsterDirty) return;
    monsterDirty = false;
    broadcastChatEvent('monster', { event: publicMonster() });
  }, MONSTER_BROADCAST_MS);
}
function scheduleNextMonster() {
  if (monsterWarnTimer) clearTimeout(monsterWarnTimer);
  monsterNextStartAt = Date.now() + MONSTER_INTERVAL_MS;
  monsterWarnTimer = setTimeout(warnMonster, Math.max(0, MONSTER_INTERVAL_MS - MONSTER_WARN_MS));
  persistMonsterState();
  broadcastChatEvent('monster', { event: publicMonster() });
}
function warnMonster() {
  if (monsterState) { monsterWarnTimer = setTimeout(warnMonster, 5000); return; } // previous fight still wrapping up
  postMonsterBotMessage('👹 در یک دقیقه‌ی دیگر یک باس ظاهر می‌شود! آنلاین بمانید و برای نبرد گروهی آماده شوید.');
  broadcastChatEvent('message');
  monsterIntroTimer = setTimeout(startMonsterIntro, MONSTER_WARN_MS);
}
function startMonsterIntro() {
  const now = Date.now();
  const onlineUsers = Object.values(users).filter((u) => now - Number(u.lastSeenAt || 0) < ONLINE_WINDOW_MS && u.isBanned !== true);
  if (onlineUsers.length < MONSTER_MIN_PLAYERS) { scheduleNextMonster(); return; }
  const maxHp = onlineUsers.length * MONSTER_HP_PER_PLAYER;
  monsterState = {
    id: 'monster-' + now + '-' + crypto.randomBytes(5).toString('hex'),
    status: 'intro',
    introEndsAt: now + MONSTER_INTRO_MS,
    maxHp, hp: maxHp,
    dmg: {}, names: {}, tapLog: {},
    shield: false,
    won: null,
    payoutDone: false,
  };
  persistMonsterState();
  broadcastChatEvent('monster', { event: publicMonster() });
  monsterFightTimer = setTimeout(startMonsterFight, MONSTER_INTRO_MS);
}
function startMonsterFight() {
  if (!monsterState || monsterState.status !== 'intro') return;
  const now = Date.now();
  monsterState.status = 'fight';
  monsterState.startedAt = now;
  monsterState.endsAt = now + MONSTER_FIGHT_MS;
  postMonsterBotMessage('👹 یک باس با ' + Math.round(monsterState.maxHp).toLocaleString('fa-IR') + ' جان ظاهر شد! تا می‌توانید سریع ضربه بزنید — ۳ دقیقه وقت دارید!');
  broadcastChatEvent('message');
  broadcastChatEvent('monster', { event: publicMonster() });
  scheduleMonsterShield();
  monsterFightTimer = setTimeout(() => finishMonster(false), MONSTER_FIGHT_MS);
}
function scheduleMonsterShield() {
  if (monsterShieldTimer) clearTimeout(monsterShieldTimer);
  monsterShieldTimer = setTimeout(() => {
    if (!monsterState || monsterState.status !== 'fight') return;
    monsterState.shield = true;
    scheduleMonsterBroadcast();
    const len = 2000 + Math.random() * 1200;
    monsterShieldTimer = setTimeout(() => {
      if (!monsterState || monsterState.status !== 'fight') return;
      monsterState.shield = false;
      scheduleMonsterBroadcast();
      scheduleMonsterShield();
    }, len);
  }, 12000 + Math.random() * 6000);
}
function finishMonster(won) {
  if (!monsterState || monsterState.status === 'finished') return;
  const m = monsterState;
  m.status = 'finished';
  m.won = won;
  if (monsterShieldTimer) { clearTimeout(monsterShieldTimer); monsterShieldTimer = null; }
  const ranking = Object.entries(m.dmg).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (won && !m.payoutDone) {
    m.payoutDone = true; // set before persist() so a near-simultaneous restart can't double-pay
    ranking.forEach(([uid, dmgDone], index) => {
      const user = users[uid];
      if (!user) return;
      const reward = index < 3 ? MONSTER_REWARD_TOP[index] : MONSTER_REWARD_ALL;
      user.ton = Number(((Number(user.ton) || 0) + reward).toFixed(6));
      user.monsterRewards = Array.isArray(user.monsterRewards) ? user.monsterRewards : [];
      user.monsterRewards.push({ ts: Date.now(), amount: reward, rank: index + 1, monsterId: m.id, dmg: Math.round(dmgDone) });
    });
    persist();
  }
  const topLine = ranking.slice(0, 3).map((e, i) => (m.names[e[0]] || ('Player ' + e[0])) + ' (+' + MONSTER_REWARD_TOP[i] + ' TON)').join('، ');
  if (won) postMonsterBotMessage('🎉 باس شکست خورد! بیشترین آسیب: ' + topLine + '. بقیه‌ی مبارزان ' + MONSTER_REWARD_ALL + ' TON دریافت کردند.');
  else postMonsterBotMessage('💀 زمان تمام شد — باس فرار کرد! این بار جایزه‌ای نیست.');
  broadcastChatEvent('message');
  broadcastChatEvent('monster', { event: publicMonster() });
  setTimeout(() => { monsterState = null; scheduleNextMonster(); }, 10000);
}
function startMonsterScheduler() {
  if (monsterNextStartAt && monsterNextStartAt > Date.now()) {
    monsterWarnTimer = setTimeout(warnMonster, Math.max(0, monsterNextStartAt - MONSTER_WARN_MS - Date.now()));
  } else {
    scheduleNextMonster();
  }
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
  try {
    fs.writeFileSync(RPS_FILE + '.shutdown.tmp', JSON.stringify(rpsGames));
    fs.renameSync(RPS_FILE + '.shutdown.tmp', RPS_FILE);
  } catch (e) {
    console.error('[rps] final flush failed: ' + e.message);
  }
  try {
    fs.writeFileSync(CHAT_FILE + '.shutdown.tmp', JSON.stringify(chatMessages));
    fs.renameSync(CHAT_FILE + '.shutdown.tmp', CHAT_FILE);
  } catch (e) {
    console.error('[chat] final flush failed: ' + e.message);
  }
  try {
    fs.writeFileSync(MAGIC_TOWER_FILE + '.shutdown.tmp', JSON.stringify(magicTowerGames));
    fs.renameSync(MAGIC_TOWER_FILE + '.shutdown.tmp', MAGIC_TOWER_FILE);
  } catch (e) {
    console.error('[magic-tower] final flush failed: ' + e.message);
  }
  try {
    fs.writeFileSync(ZOMBIE_TOWER_FILE + '.shutdown.tmp', JSON.stringify(zombieTowerGames));
    fs.renameSync(ZOMBIE_TOWER_FILE + '.shutdown.tmp', ZOMBIE_TOWER_FILE);
  } catch (e) {
    console.error('[zombie-tower] final flush failed: ' + e.message);
  }
}

function newUser(id, name) {
  return {
    id,
    name: name || ('Player ' + id),
    photoUrl: '',
    profileImage: '',
    bio: '',
    coins: 0,
    ton: 0,
    ttBalance: 0,
    ttCreditedLifetime: 0,
    ttWithdrawnLifetime: 0,
    ttLedger: [],
    ttWithdrawals: [],
    lastTtWithdrawalAt: 0,
    chatItems: { bub: [], frm: [], ban: [], eq: { bub: 'classic', frm: 'none', ban: 'classic' } },
    stickerPacks: [],
    friends: [],
    friendRequestsIn: [],
    friendRequestsOut: [],
    directMessages: {},
    directMessageReadAt: {},
    cardEventRewards: {},
    figCount: {},
    mine: { last: Date.now(), acc: 0 },
    ttOrders: [],
    tonToday: 0,
    tonTodayByLevel: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    tonDate: '',
    best: 0,
    runs: 0,
    level: 1,
    ownedSkins: ['yellow'],
    skinRewards: {},
    attemptsLeft: 10,
    attemptsResetAt: null,
    attemptsByLevel: {},
    attemptResetVersion: 0,
    taskChannelRewardClaimed: false,
    withdrawChannelTaskRewardClaimed: false,
    thirdChannelTaskRewardClaimed: false,
    adVideosWatched: 0,
    adRewardClaimed: false,
    createdAt: Date.now(),
    lastSeenAt: 0,
    tournamentBest: 0,
    tournamentDistance: 0,
    tournamentWeekKey: '',
    runStartedAt: 0,
    lastRunAt: 0,
    depositTxs: [],
    deposits: [],
    purchases: [],
    withdrawals: [],
    lastWithdrawalDay: '',
    lastWithdrawalAt: 0,
    referralCount: 0,
    referralRewardCount: 0,
    referralPendingZombies: 0,
    referredBy: null,
    referralRewardClaimed: false,
    inviteRewardsClaimed: {},
    campaignInvites: 0,
    campaignLastInviteAt: 0,
    campaignInviteCounted: false,
    blitzTips: {},
    blitzPaid: {},
    blitzWon: 0,
    isChatAdmin: false,
    adminBadge: 'boy',
    isDesigner: false,
    isSupporter: false,
    isDeveloper: false,
    badge4: false,
    badge5: false,
    chatMuted: false,
    isBanned: false,
  };
}

function referralCodeFor(uid) { return 'ref_' + String(uid); }

// ---------------------------------------------------------------
// TT balance ledger
// ------------------------------------------------------------------
// Every legitimate way a player's ttBalance can go UP funnels through this
// helper so we keep an audit trail (ttLedger) and a running lifetime total
// (ttCreditedLifetime) that can never be produced by the client - only by
// server code explicitly calling creditTT() with a server-computed amount.
// Before an on-chain TT withdrawal is allowed, we check that the player's
// current balance is actually explainable by that lifetime total (see
// ttBalanceIsPlausible below) as a sanity net against any future accounting
// bug that might otherwise let a withdrawal pay out TT that was never
// really credited by the server.
// ------------------------------------------------------------------
function creditTT(user, amount, reason) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return Number(user.ttBalance || 0);
  user.ttBalance = Number((Number(user.ttBalance || 0) + amt).toFixed(6));
  user.ttCreditedLifetime = Number((Number(user.ttCreditedLifetime || 0) + amt).toFixed(6));
  if (!Array.isArray(user.ttLedger)) user.ttLedger = [];
  user.ttLedger.push({ ts: Date.now(), delta: amt, reason: String(reason || ''), balanceAfter: user.ttBalance });
  if (user.ttLedger.length > 200) user.ttLedger = user.ttLedger.slice(-200);
  return user.ttBalance;
}

// Lifetime-credited total must always be able to explain the balance the
// player currently has plus whatever they've already withdrawn on-chain.
// A mismatch means ttBalance was changed by something other than creditTT()
// (or debited without using the ttBalance field consistently) and must be
// treated as suspicious rather than paid out.
function ttBalanceIsPlausible(user) {
  const credited = Number(user.ttCreditedLifetime || 0);
  const owed = Number(user.ttBalance || 0) + Number(user.ttWithdrawnLifetime || 0);
  return owed <= credited + TT_INTEGRITY_EPSILON;
}

// Settles the invite leaderboard once, the first time this is called after
// the campaign end date. Idempotent: safe to call from every request and
// from a periodic timer, since it checks inviteCampaignState.settled first.
function settleInviteLeaderboardIfDue() {
  if (inviteCampaignState.settled || Date.now() < INVITE_LEADERBOARD_ENDS_AT) return;
  const ranked = Object.values(users)
    .filter((u) => Number(u.campaignInvites || 0) > 0)
    .sort((a, b) => (Number(b.campaignInvites) - Number(a.campaignInvites)) || (Number(a.campaignLastInviteAt || 0) - Number(b.campaignLastInviteAt || 0)));
  const winners = [];
  ranked.slice(0, INVITE_LEADERBOARD_REWARDS.length).forEach((user, index) => {
    const reward = INVITE_LEADERBOARD_REWARDS[index];
    user.ton += reward;
    winners.push({ uid: String(user.id), name: user.name, invites: Number(user.campaignInvites), reward, rank: index + 1 });
  });
  inviteCampaignState = { settled: true, winners };
  persistInviteCampaignState();
  if (winners.length) persist();
  console.log('[invite-campaign] settled: ' + winners.length + ' winner(s) paid out.');
}
setInterval(settleInviteLeaderboardIfDue, 60000);

function applyReferral(user, referralCode) {
  if (!referralCode || user.referredBy || String(referralCode) === referralCodeFor(user.id)) return;
  const inviterId = String(referralCode).replace(/^ref_/, '');
  const inviter = users[inviterId];
  if (!inviter || String(inviter.id) === String(user.id)) return;
  user.referredBy = inviterId;
}

function syncCampaignInvite(user) {
  if (!user || !user.referredBy || user.campaignInviteCounted === true) return false;
  if (
    user.taskChannelRewardClaimed !== true ||
    user.withdrawChannelTaskRewardClaimed !== true ||
    user.thirdChannelTaskRewardClaimed !== true
  ) return false;
  const now = Date.now();
  if (now < INVITE_LEADERBOARD_STARTS_AT || now >= INVITE_LEADERBOARD_ENDS_AT) return false;
  const inviter = users[String(user.referredBy)];
  if (!inviter || String(inviter.id) === String(user.id)) return false;
  inviter.campaignInvites = Number(inviter.campaignInvites || 0) + 1;
  inviter.campaignLastInviteAt = now;
  user.campaignInviteCounted = true;
  return true;
}

async function sendTelegramStartMessage(chatId) {
  if (!BOT_TOKEN) throw new Error('server-missing-bot-token');
  const response = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: 'Welcome to TaxiTron! Start playing now.',
      reply_markup: {
        inline_keyboard: [[{
          text: '🎮 Start Game',
          web_app: { url: TELEGRAM_MINI_APP_URL },
        }]],
      },
    }),
  });
  const body = await response.json();
  if (!response.ok || body.ok !== true) {
    throw new Error('telegram-start-message-failed: ' + (body.description || response.status));
  }
}

async function setTelegramMenuButton(chatId) {
  if (!BOT_TOKEN) return;
  const menuButton = {
    type: 'web_app',
    text: '🎮 Game',
    web_app: { url: TELEGRAM_MINI_APP_URL },
  };
  const body = { menu_button: menuButton };
  if (chatId !== undefined && chatId !== null) body.chat_id = chatId;
  const response = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/setChatMenuButton', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || result.ok !== true) {
    throw new Error(result.description || 'setChatMenuButton fehlgeschlagen');
  }
}

// Sends a private Telegram DM to the admin (ADMIN_CHAT_ID) whenever a
// deposit is credited, so payments aren't missed even away from the
// admin panel. Best-effort: failures are logged, never thrown.
async function notifyAdminDeposit(user, amountTon) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return;
  try {
    const chatId = /^-?\d+$/.test(ADMIN_CHAT_ID) ? Number(ADMIN_CHAT_ID) : ADMIN_CHAT_ID;
    const name = telegramHtmlEscape(String(user.name || ('User ' + user.id)));
    const text = [
      '💰 Neue Einzahlung!',
      '',
      '👤 ' + name + ' (UID ' + user.id + ')',
      '💎 Betrag: ' + Number(amountTon).toFixed(6) + ' TON',
      '📊 Neuer Kontostand: ' + Number(user.ton).toFixed(6) + ' TON',
    ].join('\n');
    const response = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.ok !== true) {
      console.error('[telegram] admin deposit notify failed', { httpStatus: response.status, body });
    }
  } catch (error) {
    console.error('[telegram] admin deposit notify failed', error.message);
  }
}

// Generic best-effort admin DM, used by the TT withdrawal worker for
// low-balance warnings and cases that need a human to check the chain.
async function notifyAdminText(text) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return;
  try {
    const chatId = /^-?\d+$/.test(ADMIN_CHAT_ID) ? Number(ADMIN_CHAT_ID) : ADMIN_CHAT_ID;
    const response = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.ok !== true) {
      console.error('[telegram] admin notify failed', { httpStatus: response.status, body });
    }
  } catch (error) {
    console.error('[telegram] admin notify failed', error.message);
  }
}

async function startTelegramBot() {
  if (!BOT_TOKEN) {
    console.warn('[bot] NICHT gestartet: Token fehlt (BOT_TOKEN oder TELEGRAM_BOT_TOKEN)');
    return;
  }
  try {
    const webhookUrl = new URL(TELEGRAM_WEBHOOK_URL);
    if (webhookUrl.protocol !== 'https:') throw new Error('Webhook-URL muss HTTPS verwenden');
    const miniAppUrl = new URL(TELEGRAM_MINI_APP_URL);
    if (!['http:', 'https:'].includes(miniAppUrl.protocol)) throw new Error('Mini-App-URL muss HTTP oder HTTPS verwenden');
    const response = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/setWebhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl.toString(),
        allowed_updates: ['message'],
        drop_pending_updates: false,
      }),
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) {
      throw new Error(result.description || 'setWebhook fehlgeschlagen');
    }
    await setTelegramMenuButton();
    console.log('[bot] started (webhook)');
    console.log('[bot] webhook configured: ' + webhookUrl.toString());
    console.log('[bot] menu button configured: ' + miniAppUrl.toString());
  } catch (error) {
    console.error('[bot] NICHT gestartet: ' + error.message);
  }
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

function daysBetweenDayKeys(fromKey, toKey) {
  const from = Date.parse(fromKey + 'T00:00:00Z');
  const to = Date.parse(toKey + 'T00:00:00Z');
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.round((to - from) / 86400000);
}
function ensureDailyReset(user) {
  const today = berlinDayKey();
  if (!user.tonTodayByLevel || typeof user.tonTodayByLevel !== 'object') {
    user.tonTodayByLevel = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const legacyLevel = Math.max(1, Math.min(5, Number(user.level) || 1));
    user.tonTodayByLevel[legacyLevel] = Number(user.tonToday) || 0;
  }
  [1, 2, 3, 4, 5].forEach((level) => {
    const value = Number(user.tonTodayByLevel[level]);
    user.tonTodayByLevel[level] = Number.isFinite(value) ? Math.max(0, value) : 0;
  });
  if (!user.zombiesTodayByLevel || typeof user.zombiesTodayByLevel !== 'object') {
    user.zombiesTodayByLevel = { 2: 0, 3: 0, 4: 0, 5: 0 };
  }
  [2, 3, 4, 5].forEach((level) => {
    const value = Number(user.zombiesTodayByLevel[level]);
    user.zombiesTodayByLevel[level] = Number.isFinite(value) ? Math.max(0, value) : 0;
  });
  if (user.tonDate !== today) {
    user.tonDate = today;
    user.tonToday = 0;
    user.tonTodayByLevel = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    user.zombiesTodayByLevel = { 2: 0, 3: 0, 4: 0, 5: 0 };
  }
  if (user.adVideoDay !== today) {
    user.adVideoDay = today;
    user.adVideosWatched = 0;
    user.adRewardClaimed = false;
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

const ATTEMPT_LIMIT_LEVEL_ONE = 10;
const ATTEMPT_LIMIT_PREMIUM = 15;
const ATTEMPT_COOLDOWN_LEVEL_ONE_MS = 2 * 60 * 60 * 1000;
function attemptLimitForLevel(level) {
  return Number(level) >= 2 ? ATTEMPT_LIMIT_PREMIUM : ATTEMPT_LIMIT_LEVEL_ONE;
}
function nextBerlinMidnightTimestamp() {
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const wallMidnightUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1);
  let target = wallMidnightUtc;
  for (let i = 0; i < 2; i += 1) {
    const targetParts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Berlin',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(target)).map((part) => [part.type, part.value]));
    const berlinWallTime = Date.UTC(
      Number(targetParts.year),
      Number(targetParts.month) - 1,
      Number(targetParts.day),
      Number(targetParts.hour),
      Number(targetParts.minute),
      Number(targetParts.second)
    );
    const offset = berlinWallTime - target;
    target = wallMidnightUtc - offset;
  }
  return target;
}
function ensureAttemptState(user, level) {
  const normalizedLevel = Math.max(1, Math.min(5, Number(level) || 1));
  const max = attemptLimitForLevel(normalizedLevel);
  const today = berlinDayKey();
  if (!user.attemptsByLevel || typeof user.attemptsByLevel !== 'object') user.attemptsByLevel = {};
  let state = user.attemptsByLevel[normalizedLevel];
  if (!state || typeof state !== 'object') {
    const legacyLeft = normalizedLevel === 1 ? Number(user.attemptsLeft) : NaN;
    state = {
      left: Number.isFinite(legacyLeft) ? Math.max(0, Math.min(max, legacyLeft)) : max,
      resetAt: normalizedLevel === 1 ? Number(user.attemptsResetAt) || null : nextBerlinMidnightTimestamp(),
      resetDay: today,
      windowZombies: 0,
      windowRewardGiven: false,
    };
    user.attemptsByLevel[normalizedLevel] = state;
  }
  state.left = Math.max(0, Math.min(max, Number.isFinite(Number(state.left)) ? Number(state.left) : max));
  if (normalizedLevel >= 2) {
    if (state.resetDay !== today) state.left = max;
    state.resetDay = today;
    state.resetAt = nextBerlinMidnightTimestamp();
  } else {
    state.resetDay = '';
    state.resetAt = Number(state.resetAt) || null;
    if (state.left === 0 && state.resetAt && Date.now() >= state.resetAt) {
      state.left = max;
      state.resetAt = null;
      state.windowZombies = 0;
      state.windowRewardGiven = false;
    } else if (state.left > 0) {
      state.resetAt = null;
    }
  }
  if (normalizedLevel === 1) {
    user.attemptsLeft = state.left;
    user.attemptsResetAt = state.resetAt;
  }
  return state;
}
function publicAttemptsByLevel(user) {
  const result = {};
  [1, 2, 3, 4, 5].forEach((level) => {
    const state = ensureAttemptState(user, level);
    result[level] = { left: state.left, resetAt: state.resetAt, resetDay: state.resetDay };
  });
  return result;
}
function highestOwnedLevel(user) {
  const owned = Array.isArray(user.ownedSkins) ? user.ownedSkins : ['yellow'];
  return owned.includes('luna') ? 5 : owned.includes('green') ? 4 : owned.includes('white') ? 3 : owned.includes('red') ? 2 : 1;
}
function resolvePlayableLevel(user, requestedLevel) {
  const requested = Math.max(1, Math.min(5, Number(requestedLevel) || highestOwnedLevel(user)));
  const skin = requested >= 5 ? 'luna' : requested >= 4 ? 'green' : requested >= 3 ? 'white' : requested >= 2 ? 'red' : 'yellow';
  const owned = Array.isArray(user.ownedSkins) ? user.ownedSkins : ['yellow'];
  if (!owned.includes(skin)) return highestOwnedLevel(user);
  if (requested === 1 && highestOwnedLevel(user) >= 2) return highestOwnedLevel(user);
  return requested;
}
function consumeServerAttempt(user, level) {
  const state = ensureAttemptState(user, level);
  if (state.left <= 0) return false;
  state.left -= 1;
  if (Number(level) === 1 && state.left === 0) {
    state.resetAt = Date.now() + ATTEMPT_COOLDOWN_LEVEL_ONE_MS;
  }
  if (Number(level) === 1) {
    user.attemptsLeft = state.left;
    user.attemptsResetAt = state.resetAt;
  }
  return true;
}

function publicState(user) {
  ensureDailyReset(user);
  const ownedSkins = Array.isArray(user.ownedSkins) ? user.ownedSkins : ['yellow'];
  if (ownedSkins.indexOf('yellow') === -1) ownedSkins.unshift('yellow');
  user.ownedSkins = ownedSkins;
  if (!user.figCount || typeof user.figCount !== 'object') user.figCount = {};
  FIGURE_IDS.forEach((id) => {
    user.figCount[id] = Math.max(0, Math.floor(Number(user.figCount[id]) || 0));
  });
  if (!user.chatItems || typeof user.chatItems !== 'object') user.chatItems = {};
  ['bub', 'frm', 'ban'].forEach((kind) => {
    const freeId = kind === 'bub' ? 'classic' : kind === 'frm' ? 'none' : 'classic';
    if (!Array.isArray(user.chatItems[kind])) user.chatItems[kind] = [];
    user.chatItems[kind] = [...new Set(user.chatItems[kind].filter((id) => Object.hasOwn(TT_CHAT_ITEMS[kind], id)))];
    if (!user.chatItems.eq || typeof user.chatItems.eq !== 'object') user.chatItems.eq = {};
    if (!user.chatItems[kind].includes(freeId)) user.chatItems[kind].unshift(freeId);
    if (!user.chatItems[kind].includes(user.chatItems.eq[kind])) user.chatItems.eq[kind] = freeId;
  });
  if (!Array.isArray(user.stickerPacks)) user.stickerPacks = [];
  user.stickerPacks = [...new Set(user.stickerPacks.filter((id) => Object.hasOwn(TT_CHAT_ITEMS.stk, id)))];
  if (!Array.isArray(user.friends)) user.friends = [];
  if (!Array.isArray(user.friendRequestsIn)) user.friendRequestsIn = [];
  if (!Array.isArray(user.friendRequestsOut)) user.friendRequestsOut = [];
  if (!user.directMessages || typeof user.directMessages !== 'object') user.directMessages = {};
  if (!user.directMessageReadAt || typeof user.directMessageReadAt !== 'object') user.directMessageReadAt = {};
  if (!user.mine || typeof user.mine !== 'object') user.mine = { last: Date.now(), acc: 0 };
  user.mine.last = Math.max(0, Number(user.mine.last) || Date.now());
  user.mine.acc = Math.max(0, Number(user.mine.acc) || 0);
  user.level = ownedSkins.indexOf('luna') !== -1 ? 5 : ownedSkins.indexOf('green') !== -1 ? 4 : ownedSkins.indexOf('white') !== -1 ? 3 : ownedSkins.indexOf('red') !== -1 ? 2 : 1;
  if (!user.skinRewards || typeof user.skinRewards !== 'object') user.skinRewards = {};
  const rewardDays = { red:30, white:30, green:30, luna:LIMITED_SKIN_OFFERS.luna.rewardDays };
  const today = berlinDayKey();
  Object.keys(rewardDays).forEach((key) => {
    if (ownedSkins.includes(key) && !user.skinRewards[key]) {
      user.skinRewards[key] = { remainingDays: rewardDays[key], expiresAt: Date.now() + rewardDays[key] * 86400000, lastCreditDate: today, lastEarnedDate: '' };
    } else if (ownedSkins.includes(key) && user.skinRewards[key] && !user.skinRewards[key].expiresAt) {
      user.skinRewards[key].expiresAt = Date.now() + Number(user.skinRewards[key].remainingDays || rewardDays[key]) * 86400000;
    }
    if (user.skinRewards[key] && !Number.isFinite(Number(user.skinRewards[key].remainingDays))) {
      user.skinRewards[key].remainingDays = rewardDays[key];
    }
    // Calendar-based countdown: every Berlin calendar day that passes deducts a day,
    // no matter whether the user played or reached their daily TON cap that day.
    if (ownedSkins.includes(key) && user.skinRewards[key]) {
      const reward = user.skinRewards[key];
      const lastCredit = reward.lastCreditDate || today;
      const elapsedDays = daysBetweenDayKeys(lastCredit, today);
      if (elapsedDays > 0) {
        reward.remainingDays = Math.max(0, Number(reward.remainingDays || 0) - elapsedDays);
        reward.lastCreditDate = today;
      } else if (!reward.lastCreditDate) {
        reward.lastCreditDate = today;
      }
    }
  });
  return {
    uid: String(user.id),
    profilePhoto: user.profileImage || user.photoUrl || '',
    bio: typeof user.bio === 'string' ? user.bio.slice(0, 120) : '',
    coins: user.coins,
    ton: user.ton,
    totalWithdrawnTon: (Array.isArray(user.withdrawals) ? user.withdrawals : [])
      .filter((withdrawal) => withdrawal.status === 'completed')
      .reduce((sum, withdrawal) => sum + Number(withdrawal.grossAmount ?? withdrawal.amount ?? 0), 0),
    ttBalance: Number(user.ttBalance || 0),
    chatItems: {
      bub: user.chatItems.bub.slice(), frm: user.chatItems.frm.slice(), ban: user.chatItems.ban.slice(),
      eq: { ...user.chatItems.eq },
    },
    stickerPacks: user.stickerPacks.slice(),
    friends: user.friends.map((uid) => users[String(uid)]).filter(Boolean).map((friend) => ({
      uid: String(friend.id), name: friend.name || ('Player ' + friend.id), photoUrl: friend.profileImage || friend.photoUrl || '',
      chatItems: friend.chatItems && friend.chatItems.eq ? { ...friend.chatItems.eq } : { bub: 'classic', frm: 'none', ban: 'classic' },
    })),
    friendRequestsIn: user.friendRequestsIn.map((uid) => users[String(uid)]).filter(Boolean).map((friend) => ({
      uid: String(friend.id), name: friend.name || ('Player ' + friend.id), photoUrl: friend.profileImage || friend.photoUrl || '',
      chatItems: friend.chatItems && friend.chatItems.eq ? { ...friend.chatItems.eq } : { bub: 'classic', frm: 'none', ban: 'classic' },
    })),
    friendRequestsOut: user.friendRequestsOut.map((uid) => users[String(uid)]).filter(Boolean).map((friend) => ({
      uid: String(friend.id), name: friend.name || ('Player ' + friend.id), photoUrl: friend.profileImage || friend.photoUrl || '',
      chatItems: friend.chatItems && friend.chatItems.eq ? { ...friend.chatItems.eq } : { bub: 'classic', frm: 'none', ban: 'classic' },
    })),
    ttOrders: Array.isArray(user.ttOrders) ? user.ttOrders.slice(-50).reverse() : [],
    ttWithdrawals: Array.isArray(user.ttWithdrawals) ? user.ttWithdrawals.slice(-10).reverse().map(publicTtWithdrawal) : [],
    ttWithdrawPending: !!activeTtWithdrawal(user),
    figCount: user.figCount,
    mine: { last: user.mine.last, acc: user.mine.acc },
    tonToday: user.tonToday,
    tonTodayByLevel: user.tonTodayByLevel,
    zombiesTodayByLevel: user.zombiesTodayByLevel,
    lastWithdrawalDay: user.lastWithdrawalDay || '',
    lastWithdrawalAt: latestWithdrawalAt(user),
    best: user.best,
    runs: user.runs,
    level: user.level,
    ownedSkins,
    skinRewards: user.skinRewards,
    referralCode: referralCodeFor(user.id),
    referralCount: Number(user.referralCount || 0),
    referralRewardCount: Number(user.referralRewardCount || 0),
    referralPendingZombies: Number(user.referralPendingZombies || 0),
    inviteRewardsClaimed: user.inviteRewardsClaimed && typeof user.inviteRewardsClaimed === 'object' ? user.inviteRewardsClaimed : {},
    inviteEventEndsAt: INVITE_EVENT_ENDS_AT,
    campaignInvites: Number(user.campaignInvites || 0),
    attemptsByLevel: publicAttemptsByLevel(user),
    attemptResetVersion: user.attemptResetVersion || 0,
    taskChannelRewardClaimed: user.taskChannelRewardClaimed === true,
    withdrawChannelTaskRewardClaimed: user.withdrawChannelTaskRewardClaimed === true,
    thirdChannelTaskRewardClaimed: user.thirdChannelTaskRewardClaimed === true,
    adVideosWatched: Math.min(10, Math.max(0, Number(user.adVideosWatched) || 0)),
    adRewardClaimed: user.adRewardClaimed === true,
    referralRewardZombies: (Number(user.referralRewardCount) || 0) * 300,
    ttShopEnabled,
    isChatAdmin: user.isChatAdmin === true,
    adminBadge: user.adminBadge === 'girl' ? 'girl' : 'boy',
    isDesigner: user.isDesigner === true,
    isSupporter: user.isSupporter === true,
    isDeveloper: user.isDeveloper === true,
    badge4: user.badge4 === true,
    badge5: user.badge5 === true,
    chatMuted: user.chatMuted === true,
    isBanned: user.isBanned === true,
  };
}

function hasActiveLevelReward(user, level) {
  const skinByLevel = { 2: 'red', 3: 'white', 4: 'green', 5: 'luna' };
  const skin = skinByLevel[Number(level)];
  if (!skin) return true;
  if (!Array.isArray(user.ownedSkins) || !user.ownedSkins.includes(skin)) return false;
  publicState(user);
  return Number(user.skinRewards && user.skinRewards[skin] && user.skinRewards[skin].remainingDays) > 0;
}

// Supporter, Developer and Designer are all full admin-equivalent roles in
// chat (same chat-moderation and chat-override powers as isChatAdmin) - just
// separate flags/badges so staff can be given any of them without the
// "Chat-Admin" label.
function isAdminOrSupporter(user) {
  return !!(user && (user.isChatAdmin === true || user.isSupporter === true || user.isDeveloper === true || user.isDesigner === true));
}

function canModerateChat(user) {
  return user && (user.isChatAdmin === true || user.isSupporter === true || user.isDeveloper === true || user.isDesigner === true);
}

function latestWithdrawalAt(user) {
  const recorded = Number(user && user.lastWithdrawalAt) || 0;
  const fromHistory = Array.isArray(user && user.withdrawals)
    ? user.withdrawals.reduce((latest, withdrawal) => Math.max(latest, Number(withdrawal && withdrawal.ts) || 0), 0)
    : 0;
  return Math.max(recorded, fromHistory);
}
function withdrawalCooldownMs(user, now = Date.now()) {
  const lastWithdrawalAt = latestWithdrawalAt(user);
  return lastWithdrawalAt ? Math.max(0, lastWithdrawalAt + WITHDRAWAL_COOLDOWN_MS - now) : 0;
}

const RPS_CHOICES = new Set(['rock', 'paper', 'scissors']);
const RPS_MIN_STAKE = 0.001;
const RPS_GAME_TTL_MS = 30 * 60 * 1000;
const GAME_ROOM_STAKE = 0.001;
const GAME_ROOM_RESET_DELAY_MS = 15000;
const GAME_ROUND_TIMEOUT_MS = 60 * 1000;
const GAME_PLAYER_OFFLINE_MS = 35 * 1000;
const MAGIC_TOWER_STAKE = 0.1;
const MAGIC_TOWER_FLOORS = 12;
const MAGIC_TOWER_CHOICES = new Set(['higher', 'lower']);
const MAGIC_TOWER_TURN_TIMEOUT_MS = 10 * 1000;
const MAGIC_TOWER_LOBBY_TTL_MS = 30 * 60 * 1000;
const MAGIC_TOWER_RESULT_TTL_MS = 10 * 60 * 1000;
const ZOMBIE_TOWER_STAKE = 0.01;
const ZOMBIE_TOWER_TOP = 12;
const ZOMBIE_TOWER_ROUND_MS = 15000;
const ZOMBIE_TOWER_TTL_MS = 2 * 60 * 60 * 1000;
const ZOMBIE_TOWER_CHOICES = new Set(['hi', 'lo']);
function zombieTowerCard() {
  return { r: crypto.randomInt(2, 15), s: ['♠', '♥', '♦', '♣'][crypto.randomInt(4)] };
}
function zombieTowerPublic(game, uid) {
  const stake = Number(game.stake || ZOMBIE_TOWER_STAKE);
  const pot = Number((stake * 2).toFixed(9));
  const winnerPayout = Number((pot * 0.9).toFixed(9));
  const platformFee = Number((pot - winnerPayout).toFixed(9));
  const player = game.players.find((p) => String(p.id) === String(uid));
  const visiblePicks = {};
  Object.keys(game.picks || {}).forEach((id) => {
    visiblePicks[id] = { round: game.picks[id].round };
    if (String(id) === String(uid)) visiblePicks[id].choice = game.picks[id].choice;
  });
  return {
    id: game.id, status: game.status, createdAt: game.createdAt, stake, pot,
    winnerPayout, platformFee, round: game.round,
    card: game.card, deadline: game.deadline, floors: game.floors, picks: visiblePicks,
    hist: game.hist, last: game.last, sd: !!game.sd, winner: game.winner || null,
    result: game.result || null,
    forfeit: game.forfeit || null, ended: game.ended || null,
    players: game.players.map((p) => ({
      id: String(p.id),
      name: p.name,
      photoUrl: (users[String(p.id)] && users[String(p.id)].photoUrl) || p.photoUrl || '',
    })),
    me: player ? { id: String(player.id) } : null,
  };
}
function settleZombieTower(game, winnerId, draw = false) {
  if (game.status === 'done' || game.status === 'abandoned') return;
  if (!winnerId) {
    game.status = 'abandoned';
    game.ended = Date.now();
    game.result = { refunded: true, draw: !!draw };
    game.players.forEach((p) => {
      const user = users[String(p.id)];
      if (user) user.ton = Number((Number(user.ton || 0) + Number(game.stake || ZOMBIE_TOWER_STAKE)).toFixed(9));
    });
    return;
  }
  const winner = users[String(winnerId)];
  if (!winner) return;
  const stake = Number(game.stake || ZOMBIE_TOWER_STAKE);
  const pot = stake * 2;
  const winnerPayout = Number((pot * 0.9).toFixed(9));
  const platformFee = Number((pot - winnerPayout).toFixed(9));
  winner.ton = Number((Number(winner.ton || 0) + winnerPayout).toFixed(9));
  const operatorId = PLATFORM_USER_ID || ADMIN_CHAT_ID;
  if (operatorId) {
    const platform = getOrCreateUser(operatorId, 'Platform');
    platform.ton = Number((Number(platform.ton || 0) + platformFee).toFixed(9));
  }
  game.status = 'done';
  game.winner = String(winnerId);
  game.ended = Date.now();
  game.result = { winnerId: String(winnerId), payout: winnerPayout, platformFee, pot };
}
function resolveZombieTower(game) {
  if (!game || game.status !== 'playing') return;
  const ready = game.players.every((p) => game.picks[String(p.id)] && game.picks[String(p.id)].round === game.round);
  if (!ready && Date.now() <= game.deadline) return;
  const next = zombieTowerCard();
  const result = {};
  game.players.forEach((p) => {
    const id = String(p.id);
    const pick = game.picks[id] && game.picks[id].choice;
    const ok = !!pick && (next.r === game.card.r || (pick === 'hi' ? next.r > game.card.r : next.r < game.card.r));
    game.floors[id] = Math.max(0, Number(game.floors[id] || 0) + (ok ? 1 : -1));
    game.misses[id] = pick ? 0 : Number(game.misses[id] || 0) + 1;
    result[id] = { d: pick || null, ok, g: ok ? 1 : -1 };
  });
  game.last = { from: game.card, to: next, res: result, round: game.round };
  game.hist = (game.hist || []).concat([next]).slice(-24);
  game.card = next;
  game.picks = {};
  const failed = game.players.filter((p) => game.misses[String(p.id)] >= 3);
  const top = game.players.filter((p) => game.floors[String(p.id)] >= ZOMBIE_TOWER_TOP);
  if (failed.length === 2) settleZombieTower(game, null);
  else if (failed.length === 1) settleZombieTower(game, game.players.find((p) => String(p.id) !== String(failed[0].id)).id);
  else if (top.length && top.length === 1) settleZombieTower(game, top[0].id);
  else if (top.length === 2) settleZombieTower(game, null, true);
  else {
    game.round += 1;
    game.deadline = Date.now() + ZOMBIE_TOWER_ROUND_MS;
  }
}
function expireZombieTowerGames() {
  let changed = false;
  Object.values(zombieTowerGames).forEach((game) => {
    if (['done', 'abandoned'].includes(game.status)) return;
    if (Date.now() - Number(game.createdAt || Date.now()) > ZOMBIE_TOWER_TTL_MS) {
      settleZombieTower(game, null);
      changed = true;
    } else if (game.status === 'playing' && Date.now() > game.deadline + 1000) {
      resolveZombieTower(game);
      changed = true;
    }
  });
  if (changed) { persist(); persistZombieTowerGames(); }
}
setInterval(expireZombieTowerGames, 1000);
function magicTowerDeck() {
  const cards = [];
  const suits = [{ symbol: '♠', color: 'black' }, { symbol: '♥', color: 'red' }, { symbol: '♦', color: 'red' }, { symbol: '♣', color: 'black' }];
  for (let value = 2; value <= 14; value += 1) suits.forEach((suit) => cards.push({ value, suit: suit.symbol, color: suit.color }));
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}
function magicTowerGamePublic(game, uid) {
  const me = game.players.find((p) => String(p.id) === String(uid));
  return {
    id: game.id, status: game.status, stake: MAGIC_TOWER_STAKE, pot: 0.2,
    winnerPayout: 0.18, platformFee: 0.02, round: game.round,
    current: game.current, deckCount: game.deck.length,
    turnDeadlineAt: game.turnDeadlineAt || null,
    lastRound: game.lastRound || null,
    players: game.players.map((p) => ({ id: String(p.id), name: p.name, ready: p.ready, floor: p.floor, hasAction: !!game.actions[String(p.id)] })),
    me: me ? { id: String(me.id), ready: me.ready, floor: me.floor } : null,
    result: game.result || null,
  };
}
function settleMagicTowerGame(game, winnerId) {
  if (game.status === 'finished') return;
  const isTie = !winnerId;
  const payout = isTie ? MAGIC_TOWER_STAKE : 0.18;
  const fee = isTie ? 0 : 0.02;
  if (isTie) {
    game.players.forEach((player) => {
      const user = users[String(player.id)];
      if (user) user.ton = Number((Number(user.ton || 0) + MAGIC_TOWER_STAKE).toFixed(9));
    });
  } else {
    const winner = users[String(winnerId)];
    if (!winner) throw new Error('magic-tower-winner-missing');
    winner.ton = Number((Number(winner.ton || 0) + payout).toFixed(9));
    if (PLATFORM_USER_ID) {
      const platform = getOrCreateUser(PLATFORM_USER_ID, 'Platform');
      platform.ton = Number((Number(platform.ton || 0) + fee).toFixed(9));
    }
  }
  game.status = 'finished';
  game.finishedAt = Date.now();
  game.result = isTie
    ? { tie: true, payout, platformFee: fee, pot: 0.2 }
    : { winnerId: String(winnerId), winnerName: users[String(winnerId)].name, payout, platformFee: fee, pot: 0.2 };
}
function expireMagicTowerGames() {
  let changed = false;
  const now = Date.now();
  Object.values(magicTowerGames).forEach((game) => {
    if (game.status === 'finished' || game.status === 'cancelled' || now - Number(game.createdAt || now) < MAGIC_TOWER_LOBBY_TTL_MS) return;
    game.players.forEach((player) => {
      const user = users[String(player.id)];
      if (user) user.ton = Number((Number(user.ton || 0) + MAGIC_TOWER_STAKE).toFixed(9));
    });
    game.status = 'cancelled';
    game.result = { reason: 'lobby-timeout', refunded: true };
    changed = true;
  });
  if (changed) {
    persist();
    persistMagicTowerGames();
  }
}
function resolveMagicTowerRound(game) {
  if (game.status !== 'playing' || game.players.length !== 2 || Object.keys(game.actions).length !== 2) return;
  const next = game.deck.pop();
  const previous = game.current;
  game.current = next;
  game.players.forEach((player) => {
    const choice = game.actions[String(player.id)];
    if (next.value !== previous.value && choice === (next.value > previous.value ? 'higher' : 'lower')) player.floor = Math.min(MAGIC_TOWER_FLOORS, player.floor + 1);
  });
  game.lastRound = { previous, next, actions: { ...game.actions }, floors: game.players.map((p) => ({ id: String(p.id), floor: p.floor })) };
  game.actions = {};
  const reached = game.players.filter((p) => p.floor >= MAGIC_TOWER_FLOORS);
  if (reached.length) {
    const winner = reached.length === 1 ? reached[0] : null;
    settleMagicTowerGame(game, winner && winner.id);
  } else if (!game.deck.length) {
    const winner = game.players[0].floor === game.players[1].floor
      ? null
      : game.players[0].floor > game.players[1].floor ? game.players[0] : game.players[1];
    settleMagicTowerGame(game, winner && winner.id);
  } else {
    game.round += 1;
    game.turnDeadlineAt = Date.now() + MAGIC_TOWER_TURN_TIMEOUT_MS;
  }
}
function enforceMagicTowerTurnTimeout(game) {
  if (!game || game.status !== 'playing' || !game.turnDeadlineAt || Date.now() < game.turnDeadlineAt) return false;
  game.players.forEach((player) => {
    const id = String(player.id);
    if (!game.actions[id]) game.actions[id] = Math.random() < 0.5 ? 'higher' : 'lower';
  });
  resolveMagicTowerRound(game);
  return true;
}
function gameRoomId(stake) { return 'room-' + String(stake).replace('.', '-'); }
function createGameRoom(stake) {
  return { id: gameRoomId(stake), mode: 'room-knockout', stake, status: 'open', round: 0, roundStartedAt: 0, players: [], choices: {}, revealedChoices: {}, lastRoundChoices: {}, lastRoundWinners: [], result: null, resetAt: 0, createdAt: Date.now() };
}
function resetGameRoom(room) {
  room.players.forEach((player) => {
    const user = users[String(player.id)];
    if (user) user.ton += room.stake;
  });
  rpsGames[room.id] = createGameRoom(GAME_ROOM_STAKE);
}
function enforceGameRoomTimeout(room) {
  if (!room || room.mode !== 'room-knockout' || room.status !== 'playing' || !room.roundStartedAt) return false;
  const now = Date.now();
  const disconnected = room.players.some((player) => player.alive && now - Number(users[String(player.id)]?.lastSeenAt || 0) > GAME_PLAYER_OFFLINE_MS);
  if (disconnected) {
    resetGameRoom(room);
    return true;
  }
  if (now - room.roundStartedAt < GAME_ROUND_TIMEOUT_MS) return false;
  resetGameRoom(room);
  return true;
}
function removeOfflineRoomPlayers(room) {
  if (!room || !Array.isArray(room.players) || room.status === 'finished') return false;
  const now = Date.now();
  const kept = [];
  let changed = false;
  room.players.forEach((player) => {
    const user = users[String(player.id)];
    if (now - Number(user?.lastSeenAt || 0) > GAME_PLAYER_OFFLINE_MS) {
      if (user) user.ton += room.stake;
      changed = true;
    } else {
      kept.push(player);
    }
  });
  if (!changed) return false;
  room.players = kept;
  room.choices = {};
  room.status = 'open';
  room.round = 0;
  room.roundStartedAt = 0;
  return true;
}
function ensureGameRooms() {
  let changed = false;
  const id = gameRoomId(GAME_ROOM_STAKE);
  const room = rpsGames[id];
  if (room && removeOfflineRoomPlayers(room)) changed = true;
  if (!room || (room.status === 'finished' && Date.now() >= Number(room.resetAt || 0))) {
    rpsGames[id] = createGameRoom(GAME_ROOM_STAKE);
    changed = true;
  } else if (room.mode === 'room-knockout' && room.players.length < 4 && room.status === 'playing') {
    room.status = 'open';
    room.round = 0;
    room.choices = {};
    changed = true;
  } else if (room.mode === 'room-knockout' && room.players.length >= 4 && room.status === 'open') {
    room.status = 'playing';
    room.round = room.round || 1;
    room.roundStartedAt = Date.now();
    changed = true;
  }
  if (room && enforceGameRoomTimeout(room)) changed = true;
  if (changed) { persist(); persistRpsGames(); }
}
function gameRoomPublic(room, uid) {
  const playerCount = Array.isArray(room.players) ? room.players.length : 0;
  const liveStatus = room.status === 'finished' ? 'finished' : playerCount >= 4 ? 'playing' : 'open';
  const activePlayers = room.players.filter((player) => player.alive);
  const allActiveSelected = activePlayers.length > 0 && activePlayers.every((player) => room.choices[String(player.id)]);
  const lastRoundChoices = room.lastRoundChoices || {};
  const hasLastRoundReveal = Object.keys(lastRoundChoices).length > 0;
  const revealChoices = allActiveSelected || hasLastRoundReveal || room.status === 'finished';
  const choicesToReveal = room.status === 'finished' ? (room.revealedChoices || {}) : allActiveSelected ? room.choices : (hasLastRoundReveal ? lastRoundChoices : room.revealedChoices || {});
  return {
    id: room.id, stake: room.stake, status: liveStatus, round: room.round,
    playerCount, maxPlayers: 4,
    players: room.players.map((player) => ({ id: String(player.id), name: player.name, isMe: String(player.id) === String(uid), balance: Number(users[String(player.id)]?.ton || 0), alive: player.alive, selected: !!(room.choices[String(player.id)] || choicesToReveal[String(player.id)]), choice: revealChoices ? choicesToReveal[String(player.id)] || null : null, roundWinner: (room.lastRoundWinners || []).includes(String(player.id)) })),
    isPlayer: room.players.some((player) => String(player.id) === String(uid)),
    myChoice: room.choices[String(uid)] || null,
    pot: room.stake * 4,
    winnerPayout: Number((room.stake * 4 * 0.9).toFixed(9)),
    fee: Number((room.stake * 4 * 0.1).toFixed(9)),
    result: room.result,
    lastRoundWinners: room.lastRoundWinners || [],
  };
}
function finishGameRoom(room, winner) {
  const winnerPayout = Number((room.stake * 4 * 0.9).toFixed(9));
  const fee = Number((room.stake * 4 * 0.1).toFixed(9));
  if (users[String(winner.id)]) users[String(winner.id)].ton += winnerPayout;
  if (PLATFORM_USER_ID && users[PLATFORM_USER_ID]) users[PLATFORM_USER_ID].ton += fee;
  room.status = 'finished';
  room.lastRoundWinners = [String(winner.id)];
  room.result = { winnerId: String(winner.id), winnerName: winner.name, winnerPayout, fee };
  room.resetAt = Date.now() + GAME_ROOM_RESET_DELAY_MS;
  room.roundStartedAt = 0;
}

function resolveGameRoom(room) {
  const active = room.players.filter((player) => player.alive);
  if (active.length <= 1) {
    if (active.length === 1 && room.status !== 'finished') {
      finishGameRoom(room, active[0]);
    }
    return;
  }
  const choices = active.map((player) => room.choices[String(player.id)]).filter(Boolean);
  if (choices.length !== active.length) return;
  const unique = new Set(choices);
  if (unique.size === 1) { room.lastRoundChoices = { ...room.choices }; room.lastRoundWinners = []; room.choices = {}; room.round += 1; room.roundStartedAt = Date.now(); return; }
  if (active.length === 2) {
    room.revealedChoices = { ...room.choices };
    const winnerSide = rpsWinner(choices[0], choices[1]);
    if (winnerSide === 'tie') { room.lastRoundChoices = { ...room.choices }; room.lastRoundWinners = []; room.choices = {}; room.round += 1; room.roundStartedAt = Date.now(); return; }
    const winner = winnerSide === 'creator' ? active[0] : active[1];
    const loser = winner === active[0] ? active[1] : active[0];
    loser.alive = false; loser.eliminated = true;
    finishGameRoom(room, winner);
    room.choices = {};
    return;
  }
  let loserChoice = null;
  room.revealedChoices = { ...room.choices };
  room.lastRoundChoices = { ...room.choices };
  if (unique.size === 2) {
    const pair = Array.from(unique);
    const countA = active.filter((player) => room.choices[String(player.id)] === pair[0]).length;
    const countB = active.filter((player) => room.choices[String(player.id)] === pair[1]).length;
    const winnerChoice = winningChoice(pair[0], pair[1]);
    loserChoice = winnerChoice === pair[0] ? pair[1] : pair[0];
  } else {
    room.lastRoundWinners = [];
    room.choices = {};
    room.round += 1;
    room.roundStartedAt = Date.now();
    return;
  }
  if (loserChoice) {
    const losers = active.filter((player) => room.choices[String(player.id)] === loserChoice);
    losers.forEach((loser) => { loser.alive = false; loser.eliminated = true; });
    room.lastRoundWinners = active.filter((player) => player.alive).map((player) => String(player.id));
  }
  const remaining = room.players.filter((player) => player.alive);
  if (remaining.length === 1) {
    finishGameRoom(room, remaining[0]);
    room.choices = {};
    return;
  }
  room.choices = {};
  room.round += 1;
  room.roundStartedAt = Date.now();
  if (remaining.length === 2) { room.round += 1; }
}
ensureGameRooms();
function rpsPublicGame(game, uid) {
  const pot = game.stake * 2;
  const platformFee = game.status === 'finished' && game.result ? game.result.platformFee : pot * 0.1;
  const winnerPayout = game.status === 'finished' && game.result ? game.result.payout : pot * 0.9;
  return {
    id: game.id,
    stake: game.stake,
    creatorName: game.creatorName,
    opponentName: game.opponentName || null,
    status: game.status,
    isCreator: String(game.creatorId) === String(uid),
    isOpponent: String(game.opponentId || '') === String(uid),
    myChoice: String(game.creatorId) === String(uid) ? game.creatorChoice || null : String(game.opponentId || '') === String(uid) ? game.opponentChoice || null : null,
    result: game.status === 'finished' ? game.result : null,
    pot,
    platformFee,
    winnerPayout,
    expiresAt: game.expiresAt,
  };
}
function rpsWinner(first, second) {
  if (first === second) return 'tie';
  if (winningChoice(first, second) === first) return 'creator';
  return 'opponent';
}
function winningChoice(first, second) {
  if (first === second) return 'tie';
  const wins = { rock:'scissors', paper:'rock', scissors:'paper' };
  return wins[first] === second ? first : second;
}
function expireRpsGames() {
  let changed = false;
  Object.keys(rpsGames).forEach((id) => {
    const game = rpsGames[id];
    if (game.status !== 'open' || Date.now() < game.expiresAt) return;
    if (game.mode === 'four-player') {
      (game.players || []).forEach((player) => {
        const user = users[String(player.id)];
        if (user) user.ton += game.stake;
      });
    } else {
      const user = users[String(game.creatorId)];
      if (user) user.ton += game.stake;
    }
    game.status = 'cancelled';
    game.result = 'expired-refund';
    changed = true;
  });
  if (changed) { persist(); persistRpsGames(); }
}

function rpsTournamentPublic(game, uid) {
  const players = game.players || [];
  const pot = game.stake * 4;
  const me = players.find((player) => String(player.id) === String(uid));
  const match = (game.matches || []).find((item) => (String(item.a) === String(uid) || String(item.b) === String(uid)) && !item.winner);
  return {
    id: game.id, mode: 'four-player', status: game.status, round: game.round || 0,
    stake: game.stake, pot, winnerPayout: pot * 0.6, runnerUpPayout: pot * 0.2, platformFee: pot * 0.2,
    players: players.map((player) => ({ id: player.id, name: player.name, balance: Number(users[String(player.id)]?.ton || 0), alive: player.alive, eliminated: player.eliminated })),
    playerCount: players.length, maxPlayers: 4, isPlayer: !!me,
    myChoice: me ? me.choice || null : null,
    match: match ? { opponentName: players.find((player) => String(player.id) === String(String(match.a) === String(uid) ? match.b : match.a))?.name || 'Opponent' } : null,
    result: game.result || null,
  };
}
function makeTournamentMatches(playerIds) {
  return [{ a: playerIds[0], b: playerIds[1], aChoice: null, bChoice: null, winner: null }, { a: playerIds[2], b: playerIds[3], aChoice: null, bChoice: null, winner: null }];
}
function resolveTournamentMatch(game, match) {
  if (!match.aChoice || !match.bChoice) return false;
  const winner = rpsWinner(match.aChoice, match.bChoice);
  if (winner === 'tie') { match.aChoice = null; match.bChoice = null; return false; }
  match.winner = winner === 'creator' ? match.a : match.b;
  const loser = match.winner === match.a ? match.b : match.a;
  const winnerPlayer = game.players.find((player) => player.id === match.winner);
  const loserPlayer = game.players.find((player) => player.id === loser);
  if (winnerPlayer) winnerPlayer.choice = null;
  if (loserPlayer) { loserPlayer.alive = false; loserPlayer.eliminated = true; loserPlayer.choice = null; }
  return true;
}
function advanceTournament(game) {
  if (!game.matches.every((match) => match.winner)) return;
  const winners = game.matches.map((match) => match.winner);
  if (game.round === 1) { game.round = 2; game.matches = [{ a: winners[0], b: winners[1], aChoice: null, bChoice: null, winner: null }]; return; }
  const winnerId = winners[0];
  const runnerUpId = winnerId === game.matches[0].a ? game.matches[0].b : game.matches[0].a;
  const pot = game.stake * 4;
  const winnerPayout = Number((pot * 0.6).toFixed(9));
  const runnerUpPayout = Number((pot * 0.2).toFixed(9));
  const platformFee = Number((pot * 0.2).toFixed(9));
  users[String(winnerId)].ton += winnerPayout;
  users[String(runnerUpId)].ton += runnerUpPayout;
  if (PLATFORM_USER_ID && users[PLATFORM_USER_ID]) users[PLATFORM_USER_ID].ton += platformFee;
  game.status = 'finished';
  game.result = { winnerId, runnerUpId, winnerPayout, runnerUpPayout, platformFee, pot };
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

  const expectedHash = Buffer.from(computedHash, 'utf8');
  const receivedHash = Buffer.from(hash, 'utf8');
  if (expectedHash.length !== receivedHash.length || !crypto.timingSafeEqual(expectedHash, receivedHash)) {
    return { ok: false, error: 'invalid-hash' };
  }

  const authDate = parseInt(params.get('auth_date') || '0', 10) * 1000;
  if (!authDate || Date.now() - authDate > INIT_DATA_MAX_AGE_MS) {
    return { ok: false, error: 'stale-init-data' };
  }

  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch (e) { /* ignore */ }
  if (!user || !user.id) return { ok: false, error: 'missing-user' };

  const name = user.username || [user.first_name, user.last_name].filter(Boolean).join(' ') || ('Player ' + user.id);
  return { ok: true, id: user.id, name, photoUrl: typeof user.photo_url === 'string' ? user.photo_url : '' };
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
    req.user.lastSeenAt = Date.now();
    if (syncCampaignInvite(req.user)) persist();
    next();
  };
}
const requireUserFromBody = requireUser((req) => req.body && req.body.token);
const requireUserFromQuery = requireUser((req) => req.query && req.query.token);
function rejectBannedUser(req, res, next) {
  if (req.user && req.user.isBanned === true) {
    return res.status(403).json({ error: 'user-banned', state: publicState(req.user) });
  }
  next();
}

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

// ---------------------------------------------------------------
// (Zombie-Lotto wurde hier registriert, ist aber auf Wunsch wieder komplett
// entfernt - "لیگ برق‌آسا"/Blitz-Liga übernimmt die Event-Rolle jetzt allein.)

// ---------------------------------------------------------------
// لیگ برق‌آسا (Blitz-Liga): 3.5-minute virtual-football tipping event
// (over/under 2.5 goals), 10 matches per season, TON payouts. Files under
// blitz-liga/ per blitz-liga/AGENT_PROMPT.md: index.html's design/texts/
// timings/3D stadium are untouched; only its match() function was changed
// to fetch results from the endpoints below instead of computing them
// locally (point 5 of the prompt - the original id-seeded PRNG would let
// anyone precompute a match's outcome before kickoff). blitz-api.js and the
// backend itself are intentionally NOT 1:1 (the prompt explicitly asks for
// our own DB/login here) - see blitz-liga/blitz-core.js for the shared
// scoring/result logic.
// ---------------------------------------------------------------
const blitzCore = require('./blitz-liga/blitz-core.js');
const BLITZ_FILE = path.join(DATA_DIR, 'blitz-liga.json');
let blitzState = { seeds: {}, paidSeasons: [], payoutLog: [] };
try {
  if (fs.existsSync(BLITZ_FILE)) {
    const loaded = readJsonFile(BLITZ_FILE);
    if (loaded && typeof loaded === 'object') {
      blitzState.seeds = loaded.seeds && typeof loaded.seeds === 'object' ? loaded.seeds : {};
      blitzState.paidSeasons = Array.isArray(loaded.paidSeasons) ? loaded.paidSeasons : [];
      blitzState.payoutLog = Array.isArray(loaded.payoutLog) ? loaded.payoutLog : [];
    }
  }
} catch (error) {
  console.error('[blitz] state read failed: ' + error.message);
}
let blitzSaveTimer = null;
function persistBlitzState() {
  if (blitzSaveTimer) return;
  blitzSaveTimer = setTimeout(() => {
    blitzSaveTimer = null;
    try {
      const tmp = BLITZ_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(blitzState));
      fs.renameSync(tmp, BLITZ_FILE);
    } catch (error) {
      console.error('[blitz] state write failed: ' + error.message);
    }
  }, 500);
}
// In-memory memoization of the (expensive-ish) PRNG result build, keyed by
// match id - the secret seed itself only ever comes from blitzState.seeds.
const blitzResultCache = {};
// Lazily creates (and permanently persists) a true-random secret seed for a
// match - but ONLY from kickoff onward. Called before kickoff it returns
// null and generates nothing, so there is never a seed to leak even if this
// function were somehow invoked early.
function blitzSeedFor(id) {
  if (Date.now() < blitzCore.kickoffAt(id)) return null;
  let seed = blitzState.seeds[id];
  if (!Number.isFinite(seed)) {
    seed = crypto.randomInt(0, 2 ** 31);
    blitzState.seeds[id] = seed;
    // Bounded growth: a new match kicks off every ~3.5 minutes forever, so
    // keep only the last few seasons' worth of seeds around (enough for the
    // live table + season settlement; older ones are pruned).
    const ids = Object.keys(blitzState.seeds).map(Number).sort((a, b) => b - a);
    for (const old of ids.slice(blitzCore.SEASON * 3)) delete blitzState.seeds[old];
    persistBlitzState();
  }
  return seed;
}
function blitzResult(id) {
  if (blitzResultCache[id]) return blitzResultCache[id];
  const seed = blitzSeedFor(id);
  if (seed === null) return null;
  return blitzResultCache[id] = blitzCore.buildResult(id, seed);
}
function settleBlitzSeasons() {
  const now = Date.now(), c = blitzCore.clock(now), S = blitzCore.seasonOf(c.id);
  const lastMatchDone = c.id === blitzCore.firstOf(S) + blitzCore.SEASON - 1 && c.ph === 'post';
  const done = lastMatchDone ? S : S - 1;
  if (done < 0 || blitzState.paidSeasons.includes(done)) return;
  const docs = {};
  for (const user of Object.values(users)) {
    if (user.blitzTips && Object.keys(user.blitzTips).length) docs[String(user.id)] = { tips: user.blitzTips };
  }
  const rows = blitzCore.table(done, docs, now, blitzResult);
  let changed = false;
  for (const row of rows.slice(0, 10)) {
    const ton = blitzCore.PRIZES[row.rank - 1];
    const user = users[row.id];
    if (!user) continue;
    user.ton = Number((Number(user.ton || 0) + ton).toFixed(9));
    user.blitzWon = Math.round(((Number(user.blitzWon) || 0) + ton) * 10) / 10;
    if (!user.blitzPaid || typeof user.blitzPaid !== 'object') user.blitzPaid = {};
    user.blitzPaid[done] = ton;
    blitzState.payoutLog.push({ season: done, uid: row.id, rank: row.rank, points: row.pts, ton, status: 'paid', at: now });
    changed = true;
  }
  blitzState.payoutLog = blitzState.payoutLog.slice(-500);
  blitzState.paidSeasons.push(done);
  blitzState.paidSeasons = blitzState.paidSeasons.slice(-50);
  persistBlitzState();
  if (changed) persist();
  console.log('[blitz] season ' + done + ' settled: ' + rows.slice(0, 10).map((row) => row.rank + '. ' + row.id + ' ' + row.pts + 'P').join(', '));
}
function blitzAuth(req, res, next) {
  if (!BOT_TOKEN) return res.status(503).json({ error: 'server-missing-bot-token' });
  const result = verifyInitData(req.get('X-Telegram-Init-Data') || '');
  if (!result.ok) return res.status(401).json({ error: result.error || 'auth' });
  req.blitzUid = String(result.id);
  req.blitzUser = getOrCreateUser(result.id, result.name);
  next();
}
if (BOT_TOKEN) {
  app.get('/api/blitz/time', (req, res) => res.json({ now: Date.now() }));

  app.get('/api/blitz/me', blitzAuth, (req, res) => {
    const user = req.blitzUser;
    res.json({ uid: req.blitzUid, doc: { tips: user.blitzTips || {}, paid: user.blitzPaid || {}, won: Number(user.blitzWon) || 0 } });
  });

  // Rules enforced here (blitz-liga/AGENT_PROMPT.md point 3): only the
  // current match id's tip is ever touched, only during its tips phase, only
  // over/under, and the timestamp is always the server's own clock - never
  // whatever the client sends. A simple per-user rate limit guards the
  // endpoint against spam.
  const blitzLastWrite = new Map();
  app.put('/api/blitz/me', blitzAuth, rejectBannedUser, (req, res) => {
    const now = Date.now();
    const last = blitzLastWrite.get(req.blitzUid) || 0;
    if (now - last < 1000) return res.status(429).json({ error: 'rate-limited' });
    blitzLastWrite.set(req.blitzUid, now);
    const user = req.blitzUser;
    if (!user.blitzTips || typeof user.blitzTips !== 'object') user.blitzTips = {};
    const c = blitzCore.clock(now);
    const sent = (req.body && req.body.tips) || {};
    const t = sent[c.id];
    if (c.ph === 'tips') {
      if (t && (t.ou === 'over' || t.ou === 'under')) {
        const old = user.blitzTips[c.id];
        user.blitzTips[c.id] = { ou: t.ou, ts: old && old.ou === t.ou ? old.ts : now };
      } else if (!t) {
        delete user.blitzTips[c.id];
      }
    }
    const keys = Object.keys(user.blitzTips).map(Number).sort((a, b) => b - a);
    for (const old of keys.slice(30)) delete user.blitzTips[old];
    persist();
    res.json({ ok: true, doc: { tips: user.blitzTips, paid: user.blitzPaid || {}, won: Number(user.blitzWon) || 0 } });
  });

  app.get('/api/blitz/docs', blitzAuth, (req, res) => {
    const docs = {}, names = {};
    for (const user of Object.values(users)) {
      if (!user.blitzTips || !Object.keys(user.blitzTips).length) continue;
      const uid = String(user.id);
      docs[uid] = { tips: user.blitzTips, paid: user.blitzPaid || {}, won: Number(user.blitzWon) || 0 };
      names[uid] = user.name || '';
    }
    res.json({ docs, names });
  });

  // Public (team info isn't secret, see AGENT_PROMPT.md point 5 bullet 1) -
  // before kickoff this only ever returns {id,h,a}; the full result (with
  // gh/ga/ev/...) only appears from kickoff onward, once a secret seed for
  // it exists.
  app.get('/api/blitz/match/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return res.status(400).json({ error: 'invalid-id' });
    const teams = blitzCore.teamsOf(id);
    if (Date.now() < blitzCore.kickoffAt(id)) return res.json({ id, h: teams.h, a: teams.a });
    const result = blitzResult(id);
    res.json(result || { id, h: teams.h, a: teams.a });
  });

  app.get('/blitz-liga', (req, res) => {
    res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.sendFile(path.join(__dirname, 'blitz-liga', 'index.html'));
  });

  setInterval(settleBlitzSeasons, 30000);
} else {
  console.warn('[blitz] BOT_TOKEN missing - Blitz-Liga stays disabled.');
}

// The public entry point must always be the redesigned shell. The legacy game is
// still available below through /legacy-game.html for the embedded game iframe.
app.get(['/','/index.html'], (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0'
  });
  if (req.query.embedded === '1') {
    return res.sendFile(path.join(__dirname, 'index.html'));
  }
  const query = req.originalUrl.split('?')[1];
  const target = '/TaxiTonUpdate/indexup.html?v=taxiton-admin-badges-20261001' + (query ? '&' + query : '');
  res.redirect(302, target);
});
app.get(['/magic-tower-hilo.html', '/zombie.html'], (req, res) => {
  res.status(503).type('html').send(`<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zombie Tower pausiert</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090b12;color:#f5f7ff;font:16px system-ui,sans-serif;text-align:center}
main{max-width:420px;padding:32px}h1{color:#c9a24b;font-size:24px}p{color:#aeb6c8;line-height:1.6}
</style></head><body><main>
<h1>Zombie Tower ist vorübergehend pausiert</h1>
<p>Das Spiel ist wegen technischer Fehler deaktiviert. Bitte versuche es später erneut.</p>
</main></body></html>`);
});
app.get('/legacy-game.html', (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0'
  });
  if (req.query.embedded !== '1') {
    return res.redirect(302, '/TaxiTonUpdate/indexup.html?v=taxiton-admin-badges-20261001');
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/vendor/three-r128.min.js', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(__dirname, 'node_modules', 'three', 'build', 'three.min.js'));
});
app.get('/vendor/tonconnect-ui.min.js', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'node_modules', '@tonconnect', 'ui', 'dist', 'tonconnect-ui.min.js'));
});
app.use(express.static(__dirname, {
  index: false,
  setHeaders: (res, filePath) => {
    if (/\.html$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (/\.(js|css)$/i.test(filePath)) {
      const requestUrl = res.req && res.req.url || '';
      res.setHeader('Cache-Control', /[?&]v=/.test(requestUrl)
        ? 'public, max-age=86400'
        : 'no-cache, no-store, must-revalidate');
    } else if (/\.(png|jpe?g|webp|gif|svg)$/i.test(filePath)) {
      // Sprite/skin frames (e.g. the animated car skins' frame_XXX.png files)
      // never change in place - when one does change it gets a new `?v=`
      // suffix in app.js - so it's safe to skip the usual conditional-GET
      // round trip on every repeat "Play" press and just cache them for a
      // week. Without this, re-opening the game used to re-request every
      // single frame image (up to ~57 for some skins) on each load even
      // though none of them had actually changed.
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  },
}));
app.use('/monster-crash', express.static(path.join(__dirname, 'monster-crash', 'public'), {
  index: 'monster-crash.html',
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'),
}));

// Explicit no-store here (unlike the static file middleware above, a redirect response
// doesn't go through that setHeaders callback at all) so this can never get cached by an
// intermediate proxy or a Telegram client's own aggressive Mini App reopen cache - which
// would otherwise occasionally send a returning user straight back to whatever URL this
// redirect used to point to (the old design), instead of freshly resolving it every time.
app.get('/admin', (req, res) => {
  if (!ADMIN_SECRET) return res.status(503).send('Admin panel is disabled: ADMIN_SECRET is not configured.');
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TaxiTron Admin</title><style>
body{font-family:Segoe UI,Arial,sans-serif;background:#101018;color:#f5f2ff;max-width:1000px;margin:32px auto;padding:0 18px}h1{color:#ffd93d}button,input{padding:10px;border-radius:8px;border:1px solid #3b3850;background:#1c1c2a;color:#fff}button{cursor:pointer;background:#ffd93d;color:#261f00;font-weight:700}.danger{background:#ff5c6c;color:#260b10}.sound-off{background:#3b3850;color:#f5f2ff}.sound-on{background:#3ddc84;color:#062012}.toolbar{display:flex;gap:8px;margin:18px 0;flex-wrap:wrap}.player-search{flex:1;min-width:260px}.search-result-count{align-self:center;color:#aaa3b8;font-size:13px}.status{color:#aaa3b8;margin:12px 0}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:18px 0}.stat{padding:14px;border:1px solid #3b3850;border-radius:8px;background:#181824}.stat b{display:block;font-size:24px;color:#ffd93d}.row{display:grid;grid-template-columns:1.2fr 1fr 1fr 1fr 1fr 1fr 1.4fr 1fr;gap:12px;align-items:center;padding:14px 0;border-bottom:1px solid #302d40}.row.new-withdrawal{background:rgba(61,220,132,0.16);border-left:4px solid #3ddc84;animation:flash-row 1.4s ease-in-out 4}@keyframes flash-row{0%,100%{background:rgba(61,220,132,0.16)}50%{background:rgba(61,220,132,0.38)}}.purchase-row{grid-template-columns:1.5fr 1fr 1fr 1fr;background:#181824}.muted{color:#aaa3b8;font-size:12px}.reset-attempts{background:#3b3850;color:#f5f2ff;font-size:12px;padding:8px}@media(max-width:650px){.stats{grid-template-columns:1fr}.row{grid-template-columns:1fr 1fr}}
.level-controls{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}.level-controls button{font-size:11px;padding:5px 7px}.level-controls .owned{background:#3ddc84;color:#062012}.level-controls .missing{background:#3b3850;color:#f5f2ff}
.player-row>span:last-child{display:flex;flex-direction:column;gap:5px;min-width:150px}.player-row>span:last-child>button{width:100%;margin:0!important}.level-manager{border:1px solid #ffd93d;border-radius:8px;padding:6px;background:#211f16}.level-manager summary{cursor:pointer;color:#ffd93d;font-size:12px;font-weight:700}.level-manager .level-controls{margin-top:6px}
.chat-admin-row{display:grid;grid-template-columns:1.2fr .8fr 1fr 1fr 1fr;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid #302d40}.chat-admin-row.is-admin{background:rgba(128,0,240,0.1)}.chat-admin-row.is-supporter{background:rgba(142,68,230,0.12)}.chat-admin-row.is-designer{box-shadow:inset 4px 0 #ffd93d}.chat-admin-row.is-muted{background:rgba(255,92,108,0.1)}.tag{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;margin-left:6px}.tag.admin{background:#8000f0;color:#fff}.tag.designer{background:#ffd93d;color:#261f00}.tag.muted{background:#ff5c6c;color:#260b10}.small-btn{padding:6px 10px;font-size:12px}.admin-badge-select{padding:6px 8px;font-size:12px;background:#1c1c2a;color:#fff}.level-filter{padding:6px 10px;font-size:12px;background:#1c1c2a;color:#fff}.level-filter.active{background:#ffd93d;color:#261f00}.daily-status-table{width:100%;border-collapse:collapse;margin-top:10px}.daily-status-table td,.daily-status-table th{padding:8px 10px;border-bottom:1px solid #302d40;text-align:left;font-size:13px}.daily-status-table th{background:#181824;color:#ffd93d}
</style></head><body><h1>TaxiTron Admin</h1><div class="toolbar"><input id="secret" type="password" placeholder="Admin secret"><button id="load">Load players</button><button id="adjustTtTop" class="small-btn">TT geben / nehmen</button><button id="loadPurchases">Level-Käufe</button><button id="loadWithdrawals">Load withdrawals</button><button id="loadRejectedWithdrawals">Rejected withdrawals</button><button id="loadTtWithdrawals">TT-Auszahlungen (Chain)</button><button id="loadTournamentDebug">Turnier-Diagnose</button><button id="withdrawEnableToggle" class="small-btn">⏳ TT-Shop-Status laden...</button><button id="loadChatAdmin">Chat-Admin</button><button id="loadDailyStatus">Tagesstatus prüfen</button><button id="soundToggle" class="sound-off">🔔 Enable sound</button><button id="reset" class="danger">Reset all players</button></div><div id="status" class="status"></div><div id="stats" class="stats"></div><div id="list"></div>
<script>
const secret=()=>document.getElementById('secret').value;
const status=(text)=>document.getElementById('status').textContent=text;
const ORIGINAL_TITLE=document.title;
let soundEnabled=localStorage.getItem('taxitron_admin_sound')==='1';
let audioCtx=null;
let knownWithdrawalKeys=null;
let currentView='players';
let titleBlinkTimer=null;
let titleBlinkOn=false;
function updateSoundButton(){const btn=document.getElementById('soundToggle');if(soundEnabled){btn.textContent='🔔 Sound on';btn.className='sound-on'}else{btn.textContent='🔔 Enable sound';btn.className='sound-off'}}
function stopTitleBlink(){if(titleBlinkTimer){clearInterval(titleBlinkTimer);titleBlinkTimer=null}document.title=ORIGINAL_TITLE;titleBlinkOn=false}
function startTitleBlink(msg){stopTitleBlink();const label=msg||'🔔 Neue Auszahlung!';titleBlinkTimer=setInterval(()=>{titleBlinkOn=!titleBlinkOn;document.title=titleBlinkOn?label:ORIGINAL_TITLE},900)}
window.addEventListener('focus',stopTitleBlink);
function playAlertSound(){if(!soundEnabled)return;try{if(!audioCtx)audioCtx=new(window.AudioContext||window.webkitAudioContext)();if(audioCtx.state==='suspended')audioCtx.resume();const now=audioCtx.currentTime;[0,0.22,0.44].forEach((offset,i)=>{const osc=audioCtx.createOscillator();const gain=audioCtx.createGain();osc.type='sine';osc.frequency.setValueAtTime(i%2===0?880:1320,now+offset);gain.gain.setValueAtTime(0,now+offset);gain.gain.linearRampToValueAtTime(0.35,now+offset+0.02);gain.gain.linearRampToValueAtTime(0,now+offset+0.18);osc.connect(gain);gain.connect(audioCtx.destination);osc.start(now+offset);osc.stop(now+offset+0.2)})}catch(error){console.warn('alert sound failed',error)}}
function playPurchaseSound(){if(!soundEnabled)return;try{if(!audioCtx)audioCtx=new(window.AudioContext||window.webkitAudioContext)();if(audioCtx.state==='suspended')audioCtx.resume();const now=audioCtx.currentTime;const bufferSize=Math.floor(audioCtx.sampleRate*0.045);const buffer=audioCtx.createBuffer(1,bufferSize,audioCtx.sampleRate);const data=buffer.getChannelData(0);for(let i=0;i<bufferSize;i++){data[i]=(Math.random()*2-1)*(1-i/bufferSize)}const noise=audioCtx.createBufferSource();noise.buffer=buffer;const noiseFilter=audioCtx.createBiquadFilter();noiseFilter.type='highpass';noiseFilter.frequency.value=2500;const noiseGain=audioCtx.createGain();noiseGain.gain.setValueAtTime(0.3,now);noiseGain.gain.linearRampToValueAtTime(0,now+0.045);noise.connect(noiseFilter);noiseFilter.connect(noiseGain);noiseGain.connect(audioCtx.destination);noise.start(now);noise.stop(now+0.045);[[1568,now+0.05],[2093,now+0.17]].forEach(([freq,t])=>{const osc=audioCtx.createOscillator();osc.type='sine';osc.frequency.setValueAtTime(freq,t);const osc2=audioCtx.createOscillator();osc2.type='sine';osc2.frequency.setValueAtTime(freq*2.01,t);const gain=audioCtx.createGain();gain.gain.setValueAtTime(0,t);gain.gain.linearRampToValueAtTime(0.32,t+0.015);gain.gain.exponentialRampToValueAtTime(0.001,t+0.55);const gain2=audioCtx.createGain();gain2.gain.setValueAtTime(0,t);gain2.gain.linearRampToValueAtTime(0.09,t+0.015);gain2.gain.exponentialRampToValueAtTime(0.0008,t+0.4);osc.connect(gain);gain.connect(audioCtx.destination);osc2.connect(gain2);gain2.connect(audioCtx.destination);osc.start(t);osc.stop(t+0.55);osc2.start(t);osc2.stop(t+0.4)})}catch(error){console.warn('purchase sound failed',error)}}
document.getElementById('soundToggle').onclick=()=>{soundEnabled=!soundEnabled;localStorage.setItem('taxitron_admin_sound',soundEnabled?'1':'0');updateSoundButton();if(soundEnabled)playAlertSound()};
updateSoundButton();
let knownDepositKeys=null;
let knownPurchaseKeys=null;
async function pollMoneyEvents(){const s=secret();if(!s)return;try{const [dr,pr]=await Promise.all([fetch('/admin/deposits',{headers:{'x-admin-secret':s}}),fetch('/admin/purchases',{headers:{'x-admin-secret':s}})]);let newEvent=false;if(dr.ok){const dd=await dr.json();const keys=new Set((dd.deposits||[]).map(x=>x.uid+'_'+x.ts));if(knownDepositKeys===null){knownDepositKeys=keys}else{if((dd.deposits||[]).some(x=>!knownDepositKeys.has(x.uid+'_'+x.ts)))newEvent=true;knownDepositKeys=keys}}if(pr.ok){const pd=await pr.json();const keys=new Set((pd.purchases||[]).map(x=>x.uid+'_'+x.ts));if(knownPurchaseKeys===null){knownPurchaseKeys=keys}else{if((pd.purchases||[]).some(x=>!knownPurchaseKeys.has(x.uid+'_'+x.ts)))newEvent=true;knownPurchaseKeys=keys}}if(newEvent){playPurchaseSound();startTitleBlink('🛒 Neuer Kauf!')}}catch(error){console.warn('poll money events failed',error)}}
async function load(){currentView='players';const s=secret();if(!s){status('ADMIN_SECRET eingeben.');return}status('Spieler werden geladen...');const r=await fetch('/admin/players',{headers:{'x-admin-secret':s}});const d=await r.json();if(!r.ok){status(d.error||'Request failed');return}document.getElementById('stats').innerHTML='<div class="stat"><span>Registrierte Spieler</span><b>'+d.totalUsers+'</b></div><div class="stat"><span>Spieler mit Einzahlung</span><b>'+d.depositUsers+'</b></div><div class="stat"><span>TON gesamt</span><b>'+Number(d.totalTon).toFixed(6)+'</b></div><div class="stat"><span>Einladungen gesamt</span><b>'+d.totalReferrals+'</b></div><div class="stat"><span>Referral-Belohnungen</span><b>'+d.totalReferralRewards+' x 300</b></div><div class="stat"><span>Referral-Zombies</span><b>'+d.totalReferralRewardZombies+'</b></div><div class="stat"><span>TT vergeben (von '+Number(d.ttTotalSupply).toLocaleString('de-DE')+')</span><b>'+Number(d.ttGivenOut).toLocaleString('de-DE',{maximumFractionDigits:2})+'</b></div><div class="stat"><span>TT noch übrig</span><b>'+Number(d.ttRemaining).toLocaleString('de-DE',{maximumFractionDigits:2})+'</b></div>';const list=document.getElementById('list');list.innerHTML='<div class="toolbar"><input id="playerSearch" class="player-search" type="search" placeholder="Username oder Telegram-UID suchen..." autocomplete="off"><span id="playerSearchCount" class="search-result-count"></span><button class="level-filter active" data-level="">Alle Level</button><button class="level-filter" data-level="4">Level 4</button><button class="level-filter" data-level="3">Level 3</button><button class="level-filter" data-level="2">Level 2</button><button class="level-filter" data-level="1">Level 1</button></div><div class="row"><b>Spieler</b><b>TON-Guthaben</b><b>Coins</b><b>Level</b><b>Einzahlungen</b><b>Runs</b><b>Referral</b><b>Aktion</b></div>';d.players.slice().sort((a,b)=>b.level-a.level||b.ton-a.ton).forEach(p=>{const row=document.createElement('div');row.className='row player-row';row.dataset.search=(p.name+' '+p.uid).toLocaleLowerCase();row.dataset.uid=String(p.uid);row.dataset.levels=(p.ownedLevels||[p.level]).join(',');const joinedAt=p.createdAt?new Intl.DateTimeFormat('de-DE',{dateStyle:'medium',timeStyle:'medium',timeZone:'Europe/Berlin'}).format(new Date(p.createdAt)):'Nicht erfasst';row.innerHTML='<span>'+p.name+(p.isBanned?' <span class="tag muted">GESPERRT</span>':'')+'<br><span class="muted">UID '+p.uid+'</span><br><span class="muted">Beigetreten: '+joinedAt+'</span></span><span>'+Number(p.ton).toFixed(6)+' TON</span><span>'+p.coins+'</span><span>'+p.level+'</span><span>'+p.depositCount+'</span><span>'+p.runs+'</span><span>'+p.referralCount+' eingeladen<br>'+p.referralRewardCount+' Belohnungen · '+p.referralRewardZombies+' Zombies<br>'+p.referralLink+'</span><span></span>';const actionCell=row.lastElementChild;const banBtn=document.createElement('button');banBtn.textContent=p.isBanned?'✅ Entbannen':'⛔ Bannen';banBtn.className=p.isBanned?'reset-attempts':'danger small-btn';banBtn.onclick=async()=>{const action=p.isBanned?'entbannen':'bannen';if(!confirm(p.name+' wirklich '+action+'?'))return;banBtn.disabled=true;try{const rr=await fetch('/admin/users/'+encodeURIComponent(p.uid)+'/set-banned',{method:'POST',headers:{'x-admin-secret':s,'Content-Type':'application/json'},body:JSON.stringify({banned:!p.isBanned})});const dd=await rr.json();if(!rr.ok)throw new Error(dd.error||'Update failed');status(p.name+(dd.isBanned?' wurde gesperrt.':' wurde entsperrt.'));load()}catch(error){status(error.message);banBtn.disabled=false}};actionCell.appendChild(banBtn);const resetBtn=document.createElement('button');resetBtn.textContent='🔄 Reset attempts';resetBtn.className='reset-attempts';resetBtn.onclick=async()=>{if(!confirm('Versuche für '+p.name+' (UID '+p.uid+') auf 15/15 zurücksetzen?'))return;resetBtn.disabled=true;resetBtn.textContent='...';try{const rr=await fetch('/admin/users/'+encodeURIComponent(p.uid)+'/reset-attempts',{method:'POST',headers:{'x-admin-secret':s}});const dd=await rr.json();if(rr.ok){resetBtn.textContent='✓ Reset';status('Versuche für '+p.name+' zurückgesetzt.');setTimeout(()=>{resetBtn.textContent='🔄 Reset attempts';resetBtn.disabled=false},1500)}else{status(dd.error||'Reset failed');resetBtn.textContent='🔄 Reset attempts';resetBtn.disabled=false}}catch(error){status('Reset failed');resetBtn.textContent='🔄 Reset attempts';resetBtn.disabled=false}};actionCell.appendChild(resetBtn);const recordBtn=document.createElement('button');recordBtn.textContent='🏆 Turnier-Rekord ('+p.tournamentBest+')';recordBtn.className='reset-attempts';recordBtn.style.marginLeft='6px';recordBtn.onclick=async()=>{const val=prompt('Neuer Turnier-Rekord (Zombies) für '+p.name+':',p.tournamentBest);if(val===null)return;const best=parseInt(val,10);if(!Number.isFinite(best)||best<0){alert('Ungültiger Wert.');return}recordBtn.disabled=true;recordBtn.textContent='...';try{const rr=await fetch('/admin/users/'+encodeURIComponent(p.uid)+'/set-tournament-best',{method:'POST',headers:{'x-admin-secret':s,'Content-Type':'application/json'},body:JSON.stringify({best})});const dd=await rr.json();if(rr.ok){recordBtn.textContent='🏆 Turnier-Rekord ('+dd.tournamentBest+')';status('Turnier-Rekord für '+p.name+' auf '+dd.tournamentBest+' gesetzt.');recordBtn.disabled=false}else{status(dd.error||'Update failed');recordBtn.textContent='🏆 Turnier-Rekord ('+p.tournamentBest+')';recordBtn.disabled=false}}catch(error){status('Update failed');recordBtn.textContent='🏆 Turnier-Rekord ('+p.tournamentBest+')';recordBtn.disabled=false}};actionCell.appendChild(recordBtn);const adjustTonBtn=document.createElement('button');adjustTonBtn.textContent='💎 TON korrigieren';adjustTonBtn.className='reset-attempts';adjustTonBtn.style.marginLeft='6px';adjustTonBtn.onclick=async()=>{const val=prompt('TON-Änderung für '+p.name+' (z.B. -10.029940 zum Abziehen):');if(val===null)return;const delta=Number(val.replace(',','.'));if(!Number.isFinite(delta)||delta===0){alert('Ungültiger Wert.');return}if(!confirm((delta<0?'Wirklich ':'Wirklich ')+Math.abs(delta).toFixed(6)+' TON '+(delta<0?'von ':'zu ')+p.name+'s Guthaben '+(delta<0?'abziehen':'hinzufügen')+'?'))return;adjustTonBtn.disabled=true;adjustTonBtn.textContent='...';try{const rr=await fetch('/admin/users/'+encodeURIComponent(p.uid)+'/adjust-ton',{method:'POST',headers:{'x-admin-secret':s,'Content-Type':'application/json'},body:JSON.stringify({delta})});const dd=await rr.json();if(!rr.ok)throw new Error(dd.error||'Update failed');status(p.name+'s TON-Guthaben wurde auf '+Number(dd.ton).toFixed(6)+' TON korrigiert.');load()}catch(error){status(error.message);adjustTonBtn.disabled=false;adjustTonBtn.textContent='💎 TON korrigieren'}};actionCell.appendChild(adjustTonBtn);list.appendChild(row)});const search=document.getElementById('playerSearch');const count=document.getElementById('playerSearchCount');let selectedLevel='';const filterPlayers=()=>{const query=search.value.trim().toLocaleLowerCase();let visible=0;list.querySelectorAll('.player-row').forEach(row=>{const matchesSearch=!query||row.dataset.search.includes(query);const matchesLevel=!selectedLevel||row.dataset.levels.split(',').includes(selectedLevel);const match=matchesSearch&&matchesLevel;row.style.display=match?'':'none';if(match)visible++});count.textContent=visible+' von '+d.totalUsers+' Spielern'};search.addEventListener('input',filterPlayers);list.querySelectorAll('.level-filter').forEach(button=>button.addEventListener('click',()=>{selectedLevel=button.dataset.level||'';list.querySelectorAll('.level-filter').forEach(item=>item.classList.toggle('active',item===button));filterPlayers()}));filterPlayers();status(d.totalUsers+' Spieler geladen.')}
async function loadWithdrawals(opts){const silent=opts&&opts.silent;const s=secret();if(!s){if(!silent)status('ADMIN_SECRET eingeben.');return}if(!silent)status('Auszahlungen werden geladen...');let r,d;try{r=await fetch('/admin/withdrawals?status=pending',{headers:{'x-admin-secret':s}});d=await r.json()}catch(error){if(!silent)status('Request failed');return}if(!r.ok){if(!silent)status(d.error||'Request failed');return}
const currentKeys=new Set(d.withdrawals.map(w=>w.uid+'_'+w.ts));
let newlyArrived=[];
if(knownWithdrawalKeys===null){knownWithdrawalKeys=currentKeys}else{newlyArrived=d.withdrawals.filter(w=>!knownWithdrawalKeys.has(w.uid+'_'+w.ts));knownWithdrawalKeys=currentKeys}
if(!silent)currentView='withdrawals';
if(silent&&currentView!=='withdrawals'){if(newlyArrived.length){playAlertSound();startTitleBlink()}return}
const list=document.getElementById('list');
const existingWithdrawSearch=document.getElementById('withdrawSearch');
const previousWithdrawQuery=existingWithdrawSearch?existingWithdrawSearch.value:'';
const hadFocus=existingWithdrawSearch===document.activeElement;
const previousCursor=hadFocus?existingWithdrawSearch.selectionStart:null;
list.innerHTML='<div class="toolbar"><input id="withdrawSearch" class="player-search" type="search" placeholder="Username oder Telegram-UID suchen..." autocomplete="off"><span id="withdrawSearchCount" class="search-result-count"></span></div>'+(d.withdrawals.length?'':'<div>Keine offenen Auszahlungen.</div>');
d.withdrawals.forEach(w=>{const row=document.createElement('div');const isNew=newlyArrived.some(nw=>nw.uid===w.uid&&nw.ts===w.ts);row.className='row withdrawal-row'+(isNew?' new-withdrawal':'');row.dataset.search=(w.name+' '+w.uid).toLocaleLowerCase();const gross=Number(w.grossAmount!=null?w.grossAmount:w.amount);const fee=Number(w.fee!=null?w.fee:0);const net=Number(w.amount);row.innerHTML='<span>'+w.name+'<br><span class="muted">UID '+w.uid+'</span></span><span><b>AMOUNT TO SEND: '+net.toFixed(6)+' TON</b> <button class="copy-amount" type="button">Copy amount</button><br><span class="muted">Requested '+gross.toFixed(6)+' TON − 1% fee ('+fee.toFixed(6)+' TON)</span></span><span>'+w.address+' <button class="copy-address" type="button">Copy</button></span><span class="muted">'+new Date(w.ts).toLocaleString()+'</span><span><button class="complete-withdrawal">Erledigt</button><button class="danger reject-withdrawal">Reject</button></span>';const memo=document.createElement('div');memo.className='muted withdrawal-memo';memo.textContent='Memo: '+(w.memo||'?');row.querySelector('span:nth-child(3)').appendChild(memo);const copyAmountButton=row.querySelector('.copy-amount');copyAmountButton.onclick=async()=>{try{await navigator.clipboard.writeText(net.toFixed(6));copyAmountButton.textContent='Copied';setTimeout(()=>{copyAmountButton.textContent='Copy amount'},1200)}catch(error){status('Betrag konnte nicht kopiert werden.')}};const copyButton=row.querySelector('.copy-address');copyButton.onclick=async()=>{try{await navigator.clipboard.writeText(w.address);copyButton.textContent='Copied';setTimeout(()=>{copyButton.textContent='Copy'},1200)}catch(error){const input=document.createElement('textarea');input.value=w.address;document.body.appendChild(input);input.select();document.execCommand('copy');input.remove();copyButton.textContent='Copied';setTimeout(()=>{copyButton.textContent='Copy'},1200)}};row.querySelector('.complete-withdrawal').onclick=async()=>{const txId=prompt('Echte TON-Transaktions-ID eingeben:');if(!txId||!txId.trim()){status('Nicht abgeschlossen: echte TxID erforderlich.');return}const rr=await fetch('/admin/withdrawals/complete',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({uid:w.uid,ts:w.ts,txId:txId.trim(),currency:'TON'})});if(rr.ok)loadWithdrawals();else status((await rr.json()).error||'Request failed')};row.querySelector('.reject-withdrawal').onclick=async()=>{if(!confirm('Auszahlung wegen Betrug ablehnen? Der Betrag wird nicht zurückgezahlt.'))return;const rr=await fetch('/admin/withdrawals/reject',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({uid:w.uid,ts:w.ts})});if(rr.ok){status('Auszahlung abgelehnt: Auszahlung nicht möglich wegen Betrug.');loadWithdrawals()}else status((await rr.json()).error||'Request failed')};list.appendChild(row)});
const withdrawSearch=document.getElementById('withdrawSearch');
const withdrawSearchCount=document.getElementById('withdrawSearchCount');
withdrawSearch.value=previousWithdrawQuery;
const filterWithdrawals=()=>{const query=withdrawSearch.value.trim().toLocaleLowerCase();let visible=0;list.querySelectorAll('.withdrawal-row').forEach(row=>{const match=!query||row.dataset.search.includes(query);row.style.display=match?'':'none';if(match)visible++});withdrawSearchCount.textContent=visible+' von '+d.withdrawals.length};
withdrawSearch.addEventListener('input',filterWithdrawals);
filterWithdrawals();
if(hadFocus){withdrawSearch.focus();if(previousCursor!==null)withdrawSearch.setSelectionRange(previousCursor,previousCursor)}
if(!silent)status(d.withdrawals.length+' offene Auszahlung(en) geladen.');
if(newlyArrived.length){playAlertSound();startTitleBlink();if(!silent)status(newlyArrived.length+' neue Auszahlung(en) eingegangen!')}
}
async function loadCompletedWithdrawals(){
  currentView='completedWithdrawals';
  const s=secret();if(!s){status('ADMIN_SECRET eingeben.');return}
  status('Abgeschlossene Auszahlungen werden geladen...');
  let response,data;
  try{response=await fetch('/admin/withdrawals?status=completed',{headers:{'x-admin-secret':s},cache:'no-store'});data=await response.json();}
  catch(error){status('Request failed');return}
  if(!response.ok){status(data.error||'Request failed');return}
  const list=document.getElementById('list');
  list.innerHTML=data.withdrawals.length?'':'<div>Keine abgeschlossenen Auszahlungen.</div>';
  data.withdrawals.forEach(withdrawal=>{
    const row=document.createElement('div');
    row.style.cssText='display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;padding:14px 0;border-bottom:1px solid #302d40';
    const addCell=(label,value)=>{const cell=document.createElement('div'),title=document.createElement('b'),content=document.createElement('div');title.textContent=label;content.textContent=value;cell.append(title,content);row.appendChild(cell);};
    addCell('Spieler / UID',String(withdrawal.name||'Unbekannt')+' / '+String(withdrawal.uid||''));
    addCell('Auszahlung',Number(withdrawal.amount||0).toFixed(6)+' '+String(withdrawal.currency||'TON'));
    addCell('Adresse',String(withdrawal.address||''));
    addCell('Abgeschlossen',new Date(Number(withdrawal.completedAt)||Number(withdrawal.ts)||0).toLocaleString());
    const txCell=document.createElement('div'),txTitle=document.createElement('b'),txLink=document.createElement('a'),txId=String(withdrawal.txId||'');
    txTitle.textContent='Transaktions-ID';txLink.textContent=txId||'Keine TxID';
    if(txId){txLink.href='https://tonviewer.com/transaction/'+encodeURIComponent(txId);txLink.target='_blank';txLink.rel='noopener noreferrer';}
    txCell.append(txTitle,document.createElement('br'),txLink);row.appendChild(txCell);list.appendChild(row);
  });
  status(data.withdrawals.length+' abgeschlossene Auszahlung(en) geladen.');
}
async function loadTtWithdrawals(){
  currentView='ttWithdrawals';
  const s=secret();if(!s){status('ADMIN_SECRET eingeben.');return}
  status('TT-Auszahlungen werden geladen...');
  let treasuryData=null;
  try{const tr=await fetch('/admin/tt-treasury-status',{headers:{'x-admin-secret':s}});if(tr.ok)treasuryData=await tr.json();}catch(e){}
  let r,d;
  try{r=await fetch('/admin/tt-withdrawals',{headers:{'x-admin-secret':s}});d=await r.json();}catch(e){status('Request failed');return}
  if(!r.ok){status(d.error||'Request failed');return}
  const list=document.getElementById('list');
  list.innerHTML='';
  if(treasuryData){
    const banner=document.createElement('div');
    banner.style.cssText='padding:14px;border-radius:8px;margin-bottom:14px;border:1px solid '+(treasuryData.ready?'#3ddc84':'#ff5c6c')+';background:'+(treasuryData.ready?'rgba(61,220,132,0.1)':'rgba(255,92,108,0.12)');
    const warn=[];
    if(!treasuryData.enabled)warn.push('⚠️ TT_WITHDRAW_ENABLED ist AUS.');
    if(!treasuryData.ready)warn.push('🚨 Treasury NICHT bereit: '+(treasuryData.initError||'unbekannter Fehler'));
    if(treasuryData.ready&&treasuryData.tonBalance<treasuryData.minTonReserve)warn.push('🚨 Treasury-TON knapp: '+treasuryData.tonBalance.toFixed(4)+' TON (Reserve-Minimum '+treasuryData.minTonReserve+').');
    if(treasuryData.usedTodayTT>=treasuryData.dailyLimitTT)warn.push('⚠️ Tageslimit erreicht: '+treasuryData.usedTodayTT.toFixed(2)+' / '+treasuryData.dailyLimitTT+' TT.');
    banner.innerHTML='<b>Treasury-Status</b><br>'+
      'Bereit: '+(treasuryData.ready?'✅ Ja':'❌ Nein')+' | Enabled: '+(treasuryData.enabled?'✅':'❌')+' | Admin-only: '+(treasuryData.adminOnly?'Ja':'Nein')+'<br>'+
      'Treasury-Wallet: '+(treasuryData.address||'?')+'<br>'+
      'TON-Guthaben: '+treasuryData.tonBalance.toFixed(4)+' TON | TT-Guthaben: '+treasuryData.ttBalance.toFixed(2)+' TT<br>'+
      'Heute ausgezahlt: '+treasuryData.usedTodayTT.toFixed(2)+' / '+treasuryData.dailyLimitTT+' TT'+
      (warn.length?'<br><br>'+warn.map(w=>'<div>'+w+'</div>').join(''):'');
    list.appendChild(banner);
  }
  if(!d.withdrawals.length){list.insertAdjacentHTML('beforeend','<div>Keine TT-Auszahlungen vorhanden.</div>');status('0 TT-Auszahlungen geladen.');return}
  d.withdrawals.forEach(w=>{
    const row=document.createElement('div');
    row.style.cssText='display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;padding:14px 0;border-bottom:1px solid #302d40';
    const addCell=(label,value)=>{const cell=document.createElement('div'),title=document.createElement('b'),content=document.createElement('div');title.textContent=label;content.innerHTML=value;cell.append(title,content);row.appendChild(cell);};
    const statusColors={pending:'#aaa3b8',processing:'#ffd93d',completed:'#3ddc84',failed:'#ff5c6c','needs-review':'#ff9f43'};
    addCell('Spieler / UID',String(w.name||'Unbekannt')+' / '+String(w.uid||''));
    addCell('Betrag',Number(w.amount||0).toFixed(2)+' TT');
    addCell('Adresse',String(w.address||''));
    addCell('Status','<span style="color:'+(statusColors[w.status]||'#fff')+';font-weight:700">'+String(w.status||'?')+'</span>'+(w.failReason?'<br><span class="muted">'+w.failReason+'</span>':''));
    addCell('Zeit',new Date(w.ts).toLocaleString());
    if(w.status==='needs-review'){
      const actionCell=document.createElement('div');
      const completeBtn=document.createElement('button');completeBtn.textContent='Als erledigt markieren';
      const refundBtn=document.createElement('button');refundBtn.className='danger';refundBtn.textContent='Zurückbuchen';
      completeBtn.onclick=async()=>{const txId=prompt('TON-Transaktions-ID (optional, für die eigene Dokumentation):')||'';if(!confirm('Wirklich als ERLEDIGT markieren? Nur tun, wenn auf Tonviewer bestätigt, dass die TT wirklich angekommen sind!'))return;const rr=await fetch('/admin/tt-withdrawals/resolve',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({uid:w.uid,ts:w.ts,action:'complete',txId})});if(rr.ok)loadTtWithdrawals();else status((await rr.json()).error||'Request failed')};
      refundBtn.onclick=async()=>{if(!confirm('Wirklich ZURÜCKBUCHEN? Nur tun, wenn auf Tonviewer bestätigt, dass NICHTS verschickt wurde, sonst doppelte Auszahlung!'))return;const rr=await fetch('/admin/tt-withdrawals/resolve',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({uid:w.uid,ts:w.ts,action:'refund'})});if(rr.ok)loadTtWithdrawals();else status((await rr.json()).error||'Request failed')};
      actionCell.append(completeBtn,refundBtn);row.appendChild(actionCell);
    }
    list.appendChild(row);
  });
  status(d.withdrawals.length+' TT-Auszahlung(en) geladen.');
}
async function loadRejectedWithdrawals(){currentView='rejectedWithdrawals';const s=secret();if(!s){status('ADMIN_SECRET eingeben.');return}status('Abgelehnte Auszahlungen werden geladen...');const r=await fetch('/admin/withdrawals?status=rejected',{headers:{'x-admin-secret':s}});const d=await r.json();if(!r.ok){status(d.error||'Request failed');return}const list=document.getElementById('list');list.innerHTML=d.withdrawals.length?'':'Keine abgelehnten Auszahlungen.';d.withdrawals.forEach(w=>{const row=document.createElement('div');row.className='row';const gross=Number(w.grossAmount!=null?w.grossAmount:w.amount);row.innerHTML='<span>'+w.name+'<br><span class="muted">UID '+w.uid+'</span></span><span><b>'+gross.toFixed(6)+' TON</b><br><span class="muted">Wegen Betrug abgelehnt</span></span><span>'+w.address+'</span><span class="muted">'+new Date(w.ts).toLocaleString()+'</span><button class="sound-on">↩ Zurückholen</button>';const memo=document.createElement('div');memo.className='muted withdrawal-memo';memo.textContent='Memo: '+(w.memo||'?');row.children[2].appendChild(memo);row.querySelector('button').onclick=async()=>{if(!confirm('Diese Auszahlung wieder als offen markieren?'))return;const rr=await fetch('/admin/withdrawals/restore',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({uid:w.uid,ts:w.ts})});const dd=await rr.json();if(rr.ok){status('Auszahlung wurde zurückgeholt und ist wieder offen.');loadRejectedWithdrawals()}else status(dd.error||'Request failed')};list.appendChild(row)});status(d.withdrawals.length+' abgelehnte Auszahlung(en) geladen.')}
async function loadPurchases(){currentView='purchases';const s=secret();if(!s){status('ADMIN_SECRET eingeben.');return}status('Level-Käufe werden geladen...');const r=await fetch('/admin/purchases',{headers:{'x-admin-secret':s}});const d=await r.json();if(!r.ok){status(d.error||'Request failed');return}const list=document.getElementById('list');list.innerHTML='<div class="row purchase-row"><b>Nutzer</b><b>Level</b><b>Preis</b><b>Gekauft am</b></div>';if(!d.purchases.length){list.innerHTML+='<p>Keine Level-Käufe gespeichert.</p>'}d.purchases.forEach(p=>{const row=document.createElement('div');row.className='row purchase-row';const level=Number(p.level)||'?';const price=Number(p.price);const date=p.ts?new Intl.DateTimeFormat('de-DE',{dateStyle:'medium',timeStyle:'medium',timeZone:'Europe/Berlin'}).format(new Date(p.ts)):'Nicht erfasst';row.innerHTML='<span><b>'+String(p.name||'Unbekannt')+'</b><br><span class="muted">UID '+String(p.uid)+'</span></span><span>Level '+level+'<br><span class="muted">'+String(p.key||'')+'</span></span><span>'+(Number.isFinite(price)?price.toFixed(6):'?')+' TON</span><span>'+date+'</span>';list.appendChild(row)});status(d.purchases.length+' Level-Käufe geladen.')}
function addLevelControls(row){
if(row.dataset.levelControls==='1')return;
const uid=String(row.dataset.uid||'');
if(!uid)return;
const owned=new Set((row.dataset.levels||'1').split(',').map(Number));
const cell=row.lastElementChild;
cell.classList.add('player-actions');
const manager=document.createElement('details');
manager.className='level-manager';
const managerTitle=document.createElement('summary');
managerTitle.textContent='Level geben / wegnehmen';
manager.appendChild(managerTitle);
const controls=document.createElement('div');
controls.className='level-controls';
for(let level=1;level<=4;level++){
const button=document.createElement('button');
const has=owned.has(level);
button.className=has?'owned':'missing';
button.textContent=level===1?'L1 Basis':(has?'L'+level+' wegnehmen':'L'+level+' geben');
button.disabled=level===1;
button.title=has?'Level '+level+' ist vorhanden':'Level '+level+' fehlt';
button.onclick=async()=>{
if(!confirm((has?'Level '+level+' von ':'Level '+level+' an ')+uid+(has?' wegnehmen?':' geben?')))return;
button.disabled=true;
try{
const response=await fetch('/admin/users/'+encodeURIComponent(uid)+'/set-level',{method:'POST',headers:{'x-admin-secret':secret(),'Content-Type':'application/json'},body:JSON.stringify({level,owned:!has})});
const data=await response.json();
if(!response.ok)throw new Error(data.error||'Update failed');
status('Level '+level+' für UID '+uid+(has?' entfernt.':' vergeben.'));
load();
}catch(error){status(error.message);button.disabled=false}
};
controls.appendChild(button);
}
manager.appendChild(controls);
cell.prepend(manager);
row.dataset.levelControls='1';
}
const levelControlObserver=new MutationObserver((mutations)=>{
mutations.forEach(mutation=>mutation.addedNodes.forEach(node=>{
if(node.nodeType===1){
if(node.classList.contains('player-row'))addLevelControls(node);
node.querySelectorAll&&node.querySelectorAll('.player-row').forEach(addLevelControls);
}
}));
});
levelControlObserver.observe(document.getElementById('list'),{childList:true,subtree:true});
setInterval(()=>{
document.querySelectorAll('.player-row').forEach(addLevelControls);
},1000);
document.getElementById('load').onclick=load;
document.getElementById('loadPurchases').onclick=loadPurchases;
document.getElementById('loadWithdrawals').onclick=()=>loadWithdrawals();
const completedWithdrawalsButton=document.createElement('button');completedWithdrawalsButton.textContent='Completed withdrawals';document.getElementById('loadWithdrawals').insertAdjacentElement('afterend',completedWithdrawalsButton);completedWithdrawalsButton.onclick=loadCompletedWithdrawals;
document.getElementById('loadRejectedWithdrawals').onclick=loadRejectedWithdrawals;
async function loadTournamentDebug(){
  currentView='tournamentDebug';
  const s=secret();if(!s){status('ADMIN_SECRET eingeben.');return}
  status('Turnier-Diagnose wird geladen...');
  let r,d;
  try{r=await fetch('/admin/tournament-debug',{headers:{'x-admin-secret':s}});d=await r.json();}catch(e){status('Request failed');return}
  if(!r.ok){status(d.error||'Request failed');return}
  const list=document.getElementById('list');
  list.innerHTML='<div style="padding:14px;border-radius:8px;margin-bottom:14px;border:1px solid #3b3850;background:#181824"><b>Aktuelle Serverwoche:</b> '+d.currentWeek+'<br><b>Serverzeit (UTC):</b> '+d.now+'<br><br><button id="tournamentResetNowBtn" class="danger">🔄 Rangliste JETZT für alle zur\u00fccksetzen</button></div>';
  document.getElementById('tournamentResetNowBtn').onclick=async()=>{
    if(!confirm('Wirklich die Wochen-Rangliste JETZT f\u00fcr ALLE Spieler auf 0 zur\u00fccksetzen? TON/TT/Coins bleiben unber\u00fchrt, nur die Bestenliste.'))return;
    const rr=await fetch('/admin/tournament-debug/reset-now',{method:'POST',headers:{'x-admin-secret':s}});
    if(rr.ok){const dd=await rr.json();status('Rangliste zur\u00fcckgesetzt ('+dd.resetCount+' Spieler betroffen).');loadTournamentDebug()}
    else status((await rr.json()).error||'Request failed')
  };
  if(!d.entries.length){list.insertAdjacentHTML('beforeend','<div>Keine Turnier-Eintr\u00e4ge vorhanden.</div>');status('0 Eintr\u00e4ge geladen.');return}
  d.entries.forEach(e=>{
    const row=document.createElement('div');
    row.style.cssText='display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;padding:12px 0;border-bottom:1px solid #302d40';
    const stale = e.tournamentWeekKey !== d.currentWeek;
    row.innerHTML='<div><b>Spieler</b><div>'+e.name+' <span class="muted">('+e.uid+')</span></div></div>'+
      '<div><b>Gespeicherter Best</b><div>'+e.tournamentBest+'</div></div>'+
      '<div><b>Gespeicherte Woche</b><div style="color:'+(stale?'#ff5c6c':'#3ddc84')+'">'+(e.tournamentWeekKey||'(leer)')+(stale?' \u26a0 veraltet':' \u2713 aktuell')+'</div></div>'+
      '<div><b>Effektiv auf Rangliste</b><div>'+e.effectiveBest+'</div></div>';
    list.appendChild(row);
  });
  status(d.entries.length+' Eintr\u00e4ge geladen.');
}
document.getElementById('loadTtWithdrawals').onclick=loadTtWithdrawals;
document.getElementById('loadTournamentDebug').onclick=loadTournamentDebug;
function updateTtShopEnableToggle(enabled){const btn=document.getElementById('withdrawEnableToggle');btn.textContent=enabled?'💸 TT Shop ist AN — jetzt ausschalten':'🚫 TT Shop ist AUS — jetzt einschalten';btn.className='small-btn'+(enabled?'':' danger')}
document.getElementById('withdrawEnableToggle').onclick=async()=>{const s=secret();if(!s){status('ADMIN_SECRET eingeben.');return}const enabled=document.getElementById('withdrawEnableToggle').textContent.includes('AN');const rr=await fetch('/admin/tt-shop/set-enabled',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({enabled:!enabled})});if(rr.ok){const dd=await rr.json();updateTtShopEnableToggle(dd.ttShopEnabled);status(dd.ttShopEnabled?'TT Shop wurde aktiviert.':'TT Shop wurde deaktiviert.')}else status((await rr.json()).error||'Request failed')};
async function loadTtShopToggleStatus(){const s=secret();if(!s)return;try{const rr=await fetch('/admin/tt-shop/settings',{headers:{'x-admin-secret':s}});if(rr.ok){const dd=await rr.json();updateTtShopEnableToggle(dd.ttShopEnabled===true)}}catch(e){}}
setInterval(loadTtShopToggleStatus,15000);
document.getElementById('secret').addEventListener('change',loadTtShopToggleStatus);
loadTtShopToggleStatus();
async function loadChatAdmin(){currentView='chatAdmin';const s=secret();if(!s){status('ADMIN_SECRET eingeben.');return}
const list=document.getElementById('list');
list.innerHTML='<div class="toolbar"><button id="chatEnableToggle" class="small-btn">...</button><button id="cardEventEnableToggle" class="small-btn">...</button></div><div class="toolbar"><input id="chatUserSearch" type="text" placeholder="UID oder Name suchen..."><button id="chatUserSearchBtn">Suchen</button></div><div id="chatUserList"></div>';
function updateChatToggleBtn(enabled){const btn=document.getElementById('chatEnableToggle');btn.textContent=enabled?'💬 Chat ist AN — jetzt ausschalten':'🚫 Chat ist AUS — jetzt einschalten';btn.className='small-btn'+(enabled?'':' danger')}
function updateCardEventToggleBtn(enabled){const btn=document.getElementById('cardEventEnableToggle');btn.textContent=enabled?'🃏 Karten-Event ist AN — jetzt ausschalten':'🚫 Karten-Event ist AUS — jetzt einschalten';btn.className='small-btn'+(enabled?'':' danger')}
document.getElementById('chatEnableToggle').onclick=async()=>{const enabled=document.getElementById('chatEnableToggle').textContent.includes('AN');const rr=await fetch('/admin/chat/set-enabled',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({enabled:!enabled})});if(rr.ok){const dd=await rr.json();updateChatToggleBtn(dd.chatEnabled);status(dd.chatEnabled?'Chat wurde aktiviert.':'Chat wurde fuer normale Nutzer deaktiviert.')}else status((await rr.json()).error||'Request failed')};
document.getElementById('cardEventEnableToggle').onclick=async()=>{const enabled=document.getElementById('cardEventEnableToggle').textContent.includes('AN');const rr=await fetch('/admin/card-event/set-enabled',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({enabled:!enabled})});if(rr.ok){const dd=await rr.json();updateCardEventToggleBtn(dd.cardEventEnabled);status(dd.cardEventEnabled?'Karten-Event wurde aktiviert.':'Karten-Event wurde deaktiviert.')}else status((await rr.json()).error||'Request failed')};
async function runSearch(){const q=document.getElementById('chatUserSearch').value;status('Nutzer werden geladen...');const r=await fetch('/admin/chat-users?query='+encodeURIComponent(q),{headers:{'x-admin-secret':s}});const d=await r.json();if(!r.ok){status(d.error||'Request failed');return}
updateChatToggleBtn(d.chatEnabled);
updateCardEventToggleBtn(d.cardEventEnabled);
const box=document.getElementById('chatUserList');box.innerHTML=d.users.length?'':'Keine Nutzer gefunden.';
d.users.forEach(u=>{const row=document.createElement('div');row.className='chat-admin-row'+(u.isChatAdmin?' is-admin':'')+(u.isDesigner?' is-designer':'')+(u.isSupporter?' is-supporter':'')+(u.isDeveloper?' is-supporter':'')+(u.chatMuted?' is-muted':'');
const tags=(u.isChatAdmin?'<span class="tag admin">Chat-Admin</span>':'')+(u.isSupporter?'<span class="tag admin">Supporter</span>':'')+(u.isDeveloper?'<span class="tag admin">Developer (Amir)</span>':'')+(u.isDesigner?'<span class="tag designer">Designer</span>':'')+(u.badge4?'<span class="tag designer">Badge 4</span>':'')+(u.badge5?'<span class="tag designer">Badge 5</span>':'')+(u.chatMuted?'<span class="tag muted">Gemutet</span>':'');
row.innerHTML='<span>'+u.name+tags+'<br><span class="muted">UID '+u.uid+'</span></span><span></span><span></span><span></span><span></span>';
const adminBtn=document.createElement('button');adminBtn.className='small-btn';adminBtn.textContent=u.isChatAdmin?'Badge speichern':'Zum Chat-Admin machen';
const adminBadgeSelect=document.createElement('select');adminBadgeSelect.className='admin-badge-select';adminBadgeSelect.title='Admin-Badge auswählen';
adminBadgeSelect.innerHTML='<option value="boy">Admin Junge</option><option value="girl">Admin Mädchen</option>';
adminBadgeSelect.value=u.adminBadge==='girl'?'girl':'boy';adminBadgeSelect.disabled=!u.isChatAdmin;
adminBtn.onclick=async()=>{const rr=await fetch('/admin/chat/set-admin',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({uid:u.uid,isChatAdmin:true,adminBadge:adminBadgeSelect.value})});if(rr.ok)runSearch();else status((await rr.json()).error||'Request failed')};
const adminRemoveBtn=document.createElement('button');adminRemoveBtn.className='small-btn danger';adminRemoveBtn.textContent='Admin entfernen';adminRemoveBtn.style.display=u.isChatAdmin?'':'none';
adminRemoveBtn.onclick=async()=>{const rr=await fetch('/admin/chat/set-admin',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({uid:u.uid,isChatAdmin:false})});if(rr.ok)runSearch();else status((await rr.json()).error||'Request failed')};
const supporterBtn=document.createElement('button');supporterBtn.className='small-btn';supporterBtn.textContent=u.isSupporter?'Supporter entfernen':'Zum Supporter machen';
supporterBtn.title='Supporter hat dieselben Rechte wie Chat-Admin (löschen, muten, Chat-Override)';
supporterBtn.onclick=async()=>{const rr=await fetch('/admin/chat/set-supporter',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({uid:u.uid,isSupporter:!u.isSupporter})});if(rr.ok)runSearch();else status((await rr.json()).error||'Request failed')};
const developerBtn=document.createElement('button');developerBtn.className='small-btn';developerBtn.textContent=u.isDeveloper?'Developer-Badge entfernen':'Developer-Badge (Amir) geben';
developerBtn.title='Hat dieselben Rechte wie Chat-Admin (löschen, muten, Chat-Override)';
developerBtn.onclick=async()=>{const rr=await fetch('/admin/chat/set-developer',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({uid:u.uid,isDeveloper:!u.isDeveloper})});if(rr.ok)runSearch();else status((await rr.json()).error||'Request failed')};
const designerBtn=document.createElement('button');designerBtn.className='small-btn';designerBtn.textContent=u.isDesigner?'Designer entfernen':'Zum Designer machen';
designerBtn.onclick=async()=>{const rr=await fetch('/admin/chat/set-designer',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({uid:u.uid,isDesigner:!u.isDesigner})});if(rr.ok)runSearch();else status((await rr.json()).error||'Request failed')};
const badgeBtn=document.createElement('button');badgeBtn.className='small-btn';badgeBtn.textContent=u.badge4?'Badge 4 entfernen':'Badge 4 geben';
badgeBtn.onclick=async()=>{const rr=await fetch('/admin/chat/set-badge4',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({uid:u.uid,badge4:!u.badge4})});if(rr.ok)runSearch();else status((await rr.json()).error||'Request failed')};
const badge5Btn=document.createElement('button');badge5Btn.className='small-btn';badge5Btn.textContent=u.badge5?'Badge 5 entfernen':'Badge 5 geben';
badge5Btn.onclick=async()=>{const rr=await fetch('/admin/chat/set-badge5',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({uid:u.uid,badge5:!u.badge5})});if(rr.ok)runSearch();else status((await rr.json()).error||'Request failed')};
const muteBtn=document.createElement('button');muteBtn.className='small-btn'+(u.chatMuted?'':' danger');muteBtn.textContent=u.chatMuted?'Entmuten':'Muten';
muteBtn.onclick=async()=>{const rr=await fetch('/admin/chat/set-mute',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({uid:u.uid,muted:!u.chatMuted})});if(rr.ok)runSearch();else status((await rr.json()).error||'Request failed')};
row.children[2].appendChild(adminBadgeSelect);row.children[2].appendChild(adminBtn);row.children[2].appendChild(adminRemoveBtn);row.children[1].appendChild(supporterBtn);row.children[1].appendChild(developerBtn);row.children[3].appendChild(designerBtn);row.children[4].appendChild(badgeBtn);row.children[4].appendChild(badge5Btn);row.children[4].appendChild(muteBtn);box.appendChild(row)});
status(d.users.length+' Nutzer geladen.')}
document.getElementById('chatUserSearchBtn').onclick=runSearch;
document.getElementById('chatUserSearch').addEventListener('keydown',e=>{if(e.key==='Enter')runSearch()});
runSearch();
}
document.getElementById('loadChatAdmin').onclick=loadChatAdmin;
function renderDailyStatusTable(d){
  var rows=[
    ['UID',d.uid],
    ['Name',d.name],
    ['Heute (Server, Berlin)',d.serverTodayBerlin],
    ['Gespeichertes Datum beim Nutzer',d.userTonDate],
    ['Für heute zurückgesetzt?',d.isResetForToday?'OK Ja':'NEIN - zeigt noch alte Werte'],
    ['TON-Guthaben gesamt',Number(d.ton||0).toFixed(6)],
    ['Runs gesamt',d.runs],
    ['Level (höchstes besessenes)',d.level],
    ['Besessene Skins',Array.isArray(d.ownedSkins)?d.ownedSkins.join(', '):'-'],
    ['Letzter Run',d.lastRunAt||'-'],
    ['Zuletzt gesehen',d.lastSeenAt||'-']
  ];
  var zLevels=[2,3,4,5], zGoals={2:7500,3:7000,4:6000,5:5000}, skinByLevel={2:'red',3:'white',4:'green',5:'luna'};
  var zRows=zLevels.map(function(l){
    var z=Number((d.zombiesTodayByLevel||{})[l]||0), goal=zGoals[l];
    var t=Number((d.tonTodayByLevel||{})[l]||0);
    var reward=(d.skinRewards||{})[skinByLevel[l]];
    var remainingDays=reward?reward.remainingDays:'-';
    return '<tr><td>Level '+l+'</td><td>'+z+' / '+goal+'</td><td>'+t+' TON heute</td><td>Reward-Tage uebrig: '+remainingDays+'</td></tr>';
  }).join('');
  var lvl1=(d.attemptsByLevel||{})[1]||{};
  var lvl1Row='<tr><td>Level 1 (2h-Fenster)</td><td>'+(lvl1.windowZombies||0)+' / 4000</td><td>Bonus vergeben: '+(lvl1.windowRewardGiven?'OK Ja':'NEIN noch nicht')+'</td><td>Versuche uebrig: '+(lvl1.left!=null?lvl1.left:'-')+(lvl1.resetAt?(' (Reset: '+new Date(lvl1.resetAt).toLocaleString()+')'):'')+'</td></tr>';
  return '<table class="daily-status-table"><tbody>'+
    rows.map(function(pair){return '<tr><td><b>'+pair[0]+'</b></td><td colspan="3">'+(pair[1]==null?'-':pair[1])+'</td></tr>';}).join('')+
    '<tr><th>Level</th><th>Zombies heute / Ziel</th><th>TON/Bonus</th><th>Details</th></tr>'+
    lvl1Row+zRows+
    '</tbody></table>';
}
async function loadDailyStatus(){
  const s=secret();if(!s){status('ADMIN_SECRET eingeben.');return}
  const uid=prompt('Spieler-UID eingeben:');
  if(!uid||!uid.trim())return;
  status('Tagesstatus wird geladen...');
  try{
    const r=await fetch('/admin/users/'+encodeURIComponent(uid.trim())+'/daily-status',{headers:{'x-admin-secret':s}});
    const d=await r.json();
    if(!r.ok){status(d.error||'Request failed');return}
    document.getElementById('list').innerHTML=renderDailyStatusTable(d);
    status('Tagesstatus für '+d.name+' (UID '+d.uid+') geladen.');
  }catch(e){status('Request failed')}
}
document.getElementById('loadDailyStatus').onclick=loadDailyStatus;
document.getElementById('reset').onclick=async()=>{const s=secret();if(!s){status('Enter the admin secret.');return}if(!confirm("WARNING: This resets all players' coins, TON, level, skins, stats, and withdrawals. Deposits and one-time invite reward claims remain protected. Continue?"))return;status('Resetting all players...');const r=await fetch('/admin/reset-users',{method:'POST',headers:{'x-admin-secret':s}});const d=await r.json();status(r.ok?'Reset complete for '+d.count+' players.':(d.error||'Reset failed'));if(r.ok)load()};
setInterval(()=>{if(secret())loadWithdrawals({silent:true})},15000);
setInterval(()=>{if(secret())pollMoneyEvents()},15000);
</script>
<script>
(() => {
  const list = document.getElementById('list');
  const addTtButton = () => {
    const toolbar = list.querySelector('.toolbar');
    if (!toolbar || document.getElementById('adjustTtTop')) return;
    const button = document.createElement('button');
    button.id = 'adjustTtTop';
    button.className = 'small-btn';
    button.textContent = '🪙 TT geben / nehmen';
    button.onclick = async () => {
      const query = prompt('Spielername oder Telegram-UID eingeben:');
      if (!query || !query.trim()) return;
      const playerRow = [...document.querySelectorAll('.player-row')].find((row) => {
        return row.dataset.uid === query.trim() || (row.dataset.search || '').includes(query.trim().toLocaleLowerCase());
      });
      if (!playerRow) { alert('Spieler nicht gefunden. Bitte zuerst „Load players“ ausführen und nach Name/UID suchen.'); return; }
      const uid = String(playerRow.dataset.uid || '');
      const name = (playerRow.firstElementChild && playerRow.firstElementChild.textContent.split('\n')[0].trim()) || uid;
      const value = prompt('TT-Änderung für ' + name + ' (z. B. 25 zum Geben, -10 zum Abziehen):');
      if (value === null) return;
      const delta = Number(value.replace(',', '.'));
      if (!Number.isFinite(delta) || delta === 0) { alert('Ungültiger Wert.'); return; }
      const action = delta > 0 ? 'hinzufügen' : 'abziehen';
      if (!confirm(Math.abs(delta).toFixed(6) + ' TT bei ' + name + ' ' + action + '?')) return;
      button.disabled = true;
      try {
        const response = await fetch('/admin/users/' + encodeURIComponent(uid) + '/adjust-tt', {
          method: 'POST',
          headers: {'x-admin-secret': document.getElementById('secret').value, 'Content-Type': 'application/json'},
          body: JSON.stringify({delta})
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Update failed');
        status(name + 's TT-Guthaben wurde auf ' + Number(data.ttBalance).toFixed(6) + ' TT korrigiert.');
      } catch (error) {
        status(error.message);
      } finally {
        button.disabled = false;
      }
    };
    toolbar.prepend(button);
  };
  new MutationObserver(addTtButton).observe(list, {childList: true, subtree: true});
  addTtButton();
})();
</script>
<script>
(() => {
  const button = document.getElementById('adjustTtTop');
  if (!button) return;
  button.addEventListener('click', async () => {
    const query = prompt('Spielername oder Telegram-UID eingeben:');
    if (!query || !query.trim()) return;
    const uidQuery = query.trim();
    const needle = uidQuery.toLocaleLowerCase();
    const rows = [...document.querySelectorAll('.player-row')];
    const exactUid = rows.filter((row) => String(row.dataset.uid || '') === uidQuery);
    const matches = exactUid.length ? exactUid : rows.filter((row) => (row.dataset.search || '').includes(needle));
    if (matches.length !== 1) {
      alert(matches.length ? 'Mehrere Spieler gefunden. Bitte die genaue Telegram-UID eingeben.' : 'Spieler nicht gefunden. Bitte zuerst „Load players“ ausführen.');
      return;
    }
    const row = matches[0];
    const uid = String(row.dataset.uid || '');
    const name = (row.firstElementChild && row.firstElementChild.textContent.split(String.fromCharCode(10))[0].trim()) || uid;
    const value = prompt('TT-Änderung für ' + name + ' (z. B. 25 zum Geben, -10 zum Abziehen):');
    if (value === null) return;
    const delta = Number(value.replace(',', '.'));
    if (!Number.isFinite(delta) || delta === 0) { alert('Ungültiger Wert.'); return; }
    const action = delta > 0 ? 'hinzufügen' : 'abziehen';
    if (!confirm(Math.abs(delta).toFixed(6) + ' TT bei ' + name + ' ' + action + '?')) return;
    button.disabled = true;
    try {
      const response = await fetch('/admin/users/' + encodeURIComponent(uid) + '/adjust-tt', {
        method: 'POST',
        headers: {'x-admin-secret': document.getElementById('secret').value, 'Content-Type': 'application/json'},
        body: JSON.stringify({delta})
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Update failed');
      await load();
      status(name + 's TT-Guthaben wurde auf ' + Number(data.ttBalance).toFixed(6) + ' TT korrigiert.');
    } catch (error) {
      status(error.message);
    } finally {
      button.disabled = false;
    }
  });
})();
</script></body></html>`);
});

// Health check for monitoring and deployment checks.
app.get('/api/health', (req, res) => res.json({
  ok: true,
  service: 'taxitron-server',
  storage: STORAGE_PERSISTENT ? 'persistent' : 'NOT PERSISTENT - data is lost on every restart (no Railway volume)',
}));

// ---- Telegram bot /start webhook ----
app.post('/telegram/webhook', async (req, res) => {
  const update = req.body || {};
  const message = update.message;
  const text = typeof message?.text === 'string' ? message.text : '';
  const startMatch = text.match(/^\/start(?:@[^\s]+)?(?:\s+([^\s]+))?/i);
  if (!message || !startMatch) return res.sendStatus(200);

  const telegramUser = message.from;
  if (!telegramUser || telegramUser.id === undefined || telegramUser.id === null) return res.sendStatus(200);
  const userId = String(telegramUser.id);
  const existed = !!users[userId];
  const user = getOrCreateUser(userId, [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(' ') || telegramUser.username);
  if (!existed) {
    const startParameter = startMatch[1] || '';
    if (/^ref_\d+$/i.test(startParameter)) applyReferral(user, startParameter);
  }
  user.lastSeenAt = Date.now();
  persist();
  try {
    await setTelegramMenuButton(message.chat && message.chat.id ? message.chat.id : userId);
    await sendTelegramStartMessage(message.chat && message.chat.id ? message.chat.id : userId);
  } catch (error) {
    console.error('[telegram] /start welcome failed: ' + error.message);
  }
  res.sendStatus(200);
});

// ---- Auth ----
app.post('/api/auth', (req, res) => {
  const { initData, referralCode } = req.body || {};
  const result = verifyInitData(initData);
  if (!result.ok) return res.status(401).json({ error: result.error });

  const existed = !!users[String(result.id)];
  const user = getOrCreateUser(result.id, result.name);
  if (result.photoUrl) user.photoUrl = result.photoUrl;
  if (!existed) applyReferral(user, referralCode);
  user.lastSeenAt = Date.now();
  ensureDailyReset(user);
  ensureTournamentReset(user);
  const state = publicState(user);
  persist();

  const token = signToken({ uid: user.id, iat: Date.now() });
  res.json({ token, state });
});

// ---- Zombie Tower: server-authoritative two-player higher/lower game ----
app.get('/api/zombie-tower/lobby', requireUserFromQuery, (req, res) => {
  expireZombieTowerGames();
  const uid = String(req.uid);
  const rooms = Object.values(zombieTowerGames)
    .filter((game) => game.status === 'open')
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 50)
    .map((game) => zombieTowerPublic(game, uid));
  const mine = Object.values(zombieTowerGames)
    .filter((game) => game.players.some((p) => String(p.id) === uid) && !['done', 'abandoned'].includes(game.status))
    .map((game) => zombieTowerPublic(game, uid));
  const finished = Object.values(zombieTowerGames)
    .filter((game) => game.players.some((p) => String(p.id) === uid) && ['done', 'abandoned'].includes(game.status))
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 1)
    .map((game) => zombieTowerPublic(game, uid));
  res.json({ state: publicState(req.user), rooms, mine: mine.length ? mine : finished });
});
app.post('/api/zombie-tower/create', requireUserFromBody, rejectBannedUser, (req, res) => {
  expireZombieTowerGames();
  const user = req.user;
  const stake = Number(req.body && req.body.stake);
  const allowedStakes = new Set([0.01, 0.05, 0.1, 0.5, 1]);
  if (!allowedStakes.has(stake)) return res.status(400).json({ error: 'invalid-stake' });
  if (Number(user.ton || 0) < stake) return res.status(400).json({ error: 'insufficient-funds', state: publicState(user) });
  const existing = Object.values(zombieTowerGames).find((g) => !['done', 'abandoned'].includes(g.status) && g.players.some((p) => String(p.id) === String(user.id)));
  if (existing) return res.json({ state: publicState(user), game: zombieTowerPublic(existing, user.id) });
  const id = crypto.randomUUID();
  user.ton = Number((Number(user.ton || 0) - stake).toFixed(9));
  zombieTowerGames[id] = {
    id, status: 'open', createdAt: Date.now(), stake, players: [{ id: user.id, name: user.name }],
    floors: {}, misses: {}, picks: {}, hist: [], round: 0, card: null, deadline: 0,
  };
  persist(); persistZombieTowerGames();
  res.json({ state: publicState(user), game: zombieTowerPublic(zombieTowerGames[id], user.id) });
});
app.post('/api/zombie-tower/join', requireUserFromBody, rejectBannedUser, (req, res) => {
  expireZombieTowerGames();
  const game = zombieTowerGames[String(req.body && req.body.gameId)];
  const user = req.user;
  if (!game || game.status !== 'open' || game.players.length !== 1) return res.status(409).json({ error: 'room-not-open' });
  if (String(game.players[0].id) === String(user.id)) return res.status(400).json({ error: 'cannot-join-own-game' });
  const stake = Number(game.stake || ZOMBIE_TOWER_STAKE);
  if (Number(user.ton || 0) < stake) return res.status(400).json({ error: 'insufficient-funds', state: publicState(user) });
  user.ton = Number((Number(user.ton || 0) - stake).toFixed(9));
  game.players.push({ id: user.id, name: user.name });
  game.status = 'playing'; game.round = 1; game.card = zombieTowerCard();
  game.hist = [game.card]; game.deadline = Date.now() + ZOMBIE_TOWER_ROUND_MS;
  game.players.forEach((p) => { game.floors[String(p.id)] = 0; game.misses[String(p.id)] = 0; });
  persist(); persistZombieTowerGames();
  res.json({ state: publicState(user), game: zombieTowerPublic(game, user.id) });
});
app.get('/api/zombie-tower/state', requireUserFromQuery, (req, res) => {
  expireZombieTowerGames();
  const uid = String(req.uid);
  const game = Object.values(zombieTowerGames).filter((g) => g.players.some((p) => String(p.id) === uid))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  res.json({ state: publicState(req.user), game: game ? zombieTowerPublic(game, uid) : null });
});
app.post('/api/zombie-tower/play', requireUserFromBody, rejectBannedUser, (req, res) => {
  const game = zombieTowerGames[String(req.body && req.body.gameId)];
  const choice = String(req.body && req.body.choice || '');
  if (!game || game.status !== 'playing') return res.status(409).json({ error: 'game-not-playing' });
  if (!ZOMBIE_TOWER_CHOICES.has(choice)) return res.status(400).json({ error: 'invalid-choice' });
  const uid = String(req.uid);
  if (!game.players.some((p) => String(p.id) === uid)) return res.status(403).json({ error: 'not-a-player' });
  if (game.picks[uid] && game.picks[uid].round === game.round) return res.status(409).json({ error: 'choice-already-made' });
  game.picks[uid] = { choice, round: game.round };
  resolveZombieTower(game);
  persist(); persistZombieTowerGames();
  res.json({ state: publicState(req.user), game: zombieTowerPublic(game, uid) });
});
app.post('/api/zombie-tower/leave', requireUserFromBody, rejectBannedUser, (req, res) => {
  const game = zombieTowerGames[String(req.body && req.body.gameId)];
  if (!game || !game.players.some((p) => String(p.id) === String(req.uid))) return res.status(404).json({ error: 'game-not-found' });
  if (game.status === 'open') settleZombieTower(game, null);
  else if (game.status === 'playing') settleZombieTower(game, game.players.find((p) => String(p.id) !== String(req.uid)).id);
  persist(); persistZombieTowerGames();
  res.json({ state: publicState(req.user), game: zombieTowerPublic(game, req.uid) });
});

// ---- Magic Tower: two-player real-ledger higher/lower game --------------
app.post('/api/magic-tower/join', requireUserFromBody, rejectBannedUser, (req, res) => {
  const user = req.user;
  expireMagicTowerGames();
  const existing = Object.values(magicTowerGames).find((game) => game.status !== 'finished' && game.status !== 'cancelled' && game.players.some((p) => String(p.id) === String(user.id)));
  if (existing) return res.json({ state: publicState(user), game: magicTowerGamePublic(existing, user.id) });
  if (Number(user.ton || 0) < MAGIC_TOWER_STAKE) return res.status(400).json({ error: 'insufficient-funds', state: publicState(user) });
  let game = Object.values(magicTowerGames).find((item) => item.status === 'waiting' && item.players.length === 1);
  if (!game) {
    const id = 'magic-' + crypto.randomBytes(12).toString('hex');
    game = { id, status: 'waiting', round: 1, deck: magicTowerDeck(), current: null, actions: {}, lastRound: null, players: [], result: null, createdAt: Date.now() };
    magicTowerGames[id] = game;
  }
  user.ton = Number((Number(user.ton) - MAGIC_TOWER_STAKE).toFixed(9));
  game.players.push({ id: String(user.id), name: user.name, ready: false, floor: 0 });
  if (game.players.length === 2) {
    game.status = 'ready';
    game.current = game.deck.pop();
  }
  persist();
  persistMagicTowerGames();
  res.json({ state: publicState(user), game: magicTowerGamePublic(game, user.id) });
});

app.get('/api/magic-tower/games', (req, res) => {
  expireMagicTowerGames();
  const games = Object.values(magicTowerGames)
    .filter((game) => game.status !== 'finished' && game.status !== 'cancelled')
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
    .map((game) => magicTowerGamePublic(game, null));
  res.json({ games });
});

app.get('/api/magic-tower/state', requireUserFromQuery, (req, res) => {
  expireMagicTowerGames();
  const timedOut = Object.values(magicTowerGames).some(enforceMagicTowerTurnTimeout);
  if (timedOut) persistMagicTowerGames();
  const userGames = Object.values(magicTowerGames).filter((item) => {
    if (!item.players.some((p) => String(p.id) === String(req.uid))) return false;
    if (item.status === 'cancelled') return false;
    if (item.status === 'finished') return Date.now() - Number(item.finishedAt || 0) <= MAGIC_TOWER_RESULT_TTL_MS;
    return true;
  });
  const game = userGames.find((item) => item.status !== 'finished') || userGames.find((item) => {
    return item.status === 'finished';
  });
  if (!game) return res.json({ state: publicState(req.user), game: null });
  req.user.lastSeenAt = Date.now();
  res.json({ state: publicState(req.user), game: magicTowerGamePublic(game, req.uid) });
});

app.post('/api/magic-tower/ready', requireUserFromBody, rejectBannedUser, (req, res) => {
  expireMagicTowerGames();
  Object.values(magicTowerGames).forEach(enforceMagicTowerTurnTimeout);
  const game = Object.values(magicTowerGames).find((item) => item.status !== 'finished' && item.status !== 'cancelled' && item.players.some((p) => String(p.id) === String(req.uid)));
  if (!game) return res.status(404).json({ error: 'game-not-found' });
  const player = game.players.find((p) => String(p.id) === String(req.uid));
  if (!player) return res.status(403).json({ error: 'not-a-player' });
  player.ready = true;
  if (game.players.length === 2 && game.players.every((p) => p.ready) && game.status !== 'finished') {
    game.status = 'playing';
    game.turnDeadlineAt = Date.now() + MAGIC_TOWER_TURN_TIMEOUT_MS;
  }
  persistMagicTowerGames();
  res.json({ state: publicState(req.user), game: magicTowerGamePublic(game, req.uid) });
});

app.post('/api/magic-tower/play', requireUserFromBody, rejectBannedUser, (req, res) => {
  const choice = String(req.body && req.body.choice || '');
  if (!MAGIC_TOWER_CHOICES.has(choice)) return res.status(400).json({ error: 'invalid-choice' });
  const game = magicTowerGames[String(req.body && req.body.gameId)];
  if (!game || game.status !== 'playing') return res.status(404).json({ error: 'game-not-playing' });
  const timedOut = enforceMagicTowerTurnTimeout(game);
  if (timedOut) {
    persist();
    persistMagicTowerGames();
    return res.status(409).json({ error: 'turn-time-expired', game: magicTowerGamePublic(game, req.uid) });
  }
  if (!game.players.some((p) => String(p.id) === String(req.uid))) return res.status(403).json({ error: 'not-a-player' });
  if (game.actions[String(req.uid)]) return res.status(409).json({ error: 'action-already-submitted', game: magicTowerGamePublic(game, req.uid) });
  game.actions[String(req.uid)] = choice;
  resolveMagicTowerRound(game);
  persist();
  persistMagicTowerGames();
  res.json({ state: publicState(req.user), game: magicTowerGamePublic(game, req.uid) });
});

// ---- Online player count (any user seen in the last 90s, i.e. app still open) ----
const ONLINE_WINDOW_MS = 90000;

function randomPrizeTon(now) {
  return now >= RANDOM_PROMO_START_MS && now < RANDOM_PROMO_END_MS ? 0.2 : 0.001;
}

function randomGiftPrizeTon() {
  const roll = crypto.randomInt(100);
  if (roll < 70) return 0.1;
  if (roll < 90) return 0.2;
  if (roll < 97) return 0.3;
  if (roll < 99) return 0.4;
  return 0.5;
}

function normalizeChatGuess(text) {
  return text.replace(/[\u06F0-\u06F9\u0660-\u0669]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code - (code >= 0x06F0 ? 0x06F0 : 0x0660));
  });
}

function nextRandomBotIntervalMs() {
  if (Number.isFinite(RANDOM_BOT_INTERVAL_MS) && RANDOM_BOT_INTERVAL_MS > 0) {
    return RANDOM_BOT_INTERVAL_MS;
  }
  return crypto.randomInt(RANDOM_BOT_MIN_INTERVAL_MS, RANDOM_BOT_MAX_INTERVAL_MS + 1);
}

function scheduleRandomDraw() {
  setTimeout(() => {
    try {
      runRandomDraw();
    } catch (error) {
      console.error('[random-bot] draw failed: ' + error.message);
    } finally {
      scheduleRandomDraw();
    }
  }, nextRandomBotIntervalMs());
}

function runRandomGiftDrop(now) {
  chatMessages.forEach((message) => {
    if (message.randomGift && message.giftClaimed !== true && message.giftExpired !== true) {
      message.giftExpired = true;
    }
  });
  const message = {
    id: chatNextId++,
    uid: RANDOM_BOT_UID,
    name: RANDOM_BOT_NAME,
    room: 'fa',
    text: 'ZombieBot hat ein Zahlen-Geschenk abgelegt!',
    ts: now,
    isAdmin: false,
    isDesigner: false,
    chatMuted: false,
    replyTo: null,
    randomGift: true,
    giftNumber: crypto.randomInt(1, 51),
    giftPrizeTon: randomGiftPrizeTon(),
    giftClaimed: false,
    giftExpired: false,
  };
  chatMessages.push(message);
  if (chatMessages.length > CHAT_MAX_STORED) chatMessages = chatMessages.slice(-CHAT_MAX_STORED);
  persistChat();
  broadcastChatEvent('message');
}

function publicChatMessage(message, viewerUid) {
  const {
    giftNumber, giftPrizeTon: secretGiftPrizeTon, giftClaimed, giftExpired, giftWinnerUid,
    giftWinnerName, ...publicMessage
  } = message;
  const author = users[String(message.uid)];
  const equipped = author && author.chatItems && author.chatItems.eq && typeof author.chatItems.eq === 'object'
    ? author.chatItems.eq : {};
  publicMessage.chatItems = {
    bub: Object.hasOwn(TT_CHAT_ITEMS.bub, equipped.bub) ? equipped.bub : 'classic',
    frm: Object.hasOwn(TT_CHAT_ITEMS.frm, equipped.frm) ? equipped.frm : 'none',
    ban: Object.hasOwn(TT_CHAT_ITEMS.ban, equipped.ban) ? equipped.ban : 'classic',
  };
  publicMessage.photoUrl = author ? author.profileImage || author.photoUrl || '' : '';
  publicMessage.isAdmin = users[String(message.uid)]
    ? users[String(message.uid)].isChatAdmin === true : message.isAdmin === true;
  publicMessage.adminBadge = users[String(message.uid)]
    ? (users[String(message.uid)].adminBadge === 'girl' ? 'girl' : 'boy')
    : (message.adminBadge === 'girl' ? 'girl' : 'boy');
  publicMessage.isDesigner = users[String(message.uid)]
    ? users[String(message.uid)].isDesigner === true : message.isDesigner === true;
  publicMessage.isSupporter = users[String(message.uid)]
    ? users[String(message.uid)].isSupporter === true : message.isSupporter === true;
  publicMessage.isDeveloper = users[String(message.uid)]
    ? users[String(message.uid)].isDeveloper === true : message.isDeveloper === true;
  publicMessage.badge4 = users[String(message.uid)]
    ? users[String(message.uid)].badge4 === true : message.badge4 === true;
  publicMessage.badge5 = users[String(message.uid)]
    ? users[String(message.uid)].badge5 === true : message.badge5 === true;
  publicMessage.hasLevel4 = author ? Array.isArray(author.ownedSkins) && author.ownedSkins.includes('green') : false;
  publicMessage.hasLevel5 = author ? Array.isArray(author.ownedSkins) && author.ownedSkins.includes('luna') : false;
  publicMessage.chatMuted = users[String(message.uid)]
    ? users[String(message.uid)].chatMuted === true : message.chatMuted === true;
  publicMessage.reactions = publicChatReactions(message, viewerUid);
  publicMessage.isZombieBot = message.isZombieBot === true;
  if (message.likeEventBar) {
    publicMessage.likeEventRoundId = String(message.likeEventRoundId || message.id);
  }
  if (message.randomGift) {
    publicMessage.gift = {
      active: giftClaimed !== true && giftExpired !== true && Date.now() < RANDOM_GIFT_EVENT_END_MS,
      claimed: giftClaimed === true,
      expired: giftExpired === true,
      winnerName: giftWinnerName,
      prizeTon: giftClaimed === true ? secretGiftPrizeTon : undefined,
    };
  }
  return publicMessage;
}

app.get('/api/online-count', (req, res) => {
  const now = Date.now();
  const activeUsers = Object.values(users).filter((user) => now - Number(user.lastSeenAt || 0) < ONLINE_WINDOW_MS);
  const rooms = { en: 0, fa: 0, de: 0 };
  activeUsers.forEach((user) => {
    const room = user.lastChatRoom;
    if (Object.hasOwn(rooms, room) && now - Number(user.chatLastSeenAt || 0) < ONLINE_WINDOW_MS) rooms[room]++;
  });
  res.json({ online: activeUsers.length, rooms });
});

// Lightweight list of currently online users (name + TON balance) for the Home chat sidebar.
app.get('/api/online-users', (req, res) => {
  const now = Date.now();
  const raceActive = taxiRaceState && (taxiRaceState.status === 'grid' || taxiRaceState.status === 'running');
  const racingUids = raceActive ? new Set(taxiRaceState.drivers.map((d) => String(d.uid))) : null;
  const racePhase = raceActive ? taxiRaceState.status : null;
  const lastWinnerUid = taxiRaceState && taxiRaceState.status === 'finished' ? String(taxiRaceState.winnerUid) : null;
  const lastRaceRewardTT = (taxiRaceState && taxiRaceState.rewardTT) || TAXI_RACE_REWARD_TT;
  const lastRaceTipRewardTT = (taxiRaceState && taxiRaceState.tipRewardTT) || TAXI_RACE_TIP_TT;
  const correctPredictorNames = new Set((taxiRaceState && taxiRaceState.status === 'finished' && taxiRaceState.correctNames) || []);
  const pendingPredictionUids = raceActive ? new Set(Object.keys(taxiRaceState.predictions || {})) : null;
  const list = Object.values(users)
    .filter((user) => now - Number(user.lastSeenAt || 0) < ONLINE_WINDOW_MS)
    .sort((a, b) => {
      const adminDiff = (b.isChatAdmin === true || b.isSupporter === true || b.isDeveloper === true || b.isDesigner === true ? 1 : 0) - (a.isChatAdmin === true || a.isSupporter === true || a.isDeveloper === true || a.isDesigner === true ? 1 : 0);
      if (adminDiff !== 0) return adminDiff;
      const badgeDiff = (b.badge4 === true || b.badge5 === true ? 1 : 0) - (a.badge4 === true || a.badge5 === true ? 1 : 0);
      if (badgeDiff !== 0) return badgeDiff;
      return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
    })
    .slice(0, 100)
    .map((user) => ({
      uid: String(user.id),
      name: user.name || ('Player ' + user.id),
      photoUrl: user.profileImage || user.photoUrl || '',
      ton: Number(user.ton || 0),
      isChatAdmin: user.isChatAdmin === true,
      adminBadge: user.adminBadge === 'girl' ? 'girl' : 'boy',
      isDesigner: user.isDesigner === true,
      isSupporter: user.isSupporter === true,
      isDeveloper: user.isDeveloper === true,
      badge4: user.badge4 === true,
      badge5: user.badge5 === true,
      hasLevel4: Array.isArray(user.ownedSkins) && user.ownedSkins.includes('green'),
      hasLevel5: Array.isArray(user.ownedSkins) && user.ownedSkins.includes('luna'),
      chatMuted: user.chatMuted === true,
      isBanned: user.isBanned === true,
      racing: racingUids ? racingUids.has(String(user.id)) : false,
      racePhase: racingUids && racingUids.has(String(user.id)) ? racePhase : null,
      lastRaceWinner: lastWinnerUid === String(user.id),
      lastRaceRewardTT,
      racePredictedCorrect: correctPredictorNames.has(user.name),
      lastRaceTipRewardTT,
      racePredictionPending: pendingPredictionUids ? pendingPredictionUids.has(String(user.id)) : false,
    }));
  res.json({ users: list });
});

// Lets a client that just opened the app (or missed the SSE broadcast) catch up
// on the current taxi race countdown/running/finished state and join in at the
// right point.
app.get('/api/taxi-race/state', (req, res) => {
  const viewerPayload = verifyToken(req.query.token);
  const viewerUid = viewerPayload ? String(viewerPayload.uid) : null;
  res.json({ race: publicTaxiRace(viewerUid) });
});

// Lets an online, non-racing user freely predict who will win the currently
// drawn race, while predictions are still open ('grid' phase). One guess per
// user per race; a correct guess earns a flat TT tip once the race finishes.
app.post('/api/taxi-race/predict', requireUserFromBody, rejectBannedUser, (req, res) => {
  const race = taxiRaceState;
  if (!race || race.status !== 'grid') return res.status(409).json({ error: 'no-predictions-open' });
  const uid = String(req.uid);
  if (race.drivers.some((d) => String(d.uid) === uid)) return res.status(403).json({ error: 'racer-cannot-predict' });
  if (race.predictions && race.predictions[uid]) return res.status(409).json({ error: 'already-predicted' });
  const racerUid = String((req.body && req.body.racerUid) || '');
  if (!race.drivers.some((d) => String(d.uid) === racerUid)) return res.status(400).json({ error: 'invalid-racer' });
  race.predictions = race.predictions || {};
  race.predictions[uid] = racerUid;
  persistTaxiRaceState();
  broadcastChatEvent('taxi-race', { event: publicTaxiRace() });
  res.json({ ok: true, myPrediction: racerUid });
});

// Lets a client that just opened the app (or missed the SSE broadcast) catch up
// on the current monster-boss countdown/intro/fight/finished state.
app.get('/api/monster/state', (req, res) => {
  const viewerPayload = verifyToken(req.query.token);
  const viewerUid = viewerPayload ? String(viewerPayload.uid) : null;
  res.json({ monster: publicMonster(viewerUid) });
});

// Server-authoritative "tap to deal damage" - the client only sends the tap,
// every roll (damage amount, crit, block, shield-penalty) happens here so
// nobody can cheat their way onto the reward leaderboard.
app.post('/api/monster/hit', requireUserFromBody, rejectBannedUser, (req, res) => {
  const m = monsterState;
  if (!m || m.status !== 'fight') return res.status(409).json({ error: 'no-active-fight' });
  const uid = String(req.uid);
  const now = Date.now();
  const log = (m.tapLog[uid] = (m.tapLog[uid] || []).filter((t) => now - t < 1000));
  if (log.length >= MONSTER_TAP_RATE_LIMIT) return res.status(429).json({ error: 'rate-limited' });
  log.push(now);
  m.names[uid] = req.user.name || ('Player ' + uid);
  if (m.shield) {
    const penalty = Math.min(MONSTER_SHIELD_PENALTY, m.dmg[uid] || 0);
    m.dmg[uid] = (m.dmg[uid] || 0) - penalty;
    scheduleMonsterBroadcast();
    return res.json({ ok: true, penalized: true, penalty, hp: Math.round(m.hp), maxHp: m.maxHp });
  }
  const roll = Math.random();
  let type = '', dmg;
  if (roll < 0.06) { type = 'blk'; dmg = 0; }
  else {
    dmg = 3 + Math.floor(Math.random() * 6);
    if (roll > 0.93) { type = 'crit'; dmg *= 3; }
  }
  if (m.hp <= m.maxHp * 0.25) dmg = type === 'blk' ? 0 : Math.max(1, Math.round(dmg * 0.7)); // rage: boss takes less damage below 25% HP
  dmg = Math.min(dmg, m.hp);
  m.hp = Math.max(0, m.hp - dmg);
  m.dmg[uid] = (m.dmg[uid] || 0) + dmg;
  scheduleMonsterBroadcast();
  const won = m.hp <= 0;
  if (won) finishMonster(true);
  res.json({ ok: true, dmg, type, hp: Math.round(m.hp), maxHp: m.maxHp, won });
});



// ---- Global chat (shown on Home, under the online-player count) ----
// GET returns messages newer than ?after=<id> (or the last ~50 if omitted), for polling.
app.get('/api/chat/messages', (req, res) => {
  const after = Number(req.query.after) || 0;
  const before = Number(req.query.before) || 0;
  const requestedRoom = String(req.query.room || '').toLowerCase();
  const room = ['en', 'fa', 'de'].includes(requestedRoom) ? requestedRoom : '';
  const viewerPayload = verifyToken(req.query.token);
  const viewerUid = viewerPayload ? String(viewerPayload.uid) : null;
  const viewer = viewerUid ? users[viewerUid] : null;
  if (viewer) {
    viewer.lastSeenAt = Date.now();
    if (room) {
      viewer.lastChatRoom = room;
      viewer.chatLastSeenAt = Date.now();
    }
  }
  // Requests with no room keep the legacy global-chat behavior.
  const roomMessages = room
    ? chatMessages.filter((message) => (message.room || 'en') === room)
    : chatMessages;
  // "before" lets the client page further back in history (used for scroll-up
  // infinite loading and for jumping to an older reply that isn't loaded yet).
  const storedMessages = before > 0
    ? roomMessages.filter((message) => message.id < before).slice(-50)
    : after > 0
      ? roomMessages.filter((message) => message.id > after)
      : roomMessages.slice(-50);
  const messages = storedMessages.map((message) => publicChatMessage(message, viewerUid));
  res.json({ messages, enabled: chatEnabled, chatLockedToDeveloper, cardEvent: room === 'fa' ? publicCardEvent(viewerUid) : null, taxiRace: room === TAXI_RACE_ROOM ? publicTaxiRace(viewerUid) : null, monster: room === MONSTER_ROOM ? publicMonster(viewerUid) : null });
});

app.post('/api/chat/card-event/vote', requireUserFromBody, rejectBannedUser, (req, res) => {
  const event = cardEventState;
  const eventId = String(req.body && req.body.eventId || '');
  const card = Number(req.body && req.body.card);
  if (!event || event.status !== 'active' || Date.now() >= event.endsAt || eventId !== event.id) {
    return res.status(409).json({ error: 'card-event-closed', event: publicCardEvent(req.uid) });
  }
  if (![1, 2, 3].includes(card)) return res.status(400).json({ error: 'invalid-card' });
  if (event.votes[String(req.uid)]) return res.status(409).json({ error: 'already-voted', event: publicCardEvent(req.uid) });
  event.votes[String(req.uid)] = card;
  persistCardEventState();
  const publicEvent = publicCardEvent(req.uid);
  broadcastChatEvent('card-event', { event: publicCardEvent(null) });
  res.json({ ok: true, event: publicEvent });
});

app.get('/api/chat/like-event', (req, res) => {
  const payload = verifyToken(req.query.token);
  res.json({ event: publicChatLikeEvent(payload ? String(payload.uid) : null) });
});

app.post('/api/chat/like-event/like', requireUserFromBody, rejectBannedUser, (req, res) => {
  const now = Date.now();
  if (now < CHAT_LIKE_EVENT_START_MS || now >= CHAT_LIKE_EVENT_END_MS) {
    return res.status(409).json({
      error: 'like-event-not-active',
      event: publicChatLikeEvent(req.uid),
    });
  }
  const roundId = String(req.body.roundId || '');
  const round = chatLikeEventState.rounds.find((entry) => entry.roundId === roundId);
  const compatibleRound = !roundId
    ? [...chatLikeEventState.rounds].reverse().find((entry) => !entry.settled)
    : null;
  const targetRound = round || compatibleRound;
  if (!targetRound) {
    return res.status(409).json({
      error: 'like-event-not-dropped',
      event: publicChatLikeEvent(req.uid),
    });
  }
  if (targetRound.settled) {
    return res.status(409).json({
      error: 'like-event-complete',
      event: publicChatLikeEvent(req.uid),
    });
  }

  const uid = String(req.uid);
  const previousState = JSON.parse(JSON.stringify(chatLikeEventState));
  targetRound.likes = (Number(targetRound.likes) || targetRound.likers.length) + 1;
  targetRound.entryCounts[uid] = (Number(targetRound.entryCounts[uid]) || 0) + 1;
  if (!targetRound.likers.includes(uid)) targetRound.likers.push(uid);
  const eligibleUids = Object.keys(targetRound.entryCounts).filter((entryUid) => targetRound.entryCounts[entryUid] > 0);
  if (targetRound.likes >= targetRound.target && eligibleUids.length >= 3) {
    const remaining = Object.assign({}, targetRound.entryCounts);
    let remainingEntries = Object.values(remaining).reduce((sum, count) => sum + count, 0);
    targetRound.winners = [];
    for (let i = 0; i < 3; i += 1) {
      let roll = crypto.randomInt(remainingEntries);
      let winnerUid = null;
      for (const [entryUid, count] of Object.entries(remaining)) {
        if (roll < count) {
          winnerUid = entryUid;
          break;
        }
        roll -= count;
      }
      if (winnerUid === null) throw new Error('[chat-like-event] weighted winner selection failed');
      targetRound.winners.push({
        uid: winnerUid,
        name: users[winnerUid] && users[winnerUid].name || ('Player ' + winnerUid),
        photoUrl: users[winnerUid] && users[winnerUid].photoUrl || '',
        reward: 0.2,
      });
      remainingEntries -= remaining[winnerUid];
      delete remaining[winnerUid];
    }
    targetRound.settled = true;
    chatLikeEventState.nextDropAt = now + crypto.randomInt(15 * 60 * 1000, 45 * 60 * 1000 + 1);
  }
  if (!persistChatLikeEventState()) {
    chatLikeEventState = previousState;
    return res.status(500).json({ error: 'like-event-save-failed' });
  }
  applyChatLikeEventPayouts();
  ensureChatLikeEventWinnerMessage(targetRound);
  broadcastChatEvent('like-event', {
    event: publicChatLikeEvent(null),
    winnerBalances: targetRound.winners.map((winner) => ({
      uid: winner.uid,
      ton: Number(users[winner.uid] && users[winner.uid].ton || 0),
    })),
    roundId: targetRound.roundId,
  });
  if (targetRound.settled) scheduleChatLikeEventDrop();

  res.json({
    event: publicChatLikeEvent(uid),
    state: publicState(req.user),
    alreadyLiked: false,
  });
});

app.get('/api/chat/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('retry: 2000\nevent: connected\ndata: {}\n\n');
  chatEventClients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch (error) {
      clearInterval(heartbeat);
      chatEventClients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    chatEventClients.delete(res);
  });
});

app.post('/api/chat/send', requireUserFromBody, rejectBannedUser, (req, res) => {
  if (!chatEnabled && !isAdminOrSupporter(req.user)) return res.status(403).json({ error: 'chat-disabled' });
  if (chatLockedToDeveloper && req.user.isDeveloper !== true) return res.status(423).json({ error: 'chat-locked-developer' });
  const roomForRaceCheck = String((req.body && req.body.room) || 'en').toLowerCase();
  if (roomForRaceCheck === TAXI_RACE_ROOM && isTaxiRaceActive() && !isAdminOrSupporter(req.user)) return res.status(423).json({ error: 'taxi-race-active' });
  if (publicChatLikeEvent(req.uid).chatLocked) {
    return res.status(423).json({ error: 'like-event-chat-locked' });
  }
  if (req.user.chatMuted === true) return res.status(403).json({ error: 'muted' });
  const raw = String((req.body && req.body.text) || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .trim();
  const sticker = String(req.body && req.body.sticker || '').trim();
  const requestedRoom = String(req.body && req.body.room || 'en').toLowerCase();
  if (!['en', 'fa', 'de'].includes(requestedRoom)) return res.status(400).json({ error: 'invalid-chat-room' });
  if (requestedRoom === 'fa' && isCardEventActive()) return res.status(423).json({ error: 'card-event-active' });
  const stickerMatch = sticker.match(/^([a-z]+)-([1-6])$/);
  const stickerPack = stickerMatch && stickerMatch[1];
  if (sticker && (!stickerMatch || !Object.hasOwn(TT_CHAT_ITEMS.stk, stickerPack) || !Array.isArray(req.user.stickerPacks) || !req.user.stickerPacks.includes(stickerPack))) {
    return res.status(403).json({ error: 'sticker-not-owned' });
  }
  if (!raw && !sticker) return res.status(400).json({ error: 'empty-message' });
  const now = Date.now();
  const normalizedGuess = normalizeChatGuess(raw);
  const isGiftGuess = /^(?:[1-9]|[1-4][0-9]|50)$/.test(normalizedGuess) &&
    now >= RANDOM_GIFT_EVENT_START_MS && now < RANDOM_GIFT_EVENT_END_MS;
  const gift = isGiftGuess ? [...chatMessages].reverse().find((entry) => (
    entry.randomGift === true && entry.giftClaimed !== true && entry.giftExpired !== true
  )) : null;
  const lastGiftGuessAt = chatLastGiftGuessAt[req.uid] || 0;
  const guessCooldownRemainingMs = gift
    ? RANDOM_GIFT_GUESS_COOLDOWN_MS - (now - lastGiftGuessAt)
    : 0;
  if (guessCooldownRemainingMs > 0) {
    return res.status(429).json({ error: 'guess-cooldown', retryAfterMs: guessCooldownRemainingMs });
  }
  const lastAt = chatLastSentAt[req.uid] || 0;
  if (Date.now() - lastAt < CHAT_MIN_INTERVAL_MS) return res.status(429).json({ error: 'too-fast' });
  chatLastSentAt[req.uid] = now;
  if (raw.toLowerCase() === '/random') {
    return res.status(403).json({ error: 'random-bot-only' });
  }
  const text = raw.slice(0, CHAT_MAX_LEN);
  let wonGift = null;
  if (gift) chatLastGiftGuessAt[req.uid] = now;
  if (gift && Number(normalizedGuess) === gift.giftNumber) {
    gift.giftClaimed = true;
    gift.giftWinnerUid = String(req.uid);
    gift.giftWinnerName = req.user.name || ('Player ' + req.uid);
    req.user.ton = Number((Number(req.user.ton || 0) + Number(gift.giftPrizeTon)).toFixed(9));
    wonGift = {
      uid: RANDOM_BOT_UID,
      name: RANDOM_BOT_NAME,
      room: 'fa',
      text: gift.giftWinnerName + ': ' + gift.giftNumber + ' richtig – ' + gift.giftPrizeTon + ' TON',
      isAdmin: false,
      isDesigner: false,
      chatMuted: false,
      replyTo: null,
      randomWinner: true,
      randomGiftWinner: true,
      randomWinnerName: gift.giftWinnerName,
      randomPrizeTon: gift.giftPrizeTon,
      randomGiftNumber: gift.giftNumber,
      isZombieBot: RANDOM_BOT_IS_ZOMBIEBOT,
    };
  }
  const replyToId = Number(req.body && req.body.replyTo) || 0;
  let replyTo = null;
  if (replyToId > 0) {
    const original = chatMessages.find((m) => m.id === replyToId);
    if (original) replyTo = { id: original.id, name: original.name, text: original.text.slice(0, 120) };
  }
  const message = {
    id: chatNextId++,
    uid: req.uid,
    name: req.user.name || ('Player ' + req.uid),
    text: sticker ? '' : text,
    room: requestedRoom,
    ...(sticker ? { stk: sticker } : {}),
    ts: Date.now(),
    isAdmin: req.user.isChatAdmin === true,
    isDesigner: req.user.isDesigner === true,
    isSupporter: req.user.isSupporter === true,
    isDeveloper: req.user.isDeveloper === true,
    badge4: req.user.badge4 === true,
    badge5: req.user.badge5 === true,
    chatMuted: req.user.chatMuted === true,
    replyTo,
  };
  chatMessages.push(message);
  if (wonGift) {
    wonGift.id = chatNextId++;
    wonGift.ts = Date.now();
    chatMessages.push(wonGift);
  }
  if (chatMessages.length > CHAT_MAX_STORED) chatMessages = chatMessages.slice(-CHAT_MAX_STORED);
  persistChat();
  if (wonGift) persist();
  res.json({
    message: publicChatMessage(message, req.uid),
    state: wonGift ? publicState(req.user) : undefined,
    guessCooldownMs: gift ? RANDOM_GIFT_GUESS_COOLDOWN_MS : undefined,
  });
  broadcastChatEvent('message');
});

app.post('/api/chat/react', requireUserFromBody, (req, res) => {
  if (publicChatLikeEvent(req.uid).chatLocked) {
    return res.status(423).json({ error: 'like-event-chat-locked' });
  }
  const messageId = Number(req.body && req.body.messageId);
  const emoji = String(req.body && req.body.emoji || '');
  const on = req.body && req.body.on === true;
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return res.status(400).json({ error: 'invalid-message-id' });
  if (!CHAT_REACTION_EMOJIS.has(emoji)) return res.status(400).json({ error: 'invalid-reaction' });
  const message = chatMessages.find((entry) => entry.id === messageId);
  if (!message) return res.status(404).json({ error: 'message-not-found' });
  if (message.room === 'fa' && isCardEventActive()) return res.status(423).json({ error: 'card-event-active' });
  if (!message.reactions || typeof message.reactions !== 'object') message.reactions = {};
  Object.keys(message.reactions).forEach((key) => {
    if (!Array.isArray(message.reactions[key])) message.reactions[key] = [];
    message.reactions[key] = message.reactions[key].filter((uid) => String(uid) !== String(req.uid));
    if (!message.reactions[key].length) delete message.reactions[key];
  });
  if (on) (message.reactions[emoji] || (message.reactions[emoji] = [])).push(String(req.uid));
  persistChat();
  const reactions = publicChatReactions(message, req.uid);
  res.json({ messageId, reactions });
  broadcastChatEvent('reaction', { messageId, reactions: publicChatReactions(message, null) });
});

app.post('/api/chat/delete', requireUserFromBody, (req, res) => {
  if (!isAdminOrSupporter(req.user)) return res.status(403).json({ error: 'not-a-chat-admin' });
  const messageId = Number(req.body && req.body.messageId);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    return res.status(400).json({ error: 'invalid-message-id' });
  }
  const messageIndex = chatMessages.findIndex((message) => message.id === messageId);
  if (messageIndex === -1) return res.status(404).json({ error: 'message-not-found' });
  chatMessages.splice(messageIndex, 1);
  persistChat();
  res.json({ ok: true, messageId });
  broadcastChatEvent('message-deleted', { messageId });
});

// A player can edit the text of their own message (stickers/gifts/etc. can't be edited).
app.post('/api/chat/edit', requireUserFromBody, (req, res) => {
  const messageId = Number(req.body && req.body.messageId);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    return res.status(400).json({ error: 'invalid-message-id' });
  }
  const message = chatMessages.find((item) => item.id === messageId);
  if (!message) return res.status(404).json({ error: 'message-not-found' });
  if (String(message.uid) !== String(req.uid)) return res.status(403).json({ error: 'not-your-message' });
  if (message.stk) return res.status(400).json({ error: 'cannot-edit-sticker' });
  const text = String((req.body && req.body.text) || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .trim()
    .slice(0, CHAT_MAX_LEN);
  if (!text) return res.status(400).json({ error: 'empty-message' });
  message.text = text;
  message.editedAt = Date.now();
  persistChat();
  res.json({ ok: true, messageId, text, editedAt: message.editedAt });
  broadcastChatEvent('message-edited', { messageId, text, editedAt: message.editedAt });
});

// A chat admin (or supporter) can flip the global on/off switch directly from the app (in addition to the /admin panel).
app.post('/api/chat/set-enabled', requireUserFromBody, (req, res) => {
  if (!isAdminOrSupporter(req.user)) return res.status(403).json({ error: 'not-a-chat-admin' });
  chatEnabled = req.body.enabled === true;
  persistChatSettings();
  res.json({ ok: true, chatEnabled });
  broadcastChatEvent('settings', { chatEnabled });
});

// Only the "Amir" (isDeveloper) badge can lock the chat down to themselves -
// while locked, every other role (including chat-admins/supporters/designers)
// is blocked from sending, see the chatLockedToDeveloper check in
// /api/chat/send above.
app.post('/api/chat/set-developer-lock', requireUserFromBody, (req, res) => {
  if (req.user.isDeveloper !== true) return res.status(403).json({ error: 'not-developer' });
  chatLockedToDeveloper = req.body.locked === true;
  persistChatSettings();
  res.json({ ok: true, chatLockedToDeveloper });
  broadcastChatEvent('settings', { chatLockedToDeveloper });
});

// Chat admins and designers can mute/unmute chat users. Banning (losing all
// bot access, not just chat) is a much bigger hammer, so it's restricted to
// the "Amir"/developer badge only - not chat-admins/supporters/designers,
// unlike the broader mute permission below.
app.post('/api/chat/moderate', requireUserFromBody, (req, res) => {
  const targetUid = String((req.body && req.body.targetUid) || '');
  if (targetUid === String(req.uid)) return res.status(400).json({ error: 'self-moderation-not-allowed' });
  const target = users[targetUid];
  if (!target) return res.status(404).json({ error: 'user-not-found' });
  const wantsBanChange = typeof (req.body && req.body.banned) === 'boolean';
  const wantsMuteChange = typeof (req.body && req.body.muted) === 'boolean';
  if (wantsBanChange) {
    if (req.user.isDeveloper !== true) return res.status(403).json({ error: 'not-developer' });
    target.isBanned = req.body.banned === true;
  }
  if (wantsMuteChange) {
    if (!canModerateChat(req.user)) return res.status(403).json({ error: 'not-a-chat-moderator' });
    target.chatMuted = req.body.muted === true;
  }
  if (!wantsBanChange && !wantsMuteChange) return res.status(400).json({ error: 'nothing-to-moderate' });
  persist();
  const result = { uid: targetUid, chatMuted: target.chatMuted === true, isBanned: target.isBanned === true };
  res.json({ ok: true, ...result });
  broadcastChatEvent('moderation', result);
});

// ---- Deposit info ----
app.get('/api/deposit-info', requireUserFromQuery, (req, res) => {
  res.json({
    memo: 'TT' + req.uid,
    address: DEPOSIT_ADDRESS || undefined,
  });
});

// Lets the client know whether it should even show the on-chain TT
// withdrawal UI for this specific user, without exposing treasury
// internals (balances, allowlist, etc. stay admin-only).
app.get('/api/tt/withdraw-info', requireUserFromQuery, (req, res) => {
  const available = TT_WITHDRAW_ENABLED && treasury.isReady() &&
    (!TT_WITHDRAW_ADMIN_ONLY || TT_WITHDRAW_ALLOWLIST.has(String(req.uid)));
  res.json({
    available,
    minWithdraw: TT_MIN_WITHDRAW,
    cooldownMs: TT_WITHDRAW_COOLDOWN_MS,
  });
});

function limitedSkinSoldCount(key) {
  return Object.values(users).filter((user) => Array.isArray(user.ownedSkins) && user.ownedSkins.includes(key)).length;
}

app.get('/api/limited/:key', (req, res) => {
  const offer = LIMITED_SKIN_OFFERS[String(req.params.key || '')];
  if (!offer) return res.status(404).json({ error: 'limited-offer-not-found' });
  res.set('Cache-Control', 'no-store');
  res.json({ sold: limitedSkinSoldCount(req.params.key), max: offer.max });
});

app.post('/api/buy-skin', requireUserFromBody, (req, res) => {
  const key = String(req.body && req.body.key || '');
  const prices = { red: 1, white: 3, green: 10, luna: LIMITED_SKIN_OFFERS.luna.price };
  const levels = { red: 2, white: 3, green: 4, luna: LIMITED_SKIN_OFFERS.luna.level };
  const price = prices[key];
  if (!price) return res.status(400).json({ error: 'invalid-skin' });
  const user = req.user;
  if (!Array.isArray(user.ownedSkins)) user.ownedSkins = ['yellow'];
  if (user.ownedSkins.indexOf(key) !== -1) return res.status(409).json({ error: 'skin-already-owned' });
  const offer = LIMITED_SKIN_OFFERS[key];
  if (offer) {
    const sold = limitedSkinSoldCount(key);
    if (sold >= offer.max) return res.status(409).json({ error: 'sold-out', sold, max: offer.max });
  }
  if (user.ton < price) return res.status(400).json({ error: 'insufficient-funds' });
  user.ton -= price;
  user.ownedSkins.push(key);
  user.level = Math.max(user.level || 1, levels[key]);
  if (!user.skinRewards || typeof user.skinRewards !== 'object') user.skinRewards = {};
  const rewardDays = offer ? offer.rewardDays : 30;
  user.skinRewards[key] = { remainingDays: rewardDays, expiresAt: Date.now() + rewardDays * 86400000, lastCreditDate: berlinDayKey(), lastEarnedDate: '' };
  if (!Array.isArray(user.purchases)) user.purchases = [];
  user.purchases.push({ ts: Date.now(), key, price, level: levels[key] });
  if (user.purchases.length > 200) user.purchases = user.purchases.slice(-200);
  persist();
  res.json({ state: publicState(user) });
});

function ensureFigureState(user) {
  if (!user.figCount || typeof user.figCount !== 'object') user.figCount = {};
  FIGURE_IDS.forEach((id) => { user.figCount[id] = Math.max(0, Math.floor(Number(user.figCount[id]) || 0)); });
  if (!user.mine || typeof user.mine !== 'object') user.mine = { last: Date.now(), acc: 0 };
  user.mine.last = Math.max(0, Number(user.mine.last) || Date.now());
  user.mine.acc = Math.max(0, Number(user.mine.acc) || 0);
}

function userMiningRate(user) {
  ensureFigureState(user);
  const figureRate = FIGURE_IDS.reduce((sum, id) => sum + (user.figCount[id] > 0 ? FIGURE_MINING_RATES[id] : 0), 0);
  return figureRate + (user.figCount.luna > 0 ? LUNA_MINING_BONUS : 0);
}

function accrueUserMining(user, now = Date.now()) {
  ensureFigureState(user);
  const rate = userMiningRate(user);
  const elapsed = Math.max(0, now - user.mine.last);
  user.mine.acc = Math.min(rate, user.mine.acc + rate * elapsed / 86400000);
  user.mine.last = now;
  return rate;
}

function pickPackFigure(pack) {
  const entries = Object.entries(pack.weights);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = crypto.randomInt(total);
  for (const [id, weight] of entries) {
    roll -= weight;
    if (roll < 0) return id;
  }
  return entries[0][0];
}

app.post('/api/packs/buy', requireUserFromBody, rejectBannedUser, (req, res) => {
  const packId = String(req.body && req.body.packId || '');
  const pack = FIGURE_PACKS[packId];
  if (!pack) return res.status(400).json({ error: 'invalid-pack' });
  const user = req.user;
  if (Number(user.ton || 0) + 1e-9 < pack.price) {
    return res.status(400).json({ error: 'insufficient-funds', state: publicState(user) });
  }

  const now = Date.now();
  accrueUserMining(user, now);
  const figureId = pickPackFigure(pack);
  const previousCount = user.figCount[figureId] || 0;
  user.ton = Number((Number(user.ton || 0) - pack.price).toFixed(9));
  user.figCount[figureId] = previousCount + 1;
  if (!Array.isArray(user.purchases)) user.purchases = [];
  user.purchases.push({ ts: now, type: 'figure-pack', key: packId, price: pack.price, figureId });
  if (user.purchases.length > 200) user.purchases = user.purchases.slice(-200);
  persist();
  res.json({ state: publicState(user), reward: { kind: 'char', id: figureId, dup: previousCount > 0, n: previousCount + 1 } });
});

app.post('/api/mining/claim', requireUserFromBody, rejectBannedUser, (req, res) => {
  const user = req.user;
  const rate = accrueUserMining(user);
  const amount = Math.floor((Number(user.mine.acc) + 1e-9) * 100) / 100;
  if (amount < 0.01) return res.status(400).json({ error: 'mining-not-ready', state: publicState(user) });
  user.mine.acc = Math.max(0, Number((user.mine.acc - amount).toFixed(9)));
  creditTT(user, amount, 'mining-claim');
  persist();
  res.json({ amount, rate, state: publicState(user) });
});

app.post('/api/tasks/channel-claim', requireUserFromBody, async (req, res) => {
  const user = req.user;
  if (user.taskChannelRewardClaimed === true) {
    return res.json({ claimed: true, joined: true, rewardTT: 0, state: publicState(user) });
  }
  if (!BOT_TOKEN) return res.status(503).json({ error: 'server-missing-bot-token' });

  try {
    const apiUrl = 'https://api.telegram.org/bot' + BOT_TOKEN + '/getChatMember?chat_id=%40TaxiiTon&user_id=' + encodeURIComponent(user.id);
    const telegramResponse = await fetch(apiUrl);
    const telegramData = await telegramResponse.json();
    const member = telegramData && telegramData.ok ? telegramData.result : null;
    const joined = !!member && (
      member.status === 'creator' ||
      member.status === 'administrator' ||
      member.status === 'member' ||
      (member.status === 'restricted' && member.is_member === true)
    );
    if (!joined) return res.status(403).json({ error: 'channel-membership-required', joined: false });

    user.taskChannelRewardClaimed = true;
    creditTT(user, 5, 'channel-claim');
    syncCampaignInvite(user);
    let referralReward = 0;
    if (user.referredBy && !user.referralRewardClaimed) {
      const inviter = users[String(user.referredBy)];
      if (inviter) {
        inviter.referralCount = Number(inviter.referralCount || 0) + 1;
        inviter.referralPendingZombies = Number(inviter.referralPendingZombies || 0) + 300;
        inviter.referralRewardCount = Number(inviter.referralRewardCount || 0) + 1;
        referralReward = 300;
      }
      user.referralRewardClaimed = true;
    }
    persist();
    res.json({ claimed: true, joined: true, rewardTT: 5, referralReward, state: publicState(user) });
  } catch (e) {
    res.status(502).json({ error: 'telegram-membership-check-failed' });
  }
});

app.post('/api/referrals/invite-claim', requireUserFromBody, (req, res) => {
  const user = req.user;
  const milestones = { 5: 0.05, 20: 0.3, 50: 1 };
  const threshold = Number(req.body && req.body.threshold);
  if (!Object.prototype.hasOwnProperty.call(milestones, threshold)) {
    return res.status(400).json({ error: 'invalid-invite-threshold' });
  }
  if (Date.now() >= INVITE_EVENT_ENDS_AT) {
    return res.status(410).json({ error: 'invite-event-ended', endsAt: INVITE_EVENT_ENDS_AT });
  }
  const inviteCount = Number(user.referralCount || 0);
  if (inviteCount < threshold) return res.status(400).json({ error: 'invite-threshold-not-reached' });
  if (!user.inviteRewardsClaimed || typeof user.inviteRewardsClaimed !== 'object') user.inviteRewardsClaimed = {};
  if (user.inviteRewardsClaimed[String(threshold)] === true) {
    return res.json({ reward: 0, claimed: true, state: publicState(user) });
  }
  const reward = milestones[threshold];
  user.ton += reward;
  user.inviteRewardsClaimed[String(threshold)] = true;
  persist();
  res.json({ reward, claimed: true, state: publicState(user) });
});

app.post('/api/tasks/withdraw-channel-claim', requireUserFromBody, async (req, res) => {
  const user = req.user;
  if (user.withdrawChannelTaskRewardClaimed === true) {
    return res.json({ claimed: true, joined: true, rewardTT: 0, state: publicState(user) });
  }
  if (!BOT_TOKEN) return res.status(503).json({ error: 'server-missing-bot-token' });

  try {
    const apiUrl = 'https://api.telegram.org/bot' + BOT_TOKEN + '/getChatMember?chat_id=%40TaxitonWithdraw&user_id=' + encodeURIComponent(user.id);
    const telegramResponse = await fetch(apiUrl);
    const telegramData = await telegramResponse.json();
    const member = telegramData && telegramData.ok ? telegramData.result : null;
    const joined = !!member && (
      member.status === 'creator' ||
      member.status === 'administrator' ||
      member.status === 'member' ||
      (member.status === 'restricted' && member.is_member === true)
    );
    if (!joined) return res.status(403).json({ error: 'withdraw-channel-membership-required', joined: false });
    user.withdrawChannelTaskRewardClaimed = true;
    creditTT(user, 5, 'withdraw-channel-claim');
    syncCampaignInvite(user);
    persist();
    res.json({ claimed: true, joined: true, rewardTT: 5, state: publicState(user) });
  } catch (e) {
    res.status(502).json({ error: 'telegram-membership-check-failed' });
  }
});

app.post('/api/tasks/third-channel-claim', requireUserFromBody, async (req, res) => {
  const user = req.user;
  if (user.thirdChannelTaskRewardClaimed === true) {
    return res.json({ claimed: true, joined: true, rewardTT: 0, state: publicState(user) });
  }
  if (!BOT_TOKEN) return res.status(503).json({ error: 'server-missing-bot-token' });

  try {
    const apiUrl = 'https://api.telegram.org/bot' + BOT_TOKEN + '/getChatMember?chat_id=%40taxiiiton&user_id=' + encodeURIComponent(user.id);
    const telegramResponse = await fetch(apiUrl);
    const telegramData = await telegramResponse.json();
    const member = telegramData && telegramData.ok ? telegramData.result : null;
    const joined = !!member && (
      member.status === 'creator' ||
      member.status === 'administrator' ||
      member.status === 'member' ||
      (member.status === 'restricted' && member.is_member === true)
    );
    if (!joined) return res.status(403).json({ error: 'third-channel-membership-required', joined: false });
    user.thirdChannelTaskRewardClaimed = true;
    creditTT(user, 5, 'third-channel-claim');
    syncCampaignInvite(user);
    persist();
    res.json({ claimed: true, joined: true, rewardTT: 5, state: publicState(user) });
  } catch (e) {
    res.status(502).json({ error: 'telegram-membership-check-failed' });
  }
});

app.post('/api/tasks/ad-video-claim', requireUserFromBody, (req, res) => {
  const user = req.user;
  ensureDailyReset(user);
  const watched = Math.max(0, Math.min(10, Number(user.adVideosWatched) || 0));
  if (user.adRewardClaimed || watched >= 10) {
    user.adVideosWatched = 10;
    user.adRewardClaimed = true;
    return res.json({ watched: 10, reward: 0, rewardTT: 0, completed: true, state: publicState(user) });
  }
  user.adVideosWatched = watched + 1;
  let rewardTT = 0;
  if (user.adVideosWatched === 10 && user.adRewardClaimed !== true) {
    rewardTT = 250;
    creditTT(user, rewardTT, 'ad-video-claim');
    user.adRewardClaimed = true;
  }
  persist();
  res.json({ watched: user.adVideosWatched, reward: 0, rewardTT, completed: user.adRewardClaimed === true, state: publicState(user) });
});

// AdsGram calls this public callback after a rewarded video is completed.
// The Telegram UID is the same UID used as the key in users.json.
app.get('/api/adsgram-reward', (req, res) => {
  const userId = String(req.query.userid || '').trim();
  const user = userId ? users[userId] : null;

  // Always acknowledge the callback so AdsGram does not keep retrying it.
  if (!user) return res.status(200).json({ ok: false, rewarded: false });
  ensureDailyReset(user);

  if (user.adRewardClaimed === true) {
    return res.status(200).json({ ok: true, rewarded: false, completed: true, watched: 0 });
  }

  const watched = Math.max(0, Math.min(9, Number(user.adVideosWatched) || 0)) + 1;
  let reward = 0;
  let completed = false;
  if (watched >= 10) {
    user.adVideosWatched = 10;
    user.adRewardClaimed = true;
    creditTT(user, 250, 'adsgram-reward');
    reward = 0;
    completed = true;
  } else {
    user.adVideosWatched = watched;
  }

  persist();
  return res.status(200).json({ ok: true, rewarded: completed, reward, rewardTT: completed ? 250 : 0, completed, watched: user.adVideosWatched, state: publicState(user) });
});

async function tonApiJson(pathname) {
  const response = await fetch(TONAPI_URL + pathname);
  if (!response.ok) throw new Error('tonapi-http-' + response.status);
  return response.json();
}

function hasRecordedDeposit(depositId) {
  const id = String(depositId || '').toLowerCase();
  if (!id) return false;
  return Object.values(users).some((user) => {
    const txs = Array.isArray(user.depositTxs) ? user.depositTxs : [];
    if (txs.includes(id)) return true;
    return Array.isArray(user.deposits) && user.deposits.some((deposit) => String(deposit.txId || '').toLowerCase() === id);
  });
}

let depositScanInProgress = false;
let depositOperation = Promise.resolve();
function withDepositLock(operation) {
  const previous = depositOperation;
  let release;
  depositOperation = new Promise((resolve) => {
    release = resolve;
  });
  return previous.then(operation).finally(() => release());
}

async function scanDeposits() {
  if (!DEPOSIT_ADDRESS) return;
  return withDepositLock(async () => {
    if (depositScanInProgress) return;
    depositScanInProgress = true;
    try {
      const account = await tonApiJson('/accounts/' + encodeURIComponent(DEPOSIT_ADDRESS));
      const data = await tonApiJson('/accounts/' + encodeURIComponent(DEPOSIT_ADDRESS) + '/events?limit=100');
      let changed = false;
      for (const event of data.events || []) {
        for (const action of event.actions || []) {
          const transfer = action.type === 'TonTransfer' && action.TonTransfer;
          if (!transfer || action.status !== 'ok' || transfer.recipient.address !== account.address) continue;
          // New deposit memos omit the dash. Keep accepting the old format so
          // transfers already sent with a legacy memo are still credited.
          const match = /^TT-?(\d+)$/.exec(String(transfer.comment || '').trim());
          if (!match || Number(transfer.amount) <= 0) continue;
          const user = users[match[1]];
          if (!user) continue;
          if (!Array.isArray(user.depositTxs)) user.depositTxs = [];
          const txId = String(event.event_id || '').toLowerCase();
          if (!txId || hasRecordedDeposit(txId)) continue;
          const amountTon = Number(transfer.amount) / 1e9;
          user.ton += amountTon;
          user.depositTxs.push(txId);
          if (user.depositTxs.length > 200) user.depositTxs = user.depositTxs.slice(-200);
          if (!Array.isArray(user.deposits)) user.deposits = [];
          user.deposits.push({ ts: Date.now(), amount: amountTon, txId });
          if (user.deposits.length > 200) user.deposits = user.deposits.slice(-200);
          changed = true;
          console.log('[deposit] credited ' + amountTon + ' TON to user ' + user.id);
          notifyAdminDeposit(user, amountTon);
        }
      }
      if (changed) persist();
    } catch (e) {
      console.error('[deposit] scan failed: ' + e.message);
    } finally {
      depositScanInProgress = false;
    }
  });
}

function getNativeTransfer(event, uid) {
  return (event.actions || []).find((action) => {
    const transfer = action.type === 'TonTransfer' && action.TonTransfer;
    return transfer && action.status === 'ok' &&
      (transfer.comment === 'TT' + uid || transfer.comment === 'TT-' + uid) &&
      Number(transfer.amount) > 0;
  });
}

app.post('/api/deposit/claim', requireUserFromBody, async (req, res) => {
  const txHash = String(req.body && req.body.txHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(txHash)) return res.status(400).json({ error: 'invalid-transaction-id' });
  if (!DEPOSIT_ADDRESS) return res.status(503).json({ error: 'deposit-address-not-configured' });
  const user = req.user;
  await withDepositLock(async () => {
    if (!Array.isArray(user.depositTxs)) user.depositTxs = [];
    // Cheap early check for an exact repeat paste of the same value. The REAL duplicate
    // check happens below once the transfer's own canonical event_id is known: TonAPI
    // resolves several different hash values (an event's own id, its external message
    // hash, or any of its base_transactions hashes) to the exact same event, and the
    // automatic background scanner (scanDeposits() below) always records that canonical
    // event_id - not necessarily whichever equivalent hash the user happened to paste
    // here. Without re-checking against that same canonical id, the same deposit could
    // get credited twice: once automatically, once again via this manual claim.
    if (user.depositTxs.includes(txHash)) {
      res.status(409).json({ error: 'deposit-already-claimed' });
      return;
    }

    try {
      const account = await tonApiJson('/accounts/' + encodeURIComponent(DEPOSIT_ADDRESS));
      const event = await tonApiJson('/events/' + txHash);
      const canonicalEventId = String(event.event_id || txHash).toLowerCase();
      if (hasRecordedDeposit(canonicalEventId) || hasRecordedDeposit(txHash)) {
        res.status(409).json({ error: 'deposit-already-claimed' });
        return;
      }
      const transferAction = getNativeTransfer(event, user.id);
      const recipient = transferAction && transferAction.TonTransfer.recipient;
      if (!transferAction || !recipient || recipient.address !== account.address) {
        res.status(400).json({ error: 'deposit-does-not-match-account' });
        return;
      }
      const amount = transferAction.TonTransfer.amount / 1e9;
      user.ton += amount;
      user.depositTxs.push(canonicalEventId);
      if (txHash !== canonicalEventId) user.depositTxs.push(txHash);
      if (user.depositTxs.length > 200) user.depositTxs = user.depositTxs.slice(-200);
      if (!Array.isArray(user.deposits)) user.deposits = [];
      user.deposits.push({ ts: Date.now(), amount, txId: canonicalEventId });
      if (user.deposits.length > 200) user.deposits = user.deposits.slice(-200);
      persist();
      notifyAdminDeposit(user, amount);
      res.json({ state: publicState(user), amount });
    } catch (e) {
      res.status(502).json({ error: 'deposit-verification-failed' });
    }
  });
});

// ---- Checks (without consuming) that this Telegram account has a free attempt for
//      this level, and marks the run start for tournament anti-cheat timing. The
//      attempt itself is only spent on an actual crash - see /api/run/crash below -
//      so starting a run (or quitting early without crashing) never costs a try. ---
app.post('/api/run/start', requireUserFromBody, rejectBannedUser, (req, res) => {
  const level = resolvePlayableLevel(req.user, req.body && req.body.level);
  const state = ensureAttemptState(req.user, level);
  if (state.left <= 0) {
    persist();
    return res.status(409).json({ error: 'no-attempts-left', level, state: publicState(req.user) });
  }
  req.user.runStartedAt = Date.now();
  req.user.runStartedLevel = level;
  persist();
  res.json({ ok: true, level, state: publicState(req.user) });
});

// ---- Spends exactly one attempt for the level just crashed in. Called only when
//      a run actually ends in a crash (see app.js gameOver()), never for a
//      voluntary early exit. ------------------------------------------------------
app.post('/api/run/crash', requireUserFromBody, rejectBannedUser, (req, res) => {
  const level = resolvePlayableLevel(req.user, req.body && req.body.level);
  if (!consumeServerAttempt(req.user, level)) {
    persist();
    return res.status(409).json({ error: 'no-attempts-left', level, state: publicState(req.user) });
  }
  persist();
  res.json({ ok: true, level, state: publicState(req.user) });
});

// ---- Exchange a run's zombies for coins + (capped) TON ----
app.post('/api/run', requireUserFromBody, rejectBannedUser, (req, res) => {
  const user = req.user;
  const now = Date.now();
  const sinceLastRun = now - Number(user.lastRunAt || 0);
  if (sinceLastRun < MIN_MS_BETWEEN_RUN_EXCHANGES) {
    // Anti-bot: a script hammering this endpoint back-to-back gets rejected
    // instead of paid out. Nothing is consumed, so the client just keeps the
    // pending score and the player can retry once the cooldown has passed.
    return res.status(429).json({ error: 'run-too-frequent', retryAfterMs: MIN_MS_BETWEEN_RUN_EXCHANGES - sinceLastRun });
  }
  user.lastRunAt = now;

  let { distance, zombies } = req.body || {};
  zombies = Math.max(0, Math.min(MAX_ZOMBIES_PER_CALL, Math.floor(Number(zombies) || 0)));
  distance = Math.max(0, Math.min(MAX_DISTANCE_PER_CALL, Math.floor(Number(distance) || 0)));

  ensureDailyReset(user);

  const level = resolvePlayableLevel(user, req.body && req.body.level);
  const coinsPerZombie = level >= 5 ? LEVEL_FIVE_COINS_PER_ZOMBIE : level >= 4 ? LEVEL_FOUR_COINS_PER_ZOMBIE : level >= 3 ? LEVEL_THREE_COINS_PER_ZOMBIE : level >= 2 ? LEVEL_TWO_COINS_PER_ZOMBIE : COINS_PER_ZOMBIE;
  const coinsGained = zombies * coinsPerZombie;
  user.coins += coinsGained;

  if (level === 1) {
    // Level 1 isn't on the daily TON cap system: every 2-hour attempt window gives
    // one flat LEVEL_ONE_WINDOW_TON_REWARD once LEVEL_ONE_WINDOW_ZOMBIE_GOAL zombies
    // have been killed since the window started (see ensureAttemptState).
    const attemptState = ensureAttemptState(user, 1);
    attemptState.windowZombies = Math.max(0, Number(attemptState.windowZombies) || 0) + zombies;
    if (!attemptState.windowRewardGiven && attemptState.windowZombies >= LEVEL_ONE_WINDOW_ZOMBIE_GOAL) {
      attemptState.windowRewardGiven = true;
      user.ton += LEVEL_ONE_WINDOW_TON_REWARD;
    }
    user.runs += 1;
    user.best = Math.max(user.best, zombies);
    persist();
    res.json({ state: publicState(user), acceptedZombies: zombies });
    return;
  }

  const hasLevelReward = hasActiveLevelReward(user, level);
  const dailyCap = hasLevelReward ? dailyTonCapForLevel(level) : 0;
  const levelToday = Number(user.tonTodayByLevel[level] || 0);
  if (hasLevelReward && levelToday >= dailyCap - 1e-9) {
    persist();
    return res.json({ state: publicState(user), acceptedZombies: 0, error: 'daily-earn-cap-reached', level });
  }

  // Flat reward: once this level's "zombies today" goal is reached, credit the
  // FULL daily TON cap in one go - independent of the per-zombie coin rate,
  // which no longer lines up 1:1 with these goals (see LEVEL_ZOMBIE_GOALS).
  if (!user.zombiesTodayByLevel || typeof user.zombiesTodayByLevel !== 'object') user.zombiesTodayByLevel = { 2: 0, 3: 0, 4: 0, 5: 0 };
  const zombiesToday = Math.max(0, Number(user.zombiesTodayByLevel[level]) || 0) + zombies;
  user.zombiesTodayByLevel[level] = zombiesToday;
  const zombieGoal = LEVEL_ZOMBIE_GOALS[level] || LEVEL_ZOMBIE_GOALS[2];
  if (hasLevelReward && zombiesToday >= zombieGoal) {
    user.ton += dailyCap;
    user.tonTodayByLevel[level] = dailyCap;
  }
  user.tonToday = user.tonTodayByLevel[level];

  user.runs += 1;
  user.best = Math.max(user.best, zombies);

  persist();
  // acceptedZombies tells the client how many were actually credited, so anything
  // above the per-call ceiling stays pending on the client instead of being lost
  res.json({ state: publicState(user), acceptedZombies: zombies });
});

app.post('/api/tt/pickup', requireUserFromBody, rejectBannedUser, (req, res) => {
  const user = req.user;
  const amount = Math.max(1, Math.min(1, Math.floor(Number(req.body && req.body.amount) || 1)));
  creditTT(user, amount, 'tt-pickup');
  persist();
  res.json({ amount, state: publicState(user) });
});

// ---- Player-versus-player rock-paper-scissors ----
app.get('/api/rps/games', requireUserFromQuery, (req, res) => {
  expireRpsGames();
  const uid = String(req.uid);
  const games = Object.values(rpsGames)
    .filter((game) => game.status === 'open' && String(game.creatorId) !== uid)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50)
    .map((game) => rpsPublicGame(game, uid));
  const mine = Object.values(rpsGames)
    .filter((game) => (String(game.creatorId) === uid || String(game.opponentId || '') === uid) && ['open', 'playing'].includes(game.status))
    .map((game) => rpsPublicGame(game, uid));
  const finished = Object.values(rpsGames)
    .filter((game) => (String(game.creatorId) === uid || String(game.opponentId || '') === uid) && game.status === 'finished')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 1)
    .map((game) => rpsPublicGame(game, uid));
  res.json({ games, mine: mine.length ? mine : finished });
});

app.post('/api/rps/create', requireUserFromBody, rejectBannedUser, (req, res) => {
  expireRpsGames();
  const stake = Number(req.body && req.body.stake);
  if (!Number.isFinite(stake) || stake < RPS_MIN_STAKE || stake > 1000) return res.status(400).json({ error: 'invalid-stake' });
  const user = req.user;
  if (user.ton < stake) return res.status(400).json({ error: 'insufficient-funds' });
  const id = crypto.randomUUID();
  user.ton -= stake;
  rpsGames[id] = { id, stake, creatorId: user.id, creatorName: user.name, creatorChoice: null, opponentId: null, opponentName: null, opponentChoice: null, status: 'open', result: null, createdAt: Date.now(), expiresAt: Date.now() + RPS_GAME_TTL_MS };
  persist();
  persistRpsGames();
  res.json({ state: publicState(user), game: rpsPublicGame(rpsGames[id], user.id) });
});

app.post('/api/rps/join', requireUserFromBody, rejectBannedUser, (req, res) => {
  expireRpsGames();
  const game = rpsGames[String(req.body && req.body.gameId)];
  if (!game || game.status !== 'open') return res.status(404).json({ error: 'game-not-open' });
  const user = req.user;
  if (String(game.creatorId) === String(user.id)) return res.status(400).json({ error: 'cannot-join-own-game' });
  if (user.ton < game.stake) return res.status(400).json({ error: 'insufficient-funds' });
  user.ton -= game.stake;
  game.opponentId = user.id;
  game.opponentName = user.name;
  game.status = 'playing';
  persist();
  persistRpsGames();
  res.json({ state: publicState(user), game: rpsPublicGame(game, user.id) });
});

app.post('/api/rps/play', requireUserFromBody, rejectBannedUser, (req, res) => {
  const game = rpsGames[String(req.body && req.body.gameId)];
  const choice = String(req.body && req.body.choice || '');
  if (!game || game.status !== 'playing') return res.status(404).json({ error: 'game-not-playing' });
  if (!RPS_CHOICES.has(choice)) return res.status(400).json({ error: 'invalid-choice' });
  const user = req.user;
  const isCreator = String(game.creatorId) === String(user.id);
  const isOpponent = String(game.opponentId) === String(user.id);
  if (!isCreator && !isOpponent) return res.status(403).json({ error: 'not-a-player' });
  if (isCreator ? game.creatorChoice : game.opponentChoice) return res.status(409).json({ error: 'choice-already-made' });
  if (isCreator) game.creatorChoice = choice;
  else game.opponentChoice = choice;
  if (game.creatorChoice && game.opponentChoice){
    const winner = rpsWinner(game.creatorChoice, game.opponentChoice);
    const pot = game.stake * 2;
    const platformFee = winner === 'tie' ? 0 : Number((pot * 0.1).toFixed(9));
    const winnerPayout = winner === 'tie' ? game.stake : Number((pot - platformFee).toFixed(9));
    game.result = { winner, creatorChoice: game.creatorChoice, opponentChoice: game.opponentChoice, payout: winnerPayout, platformFee };
    game.status = 'finished';
    if (winner === 'tie'){
      users[String(game.creatorId)].ton += game.stake;
      users[String(game.opponentId)].ton += game.stake;
    } else {
      const winnerId = winner === 'creator' ? game.creatorId : game.opponentId;
      users[String(winnerId)].ton += winnerPayout;
      if (PLATFORM_USER_ID && users[PLATFORM_USER_ID]) users[PLATFORM_USER_ID].ton += platformFee;
    }
    persist();
  }
  persistRpsGames();
  res.json({ state: publicState(user), game: rpsPublicGame(game, user.id) });
});

// ---- Four-player knockout RPS tournaments ----
app.get('/api/rps/tournaments', requireUserFromQuery, (req, res) => {
  const uid = String(req.uid);
  const tournaments = Object.values(rpsGames).filter((game) => game.mode === 'four-player' && ['open', 'playing'].includes(game.status) && !game.players.some((player) => String(player.id) === uid)).map((game) => rpsTournamentPublic(game, uid));
  const mine = Object.values(rpsGames).filter((game) => game.mode === 'four-player' && game.players.some((player) => String(player.id) === uid) && game.status !== 'finished').slice(-1).map((game) => rpsTournamentPublic(game, uid));
  const finished = Object.values(rpsGames).filter((game) => game.mode === 'four-player' && game.players.some((player) => String(player.id) === uid) && game.status === 'finished').slice(-1).map((game) => rpsTournamentPublic(game, uid));
  const activeUsers = Object.values(users).filter((user) => Date.now() - Number(user.lastSeenAt || 0) < 90000).map((user) => ({ id: String(user.id), name: user.name, balance: Number(user.ton || 0) }));
  res.json({ tournaments, mine: mine.length ? mine : finished, activeUsers });
});

app.get('/api/game/lobby', requireUserFromQuery, (req, res) => {
  const activeUsers = Object.values(users)
    .filter((user) => Date.now() - Number(user.lastSeenAt || 0) < 90000)
    .map((user) => ({ id: String(user.id), name: user.name, balance: Number(user.ton || 0) }));
  res.json({ players: activeUsers });
});

app.get('/api/game/rooms', requireUserFromQuery, (req, res) => {
  req.user.lastSeenAt = Date.now();
  ensureGameRooms();
  res.json({ rooms: [gameRoomPublic(rpsGames[gameRoomId(GAME_ROOM_STAKE)], req.uid)] });
});

app.post('/api/game/rooms/join', requireUserFromBody, rejectBannedUser, (req, res) => {
  ensureGameRooms();
  const room = rpsGames[String(req.body && req.body.roomId)];
  if (room && Array.isArray(room.players) && room.players.length < 4) room.status = 'open';
  if (!room || room.mode !== 'room-knockout' || room.status !== 'open') return res.status(409).json({ error: 'room-not-open' });
  const user = req.user;
  if (room.players.some((player) => String(player.id) === String(user.id))) return res.status(409).json({ error: 'already-joined' });
  if (room.players.length >= 4) return res.status(409).json({ error: 'room-full' });
  if (user.ton < room.stake) return res.status(400).json({ error: 'insufficient-funds' });
  user.ton -= room.stake;
  room.players.push({ id: user.id, name: user.name, alive: true, eliminated: false });
  user.lastSeenAt = Date.now();
  if (room.players.length === 4) { room.status = 'playing'; room.round = 1; room.roundStartedAt = Date.now(); }
  persist(); persistRpsGames();
  res.json({ state: publicState(user), room: gameRoomPublic(room, user.id) });
});

app.post('/api/game/rooms/choose', requireUserFromBody, rejectBannedUser, (req, res) => {
  ensureGameRooms();
  const room = rpsGames[String(req.body && req.body.roomId)];
  const choice = String(req.body && req.body.choice || '');
  if (!room || room.mode !== 'room-knockout' || room.status !== 'playing') return res.status(409).json({ error: 'room-not-playing' });
  if (!RPS_CHOICES.has(choice)) return res.status(400).json({ error: 'invalid-choice' });
  const uid = String(req.user.id);
  req.user.lastSeenAt = Date.now();
  const player = room.players.find((item) => String(item.id) === uid && item.alive);
  if (!player) return res.status(403).json({ error: 'not-active-player' });
  if (room.choices[uid]) return res.status(409).json({ error: 'choice-already-made' });
  if (Object.keys(room.choices).length === 0) room.lastRoundChoices = {};
  room.choices[uid] = choice;
  resolveGameRoom(room);
  persist(); persistRpsGames();
  res.json({ state: publicState(req.user), room: gameRoomPublic(room, uid) });
});

app.post('/api/rps/tournaments/create', requireUserFromBody, rejectBannedUser, (req, res) => {
  const stake = Number(req.body && req.body.stake);
  if (!Number.isFinite(stake) || stake < RPS_MIN_STAKE || stake > 1000) return res.status(400).json({ error: 'invalid-stake' });
  const user = req.user;
  if (user.ton < stake) return res.status(400).json({ error: 'insufficient-funds' });
  const id = crypto.randomUUID();
  user.ton -= stake;
  rpsGames[id] = { id, mode:'four-player', stake, players:[{ id:user.id, name:user.name, alive:true, eliminated:false, choice:null }], status:'open', round:0, matches:[], result:null, createdAt:Date.now(), expiresAt:Date.now() + RPS_GAME_TTL_MS };
  persist(); persistRpsGames();
  res.json({ state: publicState(user), game: rpsTournamentPublic(rpsGames[id], user.id) });
});

app.post('/api/rps/tournaments/join', requireUserFromBody, rejectBannedUser, (req, res) => {
  const game = rpsGames[String(req.body && req.body.gameId)];
  if (!game || game.mode !== 'four-player' || game.status !== 'open') return res.status(404).json({ error:'tournament-not-open' });
  const user = req.user;
  if (game.players.some((player) => String(player.id) === String(user.id))) return res.status(409).json({ error:'already-joined' });
  if (user.ton < game.stake) return res.status(400).json({ error:'insufficient-funds' });
  user.ton -= game.stake;
  game.players.push({ id:user.id, name:user.name, alive:true, eliminated:false, choice:null });
  if (game.players.length === 4) { game.status = 'playing'; game.round = 1; game.matches = makeTournamentMatches(game.players.map((player) => player.id)); }
  persist(); persistRpsGames();
  res.json({ state: publicState(user), game: rpsTournamentPublic(game, user.id) });
});

app.post('/api/rps/tournaments/play', requireUserFromBody, rejectBannedUser, (req, res) => {
  const game = rpsGames[String(req.body && req.body.gameId)];
  const choice = String(req.body && req.body.choice || '');
  if (!game || game.mode !== 'four-player' || game.status !== 'playing') return res.status(404).json({ error:'tournament-not-playing' });
  if (!RPS_CHOICES.has(choice)) return res.status(400).json({ error:'invalid-choice' });
  const uid = String(req.user.id);
  const match = game.matches.find((item) => (String(item.a) === uid || String(item.b) === uid) && !item.winner);
  if (!match) return res.status(403).json({ error:'not-active-player' });
  const player = game.players.find((item) => String(item.id) === uid);
  if (String(match.a) === uid) {
    if (match.aChoice) return res.status(409).json({ error:'choice-already-made' });
    match.aChoice = choice;
  } else {
    if (match.bChoice) return res.status(409).json({ error:'choice-already-made' });
    match.bChoice = choice;
  }
  if (player) player.choice = choice;
  resolveTournamentMatch(game, match);
  advanceTournament(game);
  persist(); persistRpsGames();
  res.json({ state: publicState(req.user), game: rpsTournamentPublic(game, uid) });
});

// ---- Withdraw ----
function isPlausibleTonAddress(addr) {
  return typeof addr === 'string' && addr.trim().length >= 10 && !/\s/.test(addr.trim());
}
app.post('/api/withdraw', requireUserFromBody, rejectBannedUser, (req, res) => {
  const user = req.user;
  const { address, amount } = req.body || {};
  const memo = String(req.body && req.body.memo || '').trim();
  const amt = Number(amount);

  if (!isPlausibleTonAddress(address)) return res.status(400).json({ error: 'invalid-address' });
  if (memo.length > 120) return res.status(400).json({ error: 'memo-too-long' });
  if (!amt || amt < MIN_WITHDRAW) return res.status(400).json({ error: 'amount-too-small' });
  if (amt > user.ton) return res.status(400).json({ error: 'insufficient-funds' });
  const retryAfterMs = withdrawalCooldownMs(user);
  if (retryAfterMs > 0) {
    return res.status(409).json({ error: 'withdrawal-cooldown', retryAfterMs, nextAllowedAt: Date.now() + retryAfterMs, state: publicState(user) });
  }

  const fee = Number((amt * WITHDRAWAL_FEE_RATE).toFixed(6));
  const netAmount = Number((amt - fee).toFixed(6));
  const now = Date.now();
  user.ton -= amt;
  user.lastWithdrawalDay = berlinDayKey();
  user.lastWithdrawalAt = now;
  const withdrawal = { ts: now, address: String(address).trim(), memo, amount: netAmount, grossAmount: amt, fee, status: 'pending' };
  user.withdrawals.push(withdrawal);
  if (user.withdrawals.length > 200) user.withdrawals = user.withdrawals.slice(-200);

  persist();
  res.json({ state: publicState(user), withdrawal });
});

// ---------------------------------------------------------------
// TT jetton withdrawal (on-chain payout via a user's own TON Connect wallet)
// ------------------------------------------------------------------
function isValidTonDestinationAddress(address) {
  try {
    TonAddress.parse(String(address || '').trim());
    return true;
  } catch (e) {
    return false;
  }
}

function ttWithdrawalCooldownMs(user, now = Date.now()) {
  const last = Number(user.lastTtWithdrawalAt) || 0;
  return last ? Math.max(0, last + TT_WITHDRAW_COOLDOWN_MS - now) : 0;
}

function activeTtWithdrawal(user) {
  return (user.ttWithdrawals || []).find((w) => w.status === 'pending' || w.status === 'processing' || w.status === 'needs-review');
}

function ttWithdrawnTodayTotal() {
  const today = berlinDayKey();
  let total = 0;
  Object.values(users).forEach((u) => {
    (u.ttWithdrawals || []).forEach((w) => {
      if (w.status === 'failed') return;
      if (berlinDayKey(new Date(Number(w.ts) || 0)) === today) total += Number(w.amount || 0);
    });
  });
  return total;
}

function publicTtWithdrawal(w) {
  return {
    ts: w.ts,
    address: w.address,
    amount: w.amount,
    status: w.status,
    failReason: w.failReason || undefined,
    completedAt: w.completedAt || undefined,
  };
}

// All TT sends share one treasury wallet, which (like any TON wallet)
// processes external messages strictly in seqno order - so every withdrawal,
// no matter which user requested it, runs through this single serial queue
// to avoid seqno races. Each job does the full build -> send -> confirm (or
// refund) cycle before the next one starts.
let ttWithdrawQueue = Promise.resolve();
function enqueueTtWithdrawal(job) {
  ttWithdrawQueue = ttWithdrawQueue.then(job).catch((e) => {
    console.error('[tt-withdraw] worker job threw unexpectedly: ' + (e && e.message));
  });
  return ttWithdrawQueue;
}

async function processTtWithdrawal(user, withdrawal) {
  withdrawal.status = 'processing';
  persist();
  try {
    const [treasuryTtBalance, treasuryTonBalance] = await Promise.all([
      treasury.getTtBalance(TT_DECIMALS),
      treasury.getTonBalance(),
    ]);
    if (treasuryTtBalance < withdrawal.amount) {
      throw Object.assign(new Error('treasury-insufficient-tt'), { safeToRefund: true });
    }
    if (treasuryTonBalance < TT_WITHDRAW_GAS_TON + TT_MIN_TREASURY_TON_RESERVE) {
      throw Object.assign(new Error('treasury-insufficient-ton-reserve'), { safeToRefund: true });
    }

    const beforeUnits = await treasury.getTtBalanceUnits();
    const { seqnoBefore, queryId, amountUnits } = await treasury.sendJettonTransfer({
      toAddressStr: withdrawal.address,
      amountTT: withdrawal.amount,
      decimals: TT_DECIMALS,
      gasTon: TT_WITHDRAW_GAS_TON,
    });
    // From here on a message may already be on its way to the chain, so any
    // further failure must NOT be auto-refunded - see the catch block below.
    withdrawal.sendAttempted = true;
    withdrawal.seqnoBefore = seqnoBefore;
    withdrawal.queryId = queryId;
    persist();

    const accepted = await treasury.waitSeqnoChange(seqnoBefore, TT_WITHDRAW_ACCEPT_TIMEOUT_MS, 4000);
    if (!accepted) throw new Error('not-accepted-timeout');

    const confirmed = await treasury.waitBalanceDrop(beforeUnits, BigInt(amountUnits), TT_WITHDRAW_CONFIRM_TIMEOUT_MS, 5000);
    if (!confirmed) {
      withdrawal.status = 'needs-review';
      withdrawal.failReason = 'accepted-but-balance-drop-unconfirmed';
      persist();
      void notifyAdminText(
        '⚠️ TT-Auszahlung braucht manuelle Prüfung.\nUID ' + user.id + ', Betrag ' + withdrawal.amount +
        ' TT, queryId ' + queryId + '.\nBitte in /admin prüfen (Tonviewer) und manuell abschließen oder zurückbuchen.'
      );
      return;
    }

    withdrawal.status = 'completed';
    withdrawal.completedAt = Date.now();
    user.ttWithdrawnLifetime = Number((Number(user.ttWithdrawnLifetime || 0) + withdrawal.amount).toFixed(6));
    persist();
    console.log('[tt-withdraw] completed uid=' + user.id + ' amount=' + withdrawal.amount + ' queryId=' + queryId);
  } catch (e) {
    const reason = e && e.message ? e.message : String(e);
    if (withdrawal.sendAttempted && !e.safeToRefund) {
      withdrawal.status = 'needs-review';
      withdrawal.failReason = reason;
      persist();
      void notifyAdminText(
        '⚠️ TT-Auszahlung: Fehler nach Sendeversuch.\nUID ' + user.id + ', Betrag ' + withdrawal.amount +
        ' TT.\nGrund: ' + reason + '\nBitte in /admin prüfen, bevor zurückgebucht wird.'
      );
    } else {
      withdrawal.status = 'failed';
      withdrawal.failReason = reason;
      user.ttBalance = Number((Number(user.ttBalance || 0) + withdrawal.amount).toFixed(6));
      persist();
      console.error('[tt-withdraw] failed before/without send for uid ' + user.id + ': ' + reason);
      if (reason.startsWith('treasury-insufficient')) {
        void notifyAdminText('🚨 TT-Treasury niedrig: ' + reason + '. Auszahlungen pausieren, bis aufgefüllt wird.');
      }
    }
  }
}

app.post('/api/tt/withdraw', requireUserFromBody, rejectBannedUser, async (req, res) => {
  const user = req.user;
  if (!TT_WITHDRAW_ENABLED) return res.status(503).json({ error: 'tt-withdraw-disabled' });
  if (TT_WITHDRAW_ADMIN_ONLY && !TT_WITHDRAW_ALLOWLIST.has(String(user.id))) {
    return res.status(403).json({ error: 'tt-withdraw-admin-only' });
  }
  if (!treasury.isReady()) return res.status(503).json({ error: 'tt-treasury-not-ready' });

  const address = String(req.body && req.body.address || '').trim();
  const amount = Number(req.body && req.body.amount);
  if (!isValidTonDestinationAddress(address)) return res.status(400).json({ error: 'invalid-address' });
  if (!Number.isFinite(amount) || amount < TT_MIN_WITHDRAW) {
    return res.status(400).json({ error: 'amount-too-small', minimum: TT_MIN_WITHDRAW });
  }
  if (amount > Number(user.ttBalance || 0)) return res.status(400).json({ error: 'insufficient-funds' });

  if (activeTtWithdrawal(user)) return res.status(409).json({ error: 'tt-withdrawal-already-in-progress' });
  const retryAfterMs = ttWithdrawalCooldownMs(user);
  if (retryAfterMs > 0) {
    return res.status(409).json({ error: 'tt-withdrawal-cooldown', retryAfterMs, nextAllowedAt: Date.now() + retryAfterMs });
  }
  if (!ttBalanceIsPlausible(user)) {
    console.error('[tt-withdraw] BLOCKED - ttBalance integrity check failed for uid ' + user.id +
      ' (ttBalance=' + user.ttBalance + ', ttCreditedLifetime=' + user.ttCreditedLifetime + ', ttWithdrawnLifetime=' + user.ttWithdrawnLifetime + ')');
    void notifyAdminText('🚨 TT-Guthaben von UID ' + user.id + ' besteht die Plausibilitätsprüfung nicht. Auszahlung blockiert, bitte Konto prüfen.');
    return res.status(409).json({ error: 'tt-balance-integrity-check-failed' });
  }
  if (ttWithdrawnTodayTotal() + amount > TT_GLOBAL_DAILY_LIMIT) {
    return res.status(429).json({ error: 'tt-global-daily-limit-reached', limit: TT_GLOBAL_DAILY_LIMIT });
  }

  // Live reserve check right before accepting the request (the worker checks
  // again, right before spending, since other queued withdrawals can shift
  // these balances in the meantime).
  try {
    const [treasuryTtBalance, treasuryTonBalance] = await Promise.all([
      treasury.getTtBalance(TT_DECIMALS),
      treasury.getTonBalance(),
    ]);
    console.log('[tt-withdraw] pre-flight check uid=' + user.id + ' amount=' + amount +
      ' treasuryTT=' + treasuryTtBalance + ' treasuryTON=' + treasuryTonBalance);
    if (treasuryTtBalance < amount) {
      console.error('[tt-withdraw] REJECTED - treasury has only ' + treasuryTtBalance + ' TT, requested ' + amount + ' TT (uid ' + user.id + ')');
      return res.status(503).json({ error: 'tt-treasury-insufficient-tt' });
    }
    if (treasuryTonBalance < TT_WITHDRAW_GAS_TON + TT_MIN_TREASURY_TON_RESERVE) {
      console.error('[tt-withdraw] REJECTED - treasury has only ' + treasuryTonBalance + ' TON, needs at least ' +
        (TT_WITHDRAW_GAS_TON + TT_MIN_TREASURY_TON_RESERVE) + ' TON (gas + reserve) (uid ' + user.id + ')');
      return res.status(503).json({ error: 'tt-treasury-insufficient-ton-reserve' });
    }
  } catch (e) {
    console.error('[tt-withdraw] REJECTED - treasury balance check threw: ' + (e && e.message) + ' (uid ' + user.id + ')');
    return res.status(503).json({ error: 'tt-treasury-unreachable' });
  }

  user.ttBalance = Number((Number(user.ttBalance || 0) - amount).toFixed(6));
  user.lastTtWithdrawalAt = Date.now();
  const withdrawal = { ts: Date.now(), address, amount, status: 'pending', sendAttempted: false };
  if (!Array.isArray(user.ttWithdrawals)) user.ttWithdrawals = [];
  user.ttWithdrawals.push(withdrawal);
  if (user.ttWithdrawals.length > 200) user.ttWithdrawals = user.ttWithdrawals.slice(-200);
  persist();

  enqueueTtWithdrawal(() => processTtWithdrawal(user, withdrawal));
  res.json({ state: publicState(user), withdrawal: publicTtWithdrawal(withdrawal) });
});

app.get('/api/tt/withdrawals', requireUserFromQuery, (req, res) => {
  res.json({ withdrawals: (req.user.ttWithdrawals || []).slice(-50).map(publicTtWithdrawal) });
});

function isValidTtPayoutAddress(coin, address) {
  if (coin === 'ton') return TT_SHOP_TON_ADDRESS.test(address);
  if (coin === 'usdt' || coin === 'trx') return TT_SHOP_TRON_ADDRESS.test(address);
  if (coin === 'bnb' || coin === 'shib') return TT_SHOP_EVM_ADDRESS.test(address);
  if (coin === 'ltc') return TT_SHOP_LTC_ADDRESS.test(address);
  return false;
}

app.post('/api/tt-shop/order', requireUserFromBody, rejectBannedUser, (req, res) => {
  const user = req.user;
  if (!ttShopEnabled) return res.status(503).json({ error: 'tt-shop-disabled' });
  const coin = String(req.body && req.body.coin || '').toLowerCase();
  const usd = Number(req.body && req.body.usd);
  const address = String(req.body && req.body.address || '').trim();
  const memo = String(req.body && req.body.memo || '').trim();
  if (!TT_SHOP_COINS.has(coin)) return res.status(400).json({ error: 'unsupported-coin' });
  if (!Number.isInteger(usd) || !TT_SHOP_AMOUNTS_USD.includes(usd) || usd < 3) {
    return res.status(400).json({ error: 'amount-too-small', minimumUsd: 3 });
  }
  if (!isValidTtPayoutAddress(coin, address)) return res.status(400).json({ error: 'invalid-address' });
  if (coin === 'ton' && memo.length > 120) return res.status(400).json({ error: 'memo-too-long' });
  const ttCost = usd * TT_PER_USD;
  if (Number(user.ttBalance || 0) < ttCost) return res.status(400).json({ error: 'insufficient-tt' });

  const order = { ts: Date.now(), coin, usd, tt: ttCost, address, memo: coin === 'ton' ? memo : '', status: 'pending' };
  user.ttBalance = Number((Number(user.ttBalance || 0) - ttCost).toFixed(6));
  if (!Array.isArray(user.ttOrders)) user.ttOrders = [];
  user.ttOrders.unshift(order);
  if (user.ttOrders.length > 200) user.ttOrders = user.ttOrders.slice(0, 200);
  persist();
  res.json({ ok: true, order, state: publicState(user) });
});

app.post('/api/items/buy', requireUserFromBody, rejectBannedUser, (req, res) => {
  const user = req.user;
  const kind = String(req.body && req.body.kind || '');
  const id = String(req.body && req.body.id || '');
  const catalog = TT_CHAT_ITEMS[kind];
  if (!catalog || !Object.hasOwn(catalog, id)) return res.status(400).json({ error: 'invalid-item' });
  const price = catalog[id];
  if (price <= 0) return res.status(400).json({ error: 'item-is-free' });
  publicState(user);
  const collection = kind === 'stk' ? user.stickerPacks : user.chatItems[kind];
  if (collection.includes(id)) return res.status(409).json({ error: 'item-already-owned', state: publicState(user) });
  if (Number(user.ttBalance || 0) < price) return res.status(400).json({ error: 'insufficient-tt', state: publicState(user) });
  user.ttBalance = Number((Number(user.ttBalance || 0) - price).toFixed(6));
  collection.push(id);
  if (kind !== 'stk') user.chatItems.eq[kind] = id;
  if (!Array.isArray(user.purchases)) user.purchases = [];
  user.purchases.push({ ts: Date.now(), type: 'chat-item', kind, key: id, price });
  if (user.purchases.length > 200) user.purchases = user.purchases.slice(-200);
  persist();
  res.json({ ok: true, item: { kind, id }, state: publicState(user) });
});

app.post('/api/items/equip', requireUserFromBody, rejectBannedUser, (req, res) => {
  const user = req.user;
  const kind = String(req.body && req.body.kind || '');
  const id = String(req.body && req.body.id || '');
  if (!['bub', 'frm', 'ban'].includes(kind) || !Object.hasOwn(TT_CHAT_ITEMS[kind], id)) {
    return res.status(400).json({ error: 'invalid-item' });
  }
  publicState(user);
  if (!user.chatItems[kind].includes(id)) return res.status(403).json({ error: 'item-not-owned' });
  user.chatItems.eq[kind] = id;
  persist();
  res.json({ ok: true, state: publicState(user) });
});

const PROFILE_PRESET_IMAGES = new Set(['assets/av-berlin.webp','assets/av-luna.webp','assets/av-nikto.webp','assets/av-nova.webp','assets/av-sara.webp','assets/av-zero.webp','assets/av-zombie.webp']);
app.get('/api/profile/:uid', requireUserFromQuery, (req, res) => {
  const target = users[String(req.params.uid || '')];
  if (!target) return res.status(404).json({ error: 'profile-not-found' });
  const kinds = { bub: 'classic', frm: 'none', ban: 'classic' };
  const sourceItems = target.chatItems && typeof target.chatItems === 'object' ? target.chatItems : {};
  const equipped = sourceItems.eq && typeof sourceItems.eq === 'object' ? sourceItems.eq : {};
  const owned = Object.fromEntries(Object.entries(kinds).map(([kind, freeId]) => {
    const ids = Array.isArray(sourceItems[kind]) ? sourceItems[kind] : [freeId];
    return [kind, [...new Set(ids.filter((id) => Object.hasOwn(TT_CHAT_ITEMS[kind], id)))]];
  }));
  const selected = Object.fromEntries(Object.entries(kinds).map(([kind, freeId]) => [
    kind,
    owned[kind].includes(equipped[kind]) ? equipped[kind] : freeId,
  ]));
  const withdrawals = Array.isArray(target.withdrawals) ? target.withdrawals : [];
  res.json({ profile: {
    name: target.name || ('Player ' + target.id),
    photoUrl: target.profileImage || target.photoUrl || '',
    ton: Number(target.ton) || 0,
    tt: Number(target.ttBalance) || 0,
    paid: withdrawals.filter((item) => item.status === 'completed')
      .reduce((sum, item) => sum + Number(item.grossAmount ?? item.amount ?? 0), 0),
    level: Number(target.level) || 1,
    bub: selected.bub,
    frm: selected.frm,
    ban: selected.ban,
    own: owned,
    stk: Array.isArray(target.stickerPacks)
      ? [...new Set(target.stickerPacks.filter((id) => Object.hasOwn(TT_CHAT_ITEMS.stk, id)))]
      : [],
    bio: typeof target.bio === 'string' ? target.bio.slice(0, 120) : '',
  } });
});
app.post('/api/profile/bio', requireUserFromBody, rejectBannedUser, (req, res) => {
  const bio = typeof (req.body && req.body.bio) === 'string' ? req.body.bio : '';
  req.user.bio = bio.replace(/\s+/g, ' ').trim().slice(0, 120);
  persist();
  res.json({ ok: true, state: publicState(req.user) });
});
app.post('/api/profile/photo', requireUserFromBody, rejectBannedUser, (req, res) => {
  const photo = String(req.body && req.body.photo || '');
  if (photo && !PROFILE_PRESET_IMAGES.has(photo)) {
    const match = photo.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match || Buffer.from(match[1], 'base64').length > 48 * 1024) {
      return res.status(400).json({ error: 'invalid-profile-image' });
    }
  }
  req.user.profileImage = photo;
  persist();
  res.json({ ok: true, state: publicState(req.user) });
});

function ensureFriendState(user) {
  if (!Array.isArray(user.friends)) user.friends = [];
  if (!Array.isArray(user.friendRequestsIn)) user.friendRequestsIn = [];
  if (!Array.isArray(user.friendRequestsOut)) user.friendRequestsOut = [];
  if (!user.directMessages || typeof user.directMessages !== 'object') user.directMessages = {};
  if (!user.directMessageReadAt || typeof user.directMessageReadAt !== 'object') user.directMessageReadAt = {};
}
function makeFriends(first, second) {
  ensureFriendState(first); ensureFriendState(second);
  const firstId = String(first.id), secondId = String(second.id);
  if (!first.friends.includes(secondId)) first.friends.push(secondId);
  if (!second.friends.includes(firstId)) second.friends.push(firstId);
  first.friendRequestsIn = first.friendRequestsIn.filter((id) => String(id) !== secondId);
  first.friendRequestsOut = first.friendRequestsOut.filter((id) => String(id) !== secondId);
  second.friendRequestsIn = second.friendRequestsIn.filter((id) => String(id) !== firstId);
  second.friendRequestsOut = second.friendRequestsOut.filter((id) => String(id) !== firstId);
}

app.post('/api/friends/request', requireUserFromBody, rejectBannedUser, (req, res) => {
  const user = req.user;
  const targetUid = String(req.body && req.body.targetUid || '').trim();
  const target = users[targetUid];
  if (!target) return res.status(404).json({ error: 'user-not-found' });
  if (targetUid === String(user.id)) return res.status(400).json({ error: 'cannot-friend-self' });
  ensureFriendState(user); ensureFriendState(target);
  if (user.friends.includes(targetUid)) return res.status(409).json({ error: 'already-friends', state: publicState(user) });
  if (user.friendRequestsIn.includes(targetUid)) return res.status(409).json({ error: 'request-received', state: publicState(user) });
  if (user.friendRequestsOut.includes(targetUid)) return res.status(409).json({ error: 'request-already-sent', state: publicState(user) });
  user.friendRequestsOut.push(targetUid);
  target.friendRequestsIn.push(String(user.id));
  persist();
  res.json({ ok: true, state: publicState(user), target: publicState(target) });
});

app.post('/api/friends/cancel', requireUserFromBody, rejectBannedUser, (req, res) => {
  const user = req.user;
  const targetUid = String(req.body && req.body.targetUid || '').trim();
  const target = users[targetUid];
  if (!target) return res.status(404).json({ error: 'user-not-found' });
  ensureFriendState(user); ensureFriendState(target);
  if (!user.friendRequestsOut.includes(targetUid)) return res.status(404).json({ error: 'request-not-found' });
  user.friendRequestsOut = user.friendRequestsOut.filter((id) => String(id) !== targetUid);
  target.friendRequestsIn = target.friendRequestsIn.filter((id) => String(id) !== String(user.id));
  persist();
  res.json({ ok: true, state: publicState(user) });
});

app.post('/api/friends/accept', requireUserFromBody, rejectBannedUser, (req, res) => {
  const user = req.user;
  const requesterUid = String(req.body && req.body.requesterUid || '').trim();
  const requester = users[requesterUid];
  if (!requester) return res.status(404).json({ error: 'user-not-found' });
  ensureFriendState(user); ensureFriendState(requester);
  if (!user.friendRequestsIn.includes(requesterUid)) return res.status(404).json({ error: 'request-not-found' });
  makeFriends(user, requester);
  persist();
  res.json({ ok: true, state: publicState(user), requester: publicState(requester) });
});

app.post('/api/friends/decline', requireUserFromBody, rejectBannedUser, (req, res) => {
  const user = req.user;
  const requesterUid = String(req.body && req.body.requesterUid || '').trim();
  ensureFriendState(user);
  const requester = users[requesterUid];
  if (!requester || !user.friendRequestsIn.includes(requesterUid)) return res.status(404).json({ error: 'request-not-found' });
  ensureFriendState(requester);
  user.friendRequestsIn = user.friendRequestsIn.filter((id) => id !== requesterUid);
  requester.friendRequestsOut = requester.friendRequestsOut.filter((id) => String(id) !== String(user.id));
  persist();
  res.json({ ok: true, state: publicState(user) });
});

app.post('/api/friends/remove', requireUserFromBody, rejectBannedUser, (req, res) => {
  const user = req.user;
  const friendUid = String(req.body && req.body.friendUid || '').trim();
  const friend = users[friendUid];
  if (!friend) return res.status(404).json({ error: 'user-not-found' });
  ensureFriendState(user); ensureFriendState(friend);
  user.friends = user.friends.filter((id) => String(id) !== friendUid);
  friend.friends = friend.friends.filter((id) => String(id) !== String(user.id));
  persist();
  res.json({ ok: true, state: publicState(user) });
});

app.get('/api/friends/dm', requireUserFromQuery, (req, res) => {
  const user = req.user, friendUid = String(req.query.with || '').trim();
  ensureFriendState(user);
  if (!user.friends.includes(friendUid)) return res.status(403).json({ error: 'not-friends' });
  const readThrough = Math.max(0, Number(user.directMessageReadAt[friendUid]) || 0);
  res.json({ readThrough, messages: (user.directMessages[friendUid] || []).slice(-100).map((message) => ({
    ...message,
    read: String(message.fromUid) === String(user.id) || Number(message.ts) <= readThrough,
    chatItems: message.chatItems || {},
  })) });
});

app.post('/api/friends/dm/read', requireUserFromBody, (req, res) => {
  const user = req.user, friendUid = String(req.body && req.body.peerUid || '').trim();
  ensureFriendState(user);
  if (!user.friends.includes(friendUid)) return res.status(403).json({ error: 'not-friends' });
  const throughTs = Math.min(Date.now(), Math.max(0, Number(req.body && req.body.throughTs) || 0));
  if (!throughTs) return res.status(400).json({ error: 'invalid-read-time' });
  user.directMessageReadAt[friendUid] = Math.max(Number(user.directMessageReadAt[friendUid]) || 0, throughTs);
  persist();
  res.json({ ok: true, readThrough: user.directMessageReadAt[friendUid] });
});

app.post('/api/friends/dm', requireUserFromBody, rejectBannedUser, (req, res) => {
  const user = req.user, friendUid = String(req.body && req.body.toUid || '').trim();
  const friend = users[friendUid];
  if (!friend) return res.status(404).json({ error: 'user-not-found' });
  ensureFriendState(user); ensureFriendState(friend);
  if (!user.friends.includes(friendUid) || !friend.friends.includes(String(user.id))) return res.status(403).json({ error: 'not-friends' });
  const text = String(req.body && req.body.text || '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, 500);
  const image = String(req.body && req.body.image || '');
  if (image) {
    const match = image.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match || Buffer.from(match[1], 'base64').length > 48 * 1024) return res.status(400).json({ error: 'invalid-image' });
  }
  if (!text && !image) return res.status(400).json({ error: 'empty-message' });
  const message = {
    id: crypto.randomUUID(), fromUid: String(user.id), toUid: friendUid, text: image ? '' : text,
    ...(image ? { img: image } : {}), ts: Date.now(),
    photoUrl: user.profileImage || user.photoUrl || '',
    chatItems: { ...user.chatItems.eq },
  };
  user.directMessages[friendUid] = [...(user.directMessages[friendUid] || []), message].slice(-100);
  friend.directMessages[String(user.id)] = [...(friend.directMessages[String(user.id)] || []), message].slice(-100);
  persist();
  res.json({ ok: true, message });
});

// ---- Withdrawal history / status polling ----
app.get('/api/withdrawals', requireUserFromQuery, (req, res) => {
  res.json({ withdrawals: req.user.withdrawals.slice(-50) });
});

function withdrawalCurrencyEmoji(currency) {
  const icons = { TON: '💎', TRX: '🔺', USDT: '💵', BTC: '₿' };
  return icons[String(currency || '').toUpperCase()] || '🪙';
}

function telegramHtmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function postWithdrawalSuccessToTelegram(withdrawal) {
  if (!BOT_TOKEN || !WITHDRAWAL_CHANNEL_ID) return false;
  const configuredChatId = String(WITHDRAWAL_CHANNEL_ID).trim();
  const chatId = /^-?\d+$/.test(configuredChatId) ? Number(configuredChatId) : configuredChatId;
  const playGameUrl = new URL(MINI_APP_URL);
  const newsChannelUrl = new URL(NEWS_CHANNEL_URL);
  if (!['http:', 'https:'].includes(playGameUrl.protocol) || !['http:', 'https:'].includes(newsChannelUrl.protocol)) {
    throw new Error('telegram-invalid-inline-button-url');
  }
  const currency = String(withdrawal.currency || 'TON').toUpperCase();
  const amount = Number(withdrawal.amount || 0);
  const usdValue = Number.isFinite(Number(withdrawal.usdValue))
    ? Number(withdrawal.usdValue)
    : currency === 'TON' && TON_USD_RATE > 0 ? amount * TON_USD_RATE : 0;
  const txId = String(withdrawal.txId || withdrawal.txid || withdrawal.hash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(txId)) {
    throw new Error('telegram-withdrawal-full-64-char-hex-txid-required');
  }
  const shortTxId = txId.length > 12 ? txId.slice(0, 6) + '...' + txId.slice(-6) : txId;
  const explorerUrl = new URL(txId, TON_EXPLORER_URL).toString();
  const text = [
    '✅ Zombies Withdrawal Successful!',
    '',
    withdrawalCurrencyEmoji(currency) + ' Amount: ' + amount.toFixed(6) + ' ' + currency,
    '💰 USD Value: $' + usdValue.toFixed(2),
    '🌐 TxID: <a href="' + telegramHtmlEscape(explorerUrl) + '">' + telegramHtmlEscape(shortTxId) + '</a>',
  ].join('\n');
  const response = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '🧟 PLAY GAME 🧟', url: playGameUrl.toString() },
          { text: '📢 News Channel 📢', url: newsChannelUrl.toString() },
        ]],
      },
    }),
  });
  const responseBody = await response.text();
  let result;
  try {
    result = JSON.parse(responseBody);
  } catch (error) {
    console.error('[telegram] sendMessage non-JSON response', {
      httpStatus: response.status,
      body: responseBody,
    });
    throw new Error('telegram-send-message-http-' + response.status + ': non-json-response');
  }
  if (!response.ok || result.ok !== true) {
    console.error('[telegram] sendMessage failed', {
      httpStatus: response.status,
      errorCode: result.error_code,
      description: result.description,
      parameters: result.parameters,
      chatId,
      hasInlineKeyboard: true,
    });
    throw new Error('telegram-send-message-http-' + response.status + ': ' + (result.description || 'unknown-telegram-error'));
  }
  return true;
}

app.get('/api/referrals/status', requireUserFromQuery, (req, res) => {
  res.json({ state: publicState(req.user) });
});

app.post('/api/referrals/claim', requireUserFromBody, (req, res) => {
  const rewardZombies = Number(req.user.referralPendingZombies || 0);
  res.json({ rewardZombies, state: publicState(req.user) });
});

app.post('/api/referrals/exchange', requireUserFromBody, rejectBannedUser, (req, res) => {
  const user = req.user;
  const rewardZombies = Number(user.referralPendingZombies || 0);
  if (rewardZombies <= 0) {
    return res.json({ exchangedZombies: 0, coinsGained: 0, tonGained: 0, state: publicState(user) });
  }
  ensureDailyReset(user);
  const coinsGained = rewardZombies;
  user.coins += coinsGained;
  user.referralPendingZombies = 0;

  // Referral rewards now also pay out TON, at the same base rate and subject
  // to the same daily per-level cap as regular run exchanges, so this can't
  // be used to bypass the daily TON limit.
  const level = Math.max(1, Math.min(5, Number(user.level) || 1));
  const dailyCap = hasActiveLevelReward(user, level) ? dailyTonCapForLevel(level) : 0;
  const levelToday = Number(user.tonTodayByLevel[level] || 0);
  const rawGain = (coinsGained / COINS_PER_BLOCK) * PTS_PER_BLOCK * LEVEL_MULTIPLIER;
  const allowed = Math.max(0, dailyCap - levelToday);
  const tonGained = Math.min(rawGain, allowed);
  user.ton += tonGained;
  user.tonTodayByLevel[level] = levelToday + tonGained;
  user.tonToday = user.tonTodayByLevel[level];

  persist();
  res.json({ exchangedZombies: rewardZombies, coinsGained, tonGained, state: publicState(user) });
});

// ---- Tournament score submission (separate from the coin economy) ----
app.post('/api/submit-score', requireUserFromBody, rejectBannedUser, (req, res) => {
  const user = req.user;
  let { distance, zombies } = req.body || {};
  zombies = Math.max(0, Math.min(MAX_ZOMBIES_PER_CALL, Math.floor(Number(zombies) || 0)));
  distance = Math.max(0, Math.min(MAX_DISTANCE_PER_CALL, Math.floor(Number(distance) || 0)));
  const scoreMultiplier = Math.max(1, Math.min(MAX_TOURNAMENT_SCORE_MULTIPLIER, Number(req.body && req.body.scoreMultiplier) || 1));

  // Anti-cheat: trust only the server's own clock, not anything the client
  // claims about elapsed time. Without a matching /api/run/start beforehand
  // (or if the reported zombie count is not plausible for the elapsed time),
  // the submission gets clamped down instead of blindly accepted.
  const startedAt = Number(user.runStartedAt || 0);
  const rawElapsedMs = startedAt > 0 ? Math.max(0, Date.now() - startedAt) : 0;
  // Cap how much elapsed time counts towards the plausibility budget: waiting
  // idle (without ever really playing) between /api/run/start and this call must
  // not be able to buy an unlimited zombie allowance.
  const elapsedMs = Math.min(rawElapsedMs, MAX_MS_CREDITED_PER_TOURNAMENT_RUN);
  const maxPlausibleZombies = Math.floor((elapsedMs / MIN_MS_PER_TOURNAMENT_ZOMBIE) * scoreMultiplier) + TOURNAMENT_PLAUSIBILITY_BUFFER;
  if (zombies > maxPlausibleZombies) {
    console.warn(`[anti-cheat] submit-score: user ${user.id} reported ${zombies} zombies after ${rawElapsedMs}ms real / ${elapsedMs}ms credited at x${scoreMultiplier} (max plausible ${maxPlausibleZombies}) - clamped`);
    zombies = Math.max(0, maxPlausibleZombies);
  } else if (rawElapsedMs > MAX_MS_CREDITED_PER_TOURNAMENT_RUN) {
    // Not clamped (score was already within the capped budget), but a run
    // lasting this long between start and submit is unusual enough to log.
    console.warn(`[anti-cheat] submit-score: user ${user.id} took ${rawElapsedMs}ms between run/start and submit-score (longer than the ${MAX_MS_CREDITED_PER_TOURNAMENT_RUN}ms credit cap)`);
  }
  user.runStartedAt = 0; // consumed - the next round needs a fresh /api/run/start

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

  const top = ranked.slice(0, 50).map((e) => {
    const user = users[String(e.id)];
    return {
      name: e.name,
      best: e.best,
      isChatAdmin: user && user.isChatAdmin === true,
      adminBadge: user && user.adminBadge === 'girl' ? 'girl' : 'boy',
      isDesigner: user && user.isDesigner === true,
      isSupporter: user && user.isSupporter === true,
      isDeveloper: user && user.isDeveloper === true,
      badge4: user && user.badge4 === true,
      badge5: user && user.badge5 === true,
    };
  });

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

// ---- Invite leaderboard campaign: top inviters win TON ----
app.get('/api/invite-leaderboard', (req, res) => {
  settleInviteLeaderboardIfDue();
  const ranked = Object.values(users)
    .filter((u) => Number(u.campaignInvites || 0) > 0)
    .sort((a, b) => (Number(b.campaignInvites) - Number(a.campaignInvites)) || (Number(a.campaignLastInviteAt || 0) - Number(b.campaignLastInviteAt || 0)));
  const top = ranked.slice(0, 10).map((u, index) => ({
    name: u.name,
    invites: Number(u.campaignInvites),
    reward: INVITE_LEADERBOARD_REWARDS[index] || 0,
  }));

  let you;
  const token = req.query && req.query.token;
  const payload = token ? verifyToken(token) : null;
  if (payload && users[String(payload.uid)]) {
    const uid = String(payload.uid);
    const me = users[uid];
    const invites = Number(me.campaignInvites || 0);
    const rank = ranked.findIndex((e) => String(e.id) === uid) + 1;
    you = { rank: invites > 0 ? (rank || ranked.length + 1) : 0, invites };
  }

  res.json({
    startsAt: INVITE_LEADERBOARD_STARTS_AT,
    endsAt: INVITE_LEADERBOARD_ENDS_AT,
    rewards: INVITE_LEADERBOARD_REWARDS,
    settled: inviteCampaignState.settled,
    winners: inviteCampaignState.winners,
    top,
    you,
  });
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
  const totalTtCredited = all.reduce((s, u) => s + (Number(u.ttCreditedLifetime) || 0), 0);
  res.json({
    storage: { dataDir: DATA_DIR, persistent: STORAGE_PERSISTENT, volumeMountPath: RAILWAY_VOLUME_PATH || null },
    totalUsers: all.length,
    totalCoins: all.reduce((s, u) => s + u.coins, 0),
    totalTon: all.reduce((s, u) => s + u.ton, 0),
    totalRuns: all.reduce((s, u) => s + u.runs, 0),
    ttTotalSupply: TT_TOTAL_SUPPLY,
    ttGivenOut: Number(totalTtCredited.toFixed(6)),
    ttRemaining: Number(Math.max(0, TT_TOTAL_SUPPLY - totalTtCredited).toFixed(6)),
    pendingWithdrawals,
  });
});

app.get('/admin/players', requireAdmin, (req, res) => {
  const all = Object.values(users);
  const players = all.map((user) => ({
    uid: String(user.id),
    name: user.name || ('Player ' + user.id),
    ton: Number(user.ton) || 0,
    ttBalance: Number(user.ttBalance) || 0,
    coins: Number(user.coins) || 0,
    level: Number(user.level) || 1,
    ownedLevels: [1, 2, 3, 4, 5].filter((level) => {
      const skinByLevel = { 1: 'yellow', 2: 'red', 3: 'white', 4: 'green', 5: 'luna' };
      return Array.isArray(user.ownedSkins) && user.ownedSkins.includes(skinByLevel[level]);
    }),
    runs: Number(user.runs) || 0,
    depositCount: Array.isArray(user.depositTxs) ? user.depositTxs.length : 0,
    referralCount: Number(user.referralCount) || 0,
    referralRewardCount: Number(user.referralRewardCount) || 0,
    referralRewardZombies: (Number(user.referralRewardCount) || 0) * 300,
    referralLink: 'https://t.me/TaxiTronBot?start=' + encodeURIComponent(referralCodeFor(user.id)),
    tournamentBest: Number(user.tournamentBest) || 0,
    tournamentWeekKey: user.tournamentWeekKey || '',
    createdAt: Number(user.createdAt) || 0,
    isBanned: user.isBanned === true,
  })).sort((a, b) => b.ton - a.ton);
  // "Given out" is the lifetime sum of every TT ever credited to a player
  // (mining, tasks, wins, admin top-ups, ...) via creditTT() - regardless of
  // whether it's still sitting in their in-game balance or has already been
  // withdrawn on-chain. "Remaining" is simply what's left of the fixed total
  // supply once that lifetime total is subtracted - a rough but honest
  // "how much of the 100M is still available to hand out" figure, not a
  // live on-chain number (see /admin/tt-treasury-status for the treasury
  // wallet's actual on-chain TT balance).
  const ttGivenOut = all.reduce((sum, user) => sum + (Number(user.ttCreditedLifetime) || 0), 0);
  res.json({
    totalUsers: players.length,
    depositUsers: players.filter((player) => player.depositCount > 0).length,
    totalTon: players.reduce((sum, player) => sum + player.ton, 0),
    totalReferrals: players.reduce((sum, player) => sum + player.referralCount, 0),
    totalReferralRewards: players.reduce((sum, player) => sum + player.referralRewardCount, 0),
    totalReferralRewardZombies: players.reduce((sum, player) => sum + player.referralRewardZombies, 0),
    currentTournamentWeek: berlinWeekKey(),
    ttTotalSupply: TT_TOTAL_SUPPLY,
    ttGivenOut: Number(ttGivenOut.toFixed(6)),
    ttRemaining: Number(Math.max(0, TT_TOTAL_SUPPLY - ttGivenOut).toFixed(6)),
    players,
  });
});

// Read-only diagnostic for the weekly tournament leaderboard: shows each
// player's raw stored tournamentBest/tournamentWeekKey next to the
// "effective" value /api/leaderboard would actually use (0 once their
// stored week no longer matches the current one), so a "leaderboard looks
// frozen" report can be confirmed or ruled out directly from real data.
app.get('/admin/tournament-debug', requireAdmin, (req, res) => {
  const week = berlinWeekKey();
  const entries = Object.values(users)
    .map((u) => ({
      uid: String(u.id),
      name: u.name || ('Player ' + u.id),
      tournamentBest: Number(u.tournamentBest) || 0,
      tournamentWeekKey: u.tournamentWeekKey || '',
      effectiveBest: u.tournamentWeekKey === week ? (Number(u.tournamentBest) || 0) : 0,
    }))
    .filter((e) => e.tournamentBest > 0)
    .sort((a, b) => b.tournamentBest - a.tournamentBest)
    .slice(0, 30);
  res.json({ currentWeek: week, now: new Date().toISOString(), entries });
});

// Manual "start this week's race over" button: zeroes out every player's
// tournamentBest/tournamentDistance right now (stamped with the current
// week), independent of the normal Sunday-00:00-Berlin schedule. Only
// touches the weekly tournament fields - coins/TON/TT/everything else is
// untouched.
app.post('/admin/tournament-debug/reset-now', requireAdmin, (req, res) => {
  const week = berlinWeekKey();
  let count = 0;
  Object.values(users).forEach((u) => {
    if (Number(u.tournamentBest) > 0 || u.tournamentWeekKey) count += 1;
    u.tournamentBest = 0;
    u.tournamentDistance = 0;
    u.tournamentWeekKey = week;
  });
  persist();
  console.log('[admin] manually reset the weekly tournament leaderboard for ' + count + ' player(s) with prior scores (week=' + week + ')');
  res.json({ ok: true, week, resetCount: count });
});

app.get('/admin/chat-users', requireAdmin, (req, res) => {
  const query = String(req.query.query || '').trim().toLowerCase();
  const all = Object.values(users);
  const matches = query
    ? all.filter((u) => String(u.id).toLowerCase().includes(query) || (u.name || '').toLowerCase().includes(query))
    : all.slice().sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0));
  const list = matches.slice(0, 30).map((u) => ({
    uid: String(u.id),
    name: u.name || ('Player ' + u.id),
    isChatAdmin: u.isChatAdmin === true,
    adminBadge: u.adminBadge === 'girl' ? 'girl' : 'boy',
    isDesigner: u.isDesigner === true,
    isSupporter: u.isSupporter === true,
    isDeveloper: u.isDeveloper === true,
    badge4: u.badge4 === true,
    badge5: u.badge5 === true,
    chatMuted: u.chatMuted === true,
    lastSeenAt: Number(u.lastSeenAt || 0),
  }));
  res.json({ users: list, chatEnabled, cardEventEnabled });
});

app.post('/admin/chat/set-enabled', requireAdmin, (req, res) => {
  chatEnabled = req.body.enabled === true;
  persistChatSettings();
  res.json({ ok: true, chatEnabled });
  broadcastChatEvent('settings', { chatEnabled });
});

// Toggle the recurring "card event" chance game (Farsi chat room) on/off. When
// turning off, any already-scheduled next occurrence is cancelled immediately;
// an event already in progress still finishes out normally.
app.post('/admin/card-event/set-enabled', requireAdmin, (req, res) => {
  cardEventEnabled = req.body.enabled === true;
  persistCardEventSettings();
  if (!cardEventEnabled) {
    if (cardEventStartTimer) { clearTimeout(cardEventStartTimer); cardEventStartTimer = null; }
    cardEventNextStartAt = 0;
  } else if (!isCardEventActive()) {
    scheduleNextCardEvent();
  }
  res.json({ ok: true, cardEventEnabled });
});

app.post('/admin/chat/set-admin', requireAdmin, (req, res) => {
  const uid = String((req.body && req.body.uid) || '');
  const user = users[uid];
  if (!user) return res.status(404).json({ error: 'user-not-found' });
  user.isChatAdmin = req.body.isChatAdmin === true;
  if (user.isChatAdmin && req.body.adminBadge !== undefined) {
    if (req.body.adminBadge !== 'boy' && req.body.adminBadge !== 'girl') {
      return res.status(400).json({ error: 'invalid-admin-badge' });
    }
    user.adminBadge = req.body.adminBadge;
  }
  if (!user.isChatAdmin) user.adminBadge = 'boy';
  persist();
  res.json({ ok: true, uid, isChatAdmin: user.isChatAdmin, adminBadge: user.adminBadge });
  broadcastChatEvent('moderation', { uid, isChatAdmin: user.isChatAdmin, adminBadge: user.adminBadge });
});

app.post('/admin/chat/set-designer', requireAdmin, (req, res) => {
  const uid = String((req.body && req.body.uid) || '');
  const user = users[uid];
  if (!user) return res.status(404).json({ error: 'user-not-found' });
  user.isDesigner = req.body.isDesigner === true;
  persist();
  res.json({ ok: true, uid, isDesigner: user.isDesigner });
});

// Supporter: a second staff role with the exact same chat-moderation/override
// powers as Chat-Admin (see isAdminOrSupporter/canModerateChat), just under a
// different badge/label so both roles can be handed out independently.
app.post('/admin/chat/set-supporter', requireAdmin, (req, res) => {
  const uid = String((req.body && req.body.uid) || '');
  const user = users[uid];
  if (!user) return res.status(404).json({ error: 'user-not-found' });
  user.isSupporter = req.body.isSupporter === true;
  persist();
  res.json({ ok: true, uid, isSupporter: user.isSupporter });
  broadcastChatEvent('moderation', { uid, isSupporter: user.isSupporter });
});

// Developer badge ("Amir"): another full admin-equivalent role (see
// isAdminOrSupporter/canModerateChat), just a separate flag/badge image.
app.post('/admin/chat/set-developer', requireAdmin, (req, res) => {
  const uid = String((req.body && req.body.uid) || '');
  const user = users[uid];
  if (!user) return res.status(404).json({ error: 'user-not-found' });
  user.isDeveloper = req.body.isDeveloper === true;
  persist();
  res.json({ ok: true, uid, isDeveloper: user.isDeveloper });
  broadcastChatEvent('moderation', { uid, isDeveloper: user.isDeveloper });
});

app.post('/admin/chat/set-badge4', requireAdmin, (req, res) => {
  const uid = String(req.body && req.body.uid || '');
  const user = users[uid];
  if (!user) return res.status(404).json({ error: 'user-not-found' });
  user.badge4 = req.body.badge4 === true;
  persist();
  res.json({ ok: true, uid, badge4: user.badge4 });
  broadcastChatEvent('moderation', { uid, badge4: user.badge4 });
});

app.post('/admin/chat/set-badge5', requireAdmin, (req, res) => {
  const uid = String(req.body && req.body.uid || '');
  const user = users[uid];
  if (!user) return res.status(404).json({ error: 'user-not-found' });
  user.badge5 = req.body.badge5 === true;
  persist();
  res.json({ ok: true, uid, badge5: user.badge5 });
  broadcastChatEvent('moderation', { uid, badge5: user.badge5 });
});

app.post('/admin/chat/set-mute', requireAdmin, (req, res) => {
  const uid = String((req.body && req.body.uid) || '');
  const user = users[uid];
  if (!user) return res.status(404).json({ error: 'user-not-found' });
  user.chatMuted = req.body.muted === true;
  persist();
  res.json({ ok: true, uid, chatMuted: user.chatMuted });
  broadcastChatEvent('moderation', { uid, chatMuted: user.chatMuted });
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

// ---- TT jetton withdrawal admin views ----
app.get('/admin/tt-withdrawals', requireAdmin, (req, res) => {
  const statusFilter = req.query.status;
  const out = [];
  Object.values(users).forEach((u) => (u.ttWithdrawals || []).forEach((w) => {
    if (!statusFilter || w.status === statusFilter) out.push({ uid: u.id, name: u.name, ...w });
  }));
  out.sort((a, b) => b.ts - a.ts);
  res.json({ withdrawals: out });
});

app.get('/admin/tt-treasury-status', requireAdmin, async (req, res) => {
  const ready = treasury.isReady();
  let tonBalance = 0;
  let ttBalance = 0;
  if (ready) {
    try {
      [tonBalance, ttBalance] = await Promise.all([treasury.getTonBalance(), treasury.getTtBalance(TT_DECIMALS)]);
    } catch (e) {
      // leave at 0 - the "ready" + initError fields already explain chain issues
    }
  }
  res.json({
    ready,
    initError: treasury.getInitError(),
    enabled: TT_WITHDRAW_ENABLED,
    adminOnly: TT_WITHDRAW_ADMIN_ONLY,
    allowlist: [...TT_WITHDRAW_ALLOWLIST],
    address: treasury.getTreasuryAddress(),
    jettonWalletAddress: treasury.getTreasuryJettonWalletAddress(),
    tonBalance,
    ttBalance,
    minTonReserve: TT_MIN_TREASURY_TON_RESERVE,
    gasTonPerSend: TT_WITHDRAW_GAS_TON,
    dailyLimitTT: TT_GLOBAL_DAILY_LIMIT,
    usedTodayTT: ttWithdrawnTodayTotal(),
    minWithdrawTT: TT_MIN_WITHDRAW,
  });
});

// Manual resolution for withdrawals stuck in 'needs-review' (e.g. after a
// server restart mid-send, or an unconfirmed on-chain result). ALWAYS verify
// on Tonviewer/tonscan first - 'complete' records it as paid (no refund);
// 'refund' credits the TT back to the player (only safe if nothing was ever
// actually sent on-chain).
app.post('/admin/tt-withdrawals/resolve', requireAdmin, (req, res) => {
  const uid = String(req.body && req.body.uid || '');
  const ts = Number(req.body && req.body.ts);
  const action = String(req.body && req.body.action || '');
  const txId = String(req.body && req.body.txId || '').trim().slice(0, 200);
  const user = users[uid];
  if (!user) return res.status(404).json({ error: 'unknown-user' });
  const withdrawal = (user.ttWithdrawals || []).find((w) => Number(w.ts) === ts);
  if (!withdrawal) return res.status(404).json({ error: 'unknown-tt-withdrawal' });
  if (withdrawal.status !== 'needs-review') return res.status(409).json({ error: 'tt-withdrawal-not-in-review' });
  if (action === 'complete') {
    withdrawal.status = 'completed';
    withdrawal.completedAt = Date.now();
    withdrawal.manuallyResolvedTxId = txId || undefined;
    user.ttWithdrawnLifetime = Number((Number(user.ttWithdrawnLifetime || 0) + withdrawal.amount).toFixed(6));
  } else if (action === 'refund') {
    withdrawal.status = 'failed';
    withdrawal.failReason = 'manually-refunded-by-admin';
    user.ttBalance = Number((Number(user.ttBalance || 0) + withdrawal.amount).toFixed(6));
  } else {
    return res.status(400).json({ error: 'invalid-action' });
  }
  persist();
  console.log('[admin] resolved TT withdrawal uid=' + uid + ' ts=' + ts + ' action=' + action);
  res.json({ ok: true, withdrawal: publicTtWithdrawal(withdrawal) });
});

// Admin on/off switch for TT Shop payouts (see /api/tt-shop/order, which
// rejects with 'tt-shop-disabled' while this is off). Does NOT affect the
// real Wallet TON withdrawal (/api/withdraw).
app.get('/admin/tt-shop/settings', requireAdmin, (req, res) => {
  res.json({ ttShopEnabled });
});
app.post('/admin/tt-shop/set-enabled', requireAdmin, (req, res) => {
  ttShopEnabled = req.body && req.body.enabled === true;
  persistTtShopSettings();
  res.json({ ok: true, ttShopEnabled });
});

app.get('/admin/deposits', requireAdmin, (req, res) => {
  const out = [];
  Object.values(users).forEach((u) => (u.deposits || []).forEach((d) => {
    out.push({ uid: u.id, name: u.name, ...d });
  }));
  out.sort((a, b) => b.ts - a.ts);
  out.length = Math.min(out.length, 100);
  res.json({ deposits: out });
});

app.get('/admin/purchases', requireAdmin, (req, res) => {
  const out = [];
  Object.values(users).forEach((u) => (u.purchases || []).forEach((p) => {
    out.push({ uid: u.id, name: u.name, ...p });
  }));
  out.sort((a, b) => b.ts - a.ts);
  out.length = Math.min(out.length, 100);
  res.json({ purchases: out });
});

app.get('/admin/tt-orders', requireAdmin, (req, res) => {
  const status = String(req.query.status || '');
  const orders = [];
  Object.values(users).forEach((user) => (user.ttOrders || []).forEach((order) => {
    if (!status || order.status === status) orders.push({ uid: user.id, name: user.name, ...order });
  }));
  orders.sort((a, b) => b.ts - a.ts);
  res.json({ orders: orders.slice(0, 200) });
});

app.post('/admin/tt-orders/complete', requireAdmin, (req, res) => {
  const uid = String(req.body && req.body.uid || '');
  const ts = Number(req.body && req.body.ts);
  const txId = String(req.body && req.body.txId || '').trim();
  const user = users[uid];
  if (!user) return res.status(404).json({ error: 'unknown-user' });
  const order = (user.ttOrders || []).find((item) => Number(item.ts) === ts);
  if (!order) return res.status(404).json({ error: 'unknown-tt-order' });
  if (order.status !== 'pending') return res.status(409).json({ error: 'tt-order-already-resolved' });
  if (!txId || txId.length > 200) return res.status(400).json({ error: 'invalid-transaction-id' });
  order.status = 'completed';
  order.txId = txId;
  order.completedAt = Date.now();
  persist();
  res.json({ ok: true, order });
});

app.post('/admin/tt-orders/reject', requireAdmin, (req, res) => {
  const uid = String(req.body && req.body.uid || '');
  const ts = Number(req.body && req.body.ts);
  const reason = String(req.body && req.body.reason || '').trim().slice(0, 200);
  const user = users[uid];
  if (!user) return res.status(404).json({ error: 'unknown-user' });
  const order = (user.ttOrders || []).find((item) => Number(item.ts) === ts);
  if (!order) return res.status(404).json({ error: 'unknown-tt-order' });
  if (order.status !== 'pending') return res.status(409).json({ error: 'tt-order-already-resolved' });
  creditTT(user, Number(order.tt || 0), 'tt-shop-order-rejected-refund');
  order.status = 'rejected';
  order.reason = reason;
  order.rejectedAt = Date.now();
  persist();
  res.json({ ok: true, order, state: publicState(user) });
});

app.post('/admin/withdrawals/complete', requireAdmin, (req, res) => {
  const { uid, ts, txId, currency, usdValue } = req.body || {};
  const normalizedTxId = String(txId || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedTxId)) {
    return res.status(400).json({ error: 'full-64-character-hex-ton-transaction-hash-required' });
  }
  const user = users[String(uid)];
  if (!user) return res.status(404).json({ error: 'unknown-user' });
  const w = user.withdrawals.find((w) => w.ts === ts);
  if (!w) return res.status(404).json({ error: 'unknown-withdrawal' });
  if (w.status !== 'pending') return res.status(409).json({ error: 'withdrawal-already-resolved' });
  w.status = 'completed';
  w.currency = String(currency || w.currency || 'TON').toUpperCase();
  w.txId = normalizedTxId;
  if (usdValue !== undefined && Number.isFinite(Number(usdValue))) w.usdValue = Number(usdValue);
  persist();
  postWithdrawalSuccessToTelegram(w).catch((error) => {
    console.error('[telegram] withdrawal announcement failed: ' + error.message);
  });
  res.json({ ok: true, withdrawal: w, announcementQueued: !!BOT_TOKEN });
});

app.post('/admin/withdrawals/reject', requireAdmin, (req, res) => {
  const { uid, ts } = req.body || {};
  const user = users[String(uid)];
  if (!user) return res.status(404).json({ error: 'unknown-user' });
  const withdrawal = user.withdrawals.find((item) => item.ts === ts);
  if (!withdrawal) return res.status(404).json({ error: 'unknown-withdrawal' });
  if (withdrawal.status !== 'pending') return res.status(409).json({ error: 'withdrawal-already-resolved' });
  withdrawal.status = 'rejected';
  withdrawal.rejectionReason = 'fraud';
  withdrawal.rejectedAt = Date.now();
  persist();
  res.json({ ok: true, withdrawal });
});

app.post('/admin/withdrawals/restore', requireAdmin, (req, res) => {
  const { uid, ts } = req.body || {};
  const user = users[String(uid)];
  if (!user) return res.status(404).json({ error: 'unknown-user' });
  const withdrawal = user.withdrawals.find((item) => item.ts === ts);
  if (!withdrawal) return res.status(404).json({ error: 'unknown-withdrawal' });
  if (withdrawal.status !== 'rejected') return res.status(409).json({ error: 'withdrawal-is-not-rejected' });
  withdrawal.status = 'pending';
  delete withdrawal.rejectionReason;
  delete withdrawal.rejectedAt;
  persist();
  res.json({ ok: true, withdrawal });
});

// Read-only: lets support quickly check whether a user's daily zombie/TON
// cap has actually rolled over for "today" (Europe/Berlin) or is still
// showing yesterday's numbers (see ensureDailyReset()/berlinDayKey()). Does
// NOT call ensureDailyReset() itself - that would force the rollover just by
// looking, masking whether it had genuinely already happened on its own.
app.get('/admin/users/:uid/daily-status', requireAdmin, (req, res) => {
  const user = users[String(req.params.uid)];
  if (!user) return res.status(404).json({ error: 'unknown-user' });
  const today = berlinDayKey();
  res.json({
    uid: user.id,
    name: user.name,
    serverTodayBerlin: today,
    userTonDate: user.tonDate,
    isResetForToday: user.tonDate === today,
    tonTodayByLevel: user.tonTodayByLevel,
    zombiesTodayByLevel: user.zombiesTodayByLevel,
    attemptsByLevel: user.attemptsByLevel,
    ton: user.ton,
    runs: user.runs,
    ownedSkins: user.ownedSkins,
    skinRewards: user.skinRewards,
    level: user.level,
    lastRunAt: user.lastRunAt ? new Date(user.lastRunAt).toISOString() : null,
    lastSeenAt: user.lastSeenAt ? new Date(user.lastSeenAt).toISOString() : null,
  });
});

app.post('/admin/users/:uid/reset-attempts', requireAdmin, (req, res) => {
  const user = users[String(req.params.uid)];
  if (!user) return res.status(404).json({ error: 'unknown-user' });
  user.attemptsLeft = ATTEMPT_LIMIT_LEVEL_ONE;
  user.attemptsResetAt = null;
  user.attemptsByLevel = {};
  [1, 2, 3, 4, 5].forEach((level) => ensureAttemptState(user, level));
  user.attemptResetVersion = Date.now();
  persist();
  res.json({ ok: true, uid: user.id, attemptsByLevel: publicAttemptsByLevel(user), attemptResetVersion: user.attemptResetVersion });
});

app.post('/admin/users/:uid/set-tournament-best', requireAdmin, (req, res) => {
  const user = users[String(req.params.uid)];
  if (!user) return res.status(404).json({ error: 'unknown-user' });
  const best = Math.max(0, Math.floor(Number(req.body && req.body.best) || 0));
  const distance = req.body && req.body.distance !== undefined
    ? Math.max(0, Math.floor(Number(req.body.distance) || 0))
    : user.tournamentDistance;
  ensureTournamentReset(user);
  user.tournamentBest = best;
  user.tournamentDistance = distance;
  persist();
  res.json({ ok: true, uid: user.id, tournamentBest: user.tournamentBest, tournamentDistance: user.tournamentDistance });
});

app.post('/admin/users/:uid/set-banned', requireAdmin, (req, res) => {
  const user = users[String(req.params.uid)];
  if (!user) return res.status(404).json({ error: 'unknown-user' });
  user.isBanned = req.body && req.body.banned === true;
  if (user.isBanned) user.runStartedAt = 0;
  persist();
  res.json({ ok: true, uid: user.id, isBanned: user.isBanned });
});

app.post('/admin/users/:uid/set-level', requireAdmin, (req, res) => {
  const uid = String(req.params.uid);
  const user = users[uid];
  if (!user) return res.status(404).json({ error: 'unknown-user' });
  const level = Number(req.body && req.body.level);
  const owned = req.body && req.body.owned === true;
  const skinsByLevel = { 1: 'yellow', 2: 'red', 3: 'white', 4: 'green', 5: 'luna' };
  const skin = skinsByLevel[level];
  if (!skin || !Number.isInteger(level) || level < 1 || level > 5) {
    return res.status(400).json({ error: 'invalid-level' });
  }
  if (!Array.isArray(user.ownedSkins)) user.ownedSkins = ['yellow'];
  const before = {
    level: Number(user.level) || 1,
    ownedSkins: user.ownedSkins.slice(),
  };
  if (owned) {
    if (!user.ownedSkins.includes(skin)) user.ownedSkins.push(skin);
    if (level >= 2) {
      if (!user.skinRewards || typeof user.skinRewards !== 'object') user.skinRewards = {};
      user.skinRewards[skin] = {
        remainingDays: 30,
        expiresAt: Date.now() + 30 * 86400000,
        lastCreditDate: berlinDayKey(),
        lastEarnedDate: '',
      };
    }
  } else {
    if (level === 1) return res.status(400).json({ error: 'level-one-cannot-be-removed' });
    user.ownedSkins = user.ownedSkins.filter((ownedSkin) => ownedSkin !== skin);
    if (user.skinRewards && typeof user.skinRewards === 'object') delete user.skinRewards[skin];
  }
  const ownedLevels = [1, 2, 3, 4, 5].filter((candidate) => user.ownedSkins.includes(skinsByLevel[candidate]));
  user.level = Math.max(...ownedLevels);
  user.adminCorrections = Array.isArray(user.adminCorrections) ? user.adminCorrections : [];
  user.adminCorrections.push({
    type: owned ? 'admin-grant-level' : 'admin-remove-level',
    level,
    ts: Date.now(),
    before,
    after: { level: user.level, ownedSkins: user.ownedSkins.slice() },
  });
  persist();
  res.json({
    ok: true,
    uid: user.id,
    level: user.level,
    ownedLevels,
    owned,
  });
});

// Lets an admin manually correct a user's TON balance (e.g. to undo a double-credited
// deposit) by a positive or negative delta. Clamped at 0 so a mistaken large deduction
// can't push the balance negative.
app.post('/admin/users/:uid/set-campaign-invites', requireAdmin, (req, res) => {
  const user = users[String(req.params.uid)];
  if (!user) return res.status(404).json({ error: 'unknown-user' });
  const count = Number(req.body && req.body.count);
  if (!Number.isFinite(count) || count < 0) return res.status(400).json({ error: 'invalid-count' });
  const before = Number(user.campaignInvites) || 0;
  user.campaignInvites = Math.floor(count);
  persist();
  console.log('[admin] set campaignInvites for user ' + user.id + ': ' + before + ' -> ' + user.campaignInvites);
  res.json({ ok: true, uid: user.id, campaignInvites: user.campaignInvites });
});

app.post('/admin/users/:uid/adjust-ton', requireAdmin, (req, res) => {
  const user = users[String(req.params.uid)];
  if (!user) return res.status(404).json({ error: 'unknown-user' });
  const delta = Number(req.body && req.body.delta);
  if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: 'invalid-delta' });
  const before = Number(user.ton) || 0;
  user.ton = Math.max(0, before + delta);
  persist();
  console.log('[admin] adjusted TON for user ' + user.id + ': ' + before + ' -> ' + user.ton + ' (delta ' + delta + ')');
  res.json({ ok: true, uid: user.id, ton: user.ton });
});

app.post('/admin/users/:uid/adjust-tt', requireAdmin, (req, res) => {
  const user = users[String(req.params.uid)];
  if (!user) return res.status(404).json({ error: 'unknown-user' });
  const delta = Number(req.body && req.body.delta);
  if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: 'invalid-delta' });
  const before = Number(user.ttBalance) || 0;
  if (delta > 0) {
    creditTT(user, delta, 'admin-adjust-tt');
  } else {
    // Admin corrections that remove TT are assumed to be reversing TT that
    // should never have been credited in the first place (e.g. an exploit
    // or duplicate-claim bug), so the lifetime-credited total is reduced by
    // the same amount - otherwise the integrity check below would keep
    // treating the removed TT as still "explainable" and withdrawable.
    user.ttBalance = Number(Math.max(0, before + delta).toFixed(6));
    user.ttCreditedLifetime = Number(Math.max(0, Number(user.ttCreditedLifetime || 0) + delta).toFixed(6));
  }
  user.adminCorrections = Array.isArray(user.adminCorrections) ? user.adminCorrections : [];
  user.adminCorrections.push({ type: 'admin-adjust-tt', ts: Date.now(), before, after: user.ttBalance, requestedDelta: delta });
  persist();
  console.log('[admin] adjusted TT for user ' + user.id + ': ' + before + ' -> ' + user.ttBalance + ' (delta ' + delta + ')');
  res.json({ ok: true, uid: user.id, ttBalance: user.ttBalance });
});

// One-time-safe correction for the duplicate deposit case: restore Level 1
// while preserving deposits and purchase history, and set the exact TON balance.
app.post('/admin/users/:uid/correct-duplicate-deposit', requireAdmin, (req, res) => {
  const uid = String(req.params.uid);
  const user = users[uid];
  if (!user) return res.status(404).json({ error: 'unknown-user' });
  if (String(req.body && req.body.confirmUid || '') !== uid) {
    return res.status(400).json({ error: 'confirmation-uid-required' });
  }

  const targetTon = Number(req.body && req.body.targetTon);
  if (!Number.isFinite(targetTon) || targetTon !== 0.5) {
    return res.status(400).json({ error: 'target-ton-must-be-0.5' });
  }

  const before = {
    ton: Number(user.ton) || 0,
    level: Number(user.level) || 1,
    ownedSkins: Array.isArray(user.ownedSkins) ? user.ownedSkins.slice() : [],
  };
  user.ton = 0.5;
  user.level = 1;
  user.ownedSkins = ['yellow'];
  user.tonToday = 0;
  user.tonTodayByLevel = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  user.tonDate = '';
  user.attemptsLeft = ATTEMPT_LIMIT_LEVEL_ONE;
  user.attemptsResetAt = null;
  user.attemptsByLevel = {};
  user.attemptResetVersion = Date.now();
  user.adminCorrections = Array.isArray(user.adminCorrections) ? user.adminCorrections : [];
  user.adminCorrections.push({
    type: 'duplicate-deposit-level-rollback',
    ts: Date.now(),
    before,
    after: { ton: user.ton, level: user.level, ownedSkins: user.ownedSkins.slice() },
  });
  persist();
  console.log('[admin] duplicate-deposit correction for user ' + user.id + ': TON ' + before.ton + ' -> 0.5, level ' + before.level + ' -> 1');
  res.json({
    ok: true,
    uid: user.id,
    ton: user.ton,
    level: user.level,
    ownedSkins: user.ownedSkins,
    depositsPreserved: true,
    purchasesPreserved: true,
  });
});

app.post('/admin/reset-users', requireAdmin, async (req, res) => {
  const resetUsers = Object.values(users);
  rpsGames = {};
  resetUsers.forEach((user) => {
    const depositTxs = Array.isArray(user.depositTxs) ? user.depositTxs.slice() : [];
    user.coins = 0;
    user.ton = 0;
    user.tonToday = 0;
    user.tonTodayByLevel = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    user.tonDate = '';
    user.best = 0;
    user.runs = 0;
    user.level = 1;
    user.ownedSkins = ['yellow'];
    user.attemptsLeft = 10;
    user.attemptsResetAt = null;
    user.attemptsByLevel = {};
    user.attemptResetVersion = Date.now();
    user.skinRewards = {};
    user.tournamentBest = 0;
    user.tournamentDistance = 0;
    user.tournamentWeekKey = '';
    user.withdrawals = [];
    user.lastWithdrawalDay = '';
    user.lastWithdrawalAt = 0;
    user.taskChannelRewardClaimed = false;
    user.withdrawChannelTaskRewardClaimed = false;
    user.thirdChannelTaskRewardClaimed = false;
    user.depositTxs = depositTxs;
  });

  await persist();
  persistRpsGames();
  try {
    const temp = BACKUP_FILE + '.reset.tmp';
    fs.writeFileSync(temp, JSON.stringify(users));
    fs.renameSync(temp, BACKUP_FILE);
  } catch (e) {
    return res.status(500).json({ error: 'backup-write-failed' });
  }
  res.json({ ok: true, count: resetUsers.length });
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
// Safety net: without this, a single unexpected error anywhere (e.g. in a
// background timer like the Taxi Race scheduler) would crash the entire
// process by default, taking down chat/withdrawals/everything else with it.
// Logging and continuing is far safer for a long-running server than dying.
process.on('uncaughtException', (error) => {
  console.error('[fatal] uncaught exception (server kept running): ' + (error && error.stack || error));
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled promise rejection (server kept running): ' + (reason && reason.stack || reason));
});

// ---------------------------------------------------------------
// Monster Crash: multiplayer arena mini-game, mounted on the same
// Express app/HTTP server (WebSocket at /mc, static files at
// /monster-crash). Stakes/payouts run through the same TON balance
// as the rest of TaxiTron (users[uid].ton, in whole TON, converted
// to/from nanoTON for the monster-crash module).
// ---------------------------------------------------------------
function tonToNano(ton) { return Math.round(Number(ton || 0) * 1e9); }
function nanoToTon(nano) { return Number(nano || 0) / 1e9; }

function verifyMonsterCrashUser(initData) {
  if (typeof initData === 'string' && initData.indexOf('test:') === 0 && !ON_RAILWAY) {
    const parts = initData.split(':');
    const id = String(parts[1] || 'test');
    const name = parts[2] || ('Test ' + id);
    if (!users[id]) { users[id] = newUser(id, name); persist(); }
    if (users[id].isBanned === true) return null;
    return { id, name: users[id].name || name };
  }
  const result = verifyInitData(initData);
  if (!result.ok) return null;
  const id = String(result.id);
  if (!users[id]) { users[id] = newUser(id, result.name); persist(); }
  if (users[id].isBanned === true) return null;
  return { id, name: users[id].name || result.name };
}

const monsterCrashEconomy = {
  async charge(userId, nano, reason) {
    const user = users[userId];
    if (!user || user.isBanned === true) return false;
    const amount = nanoToTon(nano);
    if (Number(user.ton || 0) < amount - 1e-9) return false;
    user.ton = Number((Number(user.ton || 0) - amount).toFixed(9));
    persist();
    return true;
  },
  async credit(userId, nano, reason) {
    const user = users[userId];
    if (!user) return;
    user.ton = Number((Number(user.ton || 0) + nanoToTon(nano)).toFixed(9));
    persist();
  },
  async creditApp(nano, reason) {
    if (PLATFORM_USER_ID && users[PLATFORM_USER_ID]) {
      const platformUser = users[PLATFORM_USER_ID];
      platformUser.ton = Number((Number(platformUser.ton || 0) + nanoToTon(nano)).toFixed(9));
      persist();
    }
  },
  async getBalance(userId) {
    const user = users[userId];
    return user ? tonToNano(user.ton) : 0;
  },
};

function reconcileTtWithdrawalsOnStartup() {
  let changed = false;
  Object.values(users).forEach((user) => {
    (user.ttWithdrawals || []).forEach((w) => {
      if (w.status === 'pending') {
        changed = true;
        enqueueTtWithdrawal(() => processTtWithdrawal(user, w));
      } else if (w.status === 'processing') {
        changed = true;
        if (w.sendAttempted) {
          // We don't know if the message actually made it onto the chain -
          // never auto-refund here, a human has to check Tonviewer first.
          w.status = 'needs-review';
          w.failReason = 'server-restarted-while-processing';
          void notifyAdminText(
            '⚠️ Server-Neustart während einer TT-Auszahlung.\nUID ' + user.id + ', Betrag ' + w.amount +
            ' TT.\nBitte in /admin manuell prüfen (Tonviewer), bevor etwas zurückgebucht wird.'
          );
        } else {
          w.status = 'failed';
          w.failReason = 'server-restarted-before-send';
          user.ttBalance = Number((Number(user.ttBalance || 0) + w.amount).toFixed(6));
        }
      }
    });
  });
  if (changed) persist();
}

const server = http.createServer(app);
attachMonsterCrash(server, {
  verifyUser: verifyMonsterCrashUser,
  economy: monsterCrashEconomy,
});

server.listen(PORT, () => {
  console.log('TaxiTron server listening on port ' + PORT);
  console.log('[storage] data file: ' + DATA_FILE + ' (' + Object.keys(users).length + ' users loaded)');
  startCardEventScheduler();
  if (TAXI_RACE_ENABLED) {
    startTaxiRaceScheduler();
  } else if (taxiRaceState || taxiRaceNextStartAt) {
    // Event ended: drop any leftover race/countdown from before this was
    // disabled so a restart can't resurrect it in the chat.
    taxiRaceState = null;
    taxiRaceNextStartAt = 0;
    persistTaxiRaceState();
  }
  if (MONSTER_EVENT_ENABLED) {
    startMonsterScheduler();
  } else if (monsterState || monsterNextStartAt) {
    monsterState = null;
    monsterNextStartAt = 0;
    persistMonsterState();
  }
  if (!STORAGE_PERSISTENT) {
    console.error('==================================================================');
    console.error('[storage] WARNING: running on Railway WITHOUT a volume for ' + DATA_DIR);
    console.error('[storage] All coins, TON and tournament data will be LOST on restart.');
    console.error('[storage] Attach a volume to THIS service (mount path /data).');
    console.error('==================================================================');
  }
  if (!BOT_TOKEN) console.warn('WARNING: BOT_TOKEN not set — /api/auth will always fail.');
  startTelegramBot().catch((error) => console.error('[bot] NICHT gestartet: ' + error.message));
  scheduleRandomDraw();
  if (!DEPOSIT_ADDRESS) console.warn('WARNING: DEPOSIT_ADDRESS not set — automatic deposits are disabled.');
  if (!PLATFORM_USER_ID) console.warn('WARNING: PLATFORM_USER_ID not set — RPS platform fees cannot be credited.');
  else {
    console.log('[deposit] automatic scanner enabled every ' + Math.round(DEPOSIT_POLL_MS / 1000) + 's.');
    setTimeout(scanDeposits, 1000);
    setInterval(scanDeposits, DEPOSIT_POLL_MS);
  }
  if (SESSION_SECRET === 'dev-insecure-secret-change-me') console.warn('WARNING: using the default SESSION_SECRET — set a real one in production.');

  treasury.init({
    mnemonic: TREASURY_MNEMONIC,
    treasuryAddress: TREASURY_ADDRESS,
    jettonMaster: TT_JETTON_MASTER,
    tonCenterUrl: TONCENTER_URL,
    tonCenterApiKey: TONCENTER_API_KEY,
  }).then(() => {
    reconcileTtWithdrawalsOnStartup();
    if (!TT_WITHDRAW_ENABLED) {
      console.log('[tt-withdraw] feature flag TT_WITHDRAW_ENABLED is off — TT withdrawals stay disabled regardless of treasury status.');
    } else if (!treasury.isReady()) {
      console.error('[tt-withdraw] TT_WITHDRAW_ENABLED is on but the treasury is NOT ready (' + treasury.getInitError() + ') — withdrawals will be rejected.');
    } else {
      console.log('[tt-withdraw] enabled. admin-only=' + TT_WITHDRAW_ADMIN_ONLY + ' allowlist=[' + [...TT_WITHDRAW_ALLOWLIST].join(',') + ']');
    }
  });
});
