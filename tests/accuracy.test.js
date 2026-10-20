'use strict';
// Правки заказчика по параграфу 1.1 курсовой об ипотеке: модельный текст
// против эталона. Эталон должен проходить локальные проверки точности,
// модельный — получать замечания.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { localChecks, rejectRevision } = require('../api/textreview');
const { lawMentions } = require('../api/lawregistry');
const { STEP_PROMPTS } = require('../api/prompts');

const dir = path.join(__dirname, 'fixtures');
const model = fs.readFileSync(path.join(dir, 'ипотека_1.1_модель.txt'), 'utf8');
const gold = fs.readFileSync(path.join(dir, 'ипотека_1.1_эталон.txt'), 'utf8');
const titles = (t) => localChecks(t, { kind: 'section' }).findings
  .filter((f) => f.group === 'Юридическая точность' || /длиннее 35/.test(f.title) || /не просто/.test(f.title))
  .map((f) => f.title);

test('модельный текст: категоричность, практика без акта, скобки, реквизиты, длинные фразы', () => {
  const t = titles(model).join(' | ');
  for (const re of [/Категоричные/, /практику без реквизитов/, /Несколько актов/, /Закон без реквизитов/, /длиннее 35/, /не просто/]) {
    assert.match(t, re);
  }
});

test('эталон заказчика проверки точности проходит', () => {
  assert.deepStrictEqual(titles(gold), []);
});

test('«договор об ипотеке» — термин, а не упоминание закона', () => {
  assert.deepStrictEqual(lawMentions('Договор об ипотеке заключается в письменной форме.'), []);
  assert.strictEqual(lawMentions('по ст. 9 Закона об ипотеке').length, 1);
  assert.strictEqual(lawMentions('Федеральный закон от 16.07.1998 № 102-ФЗ «Об ипотеке (залоге недвижимости)»')[0].withNum, true);
});

test('реквизиты закона из другого раздела засчитываются', () => {
  const f = localChecks('По ст. 9 Закона об ипотеке договор содержит предмет. '.repeat(3), {
    kind: 'section', others: [{ heading: '1.1', text: 'Федеральный закон от 16.07.1998 № 102-ФЗ «Об ипотеке (залоге недвижимости)».' }],
  }).findings;
  assert.ok(!f.some((x) => /Закон без реквизитов/.test(x.title)));
});

test('правка, которая по замечанию убирает отступление, не отвергается', () => {
  const before = 'а'.repeat(6000);
  const after = 'а'.repeat(4000);
  assert.ok(rejectRevision(before, after, [{ title: 'Нагромождение' }]));
  assert.strictEqual(rejectRevision(before, after, [{ title: 'Отступление за рамки параграфа', advice: 'убрать' }]), null);
});

test('промпты: точность важнее объёма, границы параграфа, без выдуманных сумм', () => {
  const base = STEP_PROMPTS.section_write;
  assert.match(base, /ЮРИДИЧЕСКАЯ ТОЧНОСТЬ ВАЖНЕЕ ОБЪЁМА/);
  assert.match(base, /Держись границ параграфа/);
  assert.match(base, /первом упоминании в работе — с полными реквизитами/);
  assert.doesNotMatch(base, /минимум 1-2 на главу/);
  assert.doesNotMatch(base, /Красный Октябрь/);
  assert.doesNotMatch(STEP_PROMPTS.section_expand, /пограничного случая|смежной отрасли/);
  assert.match(STEP_PROMPTS.section_expand, /ответь пустой строкой/);
});

test('жирные строки-подзаголовки убираются, жирное начало абзаца остаётся', () => {
  const { stripBoldHeadings } = require('../api/cleanup');
  const r = stripBoldHeadings('Вводная фраза.\n\n**Вещно-обязательственная природа**\n\nПравовая природа двойственна.\n\n**Обеспечительная функция** заключается в гарантии.');
  assert.strictEqual(r.removed, 1);
  assert.match(r.text, /\*\*Обеспечительная функция\*\* заключается/);
  assert.doesNotMatch(r.text, /Вещно-обязательственная природа\*\*/);
});

test('отсылки «относится к предмету параграфа 2.2» ловятся', () => {
  const t = 'Ипотека обеспечивает долг. Вопросы распределения выручки относятся к предмету параграфа 2.2 настоящей работы. Существенные условия рассматриваются в параграфе 2.1.';
  const f = localChecks(t, { kind: 'section' }).findings.find((x) => /Отсылки/.test(x.title));
  assert.ok(f);
  assert.strictEqual(f.quotes.length, 2);
});
