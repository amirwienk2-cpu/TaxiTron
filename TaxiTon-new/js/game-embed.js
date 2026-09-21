// TEST-ONLY glue: embeds the real game (root index.html, screen-game canvas)
// inside the new design's "play" tab, because this new design has no game
// canvas/logic of its own. Does NOT modify root index.html/app.js/server.js.
//
// UX goal: pressing the "بازی" nav tab goes straight into the real game —
// the real app's home/menu screens are never shown. To make this feel
// instant, the real app is preloaded in the hidden iframe in the background
// (before the user even presses play), so pressing play usually only has to
// wait for a quick button click + screen switch, not a full page load.
(function(){
  const placeholder = document.getElementById('playPlaceholder');
  const wrap = document.getElementById('gameEmbedWrap');
  const frame = document.getElementById('realGameFrame');
  const backBtn = document.getElementById('gameEmbedBack');
  const startBtn = document.getElementById('startBtn');
  const playTab = document.querySelector('.tab[data-s="play"]');
  const homeTab = document.querySelector('.tab[data-s="home"]');
  if (!wrap || !frame || !backBtn) return;

  let launching = false;
  let watcher = null;
  let progressTimer = null; // polls the real game's own daily-cap % while it is running
  let preloaded = false; // true once the hidden iframe has finished loading /index.html
  let preloading = false; // true while a preload navigation is in flight

  // The real game (root index.html/app.js) tracks "today's earned TON vs. the daily cap for
  // the player's current level" in its `store.pointsTodayByLevel`, persisted live to
  // localStorage (same origin, shared with this page) every time a zombie's ride converts
  // to coins/points - it does NOT re-render its own #capPercent DOM until the player returns
  // to its Home screen, so reading localStorage directly (rather than that DOM element) is
  // what lets the bar move live, in real time, while actually driving. Same cap-based % logic
  // as app.js's getLevelDailyPtsCap()/getCurrentLevelTodayPoints() - works at any level.
  const DAILY_PTS_CAP_BY_LEVEL = { 1: 1, 2: 0.067, 3: 0.2, 4: 0.66 };
  function accountKey(name){
    const uid = localStorage.getItem('cr3d_serverUid');
    return uid ? name + '_' + uid : name;
  }
  function pollGameProgress(){
    try {
      const level = parseInt(localStorage.getItem(accountKey('cr3d_level')) || '1', 10) || 1;
      const cap = DAILY_PTS_CAP_BY_LEVEL[level] || DAILY_PTS_CAP_BY_LEVEL[1];
      const byLevel = JSON.parse(localStorage.getItem(accountKey('cr3d_pointsTodayByLevel')) || '{}') || {};
      const todayForLevel = Number(byLevel[level] || 0);
      const pct = cap > 0 ? Math.max(0, Math.min(100, Math.round((todayForLevel / cap) * 100))) : 0;
      // Best score ("بهترین امتیاز") and run count ("تعداد مسیرها") are also written live to
      // localStorage by the real game (cr3d_best / cr3d_runs) - every crash/run-end updates
      // both, so reading them here keeps the new design's Home stats in sync too.
      const best = parseInt(localStorage.getItem(accountKey('cr3d_best')) || '0', 10) || 0;
      const runs = parseInt(localStorage.getItem(accountKey('cr3d_runs')) || '0', 10) || 0;
      // "تلاش باقی‌مانده" (tries left) mirrors the real game's own attempts system:
      // max tries depends on the player's current skin/level (10 for level 1, 15 for
      // level 2+, see app.js's activeAttemptLevel()/getMaxAttempts()), and the
      // remaining count is written live to localStorage every time a run starts
      // (consumeAttempt()) or resets (daily/cooldown), so mirroring it here keeps
      // this new design's "تلاش باقی‌مانده" in sync with the real game exactly like
      // the old design's own attemptsInfo counter.
      const skin = localStorage.getItem(accountKey('cr3d_skin')) || 'yellow';
      const attemptLevel = skin === 'green' ? 4 : skin === 'white' ? 3 : skin === 'red' ? 2 : 1;
      const triesMax = attemptLevel >= 2 ? 15 : 10;
      const triesRaw = localStorage.getItem(accountKey('cr3d_attemptsLeft'));
      const tries = triesRaw !== null ? Math.max(0, Math.min(triesMax, parseInt(triesRaw, 10) || 0)) : triesMax;
      if (typeof TT !== 'undefined' && typeof TT.setProgress === 'function') TT.setProgress(pct);
      if (typeof TT !== 'undefined' && typeof TT.setStats === 'function') TT.setStats({ best, routes: runs, tries, triesMax });
    } catch (e) { /* ignore malformed localStorage during a write */ }
    progressTimer = setTimeout(pollGameProgress, 400);
  }
  function stopProgressPoll(){
    if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
  }

  // Wallet "معاوضه" (exchange) sync: the real game keeps the collected-but-not-yet-
  // exchanged zombies (cr3d_pendingZombies) and the coin balance (cr3d_coins) in
  // localStorage, and the exchange rate depends on the player's current skin/level
  // exactly like getCoinsPerZombie() in the real app.js (1/7/20/100 coins per zombie
  // for level 1/2/3/4). Poll continuously (not just while the game screen is open) so
  // the new design's Wallet tab always shows the real numbers whenever it's opened.
  function coinsPerZombieForSkin(skin){
    const level = skin === 'green' ? 4 : skin === 'white' ? 3 : skin === 'red' ? 2 : 1;
    return level >= 4 ? 100 : level >= 3 ? 20 : level >= 2 ? 7 : 1;
  }
  function pollWalletProgress(){
    try {
      const zombies = parseInt(localStorage.getItem(accountKey('cr3d_pendingZombies')) || '0', 10) || 0;
      const coins = parseInt(localStorage.getItem(accountKey('cr3d_coins')) || '0', 10) || 0;
      const skin = localStorage.getItem(accountKey('cr3d_skin')) || 'yellow';
      const rate = coinsPerZombieForSkin(skin);
      // Withdrawable TON balance ("قابل برداشت") in the old design is the same
      // store.points (cr3d_points) the exchange feeds via addPointsFromCoins() -
      // every coin exchange raises it (subject to the same daily cap), so mirror
      // it live here too, exactly like the old design's own withdraw screen. The
      // wallet's own "balance" line now shows this TON total too (not the coin
      // total), so pass it along to TT.setWallet as well.
      const points = parseFloat(localStorage.getItem(accountKey('cr3d_points')) || '0') || 0;
      if (typeof TT !== 'undefined' && typeof TT.setWallet === 'function') TT.setWallet({ zombies, coins, rate, points });
      if (typeof TT !== 'undefined' && typeof TT.setWithdraw === 'function') TT.setWithdraw({ balance: points });
      // The Home screen's own top balance (walletTonDisplay in the old design) also
      // shows this exact same store.points value - mirror it there too via setStats.
      if (typeof TT !== 'undefined' && typeof TT.setStats === 'function') TT.setStats({ gram: points });
    } catch (e) { /* ignore malformed localStorage during a write */ }
  }
  setInterval(pollWalletProgress, 500);
  pollWalletProgress();

  // Performs the exchange for real, exactly like the old design: instead of
  // re-implementing exchangePersons()'s coins->TON/daily-cap logic here (risking it
  // drifting out of sync), click the real app's own (preloaded, hidden) exchangeBtn -
  // same click handler, same rate, same daily-cap rules - then read back the result.
  if (typeof TT !== 'undefined') {
    TT.exchange = async function(){
      try {
        const doc = frame.contentWindow && frame.contentWindow.document;
        const realBtn = doc && doc.getElementById('exchangeBtn');
        if (!doc || !realBtn || realBtn.disabled) return false;
        realBtn.click();
        // local-only economy (no server configured) runs synchronously; this small
        // wait covers the async/server-session code path too, just in case.
        await new Promise(resolve => setTimeout(resolve, 200));
        const zombies = parseInt(localStorage.getItem(accountKey('cr3d_pendingZombies')) || '0', 10) || 0;
        const coins = parseInt(localStorage.getItem(accountKey('cr3d_coins')) || '0', 10) || 0;
        const points = parseFloat(localStorage.getItem(accountKey('cr3d_points')) || '0') || 0;
        return { zombies, coins, points };
      } catch (e) { return false; }
    };

    // Same idea for the withdraw request: fill the real app's own (hidden, preloaded)
    // withdraw form and click its real button, so it runs the exact same validation
    // (min withdrawal, daily-once limit, TON address check) and fee/points math as
    // the old design instead of a re-implementation that could drift out of sync.
    TT.requestWithdraw = async function(req){
      try {
        const doc = frame.contentWindow && frame.contentWindow.document;
        const addrInput = doc && doc.getElementById('withdrawAddress');
        const amtInput = doc && doc.getElementById('withdrawAmount');
        const realBtn = doc && doc.getElementById('withdrawBtn');
        if (!doc || !addrInput || !amtInput || !realBtn || realBtn.disabled) return { ok: false };
        addrInput.value = req && req.address || '';
        amtInput.value = req && req.amount || '';
        const pointsBefore = parseFloat(localStorage.getItem(accountKey('cr3d_points')) || '0') || 0;
        realBtn.click();
        // requestWithdraw() in the real app can be async (server round-trip); give
        // it a moment before reading back the result, same margin as the exchange.
        await new Promise(resolve => setTimeout(resolve, 300));
        const points = parseFloat(localStorage.getItem(accountKey('cr3d_points')) || '0') || 0;
        // A successful request always deducts from store.points immediately (even
        // for the local-pending path); if it's unchanged, the real app rejected it
        // (bad address/amount/already withdrawn today/insufficient funds/banned).
        if (points >= pointsBefore) return { ok: false };
        return { ok: true, balance: points, status: 'pending' };
      } catch (e) { return { ok: false }; }
    };
  }

  function preload(){
    if (preloaded || preloading) return; // already loaded or in flight
    preloading = true;
    frame.addEventListener('load', () => { preloaded = true; preloading = false; }, { once: true });
    frame.src = '/index.html';
  }
  // Start preloading immediately so the real app is (usually) already
  // sitting ready in the background by the time the user presses play.
  preload();

  function openRealGame(){
    if (launching) return;
    launching = true;
    wrap.hidden = false;
    if (placeholder) placeholder.style.display = 'none';
    if (preloaded) {
      // Already loaded in the background — most of the time this resolves in the very
      // same tick (see below), so the loading spinner never has to appear at all.
      pollForGameScreen(0);
    } else if (preloading) {
      wrap.classList.add('loading'); // genuinely still loading — show the spinner
      frame.addEventListener('load', () => pollForGameScreen(0), { once: true });
    } else {
      wrap.classList.add('loading');
      preload();
      frame.addEventListener('load', () => pollForGameScreen(0), { once: true });
    }
  }

  function pollForGameScreen(attempt){
    let doc = null;
    try { doc = frame.contentWindow && frame.contentWindow.document; } catch (e) { /* same-origin, shouldn't throw */ }
    if (!doc) {
      wrap.classList.add('loading');
      if (attempt < 80) return setTimeout(() => pollForGameScreen(attempt + 1), 50);
      return giveUp();
    }
    const gameScreen = doc.getElementById('screen-game');
    if (gameScreen && gameScreen.classList.contains('active')) {
      wrap.classList.remove('loading');
      launching = false;
      watchForExit(gameScreen);
      stopProgressPoll();
      pollGameProgress();
      return; // real game canvas is now visible and running
    }
    // (Re-)click the real app's own Play nav button until the game screen
    // actually becomes active — its click handlers may not be bound yet on
    // the very first attempts right after the iframe "load" event fires.
    const realPlayBtn = doc.querySelector('.bottomnav button[data-screen="game"].play-btn');
    if (realPlayBtn) realPlayBtn.click();
    // enterGame() in the real app runs entirely synchronously (no await/promise before
    // it toggles "active"), so re-check right away in the same tick instead of always
    // waiting a further 50ms - this is what makes the preloaded case feel instant with
    // no loading screen ever appearing.
    const gameScreenNow = doc.getElementById('screen-game');
    if (gameScreenNow && gameScreenNow.classList.contains('active')) {
      wrap.classList.remove('loading');
      launching = false;
      watchForExit(gameScreenNow);
      stopProgressPoll();
      pollGameProgress();
      return;
    }
    wrap.classList.add('loading'); // real click didn't resolve synchronously — genuinely still loading
    if (attempt < 80) {
      setTimeout(() => pollForGameScreen(attempt + 1), 50);
    } else {
      giveUp();
    }
  }

  function giveUp(){
    // Couldn't confirm the game screen started (e.g. no attempts left, or
    // banned) — reveal whatever the real app is showing instead of leaving
    // a spinner forever, so the user can see what's blocking it.
    wrap.classList.remove('loading');
    launching = false;
  }

  // Once the real game is running, watch its own screen element: if the
  // user taps the real app's in-game "Home" (or any other) nav button, the
  // real app switches away from #screen-game internally. We must not let
  // that old-design screen become visible to the user — instead, close the
  // embed immediately and land back on the new design's own Home tab.
  function watchForExit(gameScreen){
    if (watcher) watcher.disconnect();
    watcher = new MutationObserver(() => {
      if (!gameScreen.classList.contains('active')) {
        watcher.disconnect();
        watcher = null;
        closeRealGame();
      }
    });
    watcher.observe(gameScreen, { attributes: true, attributeFilter: ['class'] });
  }

  function closeRealGame(){
    if (watcher) { watcher.disconnect(); watcher = null; }
    stopProgressPoll();
    wrap.hidden = true;
    wrap.classList.remove('loading');
    // Never show the old placeholder text again — going back/exiting the
    // game always lands the user on the new design's own Home tab instead.
    frame.src = 'about:blank'; // drop the embedded game/session cleanly
    launching = false;
    preloaded = false;
    if (homeTab) homeTab.click();
    // Warm the iframe back up in the background so the *next* play press is
    // fast again too, without blocking anything the user is doing now.
    setTimeout(preload, 400);
  }

  if (startBtn) startBtn.addEventListener('click', openRealGame);
  if (playTab) playTab.addEventListener('click', openRealGame);
  backBtn.addEventListener('click', closeRealGame);
})();
