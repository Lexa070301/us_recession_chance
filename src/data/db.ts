import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getConfig } from "../config/load.js";

export interface Migration {
  id: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    id: "0001_init",
    sql: `
      -- Raw observations. vintage_date '' = latest revision;
      -- ALFRED fetches store distinct rows per vintage.
      CREATE TABLE IF NOT EXISTS observations (
        series_key TEXT NOT NULL,
        date TEXT NOT NULL,
        value REAL,
        vintage_date TEXT NOT NULL DEFAULT '',
        fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (series_key, date, vintage_date)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_obs_key_date
        ON observations (series_key, date);

      -- Signal state machine (one row per signal)
      CREATE TABLE IF NOT EXISTS signal_state (
        signal_key TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'ok',
        since TEXT,
        episode_start TEXT,
        last_value REAL,
        last_obs_date TEXT,
        context_json TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Signal transition log = source of SignalEvents
      CREATE TABLE IF NOT EXISTS signal_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_key TEXT NOT NULL,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        value REAL,
        payload_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON signal_events (ts);

      -- Composite score snapshots
      CREATE TABLE IF NOT EXISTS composite_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        score REAL NOT NULL,
        bucket TEXT NOT NULL,
        prob_label TEXT NOT NULL,
        detail_json TEXT
      );

      CREATE TABLE IF NOT EXISTS fetch_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        series_key TEXT NOT NULL,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT NOT NULL,
        rows INTEGER DEFAULT 0,
        error TEXT
      );

      -- Users & preferences
      CREATE TABLE IF NOT EXISTS users (
        tg_user_id INTEGER PRIMARY KEY,
        username TEXT,
        locale TEXT NOT NULL DEFAULT 'en',
        plan TEXT NOT NULL DEFAULT 'free',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT,
        is_blocked INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS user_prefs (
        user_id INTEGER PRIMARY KEY REFERENCES users(tg_user_id),
        enabled_signals_json TEXT,
        min_severity TEXT NOT NULL DEFAULT 'warning',
        delivery_mode TEXT NOT NULL DEFAULT 'digest',
        digest_time TEXT,
        quiet_hours_json TEXT
      );

      CREATE TABLE IF NOT EXISTS channels (
        chat_id INTEGER PRIMARY KEY,
        locale TEXT NOT NULL DEFAULT 'en',
        kind TEXT NOT NULL DEFAULT 'channel',
        title TEXT,
        added_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        user_id INTEGER PRIMARY KEY REFERENCES users(tg_user_id),
        status TEXT NOT NULL DEFAULT 'active',
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT,
        charge_id_last TEXT
      );

      CREATE TABLE IF NOT EXISTS payments (
        charge_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(tg_user_id),
        stars_amount INTEGER NOT NULL,
        period_days INTEGER NOT NULL,
        paid_at TEXT NOT NULL DEFAULT (datetime('now')),
        refund_at TEXT
      );

      -- Delivery outbox with retry
      CREATE TABLE IF NOT EXISTS deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER REFERENCES signal_events(id),
        digest_key TEXT,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        locale TEXT NOT NULL DEFAULT 'en',
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        payload_text TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        sent_at TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries (status);
    `,
  },
  {
    id: "0002_delivery_dedup",
    sql: `
      -- One digest per (digest_key, target): re-running the digest job the
      -- same day must not enqueue duplicates. Event deliveries (digest_key
      -- NULL) are unaffected.
      CREATE UNIQUE INDEX IF NOT EXISTS uq_deliveries_digest
        ON deliveries (digest_key, target_type, target_id)
        WHERE digest_key IS NOT NULL;
    `,
  },
  {
    id: "0003_user_prefs_digest_plus",
    sql: `
      -- Plus-tier preferences: separate digest toggles, nowcast alerts,
      -- personal composite-score alert threshold.
      ALTER TABLE user_prefs ADD COLUMN daily_digest INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE user_prefs ADD COLUMN weekly_digest INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE user_prefs ADD COLUMN nowcast_alerts INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE user_prefs ADD COLUMN score_threshold REAL;
    `,
  },
  {
    id: "0004_episodes_syndications_cards",
    sql: `
      -- External-venue publication log (PLAN2 §3). locale is part of the PK:
      -- multi-locale venues (Telegraph EN+RU pages) need one row per locale;
      -- single-locale venues use '*' or 'en'. Self-audit uses a:YYYY-Www keys.
      CREATE TABLE IF NOT EXISTS syndications (
        venue TEXT NOT NULL,
        locale TEXT NOT NULL,
        digest_key TEXT NOT NULL,
        url TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (venue, locale, digest_key)
      ) WITHOUT ROWID;

      -- Photo dedup outside the text outbox (PLAN2 §4): a digest rerun must
      -- not re-send the card image.
      CREATE TABLE IF NOT EXISTS card_sent_keys (
        digest_key TEXT NOT NULL,
        target_id TEXT NOT NULL,
        sent_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (digest_key, target_id)
      ) WITHOUT ROWID;

      -- Cached replay episodes for the self-audit job (PLAN2 §6): upserted
      -- by (signal_key, start) — pending rows are re-evaluated until the
      -- 12m outcome window resolves, then frozen.
      CREATE TABLE IF NOT EXISTS signal_episodes (
        signal_key TEXT NOT NULL,
        start TEXT NOT NULL,
        end TEXT,
        peak TEXT,
        outcome TEXT,
        evaluated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (signal_key, start)
      ) WITHOUT ROWID;
    `,
  },
  {
    id: "0005_delivery_link_preview",
    sql: `
      -- Optional link-preview URL for a delivery (weekly digest → site page
      -- whose og:image is the card PNG). NULL = preview disabled, same as
      -- before — keeps single-message text posts for everything else.
      ALTER TABLE deliveries ADD COLUMN link_preview_url TEXT;
    `,
  },
];

let db: Database.Database | undefined;

export function getDb(path?: string): Database.Database {
  if (db) return db;
  const dbPath = path ?? getConfig().env.databasePath;
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/** Rebind the singleton (tests). */
export function setDb(conn: Database.Database): void {
  db = conn;
}

export function migrate(conn: Database.Database): void {
  conn.exec(
    "CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  const applied = new Set(
    (conn.prepare("SELECT id FROM migrations").all() as { id: string }[]).map((r) => r.id),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    const run = conn.transaction(() => {
      conn.exec(m.sql);
      conn.prepare("INSERT INTO migrations (id) VALUES (?)").run(m.id);
    });
    run();
  }
}

/** For tests: fresh in-memory DB with migrations applied. */
export function createTestDb(): Database.Database {
  const conn = new Database(":memory:");
  conn.pragma("foreign_keys = ON");
  migrate(conn);
  return conn;
}
