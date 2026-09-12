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
const PLATFORM_USER_ID = String(process.env.PLATFORM_USER_ID || '');
const DEPOSIT_ADDRESS = process.env.DEPOSIT_ADDRESS || '';
const TONAPI_URL = process.env.TONAPI_URL || 'https://tonapi.io/v2';
const DEPOSIT_POLL_MS = Number(process.env.DEPOSIT_POLL_MS || 30000);

const ON_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);
const RAILWAY_VOLUME_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
const DATA_DIR = process.env.DATA_DIR || RAILWAY_VOLUME_PATH || path.join(__dirname, 'data');

if (ON_RAILWAY && SESSION_SECRET === 'dev-insecure-secret-change-me') {
  throw new Error('SESSION_SECRET must be configured in production');
}

const DATA_FILE = path.join(DATA_DIR, 'users.json');
const BACKUP_FILE = path.join(DATA_DIR, 'users.backup.json');
const RPS_FILE = path.join(DATA_DIR, 'rps-games.json');

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
let rpsGames = {};
try {
  if (fs.existsSync(RPS_FILE)) rpsGames = readJsonFile(RPS_FILE);
} catch (e) {
  console.error('[rps] games file unreadable: ' + e.message);
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
setInterval(expireRpsGames, 30000);

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
    level: 1,
    ownedSkins: ['yellow'],
    attemptsLeft: 10,
    attemptsResetAt: null,
    attemptResetVersion: 0,
    taskChannelRewardClaimed: false,
    lastSeenAt: 0,
    tournamentBest: 0,
    tournamentDistance: 0,
    tournamentWeekKey: '',
    depositTxs: [],
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
  const ownedSkins = Array.isArray(user.ownedSkins) ? user.ownedSkins : ['yellow'];
  if (ownedSkins.indexOf('yellow') === -1) ownedSkins.unshift('yellow');
  user.ownedSkins = ownedSkins;
  user.level = ownedSkins.indexOf('green') !== -1 ? 4 : ownedSkins.indexOf('white') !== -1 ? 3 : ownedSkins.indexOf('red') !== -1 ? 2 : 1;
  return {
    uid: String(user.id),
    coins: user.coins,
    ton: user.ton,
    tonToday: user.tonToday,
    best: user.best,
    runs: user.runs,
    level: user.level,
    ownedSkins,
    attemptResetVersion: user.attemptResetVersion || 0,
    taskChannelRewardClaimed: user.taskChannelRewardClaimed === true,
  };
}

const RPS_CHOICES = new Set(['rock', 'paper', 'scissors']);
const RPS_MIN_STAKE = 0.001;
const RPS_GAME_TTL_MS = 30 * 60 * 1000;
const GAME_ROOM_STAKE = 0.001;
const GAME_ROOM_RESET_DELAY_MS = 15000;
const GAME_ROUND_TIMEOUT_MS = 60 * 1000;
const GAME_PLAYER_OFFLINE_MS = 35 * 1000;
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
function resolveGameRoom(room) {
  const active = room.players.filter((player) => player.alive);
  if (active.length <= 1) {
    if (active.length === 1 && room.status !== 'finished') {
      const winner = active[0];
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
    room.lastRoundWinners = [String(winner.id)];
    room.choices = {};
    room.status = 'finished';
    const winnerPayout = Number((room.stake * 4 * 0.9).toFixed(9));
    const fee = Number((room.stake * 4 * 0.1).toFixed(9));
    if (users[String(winner.id)]) users[String(winner.id)].ton += winnerPayout;
    if (PLATFORM_USER_ID && users[PLATFORM_USER_ID]) users[PLATFORM_USER_ID].ton += fee;
    room.result = { winnerId: String(winner.id), winnerName: winner.name, winnerPayout, fee };
    room.resetAt = Date.now() + GAME_ROOM_RESET_DELAY_MS;
    room.roundStartedAt = 0;
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
  room.choices = {};
  room.round += 1;
  room.roundStartedAt = Date.now();
  const remaining = room.players.filter((player) => player.alive);
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
app.use(express.static(__dirname, { index: false }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/admin', (req, res) => {
  if (!ADMIN_SECRET) return res.status(503).send('Admin panel is disabled: ADMIN_SECRET is not configured.');
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TaxiTron Admin</title><style>
body{font-family:Segoe UI,Arial,sans-serif;background:#101018;color:#f5f2ff;max-width:1000px;margin:32px auto;padding:0 18px}h1{color:#ffd93d}button,input{padding:10px;border-radius:8px;border:1px solid #3b3850;background:#1c1c2a;color:#fff}button{cursor:pointer;background:#ffd93d;color:#261f00;font-weight:700}.danger{background:#ff5c6c;color:#260b10}.toolbar{display:flex;gap:8px;margin:18px 0;flex-wrap:wrap}.status{color:#aaa3b8;margin:12px 0}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:18px 0}.stat{padding:14px;border:1px solid #3b3850;border-radius:8px;background:#181824}.stat b{display:block;font-size:24px;color:#ffd93d}.row{display:grid;grid-template-columns:1.2fr 1fr 1fr 1fr 1fr 1fr;gap:12px;align-items:center;padding:14px 0;border-bottom:1px solid #302d40}.muted{color:#aaa3b8;font-size:12px}@media(max-width:650px){.stats{grid-template-columns:1fr}.row{grid-template-columns:1fr 1fr}}
</style></head><body><h1>TaxiTron Admin</h1><div class="toolbar"><input id="secret" type="password" placeholder="Admin secret"><button id="load">Spieler laden</button><button id="loadWithdrawals">Auszahlungen laden</button><button id="reset" class="danger">Alle Spieler zurücksetzen</button></div><div id="status" class="status"></div><div id="stats" class="stats"></div><div id="list"></div>
<script>
const secret=()=>document.getElementById('secret').value;
const status=(text)=>document.getElementById('status').textContent=text;
async function load(){const s=secret();if(!s){status('ADMIN_SECRET eingeben.');return}status('Spieler werden geladen...');const r=await fetch('/admin/players',{headers:{'x-admin-secret':s}});const d=await r.json();if(!r.ok){status(d.error||'Request failed');return}document.getElementById('stats').innerHTML='<div class="stat"><span>Registrierte Spieler</span><b>'+d.totalUsers+'</b></div><div class="stat"><span>Spieler mit Einzahlung</span><b>'+d.depositUsers+'</b></div><div class="stat"><span>TON gesamt</span><b>'+Number(d.totalTon).toFixed(6)+'</b></div>';const list=document.getElementById('list');list.innerHTML='<div class="row"><b>Spieler</b><b>TON-Guthaben</b><b>Coins</b><b>Level</b><b>Einzahlungen</b><b>Runs</b></div>';d.players.forEach(p=>{const row=document.createElement('div');row.className='row';row.innerHTML='<span>'+p.name+'<br><span class="muted">UID '+p.uid+'</span></span><span>'+Number(p.ton).toFixed(6)+' TON</span><span>'+p.coins+'</span><span>'+p.level+'</span><span>'+p.depositCount+'</span><span>'+p.runs+'</span>';list.appendChild(row)});status(d.totalUsers+' Spieler geladen.')}
async function loadWithdrawals(){const s=secret();if(!s){status('ADMIN_SECRET eingeben.');return}status('Auszahlungen werden geladen...');const r=await fetch('/admin/withdrawals?status=pending',{headers:{'x-admin-secret':s}});const d=await r.json();if(!r.ok){status(d.error||'Request failed');return}const list=document.getElementById('list');list.innerHTML=d.withdrawals.length?'':'Keine offenen Auszahlungen.';d.withdrawals.forEach(w=>{const row=document.createElement('div');row.className='row';row.innerHTML='<span>'+w.name+'<br><span class="muted">UID '+w.uid+'</span></span><span>'+w.amount+' TON</span><span>'+w.address+'</span><span class="muted">'+new Date(w.ts).toLocaleString()+'</span><button>Erledigt</button>';row.querySelector('button').onclick=async()=>{const rr=await fetch('/admin/withdrawals/complete',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':s},body:JSON.stringify({uid:w.uid,ts:w.ts})});if(rr.ok)loadWithdrawals();else status((await rr.json()).error||'Request failed')};list.appendChild(row)})}
document.getElementById('load').onclick=load;
document.getElementById('loadWithdrawals').onclick=loadWithdrawals;
document.getElementById('reset').onclick=async()=>{const s=secret();if(!s){status('Enter the admin secret.');return}if(!confirm("WARNING: This resets all players' coins, TON, level, skins, stats, and withdrawals. Deposits remain protected. Continue?"))return;status('Resetting all players...');const r=await fetch('/admin/reset-users',{method:'POST',headers:{'x-admin-secret':s}});const d=await r.json();status(r.ok?'Reset complete for '+d.count+' players.':(d.error||'Reset failed'));if(r.ok)load()};
</script></body></html>`);
});

// Health check for monitoring and deployment checks.
app.get('/api/health', (req, res) => res.json({
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
  user.lastSeenAt = Date.now();
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
  persist();
  res.json({ state: publicState(user) });
});

app.post('/api/tasks/channel-claim', requireUserFromBody, async (req, res) => {
  const user = req.user;
  if (user.taskChannelRewardClaimed === true) {
    return res.json({ claimed: true, joined: true, rewardZombies: 0, state: publicState(user) });
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
    persist();
    res.json({ claimed: true, joined: true, rewardZombies: 500, state: publicState(user) });
  } catch (e) {
    res.status(502).json({ error: 'telegram-membership-check-failed' });
  }
});

async function tonApiJson(pathname) {
  const response = await fetch(TONAPI_URL + pathname);
  if (!response.ok) throw new Error('tonapi-http-' + response.status);
  return response.json();
}

let depositScanInProgress = false;
async function scanDeposits() {
  if (!DEPOSIT_ADDRESS || depositScanInProgress) return;
  depositScanInProgress = true;
  try {
    const account = await tonApiJson('/accounts/' + encodeURIComponent(DEPOSIT_ADDRESS));
    const data = await tonApiJson('/accounts/' + encodeURIComponent(DEPOSIT_ADDRESS) + '/events?limit=100');
    let changed = false;
    for (const event of data.events || []) {
      for (const action of event.actions || []) {
        const transfer = action.type === 'TonTransfer' && action.TonTransfer;
        if (!transfer || action.status !== 'ok' || transfer.recipient.address !== account.address) continue;
        const match = /^TT-(\d+)$/.exec(String(transfer.comment || '').trim());
        if (!match || Number(transfer.amount) <= 0) continue;
        const user = users[match[1]];
        if (!user) continue;
        if (!Array.isArray(user.depositTxs)) user.depositTxs = [];
        const txId = String(event.event_id || '').toLowerCase();
        if (!txId || user.depositTxs.includes(txId)) continue;
        user.ton += Number(transfer.amount) / 1e9;
        user.depositTxs.push(txId);
        if (user.depositTxs.length > 200) user.depositTxs = user.depositTxs.slice(-200);
        changed = true;
        console.log('[deposit] credited ' + (Number(transfer.amount) / 1e9) + ' TON to user ' + user.id);
      }
    }
    if (changed) persist();
  } catch (e) {
    console.error('[deposit] scan failed: ' + e.message);
  } finally {
    depositScanInProgress = false;
  }
}

function getNativeTransfer(event, uid) {
  return (event.actions || []).find((action) => {
    const transfer = action.type === 'TonTransfer' && action.TonTransfer;
    return transfer && action.status === 'ok' &&
      transfer.comment === 'TT-' + uid && Number(transfer.amount) > 0;
  });
}

app.post('/api/deposit/claim', requireUserFromBody, async (req, res) => {
  const txHash = String(req.body && req.body.txHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(txHash)) return res.status(400).json({ error: 'invalid-transaction-id' });
  if (!DEPOSIT_ADDRESS) return res.status(503).json({ error: 'deposit-address-not-configured' });
  const user = req.user;
  if (!Array.isArray(user.depositTxs)) user.depositTxs = [];
  if (user.depositTxs.includes(txHash)) return res.status(409).json({ error: 'deposit-already-claimed' });

  try {
    const account = await tonApiJson('/accounts/' + encodeURIComponent(DEPOSIT_ADDRESS));
    const event = await tonApiJson('/events/' + txHash);
    const transferAction = getNativeTransfer(event, user.id);
    const recipient = transferAction && transferAction.TonTransfer.recipient;
    if (!transferAction || !recipient || recipient.address !== account.address) {
      return res.status(400).json({ error: 'deposit-does-not-match-account' });
    }
    const amount = transferAction.TonTransfer.amount / 1e9;
    user.ton += amount;
    user.depositTxs.push(txHash);
    if (user.depositTxs.length > 200) user.depositTxs = user.depositTxs.slice(-200);
    persist();
    res.json({ state: publicState(user), amount });
  } catch (e) {
    res.status(502).json({ error: 'deposit-verification-failed' });
  }
});

// ---- Exchange a run's zombies for coins + (capped) TON ----
app.post('/api/run', requireUserFromBody, (req, res) => {
  const user = req.user;
  let { distance, zombies } = req.body || {};
  zombies = Math.max(0, Math.min(MAX_ZOMBIES_PER_CALL, Math.floor(Number(zombies) || 0)));
  distance = Math.max(0, Math.min(MAX_DISTANCE_PER_CALL, Math.floor(Number(distance) || 0)));

  ensureDailyReset(user);

  const level = user.level || 1;
  const coinsPerZombie = level >= 4 ? LEVEL_FOUR_COINS_PER_ZOMBIE : level >= 3 ? LEVEL_THREE_COINS_PER_ZOMBIE : level >= 2 ? LEVEL_TWO_COINS_PER_ZOMBIE : COINS_PER_ZOMBIE;
  const dailyCap = level >= 4 ? LEVEL_FOUR_DAILY_PTS_CAP : level >= 3 ? LEVEL_THREE_DAILY_PTS_CAP : level >= 2 ? LEVEL_TWO_DAILY_PTS_CAP : DAILY_PTS_CAP;
  if (level >= 2 && user.tonToday >= dailyCap - 1e-9) {
    persist();
    return res.json({ state: publicState(user), acceptedZombies: 0, error: 'daily-earn-cap-reached' });
  }
  const coinsGained = zombies * coinsPerZombie;
  user.coins += coinsGained;

  const rawGain = (coinsGained / COINS_PER_BLOCK) * PTS_PER_BLOCK * LEVEL_MULTIPLIER;
  const allowed = Math.max(0, dailyCap - user.tonToday);
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

app.post('/api/rps/create', requireUserFromBody, (req, res) => {
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

app.post('/api/rps/join', requireUserFromBody, (req, res) => {
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

app.post('/api/rps/play', requireUserFromBody, (req, res) => {
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

app.post('/api/game/rooms/join', requireUserFromBody, (req, res) => {
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

app.post('/api/game/rooms/choose', requireUserFromBody, (req, res) => {
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

app.post('/api/rps/tournaments/create', requireUserFromBody, (req, res) => {
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

app.post('/api/rps/tournaments/join', requireUserFromBody, (req, res) => {
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

app.post('/api/rps/tournaments/play', requireUserFromBody, (req, res) => {
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

app.get('/admin/players', requireAdmin, (req, res) => {
  const all = Object.values(users);
  const players = all.map((user) => ({
    uid: String(user.id),
    name: user.name || ('Player ' + user.id),
    ton: Number(user.ton) || 0,
    coins: Number(user.coins) || 0,
    level: Number(user.level) || 1,
    runs: Number(user.runs) || 0,
    depositCount: Array.isArray(user.depositTxs) ? user.depositTxs.length : 0,
  })).sort((a, b) => b.ton - a.ton);
  res.json({
    totalUsers: players.length,
    depositUsers: players.filter((player) => player.depositCount > 0).length,
    totalTon: players.reduce((sum, player) => sum + player.ton, 0),
    players,
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

app.post('/admin/reset-users', requireAdmin, async (req, res) => {
  const resetUsers = Object.values(users);
  rpsGames = {};
  resetUsers.forEach((user) => {
    const depositTxs = Array.isArray(user.depositTxs) ? user.depositTxs.slice() : [];
    user.coins = 0;
    user.ton = 0;
    user.tonToday = 0;
    user.tonDate = '';
    user.best = 0;
    user.runs = 0;
    user.level = 1;
    user.ownedSkins = ['yellow'];
    user.attemptsLeft = 10;
    user.attemptsResetAt = null;
    user.attemptResetVersion = Date.now();
    user.skinRewards = {};
    user.tournamentBest = 0;
    user.tournamentDistance = 0;
    user.tournamentWeekKey = '';
    user.withdrawals = [];
    user.taskChannelRewardClaimed = false;
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
  if (!DEPOSIT_ADDRESS) console.warn('WARNING: DEPOSIT_ADDRESS not set — automatic deposits are disabled.');
  if (!PLATFORM_USER_ID) console.warn('WARNING: PLATFORM_USER_ID not set — RPS platform fees cannot be credited.');
  else {
    console.log('[deposit] automatic scanner enabled every ' + Math.round(DEPOSIT_POLL_MS / 1000) + 's.');
    setTimeout(scanDeposits, 1000);
    setInterval(scanDeposits, DEPOSIT_POLL_MS);
  }
  if (SESSION_SECRET === 'dev-insecure-secret-change-me') console.warn('WARNING: using the default SESSION_SECRET — set a real one in production.');
});
