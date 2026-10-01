/**
 * Работа по разделам: план превращается в список, каждый пункт
 * пишется, читается и правится отдельно.
 *
 * До этого экрана выбор был такой: нажать «Собрать черновик» и три
 * минуты ждать работу целиком, не вмешиваясь. Получался текст, за
 * который студент не отвечает: он его не видел, пока тот писался, и
 * не мог поправить направление. Здесь наоборот — пишем по одному
 * пункту, каждый можно прочитать, переписать заново или отредактировать
 * руками, и только потом браться за следующий.
 *
 * Промпты для этого были готовы давно (section_plan, section_write,
 * section_polish) — ими пользовалась сборка внутри себя, наружу они не
 * выходили.
 *
 * Экспортируется как window.ModernWorkbench.
 */
(function () {
  'use strict';

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function chars(text) {
    return String(text || '').replace(/\s/g, '').length;
  }

  function open() {
    var shell = window.ModernUI.openShell('Работа по разделам');
    var body = shell.body;

    body.appendChild(el('div', 'hint',
      'Вставьте план — он превратится в список. Дальше пишите по одному '
    + 'пункту: каждый можно прочитать, переписать или поправить руками. '
    + 'Написанное сохраняется сразу.'));

    var planInput = el('textarea');
    planInput.rows = 6;
    planInput.placeholder = 'Вставьте план работы (пункт 2)';
    body.appendChild(planInput);

    var row = el('div', 'row');
    var parse = el('button', 'btn', 'Разобрать план');
    row.appendChild(parse);
    var dl = el('button', 'btn ghost', 'Скачать .docx');
    dl.style.display = 'none';
    row.appendChild(dl);
    var status = el('span', 'status');
    row.appendChild(status);
    body.appendChild(row);

    var listBox = el('div');
    body.appendChild(listBox);

    // Состояние экрана: план, разобранные части и написанные тексты.
    var plan = '';
    var queue = [];
    var written = {};     // индекс -> {heading, text, chars, kind, number}
    var workId = null;
    var sources = [];

    parse.onclick = function () {
      var value = planInput.value.trim();
      if (value.length < 100) {
        status.textContent = 'План слишком короткий';
        return;
      }
      parse.disabled = true;
      status.textContent = 'Разбираю…';

      fetch('/api/outline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: value }),
      })
        .then(function (r) {
          return r.json().then(function (d) {
            if (!r.ok) throw new Error(d.error || ('сервер ответил ' + r.status));
            return d;
          });
        })
        .then(function (d) {
          plan = value;
          queue = d.queue || [];
          status.textContent = 'Частей: ' + queue.length;
          (d.warnings || []).forEach(function (w) {
            listBox.appendChild(el('div', 'warn-line', w));
          });
          // Тема из плана пригодится документу и поиску публикаций.
          var s = window.StudCore.getSettings();
          if (!s.topic && d.topic) window.StudCore.saveSettings({ topic: d.topic });
          drawList();
        })
        .catch(function (e) { status.textContent = e.message; })
        .then(function () { parse.disabled = false; });
    };

    function drawList() {
      listBox.textContent = '';
      queue.forEach(function (task, index) {
        listBox.appendChild(drawItem(task, index));
      });
      updateDownload();
    }

    function updateDownload() {
      var ready = Object.keys(written).length;
      dl.style.display = ready ? '' : 'none';
      if (ready) {
        var total = Object.keys(written).reduce(function (sum, k) {
          return sum + written[k].chars;
        }, 0);
        status.textContent = 'Готово частей: ' + ready + ' из ' + queue.length
                           + ', знаков: ' + total;
      }
    }

    function drawItem(task, index) {
      var card = el('div', 'piece');
      var head = el('div', 'ftitle', task.heading || task.title);
      card.appendChild(head);

      var meta = el('div', 'hint');
      card.appendChild(meta);

      var acts = el('div', 'row');
      var write = el('button', 'btn', 'Написать');
      acts.appendChild(write);
      var edit = el('button', 'btn ghost', 'Править');
      edit.style.display = 'none';
      acts.appendChild(edit);
      var st = el('span', 'status');
      acts.appendChild(st);
      card.appendChild(acts);

      var textBox = el('div', 'out');
      textBox.style.display = 'none';
      card.appendChild(textBox);

      var editor = el('textarea');
      editor.rows = 12;
      editor.style.display = 'none';
      card.appendChild(editor);

      function showText(text) {
        textBox.textContent = text;
        textBox.style.display = '';
        editor.style.display = 'none';
        meta.textContent = chars(text) + ' знаков без пробелов';
        write.textContent = 'Переписать';
        edit.style.display = '';
        updateDownload();
      }

      write.onclick = function () {
        write.disabled = true;
        edit.disabled = true;
        var from = Date.now();
        var timer = setInterval(function () {
          st.textContent = 'Пишу — ' + Math.round((Date.now() - from) / 1000) + ' с';
        }, 1000);
        st.textContent = 'Пишу…';

        // Контекст: уже написанные части, чтобы модель не повторяла
        // мысли из соседних разделов.
        var context = Object.keys(written)
          .sort(function (a, b) { return Number(a) - Number(b); })
          .map(function (k) {
            return { heading: written[k].heading, text: written[k].text };
          });

        var payload = {
          plan: plan,
          settings: window.StudCore.getSettings(),
          task: Object.assign({}, task, { position: index }),
          written: context,
          ownerKey: window.StudCore.ownerKey(),
        };
        if (workId) payload.workId = workId;

        window.StudCore.stream('/api/section', payload, function (ev) {
          if (ev.sources) sources = ev.sources;
          if (ev.expanding) st.textContent = 'Дописываю до нужного объёма…';
          if (ev.legal && (ev.legal.wrong || []).length) {
            card.appendChild(el('div', 'warn-line',
              'Проверьте ссылки на закон: ' + ev.legal.wrong.join('; ')));
          }
          if (ev.error) st.textContent = ev.error;
          if (ev.workId) workId = ev.workId;
          if (ev.piece) {
            written[index] = {
              heading: ev.piece.heading,
              text: ev.piece.text,
              chars: ev.piece.chars,
              kind: ev.piece.kind,
              number: ev.piece.number,
            };
            showText(ev.piece.text);
          }
        }, function (err) {
          clearInterval(timer);
          write.disabled = false;
          edit.disabled = false;
          st.textContent = err ? ('Ошибка: ' + err) : 'Готово';
        });
      };

      edit.onclick = function () {
        if (editor.style.display === 'none') {
          editor.value = written[index] ? written[index].text : '';
          editor.style.display = '';
          textBox.style.display = 'none';
          edit.textContent = 'Сохранить правку';
        } else {
          var text = editor.value;
          written[index].text = text;
          written[index].chars = chars(text);
          edit.textContent = 'Править';
          showText(text);
          // Правку возвращаем на сервер той же позицией: в документ и
          // в «Мои работы» должен попасть отредактированный вариант.
          if (workId) {
            st.textContent = 'Сохраняю…';
            fetch('/api/v1/works/' + workId + '/pieces', {
              method: 'POST',
              headers: window.StudCore.ownerHeaders({
                'Content-Type': 'application/json',
              }),
              body: JSON.stringify({
                kind: written[index].kind || 'section',
                number: written[index].number || null,
                heading: written[index].heading,
                text: text,
                position: index,
              }),
            })
              .then(function (r) {
                st.textContent = r.ok ? 'Правка сохранена' : 'Не сохранилось';
              })
              .catch(function () { st.textContent = 'Не сохранилось'; });
          }
        }
      };

      return card;
    }

    dl.onclick = function () {
      var pieces = Object.keys(written)
        .sort(function (a, b) { return Number(a) - Number(b); })
        .map(function (k) { return written[k]; });
      if (!pieces.length) return;
      status.textContent = 'Собираю файл…';
      window.StudCore.exportFullDocx(pieces, { sources: sources })
        .then(function () { status.textContent = 'Файл скачан'; })
        .catch(function (e) { status.textContent = 'Ошибка: ' + e.message; });
    };

    planInput.focus();
  }

  window.ModernWorkbench = { open: open };
})();
