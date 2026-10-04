/** External-venue contract (PLAN2 §3). */
import type Database from "better-sqlite3";

export interface ExternalPost {
  /** Dedup key: d:YYYY-MM-DD · w:YYYY-Www · a:YYYY-Www (self-audit). */
  key: string;
  kind: "daily" | "weekly" | "self_audit";
  locale: string;
  /** First line — used as page/post title where supported. */
  title: string;
  /** Full digest text. */
  text: string;
  /** Canonical site URL for "read more" links. */
  url?: string;
  /** PNG card bytes — optional image attachment. */
  card?: Buffer;
  /** Pre-trimmed text variants (X 280 / Threads 500 / etc.). */
  variants?: { short?: string; medium?: string };
}

export interface PublishResult {
  /** Canonical URL of the created post/page — stored for "read more". */
  url?: string;
}

export interface Venue {
  key: string;
  /** Which digest kinds this venue handles. */
  kinds: ExternalPost["kind"][];
  /** Missing env/config → false → silently skipped. */
  enabled(): boolean;
  /** Whether this venue handles the given post (locale filter etc.). */
  handles(post: ExternalPost): boolean;
  /** `conn` lets multi-target venues (Buffer) dedup each target on the
   * runner's connection — defaults to the shared singleton when omitted. */
  publish(post: ExternalPost, conn?: Database.Database): Promise<PublishResult | null>;
}

/** Locales eligible for syndication — Telegraph overrides per-token. */
export function syndicationLocales(): string[] {
  return (process.env.SYNDICATION_LOCALES ?? "en")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Truncate at a word boundary with an ellipsis. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const ws = cut.lastIndexOf(" ");
  return `${ws > max * 0.6 ? cut.slice(0, ws) : cut}…`;
}

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${url} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  // 204 No Content (e.g. Discord webhooks without ?wait=true) or any empty
  // body: res.json() would throw a parse error → venue marked failed →
  // duplicate on retry (audit F1).
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
