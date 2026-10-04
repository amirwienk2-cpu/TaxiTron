# TaxiTron server

Node.js/Express backend for the TaxiTron game. Handles Telegram login,
the coin → TON economy (2 coins per zombie, 10,000 coins = 0.01 TON,
capped at 1 TON/day per player), deposits/withdrawals, and a weekly
tournament leaderboard (resets Sunday 00:00 Europe/Berlin).

This matches the `SERVER_URL` calls already baked into `index.html` —
no client changes needed, just deploy this and point `SERVER_URL` at it.

## Setup

```bash
npm install
copy .env.example .env   # then fill in the real secret values
npm start
```

## Deploying on Railway

1. Deploy this repository from GitHub. The backend is the root-level
  `server.js`, so leave Railway's Root Directory empty.
2. Add a Volume, mount it at `/data`.
3. Set environment variables: `BOT_TOKEN`, `SESSION_SECRET`,
  `ADMIN_SECRET`, `PLATFORM_USER_ID`, `DATA_DIR=/data`. For Monster Crash
  voice chat, set `TURN_URL`, `TURN_USERNAME`, and `TURN_CREDENTIAL` from a
  private TURN provider. TURN is required for reliable Telegram mobile voice
  chat because many mobile networks cannot connect through STUN alone. Use an
  HTTPS public domain for the Mini App so Telegram can grant microphone access.
  The optional `INVITE_LEADERBOARD_CAMPAIGN_STARTS_AT` and
  `INVITE_LEADERBOARD_CAMPAIGN_ENDS_AT` values set the invite leaderboard
  window as ISO-8601 timestamps.
  The optional `CHAT_LIKE_EVENT_START_AT` and `CHAT_LIKE_EVENT_END_AT` values
  set the three-day chat like event window. A new Like challenge is posted
  immediately on this deployment, then 15–45 minutes after the previous round
  finishes; each post
  has its own 100–1,000 like goal and draws three winners for 0.2 TON each
  when reached. Users can like without a per-round limit; repeated likes
  increase their weighted chance, while each winner is a different user.
  The like counter updates live; regular chat messages and reactions are
  disabled while any challenge is unresolved and reopen after its winners are
  selected. Each winner's 0.2 TON reward is credited to their account balance.
4. Deploy. Railway provides `PORT` automatically.
5. In `app.js`, make sure `SERVER_URL` points at the Railway domain.
  The current production fallback is `https://taxitron-production.up.railway.app`.
6. Set `ADMIN_SECRET` and open `/admin` to review and complete manual payouts.

Railway's generated public domain must be configured in the service's
Networking settings. If you use a different domain, update the `SERVER_URL`
fallback in `app.js` and the default `MINI_APP_URL` and `TELEGRAM_WEBHOOK_URL`
values in `server.js` before deploying.

## API

| Method | Path                  | Body / Query                          | Returns |
|--------|-----------------------|----------------------------------------|---------|
| POST   | /api/auth             | `{ initData }`                         | `{ token, state }` |
| GET    | /api/deposit-info     | `?token=`                              | `{ memo, address }` |
| POST   | /api/run              | `{ token, distance, zombies }`         | `{ state }` |
| POST   | /api/withdraw         | `{ token, address, amount }`           | `{ state, withdrawal }` |
| GET    | /api/withdrawals      | `?token=`                              | `{ withdrawals: [...] }` |
| GET    | /api/tt/withdraw-info | `?token=`                              | `{ available, minWithdraw, cooldownMs }` |
| POST   | /api/tt/withdraw      | `{ token, address, amount }`           | `{ state, withdrawal }` |
| GET    | /api/tt/withdrawals   | `?token=`                              | `{ withdrawals: [...] }` |
| POST   | /api/submit-score     | `{ token, distance, zombies }`         | `{ ok: true }` |
| GET    | /api/leaderboard      | `?token=` (optional)                   | `{ top: [...], you }` |

`state` is always `{ coins, ton, tonToday, best, runs }`.

Deposits are scanned automatically every 30 seconds through TonAPI. Set
`DEPOSIT_ADDRESS`, `TONAPI_URL`, and optionally `DEPOSIT_POLL_MS` in the
deployment environment. Deposits must include the personal `TT<Telegram ID>`
comment (without a dash); each transaction is credited only once. Legacy
`TT-<Telegram ID>` comments are still accepted for previously sent transfers.

RPS games use `PLATFORM_USER_ID` as the Telegram user ID that receives the
10% fee from completed non-tie games. The winner receives the remaining 90%
of the two-player pot; ties return both original stakes.

## TT jetton withdrawals (on-chain payouts)

Players' in-game `ttBalance` can optionally be withdrawn on-chain as the real
TT jetton to any TON wallet the player connects via TON Connect (e.g.
Tonkeeper). This is entirely separate from the TON withdrawal above and from
`/api/tt-shop/order` (the manual "sell TT for other crypto" flow) - it is a
direct jetton transfer sent by the server's own treasury wallet.

**Setup (Railway env vars):**

- `TREASURY_MNEMONIC` - the treasury wallet's 24-word seed phrase. Only ever
  set this as a Railway variable; it is never read from, or written to, any
  file in this repo, never logged, and never sent to the client.
- `TT_JETTON_MASTER` - the TT jetton master contract address.
- `TREASURY_ADDRESS` - the treasury wallet's own address (W5 /
  `WalletContractV5R1`). On startup the server derives the address from
  `TREASURY_MNEMONIC` and refuses to enable withdrawals if it doesn't match
  this value.
- `TONCENTER_URL` / `TONCENTER_API_KEY` - the RPC endpoint used to read
  balances and broadcast transfers.
- `TT_WITHDRAW_ENABLED` (default `false`) - the master on/off switch.
- `TT_WITHDRAW_ADMIN_ONLY` (default `true`) + `TT_WITHDRAW_ALLOWLIST`
  (comma-separated Telegram IDs) - while admin-only is on, only allowlisted
  IDs can withdraw TT, so the feature can be tested live with one real
  account before opening it to everyone else (just flip
  `TT_WITHDRAW_ADMIN_ONLY` to `false` once you're confident).
- `TT_MIN_WITHDRAW` (default `30000` TT), `TT_WITHDRAW_COOLDOWN_MS` (default
  24h, one withdrawal per user per window), `TT_GLOBAL_DAILY_LIMIT` (default
  `500000` TT/day across all users combined).
- `TT_WITHDRAW_GAS_TON` / `TT_MIN_TREASURY_TON_RESERVE` - gas paid by the
  treasury for every send, and the minimum TON balance it must keep as a
  safety reserve. Withdrawals are refused (and the treasury balance warning
  shows in `/admin`) whenever either reserve would be breached.

**Safety behaviour:**

- `ttBalance` is only ever changed by server code (all the mining/task/game
  reward code paths), never by client input. A parallel lifetime-credited
  ledger (`ttCreditedLifetime`) is checked before every withdrawal
  (`ttBalance + alreadyWithdrawn <= everCredited`); a mismatch blocks the
  withdrawal and alerts the admin instead of paying out.
- Exactly one TT withdrawal per user may be in flight at a time, and all
  withdrawals (regardless of user) are processed one at a time through a
  single queue, since they all come from the same treasury wallet.
- A withdrawal is only marked `completed` once the treasury's on-chain TT
  balance is confirmed to have actually dropped by the sent amount - never
  just because the message was accepted. If that can't be confirmed (e.g. a
  server restart mid-send), it's marked `needs-review` and surfaced in
  `/admin` instead of being auto-completed or auto-refunded, to avoid both
  wrongly double-paying and wrongly refunding money that already left.

## Admin (manual payouts)

Send these with header `x-admin-secret: <ADMIN_SECRET>`:

- `GET /admin/stats` — totals + list of pending withdrawals
- `GET /admin/withdrawals?status=pending` — filterable withdrawal list
- `POST /admin/withdrawals/complete` with `{ uid, ts }` — mark a
  withdrawal `completed` once you've paid it out by hand
- `GET /admin/tt-treasury-status` — treasury readiness, TON/TT balances,
  today's TT withdrawal total vs. the daily limit
- `GET /admin/tt-withdrawals?status=` — all TT withdrawals (also shown in
  the `/admin` panel's "TT-Auszahlungen (Chain)" button)
- `POST /admin/tt-withdrawals/resolve` with `{ uid, ts, action }`
  (`action` is `complete` or `refund`) — manually resolve a `needs-review`
  withdrawal after checking the real chain state on Tonviewer

## Notes

- Storage is a single `users.json` file in `DATA_DIR` — fine at this
  game's scale, and simple to inspect/back up by hand. Writes are
  serialised so concurrent requests can't corrupt the file.
- Session tokens are self-contained (HMAC-signed with `SESSION_SECRET`),
  so a server restart never logs players out — no session store needed.
- Anti-cheat is intentionally minimal (per-call ceilings on zombies/
  distance). If this ever matters for real money, tighten it further.
