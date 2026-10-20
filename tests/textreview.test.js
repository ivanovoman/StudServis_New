'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { localChecks, rhythm, parseReview, rejectRevision, reviseMessages, briefStems } = require('../api/textreview');

const pick = (r, group) => r.findings.filter((f) => f.group === group);

// Нормальный научный абзац: конкретика, ссылки, разная длина фраз.
const GOOD = ('Единый налоговый счёт введён Федеральным законом от 14.07.2022 № 263-ФЗ. '
  + 'С 1 января 2023 г. платежи распределяются по правилам ст. 45 НК РФ, а не по указанию плательщика [1]. '
  + 'Это меняет саму модель исполнения обязанности. '
  + 'Налогоплательщик больше не выбирает, какой налог гасить: очерёдность задана п. 8 ст. 45 НК РФ и применяется автоматически, '
  + 'что, по мнению ряда авторов, ограничивает автономию воли участника налоговых отношений [2, с. 14]. '
  + 'Положительное сальдо можно вернуть по заявлению в течение трёх лет. ').repeat(8);

test('хороший раздел: без серьёзных замечаний', () => {
  const r = localChecks(GOOD, { kind: 'section', sources: [{}, {}, {}] });
  assert.strictEqual(r.findings.filter((f) => f.level === 'strong').length, 0);
  assert.strictEqual(pick(r, 'Научный стиль').length, 0);
  assert.strictEqual(pick(r, 'Конкретика').length, 0);
  assert.ok(r.metrics.refs >= 16);
});

test('объём сверяется с нормой своего вида', () => {
  const r = localChecks('Короткий текст раздела. '.repeat(40), { kind: 'introduction' });
  const v = pick(r, 'Объём')[0];
  assert.ok(v && /Меньше нормы/.test(v.title));
  assert.match(v.detail, /3800–5000/);
});

test('разговорные обороты — серьёзное замечание с подсказкой к каждому', () => {
  const text = GOOD + ' Долг растёт как снежный ком, и это отдельная головная боль для бизнеса.';
  const f = pick(localChecks(text, { sources: [{}, {}] }), 'Научный стиль')[0];
  assert.strictEqual(f.level, 'strong');
  assert.ok(f.items.some((i) => /снежный ком/.test(i.quote)));
  assert.ok(f.items.every((i) => i.advice));
});

test('сноска на номер за пределами списка — выдуманная', () => {
  const f = pick(localChecks(GOOD + ' См. также [7].', { sources: [{}, {}] }), 'Сноски')[0];
  assert.strictEqual(f.level, 'strong');
  assert.match(f.title, /\[7\]/);
});

test('без ссылок при подобранных источниках — предупреждение', () => {
  const plain = GOOD.replace(/\s*\[\d+(?:, с\. \d+)?\]/g, '');
  const f = pick(localChecks(plain, { sources: [{}, {}] }), 'Сноски')[0];
  assert.strictEqual(f.level, 'warn');
  assert.match(f.title, /Ни одной ссылки/);
});

test('реквизиты судебных актов и цифры без источника — на проверку', () => {
  const text = GOOD + ' Постановление Конституционного Суда РФ от 17.12.1996 № 20-П подтверждает это. '
    + 'Доля споров выросла на 37 % за год. По делу № А40-123456/2023 суд указал обратное.';
  const f = pick(localChecks(text, { sources: [{}, {}] }), 'Проверить по первоисточнику');
  assert.ok(f.some((x) => x.quotes.some((q) => /№ 20-П/.test(q))));
  assert.ok(f.some((x) => x.quotes.some((q) => /А40-123456\/2023/.test(q))));
  assert.ok(f.some((x) => /Цифры без ссылки/.test(x.title) && x.quotes.some((q) => /37 %/.test(q))));
});

test('мало конкретики и ровный ритм — как в блоках, помеченных Антиплагиатом', () => {
  const flat = 'Данный институт играет важную роль в системе правового регулирования отношений. '.repeat(20);
  const r = localChecks(flat, {});
  assert.ok(pick(r, 'Конкретика').length === 1);
  assert.ok(pick(r, 'Ритм').some((f) => /одной длины/.test(f.title)));
});

test('ритм: медиана слов, доля длинных, разброс, цифры', () => {
  const r = rhythm('Короткая фраза здесь. ' + 'Очень длинное предложение из множества слов '.repeat(4) + 'тут. Ст. 45 НК РФ.');
  assert.ok(r.sentences >= 2);
  assert.ok(r.cv > 0);
  assert.ok(r.digitsPer1000 > 0);
});

test('повторы с другими разделами находятся по совпадающим оборотам', () => {
  const other = 'Налогоплательщик больше не выбирает какой налог гасить очерёдность задана законом.';
  const f = pick(localChecks(GOOD, { sources: [{}, {}, {}], others: [{ heading: '1.1. Понятие', text: other }] }), 'Повторы')[0];
  assert.ok(f, 'повтор найден');
  assert.match(f.detail, /1\.1\. Понятие/);
});

test('план параграфа: незатронутые пункты', () => {
  assert.deepStrictEqual(briefStems('Анализ ответственности, банкротства и субсидиарной'), ['ответс', 'банкро', 'субсид']);
  const f = pick(localChecks(GOOD, { sources: [{}, {}, {}], brief: 'Ответственность директора, банкротство, субсидиарная ответственность' }), 'План')[0];
  assert.ok(f);
});

test('рецензия: разбор формата, цитата сверяется с текстом', () => {
  const text = 'Очерёдность задана п. 8 ст. 45 НК РФ и применяется автоматически.';
  const r = parseReview([
    'Вот моя рецензия:',
    '**ОЦЕНКА:** Раздел логичен, но поверхностен.',
    '1. ЗАМЕЧАНИЕ: Не раскрыта позиция судов',
    'ЦИТАТА: «применяется автоматически»',
    'СОВЕТ: Привести позицию ВС РФ',
    'ЗАМЕЧАНИЕ — Вывод не следует из сказанного',
    'ЦИТАТА: —',
    'СОВЕТ: Добавить промежуточный шаг',
    'ЗАМЕЧАНИЕ: Пересказ вместо цитаты',
    'ЦИТАТА: "налог платится сам собой"',
    'СОВЕТ: Уточнить',
  ].join('\n'), text);
  assert.strictEqual(r.summary, 'Раздел логичен, но поверхностен.');
  assert.strictEqual(r.items.length, 3);
  assert.strictEqual(r.items[0].quote, 'применяется автоматически');
  assert.strictEqual(r.items[0].quoteFound, true);
  assert.strictEqual(r.items[1].quote, '');
  assert.strictEqual(r.items[2].quoteFound, false);
});

test('правка отклоняется, если раздел сократился или пропали сноски', () => {
  const before = 'Текст раздела со ссылкой [1] и ещё одной [2]. '.repeat(30);
  assert.strictEqual(rejectRevision(before, before.replace(/ещё/g, 'также')), null);
  assert.match(rejectRevision(before, before.slice(0, 400)), /сократила/);
  assert.match(rejectRevision(before, before.replace(/\[2\]/g, '')), /\[2\]/);
  // Но если замечание прямо просило убрать [2] — можно.
  assert.strictEqual(rejectRevision(before, before.replace(/ \[2\]/g, ' источником'), [{ title: 'Сноска [2] выдумана' }]), null);
  assert.match(rejectRevision(before, ''), /пустой/);
});

test('задание на правку перечисляет замечания с фрагментами', () => {
  const m = reviseMessages({ text: 'ТЕКСТ', heading: '1.1. Понятие', topic: 'ЕНС',
    remarks: [{ title: 'Жаргон', quote: 'инкассо', advice: 'инкассовое поручение' }] });
  assert.match(m[0].content, /ТОЛЬКО то, к чему относятся замечания/);
  assert.match(m[1].content, /1\. Жаргон\n {3}Фрагмент: «инкассо»\n {3}Что сделать: инкассовое поручение/);
  assert.match(m[1].content, /ТЕКСТ РАЗДЕЛА:\nТЕКСТ$/);
});

test('оборванная цитата рецензента находится по началу', () => {
  const text = 'Позиция Конституционного Суда РФ здесь однозначна: указания прокурора обязательны для следователя.';
  const r = parseReview('ЗАМЕЧАНИЕ: Нет реквизитов\nЦИТАТА: «Позиция Конституционного Суда РФ здесь однозначна: указания прокурора должны быть…»\nСОВЕТ: Найти', text);
  assert.strictEqual(r.items[0].quoteFound, true);
  assert.strictEqual(r.items[0].quote, 'Позиция Конституционного Суда РФ здесь однозначна: указания прокурора');
  const r2 = parseReview('ЗАМЕЧАНИЕ: x\nЦИТАТА: Выход видится либо в лишении... либо в другом\nСОВЕТ: y',
    'Выход видится либо в лишении прокурора права.');
  assert.strictEqual(r2.items[0].quote, 'Выход видится либо в лишении');
});
