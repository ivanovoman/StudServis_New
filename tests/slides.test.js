'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseSlides } = require('../api/slides');

test('разбирает слайды из размеченного ответа модели', () => {
  const r = parseSlides([
    'СЛАЙД 1',
    'ЗАГОЛОВОК: Коллизии в праве',
    '- Выполнил: Иванов И.И.',
    '',
    'СЛАЙД 2',
    'ЗАГОЛОВОК: Актуальность',
    '- Первый тезис',
    '- Второй тезис',
  ].join('\n'));

  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.slides[1].title, 'Актуальность');
  assert.deepStrictEqual(r.slides[1].bullets, ['Первый тезис', 'Второй тезис']);
});

test('болтовню модели до первого слайда выбрасывает', () => {
  const r = parseSlides(
    'Конечно! Вот презентация к вашей защите:\n\nСЛАЙД 1\n'
    + 'ЗАГОЛОВОК: Тема\n- Пункт');

  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.slides[0].title, 'Тема');
});

test('снимает markdown, которым модель оборачивает ключевые слова', () => {
  const r = parseSlides(
    'СЛАЙД 1\n**ЗАГОЛОВОК:** Правила (*lex specialis*)\n- Пункт');

  assert.strictEqual(r.slides[0].title, 'Правила (lex specialis)',
    'ни звёздочек, ни слова ЗАГОЛОВОК в тексте остаться не должно');
  assert.deepStrictEqual(r.slides[0].bullets, ['Пункт']);
});

test('понимает любые маркеры списка', () => {
  const r = parseSlides([
    'СЛАЙД 1', 'ЗАГОЛОВОК: Т',
    '- дефис', '• точка', '1. цифра', '– тире', '* звёздочка',
  ].join('\n'));

  assert.deepStrictEqual(r.slides[0].bullets,
    ['дефис', 'точка', 'цифра', 'тире', 'звёздочка']);
});

test('заголовок в строке «СЛАЙД 2: Актуальность» не теряется', () => {
  const r = parseSlides('СЛАЙД 2: Актуальность темы\n- Пункт');
  assert.strictEqual(r.slides[0].title, 'Актуальность темы');
});

test('строку с двоеточием делает подзаголовком, следующие — вложенными', () => {
  const r = parseSlides([
    'СЛАЙД 1', 'ЗАГОЛОВОК: Цель и задачи',
    '- Цель: анализ природы коллизий',
    '- Задачи:',
    '- Раскрыть понятие',
    '- Классифицировать виды',
  ].join('\n'));

  const s = r.slides[0];
  assert.deepStrictEqual(s.levels, [0, 0, 1, 1]);
  assert.strictEqual(s.bullets[0], 'Цель: анализ природы коллизий',
    'двоеточие в середине строки вложенность не включает');
});

test('собирает таблицу и выравнивает строки по ширине', () => {
  const r = parseSlides([
    'СЛАЙД 1', 'ЗАГОЛОВОК: Сравнение',
    'ТАБЛИЦА: Критерий | А | Б',
    'ТАБЛИЦА: Источник | закон | договор',
    'ТАБЛИЦА: Последствие | ничтожность',
  ].join('\n'));

  const t = r.slides[0].table;
  assert.strictEqual(t.length, 3);
  assert.ok(t.every((row) => row.length === 3),
    'недостающие клетки добиваются пустыми, иначе pptx не соберётся');
  assert.strictEqual(t[2][2], '');
});

test('таблицу из одной шапки превращает в пункты', () => {
  const r = parseSlides(
    'СЛАЙД 1\nЗАГОЛОВОК: Т\nТАБЛИЦА: Критерий | А | Б');

  assert.strictEqual(r.slides[0].table.length, 0,
    'пустая таблица на слайде хуже обычного пункта');
  assert.ok(r.slides[0].bullets.length > 0);
  assert.ok(r.warnings.some((w) => /таблица без строк/i.test(w)));
});

test('таблицу в один столбец считает списком', () => {
  const r = parseSlides(
    'СЛАЙД 1\nЗАГОЛОВОК: Т\nТАБЛИЦА: Первое\nТАБЛИЦА: Второе');

  assert.strictEqual(r.slides[0].table.length, 0);
  assert.deepStrictEqual(r.slides[0].bullets, ['Первое', 'Второе']);
});

test('заметки докладчика отделяются от пунктов', () => {
  const r = parseSlides([
    'СЛАЙД 1', 'ЗАГОЛОВОК: Т', '- Пункт',
    'ЗАМЕТКА: Говорю о статистике дел.',
  ].join('\n'));

  assert.strictEqual(r.slides[0].note, 'Говорю о статистике дел.');
  assert.deepStrictEqual(r.slides[0].bullets, ['Пункт'],
    'заметка не должна попасть на экран');
});

test('предупреждает о слишком длинных пунктах', () => {
  const long = 'Очень длинный тезис, '.repeat(10);
  const r = parseSlides(`СЛАЙД 1\nЗАГОЛОВОК: Т\n- ${long}`);

  assert.ok(r.warnings.some((w) => /длиннее/.test(w)),
    'человек должен узнать, что на слайде получился абзац');
});

test('предупреждает об оборванном ответе модели', () => {
  const r = parseSlides('СЛАЙД 1\nЗАГОЛОВОК: Т\n- Пункт');
  assert.ok(r.warnings.some((w) => /10-12|оборвала/.test(w)));
});

test('пустой ответ не роняет разбор', () => {
  const r = parseSlides('');
  assert.strictEqual(r.count, 0);
  assert.deepStrictEqual(r.slides, []);
});

test('строка без маркера после заголовка считается пунктом', () => {
  const r = parseSlides(
    'СЛАЙД 1\nЗАГОЛОВОК: Т\nПервый пункт без дефиса\n- Второй');

  assert.deepStrictEqual(r.slides[0].bullets,
    ['Первый пункт без дефиса', 'Второй']);
});
