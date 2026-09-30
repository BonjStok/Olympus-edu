# Медиафайлы

Учитель может загрузить в админ-панели картинку, PDF или видео и вставить его в урок (блоки
`image`, `video`, `link`) или в карточку олимпиады (`image`). Как это выглядит для учителя –
[TEACHER-GUIDE.md](TEACHER-GUIDE.md).

## Как устроено

- **Загрузка** – действие RPC `upload` (только учитель): `{ base64, type }`, тело запроса до 12 МБ.
  Разрешены `image/png`, `image/jpeg`, `image/webp`, `application/pdf`, `video/mp4`, файл до
  8 МБ. Тип проверяется по сигнатуре содержимого, а не только по заявленному `type` – HTML под
  видом PNG не пройдёт. Ответ: `{ url: "/api/media/<uuid>", id, type, size }`
  (`lib/services/media.ts`).
- **Хранение.** Файлы **не хранятся в PostgreSQL**: в записи контента лежит только ссылка
  `/api/media/<uuid>`, сам файл – в R2-совместимом хранилище через привязку `BUCKET`
  (`vite.config.ts`). В Docker и на VPS это локальная эмуляция R2, которую wrangler держит в
  `/app/.wrangler/state` – отдельный volume `olympus_media`, не связанный с volume PostgreSQL.
- **Выдача** – `GET /api/media/{id}` (`app/api/media/[id]/route.ts`): id – UUID, тип – из белого
  списка (иначе `application/octet-stream`), `Cache-Control: public, max-age=31536000, immutable`
  (файл под одним id никогда не меняется), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, поддержка одного диапазона `Range: bytes=…` для перемотки видео
  (`206`, при неверном диапазоне – `416`). Нет файла – `404`, нет хранилища – `503`.
- **Ошибки загрузки:** `415 UNSUPPORTED_FILE_TYPE` – «Поддерживаются PNG, JPG, WebP, PDF и MP4»;
  `413 FILE_TOO_LARGE` – «Файл слишком большой: максимум 8 МБ»; `422 INVALID_FILE` – содержимое
  не соответствует типу; `503 STORAGE_UNAVAILABLE` – хранилище не подключено.

Удаление материала не удаляет загруженный файл: он остаётся доступным по ссылке и нужен, если
материал восстановят из истории.

## Резервная копия

```bash
docker compose --profile tools run --rm media-backup     # backups/olympus-media-ГГГГММДД-ЧЧММСС.tar.gz
# на сервере: docker compose -f compose.production.yaml --profile tools run --rm media-backup
```

Автодеплой копирует только PostgreSQL – медиа сохраняйте отдельно. Восстановление – распаковать
архив в volume `olympus_media` (при остановленном `web`).

## Масштабирование

Код работает с узким интерфейсом `MediaBucket` (`put`, `get`, `head` – `lib/server/env.ts`),
поэтому эмуляцию можно заменить настоящим объектным хранилищем с R2-совместимой привязкой без
изменения схемы PostgreSQL и ссылок в контенте.
