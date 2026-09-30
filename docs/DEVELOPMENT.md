# Разработка

Как запустить «Олимпус» у себя, как устроен репозиторий, какие соглашения приняты и как добавить
функцию от базы до интерфейса. Устройство системы – [ARCHITECTURE.md](ARCHITECTURE.md), тесты –
[TESTING.md](TESTING.md).

## 1. Что установить

| Инструмент | Версия | Зачем |
|---|---|---|
| Node.js | ≥ 22.13 (`engines` в `package.json`; в Docker – `node:22-bookworm-slim`) | сборка, скрипты, бот, runner |
| pnpm | ровно 11.25.0 (`packageManager` в `package.json`) | зависимости; старые версии pnpm не читают `pnpm-workspace.yaml` этого проекта |
| Docker Engine + Compose | Engine ≥ 25, Compose ≥ 2.24 | запуск всего стека |
| PostgreSQL | 17 (как в Docker; тесты проходят и на 16) | только для запуска без Docker |

pnpm нужной версии проще всего получить через Corepack, который входит в Node 22:

```bash
corepack enable          # дальше `pnpm` сам возьмёт версию из packageManager
pnpm install --frozen-lockfile
```

Без Corepack: `npx -y pnpm@11.25.0 install --frozen-lockfile` и так же для остальных команд.
`pnpm-workspace.yaml` включает политику цепочки поставок: пакеты моложе 7 дней не ставятся
(`minimumReleaseAge: 10080`), сборочные скрипты разрешены только перечисленным пакетам
(`allowBuilds`), уязвимые транзитивные версии `undici` и `ws` переопределены (`overrides`).

## 2. Запуск

### Вариант А – весь стек в Docker (как у проверяющих)

```bash
cp .env.example .env         # в шаблоне уже есть пароли для локальной проверки
docker compose up -d --build
docker compose ps            # postgres, web, runner, bot – (healthy)
```

Приложение – http://localhost:3000, режим учителя – http://localhost:3000/#/admin (пароль из
шаблона – `olympus-local-admin`, API – `test_user` / `olympus-local-test`). После изменения кода – снова `docker compose up -d --build`.
Подробности о переменных и портах – [../README.md](../README.md).

### Вариант Б – dev-сервер с горячей перезагрузкой

Нужна PostgreSQL, доступная с машины. Порт PostgreSQL из `compose.yaml` наружу не публикуется,
поэтому используйте свою установку или отдельный контейнер, например
`docker run -d --name olympus-dev-db -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:17-alpine`.

```bash
export DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres
pnpm db:setup                # compile-content + миграции + загрузка контента (SEED_MODE=bootstrap)

cat > .dev.vars <<EOF        # переменные для workerd в vinext dev; файл в .gitignore
DATABASE_URL=$DATABASE_URL
ADMIN_PASSWORD=local-admin-password
TEST_API_PASSWORD=local-test-password
EOF

pnpm dev                     # http://localhost:5173 (если порт занят, vinext возьмёт следующий)
```

`pnpm dev` пересобирает `lib/seed.json` и запускает `vinext dev`; в логе должно быть
«Using secrets defined in .dev.vars». Проверка: `curl http://localhost:5173/api/v1/health` →
`{"status":"ok","database":"ok","version":"1.0.0"}`.

Необязательные части:

- **Проверка кода:** запустите runner рядом –
  `RUNNER_TOKEN=dev-token JUDGE0_URL=https://<judge0> node runner/server.mjs` (порт 8080) – и
  добавьте в `.dev.vars` `RUNNER_URL=http://localhost:8080` и `RUNNER_TOKEN=dev-token`.
  Проверка runner: `RUNNER_URL=http://localhost:8080 RUNNER_TOKEN=dev-token pnpm test:runner`.
- **Вход через MAX:** нужен `BOT_TOKEN` в `.dev.vars` и запуск внутри MAX по HTTPS – локально это
  возможно только через туннель с публичным HTTPS-адресом, указанным в настройках бота.
- **Бот:** `NODE_EXTRA_CA_CERTS=bot/certs/russian_trusted_root_ca.crt BOT_TOKEN=… DATABASE_URL=… node bot/server.mjs`
  (long polling; см. [BOT.md](BOT.md#5-локальный-запуск-и-тесты)).

## 3. Команды

| Команда | Что делает |
|---|---|
| `pnpm dev` | `compile-content` + `vinext dev --port 5173` |
| `pnpm build` | `compile-content` + `vinext build` → `dist/` |
| `pnpm start` | `node scripts/docker-start.mjs`: миграции, seed, `wrangler dev --local` на `dist/` (так стартует контейнер) |
| `pnpm compile-content` | проверить `content/**` и записать `lib/seed.json` |
| `pnpm db:migrate` | применить `drizzle/*.sql` |
| `pnpm db:seed` | загрузить `lib/seed.json` по `SEED_MODE` и удалить истёкшие сессии |
| `pnpm db:setup` | `compile-content` + `db:migrate` + `db:seed` |
| `pnpm db:sync-content` | `scripts/sync-content.mjs` (пробный прогон; `-- --apply` для записи) |
| `pnpm lint` / `pnpm format` / `pnpm format:check` / `pnpm typecheck` | ESLint, Prettier, TypeScript |
| `pnpm test` | unit + ui (Vitest) |
| `pnpm test:unit`, `test:ui`, `test:integration`, `test:coverage`, `test:e2e` | отдельные наборы; см. [TESTING.md](TESTING.md) |
| `pnpm test:api` | сценарий API проверяющих против запущенного стека |
| `pnpm test:runner` | проверка runner (нужны `RUNNER_URL`, `RUNNER_TOKEN`) |
| `pnpm check` | lint + format:check + typecheck + test + build |
| `node scripts/check-doc-links.mjs` | проверить документацию: относительные ссылки и `#якоря` в `README.md`, `docs/**`, `content/README.md` ведут на существующие файлы и заголовки; пути в обратных кавычках существуют (предупреждения) |

Все скрипты, которым нужна база, берут подключение из `DATABASE_URL` или
`DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` (+ `DB_SSL`).

## 4. Карта репозитория

```text
app/                     маршруты Next (vinext): page.tsx, layout.tsx, globals.css, api/**/route.ts
components/olympus/      экраны: home, calendar, learn, training, mocks, profile, onboarding,
                         legal, admin (режим учителя), shared, state (данные и навигация), hooks
lib/domain/              контракт: types.ts (записи, прогресс, RPC, коды ошибок), achievements.mjs
lib/api/olympus/         RPC мини-приложения (dispatcher, context, handlers/*)
lib/api/v1/              API проверяющих (handler.ts, routes.ts)
lib/services/            бизнес-логика (content, progress, tasks, mocks, stars, admin, auth, media, runner…)
lib/server/              инфраструктура запроса (env, db, http, errors, session, max-auth, rate-limit…)
lib/content/             validate.mjs (правила контента), regions.mjs (89 субъектов РФ)
lib/client/              клиент RPC, MAX Bridge, хранилище, тексты ошибок, часы сервера
lib/ui/                  чистые функции интерфейса (календарь, CSV, прогресс, навигация, даты)
content/                 исходный контент в JSON (см. content/README.md)
drizzle/                 SQL-миграции PostgreSQL
scripts/                 docker-start, seed, миграции, compile/sync-content, api/runner smoke, deploy/
bot/                     чат-бот MAX (Node, без сборки), certs/ – корневой сертификат Минцифры
runner/                  адаптер к Judge0 (отдельный образ)
tests/                   unit, ui, integration, e2e, support (фейки и помощники), fixtures
presentation/            материалы презентации (к приложению не относятся)
public/                  статические файлы (иконки, картинки по умолчанию)
openapi.yaml, DATA-API.yaml, test-data.json   контракт и данные для проверки API
compose.yaml, compose.production.yaml, Dockerfile, Caddyfile, .env.example   запуск
.github/                 CI, деплой, CodeQL, Dependabot
```

## 5. Соглашения

- **Язык.** Код, идентификаторы, комментарии и сообщения коммитов – по-английски (Conventional
  Commits: `feat:`, `fix:`, `docs:`…). Всё, что видит пользователь, и сообщения валидации
  контента – по-русски, простыми словами для ребёнка 10–12 лет.
- **Типы.** TypeScript `strict`; контракт сервера и клиента – только в `lib/domain/types.ts`.
  Скрипты и бот – ESM `.mjs` с JSDoc (`// @ts-check`), чтобы работать в Node без сборки.
- **Слои.** Обработчик проверяет вход (`lib/server/validate.ts`) и вызывает сервис; сервис не
  знает про HTTP. Ошибки – `ApiError` с кодом из `ApiErrorCode`; тексты ошибок показываются
  ребёнку как есть, технические подробности – только в лог.
- **База.** Одно подключение на запрос, многошаговые изменения – в `db.transaction`. Миграции –
  новый файл `drizzle/000N_*.sql`, только добавляющие изменения, идемпотентные (`IF NOT EXISTS`).
- **Контент.** Любое правило контента – в `lib/content/validate.mjs`, чтобы сборка, админка и
  `sync-content` вели себя одинаково.
- **Безопасность.** Никаких секретов в коде и логах; новые секреты – в `SECRET_VARS`
  (`scripts/lib/worker-vars.mjs`), чтобы wrangler не печатал их при старте. Ответы, разборы и тесты
  задач не должны попадать к ребёнку раньше времени (см. проекции в `lib/services/content.ts`).
- **Стиль.** Prettier (ширина 100) и ESLint без предупреждений (`pnpm lint --max-warnings=0` в CI).
  Markdown и YAML Prettier не форматирует (`.prettierignore`).

## 6. Как добавить функцию от начала до конца

Пример – новое действие мини-приложения.

1. **Контракт.** Добавьте пару запрос/ответ в `OlympusRpc` (`lib/domain/types.ts`), новые коды
   ошибок – в `ApiErrorCode`; при новом виде прогресса – ключ в `progressKey`
   (`lib/services/progress.ts`) и тип значения.
2. **Сервис.** Логика – функция в `lib/services/<область>.ts`, принимающая `ServiceContext`
   (`db`, `env`, `actor`, `now`). Видимость записей – через `requireRecord`/`isVisibleTo`.
3. **Обработчик.** Маршрут в `lib/api/olympus/handlers/<область>.ts` с уровнем доступа
   `public` | `session` | `admin` и, если нужно, `maxBody`; он читает и проверяет
   `ctx.body`, вызывает сервис, возвращает `reply(...)`. Диспетчер подхватит его автоматически.
4. **База.** Если нужна новая таблица или колонка – `drizzle/000N_*.sql` (только добавления).
5. **Клиент и интерфейс.** Вызов – `api.call("<action>", {...})` из `lib/client/api.ts`; состояние –
   `components/olympus/state/data.tsx`; экран – `components/olympus/<раздел>/`. Ошибки показывайте
   рядом с элементом, а не только баннером; при сбое сети – кнопка повтора.
6. **Публичный API** (если действие нужно проверяющим): маршрут в `lib/api/v1/routes.ts`, файл
   `app/api/v1/.../route.ts`, описание в `openapi.yaml` (контрактный тест проверит, что каждая
   операция и каждый встреченный статус описаны), при необходимости – шаг в `DATA-API.yaml` и
   `scripts/api-smoke.mjs`.
7. **Бот.** Если меняются поля олимпиад/пробников или ключи прогресса, которые читает бот, обновите
   `bot/olympiads.mjs`, `bot/progress.mjs` и их тесты.
8. **Тесты.** Unit – для чистой логики сервиса; integration (`tests/integration/rpc-*.test.ts`) –
   сквозной вызов обработчика на настоящей PostgreSQL; UI (`tests/ui`) – для экрана. Затем
   `pnpm check` и `pnpm test:integration`.
9. **Документация.** Обновите [API.md](API.md), при изменении данных – [DATA.md](DATA.md), при
   изменении поведения для детей или учителей – [USER-GUIDE.md](USER-GUIDE.md) и
   [TEACHER-GUIDE.md](TEACHER-GUIDE.md); затем `node scripts/check-doc-links.mjs`.

Новое поле контента: тип в `lib/domain/types.ts` → правило в `lib/content/validate.mjs` → поле в
редакторе `components/olympus/admin/editors.tsx` (и в CSV, если это олимпиада:
`lib/ui/olympiad-csv.ts`) → тесты `tests/unit/content-validate.test.ts` → описание в
[DATA.md](DATA.md) и [../content/README.md](../content/README.md).
