  /* ================= APP-STATE / STORAGE ================= */
  const store = {
    coins: parseInt(localStorage.getItem('cr3d_coins') || '0', 10),
    best: parseInt(localStorage.getItem('cr3d_best') || '0', 10),
    runs: parseInt(localStorage.getItem('cr3d_runs') || '0', 10),
    upgrades: JSON.parse(localStorage.getItem('cr3d_upgrades') || '{}'),
    level: parseInt(localStorage.getItem('cr3d_level') || '1', 10),
    points: parseFloat(localStorage.getItem('cr3d_points') || '0'),
    pointsToday: parseFloat(localStorage.getItem('cr3d_pointsToday') || '0'),
    pointsDate: localStorage.getItem('cr3d_pointsDate') || '',
    skin: localStorage.getItem('cr3d_skin') || 'yellow',
    ownedSkins: JSON.parse(localStorage.getItem('cr3d_ownedSkins') || '["yellow"]'),
    skinRewards: JSON.parse(localStorage.getItem('cr3d_skinRewards') || '{}'),
    attemptsLeft: localStorage.getItem('cr3d_attemptsLeft') !== null ? parseInt(localStorage.getItem('cr3d_attemptsLeft'), 10) : 10,
    attemptsResetAt: localStorage.getItem('cr3d_attemptsResetAt') ? parseInt(localStorage.getItem('cr3d_attemptsResetAt'), 10) : null,
    withdrawals: JSON.parse(localStorage.getItem('cr3d_withdrawals') || '[]')
  };
  function saveStore(){
    localStorage.setItem('cr3d_coins', store.coins);
    localStorage.setItem('cr3d_best', store.best);
    localStorage.setItem('cr3d_runs', store.runs);
    localStorage.setItem('cr3d_upgrades', JSON.stringify(store.upgrades));
    localStorage.setItem('cr3d_level', store.level);
    localStorage.setItem('cr3d_points', store.points);
    localStorage.setItem('cr3d_pointsToday', store.pointsToday);
    localStorage.setItem('cr3d_pointsDate', store.pointsDate);
    localStorage.setItem('cr3d_skin', store.skin);
    localStorage.setItem('cr3d_ownedSkins', JSON.stringify(store.ownedSkins));
    localStorage.setItem('cr3d_skinRewards', JSON.stringify(store.skinRewards));
    localStorage.setItem('cr3d_attemptsLeft', store.attemptsLeft);
    if (store.attemptsResetAt) localStorage.setItem('cr3d_attemptsResetAt', store.attemptsResetAt);
    else localStorage.removeItem('cr3d_attemptsResetAt');
    localStorage.setItem('cr3d_withdrawals', JSON.stringify(store.withdrawals));
  }

  /* ---- Level 1 conversion: 10,000 coins = 0.01 PTS, x1 multiplier, capped at 1 PTS/day ---- */
  const COINS_PER_BLOCK = 10000;
  const PTS_PER_BLOCK = 0.01;
  const LEVEL_MULTIPLIER = 1; // Level 1 base
  const DAILY_PTS_CAP = 1;

  function todayStr(){
    return new Date().toISOString().slice(0,10);
  }
  /* ---- Daily passive TON reward earned from owned taxi skins (e.g. Level 2 / Level 3) ---- */
  function creditSkinRewards(){
    const t2 = todayStr();
    let changed = false;
    Object.keys(store.skinRewards).forEach(key => {
      const r = store.skinRewards[key];
      const def = SKIN_LEVELS.find(d => d.key === key);
      if (!def || !def.dailyReward || r.remainingDays <= 0) return;
      if (r.lastCreditDate !== t2){
        store.points += def.dailyReward;
        r.remainingDays -= 1;
        r.lastCreditDate = t2;
        changed = true;
      }
    });
    if (changed) saveStore();
  }
  function ensureDailyReset(){
    const t = todayStr();
    if (store.pointsDate !== t){
      store.pointsDate = t;
      store.pointsToday = 0;
    }
    creditSkinRewards();
  }
  function addPointsFromCoins(coinsAdded){
    ensureDailyReset();
    const rawGain = (coinsAdded / COINS_PER_BLOCK) * PTS_PER_BLOCK * LEVEL_MULTIPLIER;
    const allowed = Math.max(0, DAILY_PTS_CAP - store.pointsToday);
    const gain = Math.min(rawGain, allowed);
    store.points += gain;
    store.pointsToday += gain;
    saveStore();
  }

  /* ---- Ride attempts: limit removed, unlimited plays for all levels ---- */
  function ensureAttempts(){ /* no-op: attempts limit disabled */ }
  function hasAttemptsLeft(){ return true; }
  function consumeAttempt(){ return true; }
  function formatCountdown(ms){
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = String(Math.floor(total / 3600)).padStart(2,'0');
    const m = String(Math.floor((total % 3600) / 60)).padStart(2,'0');
    const s = String(total % 60).padStart(2,'0');
    return h + ':' + m + ':' + s;
  }
  function renderAttemptsUI(){
    const el = document.getElementById('attemptsInfo');
    const btn = document.getElementById('homePlayBtn');
    if (el) el.style.display = 'none';
    if (btn) btn.disabled = false;
  }
  renderAttemptsUI();

