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

// --- вёрстка: то, что сломалось на живой сборке ----------------------

const { buildBibliography } = require('../api/docxExport');
const JSZip = require('jszip');
const { Document, Packer } = require('docx');

async function renderText(blocks) {
  const doc = new Document({ sections: [{ children: blocks }] });
  const buf = await Packer.toBuffer(doc);
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml').async('string');
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);
}

test('тире в страницах не превращается в дефис', async () => {
  // Правило «между цифрами — дефис» верно для обычного текста
  // («2025-2026 гг.»), но библиографию по ГОСТу оно портит.
  const texts = await renderText(
    buildBibliography(['Рябов, С. И. Работа // Право. – 2024. – С. 301–304.']));
  assert.ok(texts.some((t) => t.includes('С. 301–304')));
  assert.ok(!texts.some((t) => t.includes('С. 301-304')));
});

test('список сортируется, русские перед латинскими', async () => {
  const texts = await renderText(buildBibliography([
    'Koshel, A. S. Digital platforms.',
    'Яковлев, И. И. Работа.',
    'Аверин, П. П. Труд.',
  ]));
  const joined = texts.join('\n');
  assert.ok(joined.indexOf('Аверин') < joined.indexOf('Яковлев'));
  assert.ok(joined.indexOf('Яковлев') < joined.indexOf('Koshel'));
});

test('дубликаты в списке схлопываются', async () => {
  const texts = await renderText(buildBibliography([
    'Иванов, И. И. Работа.', 'Иванов, И. И. Работа.',
  ]));
  const count = texts.filter((t) => t.includes('Иванов')).length;
  assert.strictEqual(count, 1);
});

test('готовая нумерация не удваивается', async () => {
  const texts = await renderText(buildBibliography(['1. Иванов, И. И. Работа.']));
  assert.ok(texts.some((t) => t.startsWith('1. Иванов')));
  assert.ok(!texts.some((t) => t.includes('1. 1.')));
});
