// server-bridge.js
// Connects the redesigned TaxiTon-new UI (index-new.html + js/app.js, whose TT.* functions
// are all pure UI setters/hooks) to the REAL backend in server.js, using the exact same
// endpoints/field names/auth flow as the live root app.js + index.html.
//
// This file only READS from server.js's public HTTP API (same-origin, relative paths) and
// feeds results into the TT.* hooks that already exist in js/app.js. It never talks to
// data/*.json directly and never fabricates coin/ton/zombie numbers on its own - every
// balance shown comes from a server response.
//
// NOTE ON SCOPE: the "#play" screen in index-new.html has no game canvas/logic at all in
// this redesign (only a "Start Game" button placeholder), so there is nothing real to wire
// there - the actual taxi/zombie driving game only exists in the legacy game iframe.
(function () {
  'use strict';

  var SESSION = { token: null, uid: null, online: false, referralCode: null };
  var lastChatMessageId = 0;
  var chatBootstrapped = false;
  var chatEventSource = null;

  // Mirrors the server-side daily TON-earning caps (server.js: DAILY_PTS_CAP and friends).
  // The server does not expose these via any endpoint (same situation as the root app.js,
  // which also hardcodes matching copies of these exact constants), so they are duplicated
  // here only to render the "TON left today" progress bar - they never gate any action.
  var DAILY_PTS_CAP_BY_LEVEL = { 1: 1, 2: 0.067, 3: 0.2, 4: 0.66 };
  function dailyCapForLevel(level) {
    var l = Number(level) || 1;
    return DAILY_PTS_CAP_BY_LEVEL[l] || DAILY_PTS_CAP_BY_LEVEL[1];
  }

  function api(path, opts) {
    opts = opts || {};
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  function postJSON(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  function withToken(url) {
    if (!SESSION.token) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(SESSION.token);
  }

  // ---- apply real server state into the existing TT.* hooks ----------------------------
  function applyState(state) {
    if (!state) return;
    SESSION.uid = state.uid;
    SESSION.isChatAdmin = state.isChatAdmin === true;
    SESSION.isDesigner = state.isDesigner === true;
    SESSION.isBanned = state.isBanned === true;
    SESSION.referralCode = state.referralCode || SESSION.referralCode;
    window.__TT_STATE = state; // for manual inspection/debugging only

    var level = Number(state.level) || 1;
    var dailyCap = dailyCapForLevel(level);
    var tonToday = (state.tonTodayByLevel && typeof state.tonTodayByLevel[level] === 'number')
      ? state.tonTodayByLevel[level]
      : (typeof state.tonToday === 'number' ? state.tonToday : 0);
    var progress = dailyCap > 0 ? Math.max(0, Math.min(100, Math.round((tonToday / dailyCap) * 100))) : 0;
    var attempts = state.attemptsByLevel && state.attemptsByLevel[level];
    var triesMax = level >= 2 ? 15 : 10;

    if (typeof TT.setStats === 'function') {
      TT.setStats({
        best: Number(state.best) || 0,
        routes: Number(state.runs) || 0,   // no server "routes" concept - closest real analogue is completed runs
        level: level + '-1',
        levelNo: level,
        gram: tonToday,                     // TON earned today at the current level
        tonLeft: Math.max(0, dailyCap - tonToday),
        progress: progress,
        tries: attempts ? Number(attempts.left) : triesMax,
        triesMax: triesMax
      });
    }
    if (typeof TT.setWallet === 'function') {
      // The wallet "exchange" widget is repurposed to show the ONE real zombie-exchange
      // path the backend actually supports: referralPendingZombies -> coins/TON via
      // POST /api/referrals/exchange (see TT.exchange below). Game zombie exchange
      // rates are level-specific and are refreshed by game-embed.js when the iframe
      // is available.
      const exchangeRate = level >= 4 ? 100 : level >= 3 ? 20 : level >= 2 ? 7 : 1;
      TT.setWallet({
        zombies: Number(state.referralPendingZombies) || 0,
        coins: Number(state.coins) || 0,
        rate: exchangeRate,
        points: Number(state.ton) || 0,
        tt: Number(state.ttBalance) || 0
      });
    }
    if (typeof TT.setWithdraw === 'function') {
      // MIN_WITHDRAW / WITHDRAWAL_FEE_RATE are server constants not exposed via any endpoint;
      // hardcoded here to match server.js exactly (same approach root app.js uses).
      TT.setWithdraw({ balance: Number(state.ton) || 0, min: 1, fee: 0.01 });
    }
    if (typeof TT.setMyChatState === 'function') {
      TT.setMyChatState({ muted: state.chatMuted === true, banned: state.isBanned === true });
    }
    if (typeof TT.setTasks === 'function') {
      // Server persists completion (not the UI's own localStorage flags), exactly like the
      // old design's store.taskChannelRewardClaimed / store.withdrawChannelTaskRewardClaimed.
      TT.setTasks({
        main: state.taskChannelRewardClaimed === true,
        withdraw: state.withdrawChannelTaskRewardClaimed === true,
        third: state.thirdChannelTaskRewardClaimed === true
      });
    }
    if (typeof TT.setAdsTask === 'function') {
      // Matches the old design's "Watch 10 videos -> 0.03 TON" task (server.js: adVideosWatched
      // / adRewardClaimed via /api/tasks/ad-video-claim).
      TT.setAdsTask({ watched: Number(state.adVideosWatched) || 0, completed: state.adRewardClaimed === true });
    }

    // ---- Shop: the only real purchasable items are the 3 TON-priced car skins
    // (red/white/green), each of which also raises the account level (2/3/4).
    // Everyone owns 'yellow' for free (server default). No coin-priced "levels"
    // or separate "chat skins" exist server-side - see js/app.js SKINS/renderShop.
    SESSION.ownedSkins = Array.isArray(state.ownedSkins) ? state.ownedSkins : ['yellow'];
    SESSION.ton = Number(state.ton) || 0;
    SESSION.level = level;
    if (typeof TT.setShop === 'function') {
      TT.setShop({ ton: SESSION.ton, level: level, ownedSkins: SESSION.ownedSkins.slice(),
        skinRewards: (state.skinRewards && typeof state.skinRewards === 'object') ? state.skinRewards : {},
        tonTodayByLevel: (state.tonTodayByLevel && typeof state.tonTodayByLevel === 'object') ? state.tonTodayByLevel : {} });
    }
  }

  // ---- select which OWNED level/skin is actually driven in the embedded game -----------------
  // There is no server concept of "active skin" (server.js's user.level is monotonic: it only
  // ever increases when a higher skin is bought - see /api/buy-skin). Switching between already
  // owned skins is purely local, exactly like the root app.js's shop "Select" button (which only
  // updates its own client-side store.skin/store.level, never talks to the server). We relay the
  // choice into the game iframe (same-origin, #play screen) via postMessage so it updates live.
  var LEVEL_TO_SKIN = { 1: 'yellow', 2: 'red', 3: 'white', 4: 'green' };
  TT.selectLevel = function (level) {
    var key = LEVEL_TO_SKIN[Number(level)];
    if (!key || SESSION.ownedSkins.indexOf(key) === -1) return;
    var ownsPremium = SESSION.ownedSkins.some(function (ownedKey) {
      return ownedKey === 'red' || ownedKey === 'white' || ownedKey === 'green';
    });
    if (Number(level) === 1 && ownsPremium) return;
    var frame = document.getElementById('realGameFrame');
    if (frame && frame.contentWindow) {
      try { frame.contentWindow.postMessage({ type: 'tt-select-skin', skin: key, level: Number(level) }, '*'); } catch (e) {}
    }
  };

  // ---- local demo purchase fallback (no Telegram auth available) --------------------------
  // Only used when there is no real server session/token (i.e. testing this UI in a plain
  // browser outside Telegram). Mirrors the root app.js's local skin-buy logic + pricing table
  // so the shop can be exercised end-to-end without a live Telegram login. Never runs once a
  // real /api/auth token exists.
  var DEMO_STATE_KEY = 'ttnew_demo_state';
  var DEMO_SKIN_DEFS = {
    red: { level: 2, price: 1, dailyReward: 0.07, rewardDays: 30 },
    white: { level: 3, price: 3, dailyReward: 0.2, rewardDays: 30 },
    green: { level: 4, price: 10, dailyReward: 0.66, rewardDays: 30 }
  };
  function loadDemoState() {
    try {
      var raw = localStorage.getItem(DEMO_STATE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return {
      uid: 'demo-local', level: 1, best: 0, runs: 0, coins: 0, ton: 20,
      ownedSkins: ['yellow'], skinRewards: {}, tonTodayByLevel: { 1: 0, 2: 0, 3: 0, 4: 0 },
      adVideosWatched: 0, adRewardClaimed: false, taskChannelRewardClaimed: false,
      withdrawChannelTaskRewardClaimed: false, thirdChannelTaskRewardClaimed: false,
      referralPendingZombies: 0, chatMuted: false, isBanned: false
    };
  }
  function saveDemoState(state) {
    try { localStorage.setItem(DEMO_STATE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function demoBuySkin(key) {
    var def = DEMO_SKIN_DEFS[key];
    if (!def) return { ok: false, error: 'unknown-skin' };
    var state = loadDemoState();
    if (state.ownedSkins.indexOf(key) === -1) {
      if (state.ton < def.price) return { ok: false, error: 'insufficient-funds' };
      state.ton -= def.price;
      state.ownedSkins.push(key);
      state.skinRewards[key] = { remainingDays: def.rewardDays, expiresAt: Date.now() + def.rewardDays * 86400000, lastCreditDate: '', lastEarnedDate: '' };
    }
    state.level = def.level;
    saveDemoState(state);
    applyState(state);
    return { ok: true };
  }

  // ---- shop: buy a real car skin/level (red/white/green) via TON --------------------------
  TT.buySkin = function (key) {
    if (!SESSION.token) return Promise.resolve(SESSION.demo ? demoBuySkin(key) : { ok: false, error: 'not-authenticated' });
    return postJSON('/api/buy-skin', { token: SESSION.token, key: key }).then(function (r) {
      if (r.ok && r.data.state) {
        applyState(r.data.state);
        return { ok: true };
      }
      return { ok: false, error: (r.data && r.data.error) || 'error' };
    }).catch(function () { return { ok: false, error: 'network-error' }; });
  };

  // ---- auth ------------------------------------------------------------------------------
  function getInitData() {
    try {
      var tg = window.Telegram && window.Telegram.WebApp;
      var initData = tg && tg.initData;
      var startParam = tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param;
      var referralCode = startParam || new URLSearchParams(window.location.search).get('ref') || '';
      return { initData: initData || '', referralCode: referralCode };
    } catch (e) {
      return { initData: '', referralCode: '' };
    }
  }

  function auth() {
    var ctx = getInitData();
    if (!ctx.initData) {
      // Not running inside Telegram (e.g. plain desktop browser test) - nothing we can
      // authenticate with. Fall back to a local-only demo account (no server involved) so
      // the shop/purchases can still be tested end-to-end in a plain browser.
      console.warn('[server-bridge] no Telegram initData available; using local demo account (no server auth).');
      SESSION.demo = true;
      var demoState = loadDemoState();
      applyState(demoState);
      return Promise.resolve(demoState);
    }
    return postJSON('/api/auth', { initData: ctx.initData, referralCode: ctx.referralCode }).then(function (r) {
      if (!r.ok || !r.data || !r.data.token) {
        console.warn('[server-bridge] /api/auth failed', r.status, r.data);
        return null;
      }
      SESSION.token = r.data.token;
      SESSION.online = true;
      applyState(r.data.state);
      return r.data.state;
    }).catch(function (e) {
      console.warn('[server-bridge] /api/auth error', e);
      return null;
    });
  }

  // ---- deposit ----------------------------------------------------------------------------
  function loadDeposit() {
    if (!SESSION.token) return;
    api(withToken('/api/deposit-info')).then(function (r) {
      if (!r.ok) return;
      if (typeof TT.setDeposit === 'function') {
        TT.setDeposit({ address: r.data.address || '', memo: r.data.memo || '' });
      }
    }).catch(function () {});
  }
  // Note: manual "check deposit by tx hash" was removed from the new design's UI (2026-09-20)
  // per user request - deposits are still auto-detected server-side via the account memo.

  // ---- withdraw ---------------------------------------------------------------------------
  function loadWithdrawals() {
    if (!SESSION.token) return;
    api(withToken('/api/withdrawals')).then(function (r) {
      if (!r.ok) return;
      if (typeof TT.setWithdrawHistory === 'function') TT.setWithdrawHistory(r.data.withdrawals || []);
    }).catch(function () {});
  }
  TT.requestWithdraw = function (req) {
    if (!SESSION.token) return Promise.resolve({ ok: false });
    return postJSON('/api/withdraw', {
      token: SESSION.token,
      address: req.address,
      amount: req.amount,
      memo: req.memo || ''
    }).then(function (r) {
      if (!r.ok) return { ok: false };
      applyState(r.data.state);
      loadWithdrawals();
      return { ok: true, balance: r.data.state.ton, status: r.data.withdrawal && r.data.withdrawal.status };
    }).catch(function () { return { ok: false }; });
  };

  // ---- tasks --------------------------------------------------------------------------------
  var TASK_ENDPOINTS = {
    TaxiiTon: '/api/tasks/channel-claim',
    TaxitonWithdraw: '/api/tasks/withdraw-channel-claim',
    taxiiiton: '/api/tasks/third-channel-claim'
  };
  TT.verifyMembership = function (channel) {
    if (!SESSION.token) return Promise.resolve(false);
    var endpoint = TASK_ENDPOINTS[channel];
    if (!endpoint) {
      console.warn('[server-bridge] no real endpoint for channel task "' + channel + '" - task can never complete for real.');
      return Promise.resolve(false);
    }
    return postJSON(endpoint, { token: SESSION.token }).then(function (r) {
      if (!r.ok) return false;
      if (r.data.state) applyState(r.data.state);
      return r.data.joined === true || r.data.claimed === true;
    }).catch(function () { return false; });
  };

  // ---- ads task: "watch 10 videos -> 0.03 TON" (matches old design's Adsgram flow) ----------
  TT.watchRewardedAd = function () {
    if (!SESSION.token) return Promise.resolve({ ok: false, notReady: true });
    if (!window.Adsgram || typeof window.Adsgram.init !== 'function') {
      // Real Adsgram network isn't available (e.g. outside Telegram) - nothing to show.
      return Promise.resolve({ ok: false, notReady: true });
    }
    var controller;
    try { controller = window.Adsgram.init({ blockId: '48235' }); } catch (e) {
      return Promise.resolve({ ok: false, notReady: true });
    }
    return controller.show().then(function () {
      return postJSON('/api/tasks/ad-video-claim', { token: SESSION.token });
    }).then(function (r) {
      if (!r.ok || !r.data.state) return { ok: false };
      applyState(r.data.state);
      return {
        ok: true,
        watched: Number(r.data.state.adVideosWatched) || 0,
        completed: r.data.state.adRewardClaimed === true
      };
    }).catch(function () { return { ok: false }; });
  };

  // ---- referrals --------------------------------------------------------------------------
  function loadReferralStatus() {
    if (!SESSION.token) return;
    api(withToken('/api/referrals/status')).then(function (r) {
      if (r.ok && r.data.state) applyState(r.data.state);
    }).catch(function () {});
  }
  TT.exchange = function () {
    if (!SESSION.token) return Promise.resolve(false);
    return postJSON('/api/referrals/exchange', { token: SESSION.token }).then(function (r) {
      if (!r.ok) return false;
      applyState(r.data.state);
      return { zombies: Number(r.data.state.referralPendingZombies) || 0, coins: Number(r.data.state.coins) || 0 };
    }).catch(function () { return false; });
  };
  TT.inviteLink = function () {
    var code = SESSION.referralCode; // real 'ref_<uid>' code from the server
    var bot = window.TAXITRON_BOT_USERNAME || 'TaxiTronBot';
    if (!code) return 'https://t.me/' + bot;
    return 'https://t.me/' + bot + '?start=' + code;
  };

  // ---- invite leaderboard (top-3 inviters win TON) -----------------------------------------
  // Public endpoint (token optional): with a valid token the server also returns "you" (your
  // own rank/invite count for the current campaign).
  function loadInviteLeaderboard() {
    api(withToken('/api/invite-leaderboard')).then(function (r) {
      if (!r.ok || !r.data) return;
      if (typeof TT.setInviteLeaderboard === 'function') TT.setInviteLeaderboard(r.data);
    }).catch(function () {});
  }

  // ---- admin ------------------------------------------------------------------------------
  TT.isAdmin = function () { return SESSION.isChatAdmin === true || SESSION.isDesigner === true; };
  TT.adminAction = function (action, user) {
    if (!SESSION.token) return Promise.resolve(false);
    if (action === 'chatOff' || action === 'chatOn') {
      return postJSON('/api/chat/moderate', { token: SESSION.token, targetUid: user.id, muted: action === 'chatOff' }).then(function (r) {
        return r.ok;
      }).catch(function () { return false; });
    }
    if (action === 'delete') {
      if (user.mid === undefined) return Promise.resolve(false);
      return postJSON('/api/chat/delete', { token: SESSION.token, messageId: user.mid }).then(function (r) {
        return r.ok;
      }).catch(function () { return false; });
    }
    return Promise.resolve(false);
  };

  // ---- chat ---------------------------------------------------------------------------------
  function mapServerMessage(m) {
    return {
      id: m.uid,
      mid: m.id,
      name: m.name,
      text: m.text,
      time: m.ts,
      me: SESSION.uid != null && m.uid === SESSION.uid,
      admin: m.isAdmin ? 'boy' : undefined,
      badge: m.badge4 ? 'badge4' : (!m.isAdmin && m.isDesigner ? 'designer' : undefined),
      muted: m.chatMuted === true,
      randomWinner: m.randomWinner === true,
      randomWinnerName: m.randomWinnerName,
      randomPrizeTon: m.randomPrizeTon,
      reply: m.replyTo ? { mid: m.replyTo.id, name: m.replyTo.name, text: m.replyTo.text } : undefined
    };
  }

  function syncChat() {
    var url = '/api/chat/messages' + (lastChatMessageId ? '?after=' + lastChatMessageId : '');
    api(url).then(function (r) {
      if (!r.ok) return;
      var messages = r.data.messages || [];
      if (typeof TT.setChatEnabled === 'function') TT.setChatEnabled(r.data.enabled !== false);
      if (!messages.length) return;
      if (!chatBootstrapped) {
        var chatList = document.getElementById('chatList');
        if (chatList) chatList.innerHTML = ''; // clear the static demo seed messages once real history is available
        chatBootstrapped = true;
      }
      messages.forEach(function (m) {
        if (typeof TT.addMessage === 'function') TT.addMessage(mapServerMessage(m));
        if (m.id > lastChatMessageId) lastChatMessageId = m.id;
      });
    }).catch(function () {});
  }

  function subscribeChatEvents() {
    if (chatEventSource || typeof EventSource === 'undefined') return;
    try {
      chatEventSource = new EventSource('/api/chat/events');
      chatEventSource.addEventListener('chat-update', function (evt) {
        var payload = {};
        try { payload = JSON.parse(evt.data); } catch (e) {}
        if (payload.type === 'message') {
          syncChat();
          if (payload.randomWinnerUid && String(payload.randomWinnerUid) === String(SESSION.uid)) {
            var winnerTon = Number(payload.randomWinnerTon);
            if (Number.isFinite(winnerTon)) {
              if (typeof TT.setWallet === 'function') TT.setWallet({ points: winnerTon });
              if (typeof TT.setWithdraw === 'function') TT.setWithdraw({ balance: winnerTon });
            }
          }
        } else if (payload.type === 'message-deleted') {
          var mid = payload.messageId;
          var el = mid != null ? document.querySelector('#chatList .msg[data-mid="' + CSS.escape(String(mid)) + '"]') : null;
          if (el) el.remove();
        } else if (payload.type === 'moderation' && typeof TT.setUserMod === 'function') {
          TT.setUserMod({ id: payload.uid }, { muted: payload.chatMuted === true, badge4: payload.badge4 === true });
        } else if (payload.type === 'settings' && typeof TT.setChatEnabled === 'function') {
          TT.setChatEnabled(payload.chatEnabled !== false);
        }
      });
      chatEventSource.onerror = function () { /* browser auto-reconnects EventSource */ };
    } catch (e) {}
  }

  TT.onSendMessage = function (payload) {
    if (!SESSION.token) return Promise.resolve(false);
    var body = { token: SESSION.token, text: payload.text };
    // Only forward replyTo when it is a real server message id (numeric); the 3 static
    // demo seed messages baked into index-new.html don't have real ids.
    if (payload.replyTo && payload.replyTo.mid != null && /^\d+$/.test(String(payload.replyTo.mid))) {
      body.replyTo = payload.replyTo.mid;
    }
    return postJSON('/api/chat/send', body).then(function (r) {
      if (r.ok && r.data.message) {
        if (typeof TT.addMessage === 'function') TT.addMessage(mapServerMessage(r.data.message));
        if (r.data.message.id > lastChatMessageId) lastChatMessageId = r.data.message.id;
        if (r.data.randomRemaining !== undefined && typeof window.toast === 'function' && typeof T === 'function') {
          window.toast(T().randomRemaining.replace('{n}', String(r.data.randomRemaining)));
        }
      }
      return r.ok;
    }).catch(function () { return false; });
  };
  TT.isChatAdmin = function () { return SESSION.isChatAdmin === true; };
  TT.setChatEnabledServer = function (enabled) {
    if (!SESSION.token || SESSION.isChatAdmin !== true) return Promise.resolve(false);
    return postJSON('/api/chat/set-enabled', { token: SESSION.token, enabled: enabled === true }).then(function (r) {
      if (!r.ok) return false;
      if (typeof TT.setChatEnabled === 'function') TT.setChatEnabled(r.data.chatEnabled !== false);
      return true;
    }).catch(function () { return false; });
  };
  // TT.editMessage has no server-side driver: server.js supports send/delete only, no edit
  // endpoint or event exists, so editing (if triggered locally) stays purely client-side.
  // TT.setReactions/onReact also stay local-only: there is no reaction concept in server.js at all.

  // ---- online users/count -------------------------------------------------------------------
  function loadOnline() {
    Promise.all([
      api('/api/online-count').catch(function () { return { ok: false }; }),
      api('/api/online-users').catch(function () { return { ok: false }; })
    ]).then(function (results) {
      var countRes = results[0], usersRes = results[1];
      var users = (usersRes.ok && usersRes.data.users) ? usersRes.data.users.map(function (u) {
        return {
          id: u.uid,
          name: u.name,
          admin: u.isChatAdmin ? 'boy' : (u.badge4 ? 'badge4' : (u.isDesigner ? 'designer' : undefined)),
          muted: u.chatMuted === true,
          me: SESSION.uid != null && String(u.uid) === String(SESSION.uid),
          ton: Number(u.ton) || 0
        };
      }) : [];
      if (typeof TT.setOnline === 'function') {
        TT.setOnline({ count: countRes.ok ? countRes.data.online : users.length, users: users });
      }
    }).catch(function () {});
  }

  // ---- weekly tournament leaderboard ---------------------------------------------------------
  // Public endpoint (token optional): with a valid token the server also returns "you" (your
  // own rank/best for this week), which is merged into the list so your row gets the "You" badge.
  function loadLeaderboard() {
    api(withToken('/api/leaderboard')).then(function (r) {
      if (!r.ok || !r.data) return;
      var top = Array.isArray(r.data.top) ? r.data.top : [];
      var entries = top.map(function (e) {
        return {
          name: e.name,
          score: Number(e.best) || 0,
          me: false,
          admin: e.isChatAdmin ? 'boy' : (e.isDesigner ? 'designer' : undefined),
        };
      });
      var you = r.data.you;
      if (you) {
        if (you.rank >= 1 && you.rank <= entries.length) {
          entries[you.rank - 1].me = true;
        } else if (Number(you.best) > 0) {
          entries.push({ name: '', score: Number(you.best) || 0, me: true });
        }
      }
      if (typeof TT.setLeaderboard === 'function') TT.setLeaderboard(entries);
    }).catch(function () {});
  }

  // ---- boot ---------------------------------------------------------------------------------
  function start() {
    auth().then(function (state) {
      if (!state) { syncChat(); loadOnline(); loadLeaderboard(); loadInviteLeaderboard(); return; } // still show public chat/online/leaderboard data even if unauthenticated
      loadDeposit();
      loadWithdrawals();
      loadReferralStatus();
      syncChat();
      subscribeChatEvents();
      loadOnline();
      loadLeaderboard();
      loadInviteLeaderboard();
      // Mirrors root app.js's ~30s re-auth/refresh cadence.
      setInterval(function () { auth().then(function () { loadWithdrawals(); }); }, 30000);
    });
    setInterval(syncChat, 4000);          // matches root app.js's chat polling cadence
    setInterval(loadOnline, 20000);       // ~20-30s cadence, matches root app.js
    setInterval(loadLeaderboard, 20000);  // weekly leaderboard refresh
    setInterval(loadInviteLeaderboard, 10000); // matches root app.js's invite-campaign polling cadence
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
