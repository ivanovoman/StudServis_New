#!/usr/bin/env node
/**
 * Черновик раздела в нескольких вариантах — разными моделями.
 *
 * Замысел заказчика: пусть раздел напишут две-три модели, а при
 * переписи на чистовик сервис возьмёт фактуру из всех вариантов, а
 * форму — из лучшего.
 *
 * Прежде чем это строить, нужно ответить на один вопрос: а дают ли
 * разные модели РАЗНУЮ фактуру? Если все пишут про одни и те же
 * статьи, сводить нечего и вся затея — лишний расход квоты.
 *
 * Инструмент пишет один раздел несколькими моделями сразу и считает,
 * сколько у каждой нашлось своего: ссылок на нормы, которых нет у
 * остальных.
 *
 * Запуск:
 *   node tools/draft-variants.js --models GigaChat-3-Ultra,GigaChat-2-Max
 */

const fs = require('fs');
const { relaunchWithCA } = require('../api/ca.js');
if (relaunchWithCA(__filename)) return;

require('dotenv').config();
const { PROVIDERS } = require('../api/providers.js');

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}

const MODELS = (arg('models',
  'GigaChat-3-Ultra,GigaChat-3-Pro,GigaChat-2-Max')).split(',');
const OUT = arg('out', '/tmp/variant');
const HEADING = arg('heading',
  'Понятие коллизии в праве и её отличие от конкуренции норм');

const PLAN = `Тема: Коллизии в праве и способы их разрешения.
Глава 1. Понятие и природа правовых коллизий.
1.1. ${HEADING}
1.2. Причины возникновения коллизий.
Глава 2. Способы разрешения коллизий.`;

/**
 * Фактура — то, ради чего варианты и сводятся.
 *
 * Считаем ссылки на нормы, номера актов, кодексы и годы: именно их
 * теряет перепись и именно их не хватает в тексте, написанном одной
 * моделью по памяти.
 */
function extractFacts(text) {
  const facts = new Set();
  const add = (re) => {
    for (const m of text.matchAll(re)) {
      facts.add(m[0].replace(/\s+/g, ' ').trim());
    }
  };
  add(/(?:ст|п|ч|абз|гл)\.\s*\d+(?:\.\d+)?/gi);
  add(/№\s*\d+[-–]?[А-ЯA-Zа-яa-z]*/g);
  add(/\b(?:ГК|УК|ТК|КоАП|ГПК|АПК|УПК|НК|СК|ЖК|БК|ЗК)\s*РФ/g);
  add(/\b(?:19|20)\d{2}\b/g);
  return facts;
}

/** Фамилии учёных: вторая половина фактуры научной работы. */
function extractNames(text) {
  const names = new Set();
  // «Алексеев С. С.», «С. С. Алексеев», «по мнению Тихомирова»
  for (const m of text.matchAll(/[А-ЯЁ][а-яё]{3,}\s+[А-ЯЁ]\.\s*[А-ЯЁ]\./g)) {
    names.add(m[0].replace(/\s+/g, ' '));
  }
  for (const m of text.matchAll(/[А-ЯЁ]\.\s*[А-ЯЁ]\.\s*([А-ЯЁ][а-яё]{3,})/g)) {
    names.add(m[1]);
  }
  return names;
}

async function writeWith(model) {
  const provider = PROVIDERS.gigachat;
  const messages = [
    {
      role: 'system',
      content: 'Ты пишешь раздел курсовой работы по юриспруденции. '
        + 'Пиши научным языком, опирайся на конкретные нормы с '
        + 'указанием статей и на позиции учёных с фамилиями. '
        + 'Не выдумывай номера дел и статей, в которых не уверен.',
    },
    {
      role: 'user',
      content: `План работы:\n${PLAN}\n\nНапиши раздел 1.1 «${HEADING}». `
        + 'Объём 5000-5500 знаков без пробелов. Только текст раздела.',
    },
  ];

  const t0 = Date.now();
  const res = await provider.stream(model, messages, process.env);
  if (!res.ok) {
    return { model, ok: false, error: `${res.status}`, seconds: 0 };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
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
      try {
        text += JSON.parse(raw).choices?.[0]?.delta?.content || '';
      } catch { /* служебная строка */ }
    }
  }

  return {
    model,
    ok: Boolean(text.trim()),
    text: text.trim(),
    seconds: Math.round((Date.now() - t0) / 1000),
  };
}

(async () => {
  console.log(`Пишем раздел «${HEADING}»`);
  console.log(`Моделей: ${MODELS.length} — ${MODELS.join(', ')}\n`);

  // Последовательно, и это вынужденно. Параллельный запуск трёх
  // моделей GigaChat отвечает «429 Too Many Requests»: ограничение
  // стоит не только на токен, но и на одновременные запросы к самим
  // моделям. Три раза по двадцать секунд — минута вместо двадцати
  // секунд, зато без отказов.
  const results = [];
  for (const model of MODELS) {
    let r = await writeWith(model);
    // Одна повторная попытка: лимит снимается за несколько секунд.
    if (!r.ok && String(r.error).includes('429')) {
      await new Promise((ok) => setTimeout(ok, 8000));
      r = await writeWith(model);
    }
    results.push(r);
  }

  const good = results.filter((r) => r.ok);
  for (const r of results) {
    if (!r.ok) {
      console.log(`  ✗ ${r.model}: не ответила (${r.error || 'пусто'})`);
      continue;
    }
    const dense = r.text.replace(/\s/g, '').length;
    const facts = extractFacts(r.text);
    const names = extractNames(r.text);
    fs.writeFileSync(`${OUT}_${r.model}.txt`, r.text, 'utf8');
    console.log(`  ✓ ${r.model.padEnd(20)} ${String(dense).padStart(5)} зн. `
      + `за ${String(r.seconds).padStart(2)} с; фактуры ${facts.size}, `
      + `фамилий ${names.size}`);
  }

  if (good.length < 2) {
    console.log('\nСводить нечего: ответила одна модель.');
    return;
  }

  // Главный вопрос: есть ли у вариантов своё, чего нет у других.
  console.log('\nЧто есть только у этого варианта (ради чего сводим):');
  const all = good.map((r) => ({
    model: r.model,
    facts: extractFacts(r.text),
    names: extractNames(r.text),
  }));

  let uniqueTotal = 0;
  for (const v of all) {
    const others = all.filter((x) => x.model !== v.model);
    const otherFacts = new Set(others.flatMap((x) => [...x.facts]));
    const otherNames = new Set(others.flatMap((x) => [...x.names]));
    const uf = [...v.facts].filter((f) => !otherFacts.has(f));
    const un = [...v.names].filter((n) => !otherNames.has(n));
    uniqueTotal += uf.length + un.length;
    console.log(`  ${v.model}:`);
    console.log(`     своя фактура (${uf.length}): ${uf.slice(0, 10).join(', ') || '—'}`);
    console.log(`     свои фамилии (${un.length}): ${un.slice(0, 8).join(', ') || '—'}`);
  }

  const union = new Set(all.flatMap((v) => [...v.facts, ...v.names]));
  const best = all.reduce((a, b) =>
    (a.facts.size + a.names.size >= b.facts.size + b.names.size ? a : b));
  const bestSize = best.facts.size + best.names.size;

  console.log(`\nИтого по всем вариантам: ${union.size} единиц фактуры и имён.`);
  console.log(`Лучший одиночный вариант (${best.model}): ${bestSize}.`);
  console.log(`Сведение добавляет ${union.size - bestSize} сверх лучшего `
    + `(${Math.round((union.size / bestSize - 1) * 100)} %).`);
})();
