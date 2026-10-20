/**
 * Проверка очереди 1: учётная запись, работы и оплата в современном
 * интерфейсе.
 *
 * Проверяется сквозной путь, а не отдельные кнопки: аноним собирает
 * работу — она сохраняется по ключу устройства; человек регистрируется
 * — работа переезжает к учётной записи и видна в списке.
 *
 * Запуск: node tools/check-account.js
 */
'use strict';

const { JSDOM } = require('jsdom');

const BASE = process.env.BASE || 'http://localhost:3000';
const PY = process.env.PY || 'http://localhost:8000';

function ok(cond, text) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + text);
  if (!cond) process.exitCode = 1;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dom = await JSDOM.fromURL(BASE + '/modern.html', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
  });
  await new Promise((r) => dom.window.addEventListener('load', r));

  const { window } = dom;
  const doc = window.document;
  window.fetch = (url, opts) => globalThis.fetch(new URL(String(url), BASE), opts);
  await wait(400);

  console.log('\nШапка');
  ok(!!doc.getElementById('btn-account'), 'кнопка входа есть');
  ok(!!doc.getElementById('btn-works'), 'кнопка «Мои работы» есть');
  ok(!!doc.getElementById('btn-pay'), 'кнопка оплаты есть');
  ok(!!window.ModernAccount, 'модуль учётной записи загрузился');

  console.log('\nКлюч устройства');
  const key = window.StudCore.ownerKey();
  ok(key && key.length >= 16, `ключ заведён: ${key.slice(0, 12)}… (${key.length} симв.)`);
  ok(window.StudCore.ownerKey() === key, 'ключ не меняется между вызовами');
  const hdrs = window.StudCore.ownerHeaders({});
  ok(hdrs['X-Owner-Key'] === key, 'ключ уходит заголовком X-Owner-Key');
  ok(!hdrs.Authorization, 'без входа токен не отправляется');

  console.log('\nСборка сохраняется по ключу устройства');
  // Пишем работу напрямую в бэкенд тем же ключом, каким это делает
  // сборка: так проверяется, что интерфейс и сервер говорят об одном
  // владельце, без трёхминутного ожидания настоящей сборки.
  const created = await globalThis.fetch(`${PY}/api/v1/works`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Owner-Key': key },
    body: JSON.stringify({ topic: 'Проверка очереди 1', plan: 'Глава 1', settings: {} }),
  }).then((r) => r.json());
  ok(!!created.id, 'работа создана: ' + created.id);

  await globalThis.fetch(`${PY}/api/v1/works/${created.id}/pieces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Owner-Key': key },
    body: JSON.stringify({ kind: 'section', heading: '1.1 Понятие',
      text: 'Текст раздела для проверки сохранения.', number: '1.1' }),
  });

  console.log('\nОкно «Мои работы»');
  doc.getElementById('btn-works')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(1200);
  let sheet = doc.querySelector('.sheet');
  ok(!!sheet && sheet.textContent.includes('Проверка очереди 1'),
    'сохранённая работа видна в списке');
  ok(/частей: 1/.test(sheet.textContent),
    'показано число частей: ' + (sheet.textContent.match(/частей: \d+/) || ['нет'])[0]);
  ok(!!sheet.querySelector('button'), 'есть кнопки действий');
  sheet.querySelector('.x').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  console.log('\nСкачивание сохранённой работы');
  // Эндпоинт ждёт topic, введение и заключение отдельно от разделов.
  // Проверяем именно сборку тела запроса: раньше уходил title, и
  // сервер отвечал 400 «Нет темы работы».
  let exported = null;
  const beforeFetch = window.fetch;
  window.fetch = function (url, opts) {
    if (String(url).includes('/api/export-docx-full')) {
      exported = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, blob: () => Promise.resolve(new window.Blob(['x'])) });
    }
    return beforeFetch(url, opts);
  };
  doc.getElementById('btn-works')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(1200);
  sheet = doc.querySelector('.sheet');
  [...sheet.querySelectorAll('button')]
    .find((b) => b.textContent === 'Скачать .docx')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(900);
  ok(!!exported, 'запрос на экспорт ушёл');
  ok(exported && !!exported.topic, 'тема передана полем topic: ' + (exported && exported.topic));
  ok(exported && Array.isArray(exported.sections), 'разделы переданы массивом');
  ok(exported && 'introduction' in exported && 'conclusion' in exported,
    'введение и заключение отделены от разделов');
  window.fetch = beforeFetch;
  sheet.querySelector('.x').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  console.log('\nРегистрация и перенос работ');
  doc.getElementById('btn-account')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(200);
  sheet = doc.querySelector('.sheet');
  [...sheet.querySelectorAll('button')]
    .find((b) => b.textContent === 'Зарегистрироваться')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(100);

  const email = 'check' + Date.now() + '@example.ru';
  const fields = sheet.querySelectorAll('input');
  fields[0].value = 'Проверка';          // имя
  fields[1].value = email;               // почта
  fields[2].value = 'Пароль-длинный-123';
  [...sheet.querySelectorAll('button')]
    .find((b) => b.textContent === 'Создать учётную запись')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(1500);

  const me = window.ModernAccount.current();
  ok(!!me, 'регистрация прошла: ' + (me ? me.email : 'нет'));
  ok(!!window.StudCore.getToken(), 'токен сохранён');
  ok(window.StudCore.ownerHeaders({}).Authorization
    && window.StudCore.ownerHeaders({}).Authorization.startsWith('Bearer '),
    'токен уходит заголовком Authorization');
  ok(doc.getElementById('btn-account').textContent !== 'Войти',
    'в шапке показано имя: ' + doc.getElementById('btn-account').textContent);

  console.log('\nРаботы после входа');
  doc.getElementById('btn-works')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(1200);
  sheet = doc.querySelector('.sheet');
  ok(sheet.textContent.includes('Проверка очереди 1'),
    'анонимная работа переехала к учётной записи');
  sheet.querySelector('.x').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  console.log('\nОплата');
  doc.getElementById('btn-pay')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(1200);
  sheet = doc.querySelector('.sheet');
  ok(sheet.textContent.includes('290'), 'тариф «Одна работа» показан');
  ok(sheet.textContent.includes('590'), 'тариф «Подписка на месяц» показан');
  ok(sheet.textContent.includes('не подключён'),
    'честно сказано, что приём платежей не настроен');
  const payBtn = [...sheet.querySelectorAll('button')]
    .find((b) => b.textContent === 'Оплатить');
  ok(payBtn && payBtn.disabled, 'кнопка оплаты неактивна, пока нет ключей');
  sheet.querySelector('.x').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  console.log('\nВыход');
  doc.getElementById('btn-account')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(200);
  sheet = doc.querySelector('.sheet');
  [...sheet.querySelectorAll('button')]
    .find((b) => b.textContent === 'Выйти')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(900);
  ok(!window.ModernAccount.current(), 'сеанс закрыт');
  ok(!window.StudCore.getToken(), 'токен стёрт');

  console.log('\nЗагрузка методички');
  doc.getElementById('btn-settings')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(200);
  sheet = doc.querySelector('.sheet');
  const file = sheet.querySelector('input[type=file]');
  ok(!!file, 'поле загрузки файла есть');
  ok(file && /pdf/.test(file.accept), 'принимает PDF: ' + (file ? file.accept : ''));

  dom.window.close();
  console.log(process.exitCode ? '\nЕсть провалы' : '\nВсё сходится');
})().catch((e) => {
  console.error('Проверка упала:', e.message);
  process.exit(1);
});
