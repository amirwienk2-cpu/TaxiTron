  /* ================= Server-authoritative economy sync ================= */
  // Fill in your deployed server's URL here once it's online, e.g.
  // const SERVER_URL = "https://your-server.example.com";
  const SERVER_URL = "https://taxitron-production.up.railway.app";
  const serverSession = { token: null, online: false };

  async function initServerSession(){
    if (!SERVER_URL) { window.__depositDebug = 'no-server-url'; loadDepositMemo(); return; }
    try {
      const tg = window.Telegram && window.Telegram.WebApp;
      const initData = tg && tg.initData;
      if (!tg) { window.__depositDebug = 'no-telegram-object'; return; }
      if (!initData) { window.__depositDebug = 'empty-initdata'; return; }
      const res = await fetch(SERVER_URL + '/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData })
      });
      if (!res.ok) {
        let msg = 'auth-http-' + res.status;
        try { const errData = await res.json(); if (errData && errData.error) msg = errData.error; } catch(e2){}
        window.__depositDebug = msg;
        throw new Error(msg);
      }
      const data = await res.json();
      serverSession.token = data.token;
      serverSession.online = true;
      window.__depositDebug = 'ok';
      applyServerState(data.state);
      syncWithdrawalStatuses();
    } catch (e) {
      if (!window.__depositDebug) window.__depositDebug = 'fetch-error: ' + (e && e.message);
      serverSession.online = false; // fall back to local economy silently
    } finally {
      loadDepositMemo();
    }
  }

  /* ================= DEPOSIT MEMO CODE ================= */
  async function loadDepositMemo(){
    const memoEl = document.getElementById('depositMemo');
    if (!memoEl) return;
    if (!serverSession.online || !serverSession.token){
      memoEl.textContent = t('depositMemoUnavailable');
      return;
    }
    try {
      const res = await fetch(SERVER_URL + '/api/deposit-info?token=' + encodeURIComponent(serverSession.token));
      if (!res.ok) throw new Error('deposit-info-http-' + res.status);
      const data = await res.json();
      memoEl.textContent = data.memo;
      if (data.address){
        const addrEl = document.getElementById('depositAddress');
        if (addrEl) addrEl.textContent = data.address;
      }
    } catch (e) {
      memoEl.textContent = t('depositMemoUnavailable');
    }
  }

  function applyServerState(state){
    store.coins = state.coins;
    store.points = state.ton;
    store.pointsToday = state.tonToday;
    store.pointsDate = todayStr();
    store.best = Math.max(store.best, state.best);
    store.runs = Math.max(store.runs, state.runs);
    saveStore();
    refreshTopUI();
  }

  async function exchangePersons(){
    if (lastPersonScore <= 0) return;

    if (serverSession.online && serverSession.token){
      const exchangeBtn = document.getElementById('exchangeBtn');
      exchangeBtn.disabled = true;
      try {
        const res = await fetch(SERVER_URL + '/api/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: serverSession.token,
            distance: lastDistance,
            zombies: lastPersonScore
          })
        });
        const data = await res.json();
        if (res.ok){
          applyServerState(data.state);
          lastPersonScore = 0;
          lastDistance = 0;
        }
        // on error (e.g. rate-limited), keep lastPersonScore so the user can retry
      } catch (e) {
        // network hiccup -> keep the pending score, user can retry the exchange
      }
      exchangeBtn.disabled = lastPersonScore <= 0;
      refreshTopUI();
      return;
    }

    // offline / no server configured: fall back to the local-only economy
    const coinsGained = lastPersonScore * 2;
    store.coins += coinsGained;
    addPointsFromCoins(coinsGained);
    lastPersonScore = 0;
    lastDistance = 0;
    saveStore();
    refreshTopUI();
  }
  document.getElementById('exchangeBtn').addEventListener('click', exchangePersons);

  /* ================= WITHDRAW (TON) ================= */
  const MIN_WITHDRAW = 1;
  function renderWithdrawUI(){
    const balEl = document.getElementById('withdrawBalance');
    if (balEl) balEl.textContent = store.points.toFixed(6);
    const histEl = document.getElementById('withdrawHistory');
    if (!histEl) return;
    histEl.innerHTML = '';
    store.withdrawals.slice().reverse().slice(0, 5).forEach(w => {
      const row = document.createElement('div');
      row.className = 'withdraw-hist-item';
      const statusKey = w.status === 'completed' ? 'withdrawCompletedStatus' : 'withdrawPendingStatus';
      row.innerHTML =
        '<span class="hist-amount">' + w.amount.toFixed(2) + ' TON</span>' +
        '<span>' + w.address.slice(0, 4) + '…' + w.address.slice(-4) + '</span>' +
        '<span class="hist-status ' + w.status + '">' + t(statusKey) + '</span>';
      histEl.appendChild(row);
    });
  }
  function setWithdrawStatus(msg, cls){
    const el = document.getElementById('withdrawStatus');
    if (!el) return;
    el.textContent = msg;
    el.className = 'withdraw-status' + (cls ? ' ' + cls : '');
  }
  function isPlausibleTonAddress(addr){
    return typeof addr === 'string' && addr.trim().length >= 10 && !/\s/.test(addr.trim());
  }
  async function requestWithdraw(){
    const addressInput = document.getElementById('withdrawAddress');
    const amountInput = document.getElementById('withdrawAmount');
    const address = addressInput.value.trim();
    const amount = parseFloat(amountInput.value);
    const btn = document.getElementById('withdrawBtn');

    if (!isPlausibleTonAddress(address)){
      setWithdrawStatus(t('withdrawErrAddress'), 'error');
      return;
    }
    if (!amount || amount < MIN_WITHDRAW){
      setWithdrawStatus(t('withdrawErrMin'), 'error');
      return;
    }
    if (amount > store.points){
      setWithdrawStatus(t('withdrawErrFunds'), 'error');
      return;
    }

    btn.disabled = true;
    let handledByServer = false;
    let serverWithdrawal = null;
    if (serverSession.online && serverSession.token){
      try {
        const res = await fetch(SERVER_URL + '/api/withdraw', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: serverSession.token, address, amount })
        });
        if (res.ok){
          const data = await res.json();
          if (data.state) applyServerState(data.state);
          else store.points -= amount;
          if (data.withdrawal) serverWithdrawal = data.withdrawal;
          handledByServer = true;
        }
      } catch (e) {
        // fall through to local pending-request handling below
      }
    }
    if (!handledByServer){
      store.points -= amount;
    }
    // Use the server's own withdrawal record (same ts the admin panel uses)
    // whenever we have one, so later status syncs can match it up.
    store.withdrawals.push(serverWithdrawal || { address, amount, status: 'pending', ts: Date.now() });
    saveStore();
    setWithdrawStatus(t('withdrawSuccess'), 'success');
    amountInput.value = '';
    refreshTopUI();
    btn.disabled = false;
  }
  document.getElementById('withdrawBtn').addEventListener('click', requestWithdraw);

  // Poll the server for updated withdrawal statuses (picks up when an admin
  // marks a withdrawal 'completed' after paying it out manually) and merge
  // them into the local history by matching on ts.
  let withdrawSyncInFlight = false;
  async function syncWithdrawalStatuses(){
    if (withdrawSyncInFlight) return;
    if (!serverSession.online || !serverSession.token) return;
    if (!store.withdrawals || !store.withdrawals.length) return;
    withdrawSyncInFlight = true;
    try {
      const res = await fetch(SERVER_URL + '/api/withdrawals?token=' + encodeURIComponent(serverSession.token));
      if (res.ok){
        const data = await res.json();
        const serverList = (data && data.withdrawals) || [];
        let changed = false;
        store.withdrawals.forEach(local => {
          const match = serverList.find(sw => sw.ts === local.ts);
          if (match && match.status !== local.status){
            local.status = match.status;
            changed = true;
          }
        });
        if (changed){
          saveStore();
          renderWithdrawUI();
        }
      }
    } catch (e) {
      // network hiccup - just retry on the next interval
    } finally {
      withdrawSyncInFlight = false;
    }
  }
  setInterval(syncWithdrawalStatuses, 20000);

  /* ================= DEPOSIT (TON) ================= */
  document.getElementById('depositCopyBtn').addEventListener('click', async () => {
    const address = document.getElementById('depositAddress').textContent.trim();
    const statusEl = document.getElementById('depositStatus');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText){
        await navigator.clipboard.writeText(address);
      } else {
        const ta = document.createElement('textarea');
        ta.value = address;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      statusEl.textContent = t('depositCopied');
      statusEl.className = 'withdraw-status success';
    } catch (e) {
      statusEl.textContent = address;
      statusEl.className = 'withdraw-status';
    }
  });

  document.getElementById('depositMemoCopyBtn').addEventListener('click', async () => {
    const memo = document.getElementById('depositMemo').textContent.trim();
    const statusEl = document.getElementById('depositStatus');
    if (!memo || memo === '—') return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText){
        await navigator.clipboard.writeText(memo);
      } else {
        const ta = document.createElement('textarea');
        ta.value = memo;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      statusEl.textContent = t('depositMemoCopied');
      statusEl.className = 'withdraw-status success';
    } catch (e) {
      statusEl.textContent = memo;
      statusEl.className = 'withdraw-status';
    }
  });

  /* ================= WALLET TABS (Deposit / Withdraw) ================= */
  (function(){
    const tabDeposit = document.getElementById('walletTabDeposit');
    const tabWithdraw = document.getElementById('walletTabWithdraw');
    const panelDeposit = document.getElementById('walletPanelDeposit');
    const panelWithdraw = document.getElementById('walletPanelWithdraw');
    function setWalletTab(tab){
      const isDeposit = tab === 'deposit';
      tabDeposit.classList.toggle('active', isDeposit);
      tabWithdraw.classList.toggle('active', !isDeposit);
      panelDeposit.classList.toggle('active', isDeposit);
      panelWithdraw.classList.toggle('active', !isDeposit);
    }
    tabDeposit.addEventListener('click', () => setWalletTab('deposit'));
    tabWithdraw.addEventListener('click', () => { setWalletTab('withdraw'); syncWithdrawalStatuses(); });
  })();

