import { z } from "zod";
import type Database from "better-sqlite3";
import { getConfig, getSeriesDef, getSignalDef } from "../config/load.js";
import { getDb } from "../data/db.js";
import {
  getAllSignalStates,
  SEVERITY_ORDER,
  type SignalStateRow,
} from "../data/repositories/signalState.js";
import { computeComposite, scoreScaleMax } from "../signals/score.js";
import { computePooledProb, probBucketLabel } from "../signals/pooledProb.js";
import { t } from "../publish/render/i18n.js";
import { formatWithUnit, splitByBlock } from "../publish/render/templates.js";
import { BUCKET_COLORS } from "../card/data.js";

/**
 * data.json contract for the GitHub Pages site + Telegram Mini App
 * (PLAN2 §2/§14): server-generated, fully localized — the frontend renders
 * `labels` without its own i18n.
 */

export const dashboardDataSchema = z.object({
  generated_at: z.string(),
  score: z.number(),
  /** Display scale top for client-side score charts (scoreScaleMax). */
  score_scale: z.number(),
  bucket: z.string(),
  bucket_color: z.string(),
  prob_label: z.string(),
  model_prob: z.number().nullable(),
  model_prob_label: z.string().nullable(),
  trend: z.array(z.number()),
  active: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      state: z.string(),
      value: z.string(),
    }),
  ),
  nowcast: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      state: z.string(),
      value: z.string(),
    }),
  ),
  labels: z.object({
    title: z.string(),
    subtitle: z.string(),
    score: z.string(),
    model: z.string(),
    nowcast: z.string(),
    nowcast_calm: z.string(),
    active: z.string(),
    trend_90d: z.string(),
    updated: z.string(),
    bot: z.string(),
    channel: z.string(),
  }),
});

export type DashboardData = z.infer<typeof dashboardDataSchema>;

function stateEntry(s: SignalStateRow, locale: string) {
  const def = getSignalDef(s.signal_key);
  const unit = def ? getSeriesDef(def.input.key)?.unit : undefined;
  return {
    key: s.signal_key,
    name: def ? t(locale, `signal.${def.key}.name`) : s.signal_key,
    state: s.state,
    value: s.last_value === null ? "" : formatWithUnit(s.last_value, unit, locale),
  };
}

export function buildDashboardData(locale: string, conn?: Database.Database): DashboardData {
  const db = conn ?? getDb();
  const cfg = getConfig();
  const states = getAllSignalStates(db);
  const composite = computeComposite(
    new Map(states.map((s) => [s.signal_key, s])),
    cfg.signals,
  );
  composite.modelProb = computePooledProb(db);

  const { forecast, nowcast } = splitByBlock(states);
  const active = [...forecast]
    .sort((a, b) => SEVERITY_ORDER[b.state] - SEVERITY_ORDER[a.state])
    .map((s) => stateEntry(s, locale));
  const nowcastEntries = nowcast.map((s) => stateEntry(s, locale));

  const trend = (
    db
      .prepare(
        `SELECT score FROM composite_snapshots
         WHERE ts >= datetime('now', '-90 days') ORDER BY ts`,
      )
      .all() as { score: number }[]
  ).map((r) => r.score);

  const p = composite.modelProb;
  return dashboardDataSchema.parse({
    generated_at: new Date().toISOString(),
    score: composite.score,
    score_scale: scoreScaleMax(),
    bucket: composite.bucket,
    bucket_color: BUCKET_COLORS[composite.bucket] ?? "#94a3b8",
    prob_label: composite.probLabel,
    model_prob: p ?? null,
    model_prob_label: p === null || p === undefined ? null : probBucketLabel(p),
    trend,
    active,
    nowcast: nowcastEntries,
    labels: {
      title: t(locale, "site.title"),
      subtitle: t(locale, "site.subtitle"),
      score: t(locale, "site.score"),
      model: t(locale, "site.model"),
      nowcast: t(locale, "site.nowcast"),
      nowcast_calm: t(locale, "site.nowcast_calm"),
      active: t(locale, "site.active"),
      trend_90d: t(locale, "site.trend_90d"),
      updated: t(locale, "site.updated"),
      bot: t(locale, "site.bot"),
      channel: t(locale, "site.channel"),
    },
  });
}
