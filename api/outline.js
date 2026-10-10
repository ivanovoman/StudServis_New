/**
 * Разбор плана работы на структуру: главы и разделы внутри них.
 *
 * Сборка курсовой начинается с вопроса «что именно писать». Ответ лежит
 * в плане, но в виде текста: «ГЛАВА 1. ПОНЯТИЕ...», «### 1.1. Понятие
 * коллизии...». Чтобы пройти по разделам и развернуть каждый, текст
 * надо превратить в список.
 *
 * Разбор намеренно терпим к формату. Модель пишет заголовки то через
 * решётки (`## ГЛАВА 1.`), то жирным (`**Глава 1.**`), то капсом, то
 * обычным регистром; номер раздела бывает «1.1.», «1.1» и даже «1.1)».
 * Требовать один формат бессмысленно — проще принять любой разумный.
 *
 * Если разделов внутри главы не нашлось, глава всё равно попадает в
 * структуру: пусть лучше она будет написана целиком одним куском, чем
 * потеряется молча.
 */

'use strict';

/** Заголовок главы: «## ГЛАВА 2.», «**Глава 2.**», «Глава 2 —». */
const CHAPTER_RE = /^\s*(?:#{1,4}\s*)?(?:\*\*)?\s*глав[аы]\s*(\d+)\s*[.):—-]?\s*(.*)$/i;

/** Заголовок раздела: «### 1.1. Название», «1.1 Название», «**2.3.**». */
const SECTION_RE = /^\s*(?:#{1,4}\s*)?(?:\*\*)?\s*(\d+)\.(\d+)\s*[.):—-]?\s*(.*)$/;

/** Служебные разделы плана — в тело работы не идут. */
const SERVICE_RE = /^\s*(?:#{1,4}\s*)?(?:\*\*)?\s*(введение|заключение|список\s+(?:литературы|источников)|структура\s+списка|библиограф|примечание|источники)/i;

/**
 * Убрать разметку из заголовка.
 *
 * В заголовке остаются хвосты вроде `**` и точка в конце. Точку надо
 * снимать: по ГОСТ заголовок пишется без неё, и если её не убрать, она
 * уедет в готовый документ.
 */
function cleanTitle(raw) {
  return String(raw || '')
    .replace(/\*\*/g, '')
    .replace(/^[\s.:—-]+/, '')
    .replace(/[\s.]+$/, '')
    .trim();
}

/**
 * Разобрать план на главы и разделы.
 *
 * @param {string} planText  текст плана из шага 2
 * @returns {{chapters: Array, warnings: string[]}}
 *   chapters — [{number, title, sections: [{number, title, brief}]}]
 *   warnings — что показалось подозрительным, для показа пользователю
 */
function parseOutline(planText) {
  const lines = String(planText || '').split(/\r?\n/);

  const chapters = [];
  const warnings = [];
  let current = null;      // текущая глава
  let currentSection = null;
  let inService = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Служебные части плана пропускаем целиком, до следующей главы.
    if (SERVICE_RE.test(trimmed)) {
      inService = true;
      currentSection = null;
      continue;
    }

    const chap = trimmed.match(CHAPTER_RE);
    if (chap) {
      inService = false;
      current = {
        number: Number(chap[1]),
        title: cleanTitle(chap[2]),
        sections: [],
      };
      chapters.push(current);
      currentSection = null;
      continue;
    }

    const sec = trimmed.match(SECTION_RE);
    if (sec && !inService) {
      const chapterNum = Number(sec[1]);
      const title = cleanTitle(sec[3]);

      // Номер раздела без заголовка — почти наверняка не заголовок, а
      // перечисление внутри текста («1.1 — см. выше»).
      if (!title) continue;

      // Раздел ссылается на главу, которой ещё не было: план сломан,
      // но терять раздел нельзя — заводим главу-пустышку.
      if (!current || current.number !== chapterNum) {
        const existing = chapters.find((c) => c.number === chapterNum);
        if (existing) {
          current = existing;
        } else {
          warnings.push(
            `Раздел ${sec[1]}.${sec[2]} стоит вне главы ${chapterNum} — `
            + 'проверьте нумерацию плана.');
          current = { number: chapterNum, title: '', sections: [] };
          chapters.push(current);
        }
      }

      currentSection = {
        number: `${sec[1]}.${sec[2]}`,
        title: title,
        brief: '',
      };
      current.sections.push(currentSection);
      continue;
    }

    // Обычная строка — описание текущего раздела. Оно пригодится как
    // задание на написание: там лежат тезисы и нормативная база.
    if (currentSection && !inService) {
      currentSection.brief += (currentSection.brief ? '\n' : '') + trimmed;
    }
  }

  // Глава без разделов — не ошибка, но писать её придётся целиком.
  for (const c of chapters) {
    if (!c.sections.length) {
      warnings.push(
        `В главе ${c.number} не нашлось разделов — она будет написана `
        + 'одним куском.');
    }
  }

  return { chapters, warnings };
}

/**
 * Посчитать, сколько шагов займёт сборка.
 *
 * Нужно, чтобы показать честный прогресс до начала работы: пользователь
 * должен понимать, что это десятки запросов и минуты ожидания, а не
 * «сейчас нажму и через пять секунд готово».
 */
function countSteps(outline, opts = {}) {
  const withIntro = opts.introduction !== false;
  const withConclusion = opts.conclusion !== false;

  let n = 0;
  for (const c of outline.chapters) {
    n += c.sections.length || 1;
  }
  if (withIntro) n += 1;
  if (withConclusion) n += 1;
  return n;
}

/** Плоский список заданий на генерацию, по порядку. */
function buildQueue(outline, opts = {}) {
  const queue = [];

  if (opts.introduction !== false) {
    queue.push({ kind: 'introduction', title: 'Введение' });
  }

  for (const c of outline.chapters) {
    if (!c.sections.length) {
      // Глава без разделов пишется целиком.
      queue.push({
        kind: 'section',
        chapter: c.number,
        number: String(c.number),
        title: c.title,
        brief: '',
        heading: `Глава ${c.number}. ${c.title}`,
      });
      continue;
    }
    for (const s of c.sections) {
      queue.push({
        kind: 'section',
        chapter: c.number,
        number: s.number,
        title: s.title,
        brief: s.brief,
        heading: `${s.number}. ${s.title}`,
        chapterTitle: c.title,
      });
    }
  }

  if (opts.conclusion !== false) {
    queue.push({ kind: 'conclusion', title: 'Заключение' });
  }

  return queue;
}

module.exports = { parseOutline, countSteps, buildQueue, cleanTitle };
