# PLAN.md — us-recession-chance

Дорожная карта реализации. Статус фаз отмечается по ходу; значимые решения —
в DEVLOG.md.

---

## 0. Цель и рамки

Продукт: мониторинг опережающих сигналов рецессии США → композитная оценка
вероятности рецессии в течение 12 месяцев → локализованные уведомления.

Формат уведомления (целевой):

```
✅/⚠️/❌ Signal name — value — short description
(historical: recession within 12m after this signal in N of M episodes)
...
📊 Composite 12m risk: <bucket> (<calibrated band>)
```

**В рамках проекта сейчас:** FRED/ALFRED-данные, сигнальный движок,
композитный скор, Telegram (каналы + бот + per-user настройки + Stars-оплата),
мультиязычность.

**Out of scope (пока):** X/Twitter-публикации, e-mail/SMS, web-дашборд,
лицензированные данные (ISM PMI, Conference Board LEI), доставка «в реальном
времени» (частоты данных: daily/weekly/monthly/quarterly).

**Ключевой принцип архитектуры:** ядро порождает каноническое событие
`SignalEvent`; адаптеры доставки только рендерят и доставляют. Пользовательские
настройки фильтруют события на уровне маршрутизации, не движка.

---

## 1. Архитектура

```
 config/*.yaml ──────────────────────────────────────────────┐
 (series, signals, weights, hist stats, channels, locales)   ▼
┌─────────┐   ┌──────────────┐   ┌────────────────┐   ┌──────────────┐
│ Fetcher │──▶│ SQLite       │──▶│ SignalEngine   │──▶│ SignalEvent  │
│ FRED /  │   │ observations │   │ evaluators     │   │ (canonical)  │
│ ALFRED  │   │ state        │   │ state machine  │   └──────┬───────┘
│ USREC   │   │ users/subs   │   │ score + prob   │          │
└─────────┘   └──────────────┘   └────────────────┘          ▼
                                                ┌─────────────────────┐
                                                │ Publisher (fan-out) │
                                                │ ├ TGChannel (locale)│
                                                │ ├ TG DM (per-user)  │
                                                │ ├ X       (later)   │
                                                │ └ Email   (later)   │
                                                └─────────────────────┘
                                                         ▲
                                                ┌────────┴────────┐
                                                │ grammY bot      │
                                                │ prefs, payments │
                                                └─────────────────┘
```

Spec-источник для data-слоя: `fed_monitor` (MIT). Переносим механику
(config-driven series/metrics/alerts, incremental fetch, SQLite, state
machine), исправляя баги и расширяя под сигнальную модель.

---

## 2. Структура проекта

```
src/
  config/            # zod-схемы + загрузчик config/*.yaml
    schema.ts
    load.ts
  data/
    db.ts            # better-sqlite3 connection + миграции (plain SQL)
    repositories/
      observations.ts
      signalState.ts
      users.ts
      subscriptions.ts
      deliveries.ts
    fredClient.ts    # rate limit, retries, incremental fetch, vintages
    nber.ts          # даты рецессий (USREC из FRED)
  metrics/
    transforms.ts    # diff, pct_change, rolling, zscore, yoy, ma_n_weeks
    panel.ts         # сборка витрины значений для движка (native freq!)
  signals/
    evaluators/
      threshold.ts         # value >/< threshold (+hysteresis)
      streak.ts            # N периодов роста/падения подряд
      episodeDuration.ts   # состояние держится K периодов
      riseFromTrough.ts    # рост от минимума за окно на X% / п.п.
      changeOverPeriod.ts  # Δ за N месяцев/недель > порога
      composite.ts         # агрегация блоков → скор
    engine.ts        # evaluate → transitions → SignalEvent[]
    score.ts         # веса → суммарный скор → prob bucket
    types.ts         # SignalEvent, SignalState, EvalResult
  publish/
    publisher.ts     # интерфейс Adapter, fan-out, outbox/retry
    adapters/
      telegramChannel.ts
      telegramDm.ts
    render/
      templates.ts   # форматирование события
      i18n.ts        # i18next init, t(key, locale)
  bot/
    index.ts         # grammY init, middleware
    commands/        # start, status, signals, settings, lang, plan
    settings.ts      # per-user prefs wizard (conversations)
    payments.ts      # Stars invoices, pre_checkout, successful_payment
    admin.ts         # admin-only команды
  jobs/
    fetch.ts
    checkSignals.ts
    digest.ts
    scheduler.ts     # node-cron: per-frequency jobs
  cli/
    backfill.ts      # npm run backfill [--years N]
    recompute.ts     # пересчёт сигналов на истории
    sendTest.ts      # тестовая отправка в канал/DM
  index.ts
config/
  sources.yaml       # описание рядов (series_id, freq, units, source)
  signals.yaml       # каталог сигналов: evaluator, params, weight, hist stats
  channels.yaml      # locale → channel target (env-переопределяемо)
  thresholds.yaml    # дефолтные профили порогов для юзеров
  locales/
    en.yaml          # шаблоны сообщений + описания сигналов
    ru.yaml
scripts/
  backtest.ts        # офлайн: статистика сигналов на истории (episodes)
  fitModel.ts        # офлайн: logit-коэффициенты → config
  histStats.md       # методология и источники статических вероятностей
test/                # vitest
data/                # sqlite (gitignored)
```

---

## 3. Конфиг-схема (config/\*.yaml, zod-валидация)

### sources.yaml — ряд

```yaml
- key: yield_10y3m
  source: fred # fred | static | derived
  series_id: T10Y3M
  frequency: daily # daily | weekly | monthly | quarterly
  unit: pct_points
  label_key: series.yield_10y3m # i18n-ключ названия
  hist_start: "1982-01" # реальное покрытие ряда (для hist stats)
```

### signals.yaml — сигнал

```yaml
- key: yield_curve_inversion
  block: financial # financial | credit | housing | labor | composite | nowcast
  title_key: signal.yield_curve_inversion
  weight: 2
  inputs:
    - { key: yield_10y3m, transform: value }
  evaluator:
    type: episode_duration
    params: { condition: "value < 0", min_periods: 10, period: trading_day }
  severity_map: # escalation по длительности эпизода
    warning: { min_periods: 10 }
    critical: { min_periods: 60 }
  hist: # статические исторические статистики (см. §8)
    sample: "1960-2024"
    episodes: 12
    recessions_covered: 8
    precision: 0.75 # доля эпизодов → рецессия за 12м
    recall: 0.92 # доля рецессий, которым предшествовал сигнал
    median_lead_months: 11
    note_key: hist.yield_curve_inversion
```

### channels.yaml

```yaml
channels:
  - { id: en_main, locale: en, chat_id_env: TG_CHANNEL_EN, kind: channel }
  - { id: ru_main, locale: ru, chat_id_env: TG_CHANNEL_RU, kind: channel }
defaults:
  digest_time_utc: "13:00" # после выхода утренних US-данных
```

---

## 4. Схема БД (SQLite, миграции plain SQL)

```sql
-- сырые данные; vintage_date заполняется при ALFRED-fetch'ах,
-- для текущих наблюдений NULL = latest revision
observations(series_key, date, value, vintage_date NULL,
             PRIMARY KEY(series_key, date, COALESCE(vintage_date,'')));

-- состояние сигналов (state machine)
signal_state(signal_key PK, state,                -- ok|watch|warning|critical
             since, episode_start, last_value, last_eval_at);

-- события сигналов (журнал переходов = источник SignalEvent)
signal_events(id PK, signal_key, ts, from_state, to_state,
              value, payload_json);   -- payload: evaluator context

-- снапшоты композитного скора (для графика/истории)
composite_snapshots(id PK, ts, score, prob_bucket, prob_low, prob_high,
                    detail_json);

fetch_log(id PK, series_key, ts, status, rows, error);

users(tg_user_id PK, username, locale, plan,      -- free|plus
      created_at, last_seen_at, is_blocked);

user_prefs(user_id PK FK, enabled_signals_json,   -- null = все
           min_severity, delivery_mode,           -- instant|digest
           digest_time, quiet_hours_json);

channels(chat_id PK, locale, kind, title, added_at);

subscriptions(user_id PK FK, status,              -- active|expired|canceled
              started_at, expires_at, charge_id_last);

payments(charge_id PK, user_id FK, stars_amount,  -- валюта XTR
         period_days, paid_at, refund_at NULL);

deliveries(id PK, event_id FK, target_type,       -- channel|dm
           target_id, locale, status,             -- pending|sent|failed
           attempts, sent_at, error);             -- outbox + ретраи
```

---

## 5. Фазы реализации

### Phase 1 — Data layer (перенос fed_monitor) ✅ DONE

- [x] `config/` zod-схемы + загрузчик; `sources.yaml` с каталогом рядов §7.
- [x] `data/db.ts`: соединение, миграции (embedded `MIGRATIONS` in db.ts).
- [x] `data/fredClient.ts`: rate limit (100 req/min), ретраи с backoff,
      инкрементальный fetch (от последнего наблюдения + overlap 14 дней),
      `"."`-пропуски отфильтрованы.
- [x] `data/nber.ts`: `USREC` → `getRecessionPeriods()` / `isRecessionMonth()`.
- [x] `cli/backfill.ts`: `npm run backfill [years]`.
- [x] `vintage_dates` поддержан (`vintageDate` в fetchAndStore; отдельные
      строки per vintage в observations).
- Тесты: инкремент + дедуп покрыты engine.test.ts.

### Phase 2 — Metrics + Signal engine ✅ DONE

- [x] `metrics/transforms.ts`: ma4/ma13/ma6, diff, pct_change, monthly_mean,
      nyfed_prob (probit Φ(α+β·spread), коэф. из model.yaml) — на родной
      частоте ряда.
- [x] `metrics/panel.ts`: резолв inputs (включая overrides веток any_of/all_of),
      кэш per run; движок пропускает сигнал, если нет новых observation-дат.
- [x] Evaluator'ы (src/signals/evaluators.ts): `levels`, `episode_duration`,
      `streak`, `rise_from_trough`, `change_over_period`, `yoy`,
      `any_of`, `all_of` — чистые функции ряда, state вычисляется
      детерминированно.
- [x] State machine ok→watch→warning→critical с гистерезисом (exit_below,
      exit_periods, warn/critical пороги).
- [x] События только на переходах состояния (signal_events), эпизод =
      context.since — дедуп эпизодов (фикс бага hash() и «40 breaches»).
- [x] `signals/score.ts`: watch=0.5w, warning=1.0w, critical=1.5w → скор →
      бакет из model.yaml → composite_snapshots.
- Тесты: 13 evaluator-тестов + 2 engine-теста (дедуп, снятие сигнала).

### Phase 3 — Publisher + Telegram-каналы ✅ DONE

- [x] `publish/render/i18n.ts` (i18next + locales yaml) + `templates.ts`:
      событие, статус, дайджест — формат `⚠️ name / Status / Value / since /
desc / hist / composite / disclaimer`.
- [x] `publish/publisher.ts`: routeEvent → каналы (per-locale рендер) +
      DM-пользователи (instant, фильтры prefs/plan) → deliveries outbox;
      processDeliveries с ретраями и обработкой 403 (is_blocked).
- [x] `adapters/telegram.ts`: sendMessage через grammY Api, fallback на plain
      text при ошибке парсинга.
- [x] `cli/sendTest.ts`: тестовая отправка в каналы/чат.
- [x] `jobs/digest.ts`: дайджест событий за 24ч + активные сигналы + композит.

### Phase 4 — Telegram-бот (per-user) ✅ DONE

- [x] `bot/` на grammY: `/start` (дисклеймер), `/status`, `/signals`
      (inline-toggle, plus only), `/settings` (delivery, severity, lang),
      `/lang`, `/plan`.
- [x] Middleware: upsert user + prefs, локаль из `language_code`; is_blocked
      при 403 обрабатывается в processDeliveries.
- [x] DM-доставка: фильтры enabled_signals, min_severity, plan-floor
      (free ≥ warning), instant vs digest.
- [x] Callback-клавиатуры: настройки и сигналы без команд-визардов.

### Phase 5 — Вероятностный слой (частично)

- [x] `scripts/histStats.md` + `hist:`-блоки в signals.yaml (precision/recall,
      episodes, insufficient_history для рядов с <5 рецессий).
- [ ] `scripts/backtest.ts`: на ALFRED-винтажах (без look-ahead): эпизоды
      сигналов vs NBER-старт, калибровка score→prob (доля рецессий за 12м по
      бакетам скора).
- [ ] `scripts/fitModel.ts`: pooled logit на 3–6 предикторах (по одному из
      блока) → коэффициенты в `config/model.yaml`; модель считает
      P(вход в рецессию | сейчас не в рецессии).
- [x] Отображение: бакеты (`<15%` / `15–35%` / `35–60%` / `>60%`) — без
      псевдоточных процентов (model.yaml).
- [x] Nowcast-блок отдельно: `sahm_rule`, `chauvet_piger` — weight=0,
      не входят в 12m-скор, рендерятся отдельным блоком.

### Phase 6 — Монетизация (Telegram Stars) ✅ DONE (код; e2e не проверено)

- [x] `bot/payments.ts`: `replyWithInvoice(currency=XTR)`,
      `pre_checkout_query`, `successful_payment` → `payments`,
      `subscriptions` (30 дней, продление при повторной оплате).
- [x] Gating: free → digest + floor=warning; plus → instant + watch +
      кастомный выбор сигналов (/signals).
- [x] `jobs/subscriptions.ts`: экспирация → downgrade → уведомление (cron hourly).
- [x] Дисклеймер в `/start`, футере сообщений, README.
- [ ] E2E-проверка в тестовом окружении Stars + реальная оплата.
- [ ] Рекуррентные инвойсы по окончании периода (сейчас ручное продление).

### Phase 7 — Ops (частично)

- [x] `jobs/scheduler.ts` (node-cron): daily 2×, weekly Wed–Fri, monthly+quarterly
      по дням 2/7/12/17/22/27, digest 13:00 UTC, ретраи доставки 15 мин,
      экспирация подписок hourly.
- [x] Outbox-ретраи доставки (`deliveries` status/attempts).
- [ ] Release-awareness: повторный fetch через N часов при отсутствии новых
      данных (сейчас: фиксированные дни месяца — компромисс v1).
- [ ] Деплой: VPS + pm2/docker-compose, бэкап sqlite, healthcheck.
- [ ] GitHub Actions cron для fetch+post (только каналы; боту нужен
      long-running процесс).

### Later (не сейчас)

- X-адаптер (pay-per-use API, текст без ссылок ~$0.015/пост).
- Email/SMS-адаптеры. Web-дашборд (можно переиспользовать идею
  static JSON + Plotly из fed_monitor). Доп. локали. Платные invite-ссылки
  для приватного канала.

---

## 6. Фиксы багов/ограничений fed_monitor (явный список)

| Проблема upstream                                                                  | Наше решение                                             |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `make_alert_id` = `hash(rule)` рандомизирован per process → сломанная дедупликация | Детерминированный `signal_key` + `sha1(params)`          |
| Нет дедупа эпизодов: breach 40 дней подряд = 40 «событий»                          | `episode_start` в state; событие только на переходе      |
| Нет гистерезиса → флап около порога                                                | Вход/выход по разным порогам + min-duration              |
| `asfreq("D").ffill()` для месячных рядов — скрывает лаг публикации                 | Родная частотность; триггер по факту новой публикации    |
| Upsert затирает ревизии                                                            | `vintage_date` в observations; ALFRED-режим для бэктеста |
| `eval(rule)` — только пороги                                                       | Типизированные evaluator'ы (streak, duration, trough…)   |
| Один `chat_id`, односторонние уведомления                                          | Publisher + каналы per locale + per-user DM              |
| `datetime.utcnow()` deprecated                                                     | `new Date().toISOString()`                               |

---

## 7. Каталог сигналов v1

| key                    | series (FRED)     | freq      | evaluator / правило                                     | block     | weight |
| ---------------------- | ----------------- | --------- | ------------------------------------------------------- | --------- | ------ |
| yield_curve_inversion  | T10Y3M            | daily     | `< 0`, эпизод ≥10 торг.дней                             | financial | 2      |
| yield_curve_steepening | T10Y3M            | daily     | выход из инверсии рывком после глубокой (`min < -50bp`) | financial | 1      |
| curve_10y2y            | T10Y2Y            | daily     | `< 0`, эпизод                                           | financial | 1      |
| nyfed_prob             | T10Y3M (мес. avg) | monthly   | probit NY Fed (статич. коэф.) > 30% / 40%               | composite | 2      |
| hy_spread              | BAMLH0A0HYM2      | daily     | `> 5%` или `Δ3m > +1п.п.`                               | credit    | 2      |
| ig_bbb_spread          | BAMLC0A4CBBB      | daily     | `> p75 исторического` или `Δ3m`                         | credit    | 1      |
| nfci                   | NFCI              | weekly    | `> 0` watch / `> 0.5` warn                              | financial | 2      |
| stlfsi                 | STLFSI4           | weekly    | `> 0.5` / `> 1.0`                                       | financial | 1      |
| lei_oecd               | USSLIND           | monthly   | `Δ6m < 0` и 6+ мес снижения                             | composite | 2      |
| permits                | PERMIT            | monthly   | `YoY < 0` устойчиво (3м подряд)                         | housing   | 1      |
| housing_starts         | HOUST             | monthly   | `YoY < -10%`                                            | housing   | 1      |
| new_orders_dg          | DGORDER           | monthly   | `YoY < 0` 3м подряд (прокси ISM)                        | housing   | 1      |
| claims_trend           | ICSA              | weekly    | `MA4 ↑ 8+ недель` или `+15% от min 12м`                 | labor     | 1      |
| continued_claims       | CCSA              | weekly    | `+10% от min 12м`                                       | labor     | 1      |
| temp_help              | TEMPHELPS         | monthly   | `YoY < 0` 3м подряд                                     | labor     | 1      |
| jolts_flows            | JTSJOL, JTSQUR    | monthly   | вакансии ↓3м и quits ↓ (⚠ n=2 рецессии)                 | labor     | 1      |
| sloos_tightening       | DRTSCILM          | quarterly | `> 20%` банков ужесточают                               | credit    | 2      |
| indpro                 | INDPRO            | monthly   | `YoY < 0`                                               | composite | 1      |
| sahm_nowcast           | SAHMREALTIME      | monthly   | `≥ 0.5` — **onset, не прогноз**                         | nowcast   | —      |
| chauvet_nowcast        | RECPROUSM156N     | monthly   | `> 20%` — вероятность «уже в рецессии»                  | nowcast   | —      |

Композитный скор = Σ весов активных (watch+warning=вес, critical=вес+0.5).
Бакеты → вероятность: калибровка в Phase 5; стартовый маппинг —
`0–4 низкий / 5–8 повышенный / 9–12 высокий / 13+ системный` (из ресёрча).

Прочие ряды в `sources.yaml` без алертов (контекст для дайджеста):
`UNRATE`, `JTSHIR`, `JTSLDL`, `PAYEMS`, `DGS10`, `DGS2`, `DGS3MO`, `VIXCLS`.

---

## 8. Методология статических вероятностей (`hist:`)

Для каждого сигнала — статическая статистика из литературы + собственного
бэктеста:

- **Эпизод** = вход в состояние после ≥N месяцев вне его (не каждый месяц!).
- **precision** = эпизоды, за которыми рецессия началась ≤12 мес / все эпизоды.
- **recall** = рецессии, которым предшествовал сигнал / все рецессии выборки.
- **median_lead** = медиана лага от старта эпизода до старта рецессии.
- База для сравнения: безусловная P(рецессия за 12м) ≈ 15–20%.
- Выборка <5 рецессий → `insufficient_history` (JOLTS n=2, HY OAS n=3,
  SLOOS n≈3–4, T10Y3M-серия n=5).

Известные опорные точки: кривая 10Y–3M — hit ~92%, false alarms ~25%
(ROC-анализ); NY Fed prob >40% — ни одного промаха кроме 10/1966; Sahm —
срабатывает в среднем на ~3.4 мес ПОЗЖЕ старта (nowcast); LEI — первый
ложный сигнал за 63 года в 2022–24 (урок: «this time is different» бывает).

---

## 9. Мультиязычность и маршрутизация

- Локаль привязана к каналу (`channels.yaml`) и к юзеру (`users.locale`).
- Все тексты — i18n-ключи; числа/даты через `Intl`.
- Добавление локали = `locales/<lang>.yaml` + строка в channels.yaml.
- Одно событие → N рендеров → N доставок (каналы) → M DM по фильтрам юзеров.

## 10. Монетизация

- Валюта: Telegram Stars (`XTR`), 30-дневные рекуррентные подписки.
- Free: публичные каналы, DM-дайджест, дефолтные пороги, `/status`.
- Plus: instant-алерты, кастомные пороги/подмножества сигналов, расширенный
  композитный отчёт, приоритетные новые функции.
- Дисклеймер: informational/educational only, not investment advice — в
  `/start`, описании бота и подвале дайджеста.

## 11. Тестирование

- Vitest: evaluator'ы (синтетика + исторические эпизоды 2007–09, 2020),
  state machine, рендер, фильтрация prefs, миграции.
- Фикстуры: срезы FRED-ответов (JSON) в `test/fixtures/`.
- Бэктест-скрипты — проверяемость на известных рецессиях.

## 12. Открытые вопросы

- Точные пороги NFCI/STLFSI для watch/warning — уточнить на бэктесте.
- Прокси для ISM new orders: региональные ФРБ-индексы (Empire, Philly) —
  выбрать при Phase 1.
- Длина истории для backfill по умолчанию: 30 лет (компромисс объём/качество).
- Формат paid invite-ссылок для приватного канала — когда включать.
