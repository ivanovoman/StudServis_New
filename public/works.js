/* Мои работы: список сохранённого, просмотр и удаление.
 *
 * Работы привязаны к ключу устройства — случайной строке в
 * localStorage. Полноценного входа ещё нет (модуль Users & Auth по ТЗ
 * отдельный), поэтому «мои работы» — это работы данного браузера. Ключ
 * переживает перезагрузку и закрытие вкладки, то есть решает главную
 * проблему: собранная курсовая больше не исчезает вместе со страницей.
 *
 * Оформление повторяет окна из tools.js, чтобы во всех шестнадцати
 * ретро-темах выглядело одинаково. Внешние стили не подключаются.
 */
(function () {
  'use strict';

  var KEY_NAME = 'studrabots_owner_key';
  var FONT = 'Courier New, Courier, monospace';

  var STATUS_TEXT = {
    draft: 'черновик',
    assembling: 'не дособрана',
    done: 'готова'
  };

  /** Ключ устройства. Заводится один раз при первом заходе. */
  function ownerKey() {
    try {
      var key = localStorage.getItem(KEY_NAME) || '';
      if (!key) {
        if (window.crypto && crypto.randomUUID) {
          key = crypto.randomUUID().replace(/-/g, '');
        } else {
          key = String(Date.now()) +
                Math.random().toString(16).slice(2) +
                Math.random().toString(16).slice(2);
        }
        localStorage.setItem(KEY_NAME, key);
      }
      return key;
    } catch (e) {
      // Приватный режим: localStorage недоступен. Работы сохранятся, но
      // после перезагрузки к ним уже не вернуться — ключ другой.
      if (!window.__studTempKey) {
        window.__studTempKey = 'temp' + String(Date.now()) +
                               Math.random().toString(16).slice(2);
      }
      return window.__studTempKey;
    }
  }

  function el(tag, style, text) {
    var node = document.createElement(tag);
    if (style) for (var k in style) node.style[k] = style[k];
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function btn() {
    return {
      background: '#000', color: '#e8e8e8', border: '1px solid #e8e8e8',
      padding: '4px 10px', cursor: 'pointer', fontFamily: FONT,
      fontSize: '13px'
    };
  }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers['X-Owner-Key'] = ownerKey();
    if (opts.body) opts.headers['Content-Type'] = 'application/json';
    return fetch('/api/v1/works' + path, opts).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          var msg = t;
          try { msg = JSON.parse(t).detail || t; } catch (e) {}
          throw new Error(msg || ('HTTP ' + r.status));
        });
      }
      return r.json();
    });
  }

  function human(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function openWorks() {
    if (window.StudTools && window.StudTools.closeModal) {
      window.StudTools.closeModal();
    }

    var overlay = el('div', {
      position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
      background: 'rgba(0,0,0,0.75)', zIndex: '1000',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: FONT
    });

    var panel = el('div', {
      width: 'min(820px, 92vw)', maxHeight: '88vh', display: 'flex',
      flexDirection: 'column', background: '#101010', color: '#e8e8e8',
      border: '2px solid #e8e8e8', boxShadow: '8px 8px 0 rgba(0,0,0,0.6)',
      padding: '14px', gap: '10px'
    });

    function close() {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener('keydown', onKey);
      overlay = null;
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);

    var bar = el('div', {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center'
    });
    bar.appendChild(el('div', { fontWeight: 'bold', letterSpacing: '2px' },
      '▓ МОИ РАБОТЫ ▓'));
    var x = el('button', btn(), '[X] Закрыть');
    x.onclick = close;
    bar.appendChild(x);
    panel.appendChild(bar);

    var status = el('div', { fontSize: '12px', opacity: '0.8' }, 'Загружаю…');
    panel.appendChild(status);

    var body = el('div', {
      flex: '1', overflow: 'auto', background: '#000',
      border: '1px solid #444', padding: '10px', fontSize: '13px',
      lineHeight: '1.5', minHeight: '160px'
    });
    panel.appendChild(body);

    overlay.appendChild(panel);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
    document.body.appendChild(overlay);

    showList(body, status);
    return close;
  }

  /** Экран со списком работ. */
  function showList(body, status) {
    body.innerHTML = '';
    status.textContent = 'Загружаю…';

    api('').then(function (data) {
      body.innerHTML = '';

      if (!data.works.length) {
        status.textContent = 'Сохранённых работ пока нет.';
        body.appendChild(el('div', { opacity: '0.8' },
          'Соберите работу в пункте 4 — она сохранится сама, по частям, '
          + 'прямо во время сборки. Даже если закрыть вкладку на середине, '
          + 'написанное останется здесь.'));
        return;
      }

      status.textContent = 'Работ сохранено: ' + data.works.length
        + '. Сохраняются автоматически во время сборки.';

      data.works.forEach(function (w) {
        var row = el('div', {
          borderTop: '1px solid #333', padding: '8px 0', display: 'flex',
          gap: '10px', alignItems: 'flex-start',
          justifyContent: 'space-between'
        });

        var left = el('div', { flex: '1', minWidth: '0' });
        left.appendChild(el('div', {
          fontWeight: 'bold', wordBreak: 'break-word'
        }, w.topic || 'Без темы'));
        left.appendChild(el('div', { fontSize: '12px', opacity: '0.7' },
          (STATUS_TEXT[w.status] || w.status)
          + ' · частей: ' + w.pieces
          + ' · ' + w.chars.toLocaleString('ru-RU') + ' знаков'
          + ' · ' + human(w.updated_at)));

        var right = el('div', { display: 'flex', gap: '6px', flexShrink: '0' });

        var open = el('button', btn(), 'Открыть');
        open.onclick = function () { showOne(w.id, body, status); };
        right.appendChild(open);

        var del = el('button', btn(), 'Удалить');
        del.onclick = function () {
          if (!confirm('Удалить работу «' + (w.topic || 'без темы')
                       + '»? Восстановить будет нельзя.')) return;
          del.disabled = true;
          api('/' + w.id, { method: 'DELETE' }).then(function () {
            if (row.parentNode) row.parentNode.removeChild(row);
            if (!body.querySelector('div')) showList(body, status);
          }).catch(function (e) {
            del.disabled = false;
            status.textContent = 'Не удалось удалить: ' + e.message;
          });
        };
        right.appendChild(del);

        row.appendChild(left);
        row.appendChild(right);
        body.appendChild(row);
      });
    }).catch(function (e) {
      status.textContent = 'Хранилище недоступно: ' + e.message;
      body.innerHTML = '';
      body.appendChild(el('div', { opacity: '0.8' },
        'Проверьте, что запущен Python-бэкенд на порту 8000. '
        + 'Без него генерация работает, но работы не сохраняются.'));
    });
  }

  /** Экран одной работы. */
  function showOne(id, body, status) {
    status.textContent = 'Открываю…';

    api('/' + id).then(function (w) {
      body.innerHTML = '';
      status.textContent = w.topic || 'Без темы';

      var actions = el('div', {
        display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap'
      });

      var back = el('button', btn(), '← К списку');
      back.onclick = function () { showList(body, status); };
      actions.appendChild(back);

      var docx = el('button', btn(), 'Скачать DOCX');
      docx.onclick = function () { exportWork(w, status, docx); };
      actions.appendChild(docx);

      body.appendChild(actions);

      var total = 0;
      w.pieces.forEach(function (p) { total += p.chars; });
      body.appendChild(el('div', { fontSize: '12px', opacity: '0.7',
                                   marginBottom: '8px' },
        'Частей: ' + w.pieces.length + ' · '
        + total.toLocaleString('ru-RU') + ' знаков без пробелов'
        + (w.status !== 'done'
            ? ' · работа не дособрана: часть разделов отсутствует' : '')));

      if (!w.pieces.length) {
        body.appendChild(el('div', { opacity: '0.8' },
          'В этой работе пока нет ни одной части.'));
        return;
      }

      w.pieces.forEach(function (p) {
        var block = el('div', { borderTop: '1px solid #333', padding: '8px 0' });
        block.appendChild(el('div', { fontWeight: 'bold' },
          (p.heading || p.kind) + ' — ' + p.chars + ' зн.'));
        block.appendChild(el('div', {
          whiteSpace: 'pre-wrap', maxHeight: '170px', overflow: 'auto',
          marginTop: '4px', opacity: '0.9'
        }, p.text || ''));
        body.appendChild(block);
      });
    }).catch(function (e) {
      status.textContent = 'Не удалось открыть: ' + e.message;
    });
  }

  /** Выгрузка сохранённой работы в DOCX по ГОСТ. */
  function exportWork(w, status, button) {
    var intro = '';
    var concl = '';
    var sections = [];
    var titles = {};

    w.pieces.forEach(function (p) {
      if (p.kind === 'introduction') intro = p.text;
      else if (p.kind === 'conclusion') concl = p.text;
      else {
        sections.push({ number: p.number, text: p.text });
        titles[p.number] = p.heading;
      }
    });

    button.disabled = true;
    status.textContent = 'Собираю документ…';

    fetch('/api/export-docx-full', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: w.topic, introduction: intro, sections: sections,
        conclusion: concl, sectionTitles: titles
      })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = (w.topic || 'Работа')
        .replace(/[^\wа-яА-ЯёЁ\- ]/g, '').slice(0, 80) + '.docx';
      document.body.appendChild(a);
      a.click();
      a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
      status.textContent = 'Документ скачан.';
      button.disabled = false;
    }).catch(function (e) {
      status.textContent = 'Не удалось собрать документ: ' + e.message;
      button.disabled = false;
    });
  }

  window.StudWorks = { openWorks: openWorks, ownerKey: ownerKey };
})();
