/* app.js — общая логика для всех ретро-тем.
 * Подключается каждой темой (<script src="../app.js"></script>) и
 * навешивает обработчики на пункты главного меню по их номеру.
 * Реализованные шаги открывают модальное окно с вводом, потоковым
 * выводом генерации и скачиванием результата в .docx.
 */
(function () {
  'use strict';

  // step id бэкенда для каждого пункта меню (null — ещё не реализован).
  //
  // needsSettings — нужны ли пункту настройки работы. Их требуют шаги,
  // которые пишут текст: им важны тема, вуз, методичка, объёмы и
  // источники. Проверка готового текста настроек не требует — там
  // пользователь просто вставляет свой текст, и спрашивать про
  // методичку было бы навязчиво.
  var MENU_STEPS = {
    1: { step: 'analysis', title: 'АНАЛИЗ ПРОБЛЕМЫ', docTitle: 'Анализ проблемы',
         placeholder: 'Тема берётся из настроек. Здесь можно уточнить акцент…',
         needsSettings: true },
    2: { step: 'plan', title: 'ПЛАН РАБОТЫ', docTitle: 'План работы',
         placeholder: 'Вставьте анализ темы (или заполните настройки и нажмите 1)…',
         needsSettings: true },
    3: { step: 'introduction', title: 'ВВЕДЕНИЕ', docTitle: 'Введение',
         placeholder: 'Вставьте план работы…',
         needsSettings: true },
    4: null,   // «Создать курсовую» — сборка из нескольких шагов, отдельная задача
    5: null,   // «Источники» — ждёт эндпоинта подбора на бэкенде
    6: null,   // «ГОСТ» — оформление документа
    7: null,   // «Проверка на ИИ» — есть в Python-бэкенде, не подключено к Node
    8: { step: 'speech', title: 'РЕЧЬ ПО РАБОТЕ', docTitle: 'Речь для защиты',
         placeholder: 'Вставьте текст готовой работы…',
         needsSettings: true },
  };

  // Пункты, для которых кнопка «Настройки» неактивна.
  function settingsEnabledFor(num) {
    var cfg = MENU_STEPS[num];
    return !!(cfg && cfg.needsSettings);
  }

  // Настройки текущей работы. Пока живут в памяти вкладки: постоянное
  // хранение появится вместе с модулем Projects на PostgreSQL.
  var settings = {
    topic: '',
    university: '',
    methodichka: '',
    wishes: '',
    sources: [],   // [{filename, chars, title}]
  };

  function settingsFilled() {
    return settings.topic.trim().length >= 5;
  }

  var FONT = "'Courier New', monospace";
  var overlay = null;
  var lastResult = '';
  var lastTopic = '';
  var generating = false;

  function el(tag, styles, text) {
    var node = document.createElement(tag);
    if (styles) for (var k in styles) node.style[k] = styles[k];
    if (text) node.textContent = text;
    return node;
  }

  function closeModal() {
    if (overlay) { overlay.remove(); overlay = null; }
    document.removeEventListener('keydown', onKeyDown);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') closeModal();
  }

  function openModal(cfg) {
    closeModal();
    lastResult = '';
    lastTopic = '';
    generating = false;

    overlay = el('div', {
      position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
      background: 'rgba(0,0,0,0.75)', zIndex: '1000',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: FONT,
    });

    var panel = el('div', {
      width: 'min(820px, 92vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column',
      background: '#101010', color: '#e8e8e8', border: '2px solid #e8e8e8',
      boxShadow: '8px 8px 0 rgba(0,0,0,0.6)', padding: '14px', gap: '10px',
    });

    var titleBar = el('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center' });
    titleBar.appendChild(el('div', { fontWeight: 'bold', letterSpacing: '2px' }, '▓ ' + cfg.title + ' ▓'));
    var closeBtn = el('button', btnStyle(), '[X] Закрыть');
    closeBtn.onclick = closeModal;
    titleBar.appendChild(closeBtn);
    panel.appendChild(titleBar);

    var input = el('textarea', {
      width: '100%', minHeight: '56px', resize: 'vertical', boxSizing: 'border-box',
      background: '#000', color: '#e8e8e8', border: '1px solid #888',
      fontFamily: FONT, fontSize: '14px', padding: '8px',
    });
    input.placeholder = cfg.placeholder;
    panel.appendChild(input);

    var controls = el('div', { display: 'flex', gap: '10px', alignItems: 'center' });
    var runBtn = el('button', btnStyle(), '[▶] Выполнить');
    var docxBtn = el('button', btnStyle(), '[↓] Скачать .docx');
    docxBtn.style.display = 'none';
    var status = el('span', { fontSize: '12px', opacity: '0.8' }, '');
    controls.appendChild(runBtn);
    controls.appendChild(docxBtn);
    controls.appendChild(status);
    panel.appendChild(controls);

    // Панель источников. Скрыта, пока их не нашли: на шагах без
    // grounding она только занимала бы место.
    var sourcesBox = el('div', {
      display: 'none', fontSize: '12px', lineHeight: '1.45',
      background: '#000', border: '1px solid #444', padding: '8px 10px',
      maxHeight: '150px', overflow: 'auto',
    });
    panel.appendChild(sourcesBox);

    // Показывает, на какие публикации опирается разбор. Пользователь
    // должен видеть основания, а не доверять тексту на слово.
    function renderSources(list) {
      sourcesBox.textContent = '';
      sourcesBox.style.display = '';
      sourcesBox.style.borderColor = '#444';
      sourcesBox.appendChild(el('div',
        { fontWeight: 'bold', marginBottom: '6px' },
        '▓ Опора: найдено публикаций — ' + list.length));

      list.forEach(function (src, i) {
        var row = el('div', { marginBottom: '5px' });
        var head = (i + 1) + '. ' + src.title;
        if (src.url) {
          var a = el('a', { color: '#7fd0ff', textDecoration: 'underline' }, head);
          a.href = src.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          row.appendChild(a);
        } else {
          row.appendChild(el('span', {}, head));
        }
        var meta = [];
        if (src.year) meta.push(String(src.year));
        if (src.provider) meta.push(src.provider);
        if (src.has_fulltext) meta.push('полный текст');
        if (src.doi) meta.push('DOI');
        row.appendChild(el('div', { opacity: '0.65', paddingLeft: '14px' },
          meta.join(' · ')));
        sourcesBox.appendChild(row);
      });
    }

    // Источников нет — говорим прямо, что текст держится только на
    // памяти модели и требует проверки.
    function renderNotice(text) {
      sourcesBox.textContent = '';
      sourcesBox.style.display = '';
      sourcesBox.style.borderColor = '#a87f2a';
      sourcesBox.appendChild(el('div', { color: '#ffcc66' }, '⚠ ' + text));
    }

    var output = el('pre', {
      flex: '1', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      background: '#000', border: '1px solid #444', padding: '10px', margin: '0',
      minHeight: '180px', fontFamily: FONT, fontSize: '13px', lineHeight: '1.5',
    });
    panel.appendChild(output);
    panel.appendChild(el('div', { fontSize: '11px', opacity: '0.6', textAlign: 'center' },
      '[Esc] — закрыть окно'));

    overlay.appendChild(panel);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeModal(); });
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeyDown);
    input.focus();

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runBtn.click(); }
    });

    runBtn.onclick = function () {
      var topic = input.value.trim();
      if (!topic || generating) return;
      generating = true;
      lastTopic = topic;
      lastResult = '';
      output.textContent = '';
      sourcesBox.style.display = 'none';
      sourcesBox.textContent = '';
      docxBtn.style.display = 'none';
      status.textContent = 'Ищу источники…';
      runBtn.disabled = true;

      streamGenerate(cfg.step, topic, function onDelta(delta) {
        if (!lastResult) status.textContent = 'Генерация…';
        lastResult += delta;
        output.textContent = lastResult;
        output.scrollTop = output.scrollHeight;
      }, function onDone(err) {
        generating = false;
        runBtn.disabled = false;
        if (err) {
          status.textContent = 'Ошибка: ' + err;
        } else {
          status.textContent = 'Готово';
          if (lastResult.trim()) docxBtn.style.display = '';
        }
      }, function onEvent(ev) {
        if (ev.sources) renderSources(ev.sources);
        else if (ev.notice) renderNotice(ev.notice);
      });
    };

    docxBtn.onclick = function () {
      if (!lastResult.trim()) return;
      status.textContent = 'Собираю .docx…';
      fetch('/api/export-docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: cfg.docTitle + ' — ' + lastTopic, text: lastResult, isH1: true }),
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || r.status); });
        return r.blob();
      }).then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (cfg.docTitle + ' — ' + lastTopic).slice(0, 60) + '.docx';
        a.click();
        URL.revokeObjectURL(a.href);
        status.textContent = 'Файл скачан';
      }).catch(function (e) {
        status.textContent = 'Ошибка экспорта: ' + e.message;
      });
    };
  }

  function btnStyle() {
    return {
      background: '#e8e8e8', color: '#101010', border: 'none', cursor: 'pointer',
      fontFamily: FONT, fontSize: '13px', fontWeight: 'bold', padding: '6px 12px',
    };
  }

  // Читает SSE-поток /api/generate и отдаёт кусочки текста в onDelta.
  // onEvent (необязателен) получает служебные сообщения: список
  // найденных источников и предупреждения.
  function streamGenerate(step, input, onDelta, onDone, onEvent) {
    fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: step, input: input }),
    }).then(function (res) {
      if (!res.ok) {
        return res.json().then(function (j) { throw new Error(j.error || ('HTTP ' + res.status)); });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { onDone(null); return; }
          buffer += decoder.decode(r.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.indexOf('data:') !== 0) continue;
            var data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              var parsed = JSON.parse(data);
              if (parsed.error) { onDone(parsed.error); return; }
              if (parsed.delta) onDelta(parsed.delta);
              if (onEvent && (parsed.sources || parsed.notice)) onEvent(parsed);
            } catch (e) { /* пропускаем невалидные строки */ }
          }
          return pump();
        });
      }
      return pump();
    }).catch(function (e) {
      onDone(e.message);
    });
  }

  // ------------------------------------------------------ НАСТРОЙКИ

  function fieldRow(labelText, node) {
    var wrap = el('div', { display: 'flex', flexDirection: 'column', gap: '4px' });
    wrap.appendChild(el('div', { fontSize: '12px', opacity: '0.8' }, labelText));
    wrap.appendChild(node);
    return wrap;
  }

  function textField(value, minHeight) {
    var t = el('textarea', {
      width: '100%', minHeight: minHeight || '38px', resize: 'vertical',
      boxSizing: 'border-box', background: '#000', color: '#e8e8e8',
      border: '1px solid #888', fontFamily: FONT, fontSize: '13px', padding: '6px',
    });
    t.value = value || '';
    return t;
  }

  // Список загруженных источников. Файлы разбираются на бэкенде: там
  // уже умеют снимать титульный лист и оглавление, а браузер PDF не
  // читает.
  function renderSourceList(box) {
    box.textContent = '';
    if (!settings.sources.length) {
      box.appendChild(el('div', { fontSize: '12px', opacity: '0.6' },
        'Источники не загружены. Без них анализ опирается на автопоиск.'));
      return;
    }
    settings.sources.forEach(function (src, i) {
      var row = el('div', {
        display: 'flex', justifyContent: 'space-between', gap: '8px',
        fontSize: '12px', borderBottom: '1px solid #333', padding: '3px 0',
      });
      row.appendChild(el('div', { flex: '1', overflow: 'hidden' },
        (i + 1) + '. ' + (src.title || src.filename) + '  (' + src.chars + ' зн.)'));
      var del = el('button', btnStyle(), '[x]');
      del.style.padding = '0 6px';
      del.onclick = function () {
        settings.sources.splice(i, 1);
        renderSourceList(box);
      };
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  function uploadSources(files, statusNode, listNode) {
    if (!files || !files.length) return;
    var form = new FormData();
    for (var i = 0; i < files.length; i++) form.append('files', files[i]);
    statusNode.textContent = 'Загрузка ' + files.length + ' файл(ов)…';

    fetch('/api/v1/projects/upload/sources', { method: 'POST', body: form })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        (data.accepted || []).forEach(function (a) {
          settings.sources.push({
            filename: a.filename,
            chars: a.chars,
            title: (a.source && a.source.title) || a.filename,
            text: (a.source && a.source.fulltext) || '',
          });
        });
        var msg = 'Принято: ' + (data.accepted || []).length;
        if ((data.rejected || []).length) {
          msg += '. Отклонено: ' + data.rejected.map(function (r) {
            return r.filename + ' — ' + r.reason;
          }).join('; ');
        }
        statusNode.textContent = msg;
        renderSourceList(listNode);
      })
      .catch(function (e) {
        statusNode.textContent = 'Ошибка загрузки: ' + e.message;
      });
  }

  function openSettings(onSaved) {
    closeModal();
    overlay = el('div', {
      position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
      background: 'rgba(0,0,0,0.75)', zIndex: '1000',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: FONT,
    });

    var panel = el('div', {
      width: 'min(760px, 94vw)', maxHeight: '90vh', overflowY: 'auto',
      display: 'flex', flexDirection: 'column', gap: '10px',
      background: '#101010', color: '#e8e8e8', border: '2px solid #e8e8e8',
      boxShadow: '8px 8px 0 rgba(0,0,0,0.6)', padding: '14px',
    });

    var titleBar = el('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center' });
    titleBar.appendChild(el('div', { fontWeight: 'bold', letterSpacing: '2px' }, '▓ НАСТРОЙКИ РАБОТЫ ▓'));
    var closeBtn = el('button', btnStyle(), '[X] Закрыть');
    closeBtn.onclick = closeModal;
    titleBar.appendChild(closeBtn);
    panel.appendChild(titleBar);

    var topic = textField(settings.topic);
    topic.placeholder = 'Например: Субсидиарная ответственность контролирующих должника лиц';
    panel.appendChild(fieldRow('Тема работы (обязательно)', topic));

    var uni = textField(settings.university);
    uni.placeholder = 'Название вуза, кафедра';
    panel.appendChild(fieldRow('Учебное заведение', uni));

    var meth = textField(settings.methodichka, '60px');
    meth.placeholder = 'Вставьте текст методички или загрузите файл ниже';
    panel.appendChild(fieldRow('Методичка', meth));

    var methStatus = el('div', { fontSize: '12px', opacity: '0.8' }, '');
    var methInput = el('input');
    methInput.type = 'file';
    methInput.accept = '.pdf,.docx,.txt,.md,.rtf';
    methInput.style.fontFamily = FONT;
    methInput.style.fontSize = '12px';
    methInput.onchange = function () {
      if (!methInput.files.length) return;
      var form = new FormData();
      form.append('file', methInput.files[0]);
      methStatus.textContent = 'Разбор методички…';
      fetch('/api/v1/projects/upload/methodichka', { method: 'POST', body: form })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.detail) { methStatus.textContent = 'Ошибка: ' + d.detail; return; }
          meth.value = d.text || '';
          var found = (d.found || []).map(function (f) {
            return f.field + ' = ' + f.value;
          }).join(', ');
          methStatus.textContent = found
            ? 'Распознано: ' + found + '. Проверьте перед запуском.'
            : 'Текст загружен, требования распознать не удалось.';
        })
        .catch(function (e) { methStatus.textContent = 'Ошибка: ' + e.message; });
    };
    panel.appendChild(fieldRow('Загрузить методичку файлом', methInput));
    panel.appendChild(methStatus);

    var wishes = textField(settings.wishes, '48px');
    wishes.placeholder = 'Например: две главы, больше судебной практики, без таблиц';
    panel.appendChild(fieldRow('Пожелания к работе', wishes));

    // --- источники
    panel.appendChild(el('div', {
      borderTop: '1px solid #444', marginTop: '4px', paddingTop: '8px',
      fontWeight: 'bold', fontSize: '13px',
    }, 'ИСТОЧНИКИ'));

    var srcStatus = el('div', { fontSize: '12px', opacity: '0.8' }, '');
    var srcList = el('div', { display: 'flex', flexDirection: 'column' });
    renderSourceList(srcList);

    var srcInput = el('input');
    srcInput.type = 'file';
    srcInput.multiple = true;
    srcInput.accept = '.pdf,.docx,.txt,.md,.rtf';
    srcInput.style.fontFamily = FONT;
    srcInput.style.fontSize = '12px';
    srcInput.onchange = function () {
      uploadSources(srcInput.files, srcStatus, srcList);
      srcInput.value = '';
    };
    panel.appendChild(fieldRow('Добавить свои статьи (PDF, DOCX, TXT)', srcInput));
    panel.appendChild(srcStatus);
    panel.appendChild(srcList);

    // --- кнопки
    var actions = el('div', { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '6px' });
    var hint = el('div', { flex: '1', fontSize: '12px', opacity: '0.7' }, '');
    actions.appendChild(hint);

    var save = el('button', btnStyle(), '[Сохранить]');
    save.onclick = function () {
      if (topic.value.trim().length < 5) {
        hint.textContent = 'Укажите тему работы — без неё шаги не запустятся.';
        return;
      }
      settings.topic = topic.value.trim();
      settings.university = uni.value.trim();
      settings.methodichka = meth.value.trim();
      settings.wishes = wishes.value.trim();
      closeModal();
      if (onSaved) onSaved();
    };
    actions.appendChild(save);
    panel.appendChild(actions);

    overlay.appendChild(panel);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeModal(); });
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeyDown);
    topic.focus();
  }

  // Находит пункты меню по ведущему номеру («1.», «1)» и т.п.) в текстовом
  // содержимом — устроено так, чтобы работать во всех темах без правки их разметки.
  function wireMenu() {
    var candidates = document.querySelectorAll('.menu-item, .item, .popup-item');

    candidates.forEach(function (node) {
      // Отдельная кнопка настроек: она не пункт конвейера и работает
      // независимо от того, какой шаг выбран.
      if (node.getAttribute('data-action') === 'settings') {
        node.style.cursor = 'pointer';
        node.addEventListener('click', function () { openSettings(null); });
        return;
      }

      var m = (node.textContent || '').trim().match(/^([1-8])[.)]/);
      if (!m) return;
      var num = Number(m[1]);
      var cfg = MENU_STEPS[num];
      node.style.cursor = 'pointer';
      node.addEventListener('click', function () {
        if (!cfg) { openStub(num); return; }
        // Шаги, которые пишут текст, без темы работать не могут:
        // сначала настройки, потом сам шаг.
        if (cfg.needsSettings && !settingsFilled()) {
          openSettings(function () { openModal(cfg); });
          return;
        }
        openModal(cfg);
      });
    });

    highlightSettingsButton();
  }

  // Кнопка настроек тускнеет, когда активный пункт в них не нуждается.
  // Совсем прятать её не стоит: пользователь должен видеть, что
  // настройки существуют.
  function highlightSettingsButton() {
    var active = document.querySelector('.item.active, .menu-item.active, .popup-item.active');
    var num = active ? Number((active.textContent || '').trim().match(/^([1-8])[.)]/) ? RegExp.$1 : 0) : 0;
    var btn = document.querySelector('[data-action="settings"]');
    if (!btn) return;
    var enabled = !num || settingsEnabledFor(num);
    btn.style.opacity = enabled ? '1' : '0.45';
    btn.title = enabled
      ? 'Тема, методичка, пожелания и свои источники'
      : 'Для этого пункта настройки не нужны';
  }

  function openStub(num) {
    closeModal();
    overlay = el('div', {
      position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
      background: 'rgba(0,0,0,0.75)', zIndex: '1000',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT,
    });
    var panel = el('div', {
      background: '#101010', color: '#e8e8e8', border: '2px solid #e8e8e8',
      padding: '24px 32px', textAlign: 'center', boxShadow: '8px 8px 0 rgba(0,0,0,0.6)',
    });
    panel.appendChild(el('div', { marginBottom: '12px', fontWeight: 'bold' }, '▓ ПУНКТ ' + num + ' ▓'));
    panel.appendChild(el('div', { marginBottom: '16px' }, 'Функция в разработке'));
    var ok = el('button', btnStyle(), '[OK]');
    ok.onclick = closeModal;
    panel.appendChild(ok);
    overlay.appendChild(panel);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeModal(); });
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeyDown);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireMenu);
  } else {
    wireMenu();
  }
})();
