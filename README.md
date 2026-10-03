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
npm run dev
```
