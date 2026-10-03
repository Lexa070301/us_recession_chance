# AGENTS.md

## Project

US recession signal monitor. Collects leading recession indicators from FRED
(and later Treasury/other free sources), evaluates a configurable signal engine,
produces a composite 12-month recession risk estimate, and delivers localized
alerts — initially via Telegram channels and DM bot, later other platforms.

Inspired by (but not a fork of) https://github.com/realwaynesun/fed_monitor —
used as an architectural specification. See PLAN.md for the roadmap and
docs/research notes for the indicator list and methodology.

## Stack

- Node.js >= 20, TypeScript, ESM (`"type": "module"`, NodeNext resolution)
- SQLite via `better-sqlite3` (plain SQL migrations, no ORM)
- `grammy` for the Telegram bot (channels + DM + Stars payments)
- `node-cron` for scheduling, `yaml` + `zod` for config, `i18next` for locales
- `tsx` for dev runs, `vitest` for tests

## Commands

- `npm run dev` — run entry point via tsx
- `npm run typecheck` — `tsc --noEmit` (run before committing)
- `npm test` — vitest
- `npm run build` / `npm start` — compile / run compiled output

## Conventions

- All indicator/signal definitions live in `config/` YAML files, validated by
  zod schemas — code should stay data-driven, mirroring fed_monitor's design.
- Never hardcode thresholds or message text in source; use config + locale files.
- `data/` (SQLite DB) and `.env` are gitignored; `.env.example` documents vars.
- Keep DEVLOG.md updated with dated entries when making meaningful changes.
- Commit messages: concise, focus on "why".

## Key docs

- `PLAN.md` — implementation roadmap (phases, schemas, signal catalog)
- `DEVLOG.md` — chronological development log
- `.env.example` — required environment variables
