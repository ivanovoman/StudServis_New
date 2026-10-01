/**
 * Мои материалы: методички, конспекты, практика.
 *
 * Всё, что студент сюда загрузит, подмешивается в задание модели при
 * написании разделов — не целиком, а теми фрагментами, которые
 * относятся к теме раздела. Смысл в том, что научный руководитель
 * узнаёт собственные формулировки и требования своей кафедры, а
 * модель про них ничего не знает.
 */
(function () {
  'use strict';

  var Core = window.StudCore;

  var KINDS = [
    ['методичка', 'Методичка кафедры'],
    ['конспект', 'Конспект лекций'],
    ['практика', 'Судебная практика'],
    ['статья', 'Статья или монография'],
    ['материал', 'Другое'],
  ];

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function human(chars) {
    if (chars >= 1000) return Math.round(chars / 1000) + ' тыс. знаков';
    return chars + ' знаков';
  }

  function open() {
    var shell = window.ModernUI.openShell('Мои материалы');
    var body = shell.body;

    body.appendChild(el('p', 'hint',
      'Загрузите методичку кафедры, конспект лекций или практику. '
      + 'Сервис найдёт в них нужные куски и будет опираться на них, '
      + 'когда пишет разделы. Форматы: PDF, DOCX, RTF, TXT.'));

    var row = el('div', 'row');
    var kind = document.createElement('select');
    KINDS.forEach(function (pair) {
      var opt = document.createElement('option');
      opt.value = pair[0];
      opt.textContent = pair[1];
      kind.appendChild(opt);
    });
    row.appendChild(kind);

    var file = el('input');
    file.type = 'file';
    file.accept = '.pdf,.docx,.rtf,.txt';
    row.appendChild(file);

    var upBtn = el('button', 'btn', 'Загрузить');
    row.appendChild(upBtn);
    body.appendChild(row);

    var status = el('div', 'status');
    body.appendChild(status);

    var list = el('div', 'out');
    body.appendChild(list);

    // Поиск по библиотеке нужен не ради самого поиска, а чтобы человек
    // увидел, что именно сервис найдёт по его теме, — и понял, стоит
    // ли докладывать материалы.
    var searchWrap = el('div');
    searchWrap.style.marginTop = '18px';
    searchWrap.appendChild(el('div', 'ftitle', 'Проверить, что найдётся'));
    var srow = el('div', 'row');
    var q = el('input');
    q.type = 'text';
    q.placeholder = 'Например: требования к объёму работы';
    srow.appendChild(q);
    var sBtn = el('button', 'btn ghost', 'Найти');
    srow.appendChild(sBtn);
    searchWrap.appendChild(srow);
    var sOut = el('div', 'out');
    searchWrap.appendChild(sOut);
    body.appendChild(searchWrap);

    function refresh() {
      fetch('/api/v1/library', { headers: Core.ownerHeaders() })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          list.innerHTML = '';
          if (!d.documents || !d.documents.length) {
            list.appendChild(el('div', 'hint', 'Пока ничего не загружено.'));
            return;
          }
          d.documents.forEach(function (doc) {
            var block = el('div', 'piece');
            block.appendChild(el('div', 'ftitle', doc.filename));
            block.appendChild(el('div', 'hint',
              doc.kind + ' · ' + human(doc.chars)
              + ' · фрагментов: ' + doc.chunks));

            var del = el('button', 'btn ghost', 'Убрать');
            del.onclick = function () {
              del.disabled = true;
              fetch('/api/v1/library/' + encodeURIComponent(doc.id), {
                method: 'DELETE',
                headers: Core.ownerHeaders(),
              }).then(function () { refresh(); })
                .catch(function () { del.disabled = false; });
            };
            block.appendChild(del);
            list.appendChild(block);
          });
        })
        .catch(function (e) {
          list.innerHTML = '';
          list.appendChild(el('div', 'warn-line',
            'Не удалось получить список: ' + e.message));
        });
    }

    upBtn.onclick = function () {
      var f = file.files && file.files[0];
      if (!f) {
        status.textContent = 'Выберите файл.';
        return;
      }
      upBtn.disabled = true;
      status.textContent = 'Загружаю «' + f.name + '»…';

      var form = new FormData();
      form.append('file', f);

      fetch('/api/v1/library/upload?kind=' + encodeURIComponent(kind.value), {
        method: 'POST',
        headers: Core.ownerHeaders(),
        body: form,
      }).then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d.detail || d.error || ('ошибка ' + r.status));
          return d;
        });
      }).then(function (d) {
        upBtn.disabled = false;
        file.value = '';
        status.textContent = 'Готово: «' + d.filename + '», '
          + d.chunks + ' фрагментов.';
        refresh();
      }).catch(function (e) {
        upBtn.disabled = false;
        status.textContent = '';
        list.insertBefore(el('div', 'warn-line', e.message), list.firstChild);
      });
    };

    sBtn.onclick = function () {
      var query = q.value.trim();
      if (query.length < 2) return;
      sBtn.disabled = true;
      sOut.innerHTML = '';

      fetch('/api/v1/library/search', {
        method: 'POST',
        headers: Core.ownerHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ query: query, limit: 3 }),
      }).then(function (r) { return r.json(); })
        .then(function (d) {
          sBtn.disabled = false;
          if (!d.hits || !d.hits.length) {
            sOut.appendChild(el('div', 'hint',
              'Ничего не нашлось. Возможно, нужного материала нет в '
              + 'библиотеке — или спросите другими словами.'));
            return;
          }
          d.hits.forEach(function (h) {
            var block = el('div', 'piece');
            block.appendChild(el('div', 'hint', h.source + ' · ' + h.kind));
            block.appendChild(el('div', null, h.snippet));
            sOut.appendChild(block);
          });
        })
        .catch(function (e) {
          sBtn.disabled = false;
          sOut.appendChild(el('div', 'warn-line', e.message));
        });
    };

    refresh();
  }

  window.ModernLibrary = { open: open };
}());
