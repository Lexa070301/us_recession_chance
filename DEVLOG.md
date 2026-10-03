# DEVLOG

Chronological development log. Newest entries at the top.

## 2026-10-03

### Repository initialized

- Node.js/TypeScript scaffold: ESM, NodeNext, tsx dev runs, vitest, strict TS.
- Deps: `better-sqlite3`, `grammy`, `node-cron`, `yaml`, `zod`, `i18next`, `dotenv`.
- `.env.example`, `.gitignore` (env, data/, dist/), `AGENTS.md`, `README.md`.

### Research summary (pre-code)

- Indicator list validated against Fed research (Richmond Fed EB 19-12,
  FEDS Notes on probit models & OOS performance, SF Fed Letter 2022-36,
  NY Fed yield-curve model). Corrections applied:
  - `JTSQUR` = quits rate, `JTSLDL` = layoffs/discharges (was swapped in draft).
  - ISM PMI and Conference Board LEI are not free via FRED — use OECD `USSLIND`
    and regional Fed surveys as proxies.
  - Added `TEMPHELPS`, `CCSA`, `T10Y2Y`, `RECPROUSM156N`, `BAMLC0A4CBBB`
    as candidates.
- fed_monitor (github.com/realwaynesun/fed_monitor, MIT) chosen as the
  architectural spec to port to Node/TS. Notable upstream bugs to fix:
  `make_alert_id` uses process-randomized `hash()` (breaks state dedupe across
  runs), no episode dedup / hysteresis, monthly series ffilled to daily hides
  publication lag, upserts destroy ALFRED vintages.
- Existing competitors: RecessionPulse, usrecession.watch, FRED email alerts.
  Differentiation: per-user thresholds, multilanguage channels, honest
  per-signal history stats, Telegram-native subscriptions.

See PLAN.md for the implementation roadmap.
