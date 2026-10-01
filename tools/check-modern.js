/**
 * Проверка современного интерфейса в настоящем DOM.
 *
 * Playwright в песочнице нет, а «синтаксис ок» ничего не говорит о том,
 * открываются ли окна и уходят ли запросы. jsdom грузит ту же страницу,
 * что и браузер, со всеми скриптами, после чего мы кликаем карточки и
 * смотрим, что получилось.
 *
 * Запуск: node tools/check-modern.js
 */
'use strict';

const { JSDOM } = require('jsdom');

const BASE = process.env.BASE || 'http://localhost:3000';

function ok(cond, text) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + text);
  if (!cond) process.exitCode = 1;
}

(async () => {
  const dom = await JSDOM.fromURL(BASE + '/modern.html', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
  });

  // Ждём, пока подтянутся и выполнятся все три скрипта.
  await new Promise((resolve) => {
    if (dom.window.document.readyState === 'complete') return resolve();
    dom.window.addEventListener('load', resolve);
  });
  await new Promise((r) => setTimeout(r, 300));

  const { window } = dom;
  const doc = window.document;

  // В jsdom нет fetch, а весь интерфейс на нём держится. Подставляем
  // настоящий из Node и достраиваем относительные адреса до полных:
  // в браузере '/api/...' разрешается сам, здесь — нет.
  window.fetch = function (url, opts) {
    return globalThis.fetch(new URL(String(url), BASE), opts);
  };

  console.log('\nЗагрузка модулей');
  ok(!!window.StudCore, 'app-core.js загрузился');
  ok(!!window.ModernUI, 'modern.js отдал каркас окна');
  ok(!!window.ModernSheets, 'modern-sheets.js загрузился');
  ok(typeof window.StudCore.getSettings === 'function', 'настройки в ядре');

  console.log('\nКарточки меню');
  const cards = [...doc.querySelectorAll('.card')];
  ok(cards.length === 8, `карточек на экране: ${cards.length} (ждём 8)`);
  const muted = cards.filter((c) => c.className.includes('muted'));
  ok(muted.length === 0, `неактивных карточек: ${muted.length} (ждём 0)`);
  const soon = [...doc.querySelectorAll('.tag.soon')];
  ok(soon.length === 0, `меток «Скоро»: ${soon.length} (ждём 0)`);

  console.log('\nОкна открываются');
  const checks = [
    [3, 'Введение', 'textarea'],
    [5, 'Подобрать источники', 'textarea'],
    [6, 'Оформить по ГОСТ', 'textarea'],
    [7, 'Проверить на ИИ', 'textarea'],
  ];
  for (const [idx, name, sel] of checks) {
    cards[idx - 1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const sheet = doc.querySelector('.sheet');
    const title = sheet && sheet.querySelector('h2');
    ok(!!sheet && title.textContent.includes(name.split(' ')[0]),
      `пункт ${idx}: «${title ? title.textContent : 'окно не открылось'}»`);
    ok(!!(sheet && sheet.querySelector(sel)), `  внутри есть ${sel}`);
    const x = sheet && sheet.querySelector('.x');
    if (x) x.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }

  console.log('\nПункт 4: развилка способов написания');
  // Пункт 4 больше не открывает сборку сразу: сначала выбор между
  // работой по разделам и сборкой целиком.
  cards[3].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  let sheet4 = doc.querySelector('.sheet');
  ok(sheet4.textContent.includes('По разделам'), 'предложена работа по разделам');
  [...sheet4.querySelectorAll('button')]
    .find((b) => b.textContent === 'Собрать целиком')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 150));
  sheet4 = doc.querySelector('.sheet');
  ok(!!sheet4.querySelector('.bar-wrap'), 'окно сборки целиком открылось');
  sheet4.querySelector('.x').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  console.log('\nНастройки');
  doc.getElementById('btn-settings')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  let sheet = doc.querySelector('.sheet');
  ok(!!sheet && !!sheet.querySelector('input[type=text]'), 'окно настроек с полями');
  const inputs = sheet.querySelectorAll('input[type=text]');
  const areas = sheet.querySelectorAll('textarea');
  const radios = sheet.querySelectorAll('input[type=radio]');
  ok(inputs.length === 2 && areas.length === 2 && radios.length === 3,
    `поля: ${inputs.length} строк, ${areas.length} областей, ${radios.length} переключателей`);

  inputs[0].value = 'Договор аренды';
  inputs[1].value = 'МФЮА';
  areas[1].value = 'больше практики';
  radios[1].checked = true;
  [...sheet.querySelectorAll('button')]
    .find((b) => b.textContent === 'Сохранить')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const saved = window.StudCore.getSettings();
  ok(saved.topic === 'Договор аренды', `тема сохранена: «${saved.topic}»`);
  ok(saved.university === 'МФЮА', `вуз сохранён: «${saved.university}»`);
  ok(saved.chapters === 2, `главы сохранены: ${saved.chapters}`);

  console.log('\nНастройки уходят в запрос генерации');
  let sentBody = null;
  const realFetch = window.fetch;
  window.fetch = function (url, opts) {
    if (String(url).includes('/api/generate')) {
      sentBody = JSON.parse(opts.body);
      return Promise.resolve({
        ok: true,
        body: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) },
      });
    }
    return realFetch(url, opts);
  };

  cards[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  sheet = doc.querySelector('.sheet');
  sheet.querySelector('textarea').value = 'Договор аренды';
  [...sheet.querySelectorAll('button')]
    .find((b) => b.textContent === 'Выполнить')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));

  ok(!!sentBody, 'запрос ушёл');
  ok(sentBody && sentBody.settings && sentBody.settings.university === 'МФЮА',
    'вуз доехал до бэкенда: ' + JSON.stringify(sentBody && sentBody.settings));


  console.log('\nПункт 5: подбор источников (живой запрос)');
  window.fetch = realFetch;
  cards[4].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  sheet = doc.querySelector('.sheet');
  [...sheet.querySelectorAll('button')]
    .find((b) => b.textContent === 'Искать')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 12000));
  let out = sheet.querySelector('.out');
  const found = out.textContent.match(/Найдено публикаций\s+—\s+(\d+)/);
  ok(!!found, 'источники найдены: ' + (found ? found[1] : out.textContent.slice(0, 90)));
  ok(out.querySelectorAll('ol li').length > 0,
    `публикаций в списке: ${out.querySelectorAll('ol li').length}`);
  ok(!!out.querySelector('.biblio'), 'список по ГОСТ показан');
  sheet.querySelector('.x').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  console.log('\nПункт 7: детектор (живой запрос)');
  cards[6].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  sheet = doc.querySelector('.sheet');
  // Детектор отказывается работать с короткими кусками: на паре фраз
  // частотные признаки не считаются. Даём текст нормального размера.
  const canned = 'Данная работа посвящена рассмотрению актуальных вопросов '
    + 'правового регулирования арендных отношений. В рамках настоящего '
    + 'исследования следует отметить, что действующее законодательство '
    + 'играет важную роль в обеспечении стабильности гражданского оборота. '
    + 'Необходимо подчеркнуть, что судебная практика по данной категории '
    + 'споров носит противоречивый характер. Таким образом, можно сделать '
    + 'вывод о том, что данный правовой институт требует дальнейшего '
    + 'совершенствования и научного осмысления. ';
  sheet.querySelector('textarea').value = canned.repeat(6);
  [...sheet.querySelectorAll('button')]
    .find((b) => b.textContent === 'Проверить')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 6000));
  out = sheet.querySelector('.out');
  ok(/Машинность:\s+\d+%/.test(out.textContent),
    'оценка показана: ' + (out.textContent.match(/Машинность:\s+\d+%/) || ['нет'])[0]);
  sheet.querySelector('.x').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  console.log('\nПункт 4: сборка на смоделированном потоке');
  // Настоящая сборка идёт три минуты; здесь проверяется, что окно
  // правильно показывает ход дела — прогресс, части, провалы, итог.
  const events = [
    { outline: [{ heading: 'Глава 1' }], total: 2, warnings: ['план короткий'] },
    { sources: [{ title: 'Источник' }] },
    { progress: { done: 1, total: 2 } },
    { piece: { number: '1.1', heading: 'Понятие', chars: 5200, text: 'текст' } },
    { failed: { heading: '1.2 Практика', reason: 'модель не ответила' } },
    { finished: { written: 1, failed: 1, chars: 5200 } },
  ];
  window.fetch = function (url, opts) {
    if (!String(url).includes('/api/assemble')) return realFetch(url, opts);
    const lines = events.map((e) => 'data: ' + JSON.stringify(e) + '\n');
    lines.push('data: [DONE]\n');
    let i = 0;
    return Promise.resolve({
      ok: true,
      body: {
        getReader: () => ({
          read: () => Promise.resolve(i < lines.length
            ? { done: false, value: new TextEncoder().encode(lines[i++]) }
            : { done: true }),
        }),
      },
    });
  };

  cards[3].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  sheet = doc.querySelector('.sheet');
  [...sheet.querySelectorAll('button')]
    .find((b) => b.textContent === 'Собрать целиком')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 150));
  sheet = doc.querySelector('.sheet');
  sheet.querySelector('textarea').value = 'Глава 1. Понятие\n1.1 Понятие\n1.2 Практика';
  [...sheet.querySelectorAll('button')]
    .find((b) => b.textContent === 'Собрать')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));

  out = sheet.querySelector('.out');
  ok(out.textContent.includes('частей — 2'), 'структура показана');
  ok(out.textContent.includes('план короткий'), 'предупреждение плана показано');
  ok(!!out.querySelector('.piece:not(.bad)'), 'готовая часть показана');
  ok(!!out.querySelector('.piece.bad'), 'провалившаяся часть показана отдельно');
  ok(sheet.querySelector('.bar').style.width === '100%', 'прогресс дошёл до конца');
  const dlBtn = [...sheet.querySelectorAll('button')]
    .find((b) => b.textContent === 'Скачать .docx');
  ok(dlBtn && dlBtn.style.display !== 'none', 'кнопка скачивания появилась');

  dom.window.close();
  console.log(process.exitCode ? '\nЕсть провалы' : '\nВсё сходится');
})().catch((e) => {
  console.error('Проверка упала:', e.message);
  process.exit(1);
});
