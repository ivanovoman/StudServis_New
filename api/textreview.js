/**
 * Глубокий анализ раздела курсовой.
 *
 * «Переписать» и «Править» отвечают на вопрос «что сделать», но не на
 * вопрос «что не так». Здесь — разбор готового раздела, который можно
 * читать как замечания научного руководителя, с цитатой и советом к
 * каждому пункту. Две части:
 *
 * 1. Проверки кодом (localChecks) — мгновенно и без модели: объём,
 *    разговорные обороты, ритм и конкретика, сноски, факты, которые
 *    надо сверить, повторы с соседними разделами, покрытие плана.
 * 2. Рецензия модели (REVIEW_PROMPT, parseReview) — то, что кодом не
 *    поймать: логика, полнота раскрытия, обоснованность выводов и
 *    предложений по законодательству, уместность таблиц.
 *
 * Пороги ритма и конкретики взяты из замеров, а не придуманы:
 *  - медиана слов в предложении: статьи автора 11, академические
 *    работы 17, цель 13 (замер корпуса Коколова);
 *  - доля предложений от 25 слов: 8,3 / 26,9 %, цель около 17,5 %;
 *  - цифр на 1000 знаков в блоках, которые Антиплагиат пометил как ИИ,
 *    медиана 1,8, в непомеченных — 3,9; разброс длины предложений
 *    (CV) — 0,46 против 0,53. Разбор 8 отчётов — research/antiplagiat.
 *
 * Ни один из этих признаков не приговор (лучший AUC 0,67), поэтому
 * они идут как «стоит посмотреть», а не как ошибка.
 */

'use strict';

const { findColloquial } = require('./register');
const { splitSentences } = require('./polish');

const TARGETS = {
  introduction: { min: 3800, max: 5000 },
  section: { min: 5000, max: 6000 },
  conclusion: { min: 2000, max: 3500 },
};

const charsNoSpace = (t) => String(t || '').replace(/\s/g, '').length;
const words = (s) => String(s || '').match(/[А-Яа-яЁёA-Za-z0-9]+(?:-[А-Яа-яЁёA-Za-z0-9]+)*/g) || [];

function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function round(n, d = 2) {
  const k = 10 ** d;
  return Math.round(n * k) / k;
}

/** Обрезать цитату до разумной длины по границе слова. */
function clip(s, n = 160) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return t.slice(0, n).replace(/\s+\S*$/, '') + '…';
}

/** Ритм и конкретика: то, что Антиплагиат хоть как-то различает. */
function rhythm(text) {
  const sentences = splitSentences(text).filter((s) => words(s).length >= 3);
  const lens = sentences.map((s) => words(s).length);
  const mean = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / (lens.length || 1));
  // Цифры в номерах норм, датах и ссылках — это и есть конкретика.
  // Номера сносок [3] не считаем: они не делают текст конкретнее.
  const digits = (String(text).replace(/\[\d+(?:,\s*с\.\s*\d+)?\]/g, '').match(/\d/g) || []).length;
  const len = String(text).length || 1;
  return {
    sentences: lens.length,
    medianWords: median(lens),
    longShare: lens.length ? round(lens.filter((n) => n >= 25).length / lens.length, 3) : 0,
    cv: mean ? round(sd / mean, 2) : 0,
    digitsPer1000: round((digits / len) * 1000, 1),
    longest: sentences.reduce((best, s) => (words(s).length > words(best).length ? s : best), ''),
  };
}

const REF_RE = /\[(\d+)(?:,\s*с\.\s*\d+)?\]/g;

/**
 * Реквизиты, которые модель любит выдумывать: судебные акты с номером,
 * дела, постановления. Каждый надо сверить с первоисточником.
 */
// Точка внутри реквизита допустима в дате (17.12.1996) и в «г.».
const ACT_RE = /(?:[Пп]остановлени[еяию]|[Оо]пределени[еяию]|[Рр]ешени[еяию]|[Оо]бзор[а-я]*|[Пп]исьм[оа])\s+(?:[^.;\n]|(?<=\d)\.(?=\d)|(?<=\sг)\.){0,120}?(?:№|N)\s*[0-9А-Яа-яЁёA-Za-z][0-9А-Яа-яЁёA-Za-z\-–/]*(?:\.[0-9А-Яа-яЁёA-Za-z\-–/]+)*/g;
const CASE_RE = /дел[оау]?\s+№\s*[АA]?\d{1,3}-\d+\/\d{2,4}/g;
const STAT_RE = /\d[\d\s,.]*\s*(?:%|процент[а-я]*|млрд|млн|трлн|тыс\.)/i;

/**
 * Основы слов из краткого содержания параграфа в плане. Совпадение по
 * началу слова (6 букв) грубое, но для «заявлено в плане — не нашлось
 * в тексте» хватает: падежи и числа русской основы его не ломают.
 */
const STOP = new Set(['который', 'которые', 'также', 'является', 'данного', 'рамках', 'основные',
  'анализ', 'рассмотрение', 'рассмотреть', 'выявление', 'особенности', 'понятие', 'вопросы']);
function briefStems(brief) {
  const seen = new Set();
  return words(brief)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 7 && !STOP.has(w))
    .map((w) => w.slice(0, 6))
    .filter((s) => !seen.has(s) && seen.add(s));
}

/** Шинглы по 6 слов — для поиска повторов с соседними разделами. */
function shingles(text, n = 6) {
  const ws = words(text).map((w) => w.toLowerCase());
  const out = new Set();
  for (let i = 0; i + n <= ws.length; i++) out.add(ws.slice(i, i + n).join(' '));
  return out;
}

/**
 * Проверки кодом.
 *
 * @param {string} text
 * @param {object} ctx  kind, heading, brief, sources (массив), others
 *                      (тексты других разделов: [{heading, text}])
 * @returns {{metrics: object, findings: Array}}
 *   finding: {group, level: 'strong'|'warn'|'info', title, detail,
 *             quotes?: string[], advice?: string}
 */
function localChecks(text, ctx = {}) {
  const src = String(text || '');
  const findings = [];
  const add = (f) => findings.push(f);
  const kind = TARGETS[ctx.kind] ? ctx.kind : 'section';

  // ---- объём
  const chars = charsNoSpace(src);
  const t = TARGETS[kind];
  if (chars < t.min) {
    add({ group: 'Объём', level: 'warn', title: `Меньше нормы: ${chars} знаков без пробелов`,
      detail: `Норма — ${t.min}–${t.max}. Не хватает около ${t.min - chars}.`,
      advice: 'Раскрыть один из тезисов подробнее: позиция суда или автора, пример, следствие для практики.' });
  } else if (chars > t.max) {
    add({ group: 'Объём', level: 'info', title: `Больше нормы: ${chars} знаков без пробелов`,
      detail: `Норма — ${t.min}–${t.max}.`,
      advice: 'Убрать повторы и общие фразы, а не содержательные тезисы.' });
  }

  // ---- научный стиль
  const hits = findColloquial(src);
  if (hits.length) {
    const byMatch = new Map();
    for (const h of hits) if (!byMatch.has(h.match.toLowerCase())) byMatch.set(h.match.toLowerCase(), h);
    const list = [...byMatch.values()];
    add({ group: 'Научный стиль', level: 'strong',
      title: `Разговорные обороты: ${list.length}`,
      detail: 'В академической работе недопустимы идиомы, разговорные оценки, жаргон и разговорная модальность.',
      quotes: list.slice(0, 12).map((h) => h.match),
      items: list.slice(0, 12).map((h) => ({ quote: h.match, kind: h.kind, advice: h.hint })),
      advice: 'Заменить нейтральной научной формулировкой — подсказки у каждого оборота.' });
  }

  // ---- ритм и конкретика
  const r = rhythm(src);
  if (r.sentences >= 8) {
    if (r.medianWords > 17) {
      add({ group: 'Ритм', level: 'warn', title: `Длинные предложения: в середине ${r.medianWords} слов`,
        detail: 'Ориентир — около 13 слов. Длинные фразы утомляют и прячут мысль.',
        quotes: [clip(r.longest, 220)],
        advice: 'Разбить самые длинные предложения: одно предложение — одна мысль.' });
    } else if (r.medianWords < 9) {
      add({ group: 'Ритм', level: 'info', title: `Рубленые предложения: в середине ${r.medianWords} слов`,
        detail: 'Ориентир — около 13 слов. Сплошь короткие фразы звучат как конспект.',
        advice: 'Соединить связанные мысли в одно предложение.' });
    }
    if (r.longShare > 0.3) {
      add({ group: 'Ритм', level: 'info',
        title: `Предложений от 25 слов: ${Math.round(r.longShare * 100)} %`,
        detail: 'Ориентир — около 17 %.' });
    }
    if (r.cv < 0.4) {
      add({ group: 'Ритм', level: 'warn', title: 'Предложения почти одной длины',
        detail: `Разброс длины ${r.cv} (у текстов, которые Антиплагиат не пометил, — около 0,53). Ровный ритм — один из признаков машинного текста.`,
        advice: 'Чередовать короткие и развёрнутые фразы: короткий тезис, затем пояснение.' });
    }
    if (r.digitsPer1000 < 2) {
      add({ group: 'Конкретика', level: 'warn',
        title: `Мало конкретики: ${r.digitsPer1000} цифры на 1000 знаков`,
        detail: 'В блоках, которые Антиплагиат пометил как ИИ, — около 1,8, в непомеченных — 3,9. Цифры здесь — номера статей и законов, даты, суммы, номера дел.',
        advice: 'Привязать тезисы к конкретным нормам («п. 3 ст. 11.3 НК РФ»), датам и проверенным данным. Не выдумывать — только из источников.' });
    }
  }

  // ---- источники и сноски
  const sources = Array.isArray(ctx.sources) ? ctx.sources : [];
  const refs = [...src.matchAll(REF_RE)].map((m) => Number(m[1]));
  const used = [...new Set(refs)].sort((a, b) => a - b);
  const missing = used.filter((n) => n < 1 || n > sources.length);
  if (sources.length && missing.length) {
    add({ group: 'Сноски', level: 'strong',
      title: `Ссылки на несуществующие источники: ${missing.map((n) => `[${n}]`).join(', ')}`,
      detail: `В списке работы ${sources.length} публикаций. Такую сноску модель выдумала.`,
      quotes: missing.map((n) => `[${n}`),
      advice: 'Убрать ссылку или заменить реальной публикацией из списка.' });
  }
  if (!refs.length) {
    add({ group: 'Сноски', level: sources.length ? 'warn' : 'info', title: 'Ни одной ссылки на литературу',
      detail: sources.length
        ? `Для работы подобрано ${sources.length} публикаций, но раздел на них не опирается.`
        : 'Источники для работы ещё не подобраны.',
      advice: 'Опереть ключевые тезисы на публикации: [N] после утверждения.' });
  } else {
    const paras = src.split(/\n\s*\n|\n(?=\S)/).map((p) => p.trim()).filter((p) => charsNoSpace(p) > 500);
    const hasRef = /\[\d+(?:,\s*с\.\s*\d+)?\]/;
    const bare = paras.filter((p) => !hasRef.test(p));
    if (paras.length >= 3 && bare.length / paras.length > 0.6) {
      add({ group: 'Сноски', level: 'info',
        title: `Абзацев без единой ссылки: ${bare.length} из ${paras.length}`,
        quotes: bare.slice(0, 2).map((p) => clip(p, 120)),
        advice: 'Там, где утверждается позиция автора, суда или статистика, нужна опора.' });
    }
  }

  // ---- факты, которые надо сверить
  const acts = [...new Set([...(src.match(ACT_RE) || []), ...(src.match(CASE_RE) || [])]
    .map((s) => clip(s, 140)))];
  if (acts.length) {
    add({ group: 'Проверить по первоисточнику', level: 'warn',
      title: `Реквизиты судебных актов и документов: ${acts.length}`,
      detail: 'Модели уверенно выдумывают номера постановлений, дел и даты. Каждый реквизит — сверить.',
      quotes: acts.slice(0, 10),
      advice: 'Сверить в КонсультантПлюс, ksrf.ru, vsrf.ru, kad.arbitr.ru. Не нашёлся — удалить.' });
  }
  const stats = splitSentences(src).filter((s) => STAT_RE.test(s) && !/\[\d+/.test(s));
  if (stats.length) {
    add({ group: 'Проверить по первоисточнику', level: 'info',
      title: `Цифры без ссылки на источник: ${stats.length}`,
      quotes: stats.slice(0, 5).map((s) => clip(s, 160)),
      advice: 'Указать источник (статистика ФНС, Судебного департамента) или убрать.' });
  }

  // ---- повторы с другими разделами
  const others = Array.isArray(ctx.others) ? ctx.others : [];
  if (others.length) {
    const mine = splitSentences(src);
    const repeats = [];
    for (const o of others) {
      const sh = shingles(o.text);
      if (!sh.size) continue;
      for (const s of mine) {
        const own = shingles(s);
        let common = 0;
        for (const x of own) if (sh.has(x)) common++;
        if (common >= 2) repeats.push({ quote: clip(s, 160), where: o.heading || 'другой раздел' });
      }
    }
    if (repeats.length) {
      add({ group: 'Повторы', level: 'warn', title: `Повторяет другие разделы: ${repeats.length} предл.`,
        quotes: repeats.slice(0, 6).map((x) => x.quote),
        detail: 'Совпадения с: ' + [...new Set(repeats.map((x) => x.where))].join('; '),
        advice: 'Сослаться на сказанное («как показано в параграфе 1.1») и двигаться дальше.' });
    }
  }

  // ---- покрытие плана
  const stems = briefStems(ctx.brief);
  if (stems.length >= 3) {
    const lower = src.toLowerCase();
    const absent = stems.filter((s) => !lower.includes(s));
    if (absent.length >= 2 && absent.length / stems.length >= 0.4) {
      add({ group: 'План', level: 'info', title: 'Не всё из плана параграфа нашлось в тексте',
        detail: `По плану: «${clip(ctx.brief, 220)}»`,
        quotes: absent.map((s) => s + '…'),
        advice: 'Проверить, раскрыт ли каждый заявленный пункт.' });
    }
  }

  const order = { strong: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);

  return {
    metrics: {
      chars, target: t, sentences: r.sentences, medianWords: r.medianWords,
      longShare: r.longShare, cv: r.cv, digitsPer1000: r.digitsPer1000,
      refs: refs.length, refsUnique: used.length, sources: sources.length,
      colloquial: hits.length,
    },
    findings,
  };
}

// ----------------------------------------------------- рецензия модели

/**
 * Задание рецензенту. Формат ответа жёсткий и построчный: модели
 * отвечают кто списком, кто таблицей, а разбирать нужно надёжно.
 * Цитата обязательна — без неё замечание нельзя ни проверить, ни
 * показать в тексте.
 */
const REVIEW_PROMPT = `Ты — научный руководитель курсовой работы, строгий, но доброжелательный. Тебе дают один раздел работы, его место в плане и тему.

Оцени раздел по существу. Ищи то, что не поймать автоматической проверкой:
- соответствует ли текст заголовку и тому, что обещано в плане;
- логика: вытекает ли каждый вывод из сказанного, нет ли скачков и противоречий;
- полнота: раскрыты ли нюансы темы, нет ли пропущенных очевидных аспектов, позиций, спорных вопросов;
- обоснованность: подкреплены ли утверждения нормами, практикой, литературой; если предлагаются изменения законодательства — обоснованы ли они;
- фактические утверждения, которые выглядят сомнительно и требуют проверки (нормы, даты, номера актов);
- вода и общие фразы, которые ничего не сообщают;
- таблицы: уместны ли, дополняют ли мысль, а не повторяют её; нет ли пустых таблиц.

Не называй конкретные номера постановлений, дел и дат, если не уверен в них полностью: пиши, что именно найти («позицию Конституционного Суда о пределах прокурорского надзора»), а не выдуманный реквизит.

Не придирайся к стилю ради придирки и не переписывай текст целиком. Не больше 8 замечаний, самые важные — первыми. Если раздел хорош, так и скажи и дай 1–3 замечания на улучшение.

Ответ — строго в таком формате, без вступлений:

ОЦЕНКА: одно-два предложения общего вывода
ЗАМЕЧАНИЕ: в чём проблема — коротко
ЦИТАТА: дословный фрагмент раздела, к которому относится замечание (5–20 слов), или «—», если замечание ко всему разделу
СОВЕТ: что конкретно сделать
ЗАМЕЧАНИЕ: …
ЦИТАТА: …
СОВЕТ: …`;

/**
 * Разбор ответа рецензента. Терпим к разметке: «**ЗАМЕЧАНИЕ:**»,
 * «1. ЗАМЕЧАНИЕ —», цитаты в кавычках. Цитату, которой нет в тексте,
 * не показываем как цитату: модель могла её пересказать, и подсветить
 * такой фрагмент в тексте нельзя.
 */
function parseReview(answer, text = '') {
  const src = String(answer || '').replace(/\*\*/g, '');
  const lines = src.split('\n').map((l) => l.trim()).filter(Boolean);
  const label = /^(?:\d+[.)]\s*)?(?:[-•]\s*)?(ОЦЕНКА|ЗАМЕЧАНИЕ|ЦИТАТА|СОВЕТ)\s*[:—–-]\s*(.*)$/i;
  let summary = '';
  const items = [];
  let cur = null;
  let last = null;
  for (const line of lines) {
    const m = line.match(label);
    if (!m) {
      if (last && cur) cur[last] = (cur[last] ? cur[last] + ' ' : '') + line;
      else if (last === 'summary') summary += ' ' + line;
      continue;
    }
    const key = m[1].toUpperCase();
    const value = m[2].trim();
    if (key === 'ОЦЕНКА') { summary = value; last = 'summary'; continue; }
    if (key === 'ЗАМЕЧАНИЕ') { cur = { title: value, quote: '', advice: '' }; items.push(cur); last = 'title'; continue; }
    if (!cur) continue;
    if (key === 'ЦИТАТА') { cur.quote = value; last = 'quote'; }
    if (key === 'СОВЕТ') { cur.advice = value; last = 'advice'; }
  }

  const norm = (s) => String(s).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
  const hay = norm(text);
  for (const it of items) {
    let q = it.quote.replace(/^[«"“„']+|[»"”']+$/g, '').replace(/[.…]+$/, '').trim();
    if (!q || q === '—' || q === '-') q = '';
    it.quote = q;
    it.quoteFound = q ? hay.includes(norm(q)) : false;
    if (q && !it.quoteFound) {
      // Модель обрывает цитату на полуслове или вставляет «…» в
      // середину. Берём самое длинное начало (от 4 слов), которое есть
      // в тексте дословно, — его можно подсветить.
      const head = q.split(/\s*(?:\.\.\.|…)\s*/)[0];
      const ws = head.split(/\s+/);
      for (let n = ws.length; n >= 4; n--) {
        const part = ws.slice(0, n).join(' ').replace(/[,;:—–-]+$/, '');
        if (hay.includes(norm(part))) {
          it.quote = part;
          it.quoteFound = true;
          break;
        }
      }
    }
  }
  return {
    summary: summary.trim(),
    items: items.filter((it) => it.title).slice(0, 10),
  };
}

// ---------------------------------------------- правка по замечаниям

/**
 * Задание на точечную правку. Главный риск — модель «улучшает» весь
 * раздел и теряет половину текста. Поэтому: менять только отмеченное,
 * остальное — дословно, и сервер сверяет объём результата.
 */
const REVISE_PROMPT = `Ты редактируешь раздел курсовой работы по замечаниям научного руководителя.

Правила:
- Исправь ТОЛЬКО то, к чему относятся замечания. Всё остальное оставь дословно — те же предложения, тот же порядок абзацев.
- Объём не сокращай. Если замечание требует раскрыть мысль — дополни текст.
- Не выдумывай нормы, номера судебных актов, даты и статистику. Если для исправления нужен реальный реквизит, а его нет, напиши «[нужно проверить]».
- Ссылки вида [N] сохраняй. Новых номеров, которых нет в тексте, не добавляй.
- Научный стиль: без разговорных оборотов, идиом, жаргона и разговорной модальности.
- Верни только исправленный текст раздела, без заголовка, пояснений и списка изменений.`;

function reviseMessages({ text, remarks, heading, topic }) {
  const list = (Array.isArray(remarks) ? remarks : [])
    .map((r, i) => `${i + 1}. ${r.title || ''}`
      + (r.quote ? `\n   Фрагмент: «${r.quote}»` : '')
      + (r.advice ? `\n   Что сделать: ${r.advice}` : ''))
    .join('\n');
  return [
    { role: 'system', content: REVISE_PROMPT },
    { role: 'user', content: `Тема работы: ${topic || '—'}\nРаздел: ${heading || '—'}\n\nЗАМЕЧАНИЯ:\n${list}\n\nТЕКСТ РАЗДЕЛА:\n${text}` },
  ];
}

/**
 * Приемка правки: модель не должна была сократить раздел и выбросить
 * сноски. Возвращает null, если правка годится, иначе причину отказа.
 */
function rejectRevision(before, after, remarks = []) {
  const a = charsNoSpace(before);
  const b = charsNoSpace(after);
  if (!b) return 'модель вернула пустой ответ';
  if (b < a * 0.85) return `модель сократила раздел с ${a} до ${b} знаков`;
  const refs = (t) => new Set([...String(t).matchAll(REF_RE)].map((m) => m[1]));
  // Ссылку, о которой прямо говорит замечание («[7] — выдуманная»),
  // убрать можно: ради этого правку и просили.
  const named = new Set();
  for (const r of remarks) {
    for (const m of `${r.title || ''} ${r.quote || ''} ${r.advice || ''}`.matchAll(/\[(\d+)/g)) named.add(m[1]);
  }
  const lost = [...refs(before)].filter((n) => !refs(after).has(n) && !named.has(n));
  if (lost.length) return `пропали ссылки на источники: ${lost.map((n) => `[${n}]`).join(', ')}`;
  return null;
}

module.exports = {
  localChecks, rhythm, parseReview, REVIEW_PROMPT, REVISE_PROMPT,
  reviseMessages, rejectRevision, briefStems,
};
