#!/usr/bin/env node
/**
 * Проверка научного стиля на живой модели.
 *
 *   node tools/register-probe.js                 — замечания заказчика
 *   node tools/register-probe.js работа.txt      — любой готовый текст
 *   node tools/register-probe.js работа.txt --find-only   — без модели
 *
 * Печатает найденные разговорные обороты, затем — что сделала
 * перепись (api/register.js → fixRegister): было / стало по каждому
 * предложению и что осталось неисправленным.
 */
const { relaunchWithCA } = require('../api/ca.js');
if (relaunchWithCA(__filename)) return;

require('dotenv').config();
const fs = require('fs');
const { PROVIDERS } = require('../api/providers.js');
const { findColloquial, offendingSentences, fixRegister } = require('../api/register.js');

const MODEL = process.env.GIGACHAT_MODEL || 'GigaChat-3-Ultra';

// Дословно из замечаний заказчика (работа о взыскании налоговой
// задолженности).
const CLIENT = [
  'Проблема здесь одна, но системная: если на счету пусто, поручение «висит» в картотеке № 2, и любая копейка, упавшая на счет, тут же уйдет в бюджет.',
  'Логика судов проста – налоговый орган действует в пределах полномочий, установленных ст. 46 НК РФ.',
  'В результате по НДС возникнет недоимка, на нее начислят пени, и отрицательное сальдо начнет расти как снежный ком, пока не сработает триггер блокировки счетов.',
  'Отдельная головная боль – взыскание с индивидуальных предпринимателей.',
  'Поэтому инкассо может быть направлено на любой обнаруженный счет, включая тот, куда приходит зарплата или социальные пособия.',
  'Автоматика ФНС видит лишь факт наличия денег и списывает их.',
  'Законодателю стоило бы установить жесткий срок для такой замены.',
].join(' ');

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
  const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
  // Сначала — оговорки модели («Генеративные языковые модели не
  // обладают собственным мнением…»), как в writeFullPiece.
  const { stripDisclaimers, relocateTransitions, fixMixedScript } = require('../api/cleanup.js');
  const cut = stripDisclaimers(fixMixedScript(file ? fs.readFileSync(file, 'utf8') : CLIENT).text);
  // Готовая работа: связки из середины разделов — в конец (по заголовкам
  // «1.2. …», «ГЛАВА 2», «ЗАКЛЮЧЕНИЕ»).
  let movedTotal = 0;
  const text = cut.text.split(/\n(?=\s*(?:\d+\.\d+\.?\s|ГЛАВА\s|ЗАКЛЮЧЕНИЕ|ВВЕДЕНИЕ))/).map((part) => {
    const lines = part.split('\n');
    const head = /^\s*(?:\d+\.\d+\.?\s|ГЛАВА\s|ЗАКЛЮЧЕНИЕ|ВВЕДЕНИЕ)/.test(lines[0]) ? lines.shift() : '';
    const r = relocateTransitions(lines.join('\n'));
    movedTotal += r.moved;
    return [head, r.text].filter(Boolean).join('\n\n');
  }).join('\n\n').replace(/\n{3,}/g, '\n\n');
  if (movedTotal) console.log(`Связок перенесено в конец раздела: ${movedTotal}\n`);
  if (cut.removed.length) {
    console.log(`Срезано оговорок модели: ${cut.removed.length}`);
    cut.removed.forEach((r) => console.log(`  ✂ ${r.slice(0, 140)}…`));
    console.log('');
  }
  const len = text.replace(/\s/g, '').length;

  const hits = findColloquial(text);
  console.log(`Текст: ${len} зн. без пробелов. Разговорных оборотов: ${hits.length}`
    + ` (${((hits.length / len) * 1000).toFixed(2)} на 1000 зн.)\n`);
  const byKind = {};
  hits.forEach((h) => { (byKind[h.kind] = byKind[h.kind] || []).push(h.match); });
  for (const [k, list] of Object.entries(byKind)) console.log(`  ${k}: ${list.join(', ')}`);
  if (process.argv.includes('--find-only') || !hits.length) return;

  const before = offendingSentences(text);
  const t0 = Date.now();
  const r = await fixRegister(text, ask);
  console.log(`\nПерепись за ${Math.round((Date.now() - t0) / 1000)} с: найдено ${r.found},`
    + ` исправлено ${r.fixed}, осталось ${r.left.length}\n`);

  for (const c of r.changes) {
    console.log(`БЫЛО:  ${c.before}`);
    console.log(`СТАЛО: ${c.after || '(удалено — повтор предыдущей мысли)'}\n`);
  }
  const kept = before.filter((o) => r.text.includes(o.sentence));
  for (const o of kept) console.log(`НЕ ПРИНЯТО (оставлено как было): ${o.sentence}\n`);
  if (r.left.length) console.log('Осталось:', r.left.map((h) => `«${h.match}»`).join(', '));
  if (file) {
    const out = file.replace(/(\.\w+)?$/, '_научный.txt');
    fs.writeFileSync(out, r.text);
    console.log(`\nИсправленный текст: ${out}`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
