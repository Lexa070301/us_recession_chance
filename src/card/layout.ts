import { BUCKET_COLORS, CARD_STATE_COLORS, type CardData } from "./data.js";
import { scoreScaleMax } from "../signals/score.js";
import { t } from "../publish/render/i18n.js";

/**
 * Satori layout tree — plain objects, no JSX (tsconfig has no `jsx` and
 * scripts/ sit outside rootDir, so a JSX path wouldn't compile anyway).
 * satori accepts this shape directly.
 */

type Style = Record<string, unknown>;

export interface CardNode {
  type: string;
  props: { style?: Style; children?: (CardNode | string)[] | string };
}

const div = (style: Style, children: (CardNode | string)[] | string = []): CardNode => ({
  // satori requires an explicit display on divs with >1 child — every
  // container here is flex anyway.
  type: "div",
  props: { style: { display: "flex", ...style }, children },
});

const TXT = "#e5e7eb";
const DIM = "#94a3b8";
const FAINT = "#64748b";
const PANEL = "#16233b";
const BAR = "#334155";

/** Sparkbar chart as div columns — satori can't render arbitrary <svg> reliably. */
function sparkbars(trend: number[], accent: string): CardNode {
  const max = scoreScaleMax(); // derived from model.yaml bands — not hardcoded
  const pts = trend.slice(-42);
  if (!pts.length) {
    return div(
      { display: "flex", alignItems: "flex-end", height: 170, color: FAINT, fontSize: 24 },
      "—",
    );
  }
  const bars: CardNode[] = pts.map((v, i) => {
    const h = Math.max(6, Math.round((Math.min(v, max) / max) * 160));
    return div({
      width: 11,
      height: h,
      borderRadius: 3,
      backgroundColor: i === pts.length - 1 ? accent : BAR,
    });
  });
  return div(
    {
      display: "flex",
      alignItems: "flex-end",
      gap: 5,
      height: 170,
    },
    bars,
  );
}

function activeChip(a: CardData["active"][number]): CardNode {
  return div(
    {
      display: "flex",
      alignItems: "center",
      gap: 12,
      backgroundColor: PANEL,
      borderRadius: 14,
      padding: "14px 22px",
      fontSize: 26,
      color: TXT,
    },
    [
      div({
        width: 16,
        height: 16,
        borderRadius: 8,
        backgroundColor: CARD_STATE_COLORS[a.state] ?? DIM,
      }),
      div({ color: TXT }, a.name),
      div({ color: DIM }, a.value),
    ],
  );
}

export function cardTree(d: CardData): CardNode {
  const accent = BUCKET_COLORS[d.bucket] ?? DIM;
  const modelLine =
    (d.modelProbLabel === null
      ? `score ${d.score}`
      : `${d.modelProbLabel} · score ${d.score}`) + (d.scoreNext ? ` · ${d.scoreNext}` : "");

  const activeRow =
    d.active.length > 0
      ? div(
          {
            display: "flex",
            gap: 14,
            marginTop: 8,
          },
          d.active.map(activeChip),
        )
      : div({ height: 8 });

  return div(
    {
      width: 1200,
      height: 630,
      display: "flex",
      flexDirection: "column",
      padding: "52px 60px",
      backgroundColor: "#0d1524",
      color: TXT,
      fontFamily: "Inter",
    },
    [
      // header
      div(
        {
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 26,
          color: FAINT,
          letterSpacing: 4,
        },
        [div({}, t(d.locale, "app.name").toUpperCase()), div({ letterSpacing: 1 }, d.date)],
      ),

      // main: verdict + sparkbars
      div({ display: "flex", flex: 1, alignItems: "center", gap: 48 }, [
        div({ display: "flex", flexDirection: "column", flex: 1 }, [
          div({ fontSize: 92, fontWeight: 700, color: accent, letterSpacing: 2 }, d.bucketLabel),
          div({ fontSize: 30, color: DIM, marginTop: 6 }, modelLine),
        ]),
        div({ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 12 }, [
          sparkbars(d.trend, accent),
          div({ fontSize: 20, color: FAINT }, t(d.locale, "card.trend_90d")),
        ]),
      ]),

      activeRow,

      // footer
      div(
        {
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 22,
          fontSize: 24,
          color: FAINT,
        },
        [div({}, d.nowcast), div({}, d.handle)],
      ),
    ],
  );
}
