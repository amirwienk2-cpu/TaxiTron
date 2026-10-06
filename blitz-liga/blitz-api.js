// blitz-api.js - connects blitz-liga/index.html to the TaxiTon backend.
// Rewritten (not 1:1 - this file is explicitly meant to be adapted, see
// blitz-liga/AGENT_PROMPT.md point 2) to use TaxiTon's real Telegram login
// instead of the sample's X-User-Id header, and to add matchResult() so
// index.html can fetch secret-seeded results instead of computing them
// locally (point 5 of the prompt).
//
// In index.html this is included right after <body>:
// <script src="blitz-api.js"></script>
(function () {
  const BASE = "/api/blitz";
  // Keep Date.now() in sync with the server so every device sees the exact
  // same match/phase at the exact same millisecond.
  const _now = Date.now.bind(Date); let offset = 0;
  fetch(BASE + "/time").then(r => r.json()).then(d => { offset = d.now - _now(); }).catch(() => {});
  Date.now = () => _now() + offset;

  const tg = window.Telegram && window.Telegram.WebApp;
  const initData = (tg && tg.initData) || "";
  const tgUser = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
  // Only used as a local display/bookkeeping id - the server never trusts
  // this value, it independently re-verifies `initData` (HMAC with the bot
  // token) on every request below.
  const myId = tgUser ? String(tgUser.id) : (localStorage.getItem("blitz-test-id") || (() => {
    const id = "demo-" + Math.random().toString(36).slice(2, 9);
    localStorage.setItem("blitz-test-id", id);
    return id;
  })());
  const headers = { "Content-Type": "application/json", "X-Telegram-Init-Data": initData };

  let names = {};
  async function get(p) { const r = await fetch(BASE + p, { headers }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }

  window.BLITZ_API = {
    userId: async () => myId,
    loadMe: async () => (await get("/me")).doc,
    saveMe: async (doc) => {
      const r = await fetch(BASE + "/me", { method: "PUT", headers, body: JSON.stringify({ tips: doc.tips }) });
      if (!r.ok) throw new Error(String(r.status));
    },
    names: async (ids) => { const o = {}; for (const i of ids) o[i] = names[i] || ""; return o; },
    subscribe: (cb) => {
      const tick = async () => { try { const d = await get("/docs"); names = d.names || {}; cb(d.docs || {}); } catch (e) {} };
      tick(); setInterval(tick, 3000);
    },
    // Secret-seeded authoritative match result. Only ever resolves to a full
    // {id,h,a,sh,sa,gh,ga,ev,...} object once the server has actually
    // revealed it (i.e. at/after kickoff) - resolves to null before that, so
    // index.html's match() keeps showing the safe teams-only placeholder.
    matchResult: async (id) => {
      try {
        const r = await fetch(BASE + "/match/" + id, { cache: "no-store" });
        if (!r.ok) return null;
        const d = await r.json();
        return Number.isFinite(d && d.gh) ? d : null;
      } catch (e) { return null; }
    },
  };
})();
