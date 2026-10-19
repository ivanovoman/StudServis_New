/**
 * Курсовая по разделам.
 *
 * План к этому моменту уже есть: его составляет пункт 2, и готовый
 * план сохраняется сам (StudCore.savePlan). По нему строится ряд
 * кнопок — титул, содержание, введение, главы с параграфами,
 * заключение, список литературы, — и каждый раздел открывается и
 * пишется отдельно.
 *
 * Что за кнопками:
 *  - Титул — поля титульного листа и предпросмотр. Поля общие с
 *    настройками и уходят в .docx.
 *  - Содержание — все разделы плана с отметкой «готово»; клик ведёт
 *    к разделу.
 *  - Введение, параграфы, заключение — написать, переписать с
 *    пожеланием, поправить руками. Объём сверяется с нормой.
 *  - Глава — состояние её параграфов и «написать оставшиеся подряд».
 *  - Список литературы — публикации, на которые ссылается текст;
 *    можно поправить руками.
 *
 * Написанное хранится в браузере по отпечатку плана и на сервере
 * («Мои работы»). Закрыл окно — вернулся — всё на месте. Новый план не
 * затирает старую работу: к прежним планам можно вернуться.
 *
 * Экспортируется как window.ModernSections.
 */
(function () {
  'use strict';

  var L = window.SectionsLogic;
  var STORE_KEY = 'studrabots.sections';
  var MAX_WORKS = 6;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fmt(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  }

  // ------------------------------------------------------ хранилище

  function readStore() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (s && s.works && Array.isArray(s.order)) return s;
    } catch (e) { /* битое хранилище — начинаем с чистого */ }
    return { works: {}, order: [] };
  }

  function writeStore(store) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
      return true;
    } catch (e) {
      // Переполнено — выбрасываем самые старые работы и пробуем ещё раз.
      while (store.order.length > 1) {
        delete store.works[store.order.pop()];
        try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); return true; } catch (e2) { /* дальше */ }
      }
      return false;
    }
  }

  function persist(state) {
    var store = readStore();
    store.works[state.hash] = state;
    store.order = [state.hash].concat(store.order.filter(function (h) { return h !== state.hash; }));
    while (store.order.length > MAX_WORKS) delete store.works[store.order.pop()];
    writeStore(store);
  }

  // ------------------------------------------------------ окно

  var shell = null;
  var state = null;
  var nav = [];
  var job = null;          // { id, status } — что сейчас пишется
  var stopChapter = false;
  var paneRefresh = null;  // перерисовать текущую панель после события

  function open() {
    shell = window.ModernUI.openShell('Курсовая по разделам');
    shell.sheet.classList.add('wide');
    var rec = window.StudCore.getPlan();
    if (!rec) { renderNoPlan(); return; }
    load(rec.plan, rec.topic);
  }

  function body() {
    shell.body.textContent = '';
    return shell.body;
  }

  /** Плана нет — честно говорим, откуда он берётся. */
  function renderNoPlan(message) {
    var b = body();
    b.appendChild(el('p', 'hint', message || 'Курсовая по разделам пишется по плану. '
      + 'Плана пока нет — составьте его в пункте 2 «План работы» '
      + '(бесплатно), он сохранится сам. Или вставьте готовый план ниже.'));
    var row = el('div', 'row');
    var make = el('button', 'btn', 'Составить план');
    make.onclick = function () {
      // Карточка пункта 2 открывает окно плана; так не дублируем его код.
      var cards = document.querySelectorAll('.card');
      if (cards[1]) cards[1].click();
    };
    row.appendChild(make);
    b.appendChild(row);
    pastePlan(b, '');
  }

  /** Поле «вставить план» — и для первого раза, и для смены плана. */
  function pastePlan(b, value) {
    var label = el('label', 'field', 'Готовый план');
    b.appendChild(label);
    var area = el('textarea');
    area.rows = 10;
    area.value = value || '';
    area.placeholder = 'ВВЕДЕНИЕ\nГЛАВА 1. …\n1.1. …\n1.2. …\nГЛАВА 2. …\n…\nЗАКЛЮЧЕНИЕ';
    b.appendChild(area);
    var row = el('div', 'row');
    var use = el('button', 'btn', 'Взять этот план');
    var st = el('span', 'status');
    row.appendChild(use);
    row.appendChild(st);
    b.appendChild(row);
    use.onclick = function () {
      var text = area.value.trim();
      if (text.length < 100) { st.textContent = 'План слишком короткий'; return; }
      window.StudCore.savePlan(text, window.StudCore.getSettings().topic);
      load(text, '');
    };
    return area;
  }

  /** Восстановить работу по плану или разобрать план заново. */
  function load(plan, topic) {
    var hash = window.StudCore.textHash(plan);
    var saved = readStore().works[hash];
    state = saved || {
      hash: hash, plan: plan, topic: topic || '', queue: null, warnings: [],
      workId: null, pieces: {}, sources: [], bibliography: null,
      notes: {}, legal: {}, active: 'title', at: Date.now(),
    };
    if (state.queue) { renderMain(); return; }

    var b = body();
    var st = el('p', 'hint', 'Разбираю план на разделы…');
    b.appendChild(st);
    fetch('/api/outline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: plan, settings: window.StudCore.getSettings() }),
    })
      .then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d.error || ('сервер ответил ' + r.status));
          return d;
        });
      })
      .then(function (d) {
        var queue = d.queue || [];
        var sections = queue.filter(function (t) { return t.kind === 'section'; });
        if (!sections.length) {
          renderNoPlan('В плане не нашлось ни одной главы или параграфа. Нужны '
            + 'строки вида «ГЛАВА 1. …» и «1.1. …». Поправьте план или '
            + 'составьте новый в пункте 2.');
          return;
        }
        state.queue = queue;
        state.warnings = d.warnings || [];
        if (!state.topic && d.topic) state.topic = d.topic;
        var s = window.StudCore.getSettings();
        if (!s.topic && state.topic) window.StudCore.saveSettings({ topic: state.topic });
        persist(state);
        renderMain();
      })
      .catch(function (e) {
        st.textContent = 'Не удалось разобрать план: ' + e.message;
      });
  }

  // ------------------------------------------------ главный экран

  var navBox = null;
  var pane = null;
  var progress = null;

  function renderMain() {
    nav = L.buildNav(state.queue);
    if (!nav.some(function (i) { return i.id === state.active; })) state.active = 'title';

    var b = body();
    var top = el('div', 'sec-top');
    var topic = window.StudCore.getSettings().topic || state.topic;
    top.appendChild(el('div', 'sec-topic', topic ? '«' + topic + '»' : 'Тема не задана'));
    progress = el('div', 'hint');
    top.appendChild(progress);
    var row = el('div', 'row');
    var dl = el('button', 'btn', 'Скачать .docx');
    dl.onclick = function () { download(dl); };
    row.appendChild(dl);
    var change = el('button', 'btn ghost', 'Сменить план');
    change.onclick = renderChangePlan;
    row.appendChild(change);
    top.appendChild(row);
    b.appendChild(top);

    (state.warnings || []).forEach(function (w) { b.appendChild(el('div', 'warn-line', w)); });

    var layout = el('div', 'sec-layout');
    navBox = el('nav', 'sec-nav');
    navBox.setAttribute('aria-label', 'Разделы курсовой');
    pane = el('div', 'sec-pane');
    layout.appendChild(navBox);
    layout.appendChild(pane);
    b.appendChild(layout);

    drawNav();
    select(state.active);
  }

  function writableItems() {
    return nav.filter(function (i) { return i.writable; });
  }

  function updateProgress() {
    if (!progress) return;
    var items = writableItems();
    var done = items.filter(function (i) { return state.pieces[i.position]; });
    var total = done.reduce(function (sum, i) { return sum + (state.pieces[i.position].chars || 0); }, 0);
    progress.textContent = 'Написано разделов: ' + done.length + ' из ' + items.length
      + (total ? ' · ' + fmt(total) + ' знаков без пробелов' : '')
      + (job ? ' · сейчас пишется: ' + labelOf(job.id) : '');
  }

  function labelOf(id) {
    var it = nav.filter(function (i) { return i.id === id; })[0];
    return it ? it.label : id;
  }

  /** Отметка у кнопки: готово, пишется, пусто. */
  function markOf(item) {
    if (job && job.id === item.id) return '…';
    if (item.writable) return state.pieces[item.position] ? '✓' : '○';
    if (item.kind === 'chapter') {
      var kids = item.children || [];
      var done = kids.filter(function (id) {
        var it = nav.filter(function (x) { return x.id === id; })[0];
        return it && state.pieces[it.position];
      }).length;
      return done + '/' + kids.length;
    }
    if (item.kind === 'title') return window.StudCore.getSettings().titlePage ? '✓' : '○';
    if (item.kind === 'bibliography') return (state.sources || []).length ? '✓' : '○';
    return '';
  }

  function drawNav() {
    navBox.textContent = '';
    nav.forEach(function (item) {
      var btn = el('button', 'sec-btn lvl' + item.level + (item.id === state.active ? ' on' : ''));
      btn.type = 'button';
      btn.dataset.id = item.id;
      var mark = el('span', 'sec-mark', markOf(item));
      if (mark.textContent === '✓') mark.classList.add('done');
      btn.appendChild(mark);
      btn.appendChild(el('span', 'sec-label', item.label));
      btn.onclick = function () { select(item.id); };
      navBox.appendChild(btn);
    });
    updateProgress();
  }

  function select(id) {
    state.active = id;
    persist(state);
    [].forEach.call(navBox.querySelectorAll('.sec-btn'), function (b) {
      b.classList.toggle('on', b.dataset.id === id);
    });
    var item = nav.filter(function (i) { return i.id === id; })[0];
    pane.textContent = '';
    paneRefresh = null;
    if (!item) return;
    if (item.kind === 'title') paneTitle();
    else if (item.kind === 'toc') paneContents();
    else if (item.kind === 'bibliography') paneBibliography();
    else if (item.kind === 'chapter' && !item.writable) paneChapter(item);
    else paneWrite(item);
    pane.scrollTop = 0;
  }

  /** «← назад / далее →» под панелью. */
  function stepper(item) {
    var i = nav.indexOf(item);
    var row = el('div', 'row sec-step');
    if (i > 0) {
      var prev = el('button', 'btn ghost', '← ' + nav[i - 1].label);
      prev.onclick = function () { select(nav[i - 1].id); };
      row.appendChild(prev);
    }
    if (i < nav.length - 1) {
      var next = el('button', 'btn ghost', nav[i + 1].label + ' →');
      next.onclick = function () { select(nav[i + 1].id); };
      row.appendChild(next);
    }
    pane.appendChild(row);
  }

  // --------------------------------------------------------- титул

  var TITLE_FIELDS = [
    ['workType', 'Вид работы', 'КУРСОВАЯ РАБОТА'],
    ['university', 'Вуз', 'Московский финансово-юридический университет МФЮА'],
    ['faculty', 'Факультет / институт', 'Юридический факультет'],
    ['department', 'Кафедра', 'Кафедра гражданского права'],
    ['direction', 'Направление / специальность', '40.03.01 Юриспруденция'],
    ['profile', 'Профиль', 'Гражданско-правовой'],
    ['discipline', 'Дисциплина', 'Гражданское право'],
    ['student', 'Студент (ФИО)', 'Иванов Иван Иванович'],
    ['group', 'Группа', 'ЮР-31'],
    ['supervisor', 'Руководитель', 'к.ю.н., доцент Петров П.П.'],
    ['city', 'Город', 'Москва'],
    ['year', 'Год', String(new Date().getFullYear())],
  ];

  function paneTitle() {
    var item = nav[0];
    pane.appendChild(el('h3', 'sec-h', 'Титульный лист'));
    pane.appendChild(el('p', 'hint', 'Пустые поля останутся в документе '
      + 'подчёркнутым местом — их можно вписать от руки. Придумывать '
      + 'фамилию руководителя сервис не будет. Если не заполнить ничего, '
      + 'кроме темы, файл соберётся без титула.'));

    var s = window.StudCore.getSettings();
    var tp = s.titlePage || {};
    var grid = el('div', 'sec-form');
    var inputs = {};

    var topicIn = el('input');
    topicIn.type = 'text';
    topicIn.value = s.topic || state.topic || '';
    var tl = el('label', 'sec-field');
    tl.appendChild(el('span', '', 'Тема'));
    tl.appendChild(topicIn);
    tl.classList.add('full');
    grid.appendChild(tl);

    TITLE_FIELDS.forEach(function (f) {
      var lbl = el('label', 'sec-field');
      lbl.appendChild(el('span', '', f[1]));
      var inp = el('input');
      inp.type = 'text';
      inp.placeholder = f[2];
      inp.value = f[0] === 'university' ? (tp.university || s.university || '') : (tp[f[0]] || '');
      inp.dataset.key = f[0];
      inputs[f[0]] = inp;
      lbl.appendChild(inp);
      grid.appendChild(lbl);
    });
    pane.appendChild(grid);

    var defence = el('label', 'radio');
    var defIn = el('input');
    defIn.type = 'checkbox';
    defIn.checked = !!tp.withDefenceBlock;
    defence.appendChild(defIn);
    defence.appendChild(document.createTextNode('Блок «К защите» (для выпускных работ)'));
    pane.appendChild(defence);

    var row = el('div', 'row');
    var save = el('button', 'btn', 'Сохранить титул');
    var st = el('span', 'status');
    row.appendChild(save);
    row.appendChild(st);
    pane.appendChild(row);

    pane.appendChild(el('div', 'hint', 'Предпросмотр'));
    var preview = el('div', 'title-preview');
    pane.appendChild(preview);

    function collect() {
      var out = {};
      Object.keys(inputs).forEach(function (k) {
        var v = inputs[k].value.trim();
        if (v) out[k] = v;
      });
      if (defIn.checked) out.withDefenceBlock = true;
      return out;
    }

    function drawPreview() {
      preview.textContent = '';
      var info = collect();
      info.topic = topicIn.value.trim();
      L.titleLines(info).forEach(function (ln) {
        var p = el('div', 'tp-line' + (ln.bold ? ' b' : '') + (ln.big ? ' big' : ''),
          ln.caps ? ln.text.toUpperCase() : ln.text);
        p.style.textAlign = ln.align;
        if (!ln.text) p.innerHTML = '&nbsp;';
        preview.appendChild(p);
      });
    }

    // Слушаем форму, а не панель: панель живёт всё время, и обработчики
    // копились бы с каждым заходом на титул.
    grid.addEventListener('input', drawPreview);
    defIn.onchange = drawPreview;
    drawPreview();

    save.onclick = function () {
      var info = collect();
      var patch = { titlePage: info, topic: topicIn.value.trim() };
      if (info.university) patch.university = info.university;
      window.StudCore.saveSettings(patch);
      st.textContent = 'Сохранено — войдёт в .docx';
      drawNav();
    };

    stepper(item);
  }

  // ----------------------------------------------------- содержание

  function paneContents() {
    var item = nav[1];
    pane.appendChild(el('h3', 'sec-h', 'Содержание'));
    pane.appendChild(el('p', 'hint', 'Собрано из плана. В .docx попадают '
      + 'написанные разделы; номера страниц проставляются в Word после '
      + 'окончательной правки. Нажмите на строку, чтобы перейти к разделу.'));
    var list = el('div', 'toc');
    L.contentsLines(nav, state.pieces).forEach(function (ln) {
      var b = el('button', 'toc-line lvl' + ln.level);
      b.type = 'button';
      b.appendChild(el('span', '', ln.text));
      if (ln.written !== null) {
        b.appendChild(el('span', 'toc-st' + (ln.written ? ' done' : ''),
          ln.written ? 'готово' : 'не написано'));
      }
      b.onclick = function () { select(ln.id); };
      list.appendChild(b);
    });
    pane.appendChild(list);
    stepper(item);
  }

  // ------------------------------------------------------- главы

  function childItems(ch) {
    return (ch.children || []).map(function (id) {
      return nav.filter(function (x) { return x.id === id; })[0];
    }).filter(Boolean);
  }

  function paneChapter(ch) {
    pane.appendChild(el('h3', 'sec-h', ch.label));
    var kids = childItems(ch);
    var list = el('div', 'toc');
    kids.forEach(function (k) {
      var p = state.pieces[k.position];
      var b = el('button', 'toc-line lvl2');
      b.type = 'button';
      b.appendChild(el('span', '', k.label));
      var vol = p ? L.volumeState('section', p.chars) : null;
      b.appendChild(el('span', 'toc-st' + (p ? ' done' : ''),
        p ? fmt(p.chars) + ' зн.' + (vol === 'short' ? ' — мало' : '') : 'не написано'));
      b.onclick = function () { select(k.id); };
      list.appendChild(b);
    });
    pane.appendChild(list);

    var left = kids.filter(function (k) { return !state.pieces[k.position]; });
    var row = el('div', 'row');
    var all = el('button', 'btn', left.length
      ? 'Написать оставшиеся параграфы (' + left.length + ')'
      : 'Все параграфы главы написаны');
    all.disabled = !left.length || !!job;
    var stop = el('button', 'btn ghost', 'Остановить после текущего');
    stop.style.display = 'none';
    var st = el('span', 'status', job ? 'Сейчас пишется: ' + labelOf(job.id) : '');
    row.appendChild(all);
    row.appendChild(stop);
    row.appendChild(st);
    pane.appendChild(row);
    pane.appendChild(el('p', 'hint', 'Параграфы пишутся по очереди: каждый '
      + 'следующий видит уже написанные и не повторяет их. Один параграф — '
      + 'обычно 1–3 минуты.'));

    all.onclick = function () {
      stopChapter = false;
      all.disabled = true;
      stop.style.display = '';
      var i = 0;
      (function next() {
        if (stopChapter || i >= left.length) {
          stop.style.display = 'none';
          if (state.active === ch.id) select(ch.id);
          return;
        }
        var k = left[i++];
        st.textContent = 'Пишу ' + k.label + ' (' + i + ' из ' + left.length + ')…';
        write(k, '').then(next, function (err) {
          st.textContent = 'Остановлено на ' + k.label + ': ' + err;
          stop.style.display = 'none';
          all.disabled = false;
        });
      })();
    };
    stop.onclick = function () {
      stopChapter = true;
      stop.disabled = true;
      st.textContent = 'Остановлю после текущего параграфа';
    };

    stepper(ch);
  }

  // ------------------------------------------------- письмо раздела

  /**
   * Написать раздел. Возвращает Promise; ход дела — в job.status.
   *
   * Одновременно пишется один раздел: модели бесплатного уровня на
   * параллельные запросы отвечают отказом, а очередь на сервере всё
   * равно выстроит их друг за другом.
   */
  function write(item, note) {
    if (job) return Promise.reject('уже пишется ' + labelOf(job.id));
    job = { id: item.id, status: 'Пишу…', from: Date.now() };
    drawNav();

    var settings = window.StudCore.getSettings();
    if (note) {
      // Пожелание к разделу добавляем к общим пожеланиям работы — так
      // оно попадёт в бриф модели тем же путём.
      settings.wishes = [settings.wishes, 'К разделу «' + item.label + '»: ' + note]
        .filter(Boolean).join('\n');
    }
    if (!settings.topic && state.topic) settings.topic = state.topic;

    // Контекст — уже написанные части в порядке плана, кроме этой.
    var written = writableItems()
      .filter(function (i) { return i.id !== item.id && state.pieces[i.position]; })
      .map(function (i) {
        var p = state.pieces[i.position];
        return { heading: p.heading, text: p.text };
      });

    var payload = {
      plan: state.plan,
      settings: settings,
      task: Object.assign({}, item.task, { position: item.position }),
      written: written,
      ownerKey: window.StudCore.ownerKey(),
      // Список публикаций работы: номера сносок должны совпадать во
      // всех разделах. Сервер держит его у себя, а этот — запасной,
      // на случай перезапуска сервера.
      sources: state.sources || [],
    };
    if (state.workId) payload.workId = state.workId;
    return streamPiece(item, '/api/section', payload);
  }

  /**
   * Правка раздела по отмеченным замечаниям анализа: модель меняет
   * только эти места. Прежний вариант сохраняется — его можно вернуть.
   */
  function revise(item, remarks) {
    if (job) return Promise.reject('уже пишется ' + labelOf(job.id));
    var p = state.pieces[item.position];
    if (!p) return Promise.reject('раздел ещё не написан');
    job = { id: item.id, status: 'Правлю по замечаниям…', from: Date.now() };
    drawNav();
    var settings = window.StudCore.getSettings();
    if (!settings.topic && state.topic) settings.topic = state.topic;
    var before = { text: p.text, chars: p.chars, edited: p.edited, at: Date.now() };
    var payload = {
      text: p.text,
      remarks: remarks,
      task: Object.assign({}, item.task, { position: item.position }),
      plan: state.plan,
      settings: settings,
      ownerKey: window.StudCore.ownerKey(),
    };
    if (state.workId) payload.workId = state.workId;
    return streamPiece(item, '/api/section-revise', payload).then(function () {
      state.prev = state.prev || {};
      state.prev[item.id] = before;
      state.pieces[item.position].revised = remarks.length;
      persist(state);
    });
  }

  /** Общий разбор потока: и для письма, и для правки по замечаниям. */
  function streamPiece(item, url, payload) {
    var tick = setInterval(function () {
      if (!job) return;
      job.clock = Math.round((Date.now() - job.from) / 1000) + ' с';
      if (paneRefresh) paneRefresh();
    }, 1000);

    return new Promise(function (resolve, reject) {
      var gotPiece = false;
      var lastError = '';
      window.StudCore.stream(url, payload, function (ev) {
        if (ev.sources && ev.sources.length && !(state.sources || []).length) {
          state.sources = ev.sources;
        }
        if (ev.queued) job.status = ev.queued.message;
        if (ev.expanding) job.status = 'Дописываю до нужного объёма…';
        if (ev.disclaimer) job.status = 'Убрал служебную оговорку модели, дописываю…';
        if (ev.legal) state.legal[item.id] = ev.legal;
        if (ev.error) lastError = ev.error;
        if (ev.workId) state.workId = ev.workId;
        if (ev.piece) {
          gotPiece = true;
          state.pieces[item.position] = {
            kind: ev.piece.kind, number: ev.piece.number, heading: ev.piece.heading,
            chapterTitle: ev.piece.chapterTitle, text: ev.piece.text,
            chars: ev.piece.chars || L.chars(ev.piece.text), edited: false, at: Date.now(),
          };
          if (!ev.legal) delete state.legal[item.id];
          persist(state);
        }
        if (paneRefresh) paneRefresh();
      }, function (err) {
        clearInterval(tick);
        job = null;
        persist(state);
        if (navBox) drawNav();
        if (paneRefresh) paneRefresh(true);
        if (err || !gotPiece) reject(err || lastError || 'модель не вернула текст');
        else resolve();
      });
    });
  }

  function paneWrite(item) {
    var kind = L.pieceKind(item);
    var target = L.targetFor(kind);
    pane.appendChild(el('h3', 'sec-h', item.label));
    if (item.kind === 'section' && item.task && item.task.chapterTitle) {
      pane.appendChild(el('div', 'hint', 'Глава ' + item.chapter + '. ' + item.task.chapterTitle));
    }
    if (item.task && item.task.brief) {
      pane.appendChild(el('p', 'sec-brief', 'По плану: ' + item.task.brief));
    }
    pane.appendChild(el('div', 'hint', 'Норма объёма: ' + fmt(target.min) + '–'
      + fmt(target.max) + ' знаков без пробелов.'));

    var noteLbl = el('label', 'field', 'Пожелание к этому разделу (необязательно)');
    pane.appendChild(noteLbl);
    var note = el('textarea');
    note.rows = 2;
    note.placeholder = 'Например: подробнее о позиции Конституционного Суда, без таблиц';
    note.value = (state.notes && state.notes[item.id]) || '';
    note.oninput = function () {
      state.notes = state.notes || {};
      state.notes[item.id] = note.value;
      persist(state);
    };
    pane.appendChild(note);

    var row = el('div', 'row');
    var writeBtn = el('button', 'btn', 'Написать');
    var editBtn = el('button', 'btn ghost', 'Править');
    var cancelBtn = el('button', 'btn ghost', 'Отменить правку');
    cancelBtn.style.display = 'none';
    var analyzeBtn = el('button', 'btn ghost', 'Глубокий анализ');
    analyzeBtn.title = 'Разбор раздела: стиль, ритм, конкретика, сноски, факты для '
      + 'проверки, повторы, детектор ИИ и рецензия научного руководителя';
    var undoBtn = el('button', 'btn ghost', 'Вернуть прежний вариант');
    var st = el('span', 'status');
    row.appendChild(writeBtn);
    row.appendChild(editBtn);
    row.appendChild(analyzeBtn);
    row.appendChild(cancelBtn);
    row.appendChild(undoBtn);
    row.appendChild(st);
    pane.appendChild(row);

    var meta = el('div', 'sec-meta');
    pane.appendChild(meta);
    var legalBox = el('div');
    pane.appendChild(legalBox);
    var reportBox = el('div', 'review');
    pane.appendChild(reportBox);
    var out = el('div', 'out');
    pane.appendChild(out);
    var editor = el('textarea', 'sec-editor');
    editor.rows = 18;
    editor.style.display = 'none';
    pane.appendChild(editor);

    var editing = false;
    var lastSig = '';

    function refresh(final) {
      var p = state.pieces[item.position];
      var mine = job && job.id === item.id;
      writeBtn.textContent = p ? 'Переписать' : 'Написать';
      writeBtn.disabled = !!job || editing;
      editBtn.style.display = p ? '' : 'none';
      editBtn.disabled = mine;
      analyzeBtn.style.display = p && !editing ? '' : 'none';
      analyzeBtn.disabled = !!reviewRuns[item.id] || mine;
      analyzeBtn.textContent = reviewRuns[item.id] ? 'Анализирую…'
        : (state.reviews && state.reviews[item.id] ? 'Анализ заново' : 'Глубокий анализ');
      undoBtn.style.display = p && state.prev && state.prev[item.id] && !editing && !job ? '' : 'none';
      if (mine) st.textContent = job.status + (job.clock ? ' — ' + job.clock : '');
      else if (job) st.textContent = 'Сейчас пишется ' + labelOf(job.id) + ' — дождитесь';
      else if (final !== true && !editing) st.textContent = st.dataset.keep || '';

      legalBox.textContent = '';
      var lg = state.legal && state.legal[item.id];
      if (lg && (lg.wrong || []).length) {
        legalBox.appendChild(el('div', 'warn-line', 'Проверьте ссылки на закон: '
          + lg.wrong.join('; ')));
      }
      if (lg && (lg.unclear || []).length) {
        legalBox.appendChild(el('div', 'warn-line', 'Не удалось проверить: '
          + lg.unclear.join('; ')));
      }

      if (editing) { reportBox.style.display = 'none'; lastSig = ''; return; }
      reportBox.style.display = '';
      // Перерисовываем текст и отчёт, только когда в них что-то
      // поменялось: refresh зовётся раз в секунду, пока идёт любое
      // задание, и иначе сбрасывал бы подсветку цитаты.
      var rep = state.reviews && state.reviews[item.id];
      var sig = [p ? p.text.length + ':' + p.at + ':' + p.edited : '-',
        rep ? [rep.at, rep.stage, !!rep.local, !!rep.detector, !!rep.legal, !!rep.review, rep.reviewError, rep.fixError].join('/') : '-',
        job ? job.id + job.status : '-'].join('|');
      if (sig === lastSig) return;
      lastSig = sig;
      renderReport(item, reportBox, out);
      if (p) {
        var vs = L.volumeState(kind, p.chars);
        meta.textContent = fmt(p.chars) + ' знаков без пробелов'
          + (vs === 'short' ? ' — меньше нормы' : vs === 'long' ? ' — больше нормы' : ' — в норме')
          + (p.edited ? ' · правлено вручную' : '');
        meta.className = 'sec-meta ' + vs;
        out.textContent = p.text;
        out.style.display = '';
      } else {
        meta.textContent = '';
        out.textContent = '';
        out.style.display = 'none';
      }
    }

    paneRefresh = function (final) {
      if (state.active !== item.id) return;
      if (final === true && !job) {
        st.textContent = state.pieces[item.position] ? 'Готово' : st.textContent;
      }
      refresh(final);
    };

    writeBtn.onclick = function () {
      var p = state.pieces[item.position];
      if (p && p.edited && typeof window.confirm === 'function'
          && !window.confirm('Раздел правился вручную. Написать заново? Правка пропадёт.')) {
        return;
      }
      st.dataset.keep = '';
      write(item, note.value.trim()).then(function () {
        if (state.active === item.id) { st.textContent = 'Готово'; refresh(true); }
      }, function (err) {
        if (state.active === item.id) st.textContent = 'Ошибка: ' + err;
      });
      refresh();
    };

    editBtn.onclick = function () {
      var p = state.pieces[item.position];
      if (!p) return;
      if (!editing) {
        editing = true;
        editor.value = p.text;
        editor.style.display = '';
        out.style.display = 'none';
        editBtn.textContent = 'Сохранить правку';
        cancelBtn.style.display = '';
        refresh();
        editor.focus();
        return;
      }
      var text = editor.value;
      p.text = text;
      p.chars = L.chars(text);
      p.edited = true;
      persist(state);
      editing = false;
      editor.style.display = 'none';
      editBtn.textContent = 'Править';
      cancelBtn.style.display = 'none';
      refresh();
      drawNav();
      saveEdit(item, p, st);
    };

    analyzeBtn.onclick = function () {
      analyze(item);
      refresh();
    };

    undoBtn.onclick = function () {
      var prev = state.prev && state.prev[item.id];
      var p = state.pieces[item.position];
      if (!prev || !p) return;
      p.text = prev.text;
      p.chars = prev.chars;
      p.edited = true;
      p.revised = 0;
      delete state.prev[item.id];
      persist(state);
      refresh();
      drawNav();
      saveEdit(item, p, st);
    };

    cancelBtn.onclick = function () {
      editing = false;
      editor.style.display = 'none';
      editBtn.textContent = 'Править';
      cancelBtn.style.display = 'none';
      refresh();
    };

    refresh();
    stepper(item);
  }

  // -------------------------------------------- глубокий анализ

  var reviewRuns = {};   // id -> true, пока идёт анализ

  /**
   * Запустить глубокий анализ раздела. Результат копится в
   * state.reviews[id] по мере прихода событий и переживает закрытие
   * окна. Отпечаток текста запоминается: если раздел потом правили,
   * отчёт помечается устаревшим.
   */
  function analyze(item) {
    var p = state.pieces[item.position];
    if (!p || reviewRuns[item.id]) return;
    reviewRuns[item.id] = true;
    state.reviews = state.reviews || {};
    var rep = state.reviews[item.id] = {
      hash: window.StudCore.textHash(p.text), at: Date.now(),
      local: null, detector: null, legal: null, review: null,
      reviewError: '', stage: 'Проверяю…',
    };
    var others = writableItems()
      .filter(function (i) { return i.id !== item.id && state.pieces[i.position]; })
      .map(function (i) {
        var q = state.pieces[i.position];
        return { heading: q.heading || i.label, text: q.text };
      });
    var settings = window.StudCore.getSettings();
    if (!settings.topic && state.topic) settings.topic = state.topic;

    window.StudCore.stream('/api/section-review', {
      text: p.text,
      task: Object.assign({}, item.task, { kind: L.pieceKind(item) }),
      plan: state.plan,
      settings: settings,
      sources: state.sources || [],
      others: others,
    }, function (ev) {
      if (ev.local) rep.local = ev.local;
      if (ev.detector) rep.detector = ev.detector;
      if (ev.legal) rep.legal = ev.legal;
      if (ev.queued) rep.stage = ev.queued.message;
      if (ev.reviewing) rep.stage = 'Научный руководитель читает раздел…';
      if (ev.review) { rep.review = ev.review; rep.stage = ''; }
      if (ev.reviewError) { rep.reviewError = ev.reviewError; rep.stage = ''; }
      if (ev.error) { rep.reviewError = ev.error; rep.stage = ''; }
      persist(state);
      if (paneRefresh) paneRefresh();
    }, function (err) {
      delete reviewRuns[item.id];
      if (err) rep.reviewError = 'Анализ прерван: ' + err;
      rep.stage = '';
      persist(state);
      if (paneRefresh) paneRefresh();
    });
  }

  /** Подсветить фрагмент в тексте раздела и прокрутить к нему. */
  function highlight(out, text, quote) {
    var q = String(quote || '').replace(/…$/, '').trim();
    if (!q) return false;
    var norm = function (x) { return x.toLowerCase().replace(/ё/g, 'е'); };
    var at = norm(text).indexOf(norm(q));
    if (at < 0) return false;
    out.textContent = '';
    out.appendChild(document.createTextNode(text.slice(0, at)));
    var mark = el('mark', 'hl', text.slice(at, at + q.length));
    out.appendChild(mark);
    out.appendChild(document.createTextNode(text.slice(at + q.length)));
    out.style.display = '';
    if (mark.scrollIntoView) mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return true;
  }

  /**
   * Отчёт анализа. Каждое замечание с советом можно отметить галочкой
   * и отправить на точечную правку. По умолчанию отмечены рецензия и
   * серьёзные находки — то, что научный руководитель точно заметит.
   */
  function renderReport(item, box, out) {
    var rep = state.reviews && state.reviews[item.id];
    box.textContent = '';
    if (!rep) return;
    var p = state.pieces[item.position];
    if (!p) return;
    var text = p.text;
    var stale = rep.hash !== window.StudCore.textHash(text);
    var picks = [];   // { box: checkbox, remark: {title, quote, advice} }

    var head = el('div', 'review-head');
    head.appendChild(el('h4', '', 'Глубокий анализ'));
    var close = el('button', 'x', '\u2715');
    close.title = 'Скрыть отчёт';
    close.onclick = function () { delete state.reviews[item.id]; persist(state); renderReport(item, box, out); };
    head.appendChild(close);
    box.appendChild(head);
    if (stale) {
      box.appendChild(el('div', 'warn-line', 'Текст изменился после анализа — '
        + 'цитаты могут не найтись. Запустите анализ заново.'));
    }

    function quoteChip(q, parent) {
      var c = el('button', 'qchip', '«' + q + '»');
      c.type = 'button';
      c.title = 'Показать в тексте';
      c.onclick = function () {
        if (!highlight(out, text, q)) c.classList.add('miss');
      };
      parent.appendChild(c);
    }

    function remarkRow(parent, level, remark, opts) {
      opts = opts || {};
      var row = el('div', 'rv-item ' + (level || 'info'));
      var line = el('label', 'rv-line');
      if (remark.advice || opts.forceCheck) {
        var cb = el('input');
        cb.type = 'checkbox';
        var key = remark.title + '|' + (remark.quote || '');
        rep.picks = rep.picks || {};
        cb.checked = key in rep.picks ? rep.picks[key] : !!opts.checked;
        cb.onchange = function () {
          rep.picks[key] = cb.checked;
          persist(state);
          updateFix();
        };
        line.appendChild(cb);
        picks.push({ box: cb, remark: remark });
      }
      line.appendChild(el('span', 'rv-title', opts.label || remark.title));
      row.appendChild(line);
      if (opts.detail) row.appendChild(el('div', 'rv-detail', opts.detail));
      var quotes = opts.quotes || (remark.quote ? [remark.quote] : []);
      if (quotes.length) {
        var qs = el('div', 'rv-quotes');
        quotes.forEach(function (q) { quoteChip(q, qs); });
        row.appendChild(qs);
      }
      if (remark.advice) row.appendChild(el('div', 'rv-advice', '→ ' + remark.advice));
      parent.appendChild(row);
    }

    // Показатели одной строкой.
    if (rep.local) {
      var m = rep.local.metrics;
      var chips = el('div', 'rv-metrics');
      [
        fmt(m.chars) + ' зн. (норма ' + fmt(m.target.min) + '–' + fmt(m.target.max) + ')',
        'предложений: ' + m.sentences,
        'слов в предложении: ~' + m.medianWords,
        'разброс длины: ' + String(m.cv).replace('.', ','),
        'цифр на 1000 зн.: ' + String(m.digitsPer1000).replace('.', ','),
        'ссылок: ' + m.refs + (m.sources ? ' на ' + m.refsUnique + ' из ' + m.sources + ' источн.' : ''),
      ].forEach(function (t) { chips.appendChild(el('span', 'rv-chip', t)); });
      box.appendChild(chips);
    }

    // Рецензия научного руководителя.
    var sec = el('div', 'rv-sec');
    sec.appendChild(el('div', 'rv-sec-h', 'Рецензия научного руководителя'));
    if (rep.review) {
      if (rep.review.summary) sec.appendChild(el('p', 'rv-summary', rep.review.summary));
      sec.appendChild(el('div', 'hint', 'Рецензию пишет модель: её замечания о фактах '
        + 'и реквизитах тоже сверяйте по первоисточнику.'));
      rep.review.items.forEach(function (it) {
        remarkRow(sec, 'warn', { title: it.title, quote: it.quoteFound ? it.quote : '', advice: it.advice },
          { checked: true, forceCheck: true,
            detail: it.quote && !it.quoteFound ? 'Фрагмент: «' + it.quote + '» (дословно в тексте не найден)' : '' });
      });
      if (!rep.review.items.length) sec.appendChild(el('div', 'ok-line', 'Замечаний нет.'));
    } else if (rep.reviewError) {
      sec.appendChild(el('div', 'warn-line', rep.reviewError));
    } else {
      sec.appendChild(el('div', 'hint', rep.stage || 'Ждёт очереди…'));
    }
    box.appendChild(sec);

    // Проверки кодом.
    if (rep.local) {
      var sec2 = el('div', 'rv-sec');
      sec2.appendChild(el('div', 'rv-sec-h', 'Проверки'));
      if (!rep.local.findings.length) {
        sec2.appendChild(el('div', 'ok-line', 'Объём, стиль, ритм, сноски и повторы — без замечаний.'));
      }
      rep.local.findings.forEach(function (f) {
        var group = el('div', 'rv-group', f.group);
        sec2.appendChild(group);
        if (f.items && f.items.length) {
          // Разговорные обороты — каждый своей строкой со своей подсказкой.
          var wrap = el('div', 'rv-item ' + f.level);
          wrap.appendChild(el('div', 'rv-title', f.title));
          if (f.detail) wrap.appendChild(el('div', 'rv-detail', f.detail));
          sec2.appendChild(wrap);
          f.items.forEach(function (it) {
            remarkRow(sec2, 'sub', {
              title: '«' + it.quote + '» — ' + it.kind, quote: it.quote,
              advice: 'Заменить: ' + it.advice,
            }, { checked: f.level === 'strong', quotes: [it.quote], label: it.kind });
          });
          return;
        }
        remarkRow(sec2, f.level, {
          title: f.title, quote: (f.quotes || [])[0] || '', advice: f.advice || '',
        }, { checked: f.level === 'strong', detail: f.detail, quotes: f.quotes || [] });
      });
      box.appendChild(sec2);
    }

    // Детектор ИИ.
    if (rep.detector) {
      var sec3 = el('div', 'rv-sec');
      sec3.appendChild(el('div', 'rv-sec-h', 'Детектор ИИ'));
      var d = rep.detector;
      if (!d.available) {
        sec3.appendChild(el('div', 'hint', 'Недоступен' + (d.error ? ': ' + d.error : '')));
      } else {
        sec3.appendChild(el('div', 'hint', 'Машинность: ' + Math.round((d.p_ai || 0) * 100)
          + ' % — ориентир, а не приговор: на текстах самого автора детектор ошибается.'));
        if (d.clean) sec3.appendChild(el('div', 'ok-line', 'Текст держится в диапазоне авторского стиля.'));
        (d.findings || []).forEach(function (f) {
          remarkRow(sec3, f.reliability === 'сильный' ? 'warn' : 'info',
            { title: f.title, advice: f.advice }, { checked: false });
        });
      }
      box.appendChild(sec3);
    }

    // Ссылки на закон.
    if (rep.legal && !rep.legal.unavailable && rep.legal.checked) {
      var sec4 = el('div', 'rv-sec');
      sec4.appendChild(el('div', 'rv-sec-h', 'Ссылки на закон'));
      var wrong = rep.legal.wrong || [];
      var unclear = rep.legal.unclear || [];
      sec4.appendChild(el('div', wrong.length ? 'warn-line' : 'ok-line',
        'Проверено ссылок: ' + rep.legal.checked + (wrong.length ? ', с ошибкой: ' + wrong.length : ', ошибок нет')));
      wrong.forEach(function (w) {
        remarkRow(sec4, 'strong', { title: 'Ссылка не сходится с текстом закона: ' + w.label,
          quote: w.label, advice: w.note || 'Сверить с текстом закона и исправить номер статьи.' },
          { checked: true });
      });
      unclear.forEach(function (w) {
        remarkRow(sec4, 'info', { title: 'Не удалось проверить: ' + w.label, advice: '' }, {});
      });
      box.appendChild(sec4);
    }

    // Правка по отмеченному.
    var fixRow = el('div', 'row rv-fix');
    var fixBtn = el('button', 'btn', 'Исправить отмеченное');
    var fixSt = el('span', 'status');
    fixRow.appendChild(fixBtn);
    fixRow.appendChild(fixSt);
    box.appendChild(fixRow);
    box.appendChild(el('div', 'hint', 'Модель поправит только отмеченные места, '
      + 'остальной текст останется как есть. Если раздел заметно сократится или '
      + 'пропадут сноски, правка не примется. Прежний вариант можно будет вернуть.'));

    function chosen() {
      return picks.filter(function (x) { return x.box.checked; }).map(function (x) { return x.remark; });
    }
    function updateFix() {
      var n = chosen().length;
      fixBtn.textContent = 'Исправить отмеченное' + (n ? ' (' + n + ')' : '');
      fixBtn.disabled = !n || !!job || stale;
    }
    updateFix();
    if (job && job.id === item.id) fixSt.textContent = job.status;
    else if (rep.fixError) { fixSt.textContent = rep.fixError; fixSt.classList.add('warn'); }

    fixBtn.onclick = function () {
      var remarks = chosen();
      if (!remarks.length) return;
      fixBtn.disabled = true;
      rep.fixError = '';
      revise(item, remarks).then(function () {
        // Отчёт относился к прежнему тексту — убираем, чтобы не путал.
        delete state.reviews[item.id];
        persist(state);
        if (paneRefresh) paneRefresh(true);
      }, function (err) {
        rep.fixError = String(err);
        persist(state);
        if (paneRefresh) paneRefresh();
      });
      if (paneRefresh) paneRefresh();
    };
  }

  /** Правку — на сервер той же позицией, чтобы она попала в «Мои работы». */
  function saveEdit(item, p, st) {
    if (!state.workId) { st.textContent = 'Правка сохранена в браузере'; return; }
    st.textContent = 'Сохраняю…';
    fetch('/api/v1/works/' + state.workId + '/pieces', {
      method: 'POST',
      headers: window.StudCore.ownerHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        kind: p.kind || (item.kind === 'chapter' ? 'section' : item.kind),
        number: p.number || null, heading: p.heading, text: p.text,
        position: item.position,
      }),
    })
      .then(function (r) { st.textContent = r.ok ? 'Правка сохранена' : 'Правка сохранена только в браузере'; })
      .catch(function () { st.textContent = 'Правка сохранена только в браузере'; });
  }

  // ------------------------------------------------ список литературы

  function allTexts() {
    return Object.keys(state.pieces).map(function (k) { return state.pieces[k].text; });
  }

  function paneBibliography() {
    var item = nav[nav.length - 1];
    pane.appendChild(el('h3', 'sec-h', 'Список литературы'));
    var sources = state.sources || [];

    if (!sources.length && !state.bibliography) {
      pane.appendChild(el('p', 'hint', 'Публикации подбираются при написании '
        + 'первого раздела и закрепляются за работой — так номера сносок '
        + 'совпадают во всех разделах. Только открытый доступ: '
        + 'КиберЛенинка, OpenAlex, Crossref.'));
    }

    var bib = L.bibliographyFrom(sources, allTexts());
    var manual = Array.isArray(state.bibliography);

    if (manual) {
      pane.appendChild(el('div', 'ok-line', 'Список поправлен вручную — в .docx уйдёт он.'));
    } else if (bib.entries.length) {
      pane.appendChild(el('p', 'hint', 'Так список уйдёт в .docx: только '
        + 'публикации, на которые ссылается текст, по ГОСТ Р 7.0.100-2018, '
        + 'по алфавиту. Ссылки [N] в тексте станут сносками.'));
    }

    var shown = manual ? state.bibliography : bib.entries;
    if (shown.length) {
      var ol = el('ol', 'sec-biblio');
      shown.forEach(function (e) { ol.appendChild(el('li', '', e)); });
      pane.appendChild(ol);
    }

    if (!manual && bib.unused.length) {
      pane.appendChild(el('div', 'hint', 'Подобраны, но текст на них пока не '
        + 'ссылается — в список не попадут: ' + bib.unused.map(function (u) {
          return '[' + u.n + '] ' + u.title;
        }).join('; ')));
    }
    if (bib.missing.length) {
      pane.appendChild(el('div', 'warn-line', 'В тексте есть ссылки на номера, '
        + 'которых нет в списке: ' + bib.missing.map(function (n) { return '[' + n + ']'; }).join(', ')
        + '. Такую сноску модель выдумала — уберите её или замените.'));
    }

    var row = el('div', 'row');
    var editBtn = el('button', 'btn ghost', manual ? 'Править список' : 'Поправить вручную');
    row.appendChild(editBtn);
    if (manual) {
      var reset = el('button', 'btn ghost', 'Вернуть автоматический');
      reset.onclick = function () { state.bibliography = null; persist(state); select('refs'); };
      row.appendChild(reset);
    }
    pane.appendChild(row);

    editBtn.onclick = function () {
      var area = el('textarea', 'sec-editor');
      area.rows = 12;
      area.value = shown.join('\n');
      area.placeholder = 'Одна запись — одна строка. Нумерация проставится сама.';
      pane.insertBefore(area, row.nextSibling);
      var r2 = el('div', 'row');
      var save = el('button', 'btn', 'Сохранить список');
      r2.appendChild(save);
      pane.insertBefore(r2, area.nextSibling);
      editBtn.disabled = true;
      save.onclick = function () {
        var lines = area.value.split('\n')
          .map(function (s) { return s.replace(/^\s*\d+[.)]\s*/, '').trim(); })
          .filter(Boolean);
        state.bibliography = lines.length ? lines : null;
        persist(state);
        select('refs');
        drawNav();
      };
    };

    stepper(item);
  }

  // ----------------------------------------------------- смена плана

  function renderChangePlan() {
    var b = body();
    b.appendChild(el('p', 'hint', 'Написанное по нынешнему плану не пропадёт: '
      + 'к нему можно вернуться из списка ниже.'));
    var back = el('button', 'btn ghost', '← К разделам');
    back.onclick = function () { renderMain(); };
    b.appendChild(back);
    pastePlan(b, state.plan);

    var store = readStore();
    var others = store.order.filter(function (h) { return store.works[h]; });
    if (others.length > 1) {
      b.appendChild(el('div', 'field', 'Работы по прежним планам'));
      others.forEach(function (h) {
        var w = store.works[h];
        var n = Object.keys(w.pieces || {}).length;
        var btn = el('button', 'toc-line lvl1' + (h === state.hash ? ' on' : ''));
        btn.type = 'button';
        btn.appendChild(el('span', '', (w.topic || 'Без темы') + ' — ' + w.plan.slice(0, 60).replace(/\s+/g, ' ') + '…'));
        btn.appendChild(el('span', 'toc-st' + (n ? ' done' : ''), 'разделов: ' + n));
        btn.onclick = function () {
          window.StudCore.savePlan(w.plan, w.topic);
          load(w.plan, w.topic);
        };
        b.appendChild(btn);
      });
    }
  }

  // --------------------------------------------------------- .docx

  function download(btn) {
    var pieces = writableItems()
      .filter(function (i) { return state.pieces[i.position]; })
      .map(function (i) {
        var p = state.pieces[i.position];
        return {
          kind: p.kind || i.kind, number: p.number || (i.task && i.task.number),
          heading: p.heading, chapterTitle: p.chapterTitle, text: p.text,
        };
      });
    if (!pieces.length) {
      progress.textContent = 'Пока нечего скачивать — напишите хотя бы один раздел.';
      return;
    }
    btn.disabled = true;
    var was = progress.textContent;
    progress.textContent = 'Собираю файл…';
    window.StudCore.exportFullDocx(pieces, {
      sources: state.sources || [], plan: state.plan, topic: state.topic,
      bibliography: state.bibliography || undefined,
    })
      .then(function () { progress.textContent = 'Файл скачан. ' + was; })
      .catch(function (e) { progress.textContent = 'Ошибка: ' + e.message; })
      .then(function () { btn.disabled = false; });
  }

  window.ModernSections = { open: open };
})();
