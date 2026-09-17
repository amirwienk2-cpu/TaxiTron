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

## Deployment

Deploy this repository to any Node.js host. The backend is the root-level
`server.js`; set `PORT` if your host does not provide one, and use persistent
storage for `DATA_DIR`.

Set `BOT_TOKEN`, `SESSION_SECRET`, `ADMIN_SECRET`, `PLATFORM_USER_ID`, and the
economy variables listed below. For Monster Crash voice chat, create a LiveKit
Cloud project and set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and
`LIVEKIT_API_SECRET`. LiveKit Cloud provides the media and TURN infrastructure;
no Railway or separate TURN configuration is required. Use an HTTPS public
domain for the Mini App so Telegram can grant microphone access.

Set `SERVER_URL` in `app.js`, plus `MINI_APP_URL` and
`TELEGRAM_WEBHOOK_URL` in the deployment environment, to your public domain.
Set `ADMIN_SECRET` and open `/admin` to review and complete manual payouts.

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
