/**
 * Разбор маркеров ссылок в тексте.
 *
 * Модель ставит [3] или [3, с. 45]; полное описание статьи она не
 * пишет никогда — реквизиты подставляются из метаданных баз.
 */
const assert = require('node:assert');
const { test } = require('node:test');
const { parseMarkers, hasMarkers, stripMarkers } = require('../api/footnotes');

test('простой маркер превращается в ссылку', () => {
  const { parts, used } = parseMarkers('Коллизия есть противоречие [1].', 3);
  assert.deepStrictEqual(used, [1]);
  assert.strictEqual(parts.filter((p) => p.type === 'ref').length, 1);
});

test('маркер с указанием страницы', () => {
  const { parts } = parseMarkers('Автор уточняет [2, с. 205].', 3);
  const ref = parts.find((p) => p.type === 'ref');
  assert.strictEqual(ref.source, 2);
  assert.strictEqual(ref.page, '205');
});

test('ссылка на несуществующий источник удаляется', () => {
  // Модель пишет [12], когда источников восемь. Оставить маркер хуже,
  // чем убрать: читатель решит, что сноска потерялась.
  const { parts, used } = parseMarkers('Текст [9] дальше.', 3);
  assert.deepStrictEqual(used, []);
  assert.ok(!parts.some((p) => p.type === 'ref'));
  assert.ok(!parts.map((p) => p.text).join('').includes('[9]'));
});

test('несколько ссылок подряд сохраняют порядок', () => {
  const { used } = parseMarkers('Первое [1], второе [3], снова [1].', 3);
  assert.deepStrictEqual(used, [1, 3, 1]);
});

test('текст без маркеров остаётся цел', () => {
  const { parts, used } = parseMarkers('Обычное рассуждение автора.', 3);
  assert.deepStrictEqual(used, []);
  assert.strictEqual(parts[0].text, 'Обычное рассуждение автора.');
});

test('hasMarkers отличает текст со ссылками', () => {
  assert.ok(hasMarkers('Позиция изложена [2].'));
  assert.ok(!hasMarkers('Позиция изложена в литературе.'));
});

test('stripMarkers убирает ссылки и лишние пробелы', () => {
  assert.strictEqual(stripMarkers('Так считает автор [2].'), 'Так считает автор.');
});

test('квадратные скобки не из ссылок не трогаются', () => {
  const text = 'Помета [нужно проверить: номер дела] остаётся.';
  const { parts } = parseMarkers(text, 5);
  assert.strictEqual(parts.map((p) => p.text || '').join(''), text);
});
