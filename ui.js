import { Api } from './api.js';
import { AppState } from './state.js';
import { Telegram } from './telegram.js';

const $ = (id) => document.getElementById(id);
const screens = {
  menu: $('screen-menu'),
  summary: $('screen-summary'),
  wallet: $('screen-wallet'),
  leaderboard: $('screen-leaderboard'),
  loader: $('screen-loader'),
};
const hud = $('hud');

let backStack = [];

function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.add('hidden'));
  hud.classList.add('hidden');
  if (screens[name]) screens[name].classList.remove('hidden');

  if (name === 'menu') {
    Telegram.hideBack();
    backStack = [];
  } else if (name !== 'summary') {
    Telegram.showBack();
  }
}

function fmtTon(n) {
  return Number(n || 0).toFixed(6);
}

export function initUI({ onPlay }) {
  AppState.subscribe((s) => {
    $('menu-coins').textContent = s.coins;
    $('menu-ton').textContent = fmtTon(s.ton);
    $('wallet-coins').textContent = s.coins;
    $('wallet-ton').textContent = fmtTon(s.ton);
    $('wallet-today').textContent = fmtTon(s.tonToday);
    $('wallet-cap').textContent = fmtTon(s.dailyCap);
  });

  $('btn-play').addEventListener('click', () => {
    Telegram.haptic('medium');
    showScreen('menu'); // HUD wird von main.js separat eingeblendet
    onPlay();
  });

  $('btn-wallet').addEventListener('click', () => openWallet());
  $('btn-leaderboard').addEventListener('click', () => openLeaderboard());

  document.querySelectorAll('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => showScreen('menu'));
  });
  Telegram.onBack(() => showScreen('menu'));

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
      $(`tab-${btn.dataset.tab}`).classList.remove('hidden');
    });
  });

  document.querySelectorAll('.btn-copy').forEach((btn) => {
    btn.addEventListener('click', () => {
      const text = $(btn.dataset.copy).textContent;
      navigator.clipboard?.writeText(text).catch(() => {});
      btn.textContent = 'Kopiert';
      setTimeout(() => { btn.textContent = 'Kopieren'; }, 1200);
    });
  });

  $('btn-withdraw-submit').addEventListener('click', submitWithdraw);
}

export function showLoader(text) {
  $('loader-text').textContent = text;
  showScreen('loader');
}

export function showMenu() {
  showScreen('menu');
}

export function showHud() {
  Object.values(screens).forEach((el) => el.classList.add('hidden'));
  hud.classList.remove('hidden');
}

export function updateHud({ distance, zombies, timeFraction }) {
  $('hud-distance').textContent = distance;
  $('hud-zombies').textContent = zombies;
  $('hud-timer-bar').style.transform = `scaleX(${timeFraction})`;
}

export function showSummary({ distance, zombies }, onRedeem) {
  showScreen('summary');
  $('sum-distance').textContent = `${distance} m`;
  $('sum-zombies').textContent = zombies;
  $('redeem-result').classList.add('hidden');
  const redeemBtn = $('btn-redeem');
  const continueBtn = $('btn-summary-continue');
  redeemBtn.classList.remove('hidden');
  continueBtn.classList.add('hidden');
  redeemBtn.disabled = false;
  redeemBtn.textContent = 'Einlösen';

  redeemBtn.onclick = async () => {
    redeemBtn.disabled = true;
    redeemBtn.textContent = 'Wird eingelöst…';
    try {
      const result = await onRedeem();
      $('redeem-coins').textContent = `+${result.coinsGained}`;
      $('redeem-ton').textContent = `+${fmtTon(result.tonGained)}`;
      $('redeem-result').classList.remove('hidden');
      redeemBtn.classList.add('hidden');
      continueBtn.classList.remove('hidden');
      Telegram.notify('success');
    } catch (err) {
      redeemBtn.disabled = false;
      redeemBtn.textContent = 'Erneut versuchen';
      Telegram.notify('error');
    }
  };
  continueBtn.onclick = () => showScreen('menu');
}

async function openWallet() {
  showScreen('wallet');
  try {
    const info = await Api.depositInfo();
    $('deposit-address').textContent = info.address;
    $('deposit-memo').textContent = info.memo;
    await refreshWithdrawHistory();
  } catch (err) {
    $('withdraw-status').textContent = err.message;
  }
}

async function refreshWithdrawHistory() {
  const list = $('withdraw-history');
  try {
    const items = await Api.withdrawals();
    list.innerHTML = items.length
      ? items.slice().reverse().map((w) => `
          <div class="history-row">
            <span>${fmtTon(w.amount)} TON</span>
            <span class="status-${w.status}">${w.status === 'completed' ? 'ausgezahlt' : 'ausstehend'}</span>
          </div>`).join('')
      : '<p class="hint">Noch keine Auszahlungen.</p>';
  } catch (err) {
    list.innerHTML = `<p class="hint">${err.message}</p>`;
  }
}

async function submitWithdraw() {
  const status = $('withdraw-status');
  const address = $('withdraw-address').value.trim();
  const amount = Number($('withdraw-amount').value);
  status.textContent = '';
  const btn = $('btn-withdraw-submit');
  btn.disabled = true;
  try {
    const res = await Api.withdraw(address, amount);
    AppState.set(res.state);
    status.style.color = 'var(--toxic)';
    status.textContent = 'Auszahlung angefordert.';
    $('withdraw-address').value = '';
    $('withdraw-amount').value = '';
    await refreshWithdrawHistory();
    Telegram.notify('success');
  } catch (err) {
    status.style.color = 'var(--rust)';
    status.textContent = err.message;
    Telegram.notify('error');
  } finally {
    btn.disabled = false;
  }
}

async function openLeaderboard() {
  showScreen('leaderboard');
  const list = $('leaderboard-list');
  const youBox = $('leaderboard-you');
  list.innerHTML = '<p class="hint">Lädt…</p>';
  try {
    const { top, you } = await Api.leaderboard();
    list.innerHTML = top.length
      ? top.map((row, i) => `
          <div class="lb-row">
            <span class="lb-rank">${i + 1}</span>
            <span class="lb-name">${escapeHtml(row.name)}</span>
            <span class="lb-best">${row.best}</span>
          </div>`).join('')
      : '<p class="hint">Noch keine Einträge diese Woche.</p>';

    if (you) {
      youBox.classList.remove('hidden');
      youBox.innerHTML = `<span>Dein Rang: #${you.rank}</span><span class="lb-best">${you.best}</span>`;
    } else {
      youBox.classList.add('hidden');
    }
  } catch (err) {
    list.innerHTML = `<p class="hint">${err.message}</p>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
