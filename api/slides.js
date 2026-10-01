/**
 * Разбор презентации из ответа модели.
 *
 * Модель отдаёт слайды размеченным текстом (СЛАЙД / ЗАГОЛОВОК /
 * пункты / ТАБЛИЦА / ЗАМЕТКА). Просить JSON у бесплатных моделей
 * бессмысленно: они регулярно ломают кавычки на русском тексте и
 * обрывают длинный массив на середине, а испорченный JSON — это
 * потеря всей презентации целиком. Построчная разметка деградирует
 * мягко: один сбойный слайд не уносит остальные.
 *
 * Отсюда же терпимость разбора: модель путает дефис с тире, забывает
 * двоеточие после ЗАГОЛОВОК, иногда оборачивает заголовок в **. Всё
 * это чинится здесь, а не повторным обращением к модели.
 */
'use strict';

const MAX_TITLE = 90;
const MAX_BULLET = 160;

/** Снимает markdown-разметку, которую модель добавляет по привычке. */
function clean(line) {
  return String(line || '')
    .replace(/\*\*/g, '')
    // Одинарные звёздочки — курсив markdown. На слайде он не нужен, а
    // в тексте «(*lex*)» выглядел как опечатка. Снимаем только парные,
    // чтобы не тронуть звёздочку как символ.
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSlideStart(line) {
  return /^(СЛАЙД|SLIDE)\s*\d+/i.test(line);
}

/** «- пункт», «• пункт», «1. пункт», «– пункт» — всё это пункт. */
function asBullet(line) {
  const m = line.match(/^\s*(?:[-–—•*]|\d+[.)])\s+(.*)$/);
  return m ? clean(m[1]) : null;
}

function parseSlides(raw) {
  const text = String(raw || '').replace(/\r/g, '');
  const lines = text.split('\n');

  const slides = [];
  let current = null;
  const warnings = [];

  const push = () => {
    if (!current) return;
    // Слайд без единой строки содержания — мусор от сбившейся
    // разметки, а не слайд. Пустая страница на защите хуже, чем её
    // отсутствие.
    if (current.title || current.bullets.length || current.table.length) {
      slides.push(current);
    }
    current = null;
  };

  for (const rawLine of lines) {
    // Звёздочки снимаем сразу: модель оборачивает в них ключевые
    // слова, и «**ЗАГОЛОВОК:**» переставал узнаваться, уезжая в
    // пункты вместе с самим словом «ЗАГОЛОВОК».
    const line = clean(rawLine);
    if (!line) continue;

    if (isSlideStart(line)) {
      push();
      current = { title: '', bullets: [], table: [], note: '' };
      // «СЛАЙД 3: Актуальность» — заголовок в той же строке.
      const inline = line.replace(/^(СЛАЙД|SLIDE)\s*\d+\s*[:.-]?\s*/i, '');
      if (inline) current.title = clean(inline);
      continue;
    }

    if (!current) {
      // Текст до первого «СЛАЙД» — вступление модели вроде «Конечно,
      // вот презентация». Молча пропускаем.
      continue;
    }

    const titleMatch = line.match(/^(?:ЗАГОЛОВОК|TITLE)\s*[:.-]?\s*(.*)$/i);
    if (titleMatch) {
      current.title = clean(titleMatch[1]);
      continue;
    }

    const noteMatch = line.match(/^(?:ЗАМЕТКА|ЗАМЕТКИ|NOTE[S]?)\s*[:.-]?\s*(.*)$/i);
    if (noteMatch) {
      const value = clean(noteMatch[1]);
      current.note = current.note ? `${current.note} ${value}` : value;
      continue;
    }

    const tableMatch = line.match(/^(?:ТАБЛИЦА|TABLE)\s*[:.-]?\s*(.*)$/i);
    if (tableMatch) {
      const cells = tableMatch[1].split('|').map((c) => clean(c));
      if (cells.some((c) => c)) current.table.push(cells);
      continue;
    }

    const bullet = asBullet(line);
    if (bullet) {
      current.bullets.push(bullet);
      continue;
    }

    // Строка без маркера. Если заголовка ещё нет — это он; иначе
    // считаем пунктом: модель часто забывает дефис на первой строке.
    if (!current.title) current.title = clean(line);
    else current.bullets.push(clean(line));
  }
  push();

  // Выравниваем таблицы: строки разной длины python-pptx не примет, а
  // модель нередко забывает пустую клетку в последнем столбце.
  slides.forEach((slide, i) => {
    if (!slide.table.length) return;
    const width = Math.max(...slide.table.map((r) => r.length));
    if (width < 2) {
      // Таблица в один столбец — это список, а не таблица.
      slide.table.forEach((r) => { if (r[0]) slide.bullets.push(r[0]); });
      slide.table = [];
      return;
    }
    if (slide.table.length < 2) {
      // Одна шапка без данных: пустая таблица на слайде хуже пункта.
      warnings.push(`Слайд ${i + 1}: таблица без строк данных, убрана.`);
      slide.table.forEach((r) => { if (r[0]) slide.bullets.push(r.join(' — ')); });
      slide.table = [];
      return;
    }
    slide.table = slide.table.map((row) => {
      const copy = row.slice(0, width);
      while (copy.length < width) copy.push('');
      return copy;
    });
  });

  // Уровни вложенности.
  //
  // Модель охотно пишет «Задачи:» и ниже сами задачи, но маркирует их
  // всё теми же дефисами. На экране это читается как один плоский
  // список, где заголовок неотличим от содержания. Пункт, который
  // кончается двоеточием, делаем подзаголовком, а идущие за ним —
  // вложенными.
  slides.forEach((slide) => {
    let nested = false;
    slide.levels = slide.bullets.map((text) => {
      if (/:$/.test(text)) {
        nested = true;
        return 0;
      }
      return nested ? 1 : 0;
    });
  });

  // Предупреждения о длине: обрезать нельзя — потеряется смысл, но
  // человек должен знать, где текст не поместится в строку.
  slides.forEach((slide, i) => {
    if (slide.title.length > MAX_TITLE) {
      warnings.push(
        `Слайд ${i + 1}: заголовок ${slide.title.length} знаков — длинно `
        + 'для экрана, стоит сократить.');
    }
    const long = slide.bullets.filter((b) => b.length > MAX_BULLET).length;
    if (long) {
      warnings.push(
        `Слайд ${i + 1}: ${long} пункт(ов) длиннее ${MAX_BULLET} знаков — `
        + 'на слайде это абзац, а не тезис.');
    }
    if (slide.bullets.length > 7) {
      warnings.push(
        `Слайд ${i + 1}: ${slide.bullets.length} пунктов — больше шести `
        + 'на экране не читается.');
    }
  });

  if (slides.length && slides.length < 6) {
    warnings.push(
      `Слайдов всего ${slides.length}: для защиты обычно нужно 10-12. `
      + 'Возможно, модель оборвала ответ — стоит сгенерировать заново.');
  }

  return { slides, warnings, count: slides.length };
}

module.exports = { parseSlides };
