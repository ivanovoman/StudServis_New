/**
 * Логика экрана «Курсовая по разделам» без DOM.
 *
 * Вынесена отдельно, чтобы проверять её в Node: какие кнопки получатся
 * из плана, какие нормы объёма у каждого раздела, что попадёт в список
 * литературы и как выглядит титул. В браузере доступна как
 * window.SectionsLogic, в Node — через require.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SectionsLogic = api;
})(this, function () {
  'use strict';

  /** Знаков без пробелов — так считают объём методички. */
  function chars(text) {
    return String(text || '').replace(/\s/g, '').length;
  }

  /**
   * Нормы объёма, знаков без пробелов.
   *
   * Введение 3800–5000 и раздел 5000–6000 — требования заказчика.
   * Заключение короче: сервер дописывает его до 2000, цель — около 3000.
   * Глава без параграфов пишется одним куском, как раздел.
   */
  var TARGETS = {
    introduction: { min: 3800, max: 5000 },
    section: { min: 5000, max: 6000 },
    conclusion: { min: 2000, max: 3500 },
  };

  function targetFor(kind) {
    return TARGETS[kind] || TARGETS.section;
  }

  /** Оценка объёма: 'short' | 'ok' | 'long'. */
  function volumeState(kind, n) {
    var t = targetFor(kind);
    if (n < t.min) return 'short';
    if (n > t.max) return 'long';
    return 'ok';
  }

  /**
   * Кнопки разделов из очереди /api/outline.
   *
   * Порядок как в готовой работе: титул, содержание, введение, главы с
   * параграфами, заключение, список литературы. Глава — отдельная
   * кнопка: с неё видно, какие параграфы написаны, и можно написать все
   * оставшиеся подряд. Глава без параграфов пишется целиком — тогда её
   * кнопка сама открывает редактор текста.
   *
   * position — место части в плане. Под ним часть хранится на сервере,
   * поэтому повторное написание заменяет прежний вариант, а не дублирует.
   */
  function buildNav(queue) {
    var items = [
      { id: 'title', kind: 'title', label: 'Титульный лист', level: 1 },
      { id: 'toc', kind: 'toc', label: 'Содержание', level: 1 },
    ];
    var chapters = {};

    (queue || []).forEach(function (task, position) {
      if (!task) return;
      if (task.kind === 'introduction') {
        items.push({ id: 'intro', kind: 'introduction', label: 'Введение',
                     level: 1, task: task, position: position, writable: true });
        return;
      }
      if (task.kind === 'conclusion') {
        items.push({ id: 'concl', kind: 'conclusion', label: 'Заключение',
                     level: 1, task: task, position: position, writable: true });
        return;
      }
      var num = String(task.number || '');
      var chapterNum = String(task.chapter || num.split('.')[0] || '');

      if (num.indexOf('.') < 0) {
        // Глава без параграфов: кнопка главы и есть раздел для письма.
        var whole = {
          id: 'ch' + chapterNum, kind: 'chapter', level: 1, chapter: chapterNum,
          label: 'Глава ' + chapterNum + (task.title ? '. ' + task.title : ''),
          title: task.title || '', task: task, position: position,
          writable: true, children: [],
        };
        chapters[chapterNum] = whole;
        items.push(whole);
        return;
      }

      var ch = chapters[chapterNum];
      if (!ch) {
        ch = {
          id: 'ch' + chapterNum, kind: 'chapter', level: 1, chapter: chapterNum,
          label: 'Глава ' + chapterNum + (task.chapterTitle ? '. ' + task.chapterTitle : ''),
          title: task.chapterTitle || '', writable: false, children: [],
        };
        chapters[chapterNum] = ch;
        items.push(ch);
      }
      var item = {
        id: 's' + num, kind: 'section', level: 2, chapter: chapterNum,
        label: num + '. ' + (task.title || ''), task: task, position: position,
        writable: true,
      };
      ch.children.push(item.id);
      items.push(item);
    });

    items.push({ id: 'refs', kind: 'bibliography', label: 'Список литературы', level: 1 });
    return items;
  }

  /** Вид части для норм объёма: глава целиком считается разделом. */
  function pieceKind(item) {
    if (!item) return 'section';
    if (item.kind === 'introduction' || item.kind === 'conclusion') return item.kind;
    return 'section';
  }

  /**
   * Номера публикаций, на которые ссылается текст.
   *
   * Тот же шаблон, что у сервера при сборке .docx: «[3]» и «[3, с. 15]».
   * Разойдись они — экран показывал бы один список, а в файл уходил
   * другой.
   */
  function usedRefs(texts) {
    var used = {};
    var re = /\[(\d+)(?:,\s*с\.\s*\d+)?\]/g;
    (texts || []).forEach(function (t) {
      var m;
      re.lastIndex = 0;
      while ((m = re.exec(String(t || '')))) used[Number(m[1])] = true;
    });
    return Object.keys(used).map(Number).sort(function (a, b) { return a - b; });
  }

  /**
   * Список литературы так, как его соберёт сервер.
   *
   * В список идут только публикации, на которые есть ссылка в тексте;
   * если ссылок нет вовсе — весь найденный список. Порядок — по
   * алфавиту, русские записи перед латинскими, без дублей.
   *
   * @returns {{entries: string[], unused: Array<{n:number, title:string}>}}
   */
  function bibliographyFrom(sources, texts) {
    var list = Array.isArray(sources) ? sources : [];
    var used = usedRefs(texts);
    var isUsed = {};
    used.forEach(function (n) { isUsed[n] = true; });

    var entries = [];
    var unused = [];
    list.forEach(function (s, i) {
      if (!s) return;
      var n = i + 1;
      if (used.length && !isUsed[n]) {
        unused.push({ n: n, title: s.title || '' });
        return;
      }
      if (s.gost) entries.push(String(s.gost).trim());
    });

    var seen = {};
    entries = entries.filter(function (e) {
      if (!e || seen[e]) return false;
      seen[e] = true;
      return true;
    }).sort(function (a, b) {
      var ca = /^[а-яё]/i.test(a) ? 0 : 1;
      var cb = /^[а-яё]/i.test(b) ? 0 : 1;
      return ca - cb || a.localeCompare(b, 'ru');
    });

    // Ссылки на номера, которых в списке нет, — верный признак
    // выдуманной сноски.
    var missing = used.filter(function (n) { return n > list.length; });

    return { entries: entries, unused: unused, missing: missing };
  }

  /**
   * Строки титула для предпросмотра — в том же порядке и с тем же
   * выравниванием, что docxExport.buildTitlePage. Пустая строка —
   * отбивка.
   */
  function titleLines(info) {
    info = info || {};
    var L = [];
    function line(text, opts) {
      opts = opts || {};
      L.push({ text: text, align: opts.align || 'center', bold: !!opts.bold,
               caps: !!opts.caps, big: !!opts.big });
    }
    function gap(n) { for (var i = 0; i < n; i++) line(''); }

    if (info.university) line(info.university, { bold: true, caps: true });
    if (info.department) line(info.department);
    if (info.faculty) line(info.faculty);
    if (info.direction) line('Направление / специальность: ' + info.direction);
    if (info.profile) line('Профиль / специализация: ' + info.profile);
    gap(3);
    line(info.workType || 'КУРСОВАЯ РАБОТА', { bold: true, caps: true, big: true });
    line('на тему:');
    if (info.topic) line('«' + String(info.topic).replace(/\.$/, '') + '»', { bold: true });
    if (info.discipline) line('по дисциплине: ' + info.discipline);
    gap(3);
    line('Выполнил(а): ' + (info.student || '____________________'), { align: 'right' });
    if (info.group) line('Группа: ' + info.group, { align: 'right' });
    line('Руководитель: ' + (info.supervisor || '____________________'), { align: 'right' });
    gap(3);
    line((info.city || 'Москва') + ' – ' + (info.year || new Date().getFullYear()));
    return L;
  }

  /**
   * Строки страницы «Содержание»: все разделы плана, а не только
   * написанные, — с отметкой, что уже готово.
   */
  function contentsLines(nav, pieces) {
    pieces = pieces || {};
    var out = [];
    (nav || []).forEach(function (item) {
      if (item.kind === 'title' || item.kind === 'toc') return;
      var text = item.kind === 'chapter'
        ? ('ГЛАВА ' + item.chapter + (item.title ? '. ' + item.title : ''))
        : (item.level === 1 ? item.label.toUpperCase() : item.label);
      var written = item.writable ? !!pieces[item.position] : null;
      out.push({ id: item.id, text: text, level: item.level, written: written });
    });
    return out;
  }

  return {
    chars: chars,
    targetFor: targetFor,
    volumeState: volumeState,
    buildNav: buildNav,
    pieceKind: pieceKind,
    usedRefs: usedRefs,
    bibliographyFrom: bibliographyFrom,
    titleLines: titleLines,
    contentsLines: contentsLines,
  };
});
