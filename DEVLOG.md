# DEVLOG

Chronological development log. Newest entries at the top.

## 2026-10-03 (implementation pass 3: real-data E2E + calibration)

### Real-data run + fixes found by backtest

Backfilled 60y (95,669 obs / 29 series) and ran `npm run backtest` — it
immediately found real problems:

- **`lei_oecd` (USSLIND) discontinued on FRED in 2020-02** → leading-composite
  signal switched to **CFNAI** (`cfnaid_weak`, MA3 < −0.7 warn / −1.0 crit;
  1967+, 8 recessions).
- **`hy_oas`/`bbb_oas` (ICE BofA)**: FRED API serves only ~3y of history —
  licensing; documented in hist notes.
- **`yield_curve_resteepening`**: plain `Δ63d > 1.0` had precision 0.15
  (fires on any steepening) → added `ref_below` gate to `change_over_period`
  (must rise _out of negative_ territory) → precision 0.40, lead 4m.
- **`jolts_flows`**: `all_of` streak-3 never fired → loosened to streak-2;
  episodes still start _inside_ recessions (2009-01, 2020-05) — JOLTS is
  coincident, not leading. Honest note in hist.
- **Nowcast signals** (Sahm, Chauvet–Piger): precision@12m is the wrong
  metric — `signalBacktest` now uses an onset window `[-3m, +6m]` for
  `block: nowcast` → Sahm 0.80, Chauvet 0.89, negative median lead as
  expected.
- **Composite calibration**: `severe` (≥13) band measured 14% — almost all
  severe months are either inside recessions or the unresolved 2023–24
  episode (the same period LEI failed for the first time in 63y). Added
  `POST_REC_SHADOW_MONTHS=12` exclusion; band labels updated to honest wide
  ranges; `severe` marked "uncertain — hist. rare".
- **`hist:` stats updated** to measured values (sample ranges + "measured"
  notes) where they materially differed from literature guesses.

### Pooled logit wired end-to-end

- `fit-model` on real data: McFadden R² 0.385, all signs sensible
  (spread −, nfci +, cfnaid −, claims +, permits −, unrate −).
- `pooled_logit` pasted into `model.yaml`; `src/signals/pooledProb.ts`
  replays `key`+`ops` per predictor at runtime → `composite.modelProb`
  → rendered as bucketed "Model estimate (12m)" line (en/ru).

### Ops/robustness

- `signal_state` now stores `_rule_hash` (sha1 of evaluator config) —
  editing signal rules in YAML triggers re-evaluation even without new data.
- Digest dedup verified live (2nd run → 0 enqueued); i18next support notice
  silenced.
- **Telegram E2E verified**: test message + full digest delivered to both
  EN and RU channels.

### Remaining

- ALFRED vintage mode; Stars e2e; release-aware refetch; X adapter;
  GitHub Actions channel-only mode.

## 2026-10-03 (implementation pass 2: Phase 5 + ops)

### Implemented

- **Backtest layer** (`src/backtest/`):
  - `replay.ts` — SeriesCache (shared transformed inputs), publication-lag
    aware replay (`PUBLISH_LAG_DAYS`: daily 1 / weekly 7 / monthly 45 /
    quarterly 90), `stateAt`, `detectEpisodes` (merge runs <6 months apart).
  - `stats.ts` — per-signal precision/recall/median-lead vs NBER starts,
    censoring of episodes near sample end; monthly composite-score grid
    (recession months excluded = transition probability) + band calibration.
  - `logit.ts` — IRLS logistic regression (standardized predictors, ridge),
    reliability table, McFadden R². No external deps.
- **Scripts**: `npm run backtest` (signal stats vs static `hist:` + score
  bands) and `npm run fit-model` (6 predictors, one per block; prints
  coefs + YAML block for `pooled_logit` in model.yaml — schema added,
  not wired into runtime yet).
- **Ops**: digest dedup via partial unique index (migration 0002,
  `ON CONFLICT DO NOTHING`); `jobs/health.ts` (stale fetches per freq,
  delivery backlog/dead, composite heartbeat → `ADMIN_TG_ID` DM);
  `jobs/backup.ts` (better-sqlite3 `.backup()`, 14-file rotation);
  cron entries for both; `ecosystem.config.cjs` for pm2; README
  commands/scheduling/deployment sections.

### Caveats

- Backtest uses latest-vintage data → revisions leak a little; publish lags
  are approximations. True ALFRED-vintage mode remains a Phase 5 follow-up.
- fit-model output must be reviewed (OOS, reliability) before wiring
  `pooled_logit` into scoring — intentionally a manual step.

### TODO / known gaps

- ALFRED vintage-aware backtest; wire calibrated bands/model into score.
- Stars e2e in Telegram test env; recurring invoices.
- Release-calendar-aware refetch; GitHub Actions channel-only mode;
  X adapter.

## 2026-10-03 (implementation pass 1)

### Implemented (PLAN.md Phases 1–4 done, 5–7 partial)

- **Config layer**: `config/sources.yaml` (28 FRED series), `signals.yaml`
  (20 signals incl. nowcast block), `channels.yaml`, `model.yaml`
  (probit coefs, composite bands, plan gating), `locales/{en,ru}.yaml`.
  Zod schemas + loader with env-resolved channel chat_ids.
- **Data layer**: `db.ts` (better-sqlite3, embedded migrations), repositories
  (observations, signal_state/events, composite_snapshots, users, prefs,
  subscriptions, payments, deliveries-outbox), `fredClient.ts` (rate limit,
  retries, incremental fetch, `vintage_dates` support), `nber.ts`.
- **Signal engine**: transforms on native frequency (no ffill-to-daily),
  typed evaluators (levels, episode_duration, streak, rise_from_trough,
  change_over_period, yoy, any_of/all_of), deterministic recompute +
  transition-only events (dedupe), hysteresis (exit_below/exit_periods).
- **Composite**: weighted score (watch .5 / warning 1 / critical 1.5) →
  prob bands from model.yaml → `composite_snapshots`.
- **Publisher**: canonical event → per-locale render → outbox deliveries
  with retries; DM filtering by prefs/plan; 403 → is_blocked.
- **Bot** (grammY): /start /status /signals /settings /lang /plan,
  inline keyboards, Stars payments (XTR invoice → activate subscription,
  expiry job + downgrade), free/plus gating.
- **Jobs**: node-cron scheduler (daily/weekly/monthly fetches, digest,
  delivery retries, sub expiry); CLIs: backfill, check-signals, send-test.
- `index.ts` modes: `bot` | `scheduler` | `all`.
- Tests: 15 vitest cases (evaluators + engine dedup/transitions).
  `npm run typecheck` clean.

### Design notes / deviations from plan

- Evaluators are pure functions of full series history — no fragile
  incremental state; `episode` inferred by walking the trailing run.
- `signal_state.last_obs_date` gates re-evaluation (publication-lag aware).
- Deliveries unified in `deliveries` table for channels + DMs (outbox).
- Fixed during smoke test: duplicated transition label, missing `since`
  in event context; `.gitignore` `data/` → `/data/` (was blocking src/data).

### TODO / known gaps

- Phase 5: `backtest.ts`, `fitModel.ts` not implemented; prob bands are
  static config values pending calibration.
- Stars payments: code complete, needs Telegram test-env e2e check;
  recurring invoices are manual-renewal for now.
- No release-calendar awareness (fixed fetch days instead).
- X adapter, web dashboard, admin commands — not started.

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
