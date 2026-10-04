import type Database from "better-sqlite3";
import { getConfig } from "../config/load.js";
import { getDb } from "../data/db.js";
import { getRecessionPeriods } from "../data/nber.js";
import {
  asofSource,
  detectEpisodes,
  latestSource,
  monthIndex,
  VintageSeriesCache,
  SeriesCache,
  type Episode,
} from "../backtest/replay.js";
import { SEVERITY_ORDER, type SignalState } from "../data/repositories/signalState.js";
import { t } from "../publish/render/i18n.js";

/**
 * /episodes YYYY [–YYYY] [asof] (PLAN2 §10): historical episode search.
 * Replays every signal over its full history and reports which episodes
 * intersect the requested year range + the NBER record for that window.
 *
 * `asof` replays on ALFRED point-in-time vintages (§1) — what the signal
 * would have said in real time; default is latest-revision (noted in output).
 */

export interface EpisodesArgs {
  from: number;
  to: number;
  asof: boolean;
}

/** Tap-friendly entry points — every NBER recession + the 2023–24 scare.
 *  Labels live in locales under `episodes.preset.<key>`. */
export const EPISODE_PRESETS: { key: string; from: number; to: number }[] = [
  { key: "double_dip", from: 1980, to: 1982 },
  { key: "early90s", from: 1990, to: 1991 },
  { key: "dotcom", from: 2001, to: 2001 },
  { key: "gfc", from: 2008, to: 2009 },
  { key: "covid", from: 2020, to: 2020 },
  { key: "inversion2324", from: 2023, to: 2024 },
];

/** "2008" | "2007-2009" | "2008 asof" | "2007–2009 asof" → parsed args. */
export function parseEpisodesArgs(arg: string): EpisodesArgs | null {
  const s = arg.trim().toLowerCase();
  const asof = /\basof\b/.test(s);
  const years = s.replace(/\basof\b/g, "").trim();
  const m = /^(\d{4})(?:\s*[-–]\s*(\d{4}))?$/.exec(years);
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  if (from < 1940 || to > new Date().getFullYear() || to < from) return null;
  return { from, to, asof };
}

/** Episode ↔ year-range overlap (month precision). */
function overlaps(ep: Episode, from: string, to: string): boolean {
  const s = ep.start.slice(0, 7);
  const e = (ep.end ?? "9999-12").slice(0, 7);
  return s <= to && e >= from;
}

// Rendered answers are stable for a day — replaying ~20 signals is seconds
// (asof sahm_states replays 51 series — heavier), but closed-year episodes
// cannot change until new data lands. Cache is bounded: keys accumulate
// otherwise (audit H3).
const cache = new Map<string, { text: string; at: number }>();
const TTL_MS = 24 * 3600 * 1000;
const CACHE_MAX = 64;
export const _episodesCache = cache; // exposed for tests

function cacheSet(key: string, text: string): void {
  if (cache.size >= CACHE_MAX) {
    // Map preserves insertion order — evict the oldest entry.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { text, at: Date.now() });
}

export function renderEpisodes(
  args: EpisodesArgs,
  locale: string,
  conn?: Database.Database,
): string {
  const db = conn ?? getDb();
  const cacheKey = `${args.from}-${args.to}|${args.asof ? "asof" : "latest"}|${locale}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.text;

  const cfg = getConfig();
  const fromMonth = `${args.from}-01`;
  const toMonth = `${args.to}-12`;
  const source = args.asof
    ? asofSource(new VintageSeriesCache(db))
    : latestSource(new SeriesCache(db));

  const recessions = getRecessionPeriods(db).filter(
    (r) => r.end >= fromMonth && r.start <= toMonth,
  );

  // Replay each signal ONCE — the NBER catch loop below reuses these
  // episodes; re-replaying per recession was O(recessions × signals) (H3).
  const episodesBySignal = new Map<string, Episode[]>();
  interface SignalHit {
    key: string;
    peak: SignalState;
    lines: string[];
    episodes: number;
  }
  const hits: SignalHit[] = [];
  for (const sig of cfg.signals) {
    const eps = detectEpisodes(source.replay(sig));
    episodesBySignal.set(sig.key, eps);
    const inWindow = eps.filter((ep) => overlaps(ep, fromMonth, toMonth));
    if (!inWindow.length) continue;
    const name = t(locale, `signal.${sig.key}.name`);
    hits.push({
      key: sig.key,
      episodes: inWindow.length,
      peak: inWindow.reduce((a, b) => (SEVERITY_ORDER[b.peak] > SEVERITY_ORDER[a.peak] ? b : a)).peak,
      lines: inWindow.map(
        (ep) =>
          `  · ${name}: ${ep.start.slice(0, 7)} → ${ep.end ? ep.end.slice(0, 7) : "…"} (${t(locale, `severity.${ep.peak}`)})`,
      ),
    });
  }
  hits.sort((a, b) => SEVERITY_ORDER[b.peak] - SEVERITY_ORDER[a.peak]);

  const out: string[] = [
    t(locale, "episodes.title", {
      range: args.from === args.to ? `${args.from}` : `${args.from}–${args.to}`,
      mode: t(locale, args.asof ? "episodes.mode_asof" : "episodes.mode_latest"),
    }),
  ];

  // NBER record for the window + how many signals caught each recession
  const forecastCount = cfg.signals.filter((s) => s.block !== "nowcast" && s.weight > 0).length;
  for (const r of recessions) {
    const caught = cfg.signals.filter((sig) => {
      if (sig.block === "nowcast" || sig.weight <= 0) return false;
      return (episodesBySignal.get(sig.key) ?? []).some(
        (ep) =>
          monthIndex(ep.start.slice(0, 7)) <= monthIndex(r.start) &&
          monthIndex((ep.end ?? ep.start).slice(0, 7)) >= monthIndex(r.start) - 24,
      );
    }).length;
    out.push(
      "",
      t(locale, "episodes.nber", {
        period: `${r.start}–${r.end}`,
        caught,
        total: forecastCount,
      }),
    );
  }
  if (!recessions.length) {
    out.push("", t(locale, "episodes.nber_none"));
  }

  if (hits.length) {
    out.push("", t(locale, "episodes.signal_header"));
    const lines = hits.flatMap((h) => h.lines);
    const MAX = 30;
    out.push(...lines.slice(0, MAX));
    if (lines.length > MAX) out.push(t(locale, "episodes.more", { n: lines.length - MAX }));
  } else {
    out.push("", t(locale, "episodes.quiet"));
  }

  out.push("", t(locale, "episodes.note", { mode: t(locale, args.asof ? "episodes.mode_asof" : "episodes.mode_latest") }));
  const text = out.join("\n").slice(0, 4096);
  cacheSet(cacheKey, text);
  return text;
}
