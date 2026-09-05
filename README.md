# СЕРВИС СТУДРАБОТ (Помощник студента)

Веб-сервис для создания курсовых работ с помощью ИИ: анализ темы, план,
введение, текст разделов, таблицы, заключение и выгрузка в DOCX по ГОСТ.

## Структура

```
api/
  server.js      — Express-сервер: /api/generate (SSE-стриминг через OpenRouter),
                   /api/export-docx, /api/export-docx-full, /api/health
  prompts.js     — системные промпты для каждого шага протокола
  docxExport.js  — генерация .docx по ГОСТ (Times New Roman 14pt, поля, таблицы)
public/
  index.html     — точка входа: при загрузке случайно выбирает одну из ретро-тем
  themes.js      — список тем (добавление новой темы = 1 строка + файл в themes/)
  themes/        — 16 ретро-интерфейсов (Amber CRT, Windows 95, ZX Spectrum и др.)
```

## Запуск

```bash
npm install
cp .env.example .env   # вписать OPENROUTER_API_KEY
npm start              # http://localhost:3000
```

## API

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/generate` | Генерация текста шага. Тело: `{ step, input, history }`. Ответ: SSE-поток `{ delta }` |
| POST | `/api/export-docx` | DOCX одного фрагмента (план, введение, раздел...) |
| POST | `/api/export-docx-full` | DOCX всей работы целиком |
| GET | `/api/health` | Статус сервера, модель, наличие ключа |

Шаги протокола (`step`): `analysis`, `plan`, `introduction`, `section_plan`,
`section_write`, `section_polish`, `table_generate`, `table_check`,
`conclusion`, `polish` — см. `api/prompts.js`.
