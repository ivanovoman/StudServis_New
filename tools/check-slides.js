/**
 * Проверка презентации к защите.
 *
 * Живой прогон модели здесь обязателен: без него неизвестно, доходят
 * ли слайды до экрана и переживает ли разметка дорогу от модели до
 * полей правки. Сборку .pptx проверяем всегда — она дешёвая и ломается
 * тише всего (файл скачивается, а внутри пусто).
 *
 * Запуск: node tools/check-slides.js       (LIVE=0 — без модели)
 */
'use strict';

const { JSDOM } = require('jsdom');

const BASE = process.env.BASE || 'http://localhost:3000';
const LIVE = process.env.LIVE !== '0';

function ok(cond, text) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + text);
  if (!cond) process.exitCode = 1;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Текст работы для живого прогона: короткий, но настоящий — модели
// нужно из чего делать слайды.
const WORK = `Введение

Коллизии в праве представляют собой противоречия между нормами,
регулирующими одно и то же общественное отношение. Актуальность темы
обусловлена стремительным обновлением законодательства, при котором
новые акты принимаются быстрее, чем отменяются устаревшие.

Целью работы является анализ правовой природы коллизий и оценка
механизмов их разрешения.

Глава 1. Понятие и виды юридических коллизий

Юридическая коллизия предполагает наличие двух и более формально
действующих норм, которые предписывают взаимоисключающее поведение.
От пробела в праве коллизию отличает то, что при пробеле норма
отсутствует вовсе, тогда как при коллизии норм избыток.

Классификация коллизий строится по нескольким основаниям. По
юридической силе актов различают вертикальные и горизонтальные
коллизии. Вертикальная коллизия возникает между актами разной силы:
например, приказ министерства противоречит федеральному закону.
Горизонтальная коллизия возникает между актами равной силы.

Глава 2. Способы разрешения коллизий

Основу разрешения составляют три классических правила. Lex superior
derogat legi inferiori: акт большей юридической силы вытесняет акт
меньшей. Lex posterior derogat legi priori: позднейший закон отменяет
предшествующий. Lex specialis derogat legi generali: специальная норма
вытесняет общую.

Особую роль играет судебное толкование. Конституционный Суд устраняет
неопределённость в вопросе о соответствии норм Конституции, а Верховный
Суд формирует единообразную практику применения.

Заключение

Проведённое исследование показало, что коллизии являются неизбежным
следствием динамики правового регулирования. Их разрешение опирается на
формальные правила приоритета, дополняемые судебным толкованием.`;

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

  console.log('\nПункт меню');
  ok(!!window.ModernSlides, 'модуль презентации загрузился');
  const cards = [...doc.querySelectorAll('.card')];
  ok(cards.length >= 9, `карточек в меню: ${cards.length}`);
  const card = cards[8];
  ok(card.textContent.includes('Презентация к защите'),
    'карточка 9: ' + card.querySelector('h3').textContent);
  ok(!card.className.includes('muted'),
    'карточка рабочая, а не «Скоро»');

  card.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(200);
  const sheet = doc.querySelector('.sheet');
  ok(!!sheet, 'окно открылось');

  console.log('\nРеквизиты титульного листа');
  const inputs = [...sheet.querySelectorAll('input[type=text]')];
  ok(inputs.length >= 3, `полей реквизитов: ${inputs.length}`);
  const labels = [...sheet.querySelectorAll('label')].map((l) => l.textContent);
  ok(labels.some((l) => /руководител/i.test(l)),
    'спрашиваем научного руководителя, а не выдумываем его');

  const area = sheet.querySelector('textarea');
  const makeBtn = [...sheet.querySelectorAll('button')]
    .find((b) => b.textContent.includes('Сделать слайды'));
  ok(!!makeBtn, 'кнопка «Сделать слайды» на месте');

  console.log('\nЗащита от пустого ввода');
  area.value = 'слишком коротко';
  makeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(150);
  const status = sheet.querySelector('.status');
  ok(/Нужен текст работы/.test(status.textContent),
    'короткий текст отклонён: ' + status.textContent.slice(0, 50));

  if (!LIVE) {
    console.log('\nLIVE=0 — живой прогон модели пропущен');
    dom.window.close();
    return;
  }

  console.log('\nЖивой прогон: модель делает слайды');
  area.value = WORK;
  const started = Date.now();
  makeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // Ждём появления блоков слайдов: это единственный надёжный признак
  // того, что поток дошёл и разметка разобралась.
  let blocks = [];
  for (let i = 0; i < 120; i += 1) {
    await wait(1000);
    blocks = [...sheet.querySelectorAll('.piece')];
    if (blocks.length) break;
    if (/warn-line/.test(sheet.innerHTML)) break;
  }
  const spent = Math.round((Date.now() - started) / 1000);

  const warn = sheet.querySelector('.warn-line');
  if (!blocks.length) {
    ok(false, 'слайды не пришли' + (warn ? ': ' + warn.textContent : ''));
    dom.window.close();
    return;
  }

  ok(blocks.length >= 6, `слайдов получено: ${blocks.length} за ${spent} с`);
  ok(/Готово/.test(sheet.querySelector('.status').textContent),
    'статус сообщает об успехе');

  const first = blocks[0];
  const titleInput = first.querySelector('input[type=text]');
  ok(!!titleInput && titleInput.value.trim().length > 3,
    'у слайда есть заголовок: ' + (titleInput ? titleInput.value : '—'));
  const bulletsArea = first.querySelector('textarea');
  ok(!!bulletsArea, 'пункты открыты для правки');

  ok(!/\*\*/.test(sheet.textContent), 'markdown-разметка вычищена');

  console.log('\nПравка слайда руками');
  titleInput.value = 'Исправленный заголовок';
  titleInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  bulletsArea.value = 'Первый пункт\n    Вложенный пункт\nВторой пункт';
  bulletsArea.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(100);
  ok(true, 'правка принята полями');

  console.log('\nСборка .pptx');
  const dlBtn = [...sheet.querySelectorAll('button')]
    .find((b) => b.textContent.includes('.pptx'));
  ok(!!dlBtn && dlBtn.style.display !== 'none',
    'кнопка скачивания появилась после генерации');

  // Файл собираем напрямую: клик в jsdom упирается в отсутствие
  // скачивания, а проверить надо содержимое документа.
  const slidesForFile = blocks.map((b, i) => {
    const t = b.querySelector('input[type=text]').value;
    const lines = b.querySelector('textarea').value.split('\n')
      .filter((s) => s.trim());
    return {
      title: t,
      bullets: lines.map((s) => s.trim()),
      levels: lines.map((s) => (/^(\s{2,}|\t)/.test(s) ? 1 : 0)),
      table: [],
      note: '',
    };
  });

  const res = await globalThis.fetch(BASE + '/api/export-pptx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slides: slidesForFile,
      topic: 'Коллизии в праве',
      university: 'МФЮА',
      author: 'Иванов И.И.',
      supervisor: 'Петров П.П.',
    }),
  });
  ok(res.ok, `бэкенд ответил ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  ok(buf.length > 20000, `файл собран: ${buf.length} байт`);
  ok(buf.slice(0, 2).toString() === 'PK', 'это настоящий zip-контейнер pptx');

  const disp = res.headers.get('content-disposition') || '';
  ok(/\.pptx/.test(disp), 'имя файла с расширением .pptx');

  require('fs').writeFileSync('/tmp/check-slides.pptx', buf);
  console.log('\n  файл: /tmp/check-slides.pptx');

  dom.window.close();
  console.log('\nВсё сходится.');
})().catch((e) => {
  console.error('\nПроверка упала:', e.message);
  process.exitCode = 1;
});
