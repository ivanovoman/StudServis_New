/**
 * Проверка экрана «Курсовая по разделам» в настоящем DOM.
 *
 * Страница грузится с диска, сервер подменён: /api/outline разбирает
 * план настоящим api/outline.js, /api/section отдаёт поток SSE с
 * источниками и текстом. Так проверяется весь путь без модели и сети:
 * план из пункта 2 → кнопки разделов → написание → правка → глава
 * целиком → титул → список литературы → выгрузка .docx.
 *
 * Запуск: node tools/check-sections.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { JSDOM } = require('jsdom');
const { parseOutline, buildQueue } = require('../api/outline');

function ok(cond, text) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + text);
  if (!cond) process.exitCode = 1;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PLAN = [
  'ВВЕДЕНИЕ',
  'ГЛАВА 1. ТЕОРЕТИЧЕСКИЕ ОСНОВЫ ЕДИНОГО НАЛОГОВОГО СЧЁТА',
  '1.1. Понятие и правовая природа единого налогового счёта',
  '1.2. Сальдо и порядок зачёта переплаты',
  'ГЛАВА 2. ПРАКТИКА ПРИМЕНЕНИЯ',
  '2.1. Возврат положительного сальдо',
  '2.2. Судебные споры о распределении платежей',
  'ЗАКЛЮЧЕНИЕ',
].join('\n');

const SOURCES = [
  { title: 'Сальдо ЕНС', gost: 'Яковлев А. А. Сальдо ЕНС // Налоги. 2023. № 2. С. 5–9.' },
  { title: 'Tax', gost: 'Smith J. Tax accounts // Journal. 2022.' },
  { title: 'Счёт', gost: 'Алексеев Б. Б. Единый счёт // Финансовое право. 2024. № 1.' },
];

(async () => {
  // Страница и её скрипты — с диска, но под адресом http://localhost:
  // у страницы с file:// нет localStorage, а экран на нём держится.
  // Скрипты выполняем сами в том же порядке, что в modern.html.
  const PUBLIC = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(PUBLIC, 'modern.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const dom = new JSDOM(html.replace(/<script src="[^"]+"><\/script>/g, ''), {
    runScripts: 'outside-only', pretendToBeVisual: true,
    url: 'http://localhost/modern.html',
  });
  for (const src of scripts) {
    dom.window.eval(fs.readFileSync(path.join(PUBLIC, src), 'utf8') + '\n//# sourceURL=' + src);
  }
  await wait(50);
  const { window } = dom;
  const doc = window.document;
  const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const btn = (root, text) => [...root.querySelectorAll('button')]
    .find((b) => b.textContent.trim().startsWith(text));
  const navBtn = (id) => doc.querySelector(`.sec-btn[data-id="${id}"]`);

  // ---------------------------------------------------- подмена сервера
  const sent = { section: [], docx: null, pieces: [] };
  let sectionN = 0;
  window.fetch = function (url, opts) {
    url = String(url);
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    const json = (d) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(d) });
    if (url === '/api/outline') {
      return json({ queue: buildQueue(parseOutline(body.plan)), topic: 'Единый налоговый счёт', warnings: [] });
    }
    if (url === '/api/section') {
      sent.section.push(body);
      sectionN++;
      const t = body.task;
      const text = `${t.heading || t.title}. Текст раздела со ссылкой [1] и [3, с. 10]. `
        + 'Слово '.repeat(sectionN === 1 ? 900 : 1000);
      const events = [
        { sources: SOURCES },
        { queued: { message: 'Вы 1-й в очереди' } },
        { piece: { kind: t.kind, number: t.number || null, heading: t.heading || t.title,
                   chapterTitle: t.chapterTitle, text, chars: text.replace(/\s/g, '').length },
          workId: 42 },
      ];
      const lines = events.map((e) => 'data: ' + JSON.stringify(e) + '\n').concat(['data: [DONE]\n']);
      let i = 0;
      const enc = new TextEncoder();
      return Promise.resolve({
        ok: true,
        body: { getReader: () => ({ read: () => new Promise((r) => setTimeout(() => {
          r(i < lines.length ? { done: false, value: enc.encode(lines[i++]) } : { done: true });
        }, 5)) }) },
      });
    }
    if (url === '/api/v1/works/42/pieces') { sent.pieces.push(body); return json({ ok: true }); }
    if (url === '/api/export-docx-full') {
      sent.docx = body;
      return Promise.resolve({ ok: true, blob: () => Promise.resolve(new window.Blob(['x'])) });
    }
    return json({});
  };
  window.URL.createObjectURL = () => 'blob:x';
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () {};

  console.log('\nМеню');
  const cards = [...doc.querySelectorAll('.card')];
  ok(cards.length === 11, `карточек: ${cards.length} (ждём 11)`);
  ok(cards[3].textContent.includes('Курсовая по разделам'), 'пункт 4 — «Курсовая по разделам»');
  ok(cards[4].textContent.includes('Черновик целиком'), 'пункт 5 — «Черновик целиком»');

  console.log('\nБез плана');
  click(cards[3]);
  let sheet = doc.querySelector('.sheet');
  ok(sheet.classList.contains('wide'), 'окно широкое');
  ok(/Плана пока нет/.test(sheet.textContent), 'объясняет, что план берётся из пункта 2');
  ok(!!btn(sheet, 'Составить план'), 'есть кнопка «Составить план»');

  console.log('\nПлан из пункта 2 сохраняется сам');
  window.StudCore.saveSettings({ topic: 'Единый налоговый счёт' });
  // Имитируем завершение пункта 2: тот же вызов, что делает modern.js.
  window.StudCore.savePlan(PLAN, 'Единый налоговый счёт');
  ok(window.StudCore.getPlan().plan === PLAN, 'план лежит в localStorage');
  click(cards[3]);
  await wait(50);
  sheet = doc.querySelector('.sheet');
  const ids = [...sheet.querySelectorAll('.sec-btn')].map((b) => b.dataset.id);
  ok(ids.join(',') === 'title,toc,intro,ch1,s1.1,s1.2,ch2,s2.1,s2.2,concl,refs',
    'кнопки: ' + [...sheet.querySelectorAll('.sec-btn .sec-label')].map((b) => b.textContent).join(' | '));
  ok(/Написано разделов: 0 из 6/.test(sheet.textContent), "прогресс 0 из 6");

  console.log('\nТитул');
  ok(!!sheet.querySelector('.title-preview'), 'открыт титул с предпросмотром');
  const studentIn = sheet.querySelector('input[data-key="student"]');
  studentIn.value = 'Иванова Мария Сергеевна';
  studentIn.dispatchEvent(new window.Event('input', { bubbles: true }));
  ok(sheet.querySelector('.title-preview').textContent.includes('Иванова Мария Сергеевна'),
    'предпросмотр обновляется на лету');
  ok(sheet.querySelector('.title-preview').textContent.includes('Руководитель: ____'),
    'пустой руководитель — подчёркнутое место');
  click(btn(sheet, 'Сохранить титул'));
  ok(window.StudCore.getSettings().titlePage.student === 'Иванова Мария Сергеевна', 'титул сохранён в настройках');

  console.log('\nПараграф 1.1');
  click(navBtn('s1.1'));
  let pane = sheet.querySelector('.sec-pane');
  ok(pane.querySelector('h3').textContent.startsWith('1.1.'), 'открыт параграф 1.1');
  ok(/5\u00a0000–6\u00a0000/.test(pane.textContent), 'показана норма 5000–6000');
  pane.querySelector('textarea').value = 'больше практики ФНС';
  click(btn(pane, 'Написать'));
  await wait(120);
  ok(sent.section.length === 1, 'запрос ушёл');
  const first = sent.section[0];
  ok(first.task.position === 1 && first.task.number === '1.1', 'позиция и номер параграфа переданы');
  ok(/К разделу «1\.1\. .*»: больше практики ФНС/.test(first.settings.wishes), 'пожелание к разделу в брифе');
  ok(Array.isArray(first.sources) && first.sources.length === 0, 'первый раздел — без закреплённых источников');
  pane = sheet.querySelector('.sec-pane');
  ok(pane.querySelector('.out').textContent.startsWith('1.1.'), 'текст показан');
  ok(/меньше нормы/.test(pane.querySelector('.sec-meta').textContent), 'короткий раздел помечен «меньше нормы»');
  ok(navBtn('s1.1').querySelector('.sec-mark').textContent === '✓', 'у кнопки галочка');
  ok(btn(pane, 'Переписать'), 'кнопка стала «Переписать»');

  console.log('\nПравка');
  click(btn(pane, 'Править'));
  const editor = pane.querySelector('.sec-editor');
  ok(editor.style.display === '', 'редактор открыт');
  editor.value = 'Исправленный текст [1].';
  click(btn(pane, 'Сохранить правку'));
  await wait(30);
  ok(sent.pieces.length === 1 && sent.pieces[0].position === 1, 'правка ушла на сервер той же позицией');
  ok(/правлено вручную/.test(pane.querySelector('.sec-meta').textContent), 'отмечено «правлено вручную»');

  console.log('\nГлава 2 целиком');
  click(navBtn('ch2'));
  pane = sheet.querySelector('.sec-pane');
  ok(/не написано/.test(pane.textContent), 'видно, что параграфы не написаны');
  click(btn(pane, 'Написать оставшиеся параграфы (2)'));
  await wait(400);
  ok(sent.section.length === 3, 'написаны оба параграфа главы: запросов ' + sent.section.length);
  ok(sent.section[1].workId === 42, 'следующие разделы идут в ту же работу');
  ok(sent.section[1].sources.length === 3, 'список источников закреплён и уходит с запросом');
  ok(sent.section[2].written.length === 2, 'контекст — уже написанные разделы');
  ok(navBtn('ch2').querySelector('.sec-mark').textContent === '2/2', 'у главы отметка 2/2');

  console.log('\nСодержание');
  click(navBtn('toc'));
  pane = sheet.querySelector('.sec-pane');
  const toc = [...pane.querySelectorAll('.toc-line')].map((b) => b.textContent);
  ok(toc[0].startsWith('ВВЕДЕНИЕ') && /не написано/.test(toc[0]), 'введение не написано');
  ok(toc.some((t) => /^ГЛАВА 2\. ПРАКТИКА/.test(t)), 'главы с названиями');
  ok(toc[toc.length - 1] === 'СПИСОК ЛИТЕРАТУРЫ', 'список литературы в конце');

  console.log('\nСписок литературы');
  click(navBtn('refs'));
  pane = sheet.querySelector('.sec-pane');
  const lis = [...pane.querySelectorAll('.sec-biblio li')].map((l) => l.textContent);
  ok(lis.length === 2 && lis[0].startsWith('Алексеев') && lis[1].startsWith('Яковлев'),
    'только цитируемые [1] и [3], по алфавиту: ' + lis.join(' / '));
  ok(/Smith/.test(pane.textContent) === false || /не попадут/.test(pane.textContent), 'неиспользованная помечена');
  click(btn(pane, 'Поправить вручную'));
  const area = pane.querySelector('.sec-editor');
  area.value = '1. Свой источник.\n' + area.value;
  click(btn(pane, 'Сохранить список'));
  pane = sheet.querySelector('.sec-pane');
  ok(/поправлен вручную/.test(pane.textContent), 'ручной список принят');

  console.log('\nВыгрузка');
  click(btn(sheet, 'Скачать .docx'));
  await wait(50);
  const d = sent.docx;
  ok(!!d, 'запрос на .docx ушёл');
  ok(d && d.sections.length === 3, 'разделов в файле: ' + (d && d.sections.length));
  ok(d && d.sections[0].text === 'Исправленный текст [1].', 'в файл ушла правка');
  ok(d && d.titlePage.student === 'Иванова Мария Сергеевна' && d.titlePage.topic === 'Единый налоговый счёт',
    'титул целиком в запросе');
  ok(d && d.bibliography[0] === 'Свой источник.', 'ручной список литературы в запросе');
  ok(d && d.sources.length === 3 && d.plan === PLAN, 'источники для сносок и план в запросе');

  console.log('\nПереживает закрытие окна');
  sheet.querySelector('.x').click();
  click(cards[3]);
  await wait(30);
  sheet = doc.querySelector('.sheet');
  ok(/Написано разделов: 3 из 6/.test(sheet.textContent), 'после повторного открытия: 3 из 6');
  ok(navBtn('refs').classList.contains('on'), 'открыт тот же раздел, что был');

  console.log('\nСмена плана не теряет работу');
  click(btn(sheet, 'Сменить план'));
  const planArea = sheet.querySelector('textarea');
  planArea.value = PLAN.replace('2.2. Судебные споры о распределении платежей', '2.2. Ответственность\n2.3. Итоги');
  click(btn(sheet, 'Взять этот план'));
  await wait(50);
  ok(/Написано разделов: 0 из 7/.test(sheet.textContent), 'новый план — новая работа: 0 из 7');
  click(btn(sheet, 'Сменить план'));
  const back = [...sheet.querySelectorAll('.toc-line')].find((b) => /разделов: 3/.test(b.textContent));
  ok(!!back, 'прежняя работа в списке');
  click(back);
  await wait(30);
  ok(/Написано разделов: 3 из 6/.test(sheet.textContent), 'вернулись к прежней: 3 из 6');

  console.log(process.exitCode ? '\nЕсть ошибки' : '\nВсё сходится');
  window.close();
})().catch((e) => { console.error(e); process.exit(1); });
