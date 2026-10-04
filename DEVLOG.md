# DEVLOG

Chronological development log. Newest entries at the top.

## 2026-10-05 (full timezone coverage)

The TZ picker preset grid was expanded to cover every inhabited US
offset (UTC−10…−4) plus common world zones (UTC…+11 incl. +5:30/+5:45
territory is reachable via command), and a `/tz` command was added for
arbitrary offsets the grid doesn't show: `/tz +5:30`, `/tz -8`,
`/tz utc` (bare numbers read as east). The settings submenu now also
replies with the hint plus current offset so the command is
discoverable. `parseTzArg` validates the world range −12…+14 h.

## 2026-10-04 (implementation pass 19: user timezone)

Time preferences moved off UTC to the user's own timezone (migration
0007 `user_prefs.tz_offset`, minutes east of UTC):

- Settings gained a Timezone row (Plus) — preset-offset picker
  (UTC−8…UTC+10 incl. UTC+5:30) with a back button.
- `digest_time` and `quiet_hours` are now interpreted in the user's TZ:
  jobCustomDigests compares against `localMinutes()`, quietHoursUntil
  evaluates the window on the shifted local clock and returns the UTC
  deferral end.
- `/quiet HH:MM-HH:MM` — custom quiet window (fractional hours stored,
  e.g. 22:30–07:15), `/quiet off` disables; settings row now points at
  the command like digest_time does.
- All "(UTC)" mentions dropped from settings/digest copy; replies echo
  the user's TZ ("set to 07:30 (UTC+3)").

## 2026-10-04 (implementation pass 18: Plus features + UX fixes)

Plus-tier expansion and dead-end cleanup from the paid-features review:

- Quiet hours finally wired end-to-end (the pref existed since 0001 with
  no effect): non-critical alerts enqueue with `deliveries.not_before` =
  quiet-window end (migration 0006); pending/retryable queries skip held
  rows. Settings row cycles UTC presets; critical events and
  high/severe band changes still bypass.
- Band-change alerts (Plus, both directions): `routeBucketAlert` fires on
  prevBucket≠bucket composite transitions — "🚨 LOW → ELEVATED" and
  "✅ risk eased ELEVATED → LOW". Goes to all Plus users; the service now
  says "better", not only "worse".
- Renewal reminders: `expiry_reminded_at` on subscriptions, one DM ~72h
  before expiry from the hourly subs job, flag reset on each payment.
- /episodes preset buttons (1980–82 … 2023–24 inversion scare) — tap
  instead of remembering the year-range syntax; free text still works.
- Demo alert: /plan gained a "sample alert" button rendering a real
  recent event — free users can see the Plus format before paying.
- Copy/config hygiene: plan_desc now lists /now, /episodes, band alerts,
  quiet hours; digest toggles framed as "optional — instant covers it";
  free users no longer see dead delivery/severity toggles (one upgrade
  CTA instead); removed the never-enforced `plans.free.min_severity_floor`.

## 2026-10-04 (implementation pass 17: score context "N to NEXT_BAND")

A bare "score 1.0" is meaningless without knowing the scale — now every
surface appends the distance to the next risk band: "score 1.0 · 4.0 to
ELEVATED". Null when already in the top band.

- `nextBand(score)` in score.ts + localized `composite.to_next`
  (en "4.0 to ELEVATED" / ru "ещё 4.0 до уровня ПОВЫШЕННЫЙ").
- Applied to: daily digest + /status + /now (`modelScoreLines`), weekly
  dashboard, PNG card (`CardData.scoreNext`), site (`data.score_next`),
  Mini App (app.js reads the same field).
- Also fixed /paysupport — twice. Empty payments list serialized
  inline_keyboard as `[[]]` which Telegram rejects (reply_markup is now
  only attached when buttons exist; bot.catch surfaces handler failures
  instead of logging-only). Then BUTTON_DATA_INVALID: `refund:*` +
  charge_id exceeds the 64-byte callback_data limit — refund callbacks
  now carry the payments rowid and resolve charge_id inside the handler.

## 2026-10-04 (implementation pass 16: event-gated daily syndication)

External venues now receive the daily digest — but only on days with
actual signal transitions. A quiet-day post ("score unchanged, no
events") is noise on X/LinkedIn/Reddit; event days are the genuinely
newsworthy ones. Gate lives in `shouldSyndicate(kind, eventCount)` at
the digest level, not per-venue.

- All six venues' `kinds` now include `"daily"` (Discord already did);
  `jobDigest` skips syndication for daily digests with zero events.
- Telegraph daily pages are archive-only — the daily digest has no
  read-more link, but the page still gets indexed and stored in
  `syndications.url`.
- Coverage: `shouldSyndicate` unit test + every built-in venue accepts
  `daily` (regression guard for future venues).

## 2026-10-04 (implementation pass 15: weekly digest → single post w/ link preview)

Telegram caption limit (1024) forced the photo + text two-message flow.
`sendMessage` supports `link_preview_options` — a text post (≤4096) can
render the site page's og:image (card.png) as a large preview, so the
weekly digest becomes ONE message when SITE_URL is set.

- **Deliveries `link_preview_url` column** (migration 0005) — per-delivery
  preview URL survives retries through the outbox; NULL = preview
  disabled (unchanged behavior for daily/alerts/audit).
- **`sendTelegramMessage(chatId, text, previewUrl?)`** — sets
  `prefer_large_media` + `show_above_text`; fallback keeps
  `is_disabled: true` everywhere else.
- **Digest** — weekly enqueues (channels, DMs, custom-time DMs) carry
  `siteLink(locale)` as preview URL; the photo-first card path now runs
  only when SITE_URL is unset (no-site deployments keep two posts).
- Weekly text already contains the site URL in `weekly.read_more`, so
  the preview URL always matches a link in the message (Telegram
  requirement). Telegraph's URL still appears first — explicit `url`
  param selects the site for the image.

## 2026-10-05 (implementation pass 14: site as a landing + rebrand)

Site's role clarified: public trust + discovery funnel — "what the
monitor says now + why believe it"; paid depth (per-signal analytics,
episode history, personalization) stays bot-only.

- **Rebrand US Recession Watch → US Recession Chance** — locales
  (app.name, card.caption, site.title, bot.start), card header now
  data-driven via `app.name`, feed title/author/URN, telegraph +
  reddit strings.
- **Homepage depth** — hero untouched; below: full signals coverage
  table (all configured signals incl. never-evaluated `state: none`,
  severity-sorted, new `data.signals` field), "what the bot adds" CTA
  block, footer nav (Methodology / Self-audit / RSS / bot / lang).
- **`/method/`** — public signal catalog grouped by block
  (name/desc/evaluator params/FRED source link), scoring table from
  model.yaml, data & revisions section, disclaimer. Localized via
  `site.method_*` + existing `signal.*` keys.
- **`/audit/`** — self-audit archive: index + per-week pages rendered
  from `deliveries` `a:*` rows; empty state until first audit ships.
- **SEO/OG** — `<title>` with bucket, description, canonical,
  hreflang (+x-default), og-tags, twitter card, JSON-LD `Dataset`,
  lang toggle. Shared `pageShell` head helper.
- **og:image** — fresh `card.png` (1200×630) rendered each
  `npm run site`, independent of `CARD_ENABLED`.
- **Mini App** — `d.signals` coverage panel (falls back cleanly on
  older `data.json` without the field).

Tests: 95/95, typecheck + build clean, local `npm run site` verified
(card.png valid PNG, meta/canonical/hreflang correct on en+ru).

## 2026-10-05 (implementation pass 13: second external audit)

Second audit of the PLAN2 build — 15 findings verified against code;
10 confirmed and fixed, 5 rejected/deferred.

### Fixed

- **F1 (high)** `postJson` crashed on Discord's `204 No Content` —
  venue marked failed → guaranteed weekly repost. Now returns `null`
  for 204 _and_ any empty body. Covered by `postJson` unit tests.
- **F2 (high)** `card.trend_90d` missing from both locales — i18next
  printed the raw key on every weekly PNG card. Keys added; new
  `test/locales.test.ts` compares the en/ru key sets with i18next
  plural suffixes (`_one/_other/_few/_many`) normalized — ru needs
  `_few/_many` forms en doesn't have, so naive parity is wrong.
- **F3** `feed.${locale}.xml` link on `/ru/index.html` resolved to a
  404 — feeds live at root. Renamed to spec form `feed-*.xml`, pages
  get a relative `../` href, and `<link rel="alternate">` was added.
- **F4 (part 1)** GHA weekly chain ran twice (`jobDigestAuto` weekly
  branch + explicit `jobDigest("weekly")` call). Workflow now makes a
  single `jobDigestAuto({ weekly: "force" })` call — fires weekly +
  self-audit on the configured day regardless of `weekly_digest_time_utc`.
- **F4 (part 2)** Buffer posted to X/Threads/LinkedIn under ONE dedup
  key — a late-network failure reposted the early ones on retry.
  Per-network `buffer:<network>` dedup rows now mark each success
  independently; failed networks retry without reposting. `Venue.publish`
  gained an optional `conn` param so dedup runs on the runner's DB.
- **F5** Self-audit was gated on `SYNDICATION_ENABLED` — disabling
  external venues silently killed the Telegram self-audit. New
  `SELF_AUDIT_ENABLED` env gate; either flag enables it.
- **F6** `sahm_states` value is a state count but inherited `percent`
  unit → "7.00%" in digests/site/Mini App. Signals can now override
  `unit:` in signals.yaml (`unit: count` set; `unit.count` locale key).
- **F7** `data.json.trend` was `number[]` per spec it should carry
  timestamps — now `[[ts, score], ...]`; Mini App + sparkbars updated
  (app.js tolerates both shapes for cached payloads).
- **F8** Feeds renamed to `feed-*.xml` (spec form); `.nojekyll`
  generated; Atom entries got `<author>`, per-entry canonical link,
  and target-independent `<id>`s.
- **F12** `scoreVerdict` excluded a recession starting in the snapshot
  month (`>` → `>=`) and anchored the 12m window on wall-clock instead
  of the snapshot's own `ts` (now selected by the query).
- **F13** `audit.verdict_miss`/`verdict_hit` emoji suggested the
  outcome rather than the forecast quality — replaced with neutral text.
- **F14** Mini App `pickLocale` hardcoded ru/en — now passes any
  2-letter code through; unsupported locales fall back to `data.json`.

### Rejected / deferred

- **F9** `.nojekyll` — actually fixed alongside F8 (harmless one-liner).
- **F11** `weekly_digest_time_utc` ignored in GHA — now explicit
  `weekly: "force"` semantics + comment; the 13:20 run IS the slot.
- **F15** External posts keep the bot promo footer — intentional CTA
  to the product's main surface; audit itself marks it tolerable.
- **`sahm_states` unit test** — already covered in
  `test/sahmStates.test.ts` (ok/warning/critical/count/context).

Tests: 93/93, typecheck clean, build clean.

## 2026-10-05 (implementation pass 12: going public + bot command menu)

- **BSL-1.1 LICENSE** — source stays readable and self-hostable
  (Additional Use Grant = personal non-commercial use); commercial
  deployment reserved until Change Date 2030-10-04, then Apache 2.0.
  `assets/fonts/OFL.txt` for bundled Inter; README License section.
- **Pre-public sweep**: `.env` never committed, no tokens/keys in git
  history — safe to flip repo visibility.
- **`npm run commands`** (`src/cli/setCommands.ts`) — syncs Telegram's
  "/" autocomplete via `setMyCommands` per supported locale; command list
  lives in `src/bot/commands.ts`, descriptions in `bot.cmd.*` locale keys.
  No more manual BotFather editing.

## 2026-10-05 (implementation pass 11: external audit fixes)

Independent audit verified ~20 findings against code. Root cause of the
critical one: `.gitignore` `site/` was unanchored — it matched `src/site/`,
so the whole Pages/Mini-App generator existed only on disk, never in the
repo (typecheck/tests/deploy broken on any fresh clone).

### Fixed

- **C1** `.gitignore` `site/` → `/site/`; committed the missing `src/site/`.
- **H1** Buffer: added required `mode: shareNow` + `needsApproval: false`
  to `CreatePostInput`; union response now handled via
  `PostActionSuccess`/`MutationError` fragments — a MutationError throws
  instead of silently burning the dedup key. Mock-based venue test added.
- **H2** Weekly chain decoupled from `weekly_digest_time_utc` in GHA: on
  the configured weekly day the digest step calls `jobDigest("weekly")` +
  `jobSelfAudit` explicitly (w:/a: dedup keys make it a no-op if already
  sent). Previously a weekly time later than the 13:20 cron silently
  disabled weekly digest + card + syndication + audit forever.
- **H3** `/episodes`: signal replays memoized across the NBER catch loop
  (was O(recessions × signals)); render cache bounded to 64 entries.
- **M1** `sahm_states` `since` now carries the stored episode start
  (`prev.since`) instead of always reporting the newest obs date.
- **M2** Suppressed transitions log a durable `console.warn` line (the
  `signal_events` table stays alert-only by design).
- **M3** Custom-time Plus users get the same weekly dashboard render
  (sparkline, WoW delta, read-more links) — was plain `renderDigest`.
- **M4** Unguarded `JSON.parse` in engine moved behind `safeJson`.
- **M5** Venue contract documented: resolved `null` = "posted, no URL";
  venues must throw on failure.
- **M6** Reddit switched to self-posts with the URL appended — a bare
  link dropped the entire digest body.
- **M7** Telegraph `toNodes` linkifies URLs (`<a>` nodes) — telegra.ph
  does not autolink text.
- **L1/L2** Card trend label localized (`card.trend_90d`); `MAX_SCORE`
  replaced by `scoreScaleMax()` derived from `model.yaml` bands; Mini App
  reads `score_scale` from `data.json`.
- **L3** `.env.example` SYNDICATION_LOCALES comment now matches code
  (default `en`).
- **L4** `bucketForScore` guards non-finite scores explicitly.
- **L5** `/episodes` note explains the ±24m catch window vs 12m precision.
- **L6** `Panel.latestObsDate` uses indexed `getLatestObsDate` (was full
  history load per series — 51× per run for sahm_states).
- **L8** `enqueueDelivery` conflict target names the dedup index columns
  explicitly (bare `ON CONFLICT` would swallow future violations).
- **L9** `renderSignalEvent` payload parse guarded.
- **L10** `signal_episodes` comments corrected (upsert, not append-only).

### Not changed (verified, by design)

- `latestVintageAt` — dead in prod paths but a tested utility used by
  vintage tests; kept.
- Delta-model vintages can't represent FRED row deletions; publish-lag
  approximations documented in PLAN2 methodology section.

## 2026-10-05 (implementation pass 10: PLAN2 roadmap — waves A–C)

Full audited PLAN2.md implemented: 14 items, all waves.

### Wave A — data integrity & UX

- **ALFRED vintages**: delta-model storage (`observations.vintage_date`),
  chunked `vintage_dates` fetch, `observationsAsOf` reconstruction
  ("per date, latest vintage ≤ asOf"), `VintageSeriesCache` + `asofSource`
  for point-in-time replay, `npm run vintages` backfill (~200k delta rows,
  ~4.6k vintages), `backtest --vintage` compares latest vs as-of.
  Key finding: FRED returns all intermediate deltas inside a
  `vintage_dates` span — sparse grids lose nothing. As-of replay fixed to
  trim non-vintage series by publication lag (was look-ahead).
  Result: precision honestly degrades (chauvet_piger 0.89→0.50).
- **Per-signal rate limiting**: `min_event_gap_hours` in signals.yaml;
  transitions inside the gap are suppressed (state still updates),
  escalations to `critical` always pass.
- **PNG cards**: satori + resvg-js, 1200×630, full Inter TTFs (WOFF subsets
  broke Cyrillic). `npm run card`, `CARD_ENABLED` gate, photo-first in
  weekly digest, dedup via `card_sent_keys`, card failure never blocks text.
- **Presets → buckets**: score-threshold cycle built from `model.yaml`
  bands (`min > 0`), localized with bucket names. **`/now`**: verdict,
  model prob, 24h delta, top signals, nowcast (Plus). FRED links in
  /guide + /analytics; corroboration line on alerts.

### Wave B — distribution

- **GitHub Pages**: `src/site/` generator — localized index.html,
  `data.{loc}.json` (zod-validated), Atom feeds. `npm run site`;
  deploy job in monitor.yml (`environment: github-pages`).
- **Syndication**: `src/publish/syndication/` — venue interface + repo
  (`syndications` PK venue+locale+key), venues: Telegraph, RSS, Bluesky,
  Mastodon, Discord, Reddit (own sub), Buffer (multiplexes X/Threads/
  LinkedIn). Master gate `SYNDICATION_ENABLED` — set ONLY in GHA, the VPS
  never has it (single-publishing-environment invariant).
- **Weekly dashboard**: `renderWeeklyDashboard` — sparkline, week delta,
  nowcast, Telegraph-first sequencing with read-more link injection.

### Wave C — self-audit & new surfaces

- **Self-audit** (`jobSelfAudit`): weekly, after digest; replays all
  signals, classifies episodes hit/false-positive/pending vs NBER, caches
  append-only, posts via outbox under `a:YYYY-Www` key.
- **State Sahm nowcast**: `sahm` transform + `sahm_states` evaluator;
  51 state/DC UR series (`ur_state_*`) in sources.yaml; warns ≥5,
  critical ≥10 states over 0.5 trigger; `Panel.signalInputs` extended.
- **`/episodes`**: Plus-gated historical search, `YYYY`/`YYYY–YYYY` +
  optional `asof` flag (real point-in-time replay), NBER catch-rate per
  window, 24h render cache.
- **Telegram Mini App**: `web/app/` (vendored telegram-web-app.js, theme
  via themeParams, locale via initDataUnsafe — display-only, no HMAC
  needed for public data); renderSite copies to `site/app/`;
  `/dashboard` command; `npm run menu-button` installs the web_app
  menu button.

### Ops notes

- Workflow digest step now passes all syndication secrets + toggles.
- `.env.example` documents CARD*ENABLED, SYNDICATION*\*, SITE_URL and all
  venue credentials with "enable only in GHA" warnings.
- Server must NOT have TG*CHANNEL*\* / SYNDICATION_ENABLED, or posts
  double (separate SQLite = no shared dedup).

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

- ~~ALFRED vintage-aware backtest~~ — done in PLAN2 pass 10 (`--vintage`).
- Wire calibrated bands/model into score (fit-model output still manual).
- Stars e2e in Telegram test env; recurring invoices.
- Release-calendar-aware refetch.
- ~~X adapter~~ — via Buffer venue in PLAN2 pass 10.

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
