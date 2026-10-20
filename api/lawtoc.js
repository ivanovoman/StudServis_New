'use strict';

/**
 * Оглавления федеральных законов, сохранённые в проекте.
 *
 * Зачем. В параграфе 1.2 курсовой об ипотеке GigaChat уверенно
 * приписал статьям Закона об ипотеке чужое содержание: ст. 64.2 —
 * залог в пользу субъекта РФ при строительстве на бюджетные средства
 * (на деле — участок под зданием, построенным в кредит), ст. 54.1 и 61 —
 * прекращение остатка долга (на деле — основания отказа в обращении
 * взыскания и распределение выручки). Перечень предмета ипотеки модель
 * взяла из старой редакции ст. 5 («дачи», «предприятия»), без
 * машино-мест.
 *
 * Python-бэкенд сверяет статьи кодексов по КонсультантПлюс, но он не
 * всегда запущен, а законы не распознавал вовсе. Здесь те же оглавления
 * читаются из backend/app/modules/sources/toc/*.json и используются
 * трижды:
 *   1. tocHint — заголовки статей в задании модели, чтобы она не
 *      выдумывала предмет статьи и опиралась на действующую редакцию;
 *   2. tocProblems — ссылки на несуществующие и утратившие силу статьи;
 *   3. reviewTitles — настоящие заголовки статей, на которые ссылается
 *      текст, для рецензента «Глубокого анализа»: сравнить пересказ с
 *      предметом статьи по смыслу модель может, а словами — нет.
 */

const fs = require('fs');
const path = require('path');

const TOC_DIR = path.join(__dirname, '..', 'backend', 'app', 'modules', 'sources', 'toc');

const NUMS = String.raw`(\d+(?:\.\d+)?(?:\s*(?:,|и)\s*\d+(?:\.\d+)?)*)`;
const ART = String.raw`(?<![А-Яа-яЁё])ст(?:атьи|атья|атьёй|атьей|атьями|атьях|атьям|атье|\.)\s*(?:ст\.\s*)?`;

const LAWS = [
  {
    key: 'ИПОТ',
    file: 'ipoteka.json',
    title: 'Федеральный закон от 16.07.1998 № 102-ФЗ «Об ипотеке (залоге недвижимости)»',
    label: 'Закона об ипотеке',
    // Когда закон относится к теме работы.
    detect: /ипотек|залог[а-яё]*\s+недвижим/i,
    // «ст. 64.2 Закона об ипотеке», «статьями 10 и 11 Закона об ипотеке»,
    // «ст. 5 Федерального закона от 16 июля 1998 г. № 102-ФЗ».
    forward: new RegExp(`${ART}${NUMS}([^;:)\\n]{0,80}?)(Закон[а-яё]*\\s+об\\s+ипотеке|«Об\\s+ипотеке|№\\s*102-ФЗ)`, 'gi'),
    // «Закон об ипотеке в ст. 5 перечисляет…»
    backward: new RegExp(String.raw`Закон[а-яё]*\s+об\s+ипотеке\s+(?:в\s+)?ст(?:атье|атьях|атьями|\.)\s*${NUMS}`, 'gi'),
  },
];

const CODES_IN_GAP = /(?<![А-Яа-яЁё])(?:ТК|ГК|ЖК|СК|УК|КоАП|ГПК|АПК|НК|УПК|ЗК)(?![А-Яа-яЁё])/;

const cache = new Map();

function loadToc(law) {
  if (cache.has(law.key)) return cache.get(law.key);
  let toc = {};
  try {
    const data = JSON.parse(fs.readFileSync(path.join(TOC_DIR, law.file), 'utf8'));
    for (const [k, v] of Object.entries(data)) if (!k.startsWith('_')) toc[k] = v;
    // Проверенное содержание ключевых статей (не только заголовок):
    // по одному заголовку модель всё равно перечисляла предмет ипотеки
    // по старой редакции ст. 5 («дачи»).
    Object.defineProperty(toc, '_content', { value: data._content || {}, enumerable: false });
  } catch (e) {
    toc = {};
  }
  cache.set(law.key, toc);
  return toc;
}

function splitNums(s) {
  return String(s).split(/\s*(?:,|и)\s*/).map((x) => x.trim()).filter(Boolean);
}

/** Фраза вокруг ссылки — до ближайшей точки с заглавной, «;» или абзаца. */
function sentenceAround(text, start, end) {
  // Конец предложения — точка, после которой пробел и заглавная буква:
  // «п. 1 ст. 77», «1998 г. №» границей не считаются.
  const BOUND = /[.!?]\s+(?=[А-ЯЁA-Z«"])|[;\n]/g;
  let l = 0;
  for (const m of text.matchAll(BOUND)) {
    if (m.index + m[0].length > start) break;
    l = m.index + m[0].length;
  }
  const tail = text.slice(end);
  const m = tail.match(/[.!?](?=\s+[А-ЯЁA-Z«"]|\s*$)|[;\n]/);
  const r = m ? end + m.index + 1 : text.length;
  return text.slice(l, r).replace(/\s+/g, ' ').trim();
}

/** Все ссылки на статьи законов с сохранённым оглавлением. */
function articleRefs(text) {
  const src = String(text || '');
  const out = [];
  const seen = new Set();
  for (const law of LAWS) {
    const toc = loadToc(law);
    const push = (nums, start, end) => {
      for (const article of splitNums(nums)) {
        const id = `${law.key}:${article}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          law,
          article,
          label: `ст. ${article} ${law.label}`,
          title: Object.prototype.hasOwnProperty.call(toc, article) ? toc[article] : null,
          tocLoaded: Object.keys(toc).length > 0,
          claim: sentenceAround(src, start, end),
          start,
        });
      }
    };
    law.forward.lastIndex = 0;
    for (const m of src.matchAll(law.forward)) {
      const gap = m[2] || '';
      if (/\.\s+[А-ЯЁ]/.test(gap) || CODES_IN_GAP.test(gap)) continue;
      push(m[1], m.index, m.index + m[0].length);
    }
    law.backward.lastIndex = 0;
    for (const m of src.matchAll(law.backward)) push(m[1], m.index, m.index + m[0].length);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Ссылки на статьи, которых нет или которые утратили силу. */
function tocProblems(text) {
  return articleRefs(text)
    .filter((r) => r.tocLoaded)
    .flatMap((r) => {
      if (r.title === null) {
        return [{ label: r.label, status: 'missing', note: `статьи с таким номером в законе нет (${r.law.title})` }];
      }
      if (/^утратил/i.test(r.title)) {
        return [{ label: r.label, status: 'mismatch', note: `статья утратила силу` }];
      }
      return [];
    });
}

/**
 * Блок для задания модели: заголовки статей закона, если он относится
 * к теме. Утратившие силу статьи не показываем — ссылаться на них
 * незачем.
 */
function tocHint(context) {
  const ctx = String(context || '');
  const blocks = [];
  for (const law of LAWS) {
    if (!law.detect.test(ctx)) continue;
    const toc = loadToc(law);
    const lines = Object.entries(toc)
      .filter(([, t]) => !/^утратил/i.test(t))
      .map(([n, t]) => `ст. ${n} — ${t.length > 110 ? `${t.slice(0, 107)}…` : t}`);
    if (!lines.length) continue;
    const content = Object.entries(toc._content || {})
      .map(([n, t]) => `ст. ${n} (содержание): ${t}`);
    blocks.push(`ДЕЙСТВУЮЩИЕ СТАТЬИ: ${law.title} (актуальная редакция).\n`
      + 'Ссылайся на статью этого закона, только если описываемое правило соответствует её заголовку ниже. '
      + 'Не приписывай статье содержание, которого нет в её предмете. Если нужной статьи в перечне нет '
      + 'или ты не уверен в номере — излагай правило без номера статьи. Перечни объектов, условия и '
      + 'термины бери из действующей редакции, а не из прежних (например, «дачи» из ст. 5 исключены).\n'
      + lines.join('\n')
      + (content.length ? `\n\nСОДЕРЖАНИЕ КЛЮЧЕВЫХ СТАТЕЙ (действующая редакция):\n${content.join('\n')}` : ''));
  }
  return blocks.join('\n\n');
}

/** Для рецензента: что на самом деле регулируют статьи, на которые ссылается текст. */
function reviewTitles(text) {
  const refs = articleRefs(text).filter((r) => r.title);
  if (!refs.length) return '';
  return 'НАСТОЯЩИЕ ЗАГОЛОВКИ СТАТЕЙ, на которые ссылается текст (по официальному оглавлению). '
    + 'Сравни с тем, что текст об этих статьях утверждает. Если текст приписывает статье '
    + 'содержание вне её предмета — это замечание категории «Юридическая точность»:\n'
    + refs.map((r) => `- ${r.label} — «${r.title}». В тексте: «${r.claim.slice(0, 320)}»`).join('\n');
}

module.exports = { LAWS, loadToc, articleRefs, tocProblems, tocHint, reviewTitles };
