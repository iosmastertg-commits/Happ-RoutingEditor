# Rule Flow Editor

Визуальный редактор правил для прокси/роутинга. 3 колонки, drag-and-drop, плавные анимации, работа с бинарными `.dat` (geosite/geoip) в формате V2Ray.

## Возможности

**Колонка 1 — Мои правила**
- Список правил (`domain:`, `geosite:`, `geoip:`, plain) с drag-and-drop сортировкой
- Inline-редактирование по клику на значение, удаление (✕) с анимацией
- Quick-add: select типа + поле ввода + кнопка `＋`
- Экспорт в `.txt`, импорт из текста / URL / файла (кнопки «Импорт» и «Экспорт»)

**Колонка 2 — Geosite**
- URL-бар + «Загрузить» (дефолт: Loyalsoldier `geosite.dat`)
- Дерево категорий (▶/▼), ленивая подгрузка доменов
- У каждого домена кружок (+/✓): клик = добавление в «Мои правила» с зелёным glow
- Drag-and-drop доменов в «Мои правила»
- Поле «добавить домен…» и кнопка удаления в каждой категории
- Кнопка `+ geosite` на категории добавляет `geosite:<код>`

**Колонка 3 — GeoIP**
- URL-бар + «Загрузить» (дефолт: Loyalsoldier `geoip.dat`)
- Страны плитками, клик = добавление `geoip:<код>` (зелёная подсветка), повторный клик — снятие

Если в URL-баре указать не `http(s)://`, а оставить путь/пусто — откроется диалог выбора локального `.dat` файла.

## Запуск из исходников

```bash
npm install
npm start
```

## Сборка .exe

```bash
npm run dist        # portable -> dist/RuleFlowEditor.exe
npm run dist:nsis   # установщик NSIS
```

Готовый файл: `dist/RuleFlowEditor.exe` (один portable-файл, ничего устанавливать не нужно).

## Архитектура

- `main.js` — Electron main: загрузка `.dat` по URL (с follow-redirect), парсинг, диалоги файлов, IPC.
- `preload.js` — безопасный мост `window.api` (contextIsolation).
- `src/datparser.js` — самописный парсер protobuf wire-формата для `GeoSiteList` / `GeoIPList` (без зависимостей).
- `src/index.html` / `style.css` / `renderer.js` — UI и вся логика колонок.
