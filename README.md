# us-recession-chance

US recession early-warning monitor.

Collects leading recession indicators (yield curve, credit spreads, financial
conditions, labor market, housing, composite indexes) from free public APIs —
primarily FRED/ALFRED — evaluates a configurable signal engine, computes a
composite 12-month recession risk estimate, and pushes localized alerts:

- Telegram channels (multiple locales)
- Telegram bot DMs with per-user thresholds and settings
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

| Command                          | What it does                                             |
| -------------------------------- | -------------------------------------------------------- |
| `npm run dev`                    | Run app (MODE=bot\|scheduler\|all, default all)          |
| `npm run build` / `npm start`    | Compile to `dist/` / run compiled app                    |
| `npm run typecheck` / `npm test` | `tsc --noEmit` / vitest                                  |
| `npm run backfill -- <years>`    | Fetch history for all FRED series                        |
| `npm run check-signals`          | Evaluate signals + composite (dry run)                   |
| `npm run send-test`              | Send a test message to configured channels               |
| `npm run digest`                 | Build + send the daily digest once                       |
| `npm run backtest`               | Replay signals vs NBER recessions; calibrate score bands |
| `npm run fit-model`              | Fit pooled 12m logit; print coefs + YAML for model.yaml  |
| `npm run backup`                 | Online SQLite backup to `data/backups/`                  |
| `npm run health`                 | One-off healthcheck report                               |

## Configuration

Everything signal-related is declarative — no thresholds in code:

- `config/sources.yaml` — FRED series, native frequency, history depth.
- `config/signals.yaml` — signal catalog: evaluator type/params, block,
  composite weight, static `hist:` stats (see `scripts/histStats.md`).
- `config/channels.yaml` — locale → chat env mapping, digest time.
- `config/model.yaml` — NY-Fed probit coefs, composite score bands,
  free/plus gating, Stars pricing; `pooled_logit` from `fit-model`.
- `config/locales/*.yaml` — message templates per locale.

## Scheduling

`node-cron` inside the process (`MODE=scheduler|all`):

- daily/weekly/monthly-quart fetches after typical FRED release windows
- signal evaluation + transition alerts after each fetch
- daily digest at `digest_time_utc`
- delivery outbox retries every 15 min (max 5 attempts)
- subscription expiry hourly; healthcheck 06:00 (admin DM on issues);
  weekly SQLite backup (keeps 14)

## Deployment

pm2 (recommended for a small VPS):

```bash
npm ci && npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

Set `FRED_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TG_CHANNEL_*` in `.env`.
Data lives in `DATABASE_PATH` (default `./data/recession.db`, WAL mode);
backups land in `data/backups/`.

Optional channel-only alternative: run `npm run backfill` +
`npm run check-signals` + `npm run digest` from GitHub Actions cron —
no server needed, but no bot interactions then.
