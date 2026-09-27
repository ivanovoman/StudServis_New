#!/usr/bin/env node
/**
 * Прогон сборки работы (пункт 4) без браузера — для приёмки.
 *
 * Повторяет то, что делает assemble.js на странице: шлёт план в
 * POST /api/assemble и разбирает поток событий. Печатает то, что
 * сценарий приёмки требует проверить: структуру, число частей, объём
 * каждой, найденные источники, пометки о ссылках на закон.
 *
 * Запуск:
 *   node tools/run-assemble.js --plan-file /tmp/plan.txt --out /tmp/work.json
 */

const fs = require('fs');
const { relaunchWithCA } = require('../api/ca.js');
if (relaunchWithCA(__filename)) return;

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}

const BASE = arg('base', 'http://localhost:3000');
const plan = fs.readFileSync(arg('plan-file'), 'utf8');
const settings = JSON.parse(arg('settings', '{}'));
const outFile = arg('out');

const dense = (s) => s.replace(/\s/g, '').length;

(async () => {
  const started = Date.now();
  const res = await fetch(`${BASE}/api/assemble`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan, settings, ownerKey: 'acceptance-run' }),
  });

  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pieces = [];
  const failed = [];
  const legal = [];
  let sources = [];
  let total = 0;
  let structureAt = null;
  let savedSeen = false;

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
      let o;
      try { o = JSON.parse(payload); } catch (e) { continue; }

      if (o.error) { console.error('ОШИБКА:', o.error); process.exit(1); }

      if (o.outline) {
        structureAt = Date.now() - started;
        total = o.total;
        console.log(`  структура за ${(structureAt / 1000).toFixed(1)} с, частей: ${total}`);
        for (const c of o.outline) {
          console.log(`    Глава ${c.number}. ${c.title}`);
          for (const s of c.sections) console.log(`      ${s.number} ${s.title}`);
        }
        if (o.warnings && o.warnings.length) {
          console.log(`    предупреждения: ${o.warnings.join('; ')}`);
        }
      }
      if (o.sources) {
        sources = o.sources;
        console.log(`  опора: ${sources.length} публикаций`);
      }
      if (o.notice) console.log(`  ВНИМАНИЕ: ${o.notice}`);
      if (o.saved && !savedSeen) { savedSeen = true; console.log('  сохранение: включено'); }
      if (o.piece) {
        pieces.push(o.piece);
        const text = o.piece.text || '';
        console.log(`  [${pieces.length}/${total}] ${o.piece.heading || o.piece.kind}`
          + ` — ${dense(text)} зн. без пробелов,`
          + ` ${((Date.now() - started) / 1000).toFixed(0)} с`);
      }
      if (o.failed) {
        failed.push(o.failed);
        console.log(`  ПРОВАЛ: ${o.failed.title} — ${o.failed.error || ''}`);
      }
      if (o.legal) legal.push(o.legal);
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\n  итого: ${pieces.length} частей, провалов ${failed.length}, ${secs} с`);

  const checked = legal.reduce((a, l) => a + (l.checked || 0), 0);
  const problems = legal.reduce((a, l) => a + (l.problems || 0), 0);
  console.log(`  ссылки на закон: проверено ${checked}, расхождений ${problems}`);

  const all = pieces.map((p) => p.text || '').join('\n');
  const markers = (all.match(/\[\d+(?:,\s*с\.\s*\d+)?\]/g) || []);
  console.log(`  маркеров сносок в тексте: ${markers.length}`);

  if (outFile) {
    fs.writeFileSync(outFile, JSON.stringify({ pieces, sources, failed, legal }, null, 2));
    console.log(`  сохранено: ${outFile}`);
  }
})().catch((e) => {
  console.error('Сорвалось:', e.message, e.cause ? `(${e.cause.code})` : '');
  process.exit(1);
});
