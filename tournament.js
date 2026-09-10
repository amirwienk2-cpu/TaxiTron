  /* ================= TOURNAMENT ================= */
  async function fetchLeaderboard(){
    if (!SERVER_URL) return null;
    try {
      let url = SERVER_URL + '/api/leaderboard';
      if (serverSession.online && serverSession.token) url += '?token=' + encodeURIComponent(serverSession.token);
      const res = await fetch(url);
      if (!res.ok) throw new Error('leaderboard-http-' + res.status);
      return await res.json();
    } catch (e) {
      return null; // offline / server unreachable -> caller falls back to local-only view
    }
  }
  async function renderLeaderboard(){
    const list = document.getElementById('leaderboardList');
    const data = await fetchLeaderboard();
    let entries;
    if (data && Array.isArray(data.top)) {
      entries = data.top.map(e => ({ name: e.name, avatar: '🧟', score: e.best, me: false }));
      if (data.you) {
        if (data.you.rank >= 1 && data.you.rank <= entries.length) {
          entries[data.you.rank - 1].name = t('youName');
          entries[data.you.rank - 1].avatar = '🚕';
          entries[data.you.rank - 1].me = true;
        } else {
          entries.push({ name: t('youName'), avatar: '🚕', score: data.you.best, me: true });
        }
      } else if (entries.length === 0) {
        entries.push({ name: t('youName'), avatar: '🚕', score: best, me: true });
      }
    } else {
      // no real data available (offline / not authenticated yet) -> local-only fallback
      entries = [{ name: t('youName'), avatar: '🚕', score: best, me: true }];
    }
    entries.sort((a, b) => b.score - a.score);
    list.innerHTML = '';
    entries.forEach((e, i) => {
      const rank = i+1;
      const row = document.createElement('div');
      row.className = 'lb-row' + (e.me ? ' me' : '');
      const rankClass = rank===1?'r1':rank===2?'r2':rank===3?'r3':'';
      row.innerHTML =
        '<div class="lb-rank ' + rankClass + '">' + rank + '</div>' +
        '<div class="lb-avatar">' + e.avatar + '</div>' +
        '<div class="lb-name">' + e.name + (e.me ? '<span class="you-tag">' + t('youTag') + '</span>' : '') + '</div>' +
        '<div class="lb-score">' + e.score + ' 🧟</div>';
      list.appendChild(row);
    });
  }
  function berlinOffsetMinutes(date){
    // Difference between Europe/Berlin wall-clock time and UTC wall-clock
    // time for the same instant (handles CET/CEST automatically).
    const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
    const berlinStr = date.toLocaleString('en-US', { timeZone: 'Europe/Berlin' });
    return (new Date(berlinStr) - new Date(utcStr)) / 60000;
  }
  function getNextBerlinSundayMidnight(now){
    const offsetMin = berlinOffsetMinutes(now);
    const berlinNow = new Date(now.getTime() + offsetMin * 60000);
    const dow = berlinNow.getUTCDay(); // 0 = Sunday, using UTC getters on the shifted date = Berlin wall clock
    const daysUntilSunday = (7 - dow) % 7;
    let target = new Date(Date.UTC(
      berlinNow.getUTCFullYear(), berlinNow.getUTCMonth(), berlinNow.getUTCDate() + daysUntilSunday, 0, 0, 0, 0
    ));
    if (target <= berlinNow) target = new Date(target.getTime() + 7 * 86400000);
    // Convert the Berlin wall-clock target back to a real UTC instant.
    const targetOffsetMin = berlinOffsetMinutes(new Date(target.getTime() - offsetMin * 60000));
    return new Date(target.getTime() - targetOffsetMin * 60000);
  }
  function updateTournamentCountdown(){
    const now = new Date();
    const nextReset = getNextBerlinSundayMidnight(now);
    let diff = Math.max(0, nextReset - now);
    const totalMinutes = Math.floor(diff / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = String(Math.floor((totalMinutes % 1440) / 60)).padStart(2, '0');
    const minutes = String(totalMinutes % 60).padStart(2, '0');
    const el = document.getElementById('tournamentCountdown');
    if (el) el.textContent = days + t('dayUnit') + ' ' + hours + t('hourUnit') + ' ' + minutes + t('minuteUnit');
  }
  setInterval(updateTournamentCountdown, 1000);

  function refreshTopUI(){
    ensureDailyReset();
    document.getElementById('topCoinDisplay').textContent = store.coins;
    document.getElementById('homeCoins').textContent = store.coins;
    document.getElementById('homeBest').textContent = store.best;
    document.getElementById('homeRuns').textContent = store.runs;
    document.getElementById('homeLevel').innerHTML = store.level + '<small>·' + LEVEL_MULTIPLIER + '</small>';
    document.getElementById('walletCoinsDisplay').textContent = store.coins;
    document.getElementById('walletTonDisplay').textContent = store.points.toFixed(6);
    document.getElementById('walletPersonsDisplay').textContent = lastPersonScore;
    document.getElementById('exchangePreview').textContent = lastPersonScore * 2;
    document.getElementById('exchangeBtn').disabled = lastPersonScore <= 0;

    document.getElementById('balanceValue').textContent = store.points.toFixed(6);
    const pct = Math.min(100, Math.round((store.pointsToday / DAILY_PTS_CAP) * 100));
    document.getElementById('capPercent').textContent = pct + '%';
    document.getElementById('capFill').style.width = pct + '%';
    document.getElementById('capSub').innerHTML =
      store.pointsToday.toFixed(6) + ' / ' + DAILY_PTS_CAP.toFixed(6) + ' TON ' +
      t('today') + ' · ' + t('statLevel') + ' ' + store.level;

    refreshShopUI();
    renderSkinShop();
    renderLeaderboard();
    renderAttemptsUI();
    renderWithdrawUI();
  }

  let lastPersonScore = 0;
  let lastDistance = 0;

