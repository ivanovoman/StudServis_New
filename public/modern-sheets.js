/**
 * Экраны современного интерфейса, которым мало одного поля ввода:
 * настройки работы, инструменты 5-7 и сборка черновика.
 *
 * Вся содержательная логика — те же запросы, что делает ретро-версия:
 * бэкенд один, и расходиться поведению нельзя. Отличается только
 * оформление: здесь карточки и светлые панели, там — рамки из
 * псевдографики. Поэтому файл рисует, но не решает: где нужен разбор
 * ответа сервера, он повторяет смысл ретро-версии слово в слово
 * (проценты детектора — ориентир, а не вердикт; источники видны
 * пользователю целиком).
 *
 * Экспортируется как window.ModernSheets.
 */
(function () {
  'use strict';

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function field(body, labelText, control) {
    var wrap = el('div', 'frow');
    var lab = el('label', 'field', labelText);
    wrap.appendChild(lab);
    wrap.appendChild(control);
    body.appendChild(wrap);
    return control;
  }

  function note(body, text) {
    var n = el('div', 'hint', text);
    body.appendChild(n);
    return n;
  }

  // ------------------------------------------------------- настройки

  /**
   * Настройки работы: тема, вуз, методичка, пожелания, число глав.
   *
   * Раньше здесь стоял alert со словами «задайте их в ретро-режиме», а
   * генерация шла с пустыми настройками — молча и заметно хуже.
   */
  function openSettings() {
    var shell = window.ModernUI.openShell('Настройки работы');
    var body = shell.body;
    var s = window.StudCore.getSettings();

    note(body, 'Настройки общие для обоих интерфейсов и переживают '
             + 'перезагрузку страницы.');

    var topic = field(body, 'Тема работы',
      Object.assign(el('input'), { type: 'text', value: s.topic || '',
        placeholder: 'Например: Договор аренды нежилого помещения' }));

    var uni = field(body, 'Вуз, кафедра',
      Object.assign(el('input'), { type: 'text', value: s.university || '',
        placeholder: 'МФЮА, кафедра гражданского права' }));

    var meth = field(body, 'Методичка вуза',
      Object.assign(el('textarea'), { rows: 3, value: s.methodichka || '',
        placeholder: 'Требования к объёму, оформлению, структуре — как в '
                   + 'методичке' }));

    // Методичку нужно уметь приложить файлом. Просить человека
    // скопировать двадцать страниц из PDF — значит получить обрывок
    // без требований к объёму, то есть худший результат.
    var methFile = document.createElement('input');
    methFile.type = 'file';
    methFile.accept = '.pdf,.docx,.txt,.md,.rtf';
    field(body, 'Или загрузите файл методички', methFile);
    var methStatus = el('div', 'hint');
    body.appendChild(methStatus);

    methFile.onchange = function () {
      if (!methFile.files.length) return;
      var form = new FormData();
      form.append('file', methFile.files[0]);
      methStatus.textContent = 'Разбираю методичку…';
      fetch('/api/v1/projects/upload/methodichka', {
        method: 'POST', body: form,
      })
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

    var wishes = field(body, 'Пожелания к работе',
      Object.assign(el('textarea'), { rows: 2, value: s.wishes || '',
        placeholder: 'Например: больше судебной практики, без таблиц' }));

    // Число глав не навязываем: курсовая бывает и двухглавой, а
    // методичка вуза может прямо требовать две.
    var chapWrap = el('div', 'radios');
    var chapters = [['Решает модель', ''], ['2 главы', '2'], ['3 главы', '3']];
    var radios = [];
    chapters.forEach(function (opt) {
      var id = 'ch-' + (opt[1] || 'auto');
      var lbl = el('label', 'radio');
      var r = el('input');
      r.type = 'radio';
      r.name = 'chapters';
      r.value = opt[1];
      r.id = id;
      r.checked = String(s.chapters || '') === opt[1];
      lbl.appendChild(r);
      lbl.appendChild(document.createTextNode(opt[0]));
      chapWrap.appendChild(lbl);
      radios.push(r);
    });
    field(body, 'Число глав', chapWrap);

    var row = el('div', 'row');
    var save = el('button', 'btn', 'Сохранить');
    row.appendChild(save);
    var status = el('span', 'status');
    row.appendChild(status);
    body.appendChild(row);

    save.onclick = function () {
      var picked = radios.filter(function (r) { return r.checked; })[0];
      window.StudCore.saveSettings({
        topic: topic.value.trim(),
        university: uni.value.trim(),
        methodichka: meth.value.trim(),
        wishes: wishes.value.trim(),
        chapters: picked && picked.value ? Number(picked.value) : null,
      });
      status.textContent = 'Сохранено';
      setTimeout(shell.close, 450);
    };

    topic.focus();
  }

  // ----------------------------------------------------- инструменты

  var TOOLS = {
    sources: {
      hint: 'Публикации открытого доступа по теме работы: OpenAlex, '
          + 'КиберЛенинка, Crossref, DOAJ.',
      placeholder: 'Уточните направление поиска или оставьте пустым — '
                 + 'возьмём тему из настроек',
      button: 'Искать',
      needsText: false,
    },
    gost: {
      hint: 'Собирает .docx по ГОСТ: поля, шрифт, интервалы, заголовки, '
          + 'нумерация страниц.',
      placeholder: 'Вставьте текст работы или её части',
      button: 'Собрать .docx',
      needsText: true,
    },
    detector: {
      hint: 'Свой детектор, откалиброванный на текстах автора. Показывает, '
          + 'что именно выдаёт машину и что переписать.',
      placeholder: 'Вставьте текст для проверки',
      button: 'Проверить',
      needsText: true,
    },
  };

  function openTool(cfg) {
    var tool = TOOLS[cfg.tool];
    var shell = window.ModernUI.openShell(cfg.title);
    var body = shell.body;

    note(body, tool.hint);

    var input = el('textarea');
    input.rows = tool.needsText ? 6 : 2;
    input.placeholder = tool.placeholder;
    body.appendChild(input);

    var row = el('div', 'row');
    var run = el('button', 'btn', tool.button);
    row.appendChild(run);
    var status = el('span', 'status');
    row.appendChild(status);
    body.appendChild(row);

    var out = el('div', 'out');
    body.appendChild(out);

    run.onclick = function () {
      var text = input.value.trim();
      if (tool.needsText && !text) {
        status.textContent = 'Нужен текст';
        return;
      }

      out.textContent = '';
      run.disabled = true;
      status.textContent = 'Работаю…';

      function done(msg) {
        run.disabled = false;
        status.textContent = msg;
      }

      var settings = window.StudCore.getSettings();
      if (cfg.tool === 'sources') runSources(text, settings, out, done);
      else if (cfg.tool === 'gost') runGost(text, settings, out, done);
      else runDetector(text, out, done);
    };

    input.focus();
  }

  function warn(out, text) {
    out.appendChild(el('div', 'warn-line', text));
  }

  function fail(out, done, e) {
    warn(out, 'Не удалось: ' + e.message + '. Проверьте, что запущен '
            + 'Python-бэкенд на порту 8000.');
    done('Ошибка');
  }

  // --- 5. Подбор источников

  function runSources(text, settings, out, done) {
    var topic = settings.topic || text;
    if (!topic) {
      warn(out, 'Тема не задана. Укажите её в настройках или впишите здесь.');
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
      .then(function (d) {
        if (!d.count) {
          warn(out, 'По этой теме ничего не нашлось. Попробуйте другие '
                  + 'слова: базы ищут по названиям и аннотациям.');
          done('Пусто');
          return;
        }

        var box = el('div', 'sources');
        box.appendChild(el('h4', null, 'Найдено публикаций — ' + d.count));
        var ol = document.createElement('ol');
        (d.sources || []).forEach(function (s) {
          var li = document.createElement('li');
          if (s.url) {
            var a = el('a', null, s.title);
            a.href = s.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            li.appendChild(a);
          } else {
            li.appendChild(document.createTextNode(s.title));
          }
          var meta = [];
          if (s.year) meta.push(String(s.year));
          if (s.provider) meta.push(s.provider);
          if (s.has_fulltext) meta.push('полный текст');
          li.appendChild(el('div', 'meta', meta.join(' · ')));
          ol.appendChild(li);
        });
        box.appendChild(ol);
        out.appendChild(box);

        if (d.bibliography) {
          out.appendChild(el('h4', null, 'Список по ГОСТ'));
          out.appendChild(el('pre', 'biblio', d.bibliography));
        }
        done('Готово');
      })
      .catch(function (e) { fail(out, done, e); });
  }

  // --- 6. Оформление по ГОСТ

  function runGost(text, settings, out, done) {
    fetch('/api/v1/documents/export/fragment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: settings.topic || 'Работа',
        text: text,
        is_h1: true,
      }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error('бэкенд ответил ' + r.status);
        return r.blob();
      })
      .then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (settings.topic || 'Работа').slice(0, 60) + '.docx';
        a.click();
        URL.revokeObjectURL(a.href);
        out.appendChild(el('div', 'ok-line', 'Файл собран и скачан.'));
        done('Готово');
      })
      .catch(function (e) { fail(out, done, e); });
  }

  // --- 7. Проверка на ИИ

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
          warn(out, 'Детектор недоступен: ' + (d.error || 'причина неизвестна'));
          done('Недоступен');
          return;
        }

        // Процент показываем, но нарочно не как вердикт: на текстах
        // самого автора он даёт 3 ложных срабатывания из 7, поэтому
        // воротами приёмки его ставить нельзя.
        var pct = Math.round((d.p_ai || 0) * 100);
        out.appendChild(el('div', 'score', 'Машинность: ' + pct + '%'));
        if (d.p_ai_note) out.appendChild(el('div', 'hint', d.p_ai_note));

        if (d.clean) {
          out.appendChild(el('div', 'ok-line',
            'Претензий нет: текст держится в диапазоне авторского стиля.'));
          done('Готово');
          return;
        }

        out.appendChild(el('h4', null, 'Что выдаёт машину'));
        (d.findings || []).forEach(function (f) {
          var row = el('div', 'finding'
            + (f.reliability === 'сильный' ? ' strong' : ''));
          row.appendChild(el('div', 'ftitle',
            f.title + ' (признак ' + f.code + ', надёжность: '
          + f.reliability + ')'));
          row.appendChild(el('div', 'fadvice', f.advice));
          out.appendChild(row);
        });

        if (d.ignored_as_noise && d.ignored_as_noise.length) {
          out.appendChild(el('div', 'hint',
            'Отброшено как шум: ' + d.ignored_as_noise.join(', ')));
        }
        out.appendChild(el('div', 'hint',
          'Детектор откалиброван на ' + (d.author_corpus_size || '?')
        + ' текстах автора. Проценты — ориентир, а не приговор: правьте '
        + 'по списку выше, он конкретнее.'));
        done('Готово');
      })
      .catch(function (e) { fail(out, done, e); });
  }


  /**
   * Развилка пункта 4: писать по разделам или собрать всё разом.
   *
   * Сборка целиком быстрее на вид — одна кнопка и три минуты, — но
   * результат человек видит уже готовым и правит вслепую. Работа по
   * разделам дольше, зато каждый кусок можно прочитать и переписать.
   * Выбор оставляем за пользователем, умолчание — по разделам.
   */
  function openWriting() {
    var shell = window.ModernUI.openShell('Написать работу');
    var body = shell.body;

    body.appendChild(el('div', 'hint',
      'Два способа. Выберите тот, что подходит сейчас.'));

    var byParts = el('div', 'piece');
    byParts.appendChild(el('div', 'ftitle', 'По разделам — рекомендуем'));
    byParts.appendChild(el('div', 'hint',
      'План превращается в список. Пишете по одному пункту, читаете, '
    + 'правите руками или переписываете заново. Каждая часть '
    + 'сохраняется сразу.'));
    var b1 = el('button', 'btn', 'Открыть по разделам');
    byParts.appendChild(b1);
    body.appendChild(byParts);

    var whole = el('div', 'piece');
    whole.appendChild(el('div', 'ftitle', 'Всё разом'));
    whole.appendChild(el('div', 'hint',
      'Черновик целиком примерно за три минуты. Удобно, когда нужен '
    + 'общий каркас, а править вы будете уже в Word.'));
    var b2 = el('button', 'btn ghost', 'Собрать целиком');
    whole.appendChild(b2);
    body.appendChild(whole);

    b1.onclick = function () { window.ModernWorkbench.open(); };
    b2.onclick = function () { openAssemble(); };
  }

  // ----------------------------------------------- 4. сборка работы

  /**
   * Сборка черновика по готовому плану.
   *
   * Идёт около трёх минут и пишет части по очереди, поэтому окно
   * показывает ход дела: структуру, долю готового, каждую написанную
   * часть и отдельно — те, что не удались. Молчащий индикатор на
   * три минуты пользователь читает как зависание.
   */
  function openAssemble() {
    var shell = window.ModernUI.openShell('Собрать черновик работы');
    var body = shell.body;

    note(body, 'Вставьте готовый план работы. Сборка занимает около трёх '
             + 'минут: части пишутся по очереди, каждая — со сносками на '
             + 'найденные источники.');

    var input = el('textarea');
    input.rows = 8;
    input.placeholder = 'Вставьте план: главы и параграфы';
    body.appendChild(input);

    var row = el('div', 'row');
    var run = el('button', 'btn', 'Собрать');
    row.appendChild(run);
    var dl = el('button', 'btn ghost', 'Скачать .docx');
    dl.style.display = 'none';
    row.appendChild(dl);
    var status = el('span', 'status');
    row.appendChild(status);
    body.appendChild(row);

    var barWrap = el('div', 'bar-wrap');
    barWrap.style.display = 'none';
    var bar = el('div', 'bar');
    barWrap.appendChild(bar);
    body.appendChild(barWrap);

    var out = el('div', 'out');
    body.appendChild(out);

    var collected = [];
    var usedSources = [];
    var legal = null;
    var queuedNote = null;

    run.onclick = function () {
      var plan = input.value.trim();
      if (!plan) { status.textContent = 'Нужен план'; return; }

      collected = [];
      usedSources = [];
      legal = null;
      queuedNote = null;
      out.textContent = '';
      dl.style.display = 'none';
      run.disabled = true;
      barWrap.style.display = '';
      bar.style.width = '0%';
      status.textContent = 'Разбираю план…';

      var started = Date.now();

      window.StudCore.stream('/api/assemble', {
        plan: plan,
        settings: window.StudCore.getSettings(),
        // Ключ устройства обязателен: по нему сервер сохраняет работу
        // по частям. Раньше здесь стоял StudWorks, которого в этом
        // интерфейсе нет, — и трёхминутная сборка никуда не писалась.
        ownerKey: window.StudCore.ownerKey(),
      }, function (ev) {
        if (ev.outline) {
          out.appendChild(el('div', 'ok-line',
            'Структура: частей — ' + (ev.total || ev.outline.length)));
          (ev.warnings || []).forEach(function (w) { warn(out, w); });
        }

        if (ev.sources) {
          // Держим список: по нему маркеры [3] станут сносками в .docx.
          usedSources = ev.sources;
          out.appendChild(el('div', 'hint',
            'Опора: публикаций — ' + ev.sources.length));
        }

        if (ev.notice) warn(out, ev.notice);

        // Ожидание очереди: человек должен понимать, что сервис не
        // завис, а ждёт своей очереди, и видеть, сколько ещё впереди.
        if (ev.queued) {
          status.textContent = 'В очереди: место ' + ev.queued.place;
          if (!queuedNote) {
            queuedNote = el('div', 'warn-line', ev.queued.message);
            out.appendChild(queuedNote);
          } else {
            queuedNote.textContent = ev.queued.message;
          }
        }

        if (ev.progress) {
          var p = ev.progress;
          var pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
          bar.style.width = pct + '%';
          var secs = Math.round((Date.now() - started) / 1000);
          status.textContent = 'Часть ' + p.done + ' из ' + p.total
                             + ' — ' + secs + ' с';
        }

        if (ev.expanding) {
          status.textContent = 'Дописываю: ' + (ev.expanding.heading || '');
        }

        if (ev.legal) legal = ev.legal;

        if (ev.piece) {
          collected.push(ev.piece);
          var done = el('div', 'piece');
          done.appendChild(el('div', 'ftitle', '✓ ' + ev.piece.heading));
          done.appendChild(el('div', 'hint',
            ev.piece.chars + ' знаков без пробелов'));
          out.appendChild(done);
          out.scrollTop = out.scrollHeight;
        }

        if (ev.failed) {
          var f = el('div', 'piece bad');
          f.appendChild(el('div', 'ftitle', '✕ ' + ev.failed.heading));
          f.appendChild(el('div', 'hint', ev.failed.reason
            + ' — этот кусок можно дописать отдельно'));
          out.appendChild(f);
        }

        if (ev.finished) {
          bar.style.width = '100%';
          out.appendChild(el('div', 'ok-line',
            'Готово: частей — ' + ev.finished.written + ', знаков — '
          + (ev.finished.chars || 0)));
          if (ev.finished.failed) {
            warn(out, 'Не получилось частей: ' + ev.finished.failed);
          }
          if (ev.finished.legal) legal = ev.finished.legal;
        }
      }, function (err) {
        run.disabled = false;
        if (err) {
          status.textContent = '';
          warn(out, 'Сборка прервалась: ' + err);
          // Написанное до обрыва не выбрасываем: эти части готовы.
          if (collected.length) dl.style.display = '';
          return;
        }
        status.textContent = 'Готово за '
          + Math.round((Date.now() - started) / 1000) + ' с';
        if (legal) out.appendChild(el('div', 'hint', legal));
        if (collected.length) dl.style.display = '';
      });
    };

    dl.onclick = function () {
      if (!collected.length) return;
      status.textContent = 'Собираю файл…';
      window.StudCore.exportFullDocx(collected, { sources: usedSources })
        .then(function () { status.textContent = 'Файл скачан'; })
        .catch(function (e) {
          status.textContent = 'Ошибка экспорта: ' + e.message;
        });
    };

    input.focus();
  }

  window.ModernSheets = {
    openSettings: openSettings,
    openTool: openTool,
    openAssemble: openAssemble,
    openWriting: openWriting,
  };
})();
