import { getConfig, getChannelTargets } from "../config/load.js";
import { getDb } from "../data/db.js";
import { getObservations } from "../data/repositories/observations.js";
import { enqueueDelivery } from "../data/repositories/deliveries.js";
import { upsertEpisode } from "../data/repositories/episodes.js";
import { getCompositeAtOrBefore } from "../data/repositories/signalState.js";
import { getRecessionPeriods } from "../data/nber.js";
import { processDeliveries } from "../publish/publisher.js";
import { t } from "../publish/render/i18n.js";
import { syndicatePosts } from "../publish/syndication/index.js";
import { SeriesCache, detectEpisodes, latestSource, monthAdd, monthIndex } from "../backtest/replay.js";
import { classifyEpisodes, HORIZON_MONTHS } from "../backtest/stats.js";
import { digestKey } from "./digest.js";
import type { RecessionPeriod } from "../data/nber.js";

/**
 * Weekly self-audit (PLAN2 §6): "what the signals said — and what followed."
 * Replays every signal, refreshes the append-only episode cache, and posts
 * a transparent hit/false-positive/pending report to the channels.
 *
 * Runs only in the publishing environment (SYNDICATION_ENABLED) — the two
 * environments have separate SQLite files, so without this gate the server
 * scheduler would post a duplicate (see PLAN2 §0). Channel delivery goes
 * through the normal outbox with an `a:YYYY-Www` dedup key.
 */

interface AuditSignalLine {
  key: string;
  name: string;
  episodes: number;
  hits: number;
  fp: number;
  pending: number;
}

/** Score snapshot ~52w ago → did an NBER recession start within 12m? */
function scoreVerdict(
  recessions: RecessionPeriod[],
  cutoffMonth: string,
): { verdict: "hit" | "miss" | "open"; until: string } {
  const cutoff = monthIndex(cutoffMonth);
  const until = monthAdd(cutoffMonth, HORIZON_MONTHS);
  if (monthIndex(until) > monthIndex(new Date().toISOString().slice(0, 7))) {
    return { verdict: "open", until };
  }
  const hit = recessions.some((r) => {
    const s = monthIndex(r.start);
    return s > cutoff && s <= cutoff + HORIZON_MONTHS;
  });
  return { verdict: hit ? "hit" : "miss", until };
}

export function renderAudit(
  lines: AuditSignalLine[],
  scoreLine: string | null,
  noSnapshotNote: string | null,
  totals: { hits: number; fp: number; pending: number; earliestOpen: string | null },
  locale: string,
  weekLabel: string,
): string {
  const out: string[] = [t(locale, "audit.title", { week: weekLabel }), ""];
  out.push(scoreLine ?? noSnapshotNote ?? "");
  out.push("", t(locale, "audit.signals_header"));

  const top = [...lines].sort((a, b) => b.episodes - a.episodes).slice(0, 5);
  for (const l of top) {
    const pendStr = l.pending
      ? t(locale, "audit.pending_suffix", { n: l.pending })
      : "";
    out.push(
      t(locale, "audit.line", {
        name: l.name,
        episodes: l.episodes,
        hits: l.hits,
        fp: l.fp,
        pending: pendStr,
      }),
    );
  }

  out.push(
    "",
    t(locale, "audit.totals", {
      hits: totals.hits,
      fp: totals.fp,
      pending: totals.pending,
      until: totals.earliestOpen ? t(locale, "audit.open_until", { date: totals.earliestOpen }) : "",
    }),
    "",
    t(locale, "audit.method"),
  );
  return out.join("\n");
}

export async function jobSelfAudit(): Promise<void> {
  // Publication environment only — prevents a double post from the server DB.
  if (process.env.SYNDICATION_ENABLED !== "true") return;
  const cfg = getConfig();
  const db = getDb();
  if (new Date().getUTCDay() !== cfg.channels.defaults.weekly_digest_day_utc) return;

  const key = digestKey("weekly").replace(/^w:/, "a:");
  const weekLabel = key.slice(2);
  console.log(`[self-audit] building ${weekLabel}`);

  // --- episode replay + cache refresh ------------------------------------
  const source = latestSource(new SeriesCache(db));
  const recessions = getRecessionPeriods(db);
  const usrecObs = getObservations("usrec", {}, db);
  const usrecLastMonth = usrecObs[usrecObs.length - 1]?.date.slice(0, 7) ?? "0000-00";

  const lines: AuditSignalLine[] = [];
  const totals = { hits: 0, fp: 0, pending: 0, earliestOpen: null as string | null };

  for (const sig of cfg.signals) {
    const episodes = detectEpisodes(source.replay(sig));
    const classified = classifyEpisodes(
      episodes,
      recessions,
      usrecLastMonth,
      sig.block === "nowcast",
    );
    const line: AuditSignalLine = {
      key: sig.key,
      name: "",
      episodes: episodes.length,
      hits: 0,
      fp: 0,
      pending: 0,
    };
    for (const { ep, outcome } of classified) {
      if (outcome === "hit") line.hits++;
      else if (outcome === "fp") line.fp++;
      else line.pending++;
      upsertEpisode(
        { signalKey: sig.key, start: ep.start, end: ep.end, peak: ep.peak, outcome },
        db,
      );
      if (outcome === "pending") {
        const until = monthAdd(ep.start.slice(0, 7), HORIZON_MONTHS);
        if (!totals.earliestOpen || until < totals.earliestOpen) totals.earliestOpen = until;
      }
    }
    totals.hits += line.hits;
    totals.fp += line.fp;
    totals.pending += line.pending;
    if (line.episodes) lines.push(line);
  }

  // --- score a year ago ---------------------------------------------------
  const cutoff52 = new Date(Date.now() - 364 * 864e5).toISOString().slice(0, 19).replace("T", " ");
  const snap = getCompositeAtOrBefore(cutoff52, db);
  const cutoffMonth = cutoff52.slice(0, 7);
  const verdict = scoreVerdict(recessions, cutoffMonth);

  const locales = new Set<string>([cfg.channels.defaults.fallback_locale]);
  for (const ch of getChannelTargets()) locales.add(ch.locale);
  const texts = new Map<string, string>();
  for (const loc of locales) {
    for (const l of lines) l.name = t(loc, `signal.${l.key}.name`);
    const scoreLine = snap
      ? t(loc, "audit.score_year", {
          score: snap.score.toFixed(1),
          bucket: t(loc, `bucket.${snap.bucket}`),
          verdict: t(loc, `audit.verdict_${verdict.verdict}`),
          until: verdict.until,
        })
      : null;
    texts.set(
      loc,
      renderAudit(
        lines,
        scoreLine,
        snap ? null : t(loc, "audit.no_snapshot", { date: cutoff52.slice(0, 10) }),
        totals,
        loc,
        weekLabel,
      ),
    );
  }

  // --- channel posts through the outbox (a: dedup key, retries for free) --
  let enqueued = 0;
  const fb = cfg.channels.defaults.fallback_locale;
  for (const ch of getChannelTargets()) {
    enqueued += enqueueDelivery(
      {
        digestKey: key,
        targetType: "channel",
        targetId: ch.chatId,
        locale: ch.locale,
        payloadText: texts.get(ch.locale) ?? texts.get(fb)!,
      },
      db,
    )
      ? 1
      : 0;
  }
  const res = await processDeliveries(db);
  console.log(`[self-audit] enqueued=${enqueued} sent=${res.sent} failed=${res.failed}`);

  // --- external venues ----------------------------------------------------
  const siteUrl = (process.env.SITE_URL ?? "").replace(/\/$/, "");
  const posts = [...texts.entries()].map(([loc, text]) => ({
    key,
    kind: "self_audit" as const,
    locale: loc,
    title: text.split("\n")[0],
    text,
    url: siteUrl ? `${siteUrl}${loc === fb ? "" : `/${loc}`}` : undefined,
  }));
  const syn = await syndicatePosts(posts, db);
  console.log(`[self-audit] syndication published=${syn.published} skipped=${syn.skipped} failed=${syn.failed}`);
}
