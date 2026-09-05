/**
 * Современный интерфейс. Оформление — карточки и модальные окна в духе
 * apple.com; вся содержательная логика взята из app-core.js, чтобы
 * ретро-версия и эта не разъезжались.
 */
(function () {
  'use strict';

  var STEPS = window.StudCore.STEPS;

  // ------------------------------------------------------- карточки

  var grid = document.getElementById('grid');

  Object.keys(STEPS).forEach(function (num) {
    var cfg = STEPS[num];
    var ready = !!cfg.step;

    var card = document.createElement('button');
    card.className = 'card' + (ready ? '' : ' disabled');
    card.type = 'button';
    if (!ready) card.setAttribute('aria-disabled', 'true');

    var tag = document.createElement('span');
    if (cfg.free) { tag.className = 'tag free'; tag.textContent = 'Бесплатно'; }
    else if (!ready) { tag.className = 'tag soon'; tag.textContent = 'Скоро'; }
    if (tag.className) card.appendChild(tag);

    var n = document.createElement('span');
    n.className = 'num';
    n.textContent = num;
    card.appendChild(n);

    var h = document.createElement('h3');
    h.textContent = cfg.title;
    card.appendChild(h);

    var p = document.createElement('p');
    p.textContent = cfg.short;
    card.appendChild(p);

    if (ready) card.onclick = function () { openSheet(num); };
    grid.appendChild(card);
  });

  // -------------------------------------------------- модальное окно

  var scrim = null;

  function closeSheet() {
    if (!scrim) return;
    scrim.remove();
    scrim = null;
    document.removeEventListener('keydown', onEsc);
    document.body.style.overflow = '';
  }

  function onEsc(e) {
    if (e.key === 'Escape') closeSheet();
  }

  function openSheet(num) {
    var cfg = STEPS[num];
    closeSheet();

    scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.addEventListener('mousedown', function (e) {
      if (e.target === scrim) closeSheet();
    });

    var sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', cfg.title);
    scrim.appendChild(sheet);

    // --- шапка
    var head = document.createElement('div');
    head.className = 'sheet-head';
    var h2 = document.createElement('h2');
    h2.textContent = cfg.title;
    head.appendChild(h2);
    var x = document.createElement('button');
    x.className = 'x';
    x.setAttribute('aria-label', 'Закрыть');
    x.textContent = '\u2715';
    x.onclick = closeSheet;
    head.appendChild(x);
    sheet.appendChild(head);

    // --- тело
    var body = document.createElement('div');
    body.className = 'sheet-body';
    sheet.appendChild(body);

    var label = document.createElement('label');
    label.className = 'field';
    label.textContent = cfg.placeholder;
    label.htmlFor = 'sheet-input';
    body.appendChild(label);

    var input = document.createElement('textarea');
    input.id = 'sheet-input';
    input.rows = 3;
    body.appendChild(input);

    var row = document.createElement('div');
    row.className = 'row';
    body.appendChild(row);

    var run = document.createElement('button');
    run.className = 'btn';
    run.textContent = 'Выполнить';
    row.appendChild(run);

    var dl = document.createElement('button');
    dl.className = 'btn ghost';
    dl.textContent = 'Скачать .docx';
    dl.style.display = 'none';
    row.appendChild(dl);

    var status = document.createElement('span');
    status.className = 'status';
    row.appendChild(status);

    var sources = document.createElement('div');
    sources.style.display = 'none';
    body.appendChild(sources);

    var out = document.createElement('div');
    out.className = 'out';
    body.appendChild(out);

    var errBox = null;
    var result = '';
    var busy = false;

    // Показывает, на какие публикации опирается разбор: пользователь
    // должен видеть основания, а не верить тексту на слово.
    function renderSources(list) {
      sources.className = 'sources';
      sources.style.display = '';
      sources.textContent = '';

      var title = document.createElement('h4');
      title.textContent = 'Опора: найдено публикаций — ' + list.length;
      sources.appendChild(title);

      var ol = document.createElement('ol');
      list.forEach(function (s) {
        var li = document.createElement('li');
        if (s.url) {
          var a = document.createElement('a');
          a.href = s.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = s.title;
          li.appendChild(a);
        } else {
          li.appendChild(document.createTextNode(s.title));
        }
        var meta = [];
        if (s.year) meta.push(String(s.year));
        if (s.provider) meta.push(s.provider);
        if (s.has_fulltext) meta.push('полный текст');
        var m = document.createElement('div');
        m.className = 'meta';
        m.textContent = meta.join(' · ');
        li.appendChild(m);
        ol.appendChild(li);
      });
      sources.appendChild(ol);
    }

    function renderNotice(text) {
      sources.className = 'sources warn';
      sources.style.display = '';
      sources.textContent = text;
    }

    function setStatus(text, spinner) {
      status.textContent = '';
      if (spinner) {
        var d = document.createElement('span');
        d.className = 'dots';
        d.innerHTML = '<i></i><i></i><i></i>';
        status.appendChild(d);
      }
      status.appendChild(document.createTextNode(text));
    }

    run.onclick = function () {
      var value = input.value.trim();
      if (!value || busy) return;

      busy = true;
      result = '';
      out.textContent = '';
      dl.style.display = 'none';
      sources.style.display = 'none';
      if (errBox) { errBox.remove(); errBox = null; }
      run.disabled = true;
      setStatus('Ищу источники', true);

      window.StudCore.generate({
        step: cfg.step,
        input: value,
        onDelta: function (delta) {
          if (!result) setStatus('Генерация', true);
          result += delta;
          out.textContent = result;
          out.scrollTop = out.scrollHeight;
        },
        onEvent: function (ev) {
          if (ev.sources) renderSources(ev.sources);
          else if (ev.notice) renderNotice(ev.notice);
        },
        onDone: function (err) {
          busy = false;
          run.disabled = false;
          if (err) {
            setStatus('', false);
            errBox = document.createElement('div');
            errBox.className = 'err';
            errBox.textContent = err;
            body.appendChild(errBox);
          } else {
            setStatus('Готово', false);
            if (result.trim()) dl.style.display = '';
          }
        },
      });
    };

    dl.onclick = function () {
      if (!result.trim()) return;
      var name = cfg.docTitle + ' — ' + input.value.trim().slice(0, 40);
      setStatus('Собираю файл', true);
      window.StudCore.exportDocx(name, result).then(function () {
        setStatus('Файл скачан', false);
      }).catch(function (e) {
        setStatus('Ошибка экспорта: ' + e.message, false);
      });
    };

    // Ctrl+Enter — привычное «отправить» в текстовом поле.
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        run.click();
      }
    });

    document.body.appendChild(scrim);
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onEsc);
    input.focus();
  }

  // ------------------------------------------------------- навигация

  document.getElementById('btn-retro').onclick = function () {
    // Возврат к ретро: снимаем отметку и разрешаем заставку снова.
    localStorage.removeItem('studservis_modern_ui');
    sessionStorage.removeItem('studservis_intro_seen');
    window.location.href = '/';
  };

  document.getElementById('btn-settings').onclick = function () {
    alert('Настройки работы появятся здесь: тема, вуз, методичка, объёмы.\n'
        + 'Пока их можно задать в ретро-режиме.');
  };
})();
