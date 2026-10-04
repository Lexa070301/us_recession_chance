import { getConfig, getSeriesDef, getSignalDef } from "../../config/load.js";
import type { SignalDef } from "../../config/schema.js";
import type {
  SignalEventRow,
  SignalState,
  SignalStateRow,
} from "../../data/repositories/signalState.js";
import type { CompositeResult } from "../../signals/score.js";
import { scoreScaleMax } from "../../signals/score.js";
import { probBucketLabel } from "../../signals/pooledProb.js";
import { t } from "./i18n.js";

const STATE_ICON: Record<SignalState, string> = {
  ok: "✅",
  watch: "👀",
  warning: "⚠️",
  critical: "🚨",
};

const SEVERITY_RANK: Record<SignalState, number> = {
  ok: 0,
  watch: 1,
  warning: 2,
  critical: 3,
};

const UNITS_WITH_DECIMALS = new Set(["percent", "pct_points", "index", "ratio", "binary"]);

export function formatValue(value: number | null, unit?: string): string {
  if (value === null || value === undefined) return "N/A";
  if (!unit || UNITS_WITH_DECIMALS.has(unit)) return value.toFixed(2);
  if (unit.startsWith("usd_")) return `$${Math.round(value).toLocaleString("en-US")}`;
  return Math.round(value).toLocaleString("en-US");
}

/** Short localized unit suffix: "−0.42 п.п.", "4.2%", "245k". */
export function formatWithUnit(value: number | null, unit: string | undefined, locale: string): string {
  if (value === null || value === undefined) return "N/A";
  if (unit === "persons") {
    return value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value));
  }
  if (unit === "thousands" || unit === "thousands_saar") {
    return value >= 1000
      ? `${(value / 1000).toFixed(1)}${t(locale, "unit.mln")}`
      : `${Math.round(value)}k`;
  }
  if (!unit) return formatValue(value, unit);
  const suffix = t(locale, `unit.${unit}`);
  return formatValue(value, unit) + (suffix === `unit.${unit}` ? "" : suffix);
}

function stateLabel(state: SignalState, locale: string): string {
  return t(locale, `severity.${state}`);
}

function histLine(signal: SignalDef, locale: string): string | null {
  const h = signal.hist;
  if (!h) return null;
  if (h.insufficient_history) {
    return t(locale, "event.hist_insufficient", { sample: h.sample ?? "" });
  }
  if (h.precision !== undefined && h.episodes !== undefined) {
    return t(locale, "event.hist", {
      precision: Math.round(h.precision * 100),
      episodes: h.episodes,
      sample: h.sample ?? "",
    });
  }
  if (h.precision !== undefined) {
    return t(locale, "event.hist_short", {
      precision: Math.round(h.precision * 100),
      sample: h.sample ?? "",
    });
  }
  return null;
}

function activeCount(composite: CompositeResult): number {
  return Object.values(composite.detail).filter((d) => d.state !== "ok").length;
}

/** "📊 Риск рецессии: НИЗКИЙ" — the headline verdict. */
function headline(composite: CompositeResult, locale: string): string {
  return t(locale, "composite.headline", { bucket: t(locale, `bucket.${composite.bucket}`) });
}

/** "Модель: <10% за 12 мес · скор 1.0" (+ divergence note on next line). */
function modelScoreLines(composite: CompositeResult, locale: string): string[] {
  const score = composite.score.toFixed(1);
  const p = composite.modelProb;
  const lines = [
    p === null || p === undefined
      ? t(locale, "composite.risk_score", { score, prob: composite.probLabel })
      : t(locale, "composite.risk_model", { prob: probBucketLabel(p), score }),
  ];
  if (p !== null && p !== undefined) {
    if (composite.bucket === "low" && p >= 0.25) {
      lines.push(t(locale, "composite.divergence_model"));
    } else if (composite.bucket !== "low" && p < 0.1) {
      lines.push(t(locale, "composite.divergence_signals"));
    }
  }
  return lines;
}

function signalName(key: string, locale: string): string {
  const def = getSignalDef(key);
  return def ? t(locale, `signal.${def.key}.name`) : key;
}

function signalUnit(key: string): string | undefined {
  const def = getSignalDef(key);
  return def ? (def.unit ?? getSeriesDef(def.input.key)?.unit) : undefined;
}

export function splitByBlock(states: SignalStateRow[]): {
  forecast: SignalStateRow[];
  nowcast: SignalStateRow[];
} {
  const forecast: SignalStateRow[] = [];
  const nowcast: SignalStateRow[] = [];
  for (const s of states.filter((s) => s.state !== "ok")) {
    (getSignalDef(s.signal_key)?.block === "nowcast" ? nowcast : forecast).push(s);
  }
  return { forecast, nowcast };
}

/** "⏱ Nowcast: ✅ спокойно" or "⏱ Nowcast: 🚨 Правило Сэм 0.63". */
export function nowcastLine(nowcast: SignalStateRow[], locale: string): string {
  const status =
    nowcast.length === 0
      ? t(locale, "composite.nowcast_calm")
      : nowcast
          .map((s) => `${STATE_ICON[s.state]} ${signalName(s.signal_key, locale)}`)
          .join(" · ");
  return t(locale, "composite.nowcast", { status });
}

/** Compact active list: top 5 by severity, "🚨 Инверсия −0.42 · …+2". */
function compactList(states: SignalStateRow[], locale: string, max = 5): string {
  const sorted = [...states].sort(
    (a, b) => SEVERITY_RANK[b.state] - SEVERITY_RANK[a.state],
  );
  const items = sorted.slice(0, max).map((s) => {
    const v =
      s.last_value === null || s.last_value === undefined
        ? ""
        : ` ${formatWithUnit(s.last_value, signalUnit(s.signal_key), locale)}`;
    return `${STATE_ICON[s.state]} ${signalName(s.signal_key, locale)}${v}`;
  });
  const rest = sorted.length - items.length;
  return rest > 0 ? `${items.join(" · ")} …+${rest}` : items.join(" · ");
}

export function renderSignalEvent(
  event: SignalEventRow,
  composite: CompositeResult | null,
  locale: string,
): string {
  const signal = getSignalDef(event.signal_key);
  const name = signalName(event.signal_key, locale);
  const unit = signalUnit(event.signal_key);

  const toLabel = stateLabel(event.to_state, locale);
  const statePart =
    event.from_state !== "ok" && event.to_state !== "ok"
      ? `${stateLabel(event.from_state, locale)} → ${toLabel}`
      : event.to_state === "ok"
        ? t(locale, "state_change.cleared")
        : toLabel;

  const lines: string[] = [
    t(locale, "event.title", { icon: STATE_ICON[event.to_state], name }),
  ];

  let valueLine = `${formatWithUnit(event.value, unit, locale)} · ${statePart}`;
  let ctx: Record<string, unknown> = {};
  try {
    ctx = event.payload_json ? (JSON.parse(event.payload_json) as Record<string, unknown>) : {};
  } catch { /* corrupt payload renders without context */ }
  const since = (ctx.since as string) ?? null;
  if (event.to_state !== "ok" && since) {
    valueLine += ` ${t(locale, "event.since", { since })}`;
  }
  lines.push(valueLine);

  if (signal) {
    const hist = histLine(signal, locale);
    if (hist) lines.push(hist);
  }
  if (composite) {
    // Corroboration context (PLAN2 §8): how many signals back this event up.
    const active = activeCount(composite);
    const total = Object.keys(composite.detail).length;
    const corrKey =
      active <= 1
        ? "event.corroboration_isolated"
        : active <= 4
          ? "event.corroboration_some"
          : "event.corroboration_broad";
    lines.push(
      t(locale, "event.corroboration", {
        active,
        total,
        label: t(locale, corrKey),
      }),
    );
    const p = composite.modelProb;
    lines.push(
      p === null || p === undefined
        ? t(locale, "composite.event_risk_nomodel", {
            bucket: t(locale, `bucket.${composite.bucket}`),
            score: composite.score.toFixed(1),
          })
        : t(locale, "composite.event_risk", {
            bucket: t(locale, `bucket.${composite.bucket}`),
            prob: probBucketLabel(p),
            score: composite.score.toFixed(1),
          }),
    );
  }
  lines.push("", t(locale, "bot.disclaimer_short"));
  return lines.join("\n");
}

export function renderStatus(
  states: SignalStateRow[],
  composite: CompositeResult,
  locale: string,
): string {
  const { forecast, nowcast } = splitByBlock(states);
  const lines: string[] = [headline(composite, locale), ...modelScoreLines(composite, locale)];

  if (forecast.length === 0) {
    lines.push("", t(locale, "bot.status_empty"));
  } else {
    lines.push("");
    for (const s of [...forecast].sort(
      (a, b) => SEVERITY_RANK[b.state] - SEVERITY_RANK[a.state],
    )) {
      const unit = signalUnit(s.signal_key);
      lines.push(
        `${STATE_ICON[s.state]} ${signalName(s.signal_key, locale)} — ${formatWithUnit(s.last_value, unit, locale)}`,
      );
    }
  }

  lines.push("", nowcastLine(nowcast, locale));
  return lines.join("\n");
}

export function renderDigest(
  events: SignalEventRow[],
  states: SignalStateRow[],
  composite: CompositeResult,
  locale: string,
  date: string,
  kind: "daily" | "weekly" = "daily",
  botPromo?: string,
): string {
  const titleKey = kind === "weekly" ? "digest.title_weekly" : "digest.title";
  const { forecast, nowcast } = splitByBlock(states);

  const lines: string[] = [t(locale, titleKey, { date }), "", headline(composite, locale)];

  if (events.length === 0 && forecast.length === 0) {
    lines.push(
      ...modelScoreLines(composite, locale).map(
        (l, i) => (i === 0 ? `${l} · ${t(locale, "digest.quiet")}` : l),
      ),
    );
  } else {
    const first = modelScoreLines(composite, locale);
    first[0] += ` · ${t(locale, "composite.active_count", { count: activeCount(composite) })}`;
    lines.push(...first);

    if (events.length) {
      const eventsKey = kind === "weekly" ? "digest.events_weekly" : "digest.events";
      lines.push("", t(locale, eventsKey));
      for (const ev of events) {
        const unit = signalUnit(ev.signal_key);
        lines.push(
          `${STATE_ICON[ev.to_state]} ${signalName(ev.signal_key, locale)} → ${formatWithUnit(ev.value, unit, locale)}`,
        );
      }
    }

    if (forecast.length) {
      lines.push(
        "",
        t(locale, "digest.active_compact", {
          count: forecast.length,
          list: compactList(forecast, locale),
        }),
      );
    }
  }

  lines.push("", nowcastLine(nowcast, locale));
  if (botPromo) lines.push("", t(locale, "digest.bot_promo", { bot: botPromo }));
  return lines.join("\n");
}

/** Plus: composite score crossed the user's personal threshold upward. */
export function renderCompositeAlert(
  composite: CompositeResult,
  threshold: number,
  locale: string,
): string {
  const p = composite.modelProb;
  const risk =
    p === null || p === undefined
      ? t(locale, "composite.alert_risk_nomodel", {
          bucket: t(locale, `bucket.${composite.bucket}`),
          active: t(locale, "composite.active_count", { count: activeCount(composite) }),
        })
      : t(locale, "composite.alert_risk", {
          bucket: t(locale, `bucket.${composite.bucket}`),
          prob: probBucketLabel(p),
          active: t(locale, "composite.active_count", { count: activeCount(composite) }),
        });
  return [
    t(locale, "composite.threshold_alert", {
      threshold,
      score: composite.score.toFixed(1),
    }),
    risk,
  ].join("\n");
}

/** Plus: per-signal detail — state, value, historical hit-rate, lead. */
export function renderAnalytics(states: SignalStateRow[], locale: string): string {
  const lines: string[] = [t(locale, "analytics.title"), ""];
  const byKey = new Map(states.map((s) => [s.signal_key, s]));

  const block = (label: string, defs: SignalDef[]) => {
    if (!defs.length) return;
    const sorted = [...defs].sort(
      (a, b) =>
        SEVERITY_RANK[byKey.get(b.key)?.state ?? "ok"] -
        SEVERITY_RANK[byKey.get(a.key)?.state ?? "ok"],
    );
    let okCount = 0;
    lines.push(label);
    for (const def of sorted) {
      const st = byKey.get(def.key);
      const state = st?.state ?? "ok";
      if (state === "ok") {
        okCount++;
        continue;
      }
      const unit = def.unit ?? getSeriesDef(def.input.key)?.unit;
      let line = `${STATE_ICON[state]} ${t(locale, `signal.${def.key}.name`)} — ${t(locale, `severity.${state}`)}`;
      if (st?.last_value !== null && st?.last_value !== undefined) {
        line += ` · ${formatWithUnit(st.last_value, unit, locale)}`;
      }
      const h = def.hist;
      if (h?.precision !== undefined && h.episodes !== undefined) {
        line += ` — ${Math.round(h.precision * 100)}% (n=${h.episodes})`;
        if (h.median_lead_months !== undefined && h.median_lead_months !== null) {
          line += ` · ${t(locale, "analytics.lead")} ${h.median_lead_months}m`;
        }
      } else if (h?.insufficient_history) {
        line += ` — ${t(locale, "analytics.insufficient")}`;
      }
      lines.push(line);
    }
    if (okCount === defs.length) {
      lines.push(t(locale, "analytics.all_ok"));
    } else if (okCount) {
      lines.push(t(locale, "analytics.rest_ok", { count: okCount }));
    }
    lines.push("");
  };

  const defs = getConfig().signals;
  block(t(locale, "analytics.forecast"), defs.filter((d) => d.block !== "nowcast"));
  block(t(locale, "analytics.nowcast"), defs.filter((d) => d.block === "nowcast"));
  // FRED source links (PLAN2 §13) — let users verify the raw data.
  const seriesIds = [
    ...new Set(
      defs
        .map((d) => getSeriesDef(d.input.key)?.series_id)
        .filter((id): id is string => !!id),
    ),
  ];
  lines.push(t(locale, "analytics.fred", { series: seriesIds.join(" · ") }));
  lines.push(t(locale, "bot.disclaimer_short"));
  return lines.join("\n");
}

/** Unicode sparkline ▁▂▃▄▅▆▇ — adaptive range, fixed-band-scale fallback. */
export function sparkline(values: number[], width = 14): string {
  const pts = values.slice(-width);
  if (!pts.length) return "";
  const BARS = "▁▂▃▄▅▆▇";
  let lo = Math.min(...pts);
  let hi = Math.max(...pts);
  if (hi - lo < 1) {
    lo = 0;
    hi = scoreScaleMax(); // flat series → composite scale keeps it honest
  }
  const span = hi - lo;
  return pts
    .map((v) => BARS[Math.max(0, Math.min(6, Math.round(((v - lo) / span) * 6)))])
    .join("");
}

/** Week-over-week delta: "▲ +1.5" / "▼ −0.5" / "—" */
export function deltaLabel(current: number, prev: number | null, locale: string): string {
  if (prev === null) return "";
  const d = current - prev;
  if (Math.abs(d) < 0.05) return `· ${t(locale, "weekly.delta_flat")}`;
  return `· ${d > 0 ? "▲" : "▼"} ${d > 0 ? "+" : ""}${d.toFixed(1)} ${t(locale, "weekly.delta_wow")}`;
}

/**
 * Weekly dashboard post (PLAN2 §5): verdict + model + score WoW delta +
 * sparkline + events + read-more links. Replaces renderDigest for the
 * weekly channel post.
 */
export function renderWeeklyDashboard(
  events: SignalEventRow[],
  states: SignalStateRow[],
  composite: CompositeResult,
  trend: number[],
  prevScore: number | null,
  locale: string,
  weekLabel: string,
  links: { site?: string; telegraph?: string } = {},
  botPromo?: string,
): string {
  const { forecast, nowcast } = splitByBlock(states);
  const lines: string[] = [
    t(locale, "weekly.title", { week: weekLabel }),
    "",
    headline(composite, locale),
  ];

  const score = composite.score.toFixed(1);
  const p = composite.modelProb;
  const delta = deltaLabel(composite.score, prevScore, locale);
  lines.push(
    (p === null || p === undefined
      ? t(locale, "composite.risk_score", { score, prob: composite.probLabel })
      : t(locale, "composite.risk_model", { prob: probBucketLabel(p), score })) +
      (delta ? ` ${delta}` : ""),
  );

  const spark = sparkline(trend, 26);
  if (spark) lines.push(spark);

  if (events.length) {
    lines.push("", t(locale, "digest.events_weekly"));
    for (const ev of events) {
      const unit = signalUnit(ev.signal_key);
      lines.push(
        `${STATE_ICON[ev.to_state]} ${signalName(ev.signal_key, locale)} → ${formatWithUnit(ev.value, unit, locale)}`,
      );
    }
  }

  if (forecast.length) {
    lines.push(
      "",
      t(locale, "digest.active_compact", {
        count: forecast.length,
        list: compactList(forecast, locale),
      }),
    );
  }

  lines.push("", nowcastLine(nowcast, locale));

  const more = [links.telegraph, links.site].filter(Boolean).join(" · ");
  if (more) lines.push("", t(locale, "weekly.read_more", { links: more }));
  if (botPromo) lines.push("", t(locale, "digest.bot_promo", { bot: botPromo }));
  return lines.join("\n");
}

/** /now (PLAN2 §11): instant paid snapshot = status + last-24h transitions. */
export function renderNow(
  states: SignalStateRow[],
  composite: CompositeResult,
  events: SignalEventRow[],
  locale: string,
): string {
  const lines = [renderStatus(states, composite, locale), ""];
  if (events.length === 0) {
    lines.push(t(locale, "bot.now_quiet"));
  } else {
    lines.push(t(locale, "bot.now_events"));
    for (const ev of events.slice(0, 8)) {
      const unit = signalUnit(ev.signal_key);
      lines.push(
        `${STATE_ICON[ev.to_state]} ${signalName(ev.signal_key, locale)} → ${formatWithUnit(ev.value, unit, locale)}`,
      );
    }
  }
  return lines.join("\n");
}
