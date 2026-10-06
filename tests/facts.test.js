const test = require('node:test');
const assert = require('node:assert');
const { extractFacts, lostFacts } = require('../api/facts.js');

test('ловит сокращённую запись нормы', () => {
  const f = extractFacts('Согласно ст. 105 УК РФ и ч. 3 ст. 17 закона.');
  assert.ok(f.has('ст. 105'));
  assert.ok(f.has('ч. 3'));
  assert.ok(f.has('ст. 17'));
  assert.ok(f.has('УК РФ'));
});

test('ловит норму, написанную словом', () => {
  const f = extractFacts('В статье 76 Конституции РФ, а также в пункте 2 и части 4.');
  assert.ok(f.has('ст. 76'), 'статья словом');
  assert.ok(f.has('п. 2'), 'пункт словом');
  assert.ok(f.has('ч. 4'), 'часть словом');
  assert.ok(f.has('Конституция РФ'));
});

test('сокращение и слово — одна и та же фактура', () => {
  assert.deepStrictEqual(
    [...extractFacts('ст. 15 ГК РФ')],
    [...extractFacts('статьей 15 ГК РФ')]
  );
});

test('смена падежа при переписи не считается потерей', () => {
  const было = 'Согласно ст. 15 Конституции РФ договор имеет приоритет.';
  const стало = 'Как указано в статье 15 Конституции Российской Федерации, приоритет за договором.';
  assert.deepStrictEqual(lostFacts(было, стало), []);
});

test('настоящая потеря нормы видна', () => {
  const было = 'Применяются ст. 1193 и ст. 1210 ГК РФ.';
  const стало = 'Применяется ст. 1193 ГК РФ.';
  assert.deepStrictEqual(lostFacts(было, стало), ['ст. 1210']);
});

test('номера актов и годы', () => {
  const f = extractFacts('Закон № 184-ФЗ, постановление №1-П от 2003 года.');
  assert.ok(f.has('№184-ФЗ'));
  assert.ok(f.has('№1-П'));
  assert.ok(f.has('2003'));
});

test('пустой текст не ломает', () => {
  assert.strictEqual(extractFacts('').size, 0);
  assert.deepStrictEqual(lostFacts('', ''), []);
});
