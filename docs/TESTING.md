# Тестирование

Документ для разработчиков: какие проверки есть в «Олимпусе», как их запускать локально и в CI,
какие переменные окружения им нужны и где остаются пробелы. Как поднять проект для разработки –
[DEVELOPMENT.md](DEVELOPMENT.md); контракт API – [API.md](API.md); тесты чат-бота подробно –
[BOT.md](BOT.md); формат учебного контента –
[../content/README.md](../content/README.md).

Все числа ниже получены запуском 29.09.2026 на коммите `5b6dddd` ветки интеграции (macOS,
Node 25.9.0; интеграционные тесты – на локальной PostgreSQL 16; в CI – Node 22 и PostgreSQL 17).

## Быстрый старт

```bash
pnpm install --frozen-lockfile
pnpm compile-content          # валидация content/** → lib/seed.json
pnpm lint && pnpm format:check && pnpm typecheck
pnpm test                     # unit + ui, без базы данных, ~15–20 с
pnpm check                    # всё сразу: lint, format:check, typecheck, test, build
```

Нужен pnpm именно версии из `package.json` (`packageManager: pnpm@11.25.0`): включите его через
`corepack enable` или вызывайте `npx -y pnpm@11.25.0 <команда>`. Старый глобальный pnpm падает на
`pnpm-workspace.yaml` с ошибкой `packages field missing or empty`.

## Пирамида тестов

| Слой | Что проверяет | Где | Команда | Нужно | Объём |
|---|---|---|---|---|---|
| Статические проверки | ESLint (0 предупреждений), Prettier, `tsc --noEmit` | весь репозиторий | `pnpm lint`, `pnpm format:check`, `pnpm typecheck` | – | – |
| Валидация контента | схема каждой записи, связи, дубли олимпиад; сборка `lib/seed.json` | `content/**`, `lib/content/validate.mjs` | `pnpm compile-content` | – | 1305 записей |
| Качество контента | содержательные правила для уроков и задач, эталонные решения задач с кодом | `tests/unit/content/` | входит в `pnpm test:unit` | `python3` (иначе проверка решений пропускается) | 1 файл, 941 тест |
| Контракты | `DATA-API.yaml` ↔ контент, `test-data.json` и `openapi.yaml`; runtime-образ содержит всё, что импортируют бот и скрипты | `tests/unit/contracts/` | входит в `pnpm test:unit` | – | 2 файла, 17 тестов |
| Unit | чистая логика сервера, клиента, бота, runner, скриптов | `tests/unit/**` (без `content/` и `contracts/`) | `pnpm test:unit` | – | 39 файлов, 950 тестов |
| UI (компоненты) | экраны приложения в jsdom с фейковым API | `tests/ui/` | `pnpm test:ui` | – | 4 файла, 27 тестов |
| Интеграционные | обработчики маршрутов `/api/olympus` и `/api/v1`, сценарий `DATA-API.yaml` и `scripts/api-smoke.mjs`, сидирование, миграции, `sync-content`, чат-бот – на настоящей PostgreSQL | `tests/integration/**` | `pnpm test:integration` | `TEST_DATABASE_URL` | 12 файлов, 240 тестов |
| E2E | сценарии ребёнка и учителя в браузере, интеграция с MAX Bridge (фейковым) | `tests/e2e/` | `pnpm test:e2e` | запущенный стек | 3 файла × 2 проекта = 8 тестов |
| API smoke | сценарий `DATA-API.yaml` по HTTP против живого стенда | `scripts/api-smoke.mjs` | `pnpm test:api` | запущенный стек, `TEST_API_PASSWORD` | 13 шагов |
| Runner smoke | runner + настоящий Judge0: `/health` и одна программа на Python | `scripts/runner-smoke.mjs` | `pnpm test:runner` | runner, Judge0, `RUNNER_TOKEN` | 1 сценарий |
| Bot smoke | настоящий MAX Bot API с токеном бота | `bot/scripts/smoke.mjs` | `node bot/scripts/smoke.mjs` | `BOT_TOKEN` | ручная проверка |

Итого в Vitest: `pnpm test` – 46 файлов, 1935 тестов (unit 42 файла / 1908 тестов, из них 941 –
контент и 17 – контракты; ui 4 / 27). Вместе с интеграционными – 58 файлов, 2175 тестов, все
проходят.

Разбивка unit-тестов по папкам:

| Папка | Файлов | Тестов | Что внутри |
|---|---:|---:|---|
| `tests/unit/*.test.ts` | 21 | 635 | валидация контента (`content-validate`, 180 тестов), `compile-content`, `sync-content` (план и отчёт), проверка ответов (`grading`), пробники, прогресс и звёзды, сессии, проверка `initData` MAX, HTTP-слой, ошибки, лимитер входов, медиа, клиент и сервер runner, настройки, учётка `test_user`, передача переменных в wrangler (`worker-vars`) |
| `tests/unit/bot/` | 10 | 199 | клиент Bot API, доставка (webhook, long polling), клавиатуры, подбор олимпиад, прогресс, лимиты запросов, напоминания, маршрутизация, тексты |
| `tests/unit/client/` | 2 | 23 | клиент `/api/olympus` и словарь ошибок, обёртка MAX Bridge |
| `tests/unit/ui/` | 6 | 93 | логика экранов без DOM: календарь (регионы, свёртка серий), даты, навигация и `start_param`, прогресс и путь обучения, тексты и склонения, формы и CSV-импорт админки |
| `tests/unit/content/` | 1 | 941 | проверки качества контента (см. ниже) |
| `tests/unit/contracts/` | 2 | 17 | `data-api.test.ts` – сценарий проверяющих согласован с контентом; `runtime-image.test.ts` – `Dockerfile` копирует в runtime-образ каждый файл, который импортируют `bot/*.mjs` и `scripts/*.mjs` |

## Как запускать каждый слой

### Unit и UI

```bash
pnpm test                 # оба проекта
pnpm test:unit            # только unit (node)
pnpm test:ui              # только UI (jsdom)
pnpm exec vitest run tests/unit/grading.test.ts          # один файл
pnpm exec vitest --project unit                           # watch-режим
CONTENT_SCOPE=math-4 pnpm test:unit tests/unit/content    # контент одного предмета и класса
```

Проекты описаны в `vitest.config.ts`: `unit` (окружение node), `ui` (jsdom, `tests/support/ui-setup.ts`
добавляет `matchMedia`, `scrollTo`, `scrollIntoView` и чистит `localStorage` после каждого теста),
`integration` (node, файлы по одному, таймауты 20/30 с). Модуль `cloudflare:workers` в тестах
подменяется `tests/support/cloudflare-workers.ts`: его `env` читает `process.env`, а тесты могут
присвоить привязки вроде `BUCKET`.

UI-тесты рендерят всё приложение (`tests/support/render-app.tsx`, `renderApp`) поверх фейкового
сервера в памяти (`tests/support/fake-api.ts`), с зафиксированной датой 29.09.2026 09:00 МСК.

### Интеграционные

Нужна отдельная одноразовая база PostgreSQL: перед каждым файлом тесты удаляют таблицы `records`,
`revisions`, `sessions`, `progress`, `imports`, `_olympus_migrations`, применяют миграции из
`drizzle/` и загружают настоящий `lib/seed.json` (`resetDatabase` в `tests/support/server.ts`).
**Не указывайте рабочую базу.**

Учебный контент и календарь регулярно переписываются, поэтому интеграционные тесты не опираются
на id и ответы из `content/`: проверка ответов, звёзды, пробники, черновики и runner работают на
маленьком синтетическом курсе `tests/support/fixtures.ts` (темы `fx-*`: числовые задачи с разными
баллами, доказательство, программы со скрытыми тестами, фиксированный, случайный и смешанный
пробники), который публикуется тем же кодом, что импорт учителя (`resetDatabase({ fixtures: true })`).
Ожидания тесты читают из самих записей фикстуры. Тесты, которые намеренно проверяют настоящий
контент (seed, `sync-content`, сценарий `DATA-API.yaml`, `api-smoke`), берут ожидания из
`lib/seed.json`, `test-data.json` и `DATA-API.yaml` во время выполнения.

```bash
# любая одноразовая PostgreSQL 17 (так в CI); пример – контейнер
docker run -d --name olympus-testdb -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=olympus_test -p 55432:5432 postgres:17-alpine

pnpm compile-content      # тесты читают lib/seed.json
TEST_DATABASE_URL=postgres://test:test@localhost:55432/olympus_test pnpm test:integration
```

Без `TEST_DATABASE_URL` проект `integration` падает сразу с подсказкой
(`tests/support/integration-setup.ts`); внутри тестов значение становится `DATABASE_URL`.
Обработчики маршрутов вызываются напрямую (`new Request(...)`), без HTTP-сервера и workerd.
Runner и хранилище медиа подменяются фейками (`startFakeRunner`, `MemoryBucket`), MAX `initData`
подписывается тем же алгоритмом, что у MAX (`signInitData`). Чат-бот
(`tests/integration/bot/`) запускается так же, как в контейнере, против фейкового Bot API на
`node:http` (`fake-max-api.ts`).

### E2E (Playwright)

Тесты идут против уже запущенного стека и ничего не поднимают сами:

```bash
cp .env.example .env      # локальные пароли уже в шаблоне
docker compose up -d --build --wait
pnpm exec playwright install chromium
E2E_BASE_URL=http://localhost:3000 E2E_ADMIN_PASSWORD=olympus-local-admin pnpm test:e2e
```

- два проекта: `mobile` (Pixel 7, 390×844) и `desktop` (1280×800), локаль `ru-RU`, часовой пояс
  `Europe/Moscow`; часы браузера зафиксированы на 29.09.2026 10:00 МСК (`tests/e2e/helpers.ts`);
- скрипт MAX Bridge (`https://st.max.ru/**`) подменяется: пустым (обычный браузер) или фейковым
  `window.WebApp`, который записывает вызовы `ready`, `BackButton`, `openLink`,
  `enableClosingConfirmation`, `HapticFeedback` (`tests/e2e/max.spec.ts`);
- `main.spec.ts` – главный путь ребёнка: первый запуск → «Олимпиады» (регион, карточка,
  «Я участвую») → «Я» → теория со звездой → практика → пробник с результатами;
- `admin.spec.ts` – учитель входит через «Для учителя», создаёт и публикует тему, видит её как
  ребёнок и удаляет. Тест пишет в базу стенда (тема остаётся в корзине удалённых) – не запускайте его
  на production;
- в CI: один повтор при падении, HTML-отчёт в `playwright-report/`, трассы в `test-results/`.

### API smoke (`DATA-API.yaml`)

```bash
API_BASE_URL=http://localhost:3000 TEST_API_PASSWORD=olympus-local-test pnpm test:api   # локальный пароль из .env.example
```

13 шагов по порядку `DATA-API.yaml`: `health` → `auth/login` → запрос без токена получает `401`
с `error.code` → `test/reset` → `content` → тема → просмотр урока → проверка задачи → регистрация на
олимпиаду → старт и сохранение пробника → завершение → профиль (прогресс урока и регистрации
сохранён) → повтор и очистка (после `reset` прогресс пуст). Каждый ответ обязан быть
`application/json` с нужными полями; в теме не должно быть `answer`/`tests`, в итогах пробника –
скрытых тестов. Ответ на числовое задание из `test-data.json` должен быть засчитан, а пробник,
отвеченный целиком, – получить полный балл (`score = max`, `pending = 0`). Идентификаторы берутся из `test-data.json`; если запись не опубликована, скрипт
берёт первую запись того же типа и пишет `note:`. Скрипт трогает только прогресс `test_user`.
Проверено 29.09.2026 против локального стека: `Olympus API smoke test: OK`.

### Runner и Judge0

Порт runner наружу не публикуется, поэтому проверку удобно запускать из контейнера `web`, где уже
задан `RUNNER_URL=http://runner:8080`:

```bash
docker compose exec -e RUNNER_TOKEN=<RUNNER_TOKEN из .env> web node scripts/runner-smoke.mjs
```

Скрипт требует `RUNNER_TOKEN` (без него сразу ошибка), проверяет `GET /health` и отправляет на
`POST /execute` программу `print(n * 2)` с тестом `2 → 4`. Без `JUDGE0_URL` runner отвечает `503` –
это ожидаемо, см. [JUDGE0.md](JUDGE0.md).

### Чат-бот с настоящим токеном

`BOT_TOKEN=… node bot/scripts/smoke.mjs` – только чтение (`GET /me`, `GET /subscriptions`); флаги
`--send-to=<user_id>`, `--register-commands`, `--resubscribe`, `--unsubscribe`. Токен не
печатается. Подробности – [BOT.md](BOT.md).

## Переменные окружения тестов

| Переменная | Кто читает | По умолчанию | Назначение |
|---|---|---|---|
| `TEST_DATABASE_URL` | `tests/support/integration-setup.ts` | – (обязательна) | одноразовая PostgreSQL для `pnpm test:integration`; база очищается |
| `CONTENT_SCOPE` | `tests/unit/content/content-quality.test.ts` | пусто (весь контент) | ограничить проверки контента префиксом, например `math-4` |
| `OLYMPUS_BENCH` | `tests/integration/bootstrap-bench.test.ts` | пусто (тест пропускается) | `1` – замерить `GET /api/olympus` ребёнка: прежний обработчик, пересборка каталога и ответ из кэша (по 5 запросов подряд, медиана CPU/времени и размер ответа; не нагрузочный тест) |
| `E2E_BASE_URL` | `playwright.config.ts` | `http://localhost:3000` | адрес запущенного стека для E2E |
| `E2E_ADMIN_PASSWORD` | `tests/e2e/admin.spec.ts` | `local-admin-pass` | `ADMIN_PASSWORD` стенда |
| `API_BASE_URL` | `scripts/api-smoke.mjs` | `http://localhost:3000` | адрес API для smoke-проверки |
| `TEST_API_USERNAME` | `scripts/api-smoke.mjs` | `test_user` | логин тестовой учётки |
| `TEST_API_PASSWORD` | `scripts/api-smoke.mjs` | – (обязательна, иначе код выхода 2) | пароль тестовой учётки стенда |
| `API_TEST_OLYMPIAD_ID` | `scripts/api-smoke.mjs` | из `test-data.json` | проверить регистрацию на другой олимпиаде (должна быть опубликована, иначе ошибка) |
| `API_WAIT_MS` | `scripts/api-smoke.mjs` | `60000` | сколько ждать `GET /api/v1/health` после старта стека |
| `RUNNER_URL` | `scripts/runner-smoke.mjs` | `http://localhost:8080` | адрес runner |
| `RUNNER_TOKEN` | `scripts/runner-smoke.mjs` | – (обязательна) | bearer-секрет runner |
| `CI` | `playwright.config.ts` | – | в CI: запрет `test.only`, 1 повтор, отчёты `github` + `html` |

## Проверки качества контента

Контент детей проверяется дважды, и оба шага запускаются в CI.

**1. `pnpm compile-content`** (`scripts/compile-content.mjs`) – те же правила, что при публикации и
импорте в админке (`lib/content/validate.mjs`): схема каждой записи (типы, обязательные поля,
лимиты длины, классы 4–6, предметы `math`/`info`, даты, безопасные URL, регионы из справочника
`lib/content/regions.mjs`), уникальность `id` внутри раздела и между разделами, связи (тема урока и
задания существует, задания пробника существуют) и дубли олимпиад (одинаковые название, регион и
дата). Любая ошибка останавливает `pnpm build` и сборку Docker-образа; сообщение указывает файл.
Сейчас: `Compiled and validated 1305 content records` (72 темы, 360 уроков, 360 заданий,
12 пробников, 501 олимпиада). Формат полей – [../content/README.md](../content/README.md).

**2. `tests/unit/content/content-quality.test.ts`** – содержательные правила (941 тест, большинство
параметризованы по записям):

- `id` уникальны по всему контенту;
- в каждой теме не меньше 5 уроков и 5 заданий, их `order` не повторяются;
- у каждой темы своё описание длиной от 20 символов;
- каждый урок содержит не меньше 200 символов текста; в каждой теме есть блок `example` или `code`;
- в теме нет заданий-шаблонов (условия совпадают после замены чисел на `N`);
- у числовых задач ответ – число (`^[-+]?\d+(?:[.,]\d+)?$`), разбор решения – от 40 символов;
- у задач с кодом от 3 до 20 тестов, публичный пример совпадает с первым тестом, в решении нет
  `TODO`/`FIXME`/«Адаптируй»;
- эталонное решение каждой задачи с кодом (Python) проходит все свои тесты: скрипт запускается
  через `python3` по 8 параллельно, 5 с на запуск, вывод сравнивается как в runner. Без `python3`
  этот тест пропускается (`skipIf`); локально он идёт ~11 с;
- после числительных 2–4 стоят правильные формы («3 минуты», а не «3 минут»);
- `test-data.json` указывает на существующие записи и на текущие правильные ответы задач и
  пробника (если переписать задачу, этот тест подскажет обновить файл).

Как безопасно добавлять темы и задачи – [../content/README.md](../content/README.md).

## Контракт API: `openapi.yaml` ↔ код

`tests/integration/api-v1.test.ts` связывает документацию и реализацию:

- каждая операция из `openapi.yaml` должна существовать как файл `app/<путь>/route.ts` с
  экспортом нужного HTTP-метода;
- каждый HTTP-статус, который встретился в тестах `/api/v1`, должен быть описан у этой операции в
  `openapi.yaml`, а каждая описанная операция `/api/v1` должна быть вызвана хотя бы раз;
- сценарий `DATA-API.yaml` проходит дважды подряд (повторяемость), ответы сверяются по полям;
  задача засчитана, пробник получает полный балл;
- `tests/integration/api-smoke.test.ts` запускает `scripts/api-smoke.mjs` против обработчиков по
  настоящему HTTP;
- `tests/unit/contracts/data-api.test.ts` (без базы): каждый id из `DATA-API.yaml` есть в
  `lib/seed.json` нужного типа и опубликован, ответы равны ответам контента, ответы `finish-mock`
  покрывают весь пробник, `DATA-API.yaml` совпадает с `test-data.json`, проверки покрывают все
  операции `/api/v1`, а их коды описаны в `openapi.yaml`; адрес production – `https://olympus-edu.ru`.

`openapi.yaml` читается простым построчным разбором (`tests/support/openapi.ts`), поэтому файл
должен сохранять отступы в два пробела и коды ответов в кавычках (`'200':`).

## CI

`.github/workflows/ci.yml` запускается на push в `main`, на pull request и вручную.

| Job | Что делает | Время/лимит |
|---|---|---|
| `quality` | `pnpm install --frozen-lockfile` → `compile-content` → `lint --max-warnings=0` → `format:check` → `typecheck` → unit + ui с покрытием (артефакт `coverage-unit-ui`, 14 дней) → `pnpm build` → `pnpm audit --prod --audit-level high` | 20 мин |
| `integration` | сервис `postgres:17-alpine`, `TEST_DATABASE_URL=postgres://test:test@localhost:5432/olympus_ci`, `compile-content`, `pnpm test:integration` | 20 мин |
| `docker-e2e` | `.env` из `.env.example` с тестовыми паролями → `docker compose config` для обоих compose-файлов → заранее скачивает `node:22-bookworm-slim` и `postgres:17-alpine` → `docker compose build --no-cache` **не дольше 300 с** (иначе ошибка; время пишется в summary) → `docker compose up -d --wait` → `scripts/api-smoke.mjs` → Playwright Chromium → `pnpm test:e2e`; при падении – логи сервисов и отчёт Playwright; в конце `docker compose down -v` | 35 мин |
| `workflows` | `actionlint` 1.7.12 для всех workflow | 5 мин |
| `publish` | только push в `main` после четырёх job выше: собирает и публикует `ghcr.io/<owner>/olympus-web` и `olympus-runner` с тегами `<sha>` и `latest` | 20 мин |

После успешного CI на `main` запускается `deploy.yml` (см. [DEPLOYMENT.md](DEPLOYMENT.md)).

Дополнительно:

- **CodeQL** (`codeql.yml`) – языки `javascript-typescript` и `actions`, набор
  `security-and-quality`; push в `main`, pull request и по понедельникам в 03:17 UTC.
- **Dependabot** (`.github/dependabot.yml`) – еженедельно по понедельникам: npm (минорные и
  патч-обновления одной группой, до 5 PR, выдержка 7 дней – как `minimumReleaseAge` в
  `pnpm-workspace.yaml`), GitHub Actions (одной группой), Docker-образы в `/` и `/runner`.

## Покрытие

Покрытие собирает V8 (`@vitest/coverage-v8`) по папкам `app`, `bot`, `components`, `lib`,
`runner`, `scripts` (без `lib/seed.json` и `*.d.ts`); отчёты – `text-summary` в консоли, HTML и
`lcov` в `coverage/` (папка в `.gitignore`).

Замер 29.09.2026, коммит `5b6dddd`:

| Набор | Команда | Statements | Branches | Functions | Lines |
|---|---|---:|---:|---:|---:|
| unit + ui (как в CI) | `pnpm exec vitest run --project unit --project ui --coverage` | 65,94 % | 66,37 % | 58,76 % | 66,73 % |
| все проекты, с интеграционными | `TEST_DATABASE_URL=… pnpm test:coverage` | 77,84 % | 74,13 % | 70,70 % | 79,14 % |

Покрытие строк по папкам (все проекты):

| Папка | Lines | Branches | Functions |
|---|---:|---:|---:|
| `lib/content` (валидация) | 100 % | 99,0 % | 100 % |
| `lib/domain` (правила достижений) | 100 % | 100 % | 100 % |
| `lib/server` (сессии, HTTP, MAX-auth, лимиты) | 100 % | 97,2 % | 94,4 % |
| `lib/api` (RPC и `/api/v1`) | 99,5 % | 93,5 % | 100 % |
| `lib/services` | 99,3 % | 93,8 % | 100 % |
| `lib/client` | 97,4 % | 88,9 % | 95,6 % |
| `lib/ui` (логика экранов) | 95,0 % | 82,9 % | 95,9 % |
| `runner` | 93,1 % | 91,0 % | 86,1 % |
| `bot` | 84,8 % | 78,4 % | 83,8 % |
| `app` (тонкие адаптеры маршрутов) | 75,0 % | 25,0 % | 37,5 % |
| `components/olympus` (React-экраны) | 59,2 % | 51,5 % | 44,4 % |
| `scripts` | 53,5 % | 48,2 % | 60,7 % |

## Как добавить тест

| Что меняете | Куда писать тест | Чем пользоваться |
|---|---|---|
| Чистую функцию в `lib/services`, `lib/server`, `lib/content`, `runner`, `scripts` | `tests/unit/<область>.test.ts` | обычный Vitest, фейковые таймеры `vi.useFakeTimers()` |
| Логику экрана без DOM (`lib/ui`) | `tests/unit/ui/` | – |
| Экран или сценарий в интерфейсе | `tests/ui/*.test.tsx` | `renderApp({ hash, settings, records, progress, … })` из `tests/support/render-app.tsx`, фейковый сервер `tests/support/fake-api.ts` (`api.calls`, `api.failNext(action, error)` для ошибок), `freezeDate()` |
| Действие `/api/olympus` или маршрут `/api/v1` | `tests/integration/rpc-*.test.ts`, `api-v1.test.ts` | из `tests/support/server.ts`: `resetDatabase({ fixtures: true })`, `configureEnv({...})`, `rpc()`, `bootstrap()`, `guestToken()`, `adminToken()`, `signInitData()`, `sql()`, `MemoryBucket` + `setBucket()`, `startFakeRunner()`; данные – синтетический курс `tests/support/fixtures.ts`, а не `content/` |
| Новую операцию `/api/v1` | `tests/integration/api-v1.test.ts` | сначала опишите её и все коды ответов в `openapi.yaml` – иначе контрактный тест упадёт |
| Чат-бота | `tests/unit/bot/` (помощники в `helpers.ts`), `tests/integration/bot/` | фейковый Bot API `tests/integration/bot/fake-max-api.ts` |
| Контент | ничего: `content-quality` и `compile-content` проверят новые записи сами | при изменении ответов задач из `test-data.json` обновите его и `DATA-API.yaml` – это покажет `tests/unit/contracts/data-api.test.ts` |
| Пользовательский путь целиком | `tests/e2e/*.spec.ts` | `prepare()`, `finishOnboarding()`, `openTab()`, `screenTitle()` из `tests/e2e/helpers.ts` |

Правила: тест не должен зависеть от текущей даты (фиксируйте часы), от сети (только фейки на
`127.0.0.1`) и от порядка файлов; интеграционный тест сам готовит базу через `resetDatabase()`.

## Известные пробелы

Состояние на коммите `5b6dddd` (29.09.2026):

- **E2E ссылаются на удалённую демо-олимпиаду** «Логика и открытия» (`event-demo-2`) в
  `main.spec.ts` и `max.spec.ts`; с текущим календарём эти шаги не найдут карточку. E2E
  переписываются; при подготовке этого документа они не запускались.
- **Нагрузка на машину.** UI-тесты рендерят экраны целиком в jsdom, поэтому проекту `ui` дан лимит
  15 с на тест (`vitest.config.ts`); при сборе покрытия на сильно загруженной машине отдельные
  тесты всё равно могут идти дольше.
- **Judge0 и MAX не участвуют в автоматических тестах**: runner подменяется фейком, MAX Bridge и
  Bot API – фейками. Настоящую проверку дают только `pnpm test:runner` и `bot/scripts/smoke.mjs`
  (список того, что можно подтвердить только с настоящим токеном, – в [BOT.md](BOT.md) и
  [MAX-INTEGRATION.md](MAX-INTEGRATION.md)).
- **Экраны React покрыты слабее логики** (59 % строк): редакторы админки и часть профиля
  проверяются только E2E. `scripts/docker-start.mjs` тестами не покрыт.
- Лимитер входов хранится в памяти процесса – это проверяется unit-тестами, но поведение при
  нескольких экземплярах web не тестируется.
