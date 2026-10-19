'use strict';
// Замечания заказчика к плану курсовой об ипотеке: объём, пересечения,
// реквизиты законов.
const test = require('node:test');
const assert = require('node:assert');
const { checkLawNames } = require('../api/lawregistry');
const { applyChapters, planSize, STEP_PROMPTS } = require('../api/prompts');

test('ловит «ФЗ-328 „О цифровых финансовых активах“»', () => {
  const p = checkLawNames('Нормативная база: ст. 13.1 Закона об ипотеке; ФЗ-328 «О цифровых финансовых активах»; дорожные карты.');
  assert.strictEqual(p.length, 1);
  assert.match(p[0].note, /259-ФЗ от 31\.07\.2020/);
  assert.strictEqual(p[0].found, '328-ФЗ');
});

test('верные реквизиты не трогает', () => {
  for (const t of [
    'Федеральный закон от 16.07.1998 № 102-ФЗ «Об ипотеке (залоге недвижимости)»',
    'ФЗ-218 «О государственной регистрации недвижимости»',
    'Закон РФ от 07.02.1992 № 2300-1 «О защите прав потребителей»',
    'Федеральный закон от 31.07.2020 № 259-ФЗ «О цифровых финансовых активах, цифровой валюте…»',
  ]) assert.deepStrictEqual(checkLawNames(t), [], t);
});

test('одинаковые номера разных законов не путает', () => {
  const t = 'Федеральный закон от 29.12.2012 № 273-ФЗ «Об образовании в Российской Федерации» и № 273-ФЗ «О противодействии коррупции». Федеральный закон от 26.06.2008 № 102-ФЗ «Об обеспечении единства измерений».';
  assert.deepStrictEqual(checkLawNames(t), []);
});

test('номер соседнего закона через точку с запятой или предложение не цепляет', () => {
  assert.deepStrictEqual(checkLawNames('Закон об ипотеке; Федеральный закон № 353-ФЗ «О потребительском кредите (займе)»'), []);
  assert.deepStrictEqual(checkLawNames('п. 5 ст. 61 Закона об ипотеке. Федеральный закон от 25.11.2017 № 328-ФЗ внёс изменения'), []);
});

test('ловит неверную дату при верном номере', () => {
  const p = checkLawNames('Федеральный закон от 16.07.1999 № 102-ФЗ «Об ипотеке (залоге недвижимости)»');
  assert.strictEqual(p.length, 1);
  assert.match(p[0].note, /16\.07\.1998/);
});

test('объём → число параграфов', () => {
  assert.deepStrictEqual([25, 30, 40].map((p) => planSize(p, null).sections), [4, 6, 9]);
  assert.strictEqual(planSize(25, null).chapters, 2);
  assert.strictEqual(planSize(null, null), null);
  // Явно заданные три главы — минимум по два параграфа.
  const f = planSize(25, 3);
  assert.strictEqual(f.sections, 6);
  assert.ok(f.forced);
});

test('промпт плана: объём, пересечения, реквизиты, без плейсхолдеров', () => {
  const t = applyChapters(STEP_PROMPTS.plan, null, 25);
  assert.match(t, /РОВНО 4 параграфа/);
  assert.match(t, /2 главы по 2 параграфа/);
  assert.match(t, /РОВНО ДВЕ/);
  assert.match(t, /не должны пересекаться/);
  assert.match(t, /Второстепенный сюжет/);
  assert.match(t, /Номер и дату указывай, только если/);
  assert.doesNotMatch(t, /35-50 тысяч/);
  for (const k of Object.keys(STEP_PROMPTS)) {
    assert.doesNotMatch(applyChapters(STEP_PROMPTS[k], null, null), /\{\{/, k);
  }
});

test('введение: методы исследования', () => {
  assert.match(STEP_PROMPTS.introduction, /Методы исследования/);
});

test('номер из перечня через запятую не приписывает соседнему закону', () => {
  assert.deepStrictEqual(checkLawNames('Нормативная база: ФЗ № 102-ФЗ, № 214-ФЗ, ГПК РФ, ФЗ «Об исполнительном производстве».'), []);
  // А длинное название с запятой внутри и номер после него — сверяет.
  const p = checkLawNames('Федеральный закон «О цифровых финансовых активах, цифровой валюте и о внесении изменений в отдельные законодательные акты Российской Федерации» от 25.11.2017 № 328-ФЗ');
  assert.strictEqual(p.length, 1);
});
