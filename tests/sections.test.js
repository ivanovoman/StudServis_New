'use strict';

const test = require('node:test');
const assert = require('node:assert');
const L = require('../public/sections-logic');
const { parseOutline, buildQueue } = require('../api/outline');
const { createSourcePins, pinKeys, foundFromList } = require('../api/worksources');

const PLAN = [
  'ВВЕДЕНИЕ',
  'ГЛАВА 1. ТЕОРЕТИЧЕСКИЕ ОСНОВЫ ЕДИНОГО НАЛОГОВОГО СЧЁТА',
  '1.1. Понятие и правовая природа единого налогового счёта',
  '1.2. Сальдо и порядок зачёта переплаты',
  'ГЛАВА 2. ПРАКТИКА ПРИМЕНЕНИЯ',
  '2.1. Возврат положительного сальдо',
  '2.2. Судебные споры о распределении платежей',
  '2.3. Предложения по совершенствованию',
  'ЗАКЛЮЧЕНИЕ',
  'СПИСОК ЛИТЕРАТУРЫ',
].join('\n');

function navFor(plan) {
  return L.buildNav(buildQueue(parseOutline(plan)));
}

test('кнопки идут в порядке готовой работы: от титула до списка литературы', () => {
  const ids = navFor(PLAN).map((i) => i.id);
  assert.deepStrictEqual(ids, [
    'title', 'toc', 'intro',
    'ch1', 's1.1', 's1.2',
    'ch2', 's2.1', 's2.2', 's2.3',
    'concl', 'refs',
  ]);
});

test('глава — отдельная кнопка с параграфами, название главы из плана', () => {
  const nav = navFor(PLAN);
  const ch2 = nav.find((i) => i.id === 'ch2');
  assert.strictEqual(ch2.writable, false);
  assert.deepStrictEqual(ch2.children, ['s2.1', 's2.2', 's2.3']);
  assert.match(ch2.label, /^Глава 2\. /);
  assert.match(ch2.label, /практика применения/i);
  const s = nav.find((i) => i.id === 's1.2');
  assert.strictEqual(s.level, 2);
  assert.strictEqual(s.label, '1.2. Сальдо и порядок зачёта переплаты');
});

test('позиция части совпадает с местом в очереди — по ней сервер заменяет раздел', () => {
  const queue = buildQueue(parseOutline(PLAN));
  const nav = L.buildNav(queue);
  for (const item of nav.filter((i) => i.writable)) {
    assert.strictEqual(queue[item.position], item.task);
  }
});

test('глава без параграфов сама становится разделом для письма', () => {
  const nav = navFor('ВВЕДЕНИЕ\nГЛАВА 1. ОБЩИЕ ПОЛОЖЕНИЯ\nГЛАВА 2. ПРАКТИКА\n2.1. Споры\n2.2. Итоги\nЗАКЛЮЧЕНИЕ');
  const ch1 = nav.find((i) => i.id === 'ch1');
  assert.strictEqual(ch1.writable, true);
  assert.strictEqual(L.pieceKind(ch1), 'section');
  assert.strictEqual(nav.find((i) => i.id === 'ch2').writable, false);
});

test('нормы объёма: введение 3800–5000, раздел 5000–6000', () => {
  assert.deepStrictEqual(L.targetFor('introduction'), { min: 3800, max: 5000 });
  assert.deepStrictEqual(L.targetFor('section'), { min: 5000, max: 6000 });
  assert.strictEqual(L.volumeState('introduction', 3799), 'short');
  assert.strictEqual(L.volumeState('introduction', 4200), 'ok');
  assert.strictEqual(L.volumeState('section', 6100), 'long');
  assert.strictEqual(L.chars('а б\nв'), 3);
});

test('список литературы — только то, на что ссылается текст, по алфавиту', () => {
  const sources = [
    { title: 'B', gost: 'Smith J. Tax accounts // Journal. 2022.' },
    { title: 'Я', gost: 'Яковлев А. А. Сальдо ЕНС // Налоги. 2023. № 2. С. 5–9.' },
    { title: 'А', gost: 'Алексеев Б. Б. Единый счёт // Финансовое право. 2024. № 1.' },
  ];
  const r = L.bibliographyFrom(sources, ['См. [2] и [1, с. 15].', 'Ещё [2].']);
  assert.deepStrictEqual(r.entries, [
    'Яковлев А. А. Сальдо ЕНС // Налоги. 2023. № 2. С. 5–9.',
    'Smith J. Tax accounts // Journal. 2022.',
  ]);
  assert.deepStrictEqual(r.unused, [{ n: 3, title: 'А' }]);
  assert.deepStrictEqual(r.missing, []);
});

test('без единой ссылки в тексте в список идут все найденные публикации', () => {
  const r = L.bibliographyFrom([{ gost: 'Б.' }, { gost: 'А.' }], ['текст без сносок']);
  assert.deepStrictEqual(r.entries, ['А.', 'Б.']);
});

test('ссылка на номер за пределами списка помечается как выдуманная', () => {
  const r = L.bibliographyFrom([{ gost: 'А.' }], ['[1] и [7]']);
  assert.deepStrictEqual(r.missing, [7]);
});

test('титул: незаполненные студент и руководитель — подчёркнутое место', () => {
  const lines = L.titleLines({ topic: 'Единый налоговый счёт.', university: 'МФЮА', year: 2026 });
  const text = lines.map((l) => l.text);
  assert.ok(text.includes('«Единый налоговый счёт»'));
  assert.ok(text.includes('Выполнил(а): ____________________'));
  assert.ok(text.includes('Руководитель: ____________________'));
  assert.strictEqual(text[text.length - 1], 'Москва – 2026');
  assert.strictEqual(lines.find((l) => l.text === 'МФЮА').caps, true);
});

test('содержание перечисляет все разделы плана с отметкой готовности', () => {
  const nav = navFor(PLAN);
  const intro = nav.find((i) => i.id === 'intro');
  const lines = L.contentsLines(nav, { [intro.position]: { text: 'x' } });
  assert.strictEqual(lines[0].text, 'ВВЕДЕНИЕ');
  assert.strictEqual(lines[0].written, true);
  assert.match(lines[1].text, /^ГЛАВА 1\. /);
  assert.strictEqual(lines[1].written, null);
  assert.strictEqual(lines[2].written, false);
  assert.strictEqual(lines[lines.length - 1].text, 'СПИСОК ЛИТЕРАТУРЫ');
});

// ------------------------------------------------ закрепление источников

test('источники закрепляются за работой и живут ограниченный срок', () => {
  let t = 0;
  const pins = createSourcePins({ ttlMs: 1000, max: 2, now: () => t });
  pins.set('w:1', { sources: [1] });
  assert.deepStrictEqual(pins.get('w:1'), { sources: [1] });
  t = 1500;
  assert.strictEqual(pins.get('w:1'), null);
  pins.set('a', 1); pins.set('b', 2); pins.set('c', 3);
  assert.strictEqual(pins.size(), 2);
  assert.strictEqual(pins.get('a'), null);
});

test('ключи: по номеру работы и по паре «владелец + тема»', () => {
  assert.deepStrictEqual(pinKeys({ workId: 7, ownerKey: 'k', topic: ' ЕНС ' }), ['w:7', 't:k|енс']);
  assert.deepStrictEqual(pinKeys({ topic: 'ЕНС' }), []);
});

test('список от клиента даёт блок промпта с теми же номерами', () => {
  const found = foundFromList([
    { title: 'Сальдо ЕНС', authors: ['Яковлев А.', 'Иванов Б.', 'Петров В.'], year: 2023, venue: 'Налоги' },
    { title: '' },
    { title: 'Tax accounts', year: 'x' },
  ]);
  assert.strictEqual(found.count, 2);
  assert.match(found.prompt_block, /^\[1\] Сальдо ЕНС\n {4}Яковлев А\., Иванов Б\., 2023, Налоги/);
  assert.match(found.prompt_block, /\[2\] Tax accounts\n {4}автор не указан, год не указан/);
  assert.ok(!/undefined/.test(found.prompt_block));
  assert.strictEqual(foundFromList([]), null);
  assert.strictEqual(foundFromList('мусор'), null);
});
