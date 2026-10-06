/**
 * Полный путь раздела: разбор темы → досье → черновик → чистовик.
 *
 * Собирает воедино то, что до сих пор проверялось по частям:
 *
 *   1. Глубокий разбор темы. Статьи ищутся по нескольким запросам и
 *      читаются целиком, а не по аннотациям.
 *   2. Досье по разделу. Из прочитанного отбираются выдержки именно
 *      по его теме, плюс перечень реально упомянутых норм.
 *   3. Черновик. Пишется по досье: содержание берётся из выдержек, а
 *      не из памяти модели. Форма при этом машинная — и это нормально.
 *   4. Чистовик. Черновик режется на куски по 350-500 знаков и
 *      переписывается в авторскую манеру под двумя сторожами: за
 *      сохранностью фактуры и за объёмом.
 *
 * Запуск:
 *   node tools/pipeline.js --heading "Название раздела" \
 *     --topic "Тема работы" [--queries "запрос1|запрос2"] \
 *     [--owner ключ] [--style-owner ключ] [--skip-harvest] \
 *     [--out /tmp/pipeline]
 */

'use strict';

const fs = require('fs');
const { relaunchWithCA } = require('../api/ca.js');
if (relaunchWithCA(__filename)) return;

require('dotenv').config();
const { PROVIDERS } = require('../api/providers.js');
const { dossierBlock } = require('../api/dossier.js');
const { extractFacts } = require('../api/facts.js');
const { polishDraft, styleRules } = require('../api/polish.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const PY = process.env.PY_BACKEND_URL || 'http://127.0.0.1:8000';
const MODEL = arg('model', 'GigaChat-3-Ultra');
const OWNER = arg('owner', 'pipeline-owner-001');
// Образцы авторской манеры лежат под своим ключом: это не материал
// по теме, а пример того, как писать.
const STYLE_OWNER = arg('style-owner', 'bench-style-owner-001');
const TOPIC = arg('topic', 'Коллизии в праве и способы их разрешения');
const HEADING = arg('heading', 'Понятие правовой коллизии и её отличие от конкуренции норм');
const OUT = arg('out', '/tmp/pipeline');

const QUERIES = arg('queries', '')
  ? arg('queries', '').split('|').map((s) => s.trim()).filter(Boolean)
  : [
    'коллизии норм права разрешение',
    'конкуренция правовых норм',
    'иерархические коллизии законодательство',
    'темпоральные коллизии права',
    'способы преодоления коллизий правоприменение',
  ];

const секунды = (t0) => Math.round((Date.now() - t0) / 1000);

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
      try {
        out += JSON.parse(raw).choices?.[0]?.delta?.content || '';
      } catch { /* служебная строка потока */ }
    }
  }
  return out.trim();
}

async function harvest() {
  const r = await fetch(`${PY}/api/v1/library/research/harvest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Owner-Key': OWNER },
    body: JSON.stringify({
      topic: TOPIC, queries: QUERIES, read_limit: 12, clear_before: true,
    }),
  });
  if (!r.ok) throw new Error(`разбор темы не удался: ${r.status}`);
  return r.json();
}

async function getDossier() {
  const r = await fetch(`${PY}/api/v1/library/research/dossier`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Owner-Key': OWNER },
    body: JSON.stringify({ heading: HEADING, topic: TOPIC }),
  });
  if (!r.ok) throw new Error(`досье не собралось: ${r.status}`);
  return r.json();
}

async function getStyle() {
  try {
    const r = await fetch(`${PY}/api/v1/library/style?limit=3`, {
      headers: { 'X-Owner-Key': STYLE_OWNER },
    });
    if (!r.ok) return [];
    return (await r.json()).samples || [];
  } catch {
    return [];
  }
}

const чисто = (t) => t.replace(/\s/g, '').length;

(async () => {
  console.log(`Тема работы: «${TOPIC}»`);
  console.log(`Раздел: «${HEADING}»`);
  console.log(`Модель: ${MODEL}\n`);

  const всего = Date.now();

  // --- 1. Разбор темы ---------------------------------------------
  let найдено = null;
  if (!has('skip-harvest')) {
    const t0 = Date.now();
    найдено = await harvest();
    console.log(`1. Разбор темы: найдено ${найдено.found}, прочитано целиком `
      + `${найдено.read} статей, ${найдено.chars} знаков — ${секунды(t0)} с`);
  } else {
    console.log('1. Разбор темы: пропущен, берём ранее прочитанное');
  }

  // --- 2. Досье под раздел ----------------------------------------
  let t0 = Date.now();
  const dossier = await getDossier();
  console.log(`2. Досье по разделу: ${dossier.excerpts} выдержек из `
    + `${dossier.sources.length} статей, ${dossier.chars} знаков — `
    + `${секунды(t0)} с`);
  console.log(`   нормы, на которые разрешено ссылаться: `
    + `${(dossier.norms || []).join(', ') || '— (значит, ссылки на номера запрещены)'}`);
  console.log(`   учёные из источников: `
    + `${(dossier.names || []).slice(0, 8).join(', ') || '—'}`);

  // --- 3. Черновик по досье ---------------------------------------
  t0 = Date.now();
  const draft = await ask([
    { role: 'system', content:
        'Ты пишешь раздел курсовой работы по юриспруденции. Научный '
        + 'язык, сплошной текст без списков и подзаголовков. Объём '
        + '5000-5500 знаков без пробелов.' },
    { role: 'system', content: dossierBlock(dossier) },
    { role: 'user', content:
        `Напиши раздел «${HEADING}» работы на тему «${TOPIC}».` },
  ]);
  const draftSec = секунды(t0);
  console.log(`3. Черновик: ${чисто(draft)} знаков без пробелов — ${draftSec} с`);

  // --- 4. Перепись в авторскую манеру -----------------------------
  const samples = await getStyle();
  if (!samples.length) {
    console.log('   ВНИМАНИЕ: образцов стиля нет, перепись пойдёт по '
      + 'общим правилам');
  }
  t0 = Date.now();
  const polished = await polishDraft(draft, {
    ask,
    style: styleRules(samples),
    onPiece: (i, n) => process.stdout.write(`\r4. Чистовик: кусок ${i}/${n}`),
  });
  const polishSec = секунды(t0);

  console.log(`\r4. Чистовик: ${чисто(polished.text)} знаков без пробелов, `
    + `${polished.pieces} кусков — ${polishSec} с`);
  console.log(`   переписей на бис ${polished.retries}, откатов к черновику `
    + `${polished.fallbacks}, усохших кусков ${polished.shortfalls}`);

  // --- Что получилось ---------------------------------------------
  const refs = (t) => [...t.matchAll(/\[(\d{1,2})(?:,[^\]]*)?\]/g)].length;
  const norms = (t) => [...extractFacts(t)].filter((f) => !/^\d{4}$/.test(f));
  const allowed = new Set(dossier.norms || []);
  const самовольные = norms(polished.text).filter((f) => !allowed.has(f));

  console.log('\nИТОГ');
  console.log(`  объём: ${чисто(draft)} → ${чисто(polished.text)} знаков без `
    + `пробелов (${Math.round((чисто(polished.text) / чисто(draft) - 1) * 100)} %)`);
  console.log(`  ссылок на источники: ${refs(draft)} → ${refs(polished.text)}`);
  console.log(`  фактуры потеряно при переписи: ${polished.lost.length}`
    + `${polished.lost.length ? ' — ' + polished.lost.join(', ') : ''}`);
  console.log(`  ссылок потеряно при переписи: ${polished.droppedRefs.length}`
    + `${polished.droppedRefs.length
      ? ' — ' + polished.droppedRefs.map((r) => `[${r}]`).join(', ') : ''}`);
  console.log(`  норм названо сверх разрешённых: ${самовольные.length}`
    + `${самовольные.length ? ' — ' + самовольные.join(', ') : ''}`);
  console.log(`  всего времени: ${секунды(всего)} с`);

  fs.writeFileSync(`${OUT}_draft.txt`, draft, 'utf8');
  fs.writeFileSync(`${OUT}_final.txt`, polished.text, 'utf8');
  console.log(`\nЧерновик: ${OUT}_draft.txt\nЧистовик: ${OUT}_final.txt`);
})().catch((e) => { console.error('Сорвалось:', e.message); process.exit(1); });
