// blitz-core.js - authoritative server-side Blitz-Liga ("لیگ برق‌آسا") logic.
// ------------------------------------------------------------------
// Adapted from blitz-liga/server/liga-core.js (the package's own example
// backend) per blitz-liga/AGENT_PROMPT.md point 5: the original demo computes
// every match's goals/events from a PRNG seeded only by the public match id
// (`id*2654435761%4294967296+17`), which means anyone who reads the client
// code can calculate a match's result before kickoff. That is fine for the
// free-to-play demo but not acceptable once real TON is paid out.
//
// This module keeps the team pick on that same public/id-seeded generator
// (teams are explicitly allowed to stay public - AGENT_PROMPT point 5,
// bullet 1), but generates everything that actually decides the outcome
// (score, goals, events, stats) from a SEPARATE secret per-match seed that
// only ever lives on the server (see server.js's blitzSeedFor()). Every
// other constant/formula below (timings, teams, poisson goal model, prize
// table, ranking tie-break) is copied 1:1 from the original so the game
// plays out identically to the supplied index.html/server example.
// ------------------------------------------------------------------

const TIP = 15 * 60000, PLAY = 120000, POST = 25000, CYCLE = TIP + PLAY + POST, LINE = 2.5;
const TEAMS = [["ستاره دانوب","#E94F4F","#FFFFFF","DAN"],["عقاب‌های آلپ","#3D7BE0","#FFFFFF","ALP"],["اتحاد شمال","#F2B84B","#1B1B1B","SHM"],["شیرهای کوهستان","#E94F4F","#2B2B6B","KOH"],["طوفان جنوب","#2FA866","#FFFFFF","TOF"],["دریاشهر","#16A3B8","#0B2A3A","DAR"],["دینامو پراتر","#7A4BD6","#FFFFFF","DIN"],["پلنگ‌های سیاه","#1B1B1B","#F2B84B","PAL"],["قطار غرب","#F28A3B","#FFFFFF","GHA"],["رئال سیمرینگ","#FFFFFF","#C9354A","REA"],["اینتر شهر","#2B4FA8","#111111","INT"],["آدمیرا بندر","#D93A8C","#FFFFFF","BAN"],["المپیا","#4A9E3F","#F2D04B","OLY"],["جنگل‌نشینان","#2E6B4F","#E8D9B0","JAN"],["پیشروان","#B8322E","#F4F4F4","PIS"],["اتحاد بریگیت","#5B6B7A","#FFFFFF","BRI"]];
const SEASON = 10, PTS = 3, PRIZES = [2, 1, 0.5, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];

function rng(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function poisson(r, l) { let L = Math.exp(-l), k = 0, p = 1; do { k++; p *= r(); } while (p > L); return k - 1; }

function clock(now) {
  const id = Math.floor(now / CYCLE), t = now - id * CYCLE;
  if (t < TIP) return { id, ph: 'tips', left: TIP - t, min: 0 };
  if (t < TIP + PLAY) return { id, ph: 'live', min: (t - TIP) / PLAY * 90, left: TIP + PLAY - t };
  return { id, ph: 'post', min: 90, left: CYCLE - t };
}
// Anchor so a season always starts at "game 1" from this match id onward,
// instead of the deploy moment landing somewhere in the middle of an
// otherwise purely Unix-epoch-aligned 10-game window (id*CYCLE since epoch,
// with no regard for when this app went live). Must match index.html's copy
// exactly, or client and server would disagree on match numbering.
const SEASON_ANCHOR_ID = 1714186;
const seasonOf = (id) => Math.floor((id - SEASON_ANCHOR_ID) / SEASON);
const firstOf = (s) => SEASON_ANCHOR_ID + s * SEASON;
const kickoffAt = (id) => id * CYCLE + TIP;

// Public, deterministic from the match id alone - safe to reveal at any time
// (including before kickoff), matches the client's own teamsOf() 1:1.
function teamsOf(id) {
  const r = rng(id * 2654435761 % 4294967296 + 17);
  const hi = Math.floor(r() * TEAMS.length);
  let ai; do { ai = Math.floor(r() * TEAMS.length); } while (ai === hi);
  return { h: TEAMS[hi], a: TEAMS[ai] };
}

// Secret: only ever call this with a true-random seed that is generated and
// stored server-side at/after kickoff (see server.js blitzSeedFor()). Never
// derive seedInt from the match id - that would reintroduce the exact
// predictability bug this module exists to close.
function buildResult(id, seedInt) {
  const t = teamsOf(id);
  const r = rng(seedInt >>> 0);
  const sh = .8 + r() * .9, sa = .7 + r() * .9;
  const gh = Math.min(poisson(r, sh * 1.15), 6), ga = Math.min(poisson(r, sa), 6);
  const used = new Set(), min = () => { let m; do { m = 1 + Math.floor(r() * 90); } while (used.has(m)); used.add(m); return m; };
  const ev = [];
  for (let i = 0; i < gh; i++) ev.push({ m: min(), t: 'goal', s: 0 });
  for (let i = 0; i < ga; i++) ev.push({ m: min(), t: 'goal', s: 1 });
  const extra = 4 + Math.floor(r() * 5);
  for (let i = 0; i < extra; i++) { const k = r(); ev.push({ m: min(), t: k < .45 ? 'save' : k < .75 ? 'card' : 'post', s: r() < .5 ? 0 : 1 }); }
  ev.sort((a, b) => a.m - b.m);
  const ph = [r() * 6, r() * 6, r() * 6, r() * 6];
  const shots = [], corners = [], pos = Math.round(50 + (sh - sa) * 14 + (r() - .5) * 8);
  const ns = 6 + Math.floor(r() * 8); for (let i = 0; i < ns; i++) shots.push({ m: 1 + Math.floor(r() * 90), s: r() < sh / (sh + sa) ? 0 : 1 });
  const nc = 4 + Math.floor(r() * 7); for (let i = 0; i < nc; i++) corners.push({ m: 1 + Math.floor(r() * 90), s: r() < sh / (sh + sa) ? 0 : 1 });
  const nums = [[1, 2, 4, 5, 3, 6, 8, 10, 7, 9, 11], [1, 2, 4, 5, 3, 6, 8, 10, 7, 9, 11]].map(a => a.map(n => n + (r() < .2 ? 10 : 0)));
  return { id, h: t.h, a: t.a, sh, sa, gh, ga, ev, ph, shots, corners, pos: Math.max(35, Math.min(65, pos)), nums };
}

const finishedAt = (id, now) => now >= id * CYCLE + CYCLE; // whole cycle (incl. the 25s post phase) has elapsed
const correct = (m, tip) => !!tip && !!tip.ou && ((tip.ou === 'over') === (m.gh + m.ga > LINE));

// Table for one season. `docs` = { uid: { tips: { matchId: {ou, ts} } } }.
// `getResult(matchId)` must return a full buildResult()-shaped object for any
// already-finished match id (the caller is responsible for having a seed for
// it - every match that ever reached kickoff gets one, see server.js).
function table(season, docs, now, getResult) {
  const c = clock(now);
  const fin = (id) => id < c.id || (id === c.id && c.ph === 'post');
  const rows = [];
  for (const [id, d] of Object.entries(docs)) {
    const tips = (d && d.tips) || {};
    let pts = 0, hits = 0, played = 0, sp = 0, n = 0;
    for (let mid = firstOf(season); mid < firstOf(season) + SEASON; mid++) {
      const t = tips[mid]; if (!t || !t.ou) continue;
      sp += typeof t.ts === 'number' ? Math.max(0, t.ts - mid * CYCLE) : TIP; n++;
      if (fin(mid)) { played++; if (correct(getResult(mid), t)) { pts += PTS; hits++; } }
    }
    if (n) rows.push({ id, pts, hits, played, sp: sp / n });
  }
  rows.sort((a, b) => b.pts - a.pts || a.sp - b.sp || (a.id < b.id ? -1 : 1));
  rows.forEach((r, i) => r.rank = i + 1);
  return rows;
}

module.exports = {
  TIP, PLAY, POST, CYCLE, LINE, SEASON, PTS, PRIZES, TEAMS,
  clock, seasonOf, firstOf, kickoffAt, finishedAt, teamsOf, buildResult, correct, table,
};
