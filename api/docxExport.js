// api/docxExport.js
//
// Генерация .docx по ГОСТ-требованиям для курсовых работ:
// - H1 (СОДЕРЖАНИЕ, ВВЕДЕНИЕ, ГЛАВА N, ЗАКЛЮЧЕНИЕ, СПИСОК ЛИТЕРАТУРЫ) — капс,
//   обычный (не жирный) шрифт, по центру, разрыв страницы ПЕРЕД каждым
//   таким заголовком, интервалы before/after = 0.
// - H2 (разделы 1.1, 1.2 и т.д.) — обычный шрифт, без разрыва страницы,
//   интервалы before/after = 0.
// - Основной текст — Times New Roman 14pt, интервал 1.5, выравнивание по
//   ширине страницы (justify), интервалы before/after = 0.
// - Таблицы — без заливки, Times New Roman 11pt, шапка по центру, текст
//   по левому краю, границы 1.5pt (docx считает size границы в восьмых
//   долях пункта: 1.5pt = 12).
// - Поля страницы: верх 2см, низ 2см, слева 3см (переплёт), справа 1.5см.
// - Списки — не Word-нумерация, а обычный текст вида "1. ...", "2. ..." —
//   модель пишет их как часть текста, мы их не трогаем и не превращаем
//   в буллиты/автонумерацию.
//
// Все параметры визуально проверены через рендеринг в PDF перед использованием.

const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        AlignmentType, BorderStyle, WidthType, PageBreak,
        Footer, PageNumber } = require('docx');

// ---- Единицы измерения ----
// docx использует DXA (1/20 пункта) для отступов/полей и полупункты (half-points)
// для размера шрифта. 1 см = 567 DXA (округлённо, через 1440 DXA = 1 дюйм = 2.54 см).
const CM = 567; // 1 см в DXA

const FONT = 'Times New Roman';
const BODY_SIZE = 28;     // 14pt = 28 half-points
const TABLE_SIZE = 22;    // 11pt = 22 half-points
const H1_SIZE = 32;       // 16pt — крупнее основного текста, но без жирности
const H2_SIZE = 28;       // 14pt — как основной текст, просто отдельный абзац-заголовок

// Множество заголовков верхнего уровня (H1) — используется, чтобы решить,
// нужен ли КАПС и разрыв страницы при простом текстовом вызове addHeading.
const H1_TITLES = new Set([
  'СОДЕРЖАНИЕ', 'ВВЕДЕНИЕ', 'ЗАКЛЮЧЕНИЕ', 'СПИСОК ЛИТЕРАТУРЫ',
]);

// Нормализация тире и дефисов по требованиям оформления:
// 1. Длинное тире (—, EM DASH) заменяется на короткое (–, EN DASH) — используется
//    как разделительный знак в обычном тексте ("эффект — преодоление...").
// 2. Между двумя числами ставится обычный дефис (-, HYPHEN-MINUS), а не тире —
//    например "2025-2026 гг.", "ст. 61.11-61.12" — это диапазон, а не пауза в речи.
// Применяется ко всему тексту перед вставкой в документ (абзацы, таблицы, заголовки).
function fixDashes(text) {
  if (!text) return text;
  let result = String(text);

  // Сначала числовые диапазоны: цифра + (любое тире, с пробелами вокруг или без) + цифра
  // → цифра-дефис-цифра без пробелов. Обрабатываем это первым, чтобы общая замена
  // тире ниже не успела превратить диапазон в "–" раньше времени.
  result = result.replace(/(\d)\s*[—–-]\s*(\d)/g, '$1-$2');

  // Все остальные длинные тире (—) — на короткие (–)
  result = result.replace(/—/g, '–');

  return result;
}

// Разбивает текст на абзацы по пустым строкам между ними.
function splitParagraphs(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean);
}

// Защита от дублирования заголовка: если модель всё же написала заголовок
// раздела как первую строку текста (например, "Введение" перед текстом
// введения, или "1.1. Название" перед текстом раздела), убираем эту строку,
// т.к. заголовок уже добавляется отдельно при оформлении документа.
// Срабатывает только на короткой первой строке (заголовки короткие, основной
// текст — нет), чтобы случайно не отрезать начало настоящего текста.
function stripDuplicateHeading(text, heading) {
  const raw = String(text || '');
  if (!heading) return raw;

  const lines = raw.split('\n');
  const firstLine = (lines[0] || '').trim();
  // Порог длины подстраивается под сам заголовок (он теперь может включать
  // полное название раздела/главы, а не только номер) — с запасом в 20
  // символов на случай небольших расхождений в пунктуации у модели.
  const maxLen = Math.max(80, heading.length + 20);
  if (!firstLine || firstLine.length > maxLen) return raw; // длинная строка — это уже текст, не заголовок

  const normalize = s => s.toLowerCase().replace(/[«»"'.:#*]/g, '').replace(/\s+/g, ' ').trim();
  const normFirst = normalize(firstLine);
  const normHeading = normalize(heading);

  // Совпадение целиком, либо заголовок раздела содержится в первой строке
  // (например, заголовок "1.1" совпадает с первой строкой "1.1. Название раздела")
  const isDuplicate = normFirst === normHeading
    || (normHeading.length > 0 && normFirst.startsWith(normHeading))
    || normFirst === 'введение' || normFirst === 'заключение';

  if (isDuplicate) {
    return lines.slice(1).join('\n').trim();
  }
  return raw;
}

// Парсит markdown-таблицу (формат, который выдаёт модель) в массив строк.
// Возвращает null, если валидной таблицы нет.
//
// Надёжность важна здесь особо: модель иногда переносит длинный текст ячейки
// на следующую строку БЕЗ символа "|" в начале (это не новая строка таблицы,
// а продолжение предыдущей ячейки). Наивный парсер, отбрасывающий любую
// строку без "|", в таком случае молча теряет часть текста и может сдвинуть
// данные по столбцам — это незаметное искажение данных, а не просто
// визуальный баг, поэтому здесь применяется более аккуратная склейка.
function parseMarkdownTable(markdown) {
  if (!markdown) return null;

  const allLines = String(markdown).split('\n');
  // Оставляем только зону таблицы: непрерывный блок строк, где есть хотя бы
  // одна строка с "|" — ищем первую и последнюю такую строку.
  const tableLineIdx = allLines
    .map((l, i) => (l.trim().startsWith('|') ? i : -1))
    .filter(i => i !== -1);
  if (tableLineIdx.length < 2) return null;

  const firstIdx = tableLineIdx[0];
  const lastIdx = tableLineIdx[tableLineIdx.length - 1];
  const zone = allLines.slice(firstIdx, lastIdx + 1);

  // Склеиваем строки: если строка не начинается с "|", это продолжение
  // предыдущей строки таблицы (перенос текста внутри ячейки) — присоединяем
  // её к предыдущей через пробел, а не отбрасываем.
  const mergedLines = [];
  for (const line of zone) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|')) {
      mergedLines.push(trimmed);
    } else if (trimmed && mergedLines.length > 0) {
      mergedLines[mergedLines.length - 1] += ' ' + trimmed;
    }
    // пустые строки внутри зоны таблицы просто пропускаются
  }

  const cells = line => line.split('|').map(c => c.trim())
    .filter((c, i, a) => !(i === 0 && c === '') && !(i === a.length - 1 && c === ''));

  const allRows = mergedLines.map(cells).filter(r => r.length > 0);
  // Строка-разделитель markdown (|---|---|) состоит только из дефисов/двоеточий — убираем её
  const rows = allRows.filter(r => !r.every(c => /^:?-+:?$/.test(c)));
  if (rows.length < 2) return null;

  // Нормализуем количество столбцов по заголовку: если в какой-то строке
  // больше ячеек (например, из-за случайного "|" внутри текста ячейки),
  // склеиваем лишние хвостовые ячейки в последнюю, а не молча обрезаем —
  // так не теряются данные, даже если разметка не идеальна.
  const colCount = rows[0].length;
  const normalized = rows.map(r => {
    if (r.length <= colCount) return r;
    const head = r.slice(0, colCount - 1);
    const tail = r.slice(colCount - 1).join(' | ');
    return [...head, tail];
  });

  return normalized;
}

// ---- Построение текстовых блоков ----

// Заголовок уровня H1: КАПС, обычный (не жирный) шрифт, по центру,
// разрыв страницы перед ним, интервалы before/after = 0.
// Возвращает МАССИВ блоков: сам заголовок + 2 пустых абзаца после него
// (видимый отступ перед текстом, без использования spacing на самом
// заголовке — это сделано через явные пустые строки, а не через spacing,
// чтобы интервалы before/after у заголовка и текста оставались равны 0).
function makeH1(text, { pageBreakBefore = true } = {}) {
  const breakChildren = [];
  if (pageBreakBefore) {
    breakChildren.push(new PageBreak());
  }
  const heading = new Paragraph({
    children: [
      ...breakChildren,
      new TextRun({ text: fixDashes(String(text)).toUpperCase(), bold: false, size: H1_SIZE, font: FONT }),
    ],
    spacing: { before: 0, after: 0, line: 360 },
    alignment: AlignmentType.CENTER,
  });
  return [heading, makeEmptyParagraph(), makeEmptyParagraph()];
}

// Заголовок уровня H2 (раздел вида 1.1, 1.2): обычный шрифт, без разрыва страницы,
// интервалы before/after = 0.
function makeH2(text) {
  return new Paragraph({
    children: [new TextRun({ text: fixDashes(String(text)), bold: false, size: H2_SIZE, font: FONT })],
    spacing: { before: 0, after: 0, line: 360 },
  });
}

// Пустой абзац — используется как явный визуальный отступ (вместо spacing),
// чтобы интервалы before/after у самих заголовков и текста оставались равны 0.
function makeEmptyParagraph() {
  return new Paragraph({
    children: [new TextRun({ text: '', size: BODY_SIZE, font: FONT })],
    spacing: { before: 0, after: 0, line: 360 },
  });
}

// Обычный абзац основного текста: Times New Roman 14pt, интервал 1.5,
// отступ первой строки, выравнивание по ширине страницы, интервалы before/after = 0.
function makeBodyParagraph(text) {
  return new Paragraph({
    children: [new TextRun({ text: fixDashes(text), size: BODY_SIZE, font: FONT })],
    spacing: { before: 0, after: 0, line: 360 }, // line: 360 = 1.5 интервала (240 = одинарный)
    indent: { firstLine: 720 },
    alignment: AlignmentType.JUSTIFIED,
  });
}

function makeBodyParagraphs(text) {
  return splitParagraphs(text).map(makeBodyParagraph);
}

// Таблица без заливки, 11pt, шапка по центру, тело по левому краю,
// все границы 1.5pt (docx считает size границы в восьмых долях пункта: 1.5 * 8 = 12).
function makeTable(tableRows) {
  if (!tableRows) return null;

  const border = { style: BorderStyle.SINGLE, size: 12, color: "000000" };
  const borders = { top: border, bottom: border, left: border, right: border };
  const colCount = tableRows[0].length;
  const colWidth = Math.floor(9360 / colCount);
  const widths = new Array(colCount).fill(colWidth);

  const makeCell = (text, isHeader) => new TableCell({
    borders,
    width: { size: colWidth, type: WidthType.DXA },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [new Paragraph({
      alignment: isHeader ? AlignmentType.CENTER : AlignmentType.LEFT,
      children: [new TextRun({ text: fixDashes(text) || '', bold: false, size: TABLE_SIZE, font: FONT })],
    })],
  });

  const rows = tableRows.map((row, i) => new TableRow({
    children: row.map(c => makeCell(c, i === 0)),
  }));

  return new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: widths, rows });
}

// Заголовок таблицы: "Таблица № N. Название" — обычный (не жирный) шрифт,
// идёт отдельным абзацем перед самой таблицей.
function makeTableCaption(number, title) {
  return new Paragraph({
    children: [new TextRun({
      text: fixDashes(`Таблица № ${number}. ${title}`),
      bold: false,
      size: BODY_SIZE,
      font: FONT,
    })],
    spacing: { before: 0, after: 0, line: 360 },
  });
}

// Собирает H2-заголовок + абзацы + опциональную таблицу (с подписью) для
// одного раздела. tableData — { number, title, markdown } или null/undefined,
// если у раздела нет таблицы. Для обратной совместимости также принимает
// markdown-строку напрямую (старый формат) — тогда заголовок таблицы не
// добавляется, только сама таблица.
function buildSectionBlocks(heading, text, tableData) {
  const blocks = [];
  if (heading) blocks.push(makeH2(heading));
  blocks.push(...makeBodyParagraphs(stripDuplicateHeading(text, heading)));

  if (tableData) {
    const isLegacyStringFormat = typeof tableData === 'string';
    const markdown = isLegacyStringFormat ? tableData : tableData.markdown;
    const table = makeTable(parseMarkdownTable(markdown));
    if (table) {
      if (!isLegacyStringFormat && tableData.number && tableData.title) {
        blocks.push(makeTableCaption(tableData.number, tableData.title));
      }
      blocks.push(table);
    }
  }

  return blocks;
}

// Строка страницы СОДЕРЖАНИЕ: пункт оглавления без номера страницы
// (номера проставляются в Word после финальной вёрстки). Разделы (1.1, 1.2)
// выводятся с отступом относительно глав.
function makeContentsLine(text, { indented = false } = {}) {
  return new Paragraph({
    children: [new TextRun({ text: fixDashes(String(text)), bold: false, size: BODY_SIZE, font: FONT })],
    spacing: { before: 0, after: 0, line: 360 },
    indent: indented ? { left: 720 } : undefined,
  });
}

// Собирает страницу СОДЕРЖАНИЕ по структуре работы: ВВЕДЕНИЕ, главы с
// разделами, ЗАКЛЮЧЕНИЕ.
function buildContentsPage(sections, chapterTitles, sectionTitles, withBibliography, contentsTitle, bibliographyTitle) {
  const blocks = [];
  blocks.push(...makeH1(contentsTitle || 'СОДЕРЖАНИЕ', { pageBreakBefore: false }));
  blocks.push(makeContentsLine('ВВЕДЕНИЕ'));

  let lastChapterNum = null;
  for (const s of (sections || [])) {
    const chapterNum = String(s.number || '').split('.')[0];
    if (chapterNum && chapterNum !== lastChapterNum) {
      const chapterName = chapterTitles && chapterTitles[chapterNum];
      blocks.push(makeContentsLine(chapterName ? `ГЛАВА ${chapterNum}. ${chapterName}` : `ГЛАВА ${chapterNum}`));
      lastChapterNum = chapterNum;
    }
    const sectionNum = s.number ? String(s.number) : null;
    if (sectionNum) {
      const sectionName = sectionTitles && sectionTitles[sectionNum];
      blocks.push(makeContentsLine(sectionName ? `${sectionNum}. ${sectionName}` : sectionNum, { indented: true }));
    }
  }

  blocks.push(makeContentsLine('ЗАКЛЮЧЕНИЕ'));
  if (withBibliography) blocks.push(makeContentsLine(bibliographyTitle || 'СПИСОК ЛИТЕРАТУРЫ'));
  return blocks;
}

/**
 * Строка титульного листа.
 *
 * Титул верстается одиночными строками с одинарным интервалом, а
 * положение блоков задаётся пустыми строками — так же, как это делают
 * в Word руками.
 */
function titleLine(text, opts = {}) {
  const { align = AlignmentType.CENTER, bold = false, size = BODY_SIZE, caps = false } = opts;
  return new Paragraph({
    children: [new TextRun({
      text: fixDashes(caps ? String(text || '').toUpperCase() : String(text || '')),
      size, font: FONT, bold,
    })],
    spacing: { before: 0, after: 0, line: 240 },
    indent: { firstLine: 0 },
    alignment: align,
  });
}

/**
 * Титульный лист.
 *
 * Сделан по образцу из методички МФЮА (приложение 2), но все поля
 * настраиваемые: у каждого вуза свой титул, и зашить один жёстко —
 * значит сделать сервис пригодным ровно для одного вуза.
 *
 * Незаполненные поля оставляют подчёркнутое место, а не выдуманные
 * данные: имя научного руководителя придумывать нельзя, а вписать его
 * ручкой — обычное дело.
 */
function buildTitlePage(info) {
  if (!info) return [];
  const R = AlignmentType.RIGHT;
  const blocks = [];
  const empty = () => blocks.push(titleLine(''));

  if (info.university) blocks.push(titleLine(info.university, { bold: true, caps: true }));
  if (info.department) blocks.push(titleLine(info.department));
  if (info.faculty) blocks.push(titleLine(info.faculty));
  if (info.direction) blocks.push(titleLine(`Направление / специальность: ${info.direction}`));
  if (info.profile) blocks.push(titleLine(`Профиль / специализация: ${info.profile}`));

  // Блок допуска — только у выпускных работ. В курсовой пустая графа
  // «Заведующий кафедрой» выглядит нелепо.
  if (info.withDefenceBlock) {
    empty();
    blocks.push(titleLine('К ЗАЩИТЕ', { align: R }));
    blocks.push(titleLine('(РЕКОМЕНДОВАНО / НЕ РЕКОМЕНДОВАНО)', { align: R, size: 20 }));
    blocks.push(titleLine('Заведующий кафедрой ______________', { align: R }));
    blocks.push(titleLine('«____» ______________ 20____ г.', { align: R }));
  }

  for (let i = 0; i < 4; i++) empty();

  blocks.push(titleLine(info.workType || 'КУРСОВАЯ РАБОТА', { bold: true, caps: true, size: H1_SIZE }));
  empty();
  blocks.push(titleLine('на тему:'));
  if (info.topic) {
    blocks.push(titleLine(`«${String(info.topic).replace(/\.$/, '')}»`, { bold: true }));
  }
  if (info.discipline) {
    empty();
    blocks.push(titleLine(`по дисциплине: ${info.discipline}`));
  }

  for (let i = 0; i < 4; i++) empty();

  blocks.push(titleLine(`Выполнил(а): ${info.student || '____________________'}`, { align: R }));
  if (info.group) blocks.push(titleLine(`Группа: ${info.group}`, { align: R }));
  if (info.studentId) blocks.push(titleLine(`Индивидуальный номер (ИНС): ${info.studentId}`, { align: R }));
  empty();
  blocks.push(titleLine(`Руководитель: ${info.supervisor || '____________________'}`, { align: R }));
  blocks.push(titleLine('«____» ______________ 20____ г.', { align: R }));

  for (let i = 0; i < 5; i++) empty();

  const year = info.year || new Date().getFullYear();
  blocks.push(titleLine(`${info.city || 'Москва'} – ${year}`));
  blocks.push(new Paragraph({ children: [new PageBreak()] }));

  return blocks;
}

/**
 * Раздел «СПИСОК ЛИТЕРАТУРЫ».
 *
 * Записи приходят готовыми — собранными по ГОСТ Р 7.0.100-2018 из
 * метаданных научных баз. Здесь только вёрстка.
 *
 * Нумерация проставляется вручную, а не автосписком Word: методички
 * требуют сплошную нумерацию арабскими цифрами с точкой, а автосписок
 * при копировании фрагментов в другой документ перенумеровывается сам.
 *
 * Абзацного отступа нет — записи выравниваются по левому краю, как в
 * образцах ГОСТа.
 */
function buildBibliography(entries, title) {
  const records = (entries || [])
    .map((e) => String(e || '').trim())
    .filter(Boolean);
  if (!records.length) return [];

  const blocks = makeH1(title || 'СПИСОК ЛИТЕРАТУРЫ', { pageBreakBefore: true });

  records.forEach((record, i) => {
    // Запись может прийти уже пронумерованной: «1. 1. Иванов…» —
    // верный признак машинной сборки.
    const text = record.replace(/^\s*\d+[.)]\s*/, '');
    blocks.push(new Paragraph({
      children: [new TextRun({
        text: `${i + 1}. ${fixDashes(text)}`, size: BODY_SIZE, font: FONT,
      })],
      spacing: { before: 0, after: 0, line: 360 },
      indent: { firstLine: 0 },
      alignment: AlignmentType.JUSTIFIED,
    }));
  });

  return blocks;
}

// ---- Документ целиком ----

// Поля страницы по ГОСТ: верх 2см, низ 2см, слева 3см (переплёт), справа 1.5см.
function buildDocument(children, opts = {}) {
  const { titlePage = false, marginRight = 1.5 * CM } = opts;

  // Номер страницы — полем PAGE, а не текстом: Word пересчитает его
  // сам, когда студент добавит абзац. Правый нижний угол без точки —
  // так требуют методички. На титуле номер не ставится, но страница
  // считается первой, поэтому содержание получает номер 2.
  const footer = new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 0, after: 0 },
      children: [new TextRun({ children: [PageNumber.CURRENT], size: BODY_SIZE, font: FONT })],
    })],
  });

  return new Document({
    styles: {
      default: { document: { run: { font: FONT, size: BODY_SIZE } } },
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 }, // A4
          margin: {
            top: 2 * CM,
            bottom: 2 * CM,
            left: 3 * CM,
            right: marginRight,
          },
        },
        titlePage,
      },
      footers: titlePage ? { default: footer, first: new Footer({ children: [] }) }
                         : { default: footer },
      children,
    }]
  });
}

/**
 * Генерирует .docx для одного фрагмента текста (любой шаг протокола).
 * Заголовок фрагмента форматируется как H1, если совпадает с одним из
 * стандартных разделов работы (ВВЕДЕНИЕ, ЗАКЛЮЧЕНИЕ и т.д.) или явно
 * помечен как H1 через isH1; иначе — как H2 (например, "План раздела 1.1").
 *
 * Для шагов, связанных с таблицей (table_generate/table_check), помимо
 * text и tableMarkdown можно передать:
 * - chapterHeading — заголовок главы (например, "ГЛАВА 1. Понятие и сущность"),
 *   добавляется как H1 перед разделом, чтобы фрагмент не терял контекст.
 * - tableNumber, tableTitle — для подписи "Таблица № N. Название" перед
 *   таблицей и для отсылочной фразы, добавляемой в конец текста.
 * - referenceSentence — отсылочная фраза с уже подставленным номером
 *   (плейсхолдер [N] должен быть заменён до вызова этой функции).
 */
async function generateFragmentDocx({
  title, text, tableMarkdown, isH1,
  chapterHeading, tableNumber, tableTitle, referenceSentence,
}) {
  const normalizedTitle = (title || 'Документ').trim();
  const useH1 = isH1 !== undefined ? isH1 : H1_TITLES.has(normalizedTitle.toUpperCase());

  const children = [];

  // Контекст главы — опционально, чтобы скачанный фрагмент таблицы не
  // выглядел оторванным от структуры работы.
  if (chapterHeading) {
    children.push(...makeH1(chapterHeading, { pageBreakBefore: false }));
  }

  if (useH1) {
    children.push(...makeH1(normalizedTitle, { pageBreakBefore: false }));
  } else {
    children.push(makeH2(normalizedTitle));
  }

  // Если есть таблица с номером/названием — добавляем отсылочную фразу
  // в конец текста (как в финальном документе), затем подпись таблицы
  // перед самой таблицей. Если номера/названия нет — просто вставляем
  // таблицу без подписи (старое поведение, для шагов без этой информации).
  const hasNumberedTable = tableMarkdown && tableNumber && tableTitle;
  const bodyText = hasNumberedTable && referenceSentence
    ? stripDuplicateHeading(text, normalizedTitle).trim() + '\n\n' + referenceSentence
    : stripDuplicateHeading(text, normalizedTitle);

  children.push(...makeBodyParagraphs(bodyText));

  const table = makeTable(parseMarkdownTable(tableMarkdown));
  if (table) {
    if (hasNumberedTable) {
      children.push(makeTableCaption(tableNumber, tableTitle));
    }
    children.push(table);
  }

  const doc = buildDocument(children);
  return Packer.toBuffer(doc);
}

/**
 * Генерирует .docx для всей работы целиком: ВВЕДЕНИЕ, главы (с разрывом
 * страницы перед каждой), разделы внутри глав (1.1, 1.2 — без разрыва),
 * ЗАКЛЮЧЕНИЕ. Разделы группируются по главам на основе номера до точки
 * (1.1, 1.2 → ГЛАВА 1; 2.1 → ГЛАВА 2 и т.д.)
 *
 * chapterTitles — необязательный словарь { "1": "Название главы 1", ... },
 * sectionTitles — необязательный словарь { "1.1": "Название раздела 1.1", ... },
 * извлечённые из текста плана на фронтенде. Если названия нет — используется
 * запасной вариант "ГЛАВА N" / просто номер раздела.
 */
async function generateFullDocx({ topic, introduction, sections, conclusion, chapterTitles, sectionTitles, bibliography, titlePage, contentsTitle, bibliographyTitle, marginRight }) {
  const children = [];
  const refs = (bibliography || []).filter((x) => String(x || '').trim());
  const contentsName = contentsTitle || 'СОДЕРЖАНИЕ';
  const refsName = bibliographyTitle || 'СПИСОК ЛИТЕРАТУРЫ';

  // Титул идёт до содержания и не нумеруется
  children.push(...buildTitlePage(titlePage));

  // СОДЕРЖАНИЕ — первая страница документа
  children.push(...buildContentsPage(sections, chapterTitles, sectionTitles, refs.length > 0, contentsName, refsName));

  // ВВЕДЕНИЕ — H1 с разрывом страницы после СОДЕРЖАНИЯ
  children.push(...makeH1('ВВЕДЕНИЕ', { pageBreakBefore: true }));
  children.push(...makeBodyParagraphs(stripDuplicateHeading(introduction, 'Введение')));

  // Группируем разделы по номеру главы (всё до первой точки)
  let lastChapterNum = null;
  for (const s of (sections || [])) {
    const chapterNum = String(s.number || '').split('.')[0];
    if (chapterNum && chapterNum !== lastChapterNum) {
      const chapterName = chapterTitles && chapterTitles[chapterNum];
      const heading = chapterName ? `ГЛАВА ${chapterNum}. ${chapterName}` : `ГЛАВА ${chapterNum}`;
      children.push(...makeH1(heading, { pageBreakBefore: true }));
      lastChapterNum = chapterNum;
    }
    const sectionNum = s.number ? String(s.number) : null;
    const sectionName = sectionTitles && sectionNum && sectionTitles[sectionNum];
    const sectionHeading = sectionName ? `${sectionNum}. ${sectionName}` : sectionNum;
    children.push(...buildSectionBlocks(sectionHeading, s.text, s.table));
  }

  // ЗАКЛЮЧЕНИЕ — новый H1 с разрывом страницы
  children.push(...makeH1('ЗАКЛЮЧЕНИЕ', { pageBreakBefore: true }));
  children.push(...makeBodyParagraphs(stripDuplicateHeading(conclusion, 'Заключение')));

  children.push(...buildBibliography(refs, refsName));

  const doc = buildDocument(children, {
    titlePage: Boolean(titlePage),
    marginRight: marginRight || 1.5 * CM,
  });
  return Packer.toBuffer(doc);
}

module.exports = {
  generateFragmentDocx,
  generateFullDocx,
  buildBibliography,
  buildTitlePage,
  splitParagraphs,
  parseMarkdownTable,
  fixDashes,
  stripDuplicateHeading,
};
