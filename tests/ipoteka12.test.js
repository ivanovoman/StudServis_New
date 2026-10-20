'use strict';
// Правки заказчика по параграфу 1.2 «Предмет ипотеки, основания её
// возникновения и государственная регистрация»: модель приписала статьям
// Закона об ипотеке чужой предмет, взяла перечень из старой редакции ст. 5,
// писала про «практику банков», сроки в днях и МФЦ, «забыл» в кавычках.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { localChecks } = require('../api/textreview');
const { articleRefs, tocProblems, tocHint, reviewTitles, loadToc, LAWS } = require('../api/lawtoc');
const { STEP_PROMPTS } = require('../api/prompts');

const dir = path.join(__dirname, 'fixtures');
const model = fs.readFileSync(path.join(dir, 'ипотека_1.2_модель.txt'), 'utf8');
const gold = fs.readFileSync(path.join(dir, 'ипотека_1.2_эталон.txt'), 'utf8');
const strict = (t) => localChecks(t, { kind: 'section' }).findings
  .filter((f) => ['Юридическая точность', 'Научный стиль'].includes(f.group))
  .map((f) => f.title);

test('1.2 модель: практика, расчёт, кавычки, процедура, закон без даты', () => {
  const t = strict(model).join(' | ');
  for (const re of [/Оценки практики/, /Числовой пример/, /ироничных кавычках/, /Процедурные/, /без даты/]) {
    assert.match(t, re);
  }
});

test('1.2 эталон заказчика проходит проверки точности и стиля', () => {
  assert.deepStrictEqual(strict(gold), []);
});

test('«как правило» — не оценка практики, «термин «залог»» — не ирония', () => {
  const t = 'Как правило, залог участка распространяется на здания залогодателя. '
    + 'Термин «ипотека» означает залог недвижимости.';
  assert.deepStrictEqual(strict(t), []);
});

test('устаревшие ЕГРП и ГКН ловятся, с оговоркой «до 2017» — нет', () => {
  const bad = localChecks('Запись об ипотеке вносится в ЕГРП по заявлению сторон договора.', { kind: 'section' });
  assert.ok(bad.findings.some((f) => /Устаревшие/.test(f.title)));
  const ok = localChecks('До 2017 года запись об ипотеке вносилась в ЕГРП по заявлению сторон.', { kind: 'section' });
  assert.ok(!ok.findings.some((f) => /Устаревшие/.test(f.title)));
});

test('оглавление Закона об ипотеке загружается из backend/…/toc', () => {
  const toc = loadToc(LAWS[0]);
  assert.ok(Object.keys(toc).length >= 90);
  assert.match(toc['64.2'], /кредитных средств/);
  assert.match(toc['54.1'], /отказа в обращении взыскания/);
  assert.match(toc['5'], /предметом ипотеки/);
});

test('ссылки на статьи закона находятся в обоих порядках и в перечнях', () => {
  const nums = (t) => articleRefs(t).map((r) => r.article);
  assert.deepStrictEqual(nums(model), ['5', '54.1', '61', '77', '64.2', '9', '10']);
  assert.deepStrictEqual(nums(gold), ['5', '62', '63', '64', '7', '77', '9', '10', '11']);
  // Ссылка на кодекс между номером и названием закона — не про закон.
  assert.deepStrictEqual(nums('ст. 446 ГПК РФ, а также Закона об ипотеке'), []);
});

test('несуществующая и утратившая силу статья — проблема', () => {
  const p = tocProblems('Согласно ст. 21 Закона об ипотеке и ст. 99 Закона об ипотеке.');
  assert.deepStrictEqual(p.map((x) => x.status), ['mismatch', 'missing']);
  assert.deepStrictEqual(tocProblems(gold), []);
});

test('рецензенту даются настоящие заголовки статей', () => {
  const r = reviewTitles(model);
  assert.match(r, /ст\. 64\.2 Закона об ипотеке — «Ипотека земельного участка, на котором находятся здания/);
  assert.match(r, /бюджетные средства/);
});

test('в задание модели попадает оглавление, если тема об ипотеке', () => {
  const h = tocHint('Ипотека как способ обеспечения исполнения обязательств');
  assert.match(h, /ст\. 5 — Имущество, которое может быть предметом ипотеки/);
  assert.doesNotMatch(h, /Утратила силу/);
  assert.strictEqual(tocHint('Коллизии в трудовом праве'), '');
});

test('BASE_ROLE: действующая редакция, норма к ограничению, без инструкций и практики', () => {
  const base = STEP_PROMPTS.section_write;
  assert.match(base, /действующую редакцию/);
  assert.match(base, /Ограничение или исключение называй вместе с нормой/);
  assert.match(base, /на практике/);
  assert.match(base, /Анализ, а не инструкция/);
});

test('содержание ст. 5 — по действующей редакции: машино-места есть, дач нет', () => {
  const h = tocHint('Предмет ипотеки');
  assert.match(h, /ст\. 5 \(содержание\):[^\n]*машино-места/);
  assert.match(h, /«Дачи»[^\n]*исключены/);
  assert.match(h, /ст\. 7 \(содержание\):[^\n]*без согласия остальных/);
});
