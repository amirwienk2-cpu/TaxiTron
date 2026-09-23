/**
 * TaxiTron economy server
 * ------------------------------------------------------------------
 * Implements exactly the API surface the client (index.html) calls:
 *
 *   POST /api/auth                 { initData }
 *   GET  /api/deposit-info         ?token=
 *   POST /api/run/start            { token, level }
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

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL || 'https://taxitron-production.up.railway.app/telegram/webhook';
const WITHDRAWAL_CHANNEL_ID = process.env.WITHDRAWAL_CHANNEL_ID || '-1004440778638';
const PLAY_GAME_URL = process.env.PLAY_GAME_URL || 'https://t.me/TaxiiTonBot';
const NEWS_CHANNEL_URL = process.env.NEWS_CHANNEL_URL || 'https://t.me/TaxiiTon';
const TON_EXPLORER_URL = process.env.TON_EXPLORER_URL || 'https://tonviewer.com/transaction/';
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://taxitron-production.up.railway.app';
const TELEGRAM_MINI_APP_URL = new URL('/TaxiTon-new/index-new.html?v=2026092405', MINI_APP_URL).toString();
const TON_USD_RATE = Number(process.env.TON_USD_RATE || 0);
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || '').trim();
const PLATFORM_USER_ID = String(process.env.PLATFORM_USER_ID || '');
const DEPOSIT_ADDRESS = process.env.DEPOSIT_ADDRESS || '';
const TONAPI_URL = process.env.TONAPI_URL || 'https://tonapi.io/v2';
const DEPOSIT_POLL_MS = Number(process.env.DEPOSIT_POLL_MS || 30000);
const INVITE_EVENT_ENDS_AT = Date.parse(process.env.INVITE_EVENT_ENDS_AT || '2026-09-19T13:50:22.986Z');
if (!Number.isFinite(INVITE_EVENT_ENDS_AT)) throw new Error('INVITE_EVENT_ENDS_AT must be a valid date');
// ---- "Invite leaderboard" campaign: whoever invites the most new users
// starting from INVITE_LEADERBOARD_STARTS_AT wins TON once the campaign ends.
// Only invites completed inside this window count (existing referralCount
// from before the campaign is untouched).
const INVITE_LEADERBOARD_STARTS_AT = Date.parse(process.env.INVITE_LEADERBOARD_STARTS_AT || '2026-09-19T15:21:53.666Z');
const INVITE_LEADERBOARD_ENDS_AT = Date.parse(process.env.INVITE_LEADERBOARD_ENDS_AT || '2026-09-26T15:21:53.666Z');
if (!Number.isFinite(INVITE_LEADERBOARD_STARTS_AT)) throw new Error('INVITE_LEADERBOARD_STARTS_AT must be a valid date');
if (!Number.isFinite(INVITE_LEADERBOARD_ENDS_AT)) throw new Error('INVITE_LEADERBOARD_ENDS_AT must be a valid date');
const INVITE_LEADERBOARD_REWARDS = [20, 10, 5]; // TON for rank 1 / 2 / 3
const ON_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);
const RAILWAY_VOLUME_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
const DATA_DIR = process.env.DATA_DIR || RAILWAY_VOLUME_PATH || path.join(__dirname, 'data');

if (ON_RAILWAY && SESSION_SECRET === 'dev-insecure-secret-change-me') {
  throw new Error('SESSION_SECRET must be configured in production');
}

function runRandomDraw() {
  const now = Date.now();
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
const COINS_PER_BLOCK = 10000;
const PTS_PER_BLOCK = 0.01;
const LEVEL_MULTIPLIER = 1; // server only ever applies the Level 1 base rate
const DAILY_PTS_CAP = 1; // TON per day at level 1
const LEVEL_TWO_DAILY_PTS_CAP = 0.067;
const LEVEL_THREE_DAILY_PTS_CAP = 0.2;
const LEVEL_FOUR_DAILY_PTS_CAP = 0.66;
const MIN_WITHDRAW = 1; // TON
const WITHDRAWAL_FEE_RATE = 0.01;
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
const CHAT_MAX_STORED = 200; // how many messages are kept on disk/in memory
const CHAT_MAX_LEN = 300; // characters per message
const CHAT_MIN_INTERVAL_MS = 2000; // basic anti-spam: one message per user every 2s

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
let chatNextId = chatMessages.reduce((max, m) => Math.max(max, Number(m.id) || 0), 0) + 1;
const chatLastSentAt = {}; // uid -> timestamp, in-memory only (anti-spam)
const chatEventClients = new Set();

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
try {
  if (fs.existsSync(CHAT_SETTINGS_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(CHAT_SETTINGS_FILE, 'utf8'));
    if (loaded && typeof loaded.enabled === 'boolean') chatEnabled = loaded.enabled;
  }
} catch (e) {
  console.error('[chat] settings file unreadable: ' + e.message);
}
function persistChatSettings() {
  try { fs.writeFileSync(CHAT_SETTINGS_FILE, JSON.stringify({ enabled: chatEnabled })); }
  catch (e) { console.error('[chat] could not write settings: ' + e.message); }
}

// One-time settlement state for the invite leaderboard campaign (payout only
// happens once, tracked outside of any single user so it survives restarts).
let inviteCampaignState = { settled: false, winners: [] };
try {
  if (fs.existsSync(INVITE_CAMPAIGN_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(INVITE_CAMPAIGN_FILE, 'utf8'));
    if (loaded && typeof loaded === 'object') inviteCampaignState = { settled: !!loaded.settled, winners: Array.isArray(loaded.winners) ? loaded.winners : [] };
  }
} catch (e) {
  console.error('[invite-campaign] settings file unreadable: ' + e.message);
}
function persistInviteCampaignState() {
  try { fs.writeFileSync(INVITE_CAMPAIGN_FILE, JSON.stringify(inviteCampaignState)); }
  catch (e) { console.error('[invite-campaign] could not write settings: ' + e.message); }
}


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
    coins: 0,
    ton: 0,
    ttBalance: 0,
    tonToday: 0,
    tonTodayByLevel: { 1: 0, 2: 0, 3: 0, 4: 0 },
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
    referralCount: 0,
    referralRewardCount: 0,
    referralPendingZombies: 0,
    referredBy: null,
    referralRewardClaimed: false,
    inviteRewardsClaimed: {},
    campaignInvites: 0,
    campaignLastInviteAt: 0,
    campaignInviteCounted: false,
    isChatAdmin: false,
    adminBadge: 'boy',
    isDesigner: false,
    badge4: false,
    chatMuted: false,
    isBanned: false,
  };
}

function referralCodeFor(uid) { return 'ref_' + String(uid); }

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
    user.tonTodayByLevel = { 1: 0, 2: 0, 3: 0, 4: 0 };
    const legacyLevel = Math.max(1, Math.min(4, Number(user.level) || 1));
    user.tonTodayByLevel[legacyLevel] = Number(user.tonToday) || 0;
  }
  [1, 2, 3, 4].forEach((level) => {
    const value = Number(user.tonTodayByLevel[level]);
    user.tonTodayByLevel[level] = Number.isFinite(value) ? Math.max(0, value) : 0;
  });
  if (user.tonDate !== today) {
    user.tonDate = today;
    user.tonToday = 0;
    user.tonTodayByLevel = { 1: 0, 2: 0, 3: 0, 4: 0 };
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
  const normalizedLevel = Math.max(1, Math.min(4, Number(level) || 1));
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
  [1, 2, 3, 4].forEach((level) => {
    const state = ensureAttemptState(user, level);
    result[level] = { left: state.left, resetAt: state.resetAt, resetDay: state.resetDay };
  });
  return result;
}
function highestOwnedLevel(user) {
  const owned = Array.isArray(user.ownedSkins) ? user.ownedSkins : ['yellow'];
  return owned.includes('green') ? 4 : owned.includes('white') ? 3 : owned.includes('red') ? 2 : 1;
}
function resolvePlayableLevel(user, requestedLevel) {
  const requested = Math.max(1, Math.min(4, Number(requestedLevel) || highestOwnedLevel(user)));
  const skin = requested >= 4 ? 'green' : requested >= 3 ? 'white' : requested >= 2 ? 'red' : 'yellow';
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
  user.level = ownedSkins.indexOf('green') !== -1 ? 4 : ownedSkins.indexOf('white') !== -1 ? 3 : ownedSkins.indexOf('red') !== -1 ? 2 : 1;
  if (!user.skinRewards || typeof user.skinRewards !== 'object') user.skinRewards = {};
  const rewardDays = { red:30, white:30, green:30 };
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
    coins: user.coins,
    ton: user.ton,
    ttBalance: Number(user.ttBalance || 0),
    tonToday: user.tonToday,
    tonTodayByLevel: user.tonTodayByLevel,
    lastWithdrawalDay: user.lastWithdrawalDay || '',
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
    isChatAdmin: user.isChatAdmin === true,
    adminBadge: user.adminBadge === 'girl' ? 'girl' : 'boy',
    isDesigner: user.isDesigner === true,
    badge4: user.badge4 === true,
    chatMuted: user.chatMuted === true,
    isBanned: user.isBanned === true,
  };
}

function canModerateChat(user) {
  return user && (user.isChatAdmin === true || user.isDesigner === true);
}

function hasWithdrawnToday(user) {
  if (!user) return false;
  const todayKey = berlinDayKey();
  if (user.lastWithdrawalDay === todayKey) return true;
  if (!Array.isArray(user.withdrawals)) return false;
  return user.withdrawals.some((w) => {
    if (!w || !w.ts) return false;
    const d = new Date(Number(w.ts));
    if (Number.isNaN(d.getTime())) return false;
    return berlinDayKey(d) === todayKey;
  });
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
  const player = game.players.find((p) => String(p.id) === String(uid));
  const visiblePicks = {};
  Object.keys(game.picks || {}).forEach((id) => {
    visiblePicks[id] = { round: game.picks[id].round };
    if (String(id) === String(uid)) visiblePicks[id].choice = game.picks[id].choice;
  });
  return {
    id: game.id, status: game.status, stake: ZOMBIE_TOWER_STAKE, pot: 0.02,
    winnerPayout: 0.018, platformFee: 0.002, round: game.round,
    card: game.card, deadline: game.deadline, floors: game.floors, picks: visiblePicks,
    hist: game.hist, last: game.last, sd: !!game.sd, winner: game.winner || null,
    forfeit: game.forfeit || null, ended: game.ended || null,
    players: game.players.map((p) => ({ id: String(p.id), name: p.name })),
    me: player ? { id: String(player.id) } : null,
  };
}
function settleZombieTower(game, winnerId) {
  if (game.status === 'done' || game.status === 'abandoned') return;
  if (!winnerId) {
    game.status = 'abandoned';
    game.ended = Date.now();
    game.result = { refunded: true };
    game.players.forEach((p) => {
      const user = users[String(p.id)];
      if (user) user.ton = Number((Number(user.ton || 0) + ZOMBIE_TOWER_STAKE).toFixed(9));
    });
    return;
  }
  const winner = users[String(winnerId)];
  if (!winner) return;
  winner.ton = Number((Number(winner.ton || 0) + 0.018).toFixed(9));
  const operatorId = PLATFORM_USER_ID || ADMIN_CHAT_ID;
  if (operatorId) {
    const platform = getOrCreateUser(operatorId, 'Platform');
    platform.ton = Number((Number(platform.ton || 0) + 0.002).toFixed(9));
  }
  game.status = 'done';
  game.winner = String(winnerId);
  game.ended = Date.now();
  game.result = { winnerId: String(winnerId), payout: 0.018, platformFee: 0.002, pot: 0.02 };
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
  else if (top.length === 2) game.sd = true;
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
// The public entry point must always be the redesigned shell. The legacy game is
// still available below through /legacy-game.html for the embedded game iframe.
app.get(['/','/index.html'], (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0'
  });
  const query = req.originalUrl.split('?')[1];
  const target = '/TaxiTon-new/index-new.html?v=20260922' + (query ? '&' + query : '');
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
    return res.redirect(302, '/TaxiTon-new/index-new.html?v=20260922');
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.use(express.static(__dirname, {
  index: false,
  setHeaders: (res, filePath) => {
    // Avoid stale cached client code (e.g. Telegram WebView) missing anti-cheat
    // or gameplay fixes after a deploy.
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
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
body{font-family:Segoe UI,Arial,sans-serif;background:#101018;color:#f5f2ff;max-width:1000px;margin:32px auto;padding:0 18px}h1{color:#ffd93d}button,input{padding:10px;border-radius:8px;border:1px solid #3b3850;background:#1c1c2a;color:#fff}button{cursor:pointer;background:#ffd93d;color:#261f00;font-weight:700}.danger{background:#ff5c6c;color:#260b10}.sound-off{background:#3b3850;color:#f5f2ff}.sound-on{background:#3ddc84;color:#062012}.toolbar{display:flex;gap:8px;margin:18px 0;flex-wrap:wrap}.player-search{flex:1;min-width:260px}.search-result-count{align-self:center;color:#aaa3b8;font-size:13px}.status{color:#aaa3b8;margin:12px 0}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:18px 0}.stat{padding:14px;border:1px solid #3b3850;border-radius:8px;background:#181824}.stat b{display:block;font-size:24px;color:#ffd93d}.row{display:grid;grid-template-columns:1.2fr 1fr 1fr 1fr 1fr 1fr 1.4fr 1fr;gap:12px;align-items:center;padding:14px 0;border-bottom:1px solid #302d40}.row.new-withdrawal{background:rgba(61,220,132,0.16);border-left:4px solid #3ddc84;animation:flash-row 1.4s ease-in-out 4}@keyframes flash-row{0%,100%{background:rgba(61,220,132,0.16)}50%{background:rgba(61,220,132,0.38)}}.muted{color:#aaa3b8;font-size:12px}.reset-attempts{background:#3b3850;color:#f5f2ff;font-size:12px;padding:8px}@media(max-width:650px){.stats{grid-template-columns:1fr}.row{grid-template-columns:1fr 1fr}}
.chat-admin-row{display:grid;grid-template-columns:1.2fr .2fr 1fr 1fr 1fr;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid #302d40}.chat-admin-row.is-admin{background:rgba(128,0,240,0.1)}.chat-admin-row.is-designer{box-shadow:inset 4px 0 #ffd93d}.chat-admin-row.is-muted{background:rgba(255,92,108,0.1)}.tag{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;margin-left:6px}.tag.admin{background:#8000f0;color:#fff}.tag.designer{background:#ffd93d;color:#261f00}.tag.muted{background:#ff5c6c;color:#260b10}.small-btn{padding:6px 10px;font-size:12px}.admin-badge-select{padding:6px 8px;font-size:12px;background:#1c1c2a;color:#fff}.level-filter{padding:6px 10px;font-size:12px;background:#1c1c2a;color:#fff}.level-filter.active{background:#ffd93d;color:#261f00}
</style></head><body><h1>TaxiTron Admin</h1><div class="toolbar"><input id="secret" type="password" placeholder="Admin secret"><button id="load">Load players</button><button id="loadWithdrawals">Load withdrawals</button><button id="loadRejectedWithdrawals">Rejected withdrawals</button><button id="loadChatAdmin">Chat-Admin</button><button id="soundToggle" class="sound-off">🔔 Enable sound</button><button id="reset" class="danger">Reset all players</button></div><div id="status" class="status"></div><div id="stats" class="stats"></div><div id="list"></div>
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
async function load(){currentView='players';const s=secret();if(!s){status('ADMIN_SECRET eingeben.');return}status('Spieler werden geladen...');const r=await fetch('/admin/players',{headers:{'x-admin-secret':s}});const d=await r.json();if(!r.ok){status(d.error||'Request failed');return}document.getElementById('stats').innerHTML='<div class="stat"><span>Registrierte Spieler</span><b>'+d.totalUsers+'</b></div><div class="stat"><span>Spieler mit Einzahlung</span><b>'+d.depositUsers+'</b></div><div class="stat"><span>TON gesamt</span><b>'+Number(d.totalTon).toFixed(6)+'</b></div><div class="stat"><span>Einladungen gesamt</span><b>'+d.totalReferrals+'</b></div><div class="stat"><span>Referral-Belohnungen</span><b>'+d.totalReferralRewards+' x 300</b></div><div class="stat"><span>Referral-Zombies</span><b>'+d.totalReferralRewardZombies+'</b></div>';const list=document.getElementById('list');list.innerHTML='<div class="toolbar"><input id="playerSearch" class="player-search" type="search" placeholder="Username oder Telegram-UID suchen..." autocomplete="off"><span id="playerSearchCount" class="search-result-count"></span><button class="level-filter active" data-level="">Alle Level</button><button class="level-filter" data-level="4">Level 4</button><button class="level-filter" data-level="3">Level 3</button><button class="level-filter" data-level="2">Level 2</button><button class="level-filter" data-level="1">Level 1</button></div><div class="row"><b>Spieler</b><b>TON-Guthaben</b><b>Coins</b><b>Level</b><b>Einzahlungen</b><b>Runs</b><b>Referral</b><b>Aktion</b></div>';d.players.slice().sort((a,b)=>b.level-a.level||b.ton-a.ton).forEach(p=>{const row=document.createElement('div');row.className='row player-row';row.dataset.search=(p.name+' '+p.uid).toLocaleLowerCase();row.dataset.levels=(p.ownedLevels||[p.level]).join(',');const joinedAt=p.createdAt?new Intl.DateTimeFormat('de-DE',{dateStyle:'medium',timeStyle:'medium',timeZone:'Europe/Berlin'}).format(new Date(p.createdAt)):'Nicht erfasst';row.innerHTML='<span>'+p.name+(p.isBanned?' <span class="tag muted">GESPERRT</span>':'')+'<br><span class="muted">UID '+p.uid+'</span><br><span class="muted">Beigetreten: '+joinedAt+'</span></span><span>'+Number(p.ton).toFixed(6)+' TON</span><span>'+p.coins+'</span><span>'+p.level+'</span><span>'+p.depositCount+'</span><span>'+p.runs+'</span><span>'+p.referralCount+' eingeladen<br>'+p.referralRewardCount+' Belohnungen · '+p.referralRewardZombies+' Zombies<br>'+p.referralLink+'</span><span></span>';const actionCell=row.lastElementChild;const banBtn=document.createElement('button');banBtn.textContent=p.isBanned?'✅ Entbannen':'⛔ Bannen';banBtn.className=p.isBanned?'reset-attempts':'danger small-btn';banBtn.onclick=async()=>{const action=p.isBanned?'entbannen':'bannen';if(!confirm(p.name+' wirklich '+action+'?'))return;banBtn.disabled=true;try{const rr=await fetch('/admin/users/'+encodeURIComponent(p.uid)+'/set-banned',{method:'POST',headers:{'x-admin-secret':s,'Content-Type':'application/json'},body:JSON.stringify({banned:!p.isBanned})});const dd=await rr.json();if(!rr.ok)throw new Error(dd.error||'Update failed');status(p.name+(dd.isBanned?' wurde gesperrt.':' wurde entsperrt.'));load()}catch(error){status(error.message);banBtn.disabled=false}};actionCell.appendChild(banBtn);const resetBtn=document.createElement('button');resetBtn.textContent='🔄 Reset attempts';resetBtn.className='reset-attempts';resetBtn.onclick=async()=>{if(!confirm('Versuche für '+p.name+' (UID '+p.uid+') auf 15/15 zurücksetzen?'))return;resetBtn.disabled=true;resetBtn.textContent='...';try{const rr=await fetch('/admin/users/'+encodeURIComponent(p.uid)+'/reset-attempts',{method:'POST',headers:{'x-admin-secret':s}});const dd=await rr.json();if(rr.ok){resetBtn.textContent='✓ Reset';status('Versuche für '+p.name+' zurückgesetzt.');setTimeout(()=>{resetBtn.textContent='🔄 Reset attempts';resetBtn.disabled=false},1500)}else{status(dd.error||'Reset failed');resetBtn.textContent='🔄 Reset attempts';resetBtn.disabled=false}}catch(error){status('Reset failed');resetBtn.textContent='🔄 Reset attempts';resetBtn.disabled=false}};actionCell.appendChild(resetBtn);const recordBtn=document.createElement('button');recordBtn.textContent='🏆 Turnier-Rekord ('+p.tournamentBest+')';recordBtn.className='reset-attempts';recordBtn.style.marginLeft='6px';recordBtn.onclick=async()=>{const val=prompt('Neuer Turnier-Rekord (Zombies) für '+p.name+':',p.tournamentBest);if(val===null)return;const best=parseInt(val,10);if(!Number.isFinite(best)||best<0){alert('Ungültiger Wert.');return}recordBtn.disabled=true;recordBtn.textContent='...';try{const rr=await fetch('/admin/users/'+encodeURIComponent(p.uid)+'/set-tournament-best',{method:'POST',headers:{'x-admin-secret':s,'Content-Type':'application/json'},body:JSON.stringify({best})});const dd=await rr.json();if(rr.ok){recordBtn.textContent='🏆 Turnier-Rekord ('+dd.tournamentBest+')';status('Turnier-Rekord für '+p.name+' auf '+dd.tournamentBest+' gesetzt.');recordBtn.disabled=false}else{status(dd.error||'Update failed');recordBtn.textContent='🏆 Turnier-Rekord ('+p.tournamentBest+')';recordBtn.disabled=false}}catch(error){status('Update failed');recordBtn.textContent='🏆 Turnier-Rekord ('+p.tournamentBest+')';recordBtn.disabled=false}};actionCell.appendChild(recordBtn);const adjustTonBtn=document.createElement('button');adjustTonBtn.textContent='💎 TON korrigieren';adjustTonBtn.className='reset-attempts';adjustTonBtn.style.marginLeft='6px';adjustTonBtn.onclick=async()=>{const val=prompt('TON-Änderung für '+p.name+' (z.B. -10.029940 zum Abziehen):');if(val===null)return;const delta=Number(val.replace(',','.'));if(!Number.isFinite(delta)||delta===0){alert('Ungültiger Wert.');return}if(!confirm((delta<0?'Wirklich ':'Wirklich ')+Math.abs(delta).toFixed(6)+' TON '+(delta<0?'von ':'zu ')+p.name+'s Guthaben '+(delta<0?'abziehen':'hinzufügen')+'?'))return;adjustTonBtn.disabled=true;adjustTonBtn.textContent='...';try{const rr=await fetch('/admin/users/'+encodeURIComponent(p.uid)+'/adjust-ton',{method:'POST',headers:{'x-admin-secret':s,'Content-Type':'application/json'},body:JSON.stringify({delta})});const dd=await rr.json();if(!rr.ok)throw new Error(dd.error||'Update failed');status(p.name+'s TON-Guthaben wurde auf '+Number(dd.ton).toFixed(6)+' TON korrigiert.');load()}catch(error){status(error.message);adjustTonBtn.disabled=false;adjustTonBtn.textContent='💎 TON korrigieren'}};actionCell.appendChild(adjustTonBtn);list.appendChild(row)});const search=document.getElementById('playerSearch');const count=document.getElementById('playerSearchCount');let selectedLevel='';const filterPlayers=()=>{const query=search.value.trim().toLocaleLowerCase();let visible=0;list.querySelectorAll('.player-row').forEach(row=>{const matchesSearch=!query||row.dataset.search.includes(query);const matchesLevel=!selectedLevel||row.dataset.levels.split(',').includes(selectedLevel);const match=matchesSearch&&matchesLevel;row.style.display=match?'':'none';if(match)visible++});count.textContent=visible+' von '+d.totalUsers+' Spielern'};search.addEventListener('input',filterPlayers);list.querySelectorAll('.level-filter').forEach(button=>button.addEventListener('click',()=>{selectedLevel=button.dataset.level||'';list.querySelectorAll('.level-filter').forEach(item=>item.classList.toggle('active',item===button));filterPlayers()}));filterPlayers();status(d.totalUsers+' Spieler geladen.')}
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
async function loadRejectedWithdrawals(){currentView='rejectedWithdrawals';const s=secret();if(!s){status('ADMIN_SECRET eingeben.');return}status('Abgelehnte Auszahlungen werden geladen...');const r=await fetch('/admin/withdrawals?status=rejected',{headers:{'x-admin-secret':s}});const d=await r.json();if(!r.ok){status(d.error||'Request failed');return}const list=document.getElementById('list');list.innerHTML=d.withdrawals.length?'':'Keine abgelehnten Auszahlungen.';d.withdrawals.forEach(w=>{const row=document.createElement('div');row.className='row';const gross=Number(w.grossAmount!=null?w.grossAmount:w.amount);row.innerHTML='<span>'+w.name+'<br><span class="muted">UID '+w.uid+'</span></span><span><b>'+gross.toFixed(6)+' TON</b><br><span class="muted">Wegen Betrug abgelehnt</span></span><span>'+w.address+'</span><span class="muted">'+new Date(w.ts).toLocaleString()+'</span><button class="sound-on">↩ Zurückholen</button>';const memo=document.createElement('div');memo.className='muted withdrawal-memo';memo.textContent='Memo: '+(w.memo||'?');row.children[2].appendChild(memo);row.querySelector('button').onclick=async()=>{if(!confirm('Diese Auszahlung wieder als offen markieren?'))return;const rr=await fetch('/admin/withdrawals/restore',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({uid:w.uid,ts:w.ts})});const dd=await rr.json();if(rr.ok){status('Auszahlung wurde zurückgeholt und ist wieder offen.');loadRejectedWithdrawals()}else status(dd.error||'Request failed')};list.appendChild(row)});status(d.withdrawals.length+' abgelehnte Auszahlung(en) geladen.')}
document.getElementById('load').onclick=load;
document.getElementById('loadWithdrawals').onclick=()=>loadWithdrawals();
document.getElementById('loadRejectedWithdrawals').onclick=loadRejectedWithdrawals;
async function loadChatAdmin(){currentView='chatAdmin';const s=secret();if(!s){status('ADMIN_SECRET eingeben.');return}
const list=document.getElementById('list');
list.innerHTML='<div class="toolbar"><button id="chatEnableToggle" class="small-btn">...</button></div><div class="toolbar"><input id="chatUserSearch" type="text" placeholder="UID oder Name suchen..."><button id="chatUserSearchBtn">Suchen</button></div><div id="chatUserList"></div>';
function updateChatToggleBtn(enabled){const btn=document.getElementById('chatEnableToggle');btn.textContent=enabled?'💬 Chat ist AN — jetzt ausschalten':'🚫 Chat ist AUS — jetzt einschalten';btn.className='small-btn'+(enabled?'':' danger')}
document.getElementById('chatEnableToggle').onclick=async()=>{const enabled=document.getElementById('chatEnableToggle').textContent.includes('AN');const rr=await fetch('/admin/chat/set-enabled',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({enabled:!enabled})});if(rr.ok){const dd=await rr.json();updateChatToggleBtn(dd.chatEnabled);status(dd.chatEnabled?'Chat wurde aktiviert.':'Chat wurde fuer normale Nutzer deaktiviert.')}else status((await rr.json()).error||'Request failed')};
async function runSearch(){const q=document.getElementById('chatUserSearch').value;status('Nutzer werden geladen...');const r=await fetch('/admin/chat-users?query='+encodeURIComponent(q),{headers:{'x-admin-secret':s}});const d=await r.json();if(!r.ok){status(d.error||'Request failed');return}
updateChatToggleBtn(d.chatEnabled);
const box=document.getElementById('chatUserList');box.innerHTML=d.users.length?'':'Keine Nutzer gefunden.';
d.users.forEach(u=>{const row=document.createElement('div');row.className='chat-admin-row'+(u.isChatAdmin?' is-admin':'')+(u.isDesigner?' is-designer':'')+(u.chatMuted?' is-muted':'');
const tags=(u.isChatAdmin?'<span class="tag admin">Chat-Admin</span>':'')+(u.isDesigner?'<span class="tag designer">Designer</span>':'')+(u.badge4?'<span class="tag designer">Badge 4</span>':'')+(u.chatMuted?'<span class="tag muted">Gemutet</span>':'');
row.innerHTML='<span>'+u.name+tags+'<br><span class="muted">UID '+u.uid+'</span></span><span></span><span></span><span></span><span></span>';
const adminBtn=document.createElement('button');adminBtn.className='small-btn';adminBtn.textContent=u.isChatAdmin?'Admin speichern':'Zum Chat-Admin machen';
const adminBadgeSelect=document.createElement('select');adminBadgeSelect.className='admin-badge-select';adminBadgeSelect.title='Admin-Badge auswählen';
adminBadgeSelect.innerHTML='<option value="boy">Admin Junge</option><option value="girl">Admin Mädchen</option>';
adminBadgeSelect.value=u.adminBadge==='girl'?'girl':'boy';adminBadgeSelect.disabled=!u.isChatAdmin;
adminBtn.onclick=async()=>{const rr=await fetch('/admin/chat/set-admin',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({uid:u.uid,isChatAdmin:true,adminBadge:adminBadgeSelect.value})});if(rr.ok)runSearch();else status((await rr.json()).error||'Request failed')};
const designerBtn=document.createElement('button');designerBtn.className='small-btn';designerBtn.textContent=u.isDesigner?'Designer entfernen':'Zum Designer machen';
designerBtn.onclick=async()=>{const rr=await fetch('/admin/chat/set-designer',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({uid:u.uid,isDesigner:!u.isDesigner})});if(rr.ok)runSearch();else status((await rr.json()).error||'Request failed')};
const badgeBtn=document.createElement('button');badgeBtn.className='small-btn';badgeBtn.textContent=u.badge4?'Badge 4 entfernen':'Badge 4 geben';
badgeBtn.onclick=async()=>{const rr=await fetch('/admin/chat/set-badge4',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({uid:u.uid,badge4:!u.badge4})});if(rr.ok)runSearch();else status((await rr.json()).error||'Request failed')};
const muteBtn=document.createElement('button');muteBtn.className='small-btn'+(u.chatMuted?'':' danger');muteBtn.textContent=u.chatMuted?'Entmuten':'Muten';
muteBtn.onclick=async()=>{const rr=await fetch('/admin/chat/set-mute',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({uid:u.uid,muted:!u.chatMuted})});if(rr.ok)runSearch();else status((await rr.json()).error||'Request failed')};
row.children[2].appendChild(adminBadgeSelect);row.children[2].appendChild(adminBtn);row.children[3].appendChild(designerBtn);row.children[4].appendChild(badgeBtn);row.children[4].appendChild(muteBtn);box.appendChild(row)});
status(d.users.length+' Nutzer geladen.')}
document.getElementById('chatUserSearchBtn').onclick=runSearch;
document.getElementById('chatUserSearch').addEventListener('keydown',e=>{if(e.key==='Enter')runSearch()});
runSearch();
}
document.getElementById('loadChatAdmin').onclick=loadChatAdmin;
document.getElementById('reset').onclick=async()=>{const s=secret();if(!s){status('Enter the admin secret.');return}if(!confirm("WARNING: This resets all players' coins, TON, level, skins, stats, and withdrawals. Deposits and one-time invite reward claims remain protected. Continue?"))return;status('Resetting all players...');const r=await fetch('/admin/reset-users',{method:'POST',headers:{'x-admin-secret':s}});const d=await r.json();status(r.ok?'Reset complete for '+d.count+' players.':(d.error||'Reset failed'));if(r.ok)load()};
setInterval(()=>{if(secret())loadWithdrawals({silent:true})},15000);
setInterval(()=>{if(secret())pollMoneyEvents()},15000);
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
  if (Number(user.ton || 0) < ZOMBIE_TOWER_STAKE) return res.status(400).json({ error: 'insufficient-funds', state: publicState(user) });
  const existing = Object.values(zombieTowerGames).find((g) => !['done', 'abandoned'].includes(g.status) && g.players.some((p) => String(p.id) === String(user.id)));
  if (existing) return res.json({ state: publicState(user), game: zombieTowerPublic(existing, user.id) });
  const id = crypto.randomUUID();
  user.ton = Number((Number(user.ton || 0) - ZOMBIE_TOWER_STAKE).toFixed(9));
  zombieTowerGames[id] = {
    id, status: 'open', createdAt: Date.now(), players: [{ id: user.id, name: user.name }],
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
  if (Number(user.ton || 0) < ZOMBIE_TOWER_STAKE) return res.status(400).json({ error: 'insufficient-funds', state: publicState(user) });
  user.ton = Number((Number(user.ton || 0) - ZOMBIE_TOWER_STAKE).toFixed(9));
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
const RANDOM_INTERVAL_MS = 15 * 60 * 1000;
const RANDOM_BOT_UID = 'random-bot';
const RANDOM_BOT_NAME = 'ZombieBot';
const RANDOM_PROMO_START_MS = Date.parse('2026-09-22T22:30:00+02:00');
const RANDOM_PROMO_END_MS = RANDOM_PROMO_START_MS + 72 * 60 * 60 * 1000;

function randomPrizeTon(now) {
  return now >= RANDOM_PROMO_START_MS && now < RANDOM_PROMO_END_MS ? 0.2 : 0.001;
}

app.get('/api/online-count', (req, res) => {
  const now = Date.now();
  const count = Object.values(users).filter((user) => now - Number(user.lastSeenAt || 0) < ONLINE_WINDOW_MS).length;
  res.json({ online: count });
});

// Lightweight list of currently online users (name + TON balance) for the Home chat sidebar.
app.get('/api/online-users', (req, res) => {
  const now = Date.now();
  const list = Object.values(users)
    .filter((user) => now - Number(user.lastSeenAt || 0) < ONLINE_WINDOW_MS)
    .sort((a, b) => {
      const adminDiff = (b.isChatAdmin === true ? 1 : 0) - (a.isChatAdmin === true ? 1 : 0);
      if (adminDiff !== 0) return adminDiff;
      const badgeDiff = (b.badge4 === true ? 1 : 0) - (a.badge4 === true ? 1 : 0);
      if (badgeDiff !== 0) return badgeDiff;
      return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
    })
    .slice(0, 100)
    .map((user) => ({
      uid: String(user.id),
      name: user.name || ('Player ' + user.id),
      photoUrl: user.photoUrl || '',
      ton: Number(user.ton || 0),
      isChatAdmin: user.isChatAdmin === true,
      adminBadge: user.adminBadge === 'girl' ? 'girl' : 'boy',
      isDesigner: user.isDesigner === true,
      badge4: user.badge4 === true,
      chatMuted: user.chatMuted === true,
    }));
  res.json({ users: list });
});

// ---- Global chat (shown on Home, under the online-player count) ----
// GET returns messages newer than ?after=<id> (or the last ~50 if omitted), for polling.
app.get('/api/chat/messages', (req, res) => {
  const after = Number(req.query.after) || 0;
  const storedMessages = after > 0 ? chatMessages.filter((m) => m.id > after) : chatMessages.slice(-50);
  const messages = storedMessages.map((message) => {
    const user = users[String(message.uid)];
    return {
      ...message,
      isAdmin: user ? user.isChatAdmin === true : message.isAdmin === true,
      adminBadge: user ? (user.adminBadge === 'girl' ? 'girl' : 'boy') : (message.adminBadge === 'girl' ? 'girl' : 'boy'),
      isDesigner: user ? user.isDesigner === true : message.isDesigner === true,
      badge4: user ? user.badge4 === true : message.badge4 === true,
      chatMuted: user ? user.chatMuted === true : message.chatMuted === true,
    };
  });
  res.json({ messages, enabled: chatEnabled });
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

app.post('/api/chat/send', requireUserFromBody, (req, res) => {
  if (!chatEnabled && req.user.isChatAdmin !== true) return res.status(403).json({ error: 'chat-disabled' });
  if (req.user.chatMuted === true) return res.status(403).json({ error: 'muted' });
  const raw = String((req.body && req.body.text) || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .trim();
  if (!raw) return res.status(400).json({ error: 'empty-message' });
  const lastAt = chatLastSentAt[req.uid] || 0;
  if (Date.now() - lastAt < CHAT_MIN_INTERVAL_MS) return res.status(429).json({ error: 'too-fast' });
  chatLastSentAt[req.uid] = Date.now();
  if (raw.toLowerCase() === '/random') {
    return res.status(403).json({ error: 'random-bot-only' });
  }
  const text = raw.slice(0, CHAT_MAX_LEN);
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
    text,
    ts: Date.now(),
    isAdmin: req.user.isChatAdmin === true,
    isDesigner: req.user.isDesigner === true,
    badge4: req.user.badge4 === true,
    chatMuted: req.user.chatMuted === true,
    replyTo,
  };
  chatMessages.push(message);
  if (chatMessages.length > CHAT_MAX_STORED) chatMessages = chatMessages.slice(-CHAT_MAX_STORED);
  persistChat();
  res.json({ message });
  broadcastChatEvent('message');
});

app.post('/api/chat/delete', requireUserFromBody, (req, res) => {
  if (req.user.isChatAdmin !== true) return res.status(403).json({ error: 'not-a-chat-admin' });
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

// A chat admin can flip the global on/off switch directly from the app (in addition to the /admin panel).
app.post('/api/chat/set-enabled', requireUserFromBody, (req, res) => {
  if (req.user.isChatAdmin !== true) return res.status(403).json({ error: 'not-a-chat-admin' });
  chatEnabled = req.body.enabled === true;
  persistChatSettings();
  res.json({ ok: true, chatEnabled });
  broadcastChatEvent('settings', { chatEnabled });
});

// Chat admins and designers can mute/unmute chat users.
app.post('/api/chat/moderate', requireUserFromBody, (req, res) => {
  if (!canModerateChat(req.user)) return res.status(403).json({ error: 'not-a-chat-moderator' });
  const targetUid = String((req.body && req.body.targetUid) || '');
  if (targetUid === String(req.uid)) return res.status(400).json({ error: 'self-moderation-not-allowed' });
  const target = users[targetUid];
  if (!target) return res.status(404).json({ error: 'user-not-found' });
  target.chatMuted = req.body.muted === true;
  persist();
  res.json({ ok: true, uid: targetUid, chatMuted: target.chatMuted });
  broadcastChatEvent('moderation', { uid: targetUid, chatMuted: target.chatMuted });
});

// ---- Deposit info ----
app.get('/api/deposit-info', requireUserFromQuery, (req, res) => {
  res.json({
    memo: 'TT' + req.uid,
    address: DEPOSIT_ADDRESS || undefined,
  });
});

app.post('/api/buy-skin', requireUserFromBody, (req, res) => {
  const key = String(req.body && req.body.key || '');
  const prices = { red: 1, white: 3, green: 10 };
  const levels = { red: 2, white: 3, green: 4 };
  const price = prices[key];
  if (!price) return res.status(400).json({ error: 'invalid-skin' });
  const user = req.user;
  if (!Array.isArray(user.ownedSkins)) user.ownedSkins = ['yellow'];
  if (user.ownedSkins.indexOf(key) !== -1) return res.status(409).json({ error: 'skin-already-owned' });
  if (user.ton < price) return res.status(400).json({ error: 'insufficient-funds' });
  user.ton -= price;
  user.ownedSkins.push(key);
  user.level = Math.max(user.level || 1, levels[key]);
  if (!user.skinRewards || typeof user.skinRewards !== 'object') user.skinRewards = {};
  user.skinRewards[key] = { remainingDays: 30, expiresAt: Date.now() + 30 * 86400000, lastCreditDate: berlinDayKey(), lastEarnedDate: '' };
  if (!Array.isArray(user.purchases)) user.purchases = [];
  user.purchases.push({ ts: Date.now(), key, price, level: levels[key] });
  if (user.purchases.length > 200) user.purchases = user.purchases.slice(-200);
  persist();
  res.json({ state: publicState(user) });
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
    user.ttBalance = Number((Number(user.ttBalance || 0) + 5).toFixed(6));
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
    user.ttBalance = Number((Number(user.ttBalance || 0) + 5).toFixed(6));
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
    user.ttBalance = Number((Number(user.ttBalance || 0) + 5).toFixed(6));
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
    rewardTT = 50;
    user.ttBalance = Number(user.ttBalance || 0) + rewardTT;
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
    user.ttBalance = Number(user.ttBalance || 0) + 50;
    reward = 0;
    completed = true;
  } else {
    user.adVideosWatched = watched;
  }

  persist();
  return res.status(200).json({ ok: true, rewarded: completed, reward, rewardTT: completed ? 50 : 0, completed, watched: user.adVideosWatched, state: publicState(user) });
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

// ---- Atomically consumes this Telegram account's level-specific attempt and
//      marks the run start for tournament anti-cheat timing. -------------------
app.post('/api/run/start', requireUserFromBody, rejectBannedUser, (req, res) => {
  const level = resolvePlayableLevel(req.user, req.body && req.body.level);
  if (!consumeServerAttempt(req.user, level)) {
    persist();
    return res.status(409).json({ error: 'no-attempts-left', level, state: publicState(req.user) });
  }
  req.user.runStartedAt = Date.now();
  req.user.runStartedLevel = level;
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
  const coinsPerZombie = level >= 4 ? LEVEL_FOUR_COINS_PER_ZOMBIE : level >= 3 ? LEVEL_THREE_COINS_PER_ZOMBIE : level >= 2 ? LEVEL_TWO_COINS_PER_ZOMBIE : COINS_PER_ZOMBIE;
  const dailyCap = level >= 4 ? LEVEL_FOUR_DAILY_PTS_CAP : level >= 3 ? LEVEL_THREE_DAILY_PTS_CAP : level >= 2 ? LEVEL_TWO_DAILY_PTS_CAP : DAILY_PTS_CAP;
  const levelToday = Number(user.tonTodayByLevel[level] || 0);
  if (level >= 2 && levelToday >= dailyCap - 1e-9) {
    persist();
    return res.json({ state: publicState(user), acceptedZombies: 0, error: 'daily-earn-cap-reached', level });
  }
  const coinsGained = zombies * coinsPerZombie;
  user.coins += coinsGained;

  const rawGain = (coinsGained / COINS_PER_BLOCK) * PTS_PER_BLOCK * LEVEL_MULTIPLIER;
  const allowed = Math.max(0, dailyCap - levelToday);
  const gain = Math.min(rawGain, allowed);
  user.ton += gain;
  user.tonTodayByLevel[level] = levelToday + gain;
  user.tonToday = user.tonTodayByLevel[level];

  user.runs += 1;
  user.best = Math.max(user.best, zombies);

  persist();
  // acceptedZombies tells the client how many were actually credited, so anything
  // above the per-call ceiling stays pending on the client instead of being lost
  res.json({ state: publicState(user), acceptedZombies: zombies });
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
  if (hasWithdrawnToday(user)) return res.status(409).json({ error: 'already-withdrawn-today' });

  const fee = Number((amt * WITHDRAWAL_FEE_RATE).toFixed(6));
  const netAmount = Number((amt - fee).toFixed(6));
  user.ton -= amt;
  user.lastWithdrawalDay = berlinDayKey();
  const withdrawal = { ts: Date.now(), address: String(address).trim(), memo, amount: netAmount, grossAmount: amt, fee, status: 'pending' };
  user.withdrawals.push(withdrawal);
  if (user.withdrawals.length > 200) user.withdrawals = user.withdrawals.slice(-200);

  persist();
  res.json({ state: publicState(user), withdrawal });
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
  const level = Math.max(1, Math.min(4, Number(user.level) || 1));
  const dailyCap = level >= 4 ? LEVEL_FOUR_DAILY_PTS_CAP : level >= 3 ? LEVEL_THREE_DAILY_PTS_CAP : level >= 2 ? LEVEL_TWO_DAILY_PTS_CAP : DAILY_PTS_CAP;
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
      badge4: user && user.badge4 === true,
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
  res.json({
    storage: { dataDir: DATA_DIR, persistent: STORAGE_PERSISTENT, volumeMountPath: RAILWAY_VOLUME_PATH || null },
    totalUsers: all.length,
    totalCoins: all.reduce((s, u) => s + u.coins, 0),
    totalTon: all.reduce((s, u) => s + u.ton, 0),
    totalRuns: all.reduce((s, u) => s + u.runs, 0),
    pendingWithdrawals,
  });
});

app.get('/admin/players', requireAdmin, (req, res) => {
  const all = Object.values(users);
  const players = all.map((user) => ({
    uid: String(user.id),
    name: user.name || ('Player ' + user.id),
    ton: Number(user.ton) || 0,
    coins: Number(user.coins) || 0,
    level: Number(user.level) || 1,
    ownedLevels: [1, 2, 3, 4].filter((level) => {
      const skinByLevel = { 1: 'yellow', 2: 'red', 3: 'white', 4: 'green' };
      return Array.isArray(user.ownedSkins) && user.ownedSkins.includes(skinByLevel[level]);
    }),
    runs: Number(user.runs) || 0,
    depositCount: Array.isArray(user.depositTxs) ? user.depositTxs.length : 0,
    referralCount: Number(user.referralCount) || 0,
    referralRewardCount: Number(user.referralRewardCount) || 0,
    referralRewardZombies: (Number(user.referralRewardCount) || 0) * 300,
    referralLink: 'https://t.me/TaxiTronBot?start=' + encodeURIComponent(referralCodeFor(user.id)),
    tournamentBest: Number(user.tournamentBest) || 0,
    createdAt: Number(user.createdAt) || 0,
    isBanned: user.isBanned === true,
  })).sort((a, b) => b.ton - a.ton);
  res.json({
    totalUsers: players.length,
    depositUsers: players.filter((player) => player.depositCount > 0).length,
    totalTon: players.reduce((sum, player) => sum + player.ton, 0),
    totalReferrals: players.reduce((sum, player) => sum + player.referralCount, 0),
    totalReferralRewards: players.reduce((sum, player) => sum + player.referralRewardCount, 0),
    totalReferralRewardZombies: players.reduce((sum, player) => sum + player.referralRewardZombies, 0),
    players,
  });
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
    badge4: u.badge4 === true,
    chatMuted: u.chatMuted === true,
    lastSeenAt: Number(u.lastSeenAt || 0),
  }));
  res.json({ users: list, chatEnabled });
});

app.post('/admin/chat/set-enabled', requireAdmin, (req, res) => {
  chatEnabled = req.body.enabled === true;
  persistChatSettings();
  res.json({ ok: true, chatEnabled });
  broadcastChatEvent('settings', { chatEnabled });
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

app.post('/admin/chat/set-badge4', requireAdmin, (req, res) => {
  const uid = String(req.body && req.body.uid || '');
  const user = users[uid];
  if (!user) return res.status(404).json({ error: 'user-not-found' });
  user.badge4 = req.body.badge4 === true;
  persist();
  res.json({ ok: true, uid, badge4: user.badge4 });
  broadcastChatEvent('moderation', { uid, badge4: user.badge4 });
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

app.post('/admin/users/:uid/reset-attempts', requireAdmin, (req, res) => {
  const user = users[String(req.params.uid)];
  if (!user) return res.status(404).json({ error: 'unknown-user' });
  user.attemptsLeft = ATTEMPT_LIMIT_LEVEL_ONE;
  user.attemptsResetAt = null;
  user.attemptsByLevel = {};
  [1, 2, 3, 4].forEach((level) => ensureAttemptState(user, level));
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

// Lets an admin manually correct a user's TON balance (e.g. to undo a double-credited
// deposit) by a positive or negative delta. Clamped at 0 so a mistaken large deduction
// can't push the balance negative.
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

app.post('/admin/reset-users', requireAdmin, async (req, res) => {
  const resetUsers = Object.values(users);
  rpsGames = {};
  resetUsers.forEach((user) => {
    const depositTxs = Array.isArray(user.depositTxs) ? user.depositTxs.slice() : [];
    user.coins = 0;
    user.ton = 0;
    user.tonToday = 0;
    user.tonTodayByLevel = { 1: 0, 2: 0, 3: 0, 4: 0 };
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

const server = http.createServer(app);
attachMonsterCrash(server, {
  verifyUser: verifyMonsterCrashUser,
  economy: monsterCrashEconomy,
});

server.listen(PORT, () => {
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
  startTelegramBot().catch((error) => console.error('[bot] NICHT gestartet: ' + error.message));
  setInterval(runRandomDraw, RANDOM_INTERVAL_MS);
  if (!DEPOSIT_ADDRESS) console.warn('WARNING: DEPOSIT_ADDRESS not set — automatic deposits are disabled.');
  if (!PLATFORM_USER_ID) console.warn('WARNING: PLATFORM_USER_ID not set — RPS platform fees cannot be credited.');
  else {
    console.log('[deposit] automatic scanner enabled every ' + Math.round(DEPOSIT_POLL_MS / 1000) + 's.');
    setTimeout(scanDeposits, 1000);
    setInterval(scanDeposits, DEPOSIT_POLL_MS);
  }
  if (SESSION_SECRET === 'dev-insecure-secret-change-me') console.warn('WARNING: using the default SESSION_SECRET — set a real one in production.');
});
