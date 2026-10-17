#!/usr/bin/env node
/**
 * Вторая проверка регистра на живой модели: что находит рецензент сверх
 * словаря сторожа.
 *
 *   node tools/review-probe.js incoming/ab/base_1.1.txt [ещё файлы…]
 *
 * По каждому файлу печатает находки сторожа и рецензента (проверенные
 * цитаты), чтобы сверить их с чтением глазами.
 */
const { relaunchWithCA } = require('../api/ca.js');
if (relaunchWithCA(__filename)) return;

require('dotenv').config();
const fs = require('fs');
const { PROVIDERS } = require('../api/providers.js');
const { findColloquial, reviewRegister } = require('../api/register.js');

const MODEL = process.env.GIGACHAT_MODEL || 'GigaChat-3-Ultra';

async function ask(messages) {
  const res = await PROVIDERS.gigachat.stream(MODEL, messages, process.env);
  if (!res.ok) throw new Error(`модель ответила ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') continue;
      try { out += JSON.parse(raw).choices?.[0]?.delta?.content || ''; } catch { /* служебное */ }
    }
  }
  return out.trim();
}

(async () => {
  let own = 0;
  let rev = 0;
  for (const file of process.argv.slice(2)) {
    const text = fs.readFileSync(file, 'utf8');
    const a = findColloquial(text);
    // Рецензент молча пропускает упавшие запросы (в работе остаётся
    // словарь) — для замера считаем, сколько кусков реально прочитано.
    const calls = { ok: 0, fail: 0, raw: [] };
    const counted = async (m) => {
      try { const r = await ask(m); calls.ok += 1; calls.raw.push(r); return r; } catch (e) { calls.fail += 1; throw e; }
    };
    const b = await reviewRegister(text, counted);
    if (process.env.RAW) console.log(calls.raw.join('\n---\n'));
    own += a.length;
    rev += b.length;
    console.log(`### ${file}: сторож ${a.length}, рецензент сверх него ${b.length} (кусков прочитано ${calls.ok}, упало ${calls.fail})`);
    console.log(`  сторож:    ${a.map((h) => h.match).join(' | ')}`);
    console.log(`  рецензент: ${b.map((h) => `${h.match} → ${h.hint}`).join(' | ')}`);
  }
  console.log(`\nИТОГО: сторож ${own}, рецензент сверх него ${rev}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
