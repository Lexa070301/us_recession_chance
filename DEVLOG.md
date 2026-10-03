# DEVLOG

Chronological development log. Newest entries at the top.

## 2026-10-05 (implementation pass 9: independent audit fixes)

Independent audit verified against code; fixed items below.

### Fixed (high)

- **`levels` hysteresis was dead code**: exit_below/exit_above could only
  early-return `ok`. `evaluate()` now takes the previous state
  (`PrevEvalState`); dead band between exit and trigger holds the stored
  state. Engine passes `{state, since}` from signal_state; `replaySignal`
  threads prev across eval points. Affects 9 signals (nfci, stlfsi, nyfed,
  sloos, cfnaid, sahm, chauvet + hy/bbb via any_of) — kills watch↔ok flaps.
- **`yoy` computed absolute diff while thresholds meant %**: now
  `(v/prev−1)·100`. Bug hit `permits_decline` (critical −10) and
  `housing_starts_decline` (warn −10). Re-measured: permits precision
  0.11→0.31, housing starts 0.18→0.36 (recall 0.75, lead 4).
- **`episode_duration`**: `since` pointed at first non-breach obs instead of
  the run start (`runStart` → `runStart − run`); a short re-breach run after
  a sub-exit gap now keeps the episode alive instead of flapping to ok.
- **Backtest look-ahead**: `monthly_mean`/`nyfed_prob` transformed obs
  (dated month-01) were "known" raw-lag days later — mid-month leak. These
  transforms now get effective freq `monthly` in `SeriesCache` (45d lag).
- **`Panel.latestObsDate`** used the transformed series' last date →
  `nyfed_recession_prob` (YYYY-MM-01) skipped re-eval all month. Now keyed
  on raw series dates.

### Fixed (medium)

- `runEngine`: per-signal try/catch — one bad rule can't abort the run.
- Composite snapshot now also written when `modelProb` drifts >0.1pp
  (was only on score/bucket change).
- `transitionSignalState` wrapped in a transaction (state+event atomic).
- `recordPayment` → `INSERT OR IGNORE` + returns bool; redelivered
  `successful_payment` no longer throws before activation.
- `applyRefund` failure after a successful `refundStarPayment` is now
  logged loudly instead of silently losing subscription bookkeeping.
- `expireDueSubscriptions` resets `delivery_mode → digest` (matches the
  refund path's downgrade behavior).
- Scheduler crons pinned to `UTC` explicitly — `TIMEZONE` env can no longer
  shift documented UTC times.
- `fit-model` gained a temporal OOS split report (train ≤2017/test 2017+).
  Result: OOS R² < 0, sign instability (unrate −0.17 full vs +1.21 train)
  driven by the unresolved 2022–25 inversion — pooled_logit flagged
  experimental in model.yaml; keep divergence-warnings visible.

### Verified NOT bugs

- `digestKey` ISO week: Thursday/Jan-4 math is exact (always whole weeks).
- `npm run digest -- weekly`: argv[1] = "weekly" under tsx -e — works.
- PLAN.md `critical = вес+0.5` was a doc bug (code/config use ×1.5) — doc fixed.

### Known limitations (accepted, documented)

- `fetchIncremental` 14d overlap won't catch deep benchmark revisions;
  GHA writes one cache entry per run (restore-keys picks the latest);
  `quiet_hours`/`plans.free.min_severity_floor` are configured but unused.

## 2026-10-05 (implementation pass 8: message layout v2)

### Changed

- Verdict-first layouts: every message starts with
  `📊 Риск рецессии: <bucket>` + one compact `Model/score/active` line.
- Digest: events carry values (`⚠️ Заявки → 245k`), active signals are
  collapsed to one `▸ Активные (n): …` line (top 5 by severity + `…+n`),
  nowcast is a single `⏱ Nowcast: ✅ спокойно`/items line. Disclaimer
  dropped from digest/status (kept in instant alerts, /start, /terms).
- Instant alert: `value · from→to since <date>` one-liner, hist line,
  one-line risk summary — description and the 3-line composite removed.
- Threshold alert: 2 lines instead of duplicated composite block.
- /analytics: sorted by severity, OK signals collapsed
  (`✅ Остальные N — норма` / `✅ Все — норма`).
- Units now render with short localized suffixes
  (`-0.42 п.п.`, `245k`, `1.4 млн`).

## 2026-10-05 (implementation pass 7: multi-tier plans)

### Implemented

- `subscription.tiers` replaces `stars_per_30d`/`period_days`:
  `{days:30,stars:150}`, `{days:90,stars:350}`, `{days:365,stars:1200}`.
- `/plan` renders one button per tier (with discount % vs the 30-day rate);
  ToS consent now carries the tier (`bot.tier_agree`,
  callback `buy:plus:pay:<days>`).
- Invoice payload = `plus:<days>:<uid>:<ts>`; `successful_payment` parses it
  via `parseInvoicePayload`, resolves the tier via `findTier`, and rejects
  payments whose `total_amount` doesn't match the configured tier price —
  forged payloads can't buy long periods cheaply.
- Refunds stay per-payment (`period_days` column already), so any tier
  refunds correctly.
- `STARS_PER_30D` override now applies only to the 30-day tier.

## 2026-10-03 (implementation pass 6: payments dev-tooling)

### Implemented (3-level Stars testing strategy)

- **No-Telegram level**: `npm run devsub` (`src/cli/devSubscription.ts`) —
  `grant <id> [days]` (synthetic `dev_*` payment + activateSubscription +
  instant mode, mirrors successful_payment), `refund <charge_id>` (applyRefund
  only — no API), `expire <id>` (marks sub due → run expiry job to finish),
  `status <id>` (user+prefs+sub+payments dump). Verified on a temp DB.
- **Test-env level**: `TG_ENV=test` → `createBot` passes
  `client.environment: "test"` to grammY (test DC, free Stars). Needs a
  separate bot token from @BotFather inside the test environment.
- **Prod-smoke level**: `STARS_PER_30D` env overrides
  `model.subscription.stars_per_30d` at load (min real price = 1 Star;
  self-refund via /paysupport).
- `.env.example` documents TG_ENV + STARS_PER_30D; README got a
  "Testing Stars payments" section.

## 2026-10-03 (implementation pass 5: tiered delivery rework)

- Channels now receive digests only (daily 13:00 UTC + weekly on Sunday).
  Instant transitions moved to Plus-only DMs — routeEvent no longer targets
  channels; BOT_USERNAME env adds a promo footer to channel digests.
- Plus prefs (migration 0003): daily_digest / weekly_digest toggles,
  nowcast_alerts, score_threshold, digest_time.
- New: /digest HH:MM custom time (jobCustomDigests every 15min, dedup via
  digest_key d:/w: ISO week), /analytics per-signal stats,
  routeCompositeAlerts fires once per upward threshold crossing.
- EngineRun now returns prevScore for crossing detection.
- test/publisher.test.ts: 6 tests covering plus-only instant, nowcast gate,
  severity floor, enabled_signals, threshold crossing.

## 2026-10-03 (implementation pass 4: payment compliance)

### Implemented

- **`/terms`** — localized ToS text (service scope, price, refund policy,
  disclaimer). Telegram requires bot-paid users to see terms pre-purchase.
- **ToS consent in buy flow** — `buy:plus` now shows a consent line + "Agree
  & pay" button (`buy:plus:pay`) before the invoice is sent.
- **`/paysupport` + self-service refunds** — lists payments inside
  `subscription.refund_window_days` (model.yaml, default 7) with
  confirm → `refundStarPayment` flow. `applyRefund` (atomic tx): marks
  `payments.refund_at`, shortens `expires_at` by the payment's period, and
  cancels + downgrades the plan when no paid time remains. Downgrade also
  resets delivery_mode to digest.
- Tests: 4 repo-level cases (window listing, shorten, cancel, idempotency).

### Notes

- Charge ids ride in callback_data (`refund:req:`/`refund:yes:`) — well
  under the 64-byte limit for typical `telegram_payment_charge_id` values.
- Refund policy chosen: full refund within 7 days, self-service. No admin
  forwarding in /paysupport (kept text-only per decision).
- Stars e2e still unverified — needs a real payment in the test env.

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
