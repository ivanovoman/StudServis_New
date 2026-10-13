#!/usr/bin/env node
/**
 * Замер научного регистра на сыром выводе модели.
 *
 * Сервер должен быть запущен с REGISTER_FIX=0: тогда находки считаются,
 * но текст не правится, и видно, что пишет сама модель. Сравнивать
 * промпты по исправленному тексту нельзя — починка маскирует разницу.
 *
 *   REGISTER_FIX=0 npm start
 *   node tools/register-ab.js --label base --sections 1.1,2.1,3.1,3.3
 *
 * Тексты кладутся в incoming/ab/<метка>_<раздел>.txt (в git не идут),
 * сводка — на экран: находки сторожа на 1000 знаков по каждому разделу.
 * Читать тексты глазами всё равно нужно: сторож ловит только свой список.
 */
const fs = require('fs');
const path = require('path');
const { relaunchWithCA } = require('../api/ca.js');
if (relaunchWithCA(__filename)) return;

const { parseOutline, buildQueue } = require('../api/outline');
const { findColloquial } = require('../api/register');

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}

const BASE = arg('base', 'http://localhost:3000');
const LABEL = arg('label', 'run');
const WANT = String(arg('sections', '1.1,2.1,3.1,3.3')).split(',');
const OUT = arg('out', path.join(__dirname, '..', 'incoming', 'ab'));
const OWNER = arg('owner', 'bench-style-owner-001');

// План курсовой заказчика о Следственном комитете (названия разделов —
// из присланной работы).
const PLAN = `ВВЕДЕНИЕ
ГЛАВА 1. СЛЕДСТВЕННЫЙ КОМИТЕТ РОССИЙСКОЙ ФЕДЕРАЦИИ: СТАНОВЛЕНИЕ И ПРАВОВОЙ СТАТУС
1.1. Исторический путь становления следственных органов в России: от Петра I до выделения СК из состава прокуратуры
1.2. Правовой статус, задачи и принципы деятельности Следственного комитета на современном этапе
1.3. Система Следственного комитета и требования к сотрудникам: кадровая политика и антикоррупционные стандарты
ГЛАВА 2. ПОЛНОМОЧИЯ СЛЕДСТВЕННОГО КОМИТЕТА
2.1. Подследственность уголовных дел: разграничение компетенции со смежными органами (МВД, ФСБ)
2.2. Реализация функции уголовного преследования: особенности производства следственных действий и применения мер принуждения
2.3. Иные полномочия: процессуальный контроль, работа с обращениями граждан и международное сотрудничество
ГЛАВА 3. ПРОБЛЕМЫ И ПЕРСПЕКТИВЫ ДЕЯТЕЛЬНОСТИ СЛЕДСТВЕННОГО КОМИТЕТА
3.1. Проблема обеспечения реальной независимости следователя от ведомственного руководства
3.2. Споры о компетенции и конфликты с прокуратурой: вопросы надзора за следствием
3.3. Перспективы развития: цифровизация предварительного расследования и возможные изменения правового статуса СКР
ЗАКЛЮЧЕНИЕ`;

const SETTINGS = {
  topic: 'Следственный комитет Российской Федерации: правовой статус, полномочия и проблемы деятельности',
  workType: 'курсовая',
  discipline: 'Уголовный процесс',
};

async function writeSection(task) {
  const r = await fetch(`${BASE}/api/section`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: PLAN, settings: SETTINGS, task, written: [], ownerKey: OWNER }),
  });
  if (!r.ok) throw new Error(`сервер ответил ${r.status}: ${await r.text()}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let piece = null;
  const events = { disclaimer: 0, expanding: 0 };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const p of parts) {
      const raw = p.replace(/^data:\s*/, '').trim();
      if (!raw || raw === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(raw); } catch { continue; }
      if (ev.error) throw new Error(ev.error);
      if (ev.disclaimer) events.disclaimer += ev.disclaimer.removed;
      if (ev.expanding) events.expanding += 1;
      if (ev.piece) piece = ev.piece;
    }
  }
  if (!piece) throw new Error('раздел не пришёл');
  return { text: piece.text, events };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const queue = buildQueue(parseOutline(PLAN), { introduction: false, conclusion: false });
  let totalHits = 0;
  let totalLen = 0;
  for (const num of WANT) {
    const task = queue.find((t) => t.number === num);
    if (!task) { console.log(`${num}: нет в плане`); continue; }
    const t0 = Date.now();
    try {
      const { text, events } = await writeSection(task);
      const hits = findColloquial(text);
      const len = text.replace(/\s/g, '').length;
      totalHits += hits.length;
      totalLen += len;
      const file = path.join(OUT, `${LABEL}_${num}.txt`);
      fs.writeFileSync(file, text);
      console.log(`${LABEL} ${num}: ${len} зн., находок ${hits.length} `
        + `(${((hits.length / len) * 1000).toFixed(2)}/1000), оговорок ${events.disclaimer}, `
        + `доборов ${events.expanding}, ${Math.round((Date.now() - t0) / 1000)} с`);
      console.log(`   ${hits.map((h) => h.match).join(' | ')}`);
    } catch (e) {
      console.log(`${LABEL} ${num}: ошибка — ${e.message}`);
    }
  }
  if (totalLen) {
    console.log(`\nИТОГО ${LABEL}: ${totalHits} находок на ${totalLen} зн. = `
      + `${((totalHits / totalLen) * 1000).toFixed(2)} на 1000 зн.`);
  }
})();
