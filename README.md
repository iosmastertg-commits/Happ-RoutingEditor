# Happ RoutingEditor

Визуальный редактор правил маршрутизации (Direct / Proxy / Block) для Happ и Incy
+ конвертер geosite/geoip `.dat` (формат V2Ray).

## Быстрый старт

1. Скачай **`RuleFlowEditor.exe`** из корня этого репозитория (или из релизов GitHub).
2. Запусти двойным кликом — программа portable, ничего устанавливать не нужно.
3. Собирай правила в три колонки, жми «⚡ Happ» / «⚡ Incy» — ссылка маршрутизации
   (`happ://routing/onadd/<base64>`) копируется в буфер.
4. Импорт по такой ссылке: «Импорт» → вкладка **«Ссылка»** → вставить → «Импортировать».

## Возможности

- **Редактор**: три колонки (Мои правила / Geosite / GeoIP), drag-and-drop,
  inline-редактирование, поиск по доменам, загрузка `.dat` по URL или из файла.
- **Конвертер**: разворачивает `geosite:`/`geoip:` в домены и IP по загруженным
  `.dat`, экспорт в txt/JSON, генерация ссылок Happ/Incy.
- **Импорт по ссылке**: `happ://routing/onadd/<base64>` и `incy://...`
  (распознаёт также URL-encoded и base64url), с заполнением секций и URL-полей.
- **Порядок правил при конвертации**: `regexp` → `keyword` → plain → `domain`.

## Для разработчика

```bash
cd "test direct"
npm install
npm start        # запуск из исходников
npm run dist     # сборка portable exe -> dist/RuleFlowEditor.exe
```

## Структура

- `RuleFlowEditor.exe` — готовая portable-сборка Windows x64.
- `test direct/` — исходники Electron-приложения (`main.js`, `preload.js`, `src/`).
- `docs/superpowers/specs/` — проектные спеки.