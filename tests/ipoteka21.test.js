'use strict';
// Правки заказчика по параграфу 2.1 «Содержание договора ипотеки и права
// и обязанности его участников»: модель пересказывала выдуманные споры
// («в споре, где залогодатель снёс несущую стену… суды удовлетворили»),
// писала о практике банков, ссылалась на общие нормы ГК вместо статей
// Закона об ипотеке (30, 31, 34, 37–40, 43, 44) и путала последствия
// нарушений. Заказчик добавил маркированный список и таблицу 3.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { localChecks, proseOnly } = require('../api/textreview');
const { articleRefs, tocHint } = require('../api/lawtoc');
const { STEP_PROMPTS } = require('../api/prompts');
const { generateFullDocx } = require('../api/docxExport');

const dir = path.join(__dirname, 'fixtures');
const model = fs.readFileSync(path.join(dir, 'ипотека_2.1_модель.txt'), 'utf8');
const gold = fs.readFileSync(path.join(dir, 'ипотека_2.1_эталон.txt'), 'utf8');
const strict = (t) => localChecks(t, { kind: 'section' }).findings
  .filter((f) => ['Юридическая точность', 'Научный стиль', 'Ритм'].includes(f.group));

test('2.1 модель: пересказ споров, практика банков, выдуманный адрес', () => {
  const f = strict(model);
  const vague = f.find((x) => /практику без реквизитов/.test(x.title));
  assert.ok(vague && vague.quotes.length >= 4, JSON.stringify(vague));
  assert.ok(f.some((x) => /Оценки практики/.test(x.title)));
  assert.ok(f.some((x) => /выдуманным адресом/.test(x.title)));
});

test('2.1 эталон заказчика (со списком и таблицей) проходит все проверки стиля и точности', () => {
  assert.deepStrictEqual(strict(gold).map((x) => x.title), []);
});

test('строки таблицы, подпись, «Источник» и пункты списка — не предложения', () => {
  const p = proseOnly(gold);
  assert.doesNotMatch(p, /\|/);
  assert.doesNotMatch(p, /^Таблица 3/m);
  assert.doesNotMatch(p, /^Источник:/m);
  assert.doesNotMatch(p, /^- какое имущество/m);
  assert.ok(localChecks(gold, { kind: 'section' }).metrics.medianWords <= 15);
});

test('ссылка на закон после ссылки на кодекс не теряется', () => {
  assert.deepStrictEqual(articleRefs(model).map((r) => r.article), ['9', '37', '43']);
  assert.deepStrictEqual(articleRefs('Ст. 342 ГК РФ и ст. 43 Закона об ипотеке допускают это.').map((r) => r.article), ['43']);
});

test('в задании модели — проверенное содержание статей о правах и обязанностях сторон', () => {
  const h = tocHint('Ипотека как способ обеспечения');
  assert.match(h, /ст\. 30 \(содержание\):[^\n]*исправном состоянии/);
  assert.match(h, /ст\. 39 \(содержание\):[^\n]*независимо от того, кому оно принадлежит/);
  assert.match(h, /ст\. 40 \(содержание\):[^\n]*не превышает срока обеспеченного обязательства/);
  assert.match(h, /ст\. 43 \(содержание\):[^\n]*признан судом недействительным/);
  assert.match(h, /ст\. 29 \(содержание\):[^\n]*ничтожны/);
});

test('промпт: специальная статья важнее общей нормы, без пересказа споров, список и таблица по образцу', () => {
  const w = STEP_PROMPTS.section_write;
  assert.match(w, /специальной статьёй базового закона/);
  assert.match(w, /Не пересказывай судебные споры/);
  assert.match(w, /СПИСОК И ТАБЛИЦА/);
  assert.match(w, /Источник: составлено автором на основе/);
});

async function docLines(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml').async('string');
  return {
    xml,
    lines: xml.split('</w:p>')
      .map((p) => [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''))
      .filter(Boolean),
  };
}

test('docx: список, таблица с подписью и источником, сквозная нумерация таблиц', async () => {
  const second = 'Виды ипотеки приведены в таблице 1.\n\nТаблица 1. Виды ипотеки\n\n'
    + '| Вид | Основание |\n|---|---|\n| Договорная | Договор |\n| Законная | Закон |\n\n'
    + 'Источник: составлено автором на основе ГК РФ.\n\nТаким образом, видов два.';
  const buf = await generateFullDocx({
    topic: 'Ипотека',
    introduction: 'Введение.',
    conclusion: 'Заключение.',
    sections: [{ number: '2.1', text: gold }, { number: '2.2', text: second }],
    sectionTitles: { 2.1: 'Договор', 2.2: 'Виды' },
  });
  const { xml, lines } = await docLines(buf);
  assert.ok(lines.includes('– какое имущество передается в залог;'), lines.slice(0, 20).join('\n'));
  assert.ok(lines.includes('Таблица № 1. Права и обязанности участников договора ипотеки'));
  assert.ok(lines.some((l) => /приведены в таблице № 1\./.test(l)));
  assert.ok(lines.includes('Таблица № 2. Виды ипотеки'));
  assert.ok(lines.some((l) => /Виды ипотеки приведены в таблице № 2\./.test(l)));
  assert.ok(lines.some((l) => /^Источник: составлено/.test(l)));
  assert.strictEqual((xml.match(/<w:tbl>/g) || []).length, 2);
  assert.ok(!lines.some((l) => l.includes('|')));
});

test('примеры с выдуманными суммами и адресами удаляются, эталоны не трогаются', () => {
  const { dropInventedExamples } = require('../api/cleanup');
  const r = dropInventedExamples(model);
  assert.strictEqual(r.removed, 1);
  assert.doesNotMatch(r.text, /Тверская|Москва/);
  const calc = 'Требования удовлетворяются по очереди. Например, если квартира продана за 5 млн рублей, а долг составляет 4,5 млн, второй получит 500 тыс. рублей. Это правило важно.';
  assert.strictEqual(dropInventedExamples(calc).text, 'Требования удовлетворяются по очереди. Это правило важно.');
  for (const f of ['ипотека_1.1_эталон.txt', 'ипотека_1.2_эталон.txt', 'ипотека_2.1_эталон.txt']) {
    assert.strictEqual(dropInventedExamples(fs.readFileSync(path.join(dir, f), 'utf8')).removed, 0, f);
  }
  const plain = 'Например, собственник вправе проживать в заложенной квартире.';
  assert.strictEqual(dropInventedExamples(plain).text, plain);
});
