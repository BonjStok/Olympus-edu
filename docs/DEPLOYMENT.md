# Развёртывание и эксплуатация

Как поднять «Олимпус» на своём сервере с HTTPS, как работает автоматический деплой из GitHub,
как обновлять контент и календарь в работающей базе, делать резервные копии и восстанавливаться.
Локальный запуск – в [../README.md](../README.md) и [DEVELOPMENT.md](DEVELOPMENT.md).

## 1. Что нужно

- Linux-сервер (VPS) с Docker Engine и Docker Compose v2. Файлы Compose используют
  `env_file.required` и `healthcheck.start_interval`, поэтому нужны Docker Compose ≥ 2.24 и Docker
  Engine ≥ 25. Ориентир по ресурсам для «Олимпуса» без Judge0: 2 vCPU, 4 ГБ RAM, 20–30 ГБ диска.
- Домен с A/AAAA-записью на сервер и открытые наружу порты `80` и `443` (TCP; `443/udp` – для
  HTTP/3, необязательно). Сертификат Let's Encrypt Caddy получает сам.
- Токен чат-бота MAX (`BOT_TOKEN`). MAX открывает мини-приложение
  и доставляет webhook только по HTTPS.
- Для проверки программ – доступный с сервера Judge0 CE ([JUDGE0.md](JUDGE0.md)). Без него всё,
  кроме проверки кода, работает.
- Для автоматического деплоя – git-клон репозитория на сервере, из которого `git fetch origin`
  работает без пароля (публичный репозиторий или deploy key), и пользователь, которому разрешён
  `docker`.

## 2. Что запускает `compose.production.yaml`

| Сервис | Наружу | Назначение |
|---|---|---|
| `caddy` | `80`, `443`, `443/udp` | HTTPS для `OLYMPUS_DOMAIN`, заголовки безопасности, `/max/webhook*` → `bot:8090`, остальное → `web:3000` |
| `web` | нет | приложение и API; `OLYMPUS_ENV=production` задан в compose-файле |
| `postgres` | нет | PostgreSQL 17, volume `olympus-production_postgres_data` |
| `runner` | нет | адаптер к Judge0 (`RUNNER_URL=http://runner:8080` задан для `web`) |
| `bot` | нет | чат-бот, режим `webhook` по умолчанию |
| `backup`, `restore`, `media-backup` | нет | утилиты с профилем `tools`, запускаются вручную |

Порты PostgreSQL, web, runner и бота наружу не публикуются.

## 3. Переменные `.env` для production

Скопируйте `.env.example` в `.env` рядом с `compose.production.yaml`. Файл `.env` не коммитится.
Старт `web` (`scripts/docker-start.mjs`) и бота проверяет значения и останавливается с понятной
ошибкой, если чего-то не хватает.

| Переменная | Требование в production |
|---|---|
| `OLYMPUS_DOMAIN` | домен без `https://`, например `olympus-edu.ru`; нужен Caddy и адресу webhook |
| `POSTGRES_PASSWORD` | ≥ 16 символов и не `olympus_local_dev`. Задайте **до первого запуска**: после создания volume смена значения в `.env` не меняет пароль уже созданной роли |
| `ADMIN_PASSWORD` | ≥ 12 символов – вход в режим учителя; локальный `olympus-local-admin` из `.env.example` в production запрещён |
| `TEST_API_PASSWORD` | ≥ 12 символов – учётная запись `test_user` для проверяющих API (`TEST_API_USERNAME`, по умолчанию `test_user`); локальный `olympus-local-test` в production запрещён |
| `BOT_TOKEN` | обязателен – проверка входа через MAX и работа бота |
| `RUNNER_TOKEN` | обязателен (в production `RUNNER_URL` всегда задан): длинная случайная строка, общая для `web` и `runner` |
| `BOT_WEBHOOK_SECRET` | обязателен для режима webhook: 5–256 символов `A-Z a-z 0-9 _ -`. Без него бот отвечает `/health` кодом 503 и деплой откатывается |
| `MAX_BOT_NAME` | публичное имя бота (у проекта – `t605_hakaton_max_bot`) – для кнопок «Открыть в MAX» и ссылок «Поделиться» в приложении и кнопок бота |
| `JUDGE0_URL`, `JUDGE0_AUTH_TOKEN` | адрес Judge0 и, если нужен, его токен |
| `SEED_MODE` | оставьте `bootstrap` |
| `BOT_REMINDERS` | оставьте `off` до согласования рассылок с MAX ([BOT.md](BOT.md#6-напоминания-и-правила-max)) |

Полная таблица переменных – в [../README.md](../README.md#6-переменные-окружения).
Сгенерировать секрет: `openssl rand -hex 24` (48 символов `0-9a-f` подходят и для `BOT_WEBHOOK_SECRET`).

## 4. Первый запуск вручную

```bash
git clone <URL репозитория> /opt/olympus
cd /opt/olympus
cp .env.example .env
nano .env                                  # заполнить значения из раздела 3
docker compose -f compose.production.yaml up -d --build
docker compose -f compose.production.yaml ps
curl -fsS https://<домен>/api/v1/health    # {"status":"ok","database":"ok","version":"1.0.0"}
```

При старте `web` применяет миграции `drizzle/*.sql` и на пустой базе загружает весь контент
(`SEED_MODE=bootstrap`). Бот сам оформляет webhook-подписку на `https://<домен>/max/webhook`.

После запуска в кабинете business.max.ru → Чат-боты → ⋮ → Настройки укажите URL мини-приложения
`https://<домен>` – он должен совпадать с адресом, иначе кнопка «Открыть» не заработает. Проверка
токена и имени бота: `docker compose -f compose.production.yaml exec bot node bot/scripts/smoke.mjs`
(подробности – [BOT.md](BOT.md#3-подключение-к-max)).

## 5. Автоматический деплой из GitHub (CD)

```text
push в main ─► CI (.github/workflows/ci.yml)
               quality · integration · docker-e2e · workflows ─► publish: образы в GHCR
                   ghcr.io/<владелец>/olympus-edu-web:<sha>, olympus-edu-runner:<sha> (+ :latest)
          ─► Deploy (.github/workflows/deploy.yml), только после успешного CI на push в main
               ssh на сервер → docker login ghcr.io (временный токен запуска)
               → scripts/deploy/remote-deploy.sh <DEPLOY_PATH> <sha> <префикс образов>
               → проверка https://<PUBLIC_URL>/api/v1/health (30 попыток по 5 с)
```

Деплой можно запустить и вручную: Actions → Deploy → Run workflow, поле `sha` – коммит `main`
(пусто – коммит запуска). Одновременно идёт не больше одного деплоя (`concurrency: deploy-production`).

### Секреты и переменные репозитория

Settings → Secrets and variables → Actions (окружение `production`):

| Имя | Тип | Значение |
|---|---|---|
| `DEPLOY_HOST` | secret | адрес сервера |
| `DEPLOY_USER` | secret | пользователь SSH с правом запускать `docker` |
| `DEPLOY_SSH_KEY` | secret | приватный ключ SSH (весь текст, включая строки BEGIN/END) |
| `DEPLOY_KNOWN_HOSTS` | secret | строка(и) `known_hosts` сервера: `ssh-keyscan -p <порт> <хост>`; проверка ключа хоста строгая |
| `DEPLOY_PATH` | secret | каталог git-клона на сервере, например `/opt/olympus` |
| `DEPLOY_PORT` | variable | порт SSH, по умолчанию `22` |
| `PUBLIC_URL` | variable | адрес для итоговой проверки, по умолчанию `https://olympus-edu.ru` |

Если хотя бы одного секрета нет, задание деплоя не падает, а пропускается с предупреждением
«Deploy skipped: missing secrets …».

### Что делает `scripts/deploy/remote-deploy.sh` на сервере

1. Отказывается работать, если на сервере правили отслеживаемые файлы (`git diff` не пуст) – их
   нужно закоммитить в репозиторий или откатить. `.env` и `backups/` не отслеживаются.
2. Запоминает текущий коммит и тег образов (`.deploy/current-tag`).
3. Делает резервную копию PostgreSQL (`--profile tools run --rm backup` → `backups/*.dump`).
4. `git fetch` и `git checkout --detach <sha>` – compose-файлы, `Caddyfile`, миграции этого релиза.
5. `docker compose pull web runner` образов `<префикс>-web:<sha>` и `<префикс>-runner:<sha>`
   (бот использует образ `web`).
6. `up -d --no-build --remove-orphans --wait --wait-timeout 240` – ждёт, пока все сервисы станут
   healthy.
7. Успех: записывает тег в `.deploy/current-tag`, выходит из GHCR, удаляет образы старше 14 дней.
8. Неудача: печатает последние 200 строк лога `web`, возвращает предыдущий коммит и его образы
   (или собирает их на сервере, если прошлый релиз был собран там же) и завершается с ошибкой.
   База при откате не восстанавливается: миграции только добавляют, а свежий дамп лежит в
   `backups/`.

Healthcheck есть у `postgres`, `web`, `runner` и `bot`, поэтому откат сработает, если:
`web` не прошёл проверку переменных; бот в состоянии `error` (неверный токен, нет
`BOT_WEBHOOK_SECRET`); задан `JUDGE0_URL`, но Judge0 не отвечает (runner отдаёт `503` на
`/health`). Без `JUDGE0_URL` runner считается здоровым.

## 6. Обновление вручную (без CI)

```bash
cd /opt/olympus
docker compose -f compose.production.yaml --profile tools run --rm backup
git pull
docker compose -f compose.production.yaml up -d --build
```

Новые миграции применятся при старте `web`. `SEED_MODE=bootstrap` не перезаписывает контент в
непустой базе, поэтому правки учителей сохраняются, а новый контент из репозитория переносится
отдельно (раздел 7).

## 7. Обновление контента и календаря в работающей базе

`SEED_MODE=bootstrap` загружает контент только в пустую базу. Новый календарь или переписанные
уроки и задания переносятся в работающую базу скриптом `scripts/sync-content.mjs`. Он есть в образе
`web` вместе с `lib/seed.json` того релиза, который запущен, поэтому сначала выкатите релиз с новым
контентом (раздел 5 или 6), а затем:

```bash
cd /opt/olympus
F=compose.production.yaml

# 0. Резервная копия
docker compose -f $F --profile tools run --rm backup

# 1. Пробный прогон: ничего не пишет, печатает план по типам записей
docker compose -f $F exec -T web node scripts/sync-content.mjs \
  --deletions - < scripts/data/olympiad-deletions-2026-09-29.json

# 2. Изучить план (при необходимости --verbose, чтобы увидеть все id), затем записать
docker compose -f $F exec -T web node scripts/sync-content.mjs \
  --deletions - --apply < scripts/data/olympiad-deletions-2026-09-29.json
```

Параметры (`node scripts/sync-content.mjs --help`):

| Параметр | Смысл |
|---|---|
| `--apply` | записать изменения одной транзакцией; без него – только отчёт |
| `--kinds a,b` | какие типы синхронизировать: `olympiads`, `topics`, `lessons`, `tasks`, `mock-tests` (по умолчанию все) |
| `--deletions <файл\|->` | id для мягкого удаления: `["id", …]`, `[{ "id", "reason" }, …]` или `{ "ids": [...] }`; `-` – читать из stdin |
| `--seed <файл>` | другой бандл вместо `lib/seed.json` |
| `--restore-deleted` | вернуть записи, которые учитель удалил в базе |
| `--verbose`, `--json` | все id в отчёте; отчёт в JSON |

Что гарантирует скрипт:

- новые записи создаются, изменённые обновляются, прежняя версия каждой изменённой или удалённой
  записи сохраняется в `revisions` (её можно восстановить в админ-панели);
- черновики учителей сохраняются; удалённые учителем записи остаются удалёнными (кроме
  `--restore-deleted`); записи, которых нет в бандле, не трогаются – отчёт показывает их в строке
  «Only in the database», и их можно добавить в файл удалений;
- прогресс детей не меняется: отметки «Я участвую» на удалённые олимпиады остаются в прогрессе,
  но сами олимпиады детям больше не видны;
- перед записью проверяется итоговое состояние целиком: схема, связи (тема урока и задания,
  задания пробника), ссылки на удаляемые записи, дубли олимпиад. При ошибке ничего не пишется,
  код выхода `1`; ошибка аргументов – код `2`;
- запись идёт под тем же advisory lock, что и сидирование при старте; повторный запуск ничего не
  меняет.

`scripts/data/olympiad-deletions-2026-09-29.json` – 28 олимпиад, которые нужно убрать из прежней
production-базы при переходе на сверенный календарь 2026/27 (дубли, не подходящие по классам, не
проводящиеся в этом сезоне, уже прошедшие; у каждой – причина). На снимке production от 29.09.2026
(521 олимпиада) пробный прогон по `--kinds olympiads` даёт: 8 новых, 493 обновлённых, 28 удалённых;
повторный запуск – без изменений (`tests/integration/sync-content.test.ts`). Если на сервере
остались записи других типов из старой версии контента, они появятся в «Only in the database» –
решите, удалять ли их, до `--apply`.

Локально то же самое: `pnpm compile-content`, затем
`node scripts/sync-content.mjs …` с переменными подключения к базе (`DATABASE_URL` или
`DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`).

## 8. Резервные копии и восстановление

```bash
F=compose.production.yaml
docker compose -f $F --profile tools run --rm backup          # backups/olympus-db-*.dump
docker compose -f $F --profile tools run --rm media-backup    # backups/olympus-media-*.tar.gz

docker compose -f $F stop web bot
BACKUP_FILE=olympus-db-ГГГГММДД-ЧЧММСС.dump docker compose -f $F --profile tools run --rm restore
docker compose -f $F start web bot
```

Автодеплой копирует только PostgreSQL. Храните копии и вне сервера (например, `rsync` каталога
`backups/`) и периодически проверяйте восстановление на тестовом стенде. Подробнее о составе
данных – [DATA.md](DATA.md#7-резервные-копии-и-восстановление).

## 9. Наблюдение и диагностика

```bash
F=compose.production.yaml
docker compose -f $F ps                          # у postgres, web, runner, bot – (healthy)
docker compose -f $F logs --tail=200 web         # миграции, [seed], ошибки приложения
docker compose -f $F logs --tail=200 bot         # JSON-события бота
curl -fsS https://<домен>/api/v1/health          # {"status":"ok","database":"ok","version":"1.0.0"}
docker compose -f $F exec bot node -e "fetch('http://127.0.0.1:8090/health').then(r=>r.text()).then(console.log)"
docker compose -f $F exec runner node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.text()).then(console.log)"
```

| Симптом | Где смотреть и что делать |
|---|---|
| `web` перезапускается, в логе `Missing production environment variables` или `… must contain at least …` | заполнить `.env` по разделу 3 |
| `/api/v1/health` → `503`, `"database":"unavailable"` | PostgreSQL недоступна или неверный пароль; `docker compose logs postgres` |
| бот `unhealthy`, в `/health` `"status":"error"` и `problems` | неверный `BOT_TOKEN`, нет `BOT_WEBHOOK_SECRET`, `BOT_WEBHOOK_URL` не `https://…:443` |
| кнопка «Открыть» в боте не открывает приложение | URL мини-приложения в business.max.ru не совпадает с доменом; задайте `MAX_BOT_NAME` ([BOT.md](BOT.md)) |
| задачи с кодом: «Проверка программ сейчас не работает…» | `JUDGE0_URL` не задан или Judge0 недоступен; `/health` runner покажет `judge0` |
| «Слишком много попыток входа» | 10 неверных паролей за 15 минут с одного адреса – подождать 15 минут или перезапустить `web` |
| Caddy не получает сертификат | DNS домена не указывает на сервер или закрыт порт 80/443 |
