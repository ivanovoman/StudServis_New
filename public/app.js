/* app.js — общая логика для всех ретро-тем.
 * Подключается каждой темой (<script src="../app.js"></script>) и
 * навешивает обработчики на пункты главного меню по их номеру.
 * Реализованные шаги открывают модальное окно с вводом, потоковым
 * выводом генерации и скачиванием результата в .docx.
 */
(function () {
  'use strict';

  // step id бэкенда для каждого пункта меню (null — ещё не реализован)
  var MENU_STEPS = {
    1: { step: 'analysis', title: 'АНАЛИЗ ПРОБЛЕМЫ', placeholder: 'Введите тему курсовой работы…', docTitle: 'Анализ проблемы' },
    2: null, 3: null, 4: null, 5: null, 6: null, 7: null, 8: null,
  };

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
      docxBtn.style.display = 'none';
      status.textContent = 'Генерация…';
      runBtn.disabled = true;

      streamGenerate(cfg.step, topic, function onDelta(delta) {
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
  function streamGenerate(step, input, onDelta, onDone) {
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

  // Находит пункты меню по ведущему номеру («1.», «1)» и т.п.) в текстовом
  // содержимом — устроено так, чтобы работать во всех темах без правки их разметки.
  function wireMenu() {
    var candidates = document.querySelectorAll('.menu-item, .item, .popup-item');
    candidates.forEach(function (node) {
      var m = (node.textContent || '').trim().match(/^([1-8])[.)]/);
      if (!m) return;
      var num = Number(m[1]);
      var cfg = MENU_STEPS[num];
      node.style.cursor = 'pointer';
      node.addEventListener('click', function () {
        if (cfg) {
          openModal(cfg);
        } else {
          openStub(num);
        }
      });
    });
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
