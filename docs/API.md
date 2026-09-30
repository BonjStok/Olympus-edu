# API «Олимпуса»

Для кого: разработчики мини-приложения и бота и те, кто проверяет API. Здесь описано, как
сервер принимает запросы, кто что может вызывать, какие бывают ответы и ошибки. Контракты в
файлах: [`openapi.yaml`](../openapi.yaml) (OpenAPI 3.1, публичный `/api/v1`),
[`DATA-API.yaml`](../DATA-API.yaml) (сценарий автоматической проверки),
[`test-data.json`](../test-data.json) (стабильные id), [`lib/domain/types.ts`](../lib/domain/types.ts)
(контракт RPC мини-приложения и коды ошибок).

## 1. Обзор

У сервера три HTTP-интерфейса. Все обслуживает один сервис `web`.

| Интерфейс | Кто вызывает | Аутентификация | Формат ответа |
|---|---|---|---|
| `GET/POST /api/olympus` – RPC мини-приложения | интерфейс «Олимпуса» в MAX и в браузере | сессия: cookie `olympus_session` или `Authorization: Bearer <sessionToken>` | JSON, ошибка `{ "error": "<текст>", "code": "<КОД>" }` |
| `/api/v1/*` – REST для проверки | проверяющая система, `pnpm test:api` | Bearer-токен тестовой учётной записи `test_user` | JSON, ошибка `{ "error": { "code", "message" } }` |
| `GET /api/media/{id}` – файлы, загруженные учителем | браузер (картинки и видео в уроках) | не нужна | бинарный файл; ошибки – `text/plain` |

Адреса:

| Окружение | Базовый адрес | Примечание |
|---|---|---|
| Production | `https://olympus-edu.ru` (API: `https://olympus-edu.ru/api/v1`) | `GET /api/v1/health` ответил `200` 29.09.2026. Этот адрес указан первым в `servers` файла `openapi.yaml` и в `api.baseUrl` файла `DATA-API.yaml` |
| Локальный Docker | `http://localhost:3000` | порт задаёт `OLYMPUS_PORT` |
| `pnpm dev` без Docker | `http://localhost:5173` | см. [DEVELOPMENT.md](DEVELOPMENT.md) |

Пути в `openapi.yaml` и `DATA-API.yaml` записаны целиком (`/api/v1/health`), поэтому базовый
адрес в них – корень сайта, без `/api/v1`.

Где код:

| Путь | Что там |
|---|---|
| `app/api/**/route.ts` | тонкие адаптеры: каждый только вызывает обработчик из `lib/api` |
| `lib/api/olympus/dispatcher.ts`, `context.ts` | RPC: bootstrap, разбор `{ action }`, уровни доступа, лимиты тела |
| `lib/api/olympus/handlers/*.ts` | действия RPC по областям: `session`, `learning`, `tasks`, `mocks`, `admin` |
| `lib/api/v1/handler.ts`, `routes.ts` | `/api/v1`: обёртки `publicRoute`/`testUserRoute` и все эндпоинты |
| `lib/services/*.ts` | бизнес-логика, общая для RPC и `/api/v1` |
| `lib/server/*.ts` | HTTP-хелперы, ошибки, сессии, проверка `initData` MAX, лимитер входа, валидаторы |
| `lib/client/api.ts` | клиент RPC в браузере |

## 2. Общие правила

- **JSON.** Тело `POST`/`PATCH` – только `application/json` (или тип `*+json`), иначе `415
  UNSUPPORTED_MEDIA_TYPE`. Некорректный JSON – `400 INVALID_JSON`. Тело должно быть объектом.
- **Заголовки каждого JSON-ответа** (`lib/server/http.ts`): `Content-Type: application/json;
  charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=()` и `Date` (по нему клиент
  сверяет часы для таймера пробника). В production Caddy добавляет HSTS
  ([SECURITY.md](SECURITY.md)).
- **Идентификаторы** записей и попыток: `^[a-zA-Z0-9_-]{1,100}$`. В RPC неверный id – `400
  INVALID_ID`; в пути `/api/v1` id другого формата даёт `404` с кодом «не найдено» этого типа.
- **Время** – миллисекунды Unix (`started`, `ends`, `finishedAt`, `serverTime`, `updatedAt`).
- **Неопубликованные черновики и удалённые материалы** для всех, кроме администратора, не
  существуют: любой запрос к ним отвечает `404` того же вида, что и для несуществующего id. Если у
  опубликованной записи есть черновик, дети видят опубликованную версию.
- **Скрытые тесты** задач по программированию не уходят клиенту никогда. Ответ, разбор и
  подсказка – только по отдельному запросу (`hint`, `reveal`) или после завершения пробника.

### Размер тела запроса

| Где | Лимит | Константа |
|---|---|---|
| Любое действие RPC и `/api/v1` по умолчанию | 256 КБ | `DEFAULT_BODY_LIMIT` |
| RPC `mock-save`, `finish-mock`; `/api/v1` `PATCH /mock-attempts/{id}` и `POST .../finish` | 2 МБ (20 программ по 50 000 символов) | `MOCK_BODY_LIMIT` |
| RPC администратора `draft`, `publish`, `import`, `upload` | 12 МБ (файл 8 МБ в base64) | `LARGE_BODY_LIMIT` |

Сначала проверяется заявленный `Content-Length`, затем поток считается при чтении. Превышение –
`413 PAYLOAD_TOO_LARGE`.

## 3. Аутентификация и сессии

### 3.1. Сессия мини-приложения

- Токен сессии – 64 шестнадцатеричных символа. Сервер принимает его из заголовка
  `Authorization: Bearer <token>` или из cookie `olympus_session`. **Заголовок главнее**: если он
  есть, cookie не читается.
- Зачем заголовок: MAX Web открывает мини-приложение в iframe (`credentialless`), где cookie не
  сохраняются. Поэтому `GET /api/olympus` и действие `session` возвращают `sessionToken` в теле, а
  клиент (`lib/client/api.ts`) хранит его в памяти и `sessionStorage` (`olympus.sessionToken`) и
  отправляет как Bearer.
- Cookie: по HTTPS – `HttpOnly; Secure; SameSite=None; Partitioned`, по HTTP (локально) –
  `HttpOnly; SameSite=Lax`. `Path=/`, `Max-Age` равен оставшемуся сроку сессии.
- Срок жизни: гостевая сессия – 365 дней, сессия MAX – 30 дней. Истёкшие сессии и гостевые сессии
  старше суток без единой записи прогресса удаляет `scripts/seed.mjs` при старте контейнера и
  каждые 6 часов.
- В БД хранится только SHA-256 токена (`sessions.token`), поэтому дамп базы не позволяет войти
  чужой сессией.
- **Гость.** `GET /api/olympus` без действующего токена создаёт гостя `guest:<uuid>` и ставит
  cookie. Действие `session` без `initData` возвращает текущий токен или тоже создаёт гостя.
- Клиент при ответе `401` один раз заново открывает сессию (с `initData` MAX, если он есть) и
  повторяет запрос.

### 3.2. Вход через MAX (`initData`)

Мини-приложение отправляет `{ "action": "session", "initData": "<window.WebApp.initData>" }`.
Проверка в `lib/server/max-auth.ts` по алгоритму из документации MAX
(`https://dev.max.ru/docs/webapps/validation`):

1. `initData` – строка до 8 192 символов, каждый ключ ровно один раз, `hash` обязателен;
2. значения декодируются, `hash` убирается, пары сортируются по ключу и склеиваются через `\n`;
3. `secret_key = HMAC-SHA256(key = "WebAppData", message = BOT_TOKEN)`;
4. `hex(HMAC-SHA256(secret_key, строка из п. 2))` должен совпасть с `hash` (сравнение за
   постоянное время). Подходит и чтение `+` как пробела (так декодируют примеры MAX на Python/Go/Java);
5. `auth_date` не старше 1 часа и не больше чем на 30 секунд в будущем.

Результат: сессия `max:<user.id>` на 30 дней (id хранится строкой, без потери точности int64), имя
из `first_name` + `last_name`. Если до этого была гостевая сессия, её прогресс и настройки в одной
транзакции переносятся в профиль MAX (достижения не теряются: «решено», «прочитано»,
«зарегистрирован» объединяются через ИЛИ, звёзды сохраняют самую раннюю дату), гость удаляется.
Если запрос пришёл с другой, не гостевой сессией, её токен удаляется. Если в `initData` есть подписанный `start_param`
(`^[A-Za-z0-9_-]{1,512}$`), он возвращается как `startParam`.

Ошибки: без `BOT_TOKEN` на сервере – `503 MAX_NOT_CONFIGURED`; испорченные данные – `400
MAX_AUTH_FAILED`; неверная подпись или данные старше часа – `401 MAX_AUTH_FAILED`.

### 3.3. Администратор (учитель)

- `admin-login` с `{ "password": "..." }` сравнивает пароль с `ADMIN_PASSWORD` (за постоянное
  время) и **меняет токен сессии**: старый токен удаляется, новый приходит в `sessionToken` и
  cookie. Так токен, известный до входа, не становится токеном администратора.
- Права администратора пропадают после **60 минут без действий администратора** (скользящее окно,
  `sessions.admin_seen`). После этого `profile.admin` становится `false`, а админские действия
  отвечают `403 ADMIN_EXPIRED` до нового входа. Для сессии, которая не входила или вышла
  (`admin-logout`), – `403 ADMIN_REQUIRED`.
- Без `ADMIN_PASSWORD` на сервере – `503 ADMIN_NOT_CONFIGURED`. Неверный пароль – `403
  WRONG_PASSWORD`, частые ошибки – `429 RATE_LIMITED` ([§8](#8-лимиты)).

### 3.4. Проверка источника (CSRF)

`POST /api/olympus` **без** заголовка `Authorization` (то есть с cookie или без сессии) должен
прийти с того же `Origin`, что и сайт (учитываются `X-Forwarded-Proto`/`X-Forwarded-Host` от
прокси), иначе `403 BAD_ORIGIN`. Запрос без `Origin` (не браузер) пропускается, `Origin: null`
не совпадает никогда. Исключение – начальное действие `session` с непустым `initData`: MAX
Android передаёт Origin контейнера, а не приложения; до входа обработчик проверяет криптографическую
подпись `initData` и срок её действия. Запрос с заголовком `Authorization` чужой сайт подделать
не может, поэтому для него проверка не выполняется. `/api/v1` работает только с Bearer-токеном и
`Origin` не проверяет.

### 3.5. Тестовая учётная запись `/api/v1`

- Логин – `TEST_API_USERNAME` (по умолчанию `test_user`), пароль – `TEST_API_PASSWORD`. В
  `.env.example` есть пароль только для локальной проверки – `olympus-local-test`; production с
  ним не запускается. Рабочий пароль (обязателен, не короче 12 символов) задают в `.env` сервера
  и передают проверяющим отдельно, в репозитории его нет.
- `POST /api/v1/auth/login` возвращает `accessToken` – детерминированный SHA-256 от логина и пароля.
  Токен **не истекает** и не хранится в БД; он меняется только при смене пароля.
- Все остальные эндпоинты `/api/v1`, кроме `health`, требуют `Authorization: Bearer <accessToken>`
  и работают от имени одного технического пользователя `test:evaluator` (роль `test_user`, не
  администратор). Прогресс этого пользователя изолирован от детей;
  `POST /api/v1/test/reset` удаляет только его строки в `progress`.
- Если `TEST_API_PASSWORD` не задан, `login` и все защищённые эндпоинты отвечают `503
  TEST_ACCOUNT_NOT_CONFIGURED`.

## 4. RPC мини-приложения `/api/olympus`

### 4.1. `GET /api/olympus` – bootstrap

Отдаёт всё, что нужно интерфейсу при запуске. Без действующей сессии создаёт гостя и ставит cookie.

| Поле | Что это |
|---|---|
| `records` | каталог: для ребёнка – только опубликованные записи всех типов, у уроков и заданий только краткие поля (`id`, `kind`, `title`, `grade`, `subject`, `topicId`, `order`, у заданий ещё `type`, `points`); у олимпиад – всё, кроме `description`, `source`, `verifiedAt` и `image` (их отдаёт действие `olympiad` для экрана олимпиады); темы и пробники целиком. Для администратора – все неудалённые записи целиком с полем `draft` (ожидающий черновик или `null`) |
| `progress` | прогресс текущего пользователя: объект `ключ → значение` (ключи в [DATA.md](DATA.md)); попытки пробников очищены так же, как в `mock-get` |
| `profile` | `{ name, photo: null, max, admin }`: `max` – вход через MAX, `admin` – права учителя активны |
| `features` | `runner` (задан `RUNNER_URL`), `max` (задан `BOT_TOKEN`), `reminders` (`BOT_TOKEN` и `BOT_REMINDERS=on`), `botName` (`MAX_BOT_NAME`, если похоже на имя бота, иначе `null`) |
| `sessionToken` | токен текущей сессии для заголовка `Authorization` |
| `serverTime` | часы сервера, мс |
| `runner`, `maxConnected` | устаревшие копии `features.runner` и `features.max` |

`features.runner = true` значит только, что web знает адрес runner. Работает ли Judge0, видно по
ответу `check`/`run` (`503 RUNNER_UNAVAILABLE`, если нет).

Каталог ребёнка одинаков для всех детей, поэтому каждый процесс web держит его в памяти уже
сериализованным в JSON (`lib/services/catalogue.ts`). На каждый запрос сервер одним запросом к
`records` получает версию контента – число живых и удалённых записей, `max(updated)` и
`sum(updated)` – и пересобирает каталог только при её изменении; прогресс, профиль, флаги и токен
собираются для каждого запроса заново. Любая запись в `records` (черновик, публикация, импорт,
удаление, восстановление, `SEED_MODE=bootstrap`/`sync`, `scripts/sync-content.mjs`) строго
увеличивает `updated` строки (`GREATEST(now, updated + 1)`), поэтому новая версия видна детям в
следующем же bootstrap. Каталог учителя не кэшируется.

### 4.2. `POST /api/olympus` – действия

Тело: `{ "action": "<имя>", ...параметры }`. Порядок обработки (`lib/api/olympus/dispatcher.ts`):
`Content-Type` → загрузка сессии → чтение тела (до 2 МБ, у администратора до 12 МБ) → поиск
действия (`400 UNKNOWN_ACTION`) → проверка `Origin` (с исключением для `session` + `initData`,
см. выше) → лимит тела этого действия (`413`) → уровень доступа → обработчик. Другие методы
(`PUT`, `PATCH`, `DELETE`, `OPTIONS`) – `405 METHOD_NOT_ALLOWED` с заголовком
`Allow: GET, POST`.

Уровни доступа:

- `public` – без сессии (обработчик сам её создаст);
- `session` – любая сессия (гость, MAX или администратор), без неё `401 SESSION_EXPIRED`;
- `admin` – сессия с активными правами администратора, иначе `401 SESSION_EXPIRED` (нет сессии),
  `403 ADMIN_REQUIRED` или `403 ADMIN_EXPIRED`.

Успешный ответ всегда `200`.

#### Сессия и настройки

| Действие | Доступ | Запрос | Ответ | Ошибки (кроме общих) |
|---|---|---|---|---|
| `session` | public | `{ initData? }` | `{ ok: true, sessionToken, startParam? }` (+ `Set-Cookie` для новой сессии) | `MAX_NOT_CONFIGURED` 503, `MAX_AUTH_FAILED` 400/401 |
| `admin-login` | session | `{ password }` (≤ 512 символов) | `{ ok: true, sessionToken }` – **новый** токен (+ `Set-Cookie`) | `RATE_LIMITED` 429, `ADMIN_NOT_CONFIGURED` 503, `INVALID_REQUEST` 400, `WRONG_PASSWORD` 403 |
| `admin-logout` | session | `{}` | `{ ok: true }` (токен не меняется, права сняты) | – |
| `settings` | session | `{ region?, grade?, subject? }`; `null` очищает поле, отсутствующее поле не меняется | `{ ok: true, settings }` | `INVALID_SETTINGS` 422 (регион не из списка `lib/content/regions.mjs`, класс не 4/5/6, предмет не `math`/`info`) |

`region: ""` означает «вся Россия». Настройки хранятся в прогрессе (`settings`) и переезжают вместе
с гостевым прогрессом в профиль MAX.

#### Учёба

| Действие | Доступ | Запрос | Ответ | Ошибки |
|---|---|---|---|---|
| `topic-content` | session | `{ id }` – id темы | `{ lessons, tasks }`: опубликованные уроки целиком и задания без `answer`, `solution`, `hint`, `tests`, по `order` | `TOPIC_NOT_FOUND` 404 |
| `view-lesson` | session | `{ id }` – id урока | `{ ok: true }`; пишет `lesson:<id>` = `{ read: true }` | `LESSON_NOT_FOUND` 404 |
| `star` | session | `{ id }` – id темы | `{ ok: true }`; звезда теории `theory-star:<id>` (повторный вызов ничего не меняет) | `TOPIC_NOT_FOUND` 404, `TOPIC_HAS_NO_LESSONS` 409, `LESSONS_NOT_READ` 409 (открыты не все уроки темы) |
| `olympiad` | session | `{ id }` – id олимпиады | `{ olympiad }`: олимпиада целиком, с `description`, `source`, `verifiedAt`, `image`, которых нет в каталоге bootstrap. Ребёнку – только опубликованные | `OLYMPIAD_NOT_FOUND` 404 (черновик, удалена, нет такой, другой тип) |
| `register` | session | `{ id, yes: boolean }` – id олимпиады | `{ ok: true, registered }`; `yes: true` пишет `registration:<id>`, `false` удаляет | `OLYMPIAD_NOT_FOUND` 404, `INVALID_REGISTERED` 422 |

#### Задания

| Действие | Доступ | Запрос | Ответ | Ошибки |
|---|---|---|---|---|
| `check` | session | `{ id, answer }` – число; `{ id, correct }` – самопроверка доказательства; `{ id, code, language }` – программа | `{ correct, output, practiceStar, solvedAfterReveal? }` | `TASK_NOT_FOUND` 404, `INVALID_ANSWER` 422, `INVALID_SELF_CHECK` 422, `INVALID_CODE` 422, `INVALID_LANGUAGE` 422, `RUNNER_BUSY` 429, `RUNNER_UNAVAILABLE` 503 |
| `run` | session | `{ id, code, language, input }` (`input` ≤ 100 000 символов) | `{ correct, output, passed?, total? }` – запуск на своих данных, без оценки и без записи попытки | `NOT_CODE_TASK` 400, `INVALID_INPUT` 422, остальные как у `check` |
| `hint` | session | `{ id }` | `{ hint }` (если у задания нет подсказки – общая: «Разбей условие на шаги и проверь небольшой пример») | `TASK_NOT_FOUND` 404, `MOCK_IN_PROGRESS` 409 |
| `reveal` | session | `{ id }` | `{ answer?, solution }`; нерешённое задание получает отметку `revealed` | `TASK_NOT_FOUND` 404, `MOCK_IN_PROGRESS` 409 |
| `code-draft` | session | `{ id, code, language }` | `{ ok: true }`; автосохранение `code:<id>` | `NOT_CODE_TASK` 400, `INVALID_CODE` 422, `INVALID_LANGUAGE` 422 |

Подробности:

- **Числовой ответ**: целое или десятичное число, знак `+`/`-`, разделитель `.` или `,`
  (`"1,5"` = `1.5`); `"abc"`, `""`, `"1e3"` – `422 INVALID_ANSWER` с текстом «Введите число,
  например 12 или 0,5».
- **Язык программы** (`language`): `python`, `cpp`, `java`, `javascript`, `kotlin`, `pascal`.
  Код до 50 000 символов. Перед отправкой в runner код сохраняется как черновик `code:<id>`, поэтому
  при сбое проверки он не теряется.
- **Звезда практики** (`practiceStar: true`) выдаётся, когда в теме верно решено 3 задания без
  просмотра решения. Задание, решённое после `reveal`, засчитывается как решённое
  (`solvedAfterReveal: true`), но в эти 3 задания для звезды не входит.
- `hint` и `reveal` отвечают `409 MOCK_IN_PROGRESS`, пока задание входит в идущий (не завершённый и
  не просроченный) пробник этого пользователя.
- `output` у `check` – вывод runner для программ, для остальных типов пустая строка. Текст ошибок
  runner и Judge0 клиенту не передаётся, только пишется в лог.

#### Пробники

| Действие | Доступ | Запрос | Ответ | Ошибки |
|---|---|---|---|---|
| `start-mock` | session | `{ id }` – id пробника | `{ attempt }` – новая попытка, задания без ответов | `MOCK_NOT_FOUND` 404 (нет пробника или в нём нет опубликованных заданий) |
| `mock-get` | session | `{ id }` – id попытки | `{ attempt }` – текущее состояние | `ATTEMPT_NOT_FOUND` 404 (в т. ч. чужая попытка) |
| `mock-save` | session, до 2 МБ | `{ id, answers }` | `{ ok: true }`; если попытка уже завершена или время вышло – `{ attempt }` с итогом (попытка завершается) | `ATTEMPT_NOT_FOUND` 404, `INVALID_ANSWERS` 422 |
| `finish-mock` | session, до 2 МБ | `{ id, answers? }` | `{ attempt }` – завершённая попытка с результатами; повторный вызов возвращает тот же итог | `ATTEMPT_NOT_FOUND` 404, `INVALID_ANSWERS` 422 |
| `mock-recheck` | session | `{ id }` | `{ attempt }` – перепроверены ответы со статусом `unchecked` | `ATTEMPT_NOT_FOUND` 404, `MOCK_NOT_FINISHED` 409 |
| `mock-proof` | session | `{ id, taskId, correct: boolean }` | `{ attempt }` – самопроверка доказательства после завершения | `ATTEMPT_NOT_FOUND` 404, `MOCK_NOT_FINISHED` 409, `TASK_NOT_FOUND` 404, `INVALID_SELF_CHECK` 422 |

Как устроена попытка (`lib/services/mocks.ts`):

- `answers` – объект `{ "<id задания попытки>": ответ }`. Ответ – строка до 2 000 символов или
  `{ code, language }`; `""` или `null` удаляет ответ. Присланные ключи **сливаются** с уже
  сохранёнными. В RPC ключ, которого нет в попытке, – `422 INVALID_ANSWERS`.
- Время: `ends = started + minutes × 60 000`. Ответы принимаются до `ends` плюс 5 секунд на задержку
  сети. Для пробника со `randomize: true` выбирается `taskCount` заданий (по умолчанию 10) в
  случайном порядке.
- Пока попытка идёт, задания отдаются без `answer`, `solution`, `hint`; после завершения – с ними.
  Скрытые `tests` не отдаются никогда.
- Итог: `results[]` с `{ id, correct, points, max, note, status }`, `score` (сумма баллов `correct`),
  `max`, `pending` (сколько `unchecked`), `finishedAt`. Статусы: `correct`, `wrong`, `unchecked`
  (runner был недоступен – баллов пока нет, можно вызвать `mock-recheck`), `self-check`
  (доказательство ждёт `mock-proof`).
- Проверка кода идёт вне транзакции: итог записывается, только если попытку никто не завершил
  раньше, поэтому двойное завершение безопасно.

#### Администратор

Все действия – уровень `admin`. Материал (`record`) проходит ту же проверку, что и при сборке
контента (`lib/content/validate.mjs`, правила – в [content/README.md](../content/README.md)); поля
`draft` и `unpublished` из запроса отбрасываются.

| Действие | Запрос | Ответ | Что делает | Ошибки |
|---|---|---|---|---|
| `draft` | `{ record }` | `{ ok: true, count: 1 }` | Черновик. У опубликованной записи меняется только `draft` – дети видят прежнюю версию. Новая или удалённая запись становится неопубликованной (`unpublished: true`) | `VALIDATION_ERROR` 400, `KIND_CONFLICT` 409, `DUPLICATE_OLYMPIAD` 409 |
| `publish` | `{ record }` | `{ ok: true, count: 1 }` | Публикует запись, прежняя версия уходит в `revisions`, черновик очищается | те же |
| `import` | `{ records: [...] }` (1–1500) | `{ ok: true, count }` | Публикует пачку атомарно: ошибка в одной записи – не записывается ничего | те же |
| `history` | `{ id }` | `{ history: [{ id, record_id, data, created }] }` | Версии записи, новые сверху | – |
| `restore` | `{ revisionId }` | `{ ok: true }` | Возвращает версию **как черновик**; удалённая запись возвращается неопубликованной, детям её не видно до публикации | `REVISION_NOT_FOUND` 404 |
| `delete` | `{ id }` | `{ ok: true }` | Мягкое удаление: запись пропадает из каталога и для детей, и в списке учителя, последняя версия сохранена в `revisions` | `RECORD_NOT_FOUND` 404 |
| `deleted` | `{}` | `{ deleted: [...] }` | Список удалённых записей | – |
| `upload` | `{ base64, type }` | `{ url: "/api/media/<uuid>", id, type, size }` | Загрузка файла в хранилище (R2), см. [MEDIA.md](MEDIA.md) | `UNSUPPORTED_FILE_TYPE` 415, `FILE_TOO_LARGE` 413, `INVALID_FILE` 422, `STORAGE_UNAVAILABLE` 503 |

- `VALIDATION_ERROR` – запись не проходит схему; урок или задание ссылается на несуществующую
  тему или на тему другого класса/предмета; пробник ссылается на несуществующее задание или на
  задание другого класса/предмета; id повторяется в пачке. Текст ошибки называет запись и причину.
- `KIND_CONFLICT` – id уже занят записью другого типа.
- `DUPLICATE_OLYMPIAD` – в календаре уже есть олимпиада с тем же названием, регионом и датой под
  другим id.
- `upload`: типы `image/png`, `image/jpeg`, `image/webp`, `application/pdf`, `video/mp4`, до 8 МБ;
  сигнатура файла сверяется с типом (HTML под видом PNG не пройдёт).

## 5. API для проверки `/api/v1`

Стабильный контракт для проверяющих: основной сценарий ребёнка (каталог → тема → урок → задача →
олимпиада → пробник → профиль) через REST. Использует те же сервисы, что и мини-приложение.
Полное описание схем – [`openapi.yaml`](../openapi.yaml).

### 5.1. Эндпоинты

| Метод и путь | Доступ | Тело запроса | Успех | Поля ответа | Ошибки |
|---|---|---|---|---|---|
| `GET /api/v1/health` | нет | – | 200 | `status: "ok"`, `database: "ok"`, `version` (из `package.json`) | 503 `{ status: "degraded", database: "unavailable", version }` |
| `POST /api/v1/auth/login` | нет | `{ username, password }` | 200 | `accessToken` (64 hex), `tokenType: "Bearer"`, `role: "test_user"`, `userId: "test:evaluator"` | 400, 401 `INVALID_CREDENTIALS`, 413, 415, 422 `INVALID_CREDENTIALS_FORMAT`, 429 `RATE_LIMITED`, 503 `TEST_ACCOUNT_NOT_CONFIGURED` |
| `GET /api/v1/content` | Bearer | – | 200 | `records[]` (как `records` в bootstrap для ребёнка, но олимпиады целиком, с `description`, `source`, `verifiedAt`, `image`), `count` | 401 |
| `GET /api/v1/topics/{id}` | Bearer | – | 200 | `topic`, `lessons[]` (целиком), `tasks[]` (без ответов, подсказок, разборов и тестов) | 401, 404 `TOPIC_NOT_FOUND` |
| `POST /api/v1/lessons/{id}/view` | Bearer | не нужно | 200 | `ok: true`, `lessonId`, `completed: true` | 401, 404 `LESSON_NOT_FOUND` |
| `POST /api/v1/tasks/{id}/check` | Bearer | `{ answer }` \| `{ correct }` \| `{ code, language }` | 200 | `taskId`, `correct`, `output`, `practiceStar`, `solvedAfterReveal?` | 400, 401, 404 `TASK_NOT_FOUND`, 413, 415, 422, 429 `RUNNER_BUSY`, 503 `RUNNER_UNAVAILABLE` |
| `POST /api/v1/olympiads/{id}/register` | Bearer | `{ registered: boolean }` | 200 | `ok: true`, `olympiadId`, `registered` | 400, 401, 404 `OLYMPIAD_NOT_FOUND`, 413, 415, 422 `INVALID_REGISTERED` |
| `POST /api/v1/mocks/{id}/start` | Bearer | не нужно | **201** | `attempt` (идущая попытка) | 401, 404 `MOCK_NOT_FOUND` |
| `PATCH /api/v1/mock-attempts/{id}` | Bearer | `{ answers }` | 200 | `ok: true`, `attemptId`, `saved: true` | 400, 401, 404 `ATTEMPT_NOT_FOUND`, 409 `ATTEMPT_FINISHED` / `ATTEMPT_TIME_EXPIRED`, 413, 415, 422 `INVALID_ANSWERS` |
| `POST /api/v1/mock-attempts/{id}/finish` | Bearer | необязательно: `{ answers }` | 200 | `attempt` (завершённая: `results`, `score`, `max`, `pending`, `finishedAt`) | 400, 401, 404 `ATTEMPT_NOT_FOUND`, 413, 415, 422 |
| `GET /api/v1/profile` | Bearer | – | 200 | `user: { id: "test:evaluator", role: "test_user" }`, `progress` (ключ → значение), `updatedAt` (мс последнего изменения или `null`) | 401 |
| `POST /api/v1/test/reset` | Bearer | не нужно | 200 | `ok: true`, `userId: "test:evaluator"`, `reset: true` | 401 |

Любой эндпоинт может ответить `500 INTERNAL_ERROR` (общий текст, детали только в логе) и `503`
(`DATABASE_UNAVAILABLE`, `TEST_ACCOUNT_NOT_CONFIGURED`). Защищённые эндпоинты без токена или с
чужим токеном отвечают `401 UNAUTHORIZED`.

Отличия от RPC:

- `mocks/{id}/start` отвечает `201`, а не `200`;
- ответы пробника принимаются «мягко» (`lenient`): ключи заданий, которых нет в попытке,
  игнорируются, число принимается как текстовый ответ. Так фиксированная карта ответов из
  `DATA-API.yaml` не ломается, если набор заданий пробника изменится;
- `PATCH` завершённой попытки – `409 ATTEMPT_FINISHED`, после окончания времени – `409
  ATTEMPT_TIME_EXPIRED` (RPC в этих случаях сам завершает попытку и возвращает итог);
- `finish` можно вызвать без тела.

### 5.2. Сценарий проверки через `curl`

Команды ниже выполнены 29.09.2026 на локальном стеке (`http://localhost:3000`, база с
календарём 2026/27); ответы сокращены. Для production замените `BASE`. Пароль берётся из
переменной окружения и в команды не вписывается.

```bash
BASE=http://localhost:3000          # или https://olympus-edu.ru
export TEST_API_PASSWORD=olympus-local-test   # локально; для production – пароль, выданный отдельно

curl -s "$BASE/api/v1/health"
# {"status":"ok","database":"ok","version":"1.0.0"}

TOKEN=$(curl -s -X POST "$BASE/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"test_user\",\"password\":\"$TEST_API_PASSWORD\"}" \
  | sed -E 's/.*"accessToken":"([0-9a-f]+)".*/\1/')
AUTH="Authorization: Bearer $TOKEN"
# ответ login: {"accessToken":"<64 hex>","tokenType":"Bearer","role":"test_user","userId":"test:evaluator"}

curl -s -X POST "$BASE/api/v1/test/reset" -H "$AUTH"
# {"ok":true,"userId":"test:evaluator","reset":true}

curl -s "$BASE/api/v1/content" -H "$AUTH"
# {"records":[{"id":"arhimed-winter-math-2027","title":"Зимний Турнир Архимеда","subject":"math",…}, …],"count":1305}

curl -s "$BASE/api/v1/topics/math-4-01" -H "$AUTH"
# {"topic":{"id":"math-4-01","title":"Чётность и нечётность","grade":4,"subject":"math",…},
#  "lessons":[…5 уроков…],"tasks":[{"id":"math-4-01-task-1","title":"Булочка за десять монет",
#  "type":"number","prompt":"…","points":1,…}, …]}      ← без answer/solution/hint

curl -s -X POST "$BASE/api/v1/lessons/math-4-01-lesson-1/view" -H "$AUTH"
# {"ok":true,"lessonId":"math-4-01-lesson-1","completed":true}

curl -s -X POST "$BASE/api/v1/tasks/math-4-01-task-1/check" -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{"answer":"26"}'
# {"taskId":"math-4-01-task-1","correct":true,"output":"","practiceStar":false}
# с {"answer":"3"}:   {"taskId":"math-4-01-task-1","correct":false,"output":"","practiceStar":false}
# с {"answer":"abc"}: 422 {"error":{"code":"INVALID_ANSWER","message":"Введите число, например 12 или 0,5"}}

curl -s -X POST "$BASE/api/v1/olympiads/moscow-math-festival-2027/register" -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{"registered":true}'
# {"ok":true,"olympiadId":"moscow-math-festival-2027","registered":true}

ATTEMPT=$(curl -s -X POST "$BASE/api/v1/mocks/mock-4-math/start" -H "$AUTH" \
  | sed -E 's/^\{"attempt":\{"id":"([^"]+)".*/\1/')
# 201 {"attempt":{"id":"<uuid>","testId":"mock-4-math","title":"Пробный тур по математике · 4 класс",
#      "subject":"math","started":…,"ends":…(+60 мин),"tasks":[…10 заданий…],"answers":{},"finished":false}}

curl -s -X PATCH "$BASE/api/v1/mock-attempts/$ATTEMPT" -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{"answers":{"math-4-01-task-2":"25"}}'
# {"ok":true,"attemptId":"<uuid>","saved":true}

curl -s -X POST "$BASE/api/v1/mock-attempts/$ATTEMPT/finish" -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{"answers":{"math-4-03-task-2":"1"}}'
# {"attempt":{…,"finished":true,"finishedAt":…,"results":[{"id":"math-4-01-task-2","correct":true,
#  "points":1,"max":1,"note":"","status":"correct"},…],"score":2,"max":17,"pending":0,
#  "tasks":[…теперь с answer, solution, hint…]}}

curl -s "$BASE/api/v1/profile" -H "$AUTH"
# {"user":{"id":"test:evaluator","role":"test_user"},"progress":{"lesson:math-4-01-lesson-1":{"read":true},
#  "task:math-4-01-task-1":{"correct":true,"lastCorrect":true,"attempts":1,…},
#  "registration:moscow-math-festival-2027":{"registered":true},"attempt:<uuid>":{…}},"updatedAt":…}

curl -s -X POST "$BASE/api/v1/test/reset" -H "$AUTH"
# {"ok":true,"userId":"test:evaluator","reset":true}  → progress снова {}, updatedAt null
```

Примеры ошибок, полученные тем же способом:

| Запрос | Ответ |
|---|---|
| `GET /api/v1/profile` без токена | `401 {"error":{"code":"UNAUTHORIZED","message":"Нужен Bearer-токен тестовой учётной записи"}}` |
| `GET /api/v1/profile` с `Bearer abc` | `401 {"error":{"code":"UNAUTHORIZED","message":"Неверный токен тестовой учётной записи"}}` |
| `GET /api/v1/topics/nope` | `404 {"error":{"code":"TOPIC_NOT_FOUND","message":"Тема не найдена"}}` |
| `POST .../check` без `Content-Type: application/json` | `415 {"error":{"code":"UNSUPPORTED_MEDIA_TYPE","message":"Используйте Content-Type: application/json"}}` |
| `POST .../check` с телом `{"answer":` | `400 {"error":{"code":"INVALID_JSON","message":"Некорректный JSON в теле запроса"}}` |
| `POST .../register` с `{"registered":"yes"}` | `422 {"error":{"code":"INVALID_REGISTERED","message":"registered должен быть boolean"}}` |
| `PATCH` завершённой попытки | `409 {"error":{"code":"ATTEMPT_FINISHED","message":"Пробник уже завершён"}}` |
| `PATCH` с `{"answers":[1]}` | `422 {"error":{"code":"INVALID_ANSWERS","message":"answers должен быть объектом { taskId: ответ }"}}` |
| `POST /api/v1/mock-attempts/<чужой или несуществующий id>/finish` | `404 {"error":{"code":"ATTEMPT_NOT_FOUND","message":"Попытка не найдена"}}` |

## 6. Файлы `GET /api/media/{id}`

Отдаёт файлы, которые учитель загрузил действием `upload` (ссылка `/api/media/<uuid>` вставляется в
блок урока). Аутентификация не нужна (`lib/services/media.ts`).

- `id` – `^[a-f0-9-]{20,64}$` (без учёта регистра); иначе `404`.
- `200` – файл с его `Content-Type`, `Content-Length`, `ETag`, `Content-Disposition: inline`,
  `Cache-Control: public, max-age=31536000, immutable`, `Accept-Ranges: bytes`,
  `X-Content-Type-Options: nosniff`.
- `Range: bytes=start-end`, `bytes=start-` или `bytes=-N` (один диапазон) – `206` с
  `Content-Range`; невыполнимый диапазон – `416` с `Content-Range: bytes */<размер>`. Это нужно для
  перемотки видео.
- `404` «Не найдено» и `503` «Хранилище файлов недоступно» – `text/plain`.

## 7. Ошибки

### 7.1. Формат

Любая ожидаемая ошибка – это `ApiError` (`lib/server/errors.ts`) со статусом, стабильным кодом и
русским текстом, который можно показать ребёнку как есть.

| API | Тело ошибки | Пример |
|---|---|---|
| RPC `/api/olympus` | `{ "error": "<текст>", "code": "<КОД>" }` | `{"error":"Неизвестное действие","code":"UNKNOWN_ACTION"}` |
| `/api/v1` | `{ "error": { "code": "<КОД>", "message": "<текст>" } }` | `{"error":{"code":"TASK_NOT_FOUND","message":"Задание не найдено"}}` |
| `/api/media` | текст `text/plain` | `Не найдено` |

Любое другое исключение считается ошибкой в коде: подробности (стек, SQL) пишутся только в лог,
клиент получает `500` с общим текстом «Что-то пошло не так. Попробуйте ещё раз чуть позже» и кодом
`SERVER_ERROR` (в `/api/v1` – `INTERNAL_ERROR`). Обрыв связи с PostgreSQL превращается в `503
DATABASE_UNAVAILABLE`. У `429` есть заголовок `Retry-After` (секунды).

### 7.2. Коды по статусам

Коды общие для обоих API (кроме `500`). Колонка «Где» – какой интерфейс может их вернуть.

| Статус | Код | Когда | Где |
|---|---|---|---|
| 400 | `INVALID_JSON` | нет тела, некорректный JSON; в `/api/v1` – тело не объект | оба |
| 400 | `INVALID_REQUEST` | тело RPC не объект; `admin-login` без пароля строкой | RPC |
| 400 | `INVALID_ID` | `id` не передан или не подходит под шаблон | RPC |
| 400 | `UNKNOWN_ACTION` | нет такого `action` | RPC |
| 400 | `VALIDATION_ERROR` | материал не проходит проверку при `draft`/`publish`/`import` | RPC |
| 400 | `NOT_CODE_TASK` | `run`/`code-draft` для задания не по программированию | RPC |
| 400 / 401 | `MAX_AUTH_FAILED` | `initData` испорчены (400), подпись неверна или данные старше часа (401) | RPC |
| 401 | `SESSION_EXPIRED` | нет сессии или она истекла | RPC |
| 401 | `UNAUTHORIZED` | нет Bearer-токена `test_user` или он неверный | v1 |
| 401 | `INVALID_CREDENTIALS` | неверный логин или пароль `test_user` | v1 |
| 403 | `BAD_ORIGIN` | POST без `Authorization` с чужого `Origin` (кроме `session` с непустым `initData` MAX) | RPC |
| 403 | `ADMIN_REQUIRED` | действие администратора без входа учителя | RPC |
| 403 | `ADMIN_EXPIRED` | права учителя сняты после 60 минут без действий | RPC |
| 403 | `WRONG_PASSWORD` | неверный пароль администратора | RPC |
| 404 | `TOPIC_NOT_FOUND`, `LESSON_NOT_FOUND`, `TASK_NOT_FOUND`, `OLYMPIAD_NOT_FOUND`, `MOCK_NOT_FOUND` | записи нет, она удалена, это черновик (для не-администратора) или запись другого типа | оба |
| 404 | `ATTEMPT_NOT_FOUND` | попытки нет или она чужая | оба |
| 404 | `RECORD_NOT_FOUND`, `REVISION_NOT_FOUND` | `delete` / `restore` по несуществующему id | RPC |
| 405 | `METHOD_NOT_ALLOWED` | метод не `GET`/`POST` | RPC |
| 409 | `MOCK_IN_PROGRESS` | `hint`/`reveal` для задания из идущего пробника | RPC |
| 409 | `MOCK_NOT_FINISHED` | `mock-recheck`/`mock-proof` до завершения | RPC |
| 409 | `ATTEMPT_FINISHED`, `ATTEMPT_TIME_EXPIRED` | сохранение в завершённую или просроченную попытку | v1 |
| 409 | `TOPIC_HAS_NO_LESSONS`, `LESSONS_NOT_READ` | звезда теории, когда уроков нет или открыты не все | RPC |
| 409 | `DUPLICATE_OLYMPIAD`, `KIND_CONFLICT` | дубль олимпиады; id занят записью другого типа | RPC |
| 413 | `PAYLOAD_TOO_LARGE` | тело больше лимита ([§2](#размер-тела-запроса)) | оба |
| 413 | `FILE_TOO_LARGE` | файл `upload` больше 8 МБ | RPC |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | тело не `application/json` | оба |
| 415 | `UNSUPPORTED_FILE_TYPE` | тип файла `upload` не из списка | RPC |
| 422 | `INVALID_ANSWER` | числовой ответ – не число | оба |
| 422 | `INVALID_SELF_CHECK` | `correct` не boolean | оба |
| 422 | `INVALID_CODE`, `INVALID_LANGUAGE` | код не строка или длиннее 50 000 символов (или runner отклонил его как слишком большой); язык не из списка | оба |
| 422 | `INVALID_INPUT` | `input` у `run` не строка или длиннее 100 000 символов | RPC |
| 422 | `INVALID_ANSWERS` | `answers` пробника не объект, ответ слишком длинный или не того вида; в RPC – ещё и задание не из попытки | оба |
| 422 | `INVALID_REGISTERED` | `yes`/`registered` не boolean | оба |
| 422 | `INVALID_SETTINGS` | недопустимые регион, класс или предмет | RPC |
| 422 | `INVALID_FILE` | base64 испорчен или файл не совпадает с заявленным типом | RPC |
| 422 | `INVALID_CREDENTIALS_FORMAT` | `username`/`password` не строки | v1 |
| 429 | `RATE_LIMITED` | слишком много неудачных входов | оба |
| 429 | `RUNNER_BUSY` | runner занят (все слоты проверки заняты) | оба |
| 500 | `SERVER_ERROR` / `INTERNAL_ERROR` | непредвиденная ошибка | RPC / v1 |
| 503 | `DATABASE_UNAVAILABLE` | PostgreSQL недоступна | оба |
| 503 | `DATABASE_NOT_CONFIGURED` | не заданы `DATABASE_URL` или `DB_HOST`/`DB_USER`/`DB_NAME` | оба |
| 503 | `RUNNER_UNAVAILABLE` | не задан `RUNNER_URL`, runner или Judge0 не отвечает | оба |
| 503 | `MAX_NOT_CONFIGURED` | вход через MAX без `BOT_TOKEN` на сервере | RPC |
| 503 | `ADMIN_NOT_CONFIGURED` | вход учителя без `ADMIN_PASSWORD` | RPC |
| 503 | `STORAGE_UNAVAILABLE` | нет хранилища файлов (R2) для `upload` | RPC |
| 503 | `TEST_ACCOUNT_NOT_CONFIGURED` | не задан `TEST_API_PASSWORD` | v1 |

Клиент мини-приложения (`lib/client/api.ts`, `lib/client/errors.ts`) превращает коды в понятные
ребёнку сообщения и кнопки («Повторить», «Открыть заново»). Сетевые сбои без ответа сервера клиент
помечает кодами `NETWORK`, `OFFLINE`, `TIMEOUT` (ожидание по умолчанию – 20 секунд); сервер таких
кодов не отдаёт.

## 8. Лимиты

### 8.1. Вход по паролю

Один лимитер на все входы по паролю – `admin-login` и `POST /api/v1/auth/login`
(`lib/server/rate-limit.ts`):

- **10 неудачных попыток за 15 минут** с одного адреса блокируют вход с этого адреса на
  **15 минут** (`429 RATE_LIMITED`, `Retry-After`). Успешный вход обнуляет счётчик.
- Адрес берётся **только из `X-Real-IP`**. В production его выставляет Caddy (адрес TCP-клиента) и
  удаляет присланные клиентом `X-Forwarded-For`, `Cf-Connecting-Ip`, `True-Client-Ip`. Без Caddy
  (локальный Docker) `X-Real-IP` задаёт сам клиент, а без заголовка все запросы попадают в один
  общий счётчик `unknown`. Поэтому в production приложение должно работать только за прокси.
- Счётчики хранятся в памяти процесса `web` (до 10 000 адресов) и обнуляются при перезапуске. Для
  нескольких экземпляров `web` понадобилось бы общее хранилище.

Других ограничений частоты запросов в приложении нет.

### 8.2. Размеры ввода (`INPUT_LIMITS`)

| Что | Максимум |
|---|---|
| Код программы (`check`, `run`, `code-draft`, ответы пробника) | 50 000 символов |
| Текстовый ответ в пробнике | 2 000 символов |
| `input` практического запуска (`run`) | 100 000 символов |
| `initData` MAX | 8 192 символа |
| Пароль | 512 символов: в `admin-login` длиннее – `400 INVALID_REQUEST`, в `/api/v1/auth/login` лишнее обрезается |
| Логин `test_user` | 128 символов (длиннее – обрезается) |
| Пачка `import` | 1–1500 записей |
| Файл `upload` | 8 МБ |

### 8.3. Проверка программ

- `web` ждёт ответа runner до 55 секунд; сам runner принимает не больше `RUNNER_MAX_CONCURRENT`
  (по умолчанию 4) запросов одновременно, лишние получают `429` → клиенту `429 RUNNER_BUSY` с
  `Retry-After` (runner присылает 2 секунды).
- Лимиты runner (`runner/server.mjs`): код до 50 000 символов, 1–20 тестов на запуск, текст теста до
  100 000 символов, тело запроса – `RUNNER_REQUEST_LIMIT` (по умолчанию 1 000 000 байт). Лимиты
  одного запуска в Judge0 – в [JUDGE0.md](JUDGE0.md).
- Если runner ответил `413`/`422`, клиенту уходит `422 INVALID_CODE`; любой другой сбой – `503
  RUNNER_UNAVAILABLE` с текстом «Проверка программ сейчас не работает. Твой код сохранён –
  попробуй позже.» В пробнике такой ответ получает статус `unchecked`, а не «неверно».

### 8.4. Прочие тайм-ауты

Подключение к PostgreSQL – 5 секунд, одно подключение на запрос (`lib/server/db.ts`). Клиент
мини-приложения прерывает запрос через 20 секунд.

## 9. Автоматическая проверка: `pnpm test:api`

`scripts/api-smoke.mjs` проходит сценарий `DATA-API.yaml` против запущенного стека и падает на
первом расхождении (код выхода 1; без пароля – код 2).

```bash
docker compose up -d --build                 # или любой другой запущенный стек
API_BASE_URL=http://localhost:3000 TEST_API_PASSWORD='…' pnpm test:api
```

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `API_BASE_URL` | `http://localhost:3000` | корень сайта |
| `TEST_API_USERNAME` | `test_user` | логин тестовой учётной записи |
| `TEST_API_PASSWORD` | – (обязательно) | пароль тестовой учётной записи |
| `API_WAIT_MS` | `60000` | сколько ждать, пока `health` станет `200` |
| `API_TEST_OLYMPIAD_ID` | – | проверить регистрацию на этой олимпиаде (она должна быть опубликована, иначе ошибка) |

Каждый запрос ждёт ответа до 5 секунд и должен вернуть `Content-Type: application/json`. Id
берутся из [`test-data.json`](../test-data.json); если такая запись не опубликована (например, после
обновления календаря), скрипт берёт первую опубликованную запись того же типа и пишет об этом
строкой `note:`.

| Шаг | Что проверяет |
|---|---|
| 1 `health` | `200`, поля `status`, `database`, `version`, `status = "ok"` |
| 2 `login` | `200`, поля `accessToken`, `tokenType`, `role`, `userId` |
| 3 authorization is enforced | `GET /profile` без токена – `401` с `error.code` |
| 4 `reset` | `200`, поля `ok`, `userId`, `reset` |
| 5 `content` | `records` – массив, `count` равен его длине и больше нуля |
| 6 topic `math-4-01` | есть уроки и задания; ни у одного задания нет `answer` и `tests` |
| 7 lesson progress `math-4-01-lesson-1` | `ok`, `lessonId`, `completed` |
| 8 task check `math-4-01-task-1` | ответ `26` из `test-data.json` засчитан (`correct: true`) именно для этого задания |
| 9 olympiad registration `moscow-math-festival-2027` | `ok`, `olympiadId`, `registered` |
| 10 mock start/save `mock-4-math` | `201`, есть `attempt.id`; `PATCH` с ответами из `test-data.json` – `saved` |
| 11 mock finish | `attempt.finished = true`, в заданиях нет `tests`; если `test-data.json` отвечает на все задания попытки – `pending = 0` и `score = max` (полный балл, у `mock-4-math` – 17 из 17) |
| 12 profile | в `progress` есть `lesson:<id>` и `registration:<id>` |
| 13 repeatability and cleanup | повторный просмотр урока проходит, после `reset` прогресс пуст |

Результат на локальном стеке 29.09.2026: все 13 шагов, `Olympus API smoke test: OK`.

В CI тот же скрипт запускается после `docker compose up` (job `docker-e2e`,
[TESTING.md](TESTING.md)). Кроме того, `tests/integration/api-v1.test.ts` вызывает обработчики на
настоящей PostgreSQL, проходит сценарий дважды подряд и сверяет контракт: каждый статус, который
встретился в тестах `/api/v1`, должен быть описан в `openapi.yaml`, а у каждой операции из
`openapi.yaml` должен быть обработчик.

## 10. `DATA-API.yaml`

Машиночитаемый сценарий для проверяющей платформы (`schemaVersion: "1.0"`):

- `solution` – `name: "Олимпус"`, `teamId`;
- `api` – `baseUrl` (корень сайта), ссылка на `openapi.yaml`, `defaultHeaders: { Accept: application/json }`;
- `checks[]` – 12 проверок по порядку (вместе с шагом очистки – 13): `health`, `login-test-user`, `reset-test-user`,
  `list-content`, `read-topic`, `view-lesson`, `check-task`, `register-olympiad`, `start-mock`,
  `save-mock`, `finish-mock`, `profile`. У каждой: `method`, `path` (с `{id}`), `role` (`public` или
  `test_user`), `dependsOn`, `request` (`headers`, `path`, `body`), `expected` (`statusCodes`,
  `contentType`, `requiredFields`, иногда `bodySchema`), `timeoutMs: 5000`, `repeatable`, `extract`
  (`accessToken` из `login`, `attemptId` из `start-mock`);
- `cleanup[]` – `POST /api/v1/test/reset` после проверки.

Подстановки: `${TEST_API_USERNAME}` и `${TEST_API_PASSWORD}` – учётные данные, которые проверяющие
получают отдельно; `${accessToken}`, `${attemptId}` – значения из `extract`.

Значения сценария – записи настоящего контента и календаря, те же, что в `test-data.json`:
тема `math-4-01`, урок `math-4-01-lesson-1`, задание `math-4-01-task-1` с ответом `"26"`,
олимпиада `moscow-math-festival-2027`, пробник `mock-4-math` (в `save-mock` – два ответа, в
`finish-mock` – правильные ответы на все 10 заданий, полный балл 17 из 17). Контент
переписывается, поэтому совпадение проверяется автоматически:

- `tests/unit/contracts/data-api.test.ts` – каждый id из `DATA-API.yaml` есть в `lib/seed.json`
  нужного типа и опубликован, ответы равны ответам контента, ответы `finish-mock` покрывают все
  задания пробника, `DATA-API.yaml` совпадает с `test-data.json`, проверки покрывают все операции
  `/api/v1` из `openapi.yaml`, а ожидаемые коды там описаны;
- `tests/integration/api-v1.test.ts` – проверки `DATA-API.yaml` выполняются по порядку дважды
  против обработчиков на настоящей PostgreSQL;
- `tests/integration/api-smoke.test.ts` – `scripts/api-smoke.mjs` проходит по HTTP.

После изменения контента: `pnpm compile-content`, затем обновить ответы в `test-data.json` и
`DATA-API.yaml` – эти тесты покажут, что разошлось.

Перед сдачей осталось заполнить только идентификатор команды:

| Где | Поле | Сейчас | Нужно |
|---|---|---|---|
| `DATA-API.yaml` | `solution.teamId` | `REPLACE_WITH_TEAM_ID` | идентификатор команды |

## 11. Известные расхождения и ограничения

- `openapi.yaml`, ответ `PayloadTooLarge`: написано «больше 256 КБ», но `PATCH /mock-attempts/{id}`
  и `POST .../finish` принимают до 2 МБ.
- `openapi.yaml` задаёт `maxLength` 128/512 для `username`/`password`, а сервер не отклоняет более
  длинные значения, а обрезает их.
- Неподдерживаемый метод на `/api/v1/*` (например, `GET /api/v1/auth/login`) отвечает `405` с пустым
  телом, а неизвестный путь `/api/v1/...` – HTML-страницей `404`: эти ответы формирует фреймворк, а
  не обработчики API, поэтому они не в формате `{ error }`. В `openapi.yaml` они не описаны.
- `features.runner` в bootstrap показывает только, что задан `RUNNER_URL`; доступность Judge0 он не
  проверяет.
- В контенте сейчас нет заданий типа `proof`: самопроверка (`check` с `correct`, `mock-proof`)
  поддержана API и покрыта тестами, но в интерфейсе с реальными данными не встречается.
- Лимитер входа хранится в памяти одного процесса ([§8.1](#81-вход-по-паролю)).
