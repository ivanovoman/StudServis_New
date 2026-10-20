/**
 * Чистка сырого вывода модели перед сборкой раздела.
 *
 * 1. Отказные дисклеймеры. На «чувствительных темах» (Следственный
 *    комитет, новые регионы) GigaChat вместо продолжения выдаёт
 *    служебную оговорку: «Генеративные языковые модели не обладают
 *    собственным мнением… разговоры на чувствительные темы могут быть
 *    ограничены». Оговорка приходит в том же потоке, что и текст, —
 *    иногда посреди фразы («Как отмечает О.И.К сожалению, иногда
 *    генеративные языковые модели…»). В курсовой заказчика она попала
 *    в итоговый файл четыре раза. Срезаем её вместе с недописанным
 *    предложением, на котором модель оборвалась.
 *
 * 2. Завершающая связка. Раздел кончается переходом к следующему
 *    («Теперь логично перейти к…»). Если объёма не хватило, добор
 *    приклеивался ПОСЛЕ связки — и связка оказывалась в середине
 *    раздела. Добавку ставим перед ней.
 */

// Ядро оговорки: по любому из этих оборотов фраза — служебная.
const DISCLAIMER_CORE = [
  /генеративн[а-яё]*\s+языков[а-яё]*\s+модел/i,
  /(?:как\s+и\s+любая\s+)?языков(?:ая|ой)\s+модел[а-яё]*,?\s+(?:GigaChat|ГигаЧат|я\s)/i,
  /GigaChat|ГигаЧат/i,
  /не\s+облада[а-яё]*\s+собственн[а-яё]*\s+мнени/i,
  /разговоры\s+на\s+(?:чувствительные|некоторые|определённые|определенные)\s+темы/i,
  /(?:временно|могут\s+быть)\s+ограничены/i,
  /благодарим\s+за\s+понимание/i,
  /ответ\s+сгенерирован\s+нейросетев/i,
  /обученн[а-яё]*\s+на\s+открытых\s+данных/i,
  /не\s+люблю\s+менять\s+тему\s+разговора/i,
  /что-то\s+в\s+вашем\s+вопросе\s+меня\s+смущает/i,
  /as\s+an\s+ai\s+(?:language\s+)?model/i,
];

// С чего оговорка начинается. Нужны, когда она приклеена без пробела:
// «О.И.К сожалению» — по общему правилу начало фразы тут не найти.
const DISCLAIMER_START = [
  /К\s+сожалению,\s+(?:иногда\s+)?(?:генеративн|я\s+не|не\s+могу)/,
  /Генеративн[а-яё]*\s+языков/,
  /Как\s+и\s+любая\s+языковая\s+модель/,
  /Ответ\s+сгенерирован/,
  /Не\s+люблю\s+менять\s+тему/,
  /Что-то\s+в\s+вашем\s+вопросе/,
  /As\s+an\s+AI/,
];

// Фраза, которая вводит цитату и без неё смысла не имеет:
// «Как отмечает О.И.», «По мнению А.В. Иванова,».
const DANGLING = /(?:отмеча[а-яё]*|пиш[а-яё]*|указыва[а-яё]*|счита[а-яё]*|полага[а-яё]*|подчёркива[а-яё]*|подчеркива[а-яё]*|по\s+мнению)\s+(?:[А-ЯЁ]\.\s?){1,2}(?:[А-ЯЁ][а-яё]+)?,?\s*$/;

function hasDisclaimer(text) {
  return DISCLAIMER_CORE.some((re) => re.test(String(text || '')));
}

/** Где в абзаце начинается оговорка (или -1). */
function disclaimerStart(par) {
  // Явное начало оговорки точнее: оно ловит и склейку без пробела.
  let best = -1;
  for (const re of DISCLAIMER_START) {
    const m = re.exec(par);
    if (m && (best < 0 || m.index < best)) best = m.index;
  }
  if (best >= 0) return best;
  for (const re of DISCLAIMER_CORE) {
    const m = re.exec(par);
    if (!m) continue;
    // Начало фразы с ядром: последняя граница предложения перед ним.
    // Граница — и «. Слово», и склейка «слово.Слово».
    const head = par.slice(0, m.index);
    let at = 0;
    const bound = /[.!?…]\s*(?=[А-ЯЁA-Z«])/g;
    let b;
    while ((b = bound.exec(head)) !== null) at = b.index + b[0].length;
    if (best < 0 || at < best) best = at;
  }
  return best;
}

/** Предложения абзаца — грубо, но с учётом «ст. 15» и инициалов. */
function sentencesOf(par) {
  try {
    const { splitSentences } = require('./polish');
    return splitSentences(par);
  } catch (e) {
    return par.split(/(?<=[.!?…])\s+(?=[А-ЯЁA-Z«])/);
  }
}

/**
 * Срезать оговорки модели.
 *
 * Абзац с оговоркой обрезается до её начала, затем — до последнего
 * целого предложения. Если от абзаца осталась одна фраза, это зачин
 * без продолжения («Практика новых территорий диктует свои контуры
 * развития.») — абзац убираем целиком.
 *
 * @returns {{text: string, removed: string[]}}
 */
function stripDisclaimers(text) {
  const src = String(text || '');
  if (!hasDisclaimer(src)) return { text: src, removed: [] };

  const removed = [];
  const out = [];
  for (const par of src.split(/\n\s*\n/)) {
    if (!hasDisclaimer(par)) { out.push(par); continue; }
    const at = disclaimerStart(par);
    removed.push(par.slice(Math.max(0, at)).trim());
    let head = par.slice(0, Math.max(0, at)).trimEnd();

    // Недописанное предложение, на котором оборвалась модель.
    let sents = sentencesOf(head).filter((s) => s.trim());
    while (sents.length) {
      const last = sents[sents.length - 1].trim();
      const whole = /[.!?…»)\]]$/.test(last) && !DANGLING.test(last);
      if (whole) break;
      removed[removed.length - 1] = `${last} ${removed[removed.length - 1]}`;
      sents = sents.slice(0, -1);
    }
    if (sents.length >= 2) out.push(sents.join(' ').trim());
    else if (sents.length === 1) removed[removed.length - 1] = `${sents[0].trim()} ${removed[removed.length - 1]}`;
  }
  return { text: out.join('\n\n').trim(), removed };
}

// ---- завершающая связка

const TRANSITION = new RegExp([
  '(?:логично|можно|следует|необходимо|нужно|пора|предстоит)\\s+(?:[А-Яа-яЁё]+\\s+){0,3}(?:перейти|переходить|спуститься|рассмотреть|обратиться|разобрать)',
  '(?:мы\\s+)?разбер[её]м\\s+(?:далее|позже|ниже|в\\s+следующ)',
  '(?:рассмотрим|перейд[её]м)\\s+(?:далее|в\\s+следующ|к\\s)',
  'в\\s+следующ(?:ем|ей)\\s+(?:раздел|параграф|глав)',
  '^Теперь,?\\s',
].join('|'), 'i');

// Абзац-итог, который тоже должен стоять последним.
const SUMMARY_PAR = /^(?:Таким\s+образом|Итак|Подводя\s+итог|Резюмируя|Обобщая|Зная|Разобравшись|Установив)/;

/**
 * Отделить хвост раздела — связку с последующим.
 * Хвост — последний абзац, если он итоговый или переходный; иначе —
 * последние фразы последнего абзаца, если в них есть переход.
 */
function splitTail(text) {
  const pars = String(text || '').trim().split(/\n\s*\n/);
  const last = pars[pars.length - 1] || '';
  if (pars.length > 1 && (SUMMARY_PAR.test(last.trim()) || sentencesOf(last).length <= 2 && TRANSITION.test(last))) {
    return { body: pars.slice(0, -1).join('\n\n'), tail: last.trim() };
  }
  const sents = sentencesOf(last);
  let k = sents.length;
  while (k > 0 && TRANSITION.test(sents[k - 1])) k -= 1;
  if (k === sents.length || k === 0) return { body: pars.join('\n\n'), tail: '' };
  const kept = sents.slice(0, k).join(' ');
  return {
    body: [...pars.slice(0, -1), kept].join('\n\n'),
    tail: sents.slice(k).join(' '),
  };
}

/**
 * Дописать добор объёма в раздел. Добор встаёт перед связкой; если у
 * добора своя связка, а у раздела уже есть, — лишнюю убираем.
 */
function appendBeforeTail(text, added) {
  const a = splitTail(text);
  const b = splitTail(added);
  const tail = a.tail || b.tail;
  return [a.body.trim(), b.body.trim(), tail.trim()].filter(Boolean).join('\n\n');
}

/**
 * Ремонт готового раздела: связки и итоговые абзацы из середины — в конец.
 *
 * Для текстов, собранных до appendBeforeTail (курсовая о СК: «Теперь
 * логично перейти…» почти в каждом разделе стояла посередине). Если у
 * раздела есть своя связка в конце, переходные фразы из середины
 * убираются — двух «Теперь перейдём» подряд быть не должно; содержательные
 * фразы итогового абзаца («Таким образом, статус СКР — гибрид») не
 * теряются, а встают перед финальной связкой.
 *
 * @returns {{text: string, moved: number}}
 */
function relocateTransitions(section) {
  const pars = String(section || '').trim().split(/\n\s*\n/);
  if (pars.length < 3) return { text: String(section || '').trim(), moved: 0 };

  const isWholeTail = (p) => (SUMMARY_PAR.test(p.trim()) && TRANSITION.test(p))
    || (sentencesOf(p).length <= 2 && TRANSITION.test(p));
  const bodies = [];
  const moved = [];
  pars.slice(0, -1).forEach((p, i) => {
    // Первый абзац раздела связкой не бывает — это зачин.
    if (i > 0 && isWholeTail(p)) { moved.push(p.trim()); return; }
    const t = splitTail(p);
    if (t.tail && t.body.trim()) { bodies.push(t.body.trim()); moved.push(t.tail); return; }
    bodies.push(p.trim());
  });
  if (!moved.length) return { text: pars.join('\n\n').trim(), moved: 0 };

  const last = splitTail(pars[pars.length - 1]);
  const lastBody = last.tail ? last.body : pars[pars.length - 1];
  const keep = last.tail
    ? moved.map((m) => sentencesOf(m).filter((x) => !TRANSITION.test(x)).join(' ').trim()).filter(Boolean)
    : moved;
  const out = [...bodies, lastBody.trim(), ...keep, last.tail.trim()].filter(Boolean);
  return { text: out.join('\n\n'), moved: moved.length };
}

// ---- латиница внутри русского слова

// Латинские двойники кириллических букв. «убийствa» с латинской «a»
// пришло в курсовой о СК: на глаз не видно, а антиплагиат считает
// такие подмены признаком обхода проверки.
const LATIN_TWINS = { a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', x: 'х', y: 'у', A: 'А', E: 'Е', O: 'О', P: 'Р', C: 'С', X: 'Х', B: 'В', M: 'М', H: 'Н', K: 'К', T: 'Т' };

/** Заменить латинские двойники в словах, где остальные буквы — русские. */
function fixMixedScript(text) {
  let fixed = 0;
  const out = String(text || '').replace(/[А-Яа-яЁёA-Za-z]+/g, (word) => {
    if (!/[А-Яа-яЁё]/.test(word) || !/[A-Za-z]/.test(word)) return word;
    const latin = word.replace(/[А-Яа-яЁё]/g, '');
    if (![...latin].every((ch) => LATIN_TWINS[ch])) return word;
    fixed += latin.length;
    return word.replace(/[A-Za-z]/g, (ch) => LATIN_TWINS[ch]);
  });
  return { text: out, fixed };
}

/**
 * Жирные строки-подзаголовки внутри параграфа убираем.
 *
 * Заказчик выделяет жирным начало абзаца — название разбираемого
 * элемента («**Обеспечительная функция** заключается…»). Модель на ту же
 * просьбу ставит отдельную строку «**Вещно-обязательственная природа**»
 * над абзацем — это подзаголовок четвёртого уровня, которого в
 * курсовой нет. Абзац под ним остаётся, строка уходит.
 *
 * @returns {{text: string, removed: number}}
 */
function stripBoldHeadings(text) {
  let removed = 0;
  const out = String(text || '').split('\n').filter((line) => {
    if (/^\s*(?:#{1,6}\s*)?\*\*[^*\n]{2,90}\*\*\s*[.:]?\s*$/.test(line)) { removed += 1; return false; }
    return true;
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: out, removed };
}

/**
 * Убирает предложения-примеры с выдуманными суммами или адресами:
 * «Например, если квартира продана за 5 млн рублей, а долг — 6 млн…»,
 * «…указано «квартира по адресу г. Москва, ул. Тверская»…». Заказчик
 * вычёркивал их в каждом параграфе (1.1, 1.2, 2.1), а запрет в промпте
 * GigaChat нарушает примерно в одном прогоне из трёх.
 *
 * Удаляется только предложение, которое НАЧИНАЕТСЯ с «Например»,
 * «Допустим», «Предположим», — то есть само является примером: правило
 * от этого не теряется. Предложения со ссылкой [N] не трогаем.
 */
function dropInventedExamples(text) {
  const MONEY = /\d+(?:[.,]\d+)?\s*(?:млн|млрд|тыс\.?|руб)/gi;
  const ADDR = /(?<![А-Яа-яЁё])(?:г\.\s*[А-ЯЁ][а-яё]+\s*,\s*(?:ул|пр-т|просп|пер)\.|по\s+адресу\s+[А-ЯЁг])/;
  let removed = 0;
  const out = String(text || '').split('\n').map((line) => {
    const kept = exampleSentences(line).filter((sent) => {
      if (!/^\s*(?:Например|Допустим|Предположим)(?![а-яё])/.test(sent)) return true;
      if (/\[\d+/.test(sent)) return true;
      if ((sent.match(MONEY) || []).length >= 2 || ADDR.test(sent)) { removed += 1; return false; }
      return true;
    });
    return kept.join('').replace(/\s+$/, '');
  });
  return { text: out.join('\n'), removed };
}

const EXAMPLE_ABBR = new Set(['г', 'ул', 'д', 'кв', 'ст', 'п', 'пп', 'ч', 'т', 'тыс', 'млн', 'млрд', 'руб', 'коп',
  'см', 'гл', 'пр', 'просп', 'пер', 'обл', 'им', 'др', 'т.е', 'т.к', 'т.п', 'т.д']);

/** Предложения строки вместе с пробелами после них; сокращения («г. Москва», «500 тыс. рублей») не режут. */
function exampleSentences(line) {
  const out = [];
  let from = 0;
  const re = /[.!?]+(\s+)(?=[А-ЯЁA-Z«"])/g;
  let m;
  while ((m = re.exec(line))) {
    const before = line.slice(from, m.index);
    const word = (before.match(/([А-Яа-яЁёA-Za-z.]+)$/) || [])[1] || '';
    if (m[0].startsWith('.') && EXAMPLE_ABBR.has(word.toLowerCase())) continue;
    out.push(line.slice(from, m.index + m[0].length));
    from = m.index + m[0].length;
  }
  if (from < line.length) out.push(line.slice(from));
  return out;
}

module.exports = { dropInventedExamples, stripBoldHeadings, relocateTransitions, fixMixedScript, hasDisclaimer, stripDisclaimers, splitTail, appendBeforeTail, TRANSITION };
