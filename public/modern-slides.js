/**
 * Презентация к защите.
 *
 * Слайды почти всегда правят руками: формулировки на экране — дело
 * вкуса кафедры, а титульный лист содержит реквизиты, которые модель
 * знать не может. Поэтому окно устроено в два хода: сначала модель
 * предлагает структуру, потом человек её правит и только затем
 * забирает .pptx. Перегенерировать всю презентацию ради одной строки
 * не нужно — правка идёт в браузере, файл собирается из того, что
 * пользователь утвердил.
 */
(function () {
  'use strict';

  var Core = window.StudCore;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function open() {
    var shell = window.ModernUI.openShell('Презентация к защите');
    var body = shell.body;

    body.appendChild(el('p', 'hint',
      'Вставьте текст готовой работы — модель предложит слайды. '
      + 'Их можно будет поправить перед выгрузкой в PowerPoint.'));

    var input = el('textarea');
    input.rows = 8;
    input.placeholder = 'Вставьте текст готовой работы';
    body.appendChild(input);

    var settings = Core.getSettings();

    // Реквизиты титульного листа. Модель их выдумывает — проверено на
    // живых прогонах, где появлялся несуществующий научный
    // руководитель. Спрашиваем у человека.
    var titleBox = el('div', 'frow');
    var fields = {};
    [['author', 'Ваши фамилия и инициалы'],
     ['supervisor', 'Научный руководитель'],
     ['university', 'Вуз']].forEach(function (pair) {
      var wrap = el('div', 'field');
      wrap.appendChild(el('label', null, pair[1]));
      var inp = el('input');
      inp.type = 'text';
      inp.placeholder = pair[1];
      if (pair[0] === 'university') inp.value = settings.university || '';
      fields[pair[0]] = inp;
      wrap.appendChild(inp);
      titleBox.appendChild(wrap);
    });
    body.appendChild(titleBox);

    var row = el('div', 'row');
    var go = el('button', 'btn', 'Сделать слайды');
    row.appendChild(go);
    var dl = el('button', 'btn ghost', 'Скачать .pptx');
    dl.style.display = 'none';
    row.appendChild(dl);
    body.appendChild(row);

    var status = el('div', 'status');
    body.appendChild(status);

    var out = el('div', 'out');
    body.appendChild(out);

    var slides = [];

    /** Перерисовывает список слайдов с полями правки. */
    function render() {
      out.innerHTML = '';
      if (!slides.length) return;

      slides.forEach(function (slide, index) {
        var block = el('div', 'piece');

        var head = el('div', 'ftitle', 'Слайд ' + (index + 1));
        block.appendChild(head);

        var title = el('input');
        title.type = 'text';
        title.value = slide.title || '';
        title.placeholder = 'Заголовок слайда';
        title.oninput = function () { slide.title = title.value; };
        block.appendChild(title);

        // Пункты правятся одним полем, по строке на пункт: отдельные
        // поля на каждый пункт превращают правку в возню с кнопками
        // «добавить» и «удалить».
        var bullets = el('textarea');
        bullets.rows = Math.max(3, (slide.bullets || []).length + 1);
        bullets.value = (slide.bullets || []).map(function (b, i) {
          var lvl = (slide.levels || [])[i] === 1 ? '    ' : '';
          return lvl + b;
        }).join('\n');
        bullets.placeholder = 'По пункту на строку. Отступ в четыре '
          + 'пробела делает пункт вложенным.';
        bullets.oninput = function () {
          var lines = bullets.value.split('\n')
            .filter(function (s) { return s.trim(); });
          slide.bullets = lines.map(function (s) { return s.trim(); });
          slide.levels = lines.map(function (s) {
            return /^(\s{2,}|\t)/.test(s) ? 1 : 0;
          });
        };
        block.appendChild(bullets);

        if (slide.table && slide.table.length) {
          var t = el('div', 'hint',
            'Таблица ' + slide.table.length + '×' + slide.table[0].length
            + ': ' + slide.table[0].join(' | '));
          block.appendChild(t);
        }

        if (slide.note) {
          var note = el('div', 'hint', 'Заметка докладчику: ' + slide.note);
          block.appendChild(note);
        }

        out.appendChild(block);
      });
    }

    go.onclick = function () {
      var text = input.value.trim();
      if (text.length < 500) {
        status.textContent = 'Нужен текст работы — хотя бы введение и '
          + 'один раздел.';
        return;
      }

      go.disabled = true;
      dl.style.display = 'none';
      slides = [];
      out.innerHTML = '';
      status.textContent = 'Готовлю слайды…';

      var started = Date.now();
      var timer = setInterval(function () {
        if (status.textContent.indexOf('очеред') !== -1) return;
        var sec = Math.round((Date.now() - started) / 1000);
        status.textContent = 'Готовлю слайды… ' + sec + ' с';
      }, 1000);

      Core.stream('/api/slides', {
        work: text,
        settings: settings,
      }, function (ev) {
        if (ev.queued) status.textContent = ev.queued.message;

        if (ev.error) {
          clearInterval(timer);
          go.disabled = false;
          status.textContent = '';
          out.appendChild(el('div', 'warn-line', ev.error));
        }

        if (ev.slides) {
          clearInterval(timer);
          go.disabled = false;
          slides = ev.slides;
          var sec = Math.round((Date.now() - started) / 1000);
          status.textContent = 'Готово: ' + ev.count + ' слайдов за '
            + sec + ' с. Поправьте текст и скачивайте.';
          render();
          (ev.warnings || []).forEach(function (w) {
            out.appendChild(el('div', 'warn-line', w));
          });
          dl.style.display = '';
        }
      }, function (err) {
        // onDone зовётся и при удачном завершении — тогда err пуст.
        clearInterval(timer);
        go.disabled = false;
        if (!err) return;
        status.textContent = '';
        out.appendChild(el('div', 'warn-line', String(err)));
      });
    };

    dl.onclick = function () {
      if (!slides.length) return;
      dl.disabled = true;
      var prev = dl.textContent;
      dl.textContent = 'Собираю…';

      fetch('/api/export-pptx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slides: slides,
          topic: settings.topic || '',
          university: fields.university.value.trim(),
          author: fields.author.value.trim(),
          supervisor: fields.supervisor.value.trim(),
        }),
      }).then(function (r) {
        if (!r.ok) {
          return r.json().then(function (d) {
            throw new Error(d.error || ('ошибка ' + r.status));
          });
        }
        return r.blob();
      }).then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = (settings.topic || 'Презентация').slice(0, 60) + '.pptx';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        dl.disabled = false;
        dl.textContent = prev;
      }).catch(function (e) {
        dl.disabled = false;
        dl.textContent = prev;
        out.appendChild(el('div', 'warn-line',
          'Не удалось собрать файл: ' + e.message));
      });
    };
  }

  window.ModernSlides = { open: open };
}());
