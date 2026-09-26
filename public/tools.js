/**
 * Пункты меню 5-7: подбор источников, оформление по ГОСТ, проверка на ИИ.
 *
 * Они отличаются от пунктов 1-3 тем, что ничего не генерируют. Каждый
 * берёт готовый текст и что-то с ним делает: ищет публикации по теме,
 * собирает .docx по ГОСТ, считает признаки машинности. Поэтому здесь
 * нет ни SSE, ни промптов, ни обращений к языковой модели — только
 * обычные запросы к Python-бэкенду, который всё это уже умеет.
 *
 * Модули на бэкенде были написаны раньше, но к интерфейсу подключены
 * не были: пункты меню показывали «функция в разработке», хотя код
 * работал и покрывался тестами. Этот файл закрывает именно разрыв
 * между готовым бэкендом и кнопкой.
 *
 * Стиль окна повторяет app.js намеренно: ретро-интерфейс должен
 * выглядеть единым, а не собранным из разных эпох.
 */
(function () {
  'use strict';

  var FONT = "'Courier New', monospace";

  function el(tag, styles, text) {
    var node = document.createElement(tag);
    Object.assign(node.style, styles || {});
    if (text != null) node.textContent = text;
    return node;
  }

  function btnStyle() {
    return {
      background: '#000', color: '#e8e8e8', border: '1px solid #e8e8e8',
      fontFamily: FONT, fontSize: '13px', padding: '5px 10px',
      cursor: 'pointer',
    };
  }

  /** Описание каждого инструмента: заголовок, подсказка, что делает. */
  var TOOLS = {
    sources: {
      title: 'ПОДБОР ИСТОЧНИКОВ',
      hint: 'Публикации открытого доступа по теме работы. Ищем в OpenAlex '
          + 'и КиберЛенинке.',
      placeholder: 'Уточните направление поиска или оставьте пустым — '
                 + 'возьмём тему из настроек…',
      button: '[▶] Искать',
      needsText: false,
    },
    gost: {
      title: 'ОФОРМЛЕНИЕ ПО ГОСТ',
      hint: 'Собирает .docx по ГОСТ 7.32: поля, шрифт, интервалы, '
          + 'заголовки, нумерация страниц.',
      placeholder: 'Вставьте текст работы или её части…',
      button: '[↓] Собрать .docx',
      needsText: true,
    },
    detector: {
      title: 'ПРОВЕРКА НА ИИ',
      hint: 'Свой детектор, откалиброванный на текстах автора. Показывает, '
          + 'что именно выдаёт машину и что переписать.',
      placeholder: 'Вставьте текст для проверки…',
      button: '[▶] Проверить',
      needsText: true,
    },
  };

  /**
   * Открыть окно инструмента.
   *
   * @param {object} cfg  запись из MENU_STEPS: {tool, title}
   */
  function openTool(cfg) {
    var spec = TOOLS[cfg.tool];
    if (!spec) return;

    if (window.StudTools && window.StudTools.closeModal) {
      window.StudTools.closeModal();
    }

    var overlay = el('div', {
      position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
      background: 'rgba(0,0,0,0.75)', zIndex: '1000',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: FONT,
    });

    var panel = el('div', {
      width: 'min(820px, 92vw)', maxHeight: '88vh', display: 'flex',
      flexDirection: 'column', background: '#101010', color: '#e8e8e8',
      border: '2px solid #e8e8e8', boxShadow: '8px 8px 0 rgba(0,0,0,0.6)',
      padding: '14px', gap: '10px',
    });

    function close() {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener('keydown', onKey);
      overlay = null;
    }

    function onKey(e) {
      if (e.key === 'Escape') close();
    }

    var titleBar = el('div', {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    });
    titleBar.appendChild(el('div', { fontWeight: 'bold', letterSpacing: '2px' },
      '▓ ' + spec.title + ' ▓'));
    var closeBtn = el('button', btnStyle(), '[X] Закрыть');
    closeBtn.onclick = close;
    titleBar.appendChild(closeBtn);
    panel.appendChild(titleBar);

    panel.appendChild(el('div', { fontSize: '12px', opacity: '0.7' },
      spec.hint));

    var input = el('textarea', {
      width: '100%', minHeight: spec.needsText ? '120px' : '56px',
      resize: 'vertical', boxSizing: 'border-box', background: '#000',
      color: '#e8e8e8', border: '1px solid #888', fontFamily: FONT,
      fontSize: '14px', padding: '8px',
    });
    input.placeholder = spec.placeholder;
    panel.appendChild(input);

    var controls = el('div', {
      display: 'flex', gap: '10px', alignItems: 'center',
    });
    var runBtn = el('button', btnStyle(), spec.button);
    var status = el('span', { fontSize: '12px', opacity: '0.8' }, '');
    controls.appendChild(runBtn);
    controls.appendChild(status);
    panel.appendChild(controls);

    var out = el('div', {
      flex: '1', overflow: 'auto', background: '#000',
      border: '1px solid #444', padding: '10px', fontSize: '13px',
      lineHeight: '1.5', minHeight: '140px',
    });
    panel.appendChild(out);

    panel.appendChild(el('div', {
      fontSize: '11px', opacity: '0.6', textAlign: 'center',
    }, '[Esc] — закрыть окно'));

    overlay.appendChild(panel);
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) close();
    });
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    input.focus();

    var busy = false;

    runBtn.onclick = function () {
      if (busy) return;
      var text = input.value.trim();

      if (spec.needsText && !text) {
        status.textContent = 'Нужен текст';
        return;
      }

      busy = true;
      runBtn.disabled = true;
      out.textContent = '';
      status.textContent = 'Работаю…';

      var settings = (window.StudTools && window.StudTools.getSettings)
        ? window.StudTools.getSettings()
        : {};

      var done = function (msg) {
        busy = false;
        runBtn.disabled = false;
        status.textContent = msg || '';
      };

      if (cfg.tool === 'sources') runSources(text, settings, out, done);
      if (cfg.tool === 'detector') runDetector(text, out, done);
      if (cfg.tool === 'gost') runGost(text, settings, out, done);
    };
  }

  // --- 5. Подбор источников -------------------------------------------

  function runSources(text, settings, out, done) {
    var topic = settings.topic || text;
    if (!topic) {
      out.appendChild(el('div', { color: '#ffcc66' },
        '⚠ Тема не задана. Укажите её в настройках или впишите здесь.'));
      done('');
      return;
    }

    fetch('/api/v1/sources/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: topic,
        directions: text ? [text] : [topic],
        limit: 8,
        with_fulltext: false,
      }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error('бэкенд ответил ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data.count) {
          out.appendChild(el('div', { color: '#ffcc66' },
            '⚠ По этой теме ничего не нашлось. Попробуйте другие слова: '
          + 'базы ищут по названиям и аннотациям.'));
          done('Пусто');
          return;
        }

        out.appendChild(el('div', { fontWeight: 'bold', marginBottom: '8px' },
          '▓ Найдено публикаций: ' + data.count));

        data.sources.forEach(function (s, i) {
          var row = el('div', { marginBottom: '9px' });
          var head = (i + 1) + '. ' + s.title;

          if (s.url) {
            var a = el('a', {
              color: '#7fd0ff', textDecoration: 'underline',
            }, head);
            a.href = s.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            row.appendChild(a);
          } else {
            row.appendChild(el('div', {}, head));
          }

          var meta = [];
          if (s.authors && s.authors.length) meta.push(s.authors.slice(0, 3).join(', '));
          if (s.year) meta.push(String(s.year));
          if (s.venue) meta.push(s.venue);
          if (s.provider) meta.push(s.provider);
          if (s.is_oa) meta.push('открытый доступ');
          if (s.doi) meta.push('DOI ' + s.doi);

          row.appendChild(el('div', {
            opacity: '0.65', paddingLeft: '14px', fontSize: '12px',
          }, meta.join(' · ')));

          out.appendChild(row);
        });

        out.appendChild(el('div', {
          marginTop: '10px', paddingTop: '8px', borderTop: '1px solid #333',
          fontSize: '12px', opacity: '0.7',
        }, 'Ссылки ведут на первоисточник. Перед включением в список '
         + 'литературы откройте и проверьте: базы иногда путают год и '
         + 'авторов.'));

        done('Готово');
      })
      .catch(function (e) {
        out.appendChild(el('div', { color: '#ff9999' },
          '✕ Поиск не удался: ' + e.message
        + '. Проверьте, что запущен Python-бэкенд на порту 8000.'));
        done('Ошибка');
      });
  }

  // --- 7. Проверка на ИИ ----------------------------------------------

  function runDetector(text, out, done) {
    fetch('/api/v1/humanizer/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error('бэкенд ответил ' + r.status);
        return r.json();
      })
      .then(function (d) {
        if (!d.available) {
          out.appendChild(el('div', { color: '#ffcc66' },
            '⚠ Детектор недоступен: ' + (d.error || 'причина неизвестна')));
          done('Недоступен');
          return;
        }

        // Итоговая вероятность выводится, но нарочно не как вердикт:
        // на текстах самого автора она даёт 3 ложных срабатывания из 7,
        // поэтому воротами приёмки её ставить нельзя.
        var pct = Math.round((d.p_ai || 0) * 100);
        out.appendChild(el('div', {
          fontWeight: 'bold', marginBottom: '4px',
        }, '▓ Машинность: ' + pct + '%'));
        out.appendChild(el('div', {
          fontSize: '12px', opacity: '0.7', marginBottom: '10px',
        }, d.p_ai_note || ''));

        if (d.clean) {
          out.appendChild(el('div', { color: '#8fd18f' },
            '✓ Претензий нет: текст держится в диапазоне авторского стиля.'));
          done('Готово');
          return;
        }

        out.appendChild(el('div', {
          fontWeight: 'bold', marginBottom: '6px',
        }, 'Что выдаёт машину:'));

        (d.findings || []).forEach(function (f) {
          var row = el('div', {
            marginBottom: '8px', paddingLeft: '8px',
            borderLeft: '2px solid '
              + (f.reliability === 'сильный' ? '#c0392b' : '#8a6d3b'),
          });
          row.appendChild(el('div', { color: '#ffb0b0' },
            '• ' + f.title + '  (признак ' + f.code
          + ', надёжность: ' + f.reliability + ')'));
          row.appendChild(el('div', {
            opacity: '0.8', fontSize: '12px', paddingLeft: '10px',
          }, f.advice));
          out.appendChild(row);
        });

        if (d.ignored_as_noise && d.ignored_as_noise.length) {
          out.appendChild(el('div', {
            marginTop: '8px', fontSize: '12px', opacity: '0.6',
          }, 'Отброшено как шум: ' + d.ignored_as_noise.join(', ')));
        }

        out.appendChild(el('div', {
          marginTop: '10px', paddingTop: '8px', borderTop: '1px solid #333',
          fontSize: '12px', opacity: '0.7',
        }, 'Детектор откалиброван на '
         + (d.author_corpus_size || '?') + ' текстах автора. Проценты — '
         + 'ориентир, а не приговор: правьте по списку выше, он конкретнее.'));

        done('Готово');
      })
      .catch(function (e) {
        out.appendChild(el('div', { color: '#ff9999' },
          '✕ Проверка не удалась: ' + e.message
        + '. Проверьте, что запущен Python-бэкенд на порту 8000.'));
        done('Ошибка');
      });
  }

  // --- 6. Оформление по ГОСТ ------------------------------------------

  function runGost(text, settings, out, done) {
    var title = settings.topic || 'Работа';

    fetch('/api/v1/documents/export/fragment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title,
        text: text,
        is_h1: true,
      }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error('бэкенд ответил ' + r.status);
        return r.blob();
      })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = title + '.docx';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Освобождаем ссылку не сразу: Safari успевает начать загрузку
        // только если объект ещё жив в момент клика.
        setTimeout(function () { URL.revokeObjectURL(url); }, 10000);

        out.appendChild(el('div', { color: '#8fd18f', marginBottom: '8px' },
          '✓ Файл собран и скачан: ' + title + '.docx'));
        out.appendChild(el('div', { fontSize: '12px', opacity: '0.75' },
          'Применено: поля 30/20/20/10 мм, Times New Roman 14 пт, '
        + 'полуторный интервал, абзацный отступ 1,25 см, нумерация '
        + 'страниц снизу по центру, заголовки без точки в конце.'));
        out.appendChild(el('div', {
          marginTop: '10px', paddingTop: '8px', borderTop: '1px solid #333',
          fontSize: '12px', opacity: '0.7',
        }, 'Требования вуза бывают строже ГОСТа. Если методичка задаёт '
         + 'своё — сверьте поля и шрифт в Word.'));

        done('Готово');
      })
      .catch(function (e) {
        out.appendChild(el('div', { color: '#ff9999' },
          '✕ Сборка не удалась: ' + e.message
        + '. Проверьте, что запущен Python-бэкенд на порту 8000.'));
        done('Ошибка');
      });
  }

  window.StudToolsUI = { openTool: openTool };
})();
