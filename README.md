# TaxiTron server

Node.js/Express backend for the TaxiTron game. Handles Telegram login,
the coin → TON economy (2 coins per zombie, 10,000 coins = 0.01 TON,
capped at 1 TON/day per player), deposits/withdrawals, and a weekly
tournament leaderboard (resets Sunday 00:00 Europe/Berlin).

This matches the `SERVER_URL` calls already baked into `index.html` —
no client changes needed, just deploy this and point `SERVER_URL` at it.

## Setup

```bash
cd server
npm install
cp .env.example .env   # then fill in BOT_TOKEN, SESSION_SECRET, ADMIN_SECRET
npm start
```

## Deploying on Railway

1. Push this `server/` folder to your GitHub repo (same repo as the game
   is fine — Railway just needs a Root Directory / start command pointing
   at it).
2. Add a Volume, mount it at `/data`.
3. Set environment variables: `BOT_TOKEN`, `SESSION_SECRET`,
   `ADMIN_SECRET`, `DATA_DIR=/data`, optionally `DEPOSIT_ADDRESS`.
4. Deploy. Railway provides `PORT` automatically.
5. In `index.html`, make sure `SERVER_URL` points at the Railway domain.

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
