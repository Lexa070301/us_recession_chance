# Historical signal statistics — methodology & sources

The `hist:` blocks in `config/signals.yaml` carry **static** statistics shown
to users ("recession within 12m followed N% of episodes"). They are compiled
from published research plus manual episode counts — deliberately static, not
recomputed at runtime, because honest estimation requires vintage data and
careful definitions.

## Definitions

- **Episode** — one contiguous activation of the signal rule, counted at its
  onset after ≥6 months inactive (not every month in state).
- **Precision** — episodes followed by an NBER recession start within 12
  months / all episodes in sample.
- **Recall** — NBER recessions preceded by the signal / all recessions in sample.
- **Median lead** — median months from episode start to recession start.
- **insufficient_history** — series covers < ~5 recessions (JOLTS: 2,
  HY OAS: 3, SLOOS: ~4, STLFSI: 3, DGORDER: 3, TEMPHELPS: 3).
- Base rate for context: unconditional P(recession within next 12m) ≈ 16%
  (~92 recession months share of post-1948 months, forward-looking window).

## Sources

- Estrella & Mishkin / NY Fed yield-curve model (10Y–3M probit); NY Fed
  recession-probability track record: >40% missed only Oct-1966 (41.1%).
- ROC analysis of daily 10Y–3M spreads: hit rate ~92%, false-alarm ~25%.
- Richmond Fed EB 19-12 — logit comparison of leading indicators.
- FEDS Notes 2019 — OOS probit performance (term spread + EBP best bivariate).
- SF Fed Economic Letter 2022-36 — unemployment-based rules ~ curve quality
  at shorter horizons.
- Richmond Fed EB 25-07 (SOS) — Sahm rule lags official start by ~3.4m on
  average; false positives 2003/2024 in their sample, 1959/1969 timing-only.
- Conference Board LEI — first-ever false positive 2022–24 after 63 years.

## Known caveats baked into the config

- 2022–24 inversion did not (yet?) produce an NBER recession — the latest
  episode may become the second false positive ever; `precision` is
  approximate and marked as such.
- "Probability" numbers are episode frequencies, not calibrated probabilities;
  Phase 5 (`backtest.ts`/`fitModel.ts`) will replace bands with a fitted model.
