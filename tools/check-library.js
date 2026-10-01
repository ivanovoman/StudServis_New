/**
 * Проверка библиотеки материалов.
 *
 * Главное здесь — не интерфейс, а то, что загруженный документ
 * действительно доходит до модели. Поэтому проверка кладёт в
 * библиотеку текст с приметой, которой модель знать не может, и
 * смотрит, появится ли эта примета в написанном разделе.
 *
 * Запуск: node tools/check-library.js    (LIVE=0 — без модели)
 */
'use strict';

const { JSDOM } = require('jsdom');

const BASE = process.env.BASE || 'http://localhost:3000';
const LIVE = process.env.LIVE !== '0';
const OWNER = 'check-library-owner-' + Date.now();

function ok(cond, text) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + text);
  if (!cond) process.exitCode = 1;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Приметы намеренно выдуманы: если они окажутся в тексте раздела,
// значит он написан с опорой на загруженный файл, а не на общие
// знания модели.
const MATERIAL = `Конспект по теории коллизионного права

Доктрина опережающего согласования

Профессор Коколов формулирует правило опережающего согласования: при
противоречии актов равной силы правоприменитель обязан сначала
проверить, нет ли в более позднем акте переходной оговорки, и только
затем применять правило lex posterior.

Трёхзвенная классификация коллизий

Коллизии делятся на три звена: явные, латентные и мнимые. Явная видна
из текста актов. Латентная обнаруживается лишь при правоприменении,
когда нормы формально совместимы, но дают несовместимый результат.
Мнимая снимается обычным толкованием.

Требования кафедры к объёму раздела

Каждый параграф курсовой работы на кафедре должен составлять не менее
пяти тысяч знаков без пробелов. Сноски оформляются постранично,
Times New Roman, кегль 12.
`;

async function api(path, opts = {}) {
  const headers = Object.assign({ 'X-Owner-Key': OWNER }, opts.headers || {});
  return globalThis.fetch(BASE + path, Object.assign({}, opts, { headers }));
}

(async () => {
  console.log('\nЗагрузка материала');
  const form = new FormData();
  form.append('file', new Blob([MATERIAL], { type: 'text/plain' }),
    'конспект.txt');

  const up = await api('/api/v1/library/upload?kind='
    + encodeURIComponent('конспект'), { method: 'POST', body: form });
  ok(up.ok, `загрузка ответила ${up.status}`);
  const doc = await up.json();
  ok(doc.chunks >= 3, `документ нарезан на ${doc.chunks} фрагментов`);

  console.log('\nСписок материалов');
  const listRes = await api('/api/v1/library');
  const list = await listRes.json();
  ok(list.count === 1, `в библиотеке документов: ${list.count}`);
  ok(list.documents[0].kind === 'конспект',
    `вид материала сохранён: ${list.documents[0].kind}`);

  console.log('\nПоиск по библиотеке');
  const cases = [
    ['как делятся коллизии на виды', 'латентн'],
    ['какой объём параграфа требует кафедра', 'пяти тысяч'],
    ['как оформлять сноски', 'постранично'],
  ];
  for (const [query, expect] of cases) {
    const r = await api('/api/v1/library/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: 1 }),
    });
    const data = await r.json();
    const text = data.hits && data.hits[0] ? data.hits[0].text : '';
    ok(text.toLowerCase().includes(expect),
      `«${query}» → нашёлся нужный фрагмент`);
  }

  console.log('\nЧужие материалы не видны');
  const alien = await globalThis.fetch(BASE + '/api/v1/library', {
    headers: { 'X-Owner-Key': 'someone-else-key-9999' },
  });
  const alienData = await alien.json();
  ok(alienData.count === 0,
    `у другого владельца документов: ${alienData.count}`);

  console.log('\nЭкран «Мои материалы»');
  const dom = await JSDOM.fromURL(BASE + '/modern.html', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
  });
  await new Promise((r) => dom.window.addEventListener('load', r));
  const { window } = dom;
  window.fetch = (url, opts) => globalThis.fetch(new URL(String(url), BASE), opts);
  await wait(300);

  ok(!!window.ModernLibrary, 'модуль библиотеки загрузился');
  const cards = [...window.document.querySelectorAll('.card')];
  ok(cards.length >= 10, `карточек в меню: ${cards.length}`);
  const card = cards[9];
  ok(card.textContent.includes('Мои материалы'),
    'карточка 10: ' + card.querySelector('h3').textContent);

  card.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(400);
  const sheet = window.document.querySelector('.sheet');
  ok(!!sheet && /материал/i.test(sheet.textContent), 'окно открылось');
  ok(!!sheet.querySelector('input[type=file]'), 'есть выбор файла');
  ok(!!sheet.querySelector('select'), 'есть выбор вида материала');

  dom.window.close();

  if (!LIVE) {
    console.log('\nLIVE=0 — живой прогон модели пропущен');
    await api('/api/v1/library/' + doc.id, { method: 'DELETE' });
    return;
  }

  console.log('\nГлавное: материал доходит до модели');
  const body = {
    plan: 'Глава 1. Понятие и виды юридических коллизий. '
      + '1.1. Понятие коллизии. 1.2. Классификация коллизий. '
      + 'Глава 2. Разрешение коллизий. 2.1. Правила приоритета.',
    settings: { topic: 'Коллизии в праве', university: 'МФЮА', chapters: 2 },
    task: {
      kind: 'section', number: '1.2',
      heading: 'Классификация юридических коллизий',
      title: 'Классификация юридических коллизий',
      brief: 'Виды коллизий, основания деления, подходы в доктрине',
      position: 2,
    },
    written: [],
    ownerKey: OWNER,
  };

  const started = Date.now();
  const res = await globalThis.fetch(BASE + '/api/section', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  let piece = null;
  let error = null;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const ev = JSON.parse(payload);
      if (ev.piece) piece = ev.piece;
      if (ev.error) error = ev.error;
    } catch { /* keep-alive */ }
  }

  if (!piece) {
    ok(false, 'раздел не написан' + (error ? ': ' + error : ''));
    await api('/api/v1/library/' + doc.id, { method: 'DELETE' });
    return;
  }

  const spent = Math.round((Date.now() - started) / 1000);
  ok(piece.chars > 4000, `раздел написан: ${piece.chars} знаков за ${spent} с`);

  const used = /опережающ|латентн|мнима|Коколов/i.test(piece.text);
  ok(used, 'в тексте видны приметы загруженного материала');

  const markers = piece.text.match(/\[\s*[МM]\s*\d+\s*\]/g);
  ok(!markers,
    'служебных пометок материалов в тексте нет'
    + (markers ? ` (найдено ${markers.length})` : ''));

  console.log('\nУборка');
  const del = await api('/api/v1/library/' + doc.id, { method: 'DELETE' });
  ok(del.ok, 'материал удалён');
  const after = await (await api('/api/v1/library')).json();
  ok(after.count === 0, 'библиотека пуста');

  console.log('\nВсё сходится.');
})().catch((e) => {
  console.error('\nПроверка упала:', e.message);
  process.exitCode = 1;
});
