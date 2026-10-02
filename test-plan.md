# Test Plan — СЕРВИС СТУДРАБОТ (PR #1, devin/1786964976-backend-integration)

Server: `npm start` in /home/ubuntu/repos/student-helper, port 3000 (already running).
Note found in setup: user's .env has `OPENROUTER_MODEL=OPENROUTER_MODEL=nvidia/nemotron-3-super-120b-a12b:free` — the model id is malformed ("OPENROUTER_MODEL=nvidia/...") so /api/generate should hit the fallback list (server.js:25-30). This naturally tests fallback behavior; report it as an .env issue.

## T1. Health endpoint (shell)
- `curl localhost:3000/api/health`
- PASS: JSON contains `"ok":true` and `"hasKey":true`. Note the reported `model` value (expected to show the malformed string — evidence of .env issue).

## T2. Random theme redirect + forced theme (browser, recorded)
- Open http://localhost:3000/ 3–4 times (re-enter URL each time).
- PASS: each load redirects to `/themes/<name>.html`; at least 2 different themes across loads (if identical by chance, reload up to 6 times).
- Open http://localhost:3000/?theme=Windows_95.html → PASS: URL becomes /themes/Windows_95.html and the Windows 95 UI renders.
- Visually inspect ~4 themes (e.g. Windows_95, Green_Phosphor, Apple_Lisa, ZX_Spectrum) — PASS: page renders styled UI with title «СЕРВИС СТУДРАБОТ» / menu content, no raw unstyled HTML or obvious broken layout.

## T3. /api/generate SSE streaming (shell)
- `curl -N -X POST localhost:3000/api/generate -H 'Content-Type: application/json' -d '{"step":"analysis","input":"Тема курсовой: Субсидиарная ответственность контролирующих лиц при банкротстве"}'`
- PASS: response is SSE (`data: {"delta":"..."}` lines) with meaningful Russian text about the topic, ending in `data: [DONE]`. Check server log for the fallback message «Основная модель недоступна, использована резервная». 
- If it returns `data: {"error":...}` — record the exact error (free models may be down) and mark honestly.
- Negative check: POST with missing `step` → PASS: 400 with error «Нужны поля step и input».

## T4. DOCX exports (shell + LibreOffice/unzip verification)
- POST /api/export-docx with `{title:"1.1. Понятие субсидиарной ответственности", text:"...two paragraphs...", tableMarkdown:"|Критерий|Описание|\n|---|---|\n|Субъект|КДЛ|", tableNumber:"1.1", tableTitle:"Критерии", chapterHeading:"ГЛАВА 1 ...", isH1:false}` → save fragment.docx.
- POST /api/export-docx-full with `{topic, introduction, sections:[{...with tableMarkdown...}], conclusion, chapterTitles, sectionTitles}` → save full.docx.
- PASS for each: `file` reports Microsoft Word 2007+; `unzip -p x.docx word/document.xml` contains `Times New Roman`, the headings text, and `<w:tbl>` with cell texts from the markdown table; full.docx additionally contains ВВЕДЕНИЕ / ЗАКЛЮЧЕНИЕ / СОДЕРЖАНИЕ headings.
- Open both in LibreOffice Writer, screenshot pages showing heading, justified text, and rendered table (visual proof, part of recording or separate screenshots).
