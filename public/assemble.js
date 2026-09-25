/**
 * Пункт 4 меню: сборка всей работы по готовому плану.
 *
 * Самый долгий пункт сервиса. На плане из трёх глав по три раздела это
 * одиннадцать обращений к модели и минут пятнадцать-двадцать ожидания.
 * Поэтому окно устроено не как «нажал и жди», а как стройка на виду:
 * сначала показывается разобранная структура (что именно будет
 * написано), потом каждый готовый кусок появляется в списке сразу, как
 * только пришёл.
 *
 * Такой порядок выбран намеренно. Пользователь должен увидеть ошибку в
 * структуре до того, как потратит двадцать минут: если в плане не те
 * разделы, лучше закрыть окно на первой секунде.
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

  function openAssemble() {
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
      width: 'min(860px, 94vw)', maxHeight: '90vh', display: 'flex',
      flexDirection: 'column', background: '#101010', color: '#e8e8e8',
      border: '2px solid #e8e8e8', boxShadow: '8px 8px 0 rgba(0,0,0,0.6)',
      padding: '14px', gap: '10px',
    });

    var reader = null;   // чтобы прервать поток при закрытии

    function close() {
      if (reader) { try { reader.cancel(); } catch (e) { /* уже закрыт */ } }
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener('keydown', onKey);
      overlay = null;
    }

    function onKey(e) { if (e.key === 'Escape') close(); }

    var titleBar = el('div', {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    });
    titleBar.appendChild(el('div', { fontWeight: 'bold', letterSpacing: '2px' },
      '▓ СБОРКА КУРСОВОЙ ▓'));
    var closeBtn = el('button', btnStyle(), '[X] Закрыть');
    closeBtn.onclick = close;
    titleBar.appendChild(closeBtn);
    panel.appendChild(titleBar);

    panel.appendChild(el('div', { fontSize: '12px', opacity: '0.7' },
      'Вставьте план из пункта 2. Работа пишется по разделам: введение, '
    + 'каждый раздел, заключение. Это долго — от десяти минут.'));

    var input = el('textarea', {
      width: '100%', minHeight: '90px', resize: 'vertical',
      boxSizing: 'border-box', background: '#000', color: '#e8e8e8',
      border: '1px solid #888', fontFamily: FONT, fontSize: '13px',
      padding: '8px',
    });
    input.placeholder = 'Вставьте сюда план работы…';
    panel.appendChild(input);

    var controls = el('div', {
      display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap',
    });
    var runBtn = el('button', btnStyle(), '[▶] Собрать работу');
    var docxBtn = el('button', btnStyle(), '[↓] Скачать .docx');
    docxBtn.style.display = 'none';
    var status = el('span', { fontSize: '12px', opacity: '0.85' }, '');
    controls.appendChild(runBtn);
    controls.appendChild(docxBtn);
    controls.appendChild(status);
    panel.appendChild(controls);

    // Полоса прогресса: на длинной операции без неё непонятно, жив ли
    // процесс вообще.
    var barWrap = el('div', {
      display: 'none', height: '14px', border: '1px solid #666',
      background: '#000',
    });
    var bar = el('div', {
      height: '100%', width: '0%', background: '#4a7a4a',
      transition: 'width 0.3s',
    });
    barWrap.appendChild(bar);
    panel.appendChild(barWrap);

    // Отдельная строка про сохранение: в общий статус её класть нельзя,
    // он всё время перерисовывается ходом сборки.
    var savedNote = el('div', {
      fontSize: '11px', opacity: '0.75', color: '#8fbf8f',
    }, '');
    panel.appendChild(savedNote);

    // На чём построен текст. Показываем отдельно: это и есть ответ на
    // вопрос «откуда взялись сноски».
    var sourcesNote = el('div', {
      fontSize: '11px', opacity: '0.75', color: '#8fbf8f',
    }, '');
    panel.appendChild(sourcesNote);

    var out = el('div', {
      flex: '1', overflow: 'auto', background: '#000',
      border: '1px solid #444', padding: '10px', fontSize: '13px',
      lineHeight: '1.5', minHeight: '180px',
    });
    panel.appendChild(out);

    panel.appendChild(el('div', {
      fontSize: '11px', opacity: '0.6', textAlign: 'center',
    }, '[Esc] — закрыть окно. Закрытие прерывает сборку.'));

    overlay.appendChild(panel);
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) close();
    });
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    input.focus();

    var busy = false;
    var collected = [];     // готовые куски для экспорта
    // Публикации, на которых построен текст. Нужны при экспорте,
    // чтобы маркеры [3] превратились в правильные сноски.
    var usedSources = [];
    var pendingLegal = null;  // сверка ссылок, ждущая своего куска

    runBtn.onclick = function () {
      if (busy) return;
      var plan = input.value.trim();
      if (plan.length < 100) {
        status.textContent = 'Нужен план работы из пункта 2';
        return;
      }

      busy = true;
      runBtn.disabled = true;
      docxBtn.style.display = 'none';
      out.textContent = '';
      collected = [];
      barWrap.style.display = '';
      bar.style.width = '0%';
      status.textContent = 'Разбираю план…';

      var settings = (window.StudTools && window.StudTools.getSettings)
        ? window.StudTools.getSettings() : {};

      run(plan, settings);
    };

    function run(plan, settings) {
      fetch('/api/assemble', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Ключ устройства нужен, чтобы сервер сохранял работу по
        // частям: закрытая вкладка больше не стоит двух минут сборки.
        body: JSON.stringify({
          plan: plan,
          settings: settings,
          ownerKey: window.StudWorks ? window.StudWorks.ownerKey() : ''
        }),
      })
        .then(function (resp) {
          if (!resp.ok) {
            return resp.json().then(function (d) {
              throw new Error(d.error || ('сервер ответил ' + resp.status));
            });
          }
          reader = resp.body.getReader();
          var decoder = new TextDecoder();
          var buffer = '';

          function pump() {
            return reader.read().then(function (r) {
              if (r.done) { finish(); return; }
              buffer += decoder.decode(r.value, { stream: true });
              var lines = buffer.split('\n');
              buffer = lines.pop();
              lines.forEach(function (line) {
                var t = line.trim();
                if (t.indexOf('data:') !== 0) return;
                var payload = t.slice(5).trim();
                if (payload === '[DONE]') return;
                try { handle(JSON.parse(payload)); } catch (e) { /* мусор */ }
              });
              return pump();
            });
          }
          return pump();
        })
        .catch(function (e) {
          out.appendChild(el('div', { color: '#ff9999' },
            '✕ ' + e.message));
          finish('Ошибка');
        });
    }

    function finish(msg) {
      busy = false;
      runBtn.disabled = false;
      reader = null;
      status.textContent = msg || status.textContent;
      if (collected.length) docxBtn.style.display = '';
    }

    function handle(ev) {
      if (ev.outline) renderOutline(ev);
      if (ev.sources) {
        // Те же публикации, на которые ссылается текст. Их обязательно
        // нужно передать при экспорте: номер [3] в разделе означает
        // третий источник ИЗ ЭТОГО списка. Подбирать заново нельзя —
        // выдача изменится, и сноски начнут врать.
        usedSources = ev.sources;
        sourcesNote.textContent = 'Опора: ' + ev.sources.length
          + ' публикаций, ссылки на них станут сносками в документе.';
      }
      if (ev.progress) {
        var p = ev.progress;
        status.textContent = 'Пишу ' + p.index + ' из ' + p.total
                           + ': ' + p.title;
        bar.style.width = Math.round((p.index - 1) / p.total * 100) + '%';
      }
      if (ev.saved) {
        // Пользователь должен видеть, что закрывать вкладку уже не
        // страшно — иначе он сидит и ждёт из страха потерять текст.
        savedNote.textContent = 'Работа сохраняется — её можно будет '
          + 'открыть в «Моих работах», даже если закрыть вкладку.';
      }
      if (ev.expanding) {
        // Дописывание занимает столько же, сколько сам раздел. Без
        // подписи выглядит как зависший прогресс.
        var x = ev.expanding;
        status.textContent = 'Раздел вышел коротким (' + x.have + ' из '
          + x.need + ' знаков) — дописываю'
          + (x.attempt > 1 ? ' (попытка ' + x.attempt + ')' : '');
      }
      // Сверка ссылок на закон приходит перед самим куском — придержим
      // её, чтобы показать прямо под заголовком раздела, к которому она
      // относится, а не отдельной строкой непонятно о чём.
      if (ev.legal) { pendingLegal = ev.legal; }

      if (ev.piece) {
        collected.push(ev.piece);
        var row = el('div', {
          marginBottom: '4px', paddingLeft: '8px',
          borderLeft: '2px solid #4a7a4a',
        });
        row.appendChild(el('div', { color: '#8fd18f' },
          '✓ ' + ev.piece.heading));
        row.appendChild(el('div', { opacity: '0.6', fontSize: '12px' },
          ev.piece.chars + ' знаков без пробелов'));

        // Автозамена смешанных слов. Показываем всегда: транслитерация
        // угадывает не идеально, и человек должен видеть, что правилось.
        if (ev.piece.fixed && ev.piece.fixed.length) {
          row.appendChild(el('div', {
            opacity: '0.75', fontSize: '12px', color: '#ffcc66',
          }, 'Исправлена латиница в словах: '
           + ev.piece.fixed.map(function (f) {
               return f.from + ' → ' + f.to;
             }).join(', ')
           + ' — проверьте, что замена верна'));
        }

        // Выдуманные номера статей — самая дорогая ошибка в юрработе:
        // выглядит она безупречно, а на защите обнаруживается сразу.
        if (pendingLegal) {
          if (pendingLegal.wrong && pendingLegal.wrong.length) {
            row.appendChild(el('div', {
              fontSize: '12px', color: '#ff9999', marginTop: '3px',
            }, 'Ссылки на закон не сходятся — исправьте:'));
            pendingLegal.wrong.forEach(function (w) {
              row.appendChild(el('div', {
                fontSize: '12px', color: '#ff9999', paddingLeft: '10px',
              }, '• ' + w.label + ' — ' + w.note));
            });
          }
          if (pendingLegal.unclear && pendingLegal.unclear.length) {
            row.appendChild(el('div', {
              fontSize: '12px', opacity: '0.7', marginTop: '3px',
            }, 'Сверить не удалось, взгляните сами: '
             + pendingLegal.unclear.map(function (u) {
                 return u.label;
               }).join(', ')));
          }
          pendingLegal = null;
        }

        out.appendChild(row);
        out.scrollTop = out.scrollHeight;
      }
      if (ev.failed) {
        var f = el('div', {
          marginBottom: '4px', paddingLeft: '8px',
          borderLeft: '2px solid #c0392b', color: '#ff9999',
        });
        f.appendChild(el('div', {}, '✕ ' + ev.failed.heading));
        f.appendChild(el('div', { opacity: '0.7', fontSize: '12px' },
          ev.failed.reason + ' — этот кусок можно дописать отдельно '
        + 'через пункт 3'));
        out.appendChild(f);
        out.scrollTop = out.scrollHeight;
      }
      if (ev.finished) {
        bar.style.width = '100%';
        var total = collected.reduce(function (a, p) { return a + p.chars; }, 0);
        var sum = el('div', {
          marginTop: '10px', paddingTop: '8px', borderTop: '1px solid #333',
        });
        sum.appendChild(el('div', { fontWeight: 'bold' },
          'Готово: ' + ev.finished.written + ' частей, '
        + total + ' знаков без пробелов'));
        if (ev.finished.failed) {
          sum.appendChild(el('div', { color: '#ffcc66' },
            'Не получилось частей: ' + ev.finished.failed
          + '. Допишите их через пункт 3 и вставьте в документ.'));
        }
        var lg = ev.finished.legal;
        if (lg) {
          sum.appendChild(el('div', {
            fontSize: '12px',
            color: lg.wrong ? '#ff9999' : '#8fd18f',
          }, lg.wrong
            ? ('Ссылок на статьи проверено: ' + lg.checked
             + ', не сходится: ' + lg.wrong + ' — они отмечены выше')
            : ('Ссылки на статьи проверены по кодексам: ' + lg.checked
             + ', расхождений нет')));
        }
        sum.appendChild(el('div', { fontSize: '12px', opacity: '0.7' },
          'Текст написан моделью по вашему плану. Реквизиты норм и '
        + 'судебной практики проверьте: модель их помнит неточно.'));
        out.appendChild(sum);
        out.scrollTop = out.scrollHeight;
        finish('Готово');
      }
    }

    function renderOutline(ev) {
      var box = el('div', { marginBottom: '10px' });
      box.appendChild(el('div', { fontWeight: 'bold', marginBottom: '5px' },
        '▓ Структура: глав ' + ev.outline.length
      + ', частей ' + ev.total));

      ev.outline.forEach(function (c) {
        box.appendChild(el('div', { marginTop: '4px' },
          'Глава ' + c.number + '. ' + c.title));
        c.sections.forEach(function (s) {
          box.appendChild(el('div', { opacity: '0.7', paddingLeft: '16px' },
            s.number + ' ' + s.title));
        });
      });

      (ev.warnings || []).forEach(function (w) {
        box.appendChild(el('div', { color: '#ffcc66', marginTop: '4px' },
          '⚠ ' + w));
      });

      box.appendChild(el('div', {
        marginTop: '8px', paddingTop: '6px', borderTop: '1px solid #333',
        fontSize: '12px', opacity: '0.7',
      }, 'Если структура не та — закройте окно и поправьте план.'));

      out.appendChild(box);
    }

    // Сборка .docx из написанного. Разделы уходят с номерами и
    // заголовками, чтобы документ собрался по ГОСТ, а не слитным текстом.
    docxBtn.onclick = function () {
      var settings = (window.StudTools && window.StudTools.getSettings)
        ? window.StudTools.getSettings() : {};

      var intro = '';
      var conclusion = '';
      var sections = [];
      var sectionTitles = {};

      collected.forEach(function (p) {
        if (p.kind === 'introduction') intro = p.text;
        else if (p.kind === 'conclusion') conclusion = p.text;
        else {
          sections.push({ number: p.number, text: p.text });
          sectionTitles[p.number] = p.heading.replace(/^[\d.]+\s*/, '');
        }
      });

      status.textContent = 'Собираю .docx…';

      fetch('/api/export-docx-full', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: settings.topic || 'Курсовая работа',
          introduction: intro,
          sections: sections,
          conclusion: conclusion,
          sectionTitles: sectionTitles,
          // Титульный лист: то, что пользователь ввёл в настройках.
          // Тема берётся из настроек работы, а не из полей титула.
          // Публикации сборки — по ним маркеры [3] станут сносками.
          sources: usedSources,
          titlePage: Object.assign({}, settings.titlePage || {}, {
            topic: settings.topic || '',
            university: settings.university || (settings.titlePage || {}).university || '',
          }),
        }),
      })
        .then(function (r) {
          if (!r.ok) throw new Error('сервер ответил ' + r.status);
          return r.blob();
        })
        .then(function (blob) {
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = (settings.topic || 'Курсовая работа') + '.docx';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
          status.textContent = 'Файл скачан';
        })
        .catch(function (e) {
          status.textContent = 'Не удалось собрать файл: ' + e.message;
        });
    };
  }

  window.StudAssemble = { openAssemble: openAssemble };
})();
