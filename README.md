# us-recession-chance

US recession early-warning monitor.

Collects leading recession indicators (yield curve, credit spreads, financial
conditions, labor market, housing, composite indexes) from free public APIs —
primarily FRED/ALFRED — evaluates a configurable signal engine, computes a
composite 12-month recession risk estimate, and pushes localized alerts:

- Telegram channels (multiple locales) — daily + weekly digests only
- Telegram bot DMs: free = digests; Plus = instant transition & nowcast
  alerts, personal score threshold, per-signal analytics, custom digest time
- Later: X/Twitter, email, other channels via a publisher abstraction

Status: early development. See `PLAN.md` for the roadmap and `DEVLOG.md` for
progress.

## Disclaimer

This project publishes informational and educational data only. It is not
investment, financial, or legal advice. Historical signal frequencies do not
guarantee future results.

## Setup

```bash
npm install
cp .env.example .env   # fill in FRED_API_KEY, TELEGRAM_BOT_TOKEN
npm run backfill -- 60 # load ~60y of FRED history (one-time)
npm run dev            # MODE=all: bot + scheduler
```

## Commands

| Command                          | What it does                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `npm run dev`                    | Run app (MODE=bot\|scheduler\|all, default all)                                |
| `npm run build` / `npm start`    | Compile to `dist/` / run compiled app                                          |
| `npm run typecheck` / `npm test` | `tsc --noEmit` / vitest                                                        |
| `npm run backfill -- <years>`    | Fetch history for all FRED series                                              |
| `npm run check-signals`          | Evaluate signals + composite (dry run)                                         |
| `npm run send-test`              | Send a test message to configured channels                                     |
| `npm run devsub -- <cmd> [args]` | Dev subscription lifecycle: `grant`/`refund`/`expire`/`status` (no Telegram)   |
| `npm run digest`                 | Build + send the daily digest once                                             |
| `npm run backtest`               | Replay signals vs NBER recessions; `--vintage` compares latest vs ALFRED as-of |
| `npm run vintages -- [series]`   | Backfill ALFRED vintage deltas for revision-prone series                       |
| `npm run fit-model`              | Fit pooled 12m logit; print coefs + YAML for model.yaml                        |
| `npm run card -- [--ru] [--out]` | Render the weekly PNG card (satori + resvg)                                    |
| `npm run site`                   | Render the GitHub Pages bundle into `site/` (html, data.json, feeds, app/)     |
| `npm run menu-button`            | Install the Mini App menu button (needs `SITE_URL`)                            |
| `npm run backup`                 | Online SQLite backup to `data/backups/`                                        |
| `npm run health`                 | One-off healthcheck report                                                     |

## Configuration

Everything signal-related is declarative — no thresholds in code:

- `config/sources.yaml` — FRED series, native frequency, history depth.
- `config/signals.yaml` — signal catalog: evaluator type/params, block,
  composite weight, static `hist:` stats (see `scripts/histStats.md`).
- `config/channels.yaml` — locale → chat env mapping, digest time.
- `config/model.yaml` — NY-Fed probit coefs, composite score bands,
  free/plus gating, Stars `subscription.tiers` (30/90/365-day plans); `pooled_logit` from `fit-model`.
- `config/locales/*.yaml` — message templates per locale.

## Scheduling

`node-cron` inside the process (`MODE=scheduler|all`):

- daily/weekly/monthly-quart fetches after typical FRED release windows
- signal evaluation + instant alerts to Plus users after each fetch
- daily digest at `digest_time_utc`; weekly digest at
  `weekly_digest_day_utc`/`weekly_digest_time_utc` (channels + users)
- custom per-user digest times checked every 15 min (Plus)
- delivery outbox retries every 15 min (max 5 attempts)
- subscription expiry hourly; healthcheck 06:00 (admin DM on issues);
  weekly SQLite backup (keeps 14)

## Testing Stars payments

Three levels, cheapest first:

1. **No Telegram** — `npm run devsub -- grant <tg_user_id> [days]` writes a
   synthetic payment + activates Plus directly in the DB (mirrors
   `successful_payment`). `refund`/`expire`/`status` cover the rest of the
   lifecycle. Tests gating, prefs, digests, expiry.
2. **Full payment flow** — Telegram test environment: create a separate bot
   via @BotFather _inside_ the test env, put its token in
   `TELEGRAM_BOT_TOKEN`, set `TG_ENV=test` (grammY then uses the test DC).
   Stars purchases are free; invoice → payment → /paysupport refund all work.
3. **Production smoke** — set `STARS_PER_30D=1` (overrides the 30-day tier
   price), buy that tier, self-refund via /paysupport.

## Deployment

pm2 (recommended for a small VPS / home server):

```bash
npm ci && npm run build
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup   # systemd auto-boot (follow the printed command)
```

Set `FRED_API_KEY`, `TELEGRAM_BOT_TOKEN` in `.env`. `TG_CHANNEL_*` is
optional here — channels are only added to the delivery list when their env
vars are set (`getChannelTargets`). To let GitHub Actions own channel posts
and keep the bot on DM duty, omit `TG_CHANNEL_*` on the server.

Update to a new version:

```bash
git pull && npm ci && npm run build && pm2 restart recession-monitor
```

Data lives in `DATABASE_PATH` (default `./data/recession.db`, WAL mode);
backups land in `data/backups/`.

Optional channel-only alternative: run `npm run backfill` +
`npm run check-signals` + `npm run digest` from GitHub Actions cron —
no server needed, but no bot interactions then. Requires the repo secrets
`FRED_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TG_CHANNEL_EN`, `TG_CHANNEL_RU`.

## Publishing (GitHub Actions)

The Actions runner is the **single publishing environment** — the VPS must
not set `TG_CHANNEL_*`, `SYNDICATION_ENABLED` or `CARD_ENABLED`, or posts
double (each environment has its own SQLite, so dedup can't catch it).

- **Weekly PNG card** — `CARD_ENABLED=true` sends a 1200×630 card before
  the weekly text digest (photo-first, dedup via `card_sent_keys`).
- **GitHub Pages** — the `pages` job renders `site/` (localized dashboard,
  `data.{loc}.json`, Atom feeds, Mini App) and deploys it. Set the Pages
  source to "GitHub Actions" once in repo settings, and add the
  `SITE_URL` repo variable (e.g. `https://<user>.github.io/<repo>`).
- **Syndication** — `SYNDICATION_ENABLED=true` publishes the digest to
  Telegraph (linked via "read more"), Bluesky, Mastodon, Discord, Reddit
  (own subreddit) and Buffer (→ X/Threads/LinkedIn). Per-venue secrets in
  `.env.example`; unset secrets simply disable that venue.
- **Self-audit** — runs after the weekly digest under the same gate:
  replays all signals, classifies episodes vs NBER, posts the report.
- **Mini App** — `/dashboard` opens `SITE_URL/app/`; run
  `npm run menu-button` once to put it on the chat menu button.
