/**
 * Проверка очереди 2: работа по разделам.
 *
 * Самое дорогое здесь — написание раздела моделью (20-40 секунд), и
 * один живой прогон мы делаем обязательно: без него неизвестно,
 * доходит ли текст до экрана. Остальные ветки (правка, экспорт,
 * перезапись) проверяются на подменённом потоке — они про интерфейс,
 * а не про модель.
 *
 * Запуск: node tools/check-workbench.js
 */
'use strict';

const { JSDOM } = require('jsdom');

const BASE = process.env.BASE || 'http://localhost:3000';
const LIVE = process.env.LIVE !== '0';   // LIVE=0 — без обращения к модели

function ok(cond, text) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + text);
  if (!cond) process.exitCode = 1;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PLAN = [
  'Глава 1. Договор подряда: понятие и правовая природа',
  '1.1. Понятие и существенные признаки договора подряда',
  '1.2. Отграничение подряда от смежных договорных конструкций',
  'Глава 2. Исполнение обязательств по договору подряда',
  '2.1. Права и обязанности сторон договора подряда',
].join('\n');

(async () => {
  const dom = await JSDOM.fromURL(BASE + '/modern.html', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
  });
  await new Promise((r) => dom.window.addEventListener('load', r));

  const { window } = dom;
  const doc = window.document;
  const realFetch = (url, opts) => globalThis.fetch(new URL(String(url), BASE), opts);
  window.fetch = realFetch;
  await wait(400);

  console.log('\nРазвилка пункта 4');
  ok(!!window.ModernWorkbench, 'модуль работы по разделам загрузился');
  const cards = [...doc.querySelectorAll('.card')];
  ok(cards[3].textContent.includes('Написать работу'),
    'карточка 4 переименована: ' + cards[3].querySelector('h3').textContent);
  cards[3].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(200);
  let sheet = doc.querySelector('.sheet');
  ok(sheet.textContent.includes('По разделам'), 'предложен путь по разделам');
  ok(sheet.textContent.includes('Всё разом'), 'предложена сборка целиком');

  console.log('\nРазбор плана в список');
  [...sheet.querySelectorAll('button')]
    .find((b) => b.textContent === 'Открыть по разделам')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(200);
  sheet = doc.querySelector('.sheet');
  sheet.querySelector('textarea').value = PLAN;
  [...sheet.querySelectorAll('button')]
    .find((b) => b.textContent === 'Разобрать план')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(1500);

  let items = [...sheet.querySelectorAll('.piece')];
  ok(items.length === 5, `частей в списке: ${items.length} (ждём 5)`);
  ok(items[0].textContent.includes('Введение'), 'первая часть — введение');
  ok(items[1].textContent.includes('1.1'), 'вторая — раздел 1.1');
  ok(items[4].textContent.includes('Заключение'), 'последняя — заключение');
  ok(window.StudCore.getSettings().topic, 'тема подхвачена из плана: '
    + window.StudCore.getSettings().topic);

  if (LIVE) {
    console.log('\nЖивое написание раздела (до 60 с)');
    const started = Date.now();
    [...items[1].querySelectorAll('button')]
      .find((b) => b.textContent === 'Написать')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    // Контейнер для текста существует с самого начала и просто скрыт,
    // поэтому ждём именно появления текста, а не элемента.
    for (let i = 0; i < 120; i += 1) {
      const box = items[1].querySelector('.out');
      if (box && box.textContent.trim().length > 200) break;
      await wait(1000);
    }
    await wait(500);

    const out = items[1].querySelector('.out');
    const written = out && out.textContent.trim();
    ok(!!written && written.length > 1000,
      `текст раздела получен: ${written ? written.length : 0} знаков за `
      + `${Math.round((Date.now() - started) / 1000)} с`);
    ok(items[1].textContent.includes('знаков без пробелов'),
      'показан объём части');
    const again = [...items[1].querySelectorAll('button')]
      .find((b) => b.textContent === 'Переписать');
    ok(!!again, 'кнопка сменилась на «Переписать»');
    const editBtn = [...items[1].querySelectorAll('button')]
      .find((b) => b.textContent === 'Править');
    ok(editBtn && editBtn.style.display !== 'none', 'появилась кнопка правки');

    console.log('\nПравка руками');
    editBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(200);
    const editor = items[1].querySelector('textarea');
    ok(!!editor && editor.style.display !== 'none', 'редактор открылся');
    ok(editor.value.length > 1000, 'в редакторе текст раздела');
    editor.value = 'Полностью переписанный вручную текст раздела.';
    [...items[1].querySelectorAll('button')]
      .find((b) => b.textContent === 'Сохранить правку')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(1200);
    ok(items[1].querySelector('.out').textContent
      === 'Полностью переписанный вручную текст раздела.',
      'правка отражена на экране');
    ok(items[1].textContent.includes('41 знаков'),
      'объём пересчитан после правки: '
      + (items[1].textContent.match(/\d+ знаков/) || ['нет'])[0]);
  } else {
    console.log('\nЖивое написание пропущено (LIVE=0)');
  }

  console.log('\nЭкспорт написанного');
  let sent = null;
  window.fetch = function (url, opts) {
    if (String(url).includes('/api/export-docx-full')) {
      sent = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, blob: () => Promise.resolve(new window.Blob(['x'])) });
    }
    return realFetch(url, opts);
  };
  const dlBtn = [...sheet.querySelectorAll('button')]
    .find((b) => b.textContent === 'Скачать .docx');
  if (LIVE) {
    ok(dlBtn && dlBtn.style.display !== 'none', 'кнопка скачивания доступна');
    dlBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(600);
    ok(!!sent, 'запрос на экспорт ушёл');
    ok(sent && !!sent.topic, 'тема передана: ' + (sent && sent.topic));
    ok(sent && sent.sections.length === 1, 'в документ пошёл написанный раздел');
  } else {
    ok(!!dlBtn, 'кнопка скачивания есть в разметке');
  }

  dom.window.close();
  console.log(process.exitCode ? '\nЕсть провалы' : '\nВсё сходится');
})().catch((e) => {
  console.error('Проверка упала:', e.message);
  process.exit(1);
});
