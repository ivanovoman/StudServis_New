#!/usr/bin/env node
/**
 * Прогон одного пункта меню без браузера.
 *
 * Нужен для приёмки (ПРОВЕРКА.md): повторяет ровно то, что делает
 * страница — тот же POST /api/generate, тот же разбор SSE, — и считает
 * то, что в сценарии требуется проверить глазами: время до первого
 * куска, объём в знаках без пробелов, число найденных источников,
 * мусор в тексте.
 *
 * Запуск:
 *   node tools/run-step.js --step analysis --input "Коллизии в праве"
 *   node tools/run-step.js --step plan --input-file /tmp/analysis.txt \
 *        --settings '{"chapters":"2"}' --out /tmp/plan.txt
 *
 * Шаг называется словом, а не номером меню: analysis, plan,
 * introduction, speech. Номер сервер не понимает и отвечает
 * «Неизвестный шаг протокола».
 */

const fs = require('fs');
const path = require('path');
const { relaunchWithCA } = require('../api/ca.js');
if (relaunchWithCA(__filename)) return;

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}

const BASE = arg('base', 'http://localhost:3000');
const step = arg('step');
const inputFile = arg('input-file');
const input = inputFile ? fs.readFileSync(inputFile, 'utf8') : arg('input');
const settings = JSON.parse(arg('settings', '{}'));
const outFile = arg('out');
const history = arg('history-file')
  ? JSON.parse(fs.readFileSync(arg('history-file'), 'utf8'))
  : [];

if (!step || !input) {
  console.error('Нужны --step и --input (или --input-file)');
  console.error('Шаг — слово, а не номер меню: analysis, plan, '
    + 'introduction, speech.');
  process.exit(2);
}

/** Знаки без пробелов — норматив из задания считается именно так. */
const dense = (s) => s.replace(/\s/g, '').length;

/** Мусор, который ищет шаг 12 сценария. */
function findGarbage(text) {
  const problems = [];

  // Латиница внутри русского слова: «довestnosti». Латинские термины
  // целиком (lex specialis) законны, поэтому ищем именно стык.
  const mixed = text.match(/[а-яё][a-z]{2,}|[a-z]{2,}[а-яё]/gi);
  if (mixed) problems.push(`латиница в русских словах: ${[...new Set(mixed)].slice(0, 5).join(', ')}`);

  // Иероглифы и полноширинные знаки.
  const cjk = [...text].filter((c) => c.codePointAt(0) > 0x2fff
    && !(c.codePointAt(0) >= 0xfe00 && c.codePointAt(0) <= 0xfe0f));
  if (cjk.length) problems.push(`иероглифы (${cjk.length}): ${[...new Set(cjk)].slice(0, 8).join(' ')}`);

  // Незаменённая подстановка в промпте.
  const tpl = text.match(/\{\{[A-Z_]+\}\}/g);
  if (tpl) problems.push(`подстановка не сработала: ${[...new Set(tpl)].join(', ')}`);

  return problems;
}

(async () => {
  const started = Date.now();
  let firstChunk = null;
  let text = '';
  let sources = [];
  const notices = [];

  const res = await fetch(`${BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ step, input, history, settings }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;

      let obj;
      try { obj = JSON.parse(payload); } catch (e) { continue; }

      if (obj.error) { console.error('ОШИБКА:', obj.error); process.exit(1); }
      if (obj.sources) sources = obj.sources;
      if (obj.notice) notices.push(obj.notice);
      if (obj.delta) {
        if (firstChunk === null) firstChunk = Date.now() - started;
        text += obj.delta;
      }
    }
  }

  const total = Date.now() - started;
  const garbage = findGarbage(text);

  console.log(`  первый кусок:  ${firstChunk === null ? '—' : (firstChunk / 1000).toFixed(1) + ' с'}`);
  console.log(`  всего:         ${(total / 1000).toFixed(1)} с`);
  console.log(`  знаков:        ${text.length} (без пробелов ${dense(text)})`);
  console.log(`  источников:    ${sources.length}`);
  if (notices.length) console.log(`  сообщения:     ${notices.join(' | ')}`);
  console.log(`  мусор:         ${garbage.length ? garbage.join('; ') : 'не найден'}`);

  if (outFile) {
    fs.writeFileSync(outFile, text);
    console.log(`  сохранено:     ${outFile}`);
  }
})().catch((e) => {
  console.error('Сорвалось:', e.message, e.cause ? `(${e.cause.code})` : '');
  process.exit(1);
});
