# PLAN2 — Growth & Trust Roadmap

Вторая волна развития после аудита (PLAN.md закрыт). Цель: (а) сделать
backtest методологически честным (ALFRED), (б) построить бесплатные каналы
дистрибуции, (в) углубить Plus-функционал, (г) подготовить веб-присутствие.

Порядок в документе ≈ рекомендуемый порядок реализации: сначала фундамент
(ALFRED, PNG-рендер, web-выгрузка), потом фичи, опирающиеся на них.
Оценки трудозатрат — в условных «сессиях» (полдня работы).

> Верификация: план сверен с кодом на {дата}. Важные факты, влияющие на
> реализацию, помечены «[verified]».

---

## 0. Архитектурные предпосылки (проверено по коду)

- `publisher.ts`: события/дайджесты роутятся через `deliveries`-outbox —
  **`payload_text` только текстовый** [verified]. Фото и внешние витрины
  не проходят через outbox: отправляются напрямую в джобе.
- `deliveries.digest_key` (`d:YYYY-MM-DD` / `w:YYYY-Www`) + `payload_text`
  — готовый источник текста для RSS/feed-итемов [verified].
- `signal_state.context_json` хранит контекст сигнала + `_rule_hash`;
  у `signal_events` аналогичное поле называется **`payload_json`**
  [verified].
- `composite_snapshots.detail_json` уже содержит `_model_prob`
  [verified, engine.ts:124] — дельта «модель была X% неделю назад»
  берётся оттуда, отдельное поле не нужно.
- **`observations` УЖЕ имеет колонку `vintage_date`** (`''` = latest
  revision), `upsertObservations(..., vintageDate)`,
  `getObservations(..., {vintageDate})` и `FredClient.fetchSeries` с
  параметром `vintageDates` — часть ALFRED-инфраструктуры заложена при
  инициализации [verified, db.ts:21, observations.ts, fredClient.ts:65].
- `signal.input` — обязательный одиночный `InputRef` [schema.ts:152];
  multi-input сигналы решаем через `evaluator.params.keys` + `input`
  как «драйвер сетки» (см. п.7).
- Дедуп повторного прогона: `last_obs_date` + `_rule_hash`; свежесть
  по raw-рядам через `Panel.latestObsDate` [verified].
- `SeriesCache`/`replaySignal`/`detectEpisodes`/`getRecessionPeriods` —
  готовый движок для `/episodes` и self-audit [verified].
- **Две среды исполнения**: GHA (канальные дайджесты, кэшированная БД)
  и сервер/pm2 (бот, DM). Это разные SQLite! Любая витрина/пост, который
  должен выйти один раз, требует env-гейта (см. `SYNDICATION_ENABLED`).
- **⚠️ Тот же риск уже сегодня для канальных дайджестов** [verified]:
  серверный `scheduler.ts` запускает `jobDigestAuto` (ежедневно,
  `digest_time_utc`) и `jobDigest("weekly")` (`weekly_digest_day_utc`),
  а GHA — `jobDigestAuto` в 13:20. Если `TG_CHANNEL_*` выставлены в
  серверном `.env`, каналы получают каждый дайджест **дважды** — дедуп
  per-DB не спасает. Операционная проверка (см. чеклист): на сервере
  `TG_CHANNEL_*` быть не должно; долгосрочно — env-гейт
  `CHANNEL_POSTS_ENABLED` в `jobDigest` для channel-targets.
- `composite_snapshots.ts` = `datetime('now')` → формат
  `'YYYY-MM-DD HH:MM:SS'` (пробел, UTC). Сравнение `ts <= ?` со строкой
  ISO `'…T…Z'` ломается лексикографически — cutoff для «неделю назад»
  передавать как `toISOString().slice(0,19).replace('T',' ')` или через
  `datetime(?)` в SQL [verified, db.ts:56].

---

## 1. ALFRED-винтажи (честный no-look-ahead бэктест)

### Проблема

`knownAt` учитывает publication lag, но значения — latest-vintage:
FRED переписывает историю (benchmark revisions, seasonal factors).
hist:-статистики слегка «подсматривают» исправленные данные.

### Факты (проверено по FRED API docs + коду)

- `fred/series/observations` принимает `vintage_dates=YYYY-MM-DD,...`;
  произвольные даты разрешены («Entering a vintage date is also useful
  to compare...») → endpoint `vintagedates` нам **не нужен**, генерим
  даты сами.
- В JSON-ответе каждая строка несёт `realtime_start` = дата винтажа, к
  которому она относится → группировка по `realtime_start` при батче.
- Лимиты `vintage_dates` на запрос до ~2000, но реальный тормоз —
  размер ответа (vintages × obs): батчуем по 50–100 (см. реализацию).
- **Ключевое упрощение**: рыночные серии (доходности, VIX, OAS-спреды)
  практически не ревизуются — винтажи нужны только для реальной
  активности: `unrate`, `payems`, `temp_help`, `icsa`, `ccsa`,
  `permits`, `housing_starts`, `dg_orders`, `indpro`, `cfnaid`,
  JOLTS-четвёрка (`job_openings`/`quits_rate`/`hires_rate`/`layoffs_rate`),
  `sloos_ci`, `recprob_chauvet`. НЕ нужны: рыночные daily
  (`yield_*`, `dgs*`, `vix`, `hy_oas`, `bbb_oas`, `nfci`, `anfci`,
  `stlfsi` — индексы не ревизуются), `nyfed_prob`-входы (это T10Y3M),
  `sahm` (SAHMREALTIME сам по себе real-time ряд), `usrec`, `lei_oecd`
  (мёртвый). Это сокращает объём на порядок vs «всё подряд».

### Дизайн данных (используем существующую схему)

Новая таблица **не нужна** — храним винтажи в `observations` с
`vintage_date != ''` (PK `(series_key, date, vintage_date)` уже верен).

- `sources.yaml`: новое поле `vintage: monthly | quarterly | none`
  (default `none`) в `seriesDefSchema` — явный opt-in per series; плюс
  `vintage_lookback_years` (default 40) — ограничение окна obs на винтаж.
  Назначаем: quarterly — почти все monthly-ряды реальной активности
  (~13 серий из списка выше) и weekly `icsa`/`ccsa`; monthly — только
  для серий, где ревизии доказано важны (кандидат: `unrate`);
  none — все рыночные/daily + `sahm`, `usrec`, `lei_oecd`.
- Объём (уточнённо, квартальная сетка от hist_start, lookback 40y):
  ~13 monthly × ~240 винтажей × ~300–480 obs + 2 weekly × 240 ×
  ~1300–2700 obs ≈ **1.5–2M строк ≈ 60–100 МБ SQLite**. Больше ранней
  оценки — если размер критичен, у weekly-рядов режем
  `vintage_lookback_years: 20` (−~40%).
- `observationsAsOf(seriesKey, asOfDate)` — новая repo-функция:
  ```sql
  SELECT date, value FROM observations
  WHERE series_key = ? AND vintage_date = (
    SELECT MAX(vintage_date) FROM observations
    WHERE series_key = ? AND vintage_date != '' AND vintage_date <= ?
  ) ORDER BY date
  ```
  **Обязательно `vintage_date != ''` во внутреннем запросе** — иначе
  при отсутствии винтажей ≤ asOfDate `MAX` вернёт `''` и функция тихо
  отдаст latest-revision данные как «as-of» (скрытый look-ahead).
  Пустой результат = «данные на эту дату неизвестны» — корректно.

### Реализация

1. `schema.ts`: поля `vintage`, `vintage_lookback_years` в
   `seriesDefSchema`.
2. `fredClient.ts`: `fetchSeries` — возвращать `realtime_start` в строках
   (расширить `FredObservation`/`ObsRow`-маппинг); новый метод
   `fetchVintageBatch(seriesKey, vintageDates[])` → группировка по
   `realtime_start`, upsert каждой группы с `vintage_date = realtime_start`.
   Пейсинг — существующий `RateLimiter`.
3. `src/cli/vintageBackfill.ts` (`npm run vintages`):
   - для каждой серии с `vintage != none`: генерим сетку дат (1-е числа
     месяцев/кварталов от `hist_start`), вычитаем уже скачанные винтажи
     (`SELECT DISTINCT vintage_date`), батчи по **50–100 винтажей**
     (400 × ~480 obs ≈ 200k строк в одном JSON — перебор) →
     `fetchVintageBatch` с `observation_start = vintage − lookback`.
   - Первый бэкфилл: ~16 серий × ~240 винтажей / 75 ≈ ~50 запросов на
     серию ≈ ~800 запросов ≈ ~10 мин при 100 rpm.
   - Инкрементально: раз в месяц дотягивает новые сеточные даты —
     отдельный CLI-запуск вручную/по cron в среде бэктеста (винтажи
     нужны только для анализа; в боевой scheduler не добавляем —
     лишний объём в GHA-кэше/бэкапах без пользы).
4. `backtest/replay.ts` — режим `asof`:
   - `VintageSeriesCache`: `get(ref, evalDate)` → находит последний
     винтаж `<= evalDate` (`SELECT MAX(vintage_date) ... vintage_date
!= ''`), берёт `observationsAsOf`, применяет `applyTransform`,
     кэш per `key|transform|vintage` (разные сигналы на одном evalDate
     переиспользуют один винтаж).
   - `replaySignalAsof(signal, cache)`: **та же сетка evalDate, что у
     `replaySignal`** — даты наблюдений input-ряда (native frequency),
     а не даты винтажей: weekly-сигнал остаётся weekly-сеткой, просто
     каждый вход резолвится «каким его видели на evalDate». `knownAt`
     заменяется as-of-срезом, **лаг = 0** (винтаж сам воплощает
     задержку публикации). prev-state протягивается как в `replaySignal`.
     Гранулярность «знания» ограничена сеткой винтажей (квартал =
     ±1.5 мес старости данных) — документированный компромисс.
   - `stateAt`/`compositeScoreGrid` — as-of-варианты для рекалибровки
     (тот же evalDate-параметр в `cache.get`).
5. `scripts/backtest.ts`: флаг `--vintage` → второй прогон + таблица
   latest-vs-vintage precision рядом. Критерий вывода: если дельта <2п.п.
   по precision — допущение latest-vintage почти невинно, документируем.
6. Обновить `hist:` в `signals.yaml` и `histStats.md` по винтажному
   прогону; пометка `as-of vintage` в sample-строке.

### Тесты

- `observationsAsOf`: 2 винтажа, ревизия значения → берётся нужная;
  **нет винтажей ≤ asOfDate → пустой результат** (не latest-revision!).
- Группировка `fetchVintageBatch` по `realtime_start` (мок fetch).
- `replaySignalAsof` без `asof`-пути — регрессия существующих 9 тестов.
- Look-ahead: obs, добавленная в более позднем винтаже, недоступна раньше.

### Риски/компромиссы

- Квартальная сетка винтажей = дата «знания» ±1.5 мес — грубее чем
  publication-lag-модель. Компромисс осознанный, документируем; при
  желании — monthly для 2–3 ключевых серий.
- `data/recession.db` вырастает на ~60–100 МБ → размер бэкапов и
  GHA-кэша (лимит кэша ~10GB на репо — ок, но отметить; винтажи можно
  исключить из кэша/бэкапа — они восстановимы перефетчем).

**Effort: 2 сессии.** Зависимости: нет. **Приоритет №1.**

---

## 2. Дайджест-веб-страница (GitHub Pages)

### Цель

Публичный URL с текущим состоянием — точка входа извне, SEO, основа для
Mini App (п.14) и RSS-хост (п.3).

### Дизайн

- Статика → деплой через `actions/upload-pages-artifact` +
  `deploy-pages` (без коммитов в репо, история чистая; альтернатива —
  `docs/` + git push, проще, но мусорит историю — выбираем artifact).
- Генератор `src/web/renderSite.ts` (`npm run site`): читает
  `data/recession.db`, строит в `site/`:
  - `index.html` — вердикт, модель, активные, nowcast, 90-дневный график
    скора из `composite_snapshots` (inline-SVG, генерим path'ами сами);
  - `ru/index.html` — RU-локаль; тогл языка — ссылки en/ru;
  - `data.json` — машиночитаемый снапшот (для Mini App, п.14);
  - `feed.xml` / `feed-ru.xml` — RSS (п.3.2);
  - `card.png` — og:image (когда п.4 включён; до тех пор — без картинки
    или простой статический og).
- Мета: `<title>US Recession Watch — 12m recession risk: {BUCKET}</title>`,
  og-tags, canonical, JSON-LD `Dataset`.
- `.nojekyll` в артефакте.

### GHA (`monitor.yml`)

```yaml
permissions: { contents: read, pages: write, id-token: write }
concurrency: { group: pages, cancel-in-progress: true }
steps:
  - run: npm run site # после digest
  - uses: actions/upload-pages-artifact@v3
    with: { path: site }
  - uses: actions/deploy-pages@v4
# deploy-pages требует `environment: { name: github-pages }` на job —
# выносим в отдельный job deploy (needs: run), чтобы monitor-job не
# тащил pages-окружение и не блокировался на него при отключенном Pages.
```

Репо: Settings → Pages → Source: «GitHub Actions». URL:
`https://lexa070301.github.io/us_recession_chance/`.

### Файлы

- `src/web/renderSite.ts`, `src/web/page.ts` (шаблон+inline CSS),
  `src/web/dataJson.ts` (схема zod-валидируется).
- `package.json`: `"site": "tsx src/web/renderSite.ts"`.

### Тесты

- `renderSite` на фикстурной БД → вердикт в HTML, размер <200KB.
- `data.json` проходит zod-схему.

**Effort: 1.5 сессии.** Зависимости: выигрывает от п.4 (og-картинка).

---

## 3. Внешние витрины: Buffer (X+Threads+LinkedIn), Telegraph, RSS, Substack, Bluesky, Mastodon, Discord, Reddit

### Стратегия: Buffer как мультиплексор сложных сетей [verified]

Вместо трёх отдельных адаптеров для самых бюрократических сетей —
**один `buffer` venue**, покрывающий X + Threads + LinkedIn через
Buffer Free:

- **Buffer Free**: 3 канала, 10 запланированных постов/канал, **API
  включён**: 1 API key, 250 req/24h, 3000 req/30d — наш ритм (2–3 поста
  в неделю) ничтожен относительно лимита.
- API — **новый GraphQL** (`developers.buffer.com`, legacy REST
  выключается 1 фев 2027 — пишем только на новом). Постинг:
  mutation `createPost` с `channelId` (или массивом каналов — уточнить
  в схеме при реализации); режим публикации «сейчас» vs очередь —
  проверить поле (типа `shareNow`/publish-immediately).
- Выбранные каналы и почему:
  - **X** — ядро макро-аудитории, self-API платный/сложный → Buffer.
  - **Threads** — text-first, растущий; self = Meta app review → Buffer.
    Требует привязанный Instagram-аккаунт (сам по себе IG слот не
    занимает — канал Threads отдельный).
  - **LinkedIn** — сильная макро-аудитория; self = верификация app +
    scope `w_member_social`, самый бюрократичный → Buffer.
- **Осознанно отброшено**:
  - _Facebook Page_ — органический охват страниц ~1–5%, дублирует
    Threads, ценности почти ноль.
  - _Instagram_ — обязательное медиа на пост и слабый fit для текстового
    макро; запасной своп (LinkedIn→IG) возможен позже, когда PNG-карточки
    будут готовы — на free лимит 8 уникальных каналов/сеть за lifetime,
    так что каналы не крутим без нужды.
  - _Pinterest/TikTok/YouTube_ — вне ниши.
- **⚠️ Запасной вариант**: у X есть собственный free API tier
  (~500 write-постов/мес) — если Buffer перестанет устраивать, X можно
  self-кодить бесплатно, а слот Buffer освободить под IG.

На self-коде остаются дешёвые витрины: Telegraph, RSS→Substack, Bluesky,
Mastodon, Discord, **Reddit** (собственный сабреддит — см. §3.8).

### Критически важно: две среды исполнения [verified]

`jobDigest` вызывается и в GHA, и на сервере — у них **разные SQLite**.
Синдикация без гейта будет двоить посты (дедуп-таблица у каждой среды
своя). Решение: джоб синдикации запускается **только под env-флагом**
`SYNDICATION_ENABLED=true`, который выставлен в `monitor.yml` и
отсутствует на сервере.

### Общая абстракция

`src/publish/venues.ts` — реестр витрин:

```ts
interface Venue {
  key: string; // buffer | telegraph | bsky | mastodon | discord | reddit
  publish(post: ExternalPost): Promise<{ url?: string } | "skip">;
}
interface ExternalPost {
  kind: "daily" | "weekly" | "self_audit";
  locale: "en" | "ru";
  title: string;
  text: string;
  telegraphNodes?: unknown[]; // для telegraph
  imagePng?: Buffer; // карточка (п.4)
  variants?: { short: string }; // укороченный текст для X (≤280) и пр.
}
```

`jobSyndicate(kind)` вызывается из `jobDigest`/`jobSelfAudit`
**только при `SYNDICATION_ENABLED`**: собирает посты по локалям,
фан-аут по включённым витринам (нет env → `skip`), per-venue try/catch

- лог (fail-open: сбой витрины не роняет дайджест). Дедуп:
  `syndications (venue, locale, digest_key, url, created_at,
PRIMARY KEY(venue, locale, digest_key))` — **`locale` обязательна в
  PK**: Telegraph создаёт по странице на язык (2 токена), батч без неё
  даёт коллизию на `w:`-ключе. Для моноязычных витрин (Discord-канал,
  Reddit) locale-значение — `'en'`-пост или `'*'`. Self-audit получает
  свой ключ `a:YYYY-Www` — иначе он столкнётся с weekly `w:`-ключом
  той же недели.
- Env-переменные витрин читаем напрямую через `process.env` (по
  аналогии со `STARS_PER_30D`/`BOT_USERNAME`) — не расширяем
  `env`-объект в `load.ts`, чтобы отсутствие секретов не ломало конфиг.

### Порядок внутри дайджеста (важно)

Telegraph-ссылку хотим вложить в текст канального поста («полная версия
→ telegra.ph/...») → `jobSyndicate` для telegraph выполняется **до**
enqueue канальных дайджестов: в `jobDigest("weekly")` — build →
`syndicateTelegraph` → полученный URL прокидываем в `renderDigest` как
`readMoreUrl` → enqueue. Остальные витрины — после отправки (не влияют
на текст). Для daily — витрины без readMore-инжектации, после отправки.

### 3.1 Telegraph

- `npm run telegraph-init` → `createAccount` ×2 (short_name
  `US Recession Watch` / `Сигналы рецессии`), выводит `access_token` →
  `.env`: `TELEGRAPH_TOKEN_EN`, `TELEGRAPH_TOKEN_RU`.
- `createPage`: title `Weekly recession signals — {ISO-week}`,
  content — `telegraphNodes` из `src/web/telegraphNodes.ts` (наш
  рендер → ограниченный Node-JSON Telegraph: h3/h4/p/ul/strong;
  лимит 64KB — дайджест влезает с запасом).
- Только weekly + self_audit (daily — спам-ритм для SEO-страниц).

### 3.2 RSS/Atom

- `docs`-эквивалент `feed.xml` генерится `npm run site` (п.2): items =
  тексты дайджестов из `deliveries` (`digest_key IS NOT NULL AND
target_type='channel'`, последние 30), guid = digest*key.
  `payload_text` — legacy-Markdown (`\_italic*`) → для `content:encoded`  либо мини-конвертер md→html, либо`<pre>`/escaped текст
  (RSS-читалки покажут текст как есть — приемлемо для v1).
- `feed.xml` (en) + `feed-ru.xml`; `<link rel="alternate">` на index.

### 3.3 Substack

- Публичного write-API нет → работает через RSS: бесплатный Substack
  создаём вручную, «Import RSS» на наш `feed.xml` → посты появляются
  автоматически. **Кода нет** — только операционный шаг + README-заметка.
- Опция на будущее: Buttondown API (free ≤100 subs) — не реализуем.

### 3.4 Bluesky

- Зависимость `@atproto/api`: `BskyAgent.login(identifier, appPassword)`,
  `post({text, facets, embed})`. Facets для кликабельного линка.
- Текст ≤300 симв.: вердикт + число активных + ссылка на Pages/Telegraph.
- weekly + self_audit; `imagePng` → `uploadBlob` + `embed.images`.
- Env: `BSKY_HANDLE`, `BSKY_APP_PASSWORD`.

### 3.5 Mastodon

- Без зависимостей: `POST {instance}/api/v1/statuses` (Bearer) +
  `POST /api/v2/media` для картинки. ~500 симв. — почти полный текст.
- Env: `MASTODON_INSTANCE`, `MASTODON_TOKEN`.

### 3.6 Buffer (X + Threads + LinkedIn) — единый venue

- `src/publish/venues/buffer.ts`: GraphQL `POST https://api.buffer.com`
  (`Authorization: Bearer {BUFFER_API_KEY}`), mutation `createPost` per
  channel — 3 вызова/пост (или один с массивом каналов, если схема
  позволяет — уточнить). Публикуем **сразу**, не в очередь.
- Env: `BUFFER_API_KEY`, `BUFFER_CHANNEL_X`, `BUFFER_CHANNEL_THREADS`,
  `BUFFER_CHANNEL_LINKEDIN` — список ID каналов, venue активна при
  `BUFFER_API_KEY` + хотя бы один channel id.
- Текст: вердикт + активные + ссылка на Pages/Telegraph; `imagePng` →
  media upload через Buffer API (проверить мутацию upload при
  реализации — если сложно, v1 без картинки, ссылка на Pages покажет
  og:image при раскрытии превью).
- Формат per сеть: X ≤280 симв. (обрезка + ссылка), Threads ≤500,
  LinkedIn ~полный текст. `ExternalPost` получает `variants?:
{ short: string }` — buffer венue сам выбирает вариант по каналу.
- Только weekly + self_audit (daily = спам для соцсетей).
- Ограничения free-тарифа учитываем: посты не чаще 10 в очереди
  (у нас 2–3/нед — ок), лимит 250 req/day не касается.

### 3.7 Discord

- `POST {webhook_url}` `{content, embeds}`; PNG — multipart `files[0]`.
- Сервер «US Recession Watch» создаём вручную, webhook в `#digest`.
- Постит и daily (Discord-привычная частота).
- Env: `DISCORD_WEBHOOK_URL`.

### 3.8 Reddit — собственный сабреддит

- Создаём `r/USRecessionWatch` вручную (операционный шаг); постим
  **только в него** — автопост в чужие сабы = бан. В своём сабе правила
  наши, формат — weekly-дашборд + self-audit (новость-формат ложится на
  Reddit лучше, чем в соцсети).
- Auth: script-app на `reddit.com/prefs/apps` → OAuth password-grant:
  `POST https://www.reddit.com/api/v1/access_token` (HTTP Basic
  client_id:secret, body `grant_type=password&username=…&password=…`,
  `User-Agent` обязателен) → access_token → вызовы идут на
  **`https://oauth.reddit.com`** (не `www.reddit.com` — oauth-домен
  обязателен): `POST oauth.reddit.com/api/submit`
  `{sr, title, kind:"self"|"link", text}`. Link-post на telegra.ph-статью
  — Reddit любит link-posts и они индексируются лучше.
- Rate: безопасно 1 пост/нед на сабе; Reddit лимиты для новых
  аккаунтов/сабов жёсткие → постим только weekly + self_audit.
- `imagePng` → kind:"image" пост как опция (self-text безопаснее).
- Env: `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`,
  `REDDIT_PASSWORD`, `REDDIT_SUBREDDIT=USRecessionWatch`.

### `.env.example` — блок документации

```dotenv
# --- Syndication (all optional; venue is skipped when unset) ---
# Master switch — set ONLY in the env that must publish (GHA), never on
# the bot server: each env has its own SQLite, dedup would not work.
SYNDICATION_ENABLED=false
# Buffer: buffer.com → Settings → API → new API key; channel IDs from
# GraphQL `channels` query. Free plan: 3 channels (we use X+Threads+LinkedIn)
BUFFER_API_KEY=
BUFFER_CHANNEL_X=
BUFFER_CHANNEL_THREADS=
BUFFER_CHANNEL_LINKEDIN=
# Telegraph: `npm run telegraph-init` once → prints access_token
TELEGRAPH_TOKEN_EN=
TELEGRAPH_TOKEN_RU=
# Bluesky: bsky.app → Settings → App Passwords
BSKY_HANDLE=yourhandle.bsky.social
BSKY_APP_PASSWORD=
# Mastodon: Preferences → Development → New Application (scopes read+write)
MASTODON_INSTANCE=mastodon.social
MASTODON_TOKEN=
# Discord: channel → Edit → Integrations → Webhooks → Copy URL
DISCORD_WEBHOOK_URL=
# Reddit: reddit.com/prefs/apps → "script" app; posts go to OUR OWN
# subreddit only — auto-posting to other subs = ban
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USERNAME=
REDDIT_PASSWORD=
REDDIT_SUBREDDIT=USRecessionWatch
```

### Тесты

- `jobSyndicate` с мок-витринами: fan-out, дедуп, per-venue fault
  isolation, `skip` без env, **не запускается без `SYNDICATION_ENABLED`**.
- `telegraphNodes` конвертер → валидный Node[].

**Effort: 2 сессии** (абстракция + 6 self-витрин + 1 Buffer-venue
вместо трёх). Зависимости: п.2 (ссылки), п.4 (картинки).

---

## 4. PNG-карточка дайджеста (рендер, но НЕ включать)

### Цель

Современная инфографика. Фича-флаг `CARD_ENABLED=false` — реальный
рендер только через `npm run card` в файл для ручного теста.

### Стек

- **`satori`** (Vercel): HTML-like дерево → SVG. Шрифты ArrayBuffer'ом:
  Inter Regular+Bold в `assets/fonts/` (OFL, кириллица есть [verified —
  Inter поддерживает Cyrillic]; fallback Manrope, тоже OFL).
- **Без JSX**: `tsconfig.json` не задаёт `jsx`, `rootDir: src`, а
  `scripts/` вообще вне компиляции → `layout.ts` строит plain-object
  дерево `{ type: "div", props: { style, children: [...] } }` — satori
  принимает его напрямую, tsconfig не трогаем.
- **`@resvg/resvg-js`**: SVG → PNG. WASM, без нативных зависимостей —
  работает в GHA. node-canvas отклонён (нативная сборка ломает `npm ci`).
- Размер 1200×630 (og-стандарт).
- **⚠️ Уточнение по satori** [verified по docs]: satori рендерит
  ограниченное подмножество HTML/CSS, произвольный `<svg>`-элемент
  поддерживается ненадёжно. Спарклайн поэтому рисуем одним из:
  (a) **бар-чарт из div'ов** (N колонок скора за 90д — надёжно, выглядит
  современно); (b) генерим `<path>` для линии и **инжектим строкой в
  выходной SVG satori** перед resvg (мы контролируем промежуточный SVG —
  гарантированно сработает, линия вместо баров). Выбираем (a) для v1,
  (b) — если хочется линию.

### Дизайн (как в предыдущей версии плана)

Фон `#0d1524`, вердикт 96px в цвете бакета (low `#4ade80` / elevated
`#f59e0b` / high `#f97316` / severe `#ef4444`), текст `#e5e7eb`,
спаркбар из `composite_snapshots` за 90д (последний столбец ярче),
топ-3 активных сигнала компактно, футер `Nowcast: calm · t.me/{bot}`.
Две локали (ru/en) — тексты из locales `card.*`.

### Реализация

- `src/card/data.ts` — сбор `CardData` из БД (композит + `_model_prob`,
  снапшоты 90д, активные топ-3 по severity, nowcast, дата, локаль).
- `src/card/layout.ts` — чистый `CardData → satori-tree`.
- `src/card/render.ts` — `renderCard(data): Promise<Buffer>`.
- `src/cli/card.ts` — `npm run card -- [--ru] [--out card.png]` — тестовый
  стенд.
- `channels.yaml`: `card.enabled` + env-override `CARD_ENABLED` (как
  прочие оверайды).
- **Доставка фото** [verified: outbox — только текст]:
  - новый адаптер `sendTelegramPhoto(chatId, buf, caption?)` в
    `publish/adapters/telegram.ts` (`tg.sendPhoto(chatId, new InputFile(buf, "card.png"), {caption, parse_mode})`).
  - В `jobDigest` при включённом флаге: **photo-first** — `sendPhoto`
    с коротким caption-вердиктом (≤1024) per channel в try/catch
    (фейл фото не влияет на текстовый outbox), затем обычный текстовый
    дайджест. Фото вне outbox: дедуп по `digest_key` на уровне
    `syndications`-подобной записи либо просто `card_sent_keys` в БД
    (иначе перезапуск джоба пошлёт фото дважды — фиксируем отправку).
  - DM-пользователям карточку в v1 **не шлём** (каналы only; расширение —
    через `deliveries.payload_kind` позже).

### Тесты

- `layout` — снапшот структуры на фикстуре.
- `renderCard` → PNG magic bytes, >20KB, ≤5s.
- Кириллица в вердикте («ПОВЫШЕННЫЙ») — визуально при тест-рендере.

**Effort: 2 сессии.** Разблокирует п.5/3/14.

---

## 5. Еженедельный «дашборд-пост» (weekly v2)

### Реализация

- `templates.ts`: `renderWeeklyDashboard(events, states, composite,
prevWeek, trend, locale, dateLabel, promo?, readMoreUrl?)`.
- `prevWeek` = `getCompositeAtOrBefore(now-7d)` — новая repo-функция
  (`SELECT … WHERE ts <= ? ORDER BY ts DESC LIMIT 1`); поля
  `score`/`bucket` + `_model_prob` из `detail_json` [verified].
  **⚠️ Формат `ts`**: колонка хранит `datetime('now')` = пробел, не
  ISO-'T' — cutoff передаём `… .toISOString().slice(0,19).replace('T',' ')`
  или `datetime(?)` в SQL (см. §0).
- `trend`: выборка `composite_snapshots` за 30д → unicode-спарклайн
  `▁▂▃▄▅▆▇` (квантование по min/max выборки) + `first→last` дельта.
- Блок «Изменения за неделю» = текущий `getRecentEvents(168)`.
- Формат как в предыдущей версии плана (вердикт + дельты + переходы +
  активные + nowcast + trend + CTA/readMore из п.3).
- `jobDigest("weekly")` → новый рендер для каналов И DM (общий payload).
- Когда п.4 включён: photo-first (caption = первая строка вердикта),
  текст — outbox.

### Тесты

- `prevWeek=null` → корректный деград (строка дельты пропускается).
- `getCompositeAtOrBefore` на фикстурах; unicode-спарклайн квантование.

**Effort: 1 сессия.** Зависимости: п.4 для варианта с картинкой, п.3 для
readMore-ссылки.

---

## 6. Еженедельный self-audit («что было бы»)

### Формат — как в предыдущей версии.

### Реализация

- `src/jobs/selfAudit.ts` (`jobSelfAudit`): вызывается из шага digest в
  GHA после weekly (проверка `getUTCDay() === weekly_digest_day_utc`
  внутри джоба) — **только под `SYNDICATION_ENABLED`**, иначе серверный
  scheduler при появлении такого вызова продублирует посты (см. §0).
- Канальные посты self-audit — **через существующий outbox**, не прямой
  `sendTelegramMessage`: `enqueueDelivery({ digestKey: "a:YYYY-Www",
targetType: "channel", … })` + `processDeliveries()` — получаем дедуп
  по `uq_deliveries_digest`, ретраи и retry-логику бесплатно
  (бот-токен в GHA-secrets уже есть, digest так и работает).
  DM-подписчиков в v1 не трогаем — канальная аудитория важнее.
- Данные: `composite_snapshots` на `now-52w` (или `replay` если снапшотов
  мало — примечание: снапшоты истории <года вообще отсутствуют, ранние
  недели покажут `n/a` — честно пишем «нет данных до {дата}»);
  `detectEpisodes`+`getRecessionPeriods` → hit/FP/pending за 12м.
- Кэш эпизодов: миграция `0004_episodes_syndications` —
  `signal_episodes (signal_key, start, end, peak, outcome,
evaluated_at, PRIMARY KEY(signal_key,start))` + `syndications` (п.3) +
  `card_sent_keys` (п.4) — одной миграцией.
- Pending-эпизоды отдельным счётчиком («оценка открыта до {дата}»).

### Тесты

- Классификация hit/fp/pending; append-only досчёт эпизодов.

**Effort: 1.5 сессии.** Зависимости: п.3.

---

## 7. Regional nowcast: Sahm по штатам (Plus)

### Факты [verified]

- FRED: `SAHMREALTIME` — только национальный; штатных готовых нет, но
  есть `XXUR` (SA unemployment rate по 50 штатам + DC, с 1976, monthly,
  лаг ~3–4 недели). Методология подтверждена самой К. Сэм (state-level
  Sahm: `MA3 − min(MA3 за 12м)`, триггер 0.5 — национальный; штаты
  шумнее → пометка experimental, без hist).

### Дизайн multi-input [verified vs schema]

`signal.input` обязателен и одиночный → не трогаем схему сигнала:

- `input: {key: unrate, transform: value}` — **драйвер сетки** (тот же
  monthly-календарь; `Panel.latestObsDate`, `replaySignal`, `_rule_hash`
  работают без изменений).
- Новый тип evaluator'а `sahm_states` — **три правки, все обязательны**:
  (a) `evaluatorSchema`: ветка в discriminated union
  `{type:"sahm_states", params: {keys: string[], trigger, warn_count,
critical_count}}` + тип `EvaluatorDef`; (b) case в `evaluate()` —
  резолвит каждый `params.keys[i]` через внедрённый `getObs` как
  `{key, transform:"sahm"}` (сигнатура `GetObs` уже позволяет —
  `engine.ts` передаёт `panel.resolve(ref ?? signal.input)`);
  (c) `Panel.signalInputs.walk`: собирает `ev.params.keys` как refs
  `{key, transform:"sahm"}` → `latestObsDate` следит за всеми 51 рядом
  (иначе сигнал не переоценится при штатных апдейтах — тот же класс
  бага, что nyfed-fix).
- Новый transform `sahm` в `transforms.ts`: `MA3(obs) − min(MA3 за
12м)` — чистая функция над ObsRow[] (нужно ~15 obs истории).

### Источники

- `sources.yaml`: 51 ряд `ur_state_{code}` → `{CODE}UR`, monthly —
  пишем генератором (скрипт добавляет блок в yaml; zod-поля те же).
- `fetchAllSeries` подхватит их автоматом (+51 запрос/мес, под лимитом).

### Сигнал и доставка

- `block: nowcast`, `weight: 0` (не влияет на скор). Пороги count —
  стартовые `warn_count: 5`, `critical_count: 10`, `trigger: 0.5` —
  помечены experimental, без `hist` (калибровку отложить).
- `context`: `states: [{code, val}...]` топ-3 + count → алерт
  `⏱ Sahm: {{count}} states >{{trigger}}: {{top}}`.
- Nowcast-гейт `prefs.nowcast_alerts` уже фильтрует по `block==="nowcast"`
  [verified, publisher.ts:34] → Plus-механика бесплатна.
- **⚠️ проверить при реализации**: рендеры «активных» в дайджесте —
  исключить `block===nowcast` из общего списка активных (сейчас nowcast
  показывается отдельной строкой; sahm_states не должен удваивать шум).
- `min_event_gap_hours` (п.12) обязателен: штатные ряды приходят пачкой.

### Тесты

- `sahm`-transform на синтетике (MA3, min12, недостаток истории → []).
- `sahm_states` evaluator: count-пороги, топ-выборка, `keys` через resolve.

**Effort: 1.5 сессии.** Зависимости: п.12 желателен раньше.

---

## 8. «Уверенность в алерте» — согласованность блока

### Реализация

- `routeEvent(event, composite, states, conn)` — третий параметр
  `SignalStateRow[]` (у `routeEvents` уже есть вызывающий контекст из
  `jobDigest`/`engine`-path — передаём `getAllSignalStates`).
- `renderSignalEvent(event, composite, locale, states)`: блок сигнала
  из `getSignalDef().block`; `confirm = count(того же block, state>=warning)`
  — показывать при block-size ≥3 сигналов и только для `warning`/`critical`
  переходов вверх. Строки: `🧭 Подтверждают: {{n}} из {{m}} {{block}}-сигналов`
  / при n=1 `⚠ Не подтверждается другими {{block}}-сигналами`.
- `any_of/all_of`-ветви — v1 пропускаем (context.branches есть, но
  шумно).

### Тесты

- Строка появляется/скрывается по размеру блока и direction.

**Effort: 0.5 сессии.**

---

## 9. Пресеты алерт-зон по бакету (Plus) — исправление формулировки

### Факт [verified, handlers.ts:238]

Пресеты **уже существуют**: `set:score` циклит `[null, 3, 5, 7, 9, 13]`
одной кнопкой. Проблема: `3` и `7` не совпадают с границами бакетов
(`bands.min` = 5/9/13), и пользователь видит голое число без смысла.

### Реализация (уточнённая)

- Cycle строим из `model.composite.bands[].min` с `min > 0` →
  `[null, 5, 9, 13]` — не хардкодим (конфиг может поменяться; band
  `low` с `min: 0` в cycle не включаем — порог 0 бессмыслен).
- Подпись кнопки: порог + имя бакета локализовано
  (`≥9 · ВЫСОКИЙ`); в самой клавиатуре остаётся одна cycle-кнопка —
  **4 кнопки по ряду НЕ нужны**: cycle занимает 1 строку, читаемо,
  меньше кода. (Отклоняем вариант с рядом кнопок: 4 лишних колбэка и
  шире layout — выигрыша нет.)
- Миграция юзеров со старыми значениями 3/7: при загрузке prefs
  значения «не из списка» показываются как есть, cycle продолжится со
  следующего — специальной миграции не делаем (значения рабочие,
  просто нестандартные).

### Тесты

- Cycle = bands.mins из конфига; отображение bucket-лейбла.

**Effort: 0.2 сессии.**

---

## 10. `/episodes 2008` — исторический поиск (Plus)

### Реализация

- `bot.command("episodes", cmdEpisodes)`; парсинг `/episodes` | `2008` |
  `2007-2009`; plus-гейт.
- Ядро: `SeriesCache` + `replaySignal` per signal + `detectEpisodes` →
  эпизоды, пересекающие год(ы); `getRecessionPeriods` → кто «поймал»
  окно + NBER-периоды года. Формат — как в черновике плана.
- Производительность: replay 20 сигналов по полной истории — секунды;
  кэшируем отрендеренный ответ per `year|locale` в памяти процесса
  (Map, TTL сутки).
- > 4096 симв. → топ-N по severity + `…ещё n`.
- Дисклеймер в конце: latest-vintage (до внедрения п.1 — потом строка
  меняется на as-of пометку).

### Тесты

- Парсинг аргументов; пересечение эпизодов с годом; кэш-ключ.

**Effort: 1 сессия.**

---

## 11. `/now` — компактный статус (Plus)

- `bot.command("now", cmdNow)` — plus-гейт с апселлом
  (`bot.settings_plus_only` + кнопка `/plan`).
- `renderNow(composite, prevComposite, top3, nowcast, loc)` — 5–7 строк:
  вердикт + модель + `vs вчера: +0.5` + топ-3 активных + nowcast.
- `prevComposite` = `getCompositeAtOrBefore(now-24h)` (repo из п.5).
- В `/guide` и `/start`-справку добавить команду (Plus-marked).

**Effort: 0.3 сессии.**

---

## 12. Rate-limit событий per signal — исправление семантики

### Цель

Страховка от флапа частых (daily) рядов. Гистерезис чинит дребезг вокруг
порога, но лёгкий drift + частые obs всё равно могут дать серию событий.

### Уточнённый дизайн [verified vs schema]

- `signalDefSchema`: `min_event_gap_hours: z.number().positive().optional()`
  (имя — не `min_interval_hours`: единообразие с `ts`-полями).
- Проверка: `SELECT ts, to_state FROM signal_events WHERE signal_key=?
ORDER BY id DESC LIMIT 1` → `now − ts < gap` и переход **не в
  `critical`** → подавление. **Эскалация в critical всегда проходит** —
  иначе warning→critical за 2 часа молчит (alert-safety важнее антиспама).
- Подавление реализуем в `transitionSignalState(..., {suppressEvent?: boolean})`:
  state-строка обновляется (иначе залипнет), event не вставляется; маркер
  `suppressed: {from,to}` пишем в **`signal_state.context_json`** (поле
  events — `payload_json`; у подавленного перехода события нет — место
  маркера только одно) [verified: db.ts:37,48].
- Решение где считать: в `engine.ts` до вызова `transitionSignalState`
  — новая repo-функция `getLastEvent(signal_key)` + правило →
  `suppressEvent` флаг. **В `replaySignal` ничего не добавляем**: replay
  не пишет `signal_events` вовсе — эпизоды строятся из ряда состояний,
  а подавление не меняет состояние → паритет live/backtest соблюдается
  автоматически. (Если позже появится event-level метрика в replay —
  применить тот же gap-фильтр там.)
- Значения по умолчанию (в `signals.yaml`, не захардкожены): daily-ряды с
  пороговыми правилами (`hy_spread`, `bbb`, `stlfsi`, `vix`-связанные,
  `resteepening`) — 48–72h; monthly — не нужен; `sahm_states` — 168h
  (штатные приходят пачкой раз в месяц, но защита от дребезга порогов).
- Компромисс (документируем): подавленный переход пропадает из
  `signal_events` → не попадёт в instant-алерт и «Изменения» дайджеста;
  состояние при этом честное — «активные» в дайджесте его покажут.

### Тесты

- Подавление в окне; прохождение `critical` в окне; state обновился без
  event; после окна — проходит; `getLastEvent` на фикстурах.

**Effort: 0.7 сессии.**

---

## 13. FRED-ссылки в /guide и /analytics [verified: поле `series_id`]

- `/guide` — секция «Индикаторы и источники», генерируемая кодом из
  `sources.yaml` (не текстом в locale): `{название сигнала} →
fred.stlouisfed.org/series/{series_id}` — plain URL, Telegram сам
  сделает кликабельным.
- `/analytics` — к имени сигнала `· {series_id}`.
- Деривативные ряды (sloos_ci, nyfed_prob, sahm_states-ключи) — пометка
  `derived` без ссылки или ссылка на базовую серию.

**Effort: 0.3 сессии.**

---

## 14. Telegram Mini App на GitHub Pages

### Архитектура [verified]

- Pages = HTTPS ✓. `docs`-артефакт п.2 добавляет `app/index.html`
  - `app/app.js` + `app/styles.css` (версионируем исходники в `web/app/`,
    генератор копирует в `site/app/`).
- SPA читает `../data.json` (генерится п.2) — вердикт, спарклайн-points,
  активные, nowcast, `generated_at`.
- `telegram-web-app.js` — официальный CDN-скрипт Telegram (вендорим в
  репо: `web/app/vendor/telegram-web-app.js` — отвязываемся от их CDN).
- Тема: `Telegram.WebApp.themeParams` → CSS-переменные.
- Локаль UI: `initDataUnsafe.user.language_code` → `ru|en` — доверять
  некритично (данные публичные). **initData НЕ валидируем** — проверка
  HMAC невозможна без бэкенда; это осознанно приемлемо, т.к. выдаём
  только публичный агрегат. Персональные данные → тогда сервер.
- Деградация вне Telegram (прямая ссылка в браузере): показываем те же
  данные, логика не должна падать на отсутствии `window.Telegram`.
- Подключение:
  - команда `/dashboard` → `InlineKeyboard().webApp(t("bot.dashboard"),
"https://lexa070301.github.io/us_recession_chance/app/")`
    [grammy `InlineKeyboard().webApp` существует];
  - опционально reply-кнопка `Keyboard().webApp(...)` на `/start`;
  - Menu Button: `bot.api.setChatMenuButton({ menu_button: { type:
"web_app", text, web_app: {url} } })` — CLI `npm run menu-button`
    или через BotFather (Bot Settings → Menu Button). Зафиксировать в
    README.
- `data.json` схема: `{ generated_at, score, bucket, prob_label,
model_prob, trend: [[ts,score]...90d], active: [{icon,name,value,
severity}], nowcast: {…}, labels: {en:{…}, ru:{…}} }` — UI берёт
  строки из json, отдельный i18n в JS не нужен.

### Тесты

- `data.json` — zod-валидация в генераторе + тест.
- Ручная проверка в браузере + в Telegram (через BotFather test bot).

**Effort: 1.5 сессии.** Зависимости: п.2, визуальный язык п.4.

---

## Сводная таблица

| #   | Фича           | Effort | Зависит от | Гейтинг                           |
| --- | -------------- | ------ | ---------- | --------------------------------- |
| 1   | ALFRED-винтажи | 2      | —          | per-series `vintage:`             |
| 2   | Pages-сайт     | 1.5    | —          | нет                               |
| 3   | Syndication ×7 | 2      | 2,(4)      | `SYNDICATION_ENABLED` + env/venue |
| 4   | PNG-карточка   | 2      | —          | `CARD_ENABLED`                    |
| 5   | Weekly-дашборд | 1      | (4),(3)    | нет                               |
| 6   | Self-audit     | 1.5    | 3          | `SYNDICATION_ENABLED`             |
| 7   | Sahm-штаты     | 1.5    | (12)       | plus/nowcast, `block:nowcast`     |
| 8   | Corroboration  | 0.5    | —          | нет                               |
| 9   | Пресеты→бакеты | 0.2    | —          | plus (уже)                        |
| 10  | /episodes      | 1      | —          | plus                              |
| 11  | /now           | 0.3    | —          | plus                              |
| 12  | Rate-limit     | 0.7    | —          | per-signal config                 |
| 13  | FRED-ссылки    | 0.3    | —          | нет                               |
| 14  | Mini App       | 1.5    | 2          | нет                               |

**Волны:**

- **A (фундамент)**: 1 → 12 → 4 → мелочь {9, 11, 13, 8} одним прогоном.
- **B (внешний мир)**: 2 → 3 → 5.
- **C (глубина)**: 6 → 7 → 10 → 14.

**Операционные шаги (не код):** проверить серверный `.env` —
`TG_CHANNEL_*` там быть **не должно** (иначе канальные дайджесты уже
сегодня дублируются сервер+GHA; см. §0) — при наличии убрать либо
ввести `CHANNEL_POSTS_ENABLED` гейт; Pages → Source: GitHub Actions;
Buffer: аккаунт → подключить X/Threads/LinkedIn (для Threads нужен
связанный Instagram-аккаунт) → API key + channel IDs в GitHub Secrets;
Reddit: создать `r/USRecessionWatch` + script-app на prefs/apps;
`npm run telegraph-init` ×2; аккаунты bsky/mastodon/discord-сервер;
Substack — вручную + «Import RSS» на feed.xml;
`setChatMenuButton` для Mini App; `SYNDICATION_ENABLED=true` и секреты
витрин — **только в GitHub Secrets**, не на сервере.

**Общие правила:** тексты — только через locales; env — в `.env.example`
с инструкцией; venue-фейлы fail-open; конфиги — zod; DEVLOG-запись
волной; ничего не включаем в прод без флага, пока не протестировано.
