import { z } from "zod";

export const frequencySchema = z.enum(["daily", "weekly", "monthly", "quarterly"]);
export type Frequency = z.infer<typeof frequencySchema>;

export const seriesDefSchema = z.object({
  key: z.string(),
  source: z.enum(["fred", "static", "derived"]).default("fred"),
  series_id: z.string().optional(),
  frequency: frequencySchema,
  unit: z.string(),
  hist_start: z.string().optional(),
  /** `alfred` = backfill vintage deltas (point-in-time history for honest
   * backtests); `none` = latest revision only (market series aren't
   * revised, so they don't need snapshots). */
  vintage: z.enum(["alfred", "none"]).default("none"),
  /** Observation window fetched per vintage batch (years back). */
  vintage_lookback_years: z.number().positive().default(40),
});
export type SeriesDef = z.infer<typeof seriesDefSchema>;

export const sourcesConfigSchema = z.object({
  version: z.number(),
  data_sources: z.object({
    fred: z.object({
      base_url: z.string(),
      file_type: z.string().default("json"),
      api_key_env: z.string().default("FRED_API_KEY"),
      rate_limit_rpm: z.number().default(100),
      retry_delay_ms: z.number().default(5000),
      max_retries: z.number().default(3),
    }),
  }),
  series: z.array(seriesDefSchema),
});
export type SourcesConfig = z.infer<typeof sourcesConfigSchema>;

// ------------------------------------------------------------------
// Evaluators
// ------------------------------------------------------------------

export const opSchema = z.enum(["<", "<=", ">", ">=", "=="]);
export type Op = z.infer<typeof opSchema>;

export const inputRefSchema = z.object({
  key: z.string(),
  transform: z.string().default("value"),
});
export type InputRef = z.infer<typeof inputRefSchema>;

const levelSchema = z.object({
  state: z.enum(["watch", "warning", "critical"]),
  op: opSchema,
  threshold: z.number(),
});

export const evaluatorSchema: z.ZodType<EvaluatorDef> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("levels"),
      input: inputRefSchema.optional(),
      params: z.object({
        levels: z.array(levelSchema).min(1),
        exit_below: z.number().optional(),
        exit_above: z.number().optional(),
      }),
    }),
    z.object({
      type: z.literal("episode_duration"),
      input: inputRefSchema.optional(),
      params: z.object({
        op: opSchema,
        threshold: z.number(),
        warn_periods: z.number().int(),
        critical_periods: z.number().int().optional(),
        exit_periods: z.number().int().default(1),
      }),
    }),
    z.object({
      type: z.literal("streak"),
      input: inputRefSchema.optional(),
      params: z.object({
        direction: z.enum(["up", "down"]),
        warn_count: z.number().int(),
        critical_count: z.number().int().optional(),
      }),
    }),
    z.object({
      type: z.literal("rise_from_trough"),
      input: inputRefSchema.optional(),
      params: z.object({
        window: z.number().int(),
        rise_pct: z.number().optional(),
        rise_abs: z.number().optional(),
        critical_pct: z.number().optional(),
        critical_abs: z.number().optional(),
      }),
    }),
    z.object({
      type: z.literal("change_over_period"),
      input: inputRefSchema.optional(),
      params: z.object({
        periods: z.number().int(),
        op: opSchema,
        warn: z.number(),
        critical: z.number().optional(),
        /** Only fire when the reference obs was below this (e.g. ref_below: 0 = rising out of negative territory). */
        ref_below: z.number().optional(),
      }),
    }),
    z.object({
      type: z.literal("yoy"),
      input: inputRefSchema.optional(),
      params: z.object({
        op: opSchema,
        threshold: z.number(),
        warn: z.number().int(), // consecutive periods needed for warning
        critical: z.number().optional(), // instant-critical yoy threshold
      }),
    }),
    z.object({
      type: z.literal("sahm_states"),
      params: z.object({
        /** State UR series keys (ur_state_XX) — resolved via transform `sahm`. */
        keys: z.array(z.string()).min(1),
        trigger: z.number(),
        warn_count: z.number().int(),
        critical_count: z.number().int().optional(),
      }),
    }),
    z.object({
      type: z.literal("any_of"),
      branches: z.array(z.lazy(() => evaluatorSchema)).min(1),
    }),
    z.object({
      type: z.literal("all_of"),
      branches: z.array(z.lazy(() => evaluatorSchema)).min(1),
    }),
  ]),
);

export type EvaluatorDef =
  | { type: "levels"; input?: InputRef; params: { levels: { state: "watch" | "warning" | "critical"; op: Op; threshold: number }[]; exit_below?: number; exit_above?: number } }
  | { type: "episode_duration"; input?: InputRef; params: { op: Op; threshold: number; warn_periods: number; critical_periods?: number; exit_periods: number } }
  | { type: "streak"; input?: InputRef; params: { direction: "up" | "down"; warn_count: number; critical_count?: number } }
  | { type: "rise_from_trough"; input?: InputRef; params: { window: number; rise_pct?: number; rise_abs?: number; critical_pct?: number; critical_abs?: number } }
  | { type: "change_over_period"; input?: InputRef; params: { periods: number; op: Op; warn: number; critical?: number; ref_below?: number } }
  | { type: "yoy"; input?: InputRef; params: { op: Op; threshold: number; warn: number; critical?: number } }
  | { type: "sahm_states"; params: { keys: string[]; trigger: number; warn_count: number; critical_count?: number } }
  | { type: "any_of"; branches: EvaluatorDef[] }
  | { type: "all_of"; branches: EvaluatorDef[] };

export const histSchema = z.object({
  sample: z.string().optional(),
  episodes: z.number().optional(),
  recessions_covered: z.number().optional(),
  precision: z.number().optional(),
  recall: z.number().optional(),
  median_lead_months: z.number().optional(),
  insufficient_history: z.boolean().default(false),
  note: z.string().optional(),
});
export type HistStats = z.infer<typeof histSchema>;

export const signalDefSchema = z.object({
  key: z.string(),
  block: z.enum(["financial", "credit", "housing", "labor", "composite", "nowcast"]),
  weight: z.number(),
  input: inputRefSchema,
  /** Display-unit override — for derived values whose unit differs from the
   * input series (e.g. sahm_states counts states, not percent). */
  unit: z.string().optional(),
  evaluator: evaluatorSchema,
  /** Flap guard: transitions closer than this to the previous event update
   * state silently (no SignalEvent) unless they escalate to `critical`. */
  min_event_gap_hours: z.number().positive().optional(),
  hist: histSchema.optional(),
});
export type SignalDef = z.infer<typeof signalDefSchema>;

export const signalsConfigSchema = z.object({
  version: z.number(),
  signals: z.array(signalDefSchema),
});
export type SignalsConfig = z.infer<typeof signalsConfigSchema>;

// ------------------------------------------------------------------
// Channels / model
// ------------------------------------------------------------------

export const channelsConfigSchema = z.object({
  version: z.number(),
  channels: z.array(
    z.object({
      id: z.string(),
      locale: z.string(),
      kind: z.enum(["channel", "group"]),
      chat_id_env: z.string(),
    }),
  ),
  defaults: z.object({
    supported_locales: z.array(z.string()).min(1),
    fallback_locale: z.string(),
    digest_time_utc: z.string(),
    weekly_digest_day_utc: z.number().int().min(0).max(6).default(0),
    weekly_digest_time_utc: z.string().default("13:00"),
  }),
});
export type ChannelsConfig = z.infer<typeof channelsConfigSchema>;

export const modelConfigSchema = z.object({
  version: z.number(),
  nyfed_probit: z.object({
    alpha: z.number(),
    beta: z.number(),
    horizon_months: z.number(),
  }),
  composite: z.object({
    state_weight: z.object({ watch: z.number(), warning: z.number(), critical: z.number() }),
    bands: z.array(
      z.object({ min: z.number(), max: z.number(), bucket: z.string(), prob_label: z.string() }),
    ),
    base_rate_label: z.string(),
  }),
  plans: z.object({
    free: z.object({
      delivery_mode: z.enum(["instant", "digest"]),
      custom_signals: z.boolean(),
    }),
    plus: z.object({
      delivery_mode: z.enum(["instant", "digest"]),
      custom_signals: z.boolean(),
      min_severity_floor: z.enum(["watch", "warning", "critical"]),
    }),
  }),
  subscription: z.object({
    tiers: z
      .array(z.object({ days: z.number().int().positive(), stars: z.number().int().positive() }))
      .min(1),
    refund_window_days: z.number().int().default(7),
  }),
  // Fitted by scripts/fitModel.ts — optional until reviewed & wired in.
  pooled_logit: z
    .object({
      horizon_months: z.number().int(),
      sample: z.string(),
      predictors: z.array(
        z.object({
          name: z.string(),
          /** Series + transform pipeline used to compute the predictor. */
          key: z.string(),
          ops: z.array(
            z.object({
              t: z.enum(["monthly_mean", "ma", "diff", "pct_change"]),
              n: z.number().int().optional(),
            }),
          ),
          mean: z.number(),
          std: z.number(),
          coef: z.number(),
        }),
      ),
      intercept: z.number(),
    })
    .optional(),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;
