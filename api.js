// Dünner Wrapper um alle Endpunkte aus server.js.
// API_BASE muss auf die URL zeigen, unter der server.js läuft (siehe README).

export const API_BASE = window.__COIN_RUNNER_API_BASE__ || '';

const TOKEN_KEY = 'coinrunner.token';

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
function setToken(t) {
  localStorage.setItem(TOKEN_KEY, t);
}
function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const url = new URL(API_BASE + path, window.location.href);
  const opts = { method, headers: {} };

  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(auth ? { ...body, token: getToken() } : body);
  } else if (auth && method === 'GET') {
    url.searchParams.set('token', getToken() || '');
  }

  const res = await fetch(url.toString(), opts);
  let data;
  try { data = await res.json(); } catch (e) { data = {}; }

  if (!res.ok) {
    const err = new Error(data.error || `Anfrage fehlgeschlagen (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const Api = {
  hasToken: () => !!getToken(),
  clearToken,

  async auth(initData) {
    const data = await request('/api/auth', { method: 'POST', body: { initData }, auth: false });
    setToken(data.token);
    return data.state;
  },

  state: () => request('/api/state').then((d) => d.state),

  depositInfo: () => request('/api/deposit-info'),

  leaderboard: () => request('/api/leaderboard'),

  run: (distance, zombies) =>
    request('/api/run', { method: 'POST', body: { distance, zombies } }),

  submitScore: (distance, zombies) =>
    request('/api/submit-score', { method: 'POST', body: { distance, zombies } }),

  withdraw: (address, amount) =>
    request('/api/withdraw', { method: 'POST', body: { address, amount } }),

  withdrawals: () => request('/api/withdrawals').then((d) => d.withdrawals),
};
