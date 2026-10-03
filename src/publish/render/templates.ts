import { getConfig, getSeriesDef, getSignalDef } from "../../config/load.js";
import type { SignalDef } from "../../config/schema.js";
import type {
  SignalEventRow,
  SignalState,
  SignalStateRow,
} from "../../data/repositories/signalState.js";
import type { CompositeResult } from "../../signals/score.js";
import { probBucketLabel } from "../../signals/pooledProb.js";
import { t } from "./i18n.js";

const STATE_ICON: Record<SignalState, string> = {
  ok: "✅",
  watch: "👀",
  warning: "⚠️",
  critical: "🚨",
};

const UNITS_WITH_DECIMALS = new Set(["percent", "pct_points", "index", "ratio", "binary"]);

export function formatValue(value: number | null, unit?: string): string {
  if (value === null || value === undefined) return "N/A";
  if (!unit || UNITS_WITH_DECIMALS.has(unit)) return value.toFixed(2);
  if (unit.startsWith("usd_")) return `$${Math.round(value).toLocaleString("en-US")}`;
  return Math.round(value).toLocaleString("en-US");
}

function transitionLabel(from: SignalState, to: SignalState, locale: string): string {
  const toLabel = to === "ok" ? t(locale, "state_change.cleared") : t(locale, `severity.${to}`);
  return `${t(locale, `severity.${from}`)} → ${toLabel}`;
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

export function compositeLine(composite: CompositeResult, locale: string): string {
  const activeCount = Object.values(composite.detail).filter((d) => d.state !== "ok").length;
  const scoreLine = t(locale, "composite.line", {
    score: composite.score.toFixed(1),
    bucket: t(locale, `bucket.${composite.bucket}`),
    prob: composite.probLabel,
    active: t(locale, "composite.active_count", { count: activeCount }),
  });
  const p = composite.modelProb;
  if (p === null || p === undefined) return scoreLine;

  // Model probability is the headline number; the score line explains the basis.
  const lines = [t(locale, "composite.model_prob", { prob: probBucketLabel(p) }), scoreLine];
  if (composite.bucket === "low" && p >= 0.25) {
    lines.push(t(locale, "composite.divergence_model"));
  } else if (composite.bucket !== "low" && p < 0.1) {
    lines.push(t(locale, "composite.divergence_signals"));
  }
  return lines.join("\n");
}

export function renderSignalEvent(
  event: SignalEventRow,
  composite: CompositeResult | null,
  locale: string,
): string {
  const signal = getSignalDef(event.signal_key);
  const name = signal ? t(locale, `signal.${signal.key}.name`) : event.signal_key;
  const desc = signal ? t(locale, `signal.${signal.key}.desc`) : "";
  const unit = signal ? getSeriesDef(signal.input.key)?.unit : undefined;

  const lines: string[] = [
    t(locale, "event.title", { icon: STATE_ICON[event.to_state], name }),
    t(locale, "event.transition", {
      label: transitionLabel(event.from_state, event.to_state, locale),
    }),
    t(locale, "event.value", { value: formatValue(event.value, unit) }),
  ];

  const ctx = event.payload_json ? (JSON.parse(event.payload_json) as Record<string, unknown>) : {};
  const since = (ctx.since as string) ?? null;
  if (event.to_state !== "ok" && since) {
    lines.push(t(locale, "event.since", { since }));
  }
  if (desc) lines.push(desc);
  if (signal) {
    const hist = histLine(signal, locale);
    if (hist) lines.push(`_${hist}_`);
  }
  if (composite) {
    lines.push("", t(locale, "composite.title"), compositeLine(composite, locale));
  }
  lines.push("", t(locale, "bot.disclaimer_short"));
  return lines.join("\n");
}

export function renderStatus(
  states: SignalStateRow[],
  composite: CompositeResult,
  locale: string,
): string {
  const cfg = getConfig();
  const lines: string[] = [t(locale, "composite.title"), compositeLine(composite, locale), ""];

  const active = states.filter((s) => s.state !== "ok");
  const nowcast = states.filter((s) => {
    const def = getSignalDef(s.signal_key);
    return def?.block === "nowcast" && s.state !== "ok";
  });

  const nonNowcast = active.filter(
    (s) => getSignalDef(s.signal_key)?.block !== "nowcast",
  );

  if (nonNowcast.length === 0) {
    lines.push(t(locale, "bot.status_empty"));
  } else {
    lines.push(t(locale, "digest.section_active"));
    for (const s of nonNowcast) {
      const def = getSignalDef(s.signal_key);
      const name = def ? t(locale, `signal.${def.key}.name`) : s.signal_key;
      const unit = def ? getSeriesDef(def.input.key)?.unit : undefined;
      lines.push(`${STATE_ICON[s.state]} ${name} — ${formatValue(s.last_value, unit)}`);
    }
  }

  if (nowcast.length) {
    lines.push("", t(locale, "composite.nowcast_title"));
    for (const s of nowcast) {
      const def = getSignalDef(s.signal_key);
      const name = def ? t(locale, `signal.${def.key}.name`) : s.signal_key;
      lines.push(`${STATE_ICON[s.state]} ${name}`);
    }
  }

  lines.push("", t(locale, "bot.disclaimer_short"));
  void cfg;
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
  const eventsKey = kind === "weekly" ? "digest.section_events_weekly" : "digest.section_events";
  const lines: string[] = [t(locale, titleKey, { date }), ""];

  if (events.length) {
    lines.push(t(locale, eventsKey));
    for (const ev of events) {
      const def = getSignalDef(ev.signal_key);
      const name = def ? t(locale, `signal.${def.key}.name`) : ev.signal_key;
      lines.push(
        `${STATE_ICON[ev.to_state]} ${name} — ${transitionLabel(ev.from_state, ev.to_state, locale)}`,
      );
    }
    lines.push("");
  }

  const active = states.filter(
    (s) => s.state !== "ok" && getSignalDef(s.signal_key)?.block !== "nowcast",
  );
  if (active.length) {
    lines.push(t(locale, "digest.section_active"));
    for (const s of active) {
      const def = getSignalDef(s.signal_key);
      const name = def ? t(locale, `signal.${def.key}.name`) : s.signal_key;
      const unit = def ? getSeriesDef(def.input.key)?.unit : undefined;
      lines.push(`${STATE_ICON[s.state]} ${name} — ${formatValue(s.last_value, unit)}`);
    }
    lines.push("");
  }

  lines.push(t(locale, "composite.title"), compositeLine(composite, locale));
  lines.push("", t(locale, "bot.disclaimer_short"));
  if (botPromo) lines.push("", t(locale, "digest.bot_promo", { bot: botPromo }));
  return lines.join("\n");
}

/** Plus: composite score crossed the user's personal threshold upward. */
export function renderCompositeAlert(
  composite: CompositeResult,
  threshold: number,
  locale: string,
): string {
  return [
    t(locale, "composite.threshold_alert", {
      threshold,
      score: composite.score.toFixed(1),
      bucket: t(locale, `bucket.${composite.bucket}`),
      prob: composite.probLabel,
    }),
    compositeLine(composite, locale),
    "",
    t(locale, "bot.disclaimer_short"),
  ].join("\n");
}

/** Plus: per-signal detail — state, value, historical hit-rate, lead. */
export function renderAnalytics(states: SignalStateRow[], locale: string): string {
  const lines: string[] = [t(locale, "analytics.title"), ""];
  const byKey = new Map(states.map((s) => [s.signal_key, s]));

  const block = (label: string, defs: SignalDef[]) => {
    if (!defs.length) return;
    lines.push(label);
    for (const def of defs) {
      const st = byKey.get(def.key);
      const state = st?.state ?? "ok";
      const unit = getSeriesDef(def.input.key)?.unit;
      let line = `${STATE_ICON[state]} ${t(locale, `signal.${def.key}.name`)} — ${t(locale, `severity.${state}`)}`;
      if (st?.last_value !== null && st?.last_value !== undefined) {
        line += ` · ${formatValue(st.last_value, unit)}`;
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
    lines.push("");
  };

  const defs = getConfig().signals;
  block(t(locale, "analytics.forecast"), defs.filter((d) => d.block !== "nowcast"));
  block(t(locale, "analytics.nowcast"), defs.filter((d) => d.block === "nowcast"));
  lines.push(t(locale, "bot.disclaimer_short"));
  return lines.join("\n");
}
