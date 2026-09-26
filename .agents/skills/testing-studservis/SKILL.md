---
name: testing-studservis
description: How to run and end-to-end test the СЕРВИС СТУДРАБОТ app (Express + OpenRouter generation + GOST DOCX export + retro-theme frontend)
---

# Testing СЕРВИС СТУДРАБОТ

## Run
- `npm install && npm start` in repo root → http://localhost:3000. Requires `OPENROUTER_API_KEY` in `.env` (Devin secret needed: OPENROUTER_API_KEY, or user-supplied .env).
- Sanity: `curl localhost:3000/api/health` → `{"ok":true,...,"hasKey":true}`.

## Frontend (browser)
- `/` randomly redirects to one of the themes in `public/themes/` (list in `public/themes.js`). Force one via `/?theme=Windows_95.html`.
- UI menus are static mockups (not wired to API) — do not treat dead buttons as bugs.
- Known cosmetic issue: most themes reference `альфабета_логотип.png` which is missing from `public/themes/` → broken logo icon (404). Verify whether it's been fixed before re-reporting.

## API testing (curl)
- Streaming: `curl -N -X POST localhost:3000/api/generate -H 'Content-Type: application/json' -d '{"step":"analysis","input":"Тема курсовой: ..."}'` → SSE lines `data: {"delta":"..."}` ending `data: [DONE]`. Free OpenRouter models can take 1–3 min or fail; server falls back through FALLBACK_MODELS (see console log «использована резервная»). Don't pipe the stream through `head` — SIGPIPE kills curl mid-stream; use `-o file`.
- Steps available: analysis, plan, introduction, section_plan, section_write, section_polish, table_generate, table_check, conclusion, polish (api/prompts.js).
- `/api/export-docx` payload: `{title, text, tableMarkdown, isH1, chapterHeading, tableNumber, tableTitle, referenceSentence}`.
- `/api/export-docx-full` payload shape matters: `sections` is an array of `{number:"1.1", text, table:{number,title,markdown}}`; `chapterTitles` is a dict `{"1":"..."}`; `sectionTitles` a dict `{"1.1":"..."}`. Wrong shapes silently produce a doc with only ВВЕДЕНИЕ/ЗАКЛЮЧЕНИЕ.
- Validate docx: `unzip -p x.docx word/document.xml | grep 'Times New Roman'` etc.; visual proof via LibreOffice (`sudo apt-get install -y libreoffice-writer`, not preinstalled).

## Gotchas
- A `.env` line like `OPENROUTER_MODEL=OPENROUTER_MODEL=nvidia/...` makes the primary model id invalid; generation still works only via the fallback list. Check `/api/health`'s `model` field for sanity.
