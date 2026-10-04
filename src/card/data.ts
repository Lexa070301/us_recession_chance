import type Database from "better-sqlite3";
import { getConfig, getSeriesDef, getSignalDef } from "../config/load.js";
import { getDb } from "../data/db.js";
import {
  getAllSignalStates,
  SEVERITY_ORDER,
  type SignalStateRow,
} from "../data/repositories/signalState.js";
import { computeComposite } from "../signals/score.js";
import { computePooledProb, probBucketLabel } from "../signals/pooledProb.js";
import { t } from "../publish/render/i18n.js";
import { formatWithUnit, splitByBlock } from "../publish/render/templates.js";

export interface CardActive {
  state: SignalStateRow["state"];
  name: string;
  value: string;
}

export interface CardData {
  locale: string;
  date: string;
  bucket: string;
  bucketLabel: string;
  score: string;
  modelProbLabel: string | null;
  /** Composite scores over the last ~90 days, oldest → newest. */
  trend: number[];
  active: CardActive[];
  nowcast: string;
  handle: string;
  /** One-line verdict used as the photo caption (Telegram limit 1024). */
  caption: string;
}

/** Bucket accent colors — shared by card, site and Mini App. */
export const BUCKET_COLORS: Record<string, string> = {
  low: "#4ade80",
  elevated: "#f59e0b",
  high: "#f97316",
  severe: "#ef4444",
};

/** State accent colors for the card chips — no emoji in the PNG (Inter has
 * no emoji glyphs and pulling twemoji would make renders network-dependent). */
export const STATE_COLORS: Record<string, string> = {
  ok: "#4ade80",
  watch: "#f59e0b",
  warning: "#f97316",
  critical: "#ef4444",
};

/** Recent composite scores for the sparkbar (sparse snapshots are fine). */
export function trendScores(days: number, conn?: Database.Database): number[] {
  const db = conn ?? getDb();
  const rows = db
    .prepare(
      `SELECT score FROM composite_snapshots
       WHERE ts >= datetime('now', ?) ORDER BY ts`,
    )
    .all(`-${days} days`) as { score: number }[];
  return rows.map((r) => r.score);
}

export function collectCardData(locale: string, conn?: Database.Database): CardData {
  const db = conn ?? getDb();
  const cfg = getConfig();
  const states = getAllSignalStates(db);
  const composite = computeComposite(
    new Map(states.map((s) => [s.signal_key, s])),
    cfg.signals,
  );
  composite.modelProb = computePooledProb(db);

  const { forecast, nowcast } = splitByBlock(states);
  const nowcastActive = nowcast.filter((s) => s.state !== "ok");
  const nowcastText =
    nowcastActive.length === 0
      ? t(locale, "card.nowcast_calm")
      : t(locale, "card.nowcast_active", {
          names: nowcastActive
            .map((s) => {
              const def = getSignalDef(s.signal_key);
              return def ? t(locale, `signal.${def.key}.name`) : s.signal_key;
            })
            .join(", "),
        });
  const active = [...forecast]
    .sort((a, b) => SEVERITY_ORDER[b.state] - SEVERITY_ORDER[a.state])
    .slice(0, 3)
    .map((s) => {
      const def = getSignalDef(s.signal_key);
      const unit = def ? (def.unit ?? getSeriesDef(def.input.key)?.unit) : undefined;
      return {
        state: s.state,
        name: def ? t(locale, `signal.${def.key}.name`) : s.signal_key,
        value: s.last_value === null ? "" : formatWithUnit(s.last_value, unit, locale),
      };
    });

  const score = composite.score.toFixed(1);
  const modelProbLabel =
    composite.modelProb === null || composite.modelProb === undefined
      ? null
      : probBucketLabel(composite.modelProb);
  const bucketLabel = t(locale, `bucket.${composite.bucket}`);
  const handle = cfg.env.botUsername ? `@${cfg.env.botUsername}` : t(locale, "app.name");

  return {
    locale,
    date: new Date().toISOString().slice(0, 10),
    bucket: composite.bucket,
    bucketLabel,
    score,
    modelProbLabel,
    trend: trendScores(90, db),
    active,
    nowcast: nowcastText,
    handle,
    caption: t(locale, "card.caption", { bucket: bucketLabel, score }),
  };
}

export { STATE_COLORS as CARD_STATE_COLORS };
