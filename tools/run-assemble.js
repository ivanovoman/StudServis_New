#!/usr/bin/env node
/**
 * Прогон полной сборки работы через /api/assemble.
 *
 * Нужен, чтобы мерить сборку целиком, а не по одному разделу: время,
 * объёмы частей, отказы и порчу текста. Через браузер это неудобно —
 * вкладку нельзя закрыть, а результат нигде не сохраняется.
 *
 *   node tools/run-assemble.js <файл-плана> [файл-результата]
 *
 * Результат кладётся в JSON: части, объёмы, время, список отказов.
 */

const fs = require('fs');

const planFile = process.argv[2];
const outFile = process.argv[3] || '/tmp/assembled.json';
const base = process.env.BASE_URL || 'http://localhost:3000';

if (!planFile || !fs.existsSync(planFile)) {
  console.error('Укажите файл плана: node tools/run-assemble.js plan.md');
  process.exit(1);
}

const plan = fs.readFileSync(planFile, 'utf8');
const settings = {
  topic: 'Коллизии в праве',
  chapters: 2,
  university: '',
  methodichka: '',
  wishes: '',
  sources: [],
};

// Знаки без пробелов — именно в них заданы нормы объёма.
const noSpace = (s) => s.replace(/\s/g, '').length;

(async () => {
  const t0 = Date.now();
  const res = await fetch(`${base}/api/assemble`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan, settings }),
  });

  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const pieces = [];
  const failed = [];
  let outline = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') continue;

      let ev;
      try { ev = JSON.parse(raw); } catch { continue; }

      if (ev.outline) {
        outline = ev.outline;
        total = ev.total;
        console.log(`План разобран: ${total} частей`);
        if (ev.warnings && ev.warnings.length) {
          for (const w of ev.warnings) console.log(`  предупреждение: ${w}`);
        }
      }
      if (ev.progress) {
        const p = ev.progress;
        process.stdout.write(
          `[${p.index}/${p.total}] ${p.title} ... `
        );
      }
      if (ev.expanding) {
        const x = ev.expanding;
        process.stdout.write(
          `коротко (${x.have} из ${x.need}), дописываю #${x.attempt} ... `
        );
      }
      if (ev.piece) {
        const el = ((Date.now() - t0) / 1000).toFixed(0);
        pieces.push(ev.piece);
        const fixNote = ev.piece.fixed && ev.piece.fixed.length
          ? `, исправлено слов: ${ev.piece.fixed.length}`
          : '';
        console.log(
          `готово ${noSpace(ev.piece.text)} зн. б/п (${el} с всего${fixNote})`
        );
      }
      if (ev.failed) {
        failed.push(ev.failed);
        console.log(`СБОЙ: ${ev.failed.reason}`);
      }
      if (ev.finished) {
        console.log(
          `\nИтог: написано ${ev.finished.written}, сбоев ${ev.finished.failed}`
        );
      }
    }
  }

  const secs = (Date.now() - t0) / 1000;
  fs.writeFileSync(outFile, JSON.stringify({
    seconds: secs, outline, pieces, failed,
  }, null, 1));

  console.log(`Время: ${Math.floor(secs / 60)} мин ${Math.round(secs % 60)} с`);
  console.log(`Результат: ${outFile}`);
})().catch((e) => {
  console.error('Ошибка:', e.message);
  process.exit(1);
});
