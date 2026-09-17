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
| POST   | /api/submit-score     | `{ token, distance, zombies }`         | `{ ok: true }` |
| GET    | /api/leaderboard      | `?token=` (optional)                   | `{ top: [...], you }` |

`state` is always `{ coins, ton, tonToday, best, runs }`.

Deposits are scanned automatically every 30 seconds through TonAPI. Set
`DEPOSIT_ADDRESS`, `TONAPI_URL`, and optionally `DEPOSIT_POLL_MS` in the
deployment environment. Deposits must include the personal `TT-<Telegram ID>`
comment; each transaction is credited only once.

RPS games use `PLATFORM_USER_ID` as the Telegram user ID that receives the
10% fee from completed non-tie games. The winner receives the remaining 90%
of the two-player pot; ties return both original stakes.

## Admin (manual payouts)

Send these with header `x-admin-secret: <ADMIN_SECRET>`:

- `GET /admin/stats` — totals + list of pending withdrawals
- `GET /admin/withdrawals?status=pending` — filterable withdrawal list
- `POST /admin/withdrawals/complete` with `{ uid, ts }` — mark a
  withdrawal `completed` once you've paid it out by hand

## Notes

- Storage is a single `users.json` file in `DATA_DIR` — fine at this
  game's scale, and simple to inspect/back up by hand. Writes are
  serialised so concurrent requests can't corrupt the file.
- Session tokens are self-contained (HMAC-signed with `SESSION_SECRET`),
  so a server restart never logs players out — no session store needed.
- Anti-cheat is intentionally minimal (per-call ceilings on zombies/
  distance). If this ever matters for real money, tighten it further.
