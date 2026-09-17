// Monster Crash – Online-Lobby + Spielserver
// Benötigt: npm install ws
//
// Ablauf:
//  - Spieler zahlt 0.001 TON Einsatz -> ist in der Lobby (max. 10)
//  - Erster Beitritt startet einen 5:00-Timer
//  - Timer abgelaufen: >= 3 Spieler -> Spiel startet, sonst Einsatz zurück an alle
//  - Jede Runde 1:00, wer am wenigsten Monster hat fliegt raus, bis einer übrig ist
//  - Sieger bekommt 80 % vom Topf, 20 % gehen an die App
//
// Alle Beträge sind in nanoTON (1 TON = 1_000_000_000 nano), damit es keine Rundungsfehler gibt.

const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const DEFAULTS = {
  path: '/mc',
  feeNano: 1_000_000,        // 0.001 TON
  winnerShare: 0.8,          // 80 % an den Sieger, Rest an die App
  minPlayers: 3,
  maxPlayers: 10,
  lobbySeconds: 300,         // 5:00
  roundSeconds: 60,          // 1:00
  countSeconds: 5,
  breakSeconds: 5,
  monsterCount: 50,
  arena: 60,
};

const OBSTACLES = [
  { x: 25, z: 25, r: 3 }, { x: -25, z: 25, r: 3 }, { x: 25, z: -25, r: 3 }, { x: -25, z: -25, r: 3 },
  { x: 0, z: 38, r: 2 }, { x: 0, z: -38, r: 2 }, { x: 38, z: 0, r: 2 }, { x: -38, z: 0, r: 2 },
];

// Prüft die Telegram-WebApp-initData (Signatur mit dem BOT_TOKEN)
function verifyTelegramInitData(initData, botToken, maxAgeSec = 86400) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (maxAgeSec && Date.now() / 1000 - authDate > maxAgeSec) return null;
  try {
    const u = JSON.parse(params.get('user'));
    return { id: String(u.id), name: String(u.first_name || u.username || 'Spieler').slice(0, 16) };
  } catch {
    return null;
  }
}

/**
 * @param {import('http').Server} server  – dein HTTP-Server (bei Express: const server = app.listen(...))
 * @param {object} opts
 * @param {(initData:string)=>{id:string,name:string}|null} opts.verifyUser
 * @param {object} opts.economy
 * @param {(userId:string, nano:number, reason:string)=>Promise<boolean>} opts.economy.charge   – ATOMAR abbuchen, false wenn zu wenig Guthaben
 * @param {(userId:string, nano:number, reason:string)=>Promise<void>}    opts.economy.credit   – gutschreiben (Rückerstattung / Gewinn)
 * @param {(nano:number, reason:string)=>Promise<void>}                   opts.economy.creditApp – App-Anteil verbuchen
 */
function attachMonsterCrash(server, opts) {
  const cfg = { ...DEFAULTS, ...opts };
  const eco = cfg.economy;
  if (!eco || !eco.charge || !eco.credit || !eco.creditApp) throw new Error('monster-crash: economy.charge/credit/creditApp fehlen');
  if (!cfg.verifyUser) throw new Error('monster-crash: verifyUser fehlt');

  const wss = new WebSocketServer({ server, path: cfg.path });
  const conns = new Map();                 // userId -> ws
  const matches = new Map();               // matchId -> match
  let lobby = { players: new Map(), endsAt: null };
  const joining = new Set();
  let matchSeq = 0;

  const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  // optional: economy.getBalance(userId) -> nano, dann sieht der Spieler sein Guthaben
  async function pushBalance(userId) {
    if (!eco.getBalance) return;
    try { send(conns.get(userId), { t: 'balance', nano: await eco.getBalance(userId) }); } catch {}
  }

  const lobbyView = () => ({
    t: 'lobby',
    players: [...lobby.players.values()].map(p => ({ id: p.id, name: p.name })),
    endsAt: lobby.endsAt,
    now: Date.now(),
    fee: cfg.feeNano,
    pot: cfg.feeNano * lobby.players.size,
    winnerShare: cfg.winnerShare,
    min: cfg.minPlayers,
    max: cfg.maxPlayers,
  });
  const broadcastLobby = () => {
    const v = lobbyView();
    for (const ws of conns.values()) if (!ws.matchId) send(ws, v);
  };

  async function refund(userId, reason) {
    try { await eco.credit(userId, cfg.feeNano, reason); }
    catch (e) { console.error('[monster-crash] RÜCKERSTATTUNG FEHLGESCHLAGEN', userId, e); }
    pushBalance(userId);
  }

  async function join(ws) {
    const u = ws.user;
    if (ws.matchId || lobby.players.has(u.id) || joining.has(u.id)) return send(ws, lobbyView());
    if (lobby.players.size + joining.size >= cfg.maxPlayers) {
      return send(ws, { t: 'error', msg: `Lobby ist voll (max ${cfg.maxPlayers}). Warte auf die nächste Runde.` });
    }
    joining.add(u.id);
    try {
      const ok = await eco.charge(u.id, cfg.feeNano, 'monster-crash-entry');
      if (!ok) return send(ws, { t: 'error', msg: 'Nicht genug Guthaben – du brauchst 0.001 TON.' });
      lobby.players.set(u.id, { id: u.id, name: u.name });
      if (!lobby.endsAt) lobby.endsAt = Date.now() + cfg.lobbySeconds * 1000;
    } catch (e) {
      console.error('[monster-crash] charge error', e);
      send(ws, { t: 'error', msg: 'Zahlung fehlgeschlagen, bitte nochmal versuchen.' });
    } finally {
      joining.delete(u.id);
      broadcastLobby();
      pushBalance(u.id);
    }
  }

  async function leave(ws) {
    const u = ws.user;
    if (!lobby.players.has(u.id)) return;
    lobby.players.delete(u.id);
    if (lobby.players.size === 0) lobby.endsAt = null;
    broadcastLobby();
    await refund(u.id, 'monster-crash-leave');
  }

  // Lobby-Timer
  setInterval(async () => {
    if (!lobby.endsAt || Date.now() < lobby.endsAt) return;
    const list = [...lobby.players.values()];
    lobby = { players: new Map(), endsAt: null };
    if (list.length >= cfg.minPlayers) {
      startMatch(list);
    } else {
      for (const p of list) {
        await refund(p.id, 'monster-crash-not-enough-players');
        send(conns.get(p.id), { t: 'cancelled', msg: `Nur ${list.length} Spieler – mindestens ${cfg.minPlayers} nötig. Dein Einsatz wurde zurückgebucht.` });
      }
    }
    broadcastLobby();
  }, 1000);

  wss.on('connection', ws => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', raw => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'auth') {
        const u = cfg.verifyUser(m.initData);
        if (!u) return send(ws, { t: 'error', msg: 'Anmeldung fehlgeschlagen. Öffne das Spiel über den Telegram-Bot.' });
        const old = conns.get(u.id);
        if (old && old !== ws) old.close();
        ws.user = u;
        conns.set(u.id, ws);
        send(ws, { t: 'me', id: u.id, name: u.name });
        pushBalance(u.id);
        for (const mt of matches.values()) {
          if (mt.players.has(u.id)) { ws.matchId = mt.id; send(ws, mt.startMsg()); return; }
        }
        send(ws, lobbyView());
        return;
      }
      if (!ws.user) return;
      if (m.t === 'join') return join(ws);
      if (m.t === 'leave') return leave(ws);
      if (m.t === 'lobby') { if (!ws.matchId) send(ws, lobbyView()); return; }
      const mt = ws.matchId && matches.get(ws.matchId);
      if (mt) mt.onMsg(ws.user.id, m);
    });
    ws.on('close', () => {
      if (ws.user && conns.get(ws.user.id) === ws) conns.delete(ws.user.id);
    });
  });

  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  // ---------------- Match ----------------
  function startMatch(list) {
    const id = ++matchSeq;
    const A = cfg.arena;
    const pot = cfg.feeNano * list.length;
    const players = new Map();
    list.forEach((p, i) => {
      players.set(p.id, { id: p.id, name: p.name, color: i, x: 0, z: 0, a: 0, monsters: 0, total: 0, out: false, place: 0, lastSeen: 0 });
    });

    const freeSpot = (pad) => {
      for (let k = 0; k < 40; k++) {
        const x = (Math.random() * 2 - 1) * (A - 5), z = (Math.random() * 2 - 1) * (A - 5);
        if (OBSTACLES.every(o => Math.hypot(o.x - x, o.z - z) > o.r + pad)) return { x, z };
      }
      return { x: 0, z: 0 };
    };
    const placeMonster = mo => { Object.assign(mo, freeSpot(2)); mo.active = true; };
    const monsters = Array.from({ length: cfg.monsterCount }, () => { const mo = { dir: Math.random() * 6.28 }; placeMonster(mo); return mo; });

    const placePlayers = () => {
      const alive = [...players.values()].filter(p => !p.out);
      alive.forEach((p, i) => {
        const ang = (i / alive.length) * Math.PI * 2;
        p.x = Math.sin(ang) * 32; p.z = Math.cos(ang) * 32; p.a = ang + Math.PI; p.lastSeen = Date.now();
      });
    };

    let round = 1;
    let phase = 'count';
    let phaseEnds = Date.now() + cfg.countSeconds * 1000;
    placePlayers();

    const broadcast = msg => {
      const s = JSON.stringify(msg);
      for (const p of players.values()) {
        const ws = conns.get(p.id);
        if (ws && ws.readyState === 1 && ws.matchId === id) ws.send(s);
      }
    };

    const mt = {
      id,
      players,
      startMsg: () => ({
        t: 'start', matchId: id, round, pot, winnerShare: cfg.winnerShare, arena: A, iceServers: cfg.iceServers,
        players: [...players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, x: p.x, z: p.z, a: p.a, out: p.out })),
      }),
      onMsg(uid, m) {
        const p = players.get(uid);
        if (!p || p.out) return;
        if (m.t === 'pos') {
          const nx = Number(m.x), nz = Number(m.z), na = Number(m.a);
          if (!isFinite(nx) || !isFinite(nz) || !isFinite(na)) return;
          const now = Date.now();
          const dt = Math.max(0.05, (now - p.lastSeen) / 1000);
          if (Math.hypot(nx - p.x, nz - p.z) > 60 * dt + 2) return; // unrealistisch schnell -> ignorieren
          p.x = Math.max(-A, Math.min(A, nx));
          p.z = Math.max(-A, Math.min(A, nz));
          p.a = na;
          p.lastSeen = now;
        } else if (m.t === 'grab' && phase === 'play') {
          const mo = monsters[m.i | 0];
          if (mo && mo.active && Math.hypot(mo.x - p.x, mo.z - p.z) < 4.5) {
            mo.active = false;
            mo.respawnAt = Date.now() + 2000 + Math.random() * 2000;
            p.monsters++;
            p.total++;
          }
        }
      },
    };
    matches.set(id, mt);
    for (const p of players.values()) {
      const ws = conns.get(p.id);
      if (ws) { ws.matchId = id; send(ws, mt.startMsg()); }
    }

    function endRound() {
      const alive = [...players.values()].filter(p => !p.out);
      alive.sort((a, b) => a.monsters - b.monsters || Math.random() - 0.5);
      const loser = alive[0];
      loser.out = true;
      loser.place = alive.length;
      broadcast({ t: 'out', id: loser.id, name: loser.name, monsters: loser.monsters, total: loser.total, place: loser.place, left: alive.length - 1 });
      if (alive.length - 1 <= 1) finish(alive[1]);
      else { phase = 'break'; phaseEnds = Date.now() + cfg.breakSeconds * 1000; }
    }

    function nextRound() {
      round++;
      for (const p of players.values()) p.monsters = 0;
      monsters.forEach(placeMonster);
      placePlayers();
      phase = 'count';
      phaseEnds = Date.now() + cfg.countSeconds * 1000;
      const spawn = {};
      for (const p of players.values()) if (!p.out) spawn[p.id] = [p.x, p.z, p.a];
      broadcast({ t: 'round', round, spawn });
    }

    async function finish(winner) {
      phase = 'done';
      clearInterval(tick);
      winner.place = 1;
      const prize = Math.floor(pot * cfg.winnerShare);
      const appCut = pot - prize;
      try { await eco.credit(winner.id, prize, `monster-crash-win-${id}`); }
      catch (e) { console.error('[monster-crash] GEWINN-AUSZAHLUNG FEHLGESCHLAGEN', id, winner.id, prize, e); }
      pushBalance(winner.id);
      try { await eco.creditApp(appCut, `monster-crash-fee-${id}`); }
      catch (e) { console.error('[monster-crash] App-Anteil nicht verbucht', id, appCut, e); }
      broadcast({
        t: 'end', pot, prize,
        winner: { id: winner.id, name: winner.name },
        results: [...players.values()].sort((a, b) => a.place - b.place).map(p => ({ id: p.id, name: p.name, place: p.place, total: p.total })),
      });
      matches.delete(id);
      for (const p of players.values()) {
        const ws = conns.get(p.id);
        if (ws && ws.matchId === id) ws.matchId = null;
      }
      console.log(`[monster-crash] Match ${id} beendet – Sieger ${winner.id}, Gewinn ${prize} nano, App ${appCut} nano`);
    }

    const tick = setInterval(() => {
      const now = Date.now();
      const dt = 0.1;
      if (phase === 'count' && now >= phaseEnds) { phase = 'play'; phaseEnds = now + cfg.roundSeconds * 1000; }
      else if (phase === 'play' && now >= phaseEnds) endRound();
      else if (phase === 'break' && now >= phaseEnds) nextRound();
      if (phase === 'done') return;

      const alive = [...players.values()].filter(p => !p.out);
      for (const mo of monsters) {
        if (!mo.active) { if (phase === 'play' && now >= mo.respawnAt) placeMonster(mo); continue; }
        let near = null, nd = 12;
        for (const p of alive) { const d = Math.hypot(p.x - mo.x, p.z - mo.z); if (d < nd) { nd = d; near = p; } }
        let sp = 2;
        if (near) { mo.dir = Math.atan2(mo.x - near.x, mo.z - near.z) + (Math.random() - 0.5) * 0.8; sp = 8; }
        else mo.dir += (Math.random() - 0.5) * 3 * dt;
        mo.x += Math.sin(mo.dir) * sp * dt;
        mo.z += Math.cos(mo.dir) * sp * dt;
        const L = A - 1.5;
        if (Math.abs(mo.x) > L) { mo.x = Math.sign(mo.x) * L; mo.dir = -mo.dir; }
        if (Math.abs(mo.z) > L) { mo.z = Math.sign(mo.z) * L; mo.dir = Math.PI - mo.dir; }
        for (const o of OBSTACLES) {
          const dx = mo.x - o.x, dz = mo.z - o.z, d = Math.hypot(dx, dz);
          if (d < o.r + 1 && d > 0.001) { mo.x = o.x + dx / d * (o.r + 1); mo.z = o.z + dz / d * (o.r + 1); mo.dir += 1.5; }
        }
      }

      broadcast({
        t: 's', ph: phase, left: Math.max(0, (phaseEnds - now) / 1000), round,
        p: [...players.values()].map(p => [p.id, +p.x.toFixed(2), +p.z.toFixed(2), +p.a.toFixed(3), p.monsters, p.out ? 1 : 0, p.total]),
        m: monsters.map(mo => [+mo.x.toFixed(1), +mo.z.toFixed(1), mo.active ? 1 : 0]),
      });
    }, 100);
  }

  console.log(`[monster-crash] WebSocket bereit auf ${cfg.path}`);
  return { wss };
}

module.exports = { attachMonsterCrash, verifyTelegramInitData };
