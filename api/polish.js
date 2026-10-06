/**
 * Перепись черновика кусками: из машинного текста в авторскую манеру.
 *
 * Второе звено конвейера. Первое (досье из прочитанных статей) даёт
 * черновику содержание, это — форму. Разделение не случайное: опыт
 * показал, что на коротком куске модель держит ритм, а на целом
 * разделе выравнивает все фразы под одну длину, и текст становится
 * машинным. Отсюда куски по 350-500 знаков.
 *
 * Дорого достались три вещи, и каждая здесь закреплена кодом, а не
 * просьбой в задании:
 *
 * 1. Нарезка по границам предложений. Точка в «ст. 15» предложение
 *    не кончает — на юридическом тексте это главный источник ложных
 *    разрывов.
 *
 * 2. Сторож фактуры. При переписи молча пропадают ссылки на нормы:
 *    текст остаётся гладким, а рассуждение остаётся без статьи, на
 *    которую опиралось. Слова «ничего не выбрасывай» в задании от
 *    этого не спасают.
 *
 * 3. Сторож объёма. Перепись ужимает текст на пятую часть, и раздел
 *    на 5500 знаков превращается в 4500. «Объём примерно тот же» в
 *    задании тоже не работает — нужны точные числа в лицо.
 */

'use strict';

const { lostFacts, lostRefs } = require('./facts.js');

// Границы куска. Меньше — рвётся мысль, больше — модель начинает
// выравнивать фразы под одну длину.
const MIN_PIECE = 350;
const MAX_PIECE = 500;

// Доля исходного объёма, ниже которой кусок считается усохшим.
const KEEP_SHARE = 0.9;

// Сколько переписанного текста показывать как левый край окна и
// сколько чернового — как правый. Окно нужно, чтобы куски стыковались
// без повторов и без «итак» в начале каждого.
const WINDOW_BEHIND = 400;
const WINDOW_AHEAD = 250;

const TASK = 'Перепиши фрагмент научной работы в манере автора.\n\n'
  + 'ЖЁСТКИЕ ПРАВИЛА:\n'
  + '- Содержание не меняй: ни одного нового факта, ни одной новой '
  + 'ссылки на норму. Ничего не выбрасывай.\n'
  + '- Объём примерно тот же.\n'
  + '- Не добавляй вступлений и выводов, не пиши «итак» и «таким '
  + 'образом» в начале.\n'
  + '- В ответе только переписанный фрагмент, без пояснений.';

/**
 * Нарезка текста на куски по границам предложений.
 *
 * Резать по счётчику знаков нельзя: граница попадёт в середину фразы,
 * и переписывать придётся обрубок. Набираем целые предложения, пока
 * кусок не дорастёт до нижней границы.
 */
function splitPieces(text, min = MIN_PIECE, max = MAX_PIECE) {
  const GUARD = '\u0000';
  // Сокращения, после которых точка не кончает предложение.
  const abbr = /(?<![А-Яа-яЁёA-Za-z])(ст|стт|п|пп|ч|абз|гл|разд|подп|г|гг|руб|тыс|млн|см|ср|рис|табл|стр|изд|им|др|пр|т|е|д)\./gi;
  const guarded = String(text || '')
    .replace(abbr, (m) => m.replace('.', GUARD))
    .replace(/(\d)\.(\d)/g, `$1${GUARD}$2`);

  const sentences = guarded
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.replace(new RegExp(GUARD, 'g'), '.').trim())
    .filter(Boolean);

  const pieces = [];
  let buf = '';
  for (const s of sentences) {
    const next = buf ? `${buf} ${s}` : s;
    // Фразу не рвём: если кусок набрал нижнюю границу, а следующее
    // предложение выводит за верхнюю — закрываем кусок.
    if (buf.length >= min && next.length > max) {
      pieces.push(buf);
      buf = s;
    } else {
      buf = next;
    }
  }
  if (buf) pieces.push(buf);
  return pieces;
}

/** Правила авторской манеры с образцами. */
function styleRules(samples) {
  const list = Array.isArray(samples) ? samples : [];
  return 'КАК ПИШЕТ АВТОР, В ЧЬЕЙ МАНЕРЕ НУЖНО ПЕРЕПИСАТЬ\n\n'
    + 'Предложения РАЗНОЙ длины — это главное. Почти каждое третье '
    + 'короткое, пять-восемь слов. Попадаются и длинные, одно из семи. '
    + 'Выравнивать все фразы под одну длину нельзя: ровный текст '
    + 'машинный.\n'
    + 'Канцелярит под запретом: «является», «осуществляется», '
    + '«в целях», «в рамках», «данный» в значении «этот».\n'
    + 'Прямая оценка вместо уклончивости.\n\n'
    + list.map((s, i) => `ОТРЫВОК ${i + 1}\n${s}`).join('\n\n');
}

/**
 * Переписывает черновик кусками.
 *
 * @param {string} draft черновой текст
 * @param {object} opts
 * @param {function} opts.ask вызов модели: (messages) => Promise<string>
 * @param {string} opts.style блок с авторской манерой
 * @param {function} [opts.onPiece] сообщает о ходе работы
 * @returns {Promise<{text, pieces, retries, fallbacks, shortfalls, lost}>}
 */
async function polishDraft(draft, opts) {
  const { ask, style = '', onPiece = null } = opts || {};
  if (typeof ask !== 'function') throw new Error('polishDraft: нужен ask');

  const pieces = splitPieces(draft);
  const done = [];
  let retries = 0;
  let fallbacks = 0;
  let shortfalls = 0;

  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i];

    // Окно: хвост уже переписанного и начало следующего чернового.
    // Без него куски стыкуются плохо — модель начинает каждый заново.
    const behind = done.join(' ').slice(-WINDOW_BEHIND);
    const ahead = (pieces[i + 1] || '').slice(0, WINDOW_AHEAD);

    const context = [
      behind ? `УЖЕ ПЕРЕПИСАНО ВЫШЕ (не повторяй, продолжай связно):\n${behind}` : '',
      ahead ? `ДАЛЬШЕ В ЧЕРНОВИКЕ (не переписывай, только для связности):\n${ahead}` : '',
    ].filter(Boolean).join('\n\n');

    const base = `${TASK}${context ? `\n\n${context}` : ''}`
      + `\n\nФРАГМЕНТ ДЛЯ ПЕРЕПИСИ:\n${piece}`;

    let text = await ask([
      { role: 'system', content: style },
      { role: 'user', content: base },
    ]);

    // Сторож следит за тремя вещами: фактура, ссылки на источники,
    // объём. Ссылки добавились после замера всего конвейера: из
    // девятнадцати пропало три, и раздел местами стал пересказом без
    // опоры на литературу.
    let lost = lostFacts(piece, text);
    let dropped = lostRefs(piece, text);
    let short = text.length < piece.length * KEEP_SHARE;

    if (lost.length || dropped.length || short) {
      retries += 1;
      const claims = [];
      if (lost.length) {
        claims.push(`ОБЯЗАТЕЛЬНО сохрани в тексте: ${lost.join(', ')}. `
          + 'В прошлый раз ты это потерял.');
      }
      if (dropped.length) {
        claims.push('ОБЯЗАТЕЛЬНО сохрани ссылки на источники: '
          + `${dropped.map((r) => `[${r}]`).join(', ')}. Они указывают, `
          + 'откуда взята мысль, и выбрасывать их нельзя.');
      }
      if (short) {
        claims.push(`Объём: в исходном фрагменте ${piece.length} знаков, `
          + `в твоём прошлом ответе ${text.length}. Нужно не меньше `
          + `${Math.round(piece.length * KEEP_SHARE)} знаков — разверни `
          + 'мысль подробнее, но ничего не придумывай сверх сказанного.');
      }

      const second = await ask([
        { role: 'system', content: style },
        { role: 'user', content: `${TASK}\n\n${claims.join('\n')}`
          + `\n\nФРАГМЕНТ ДЛЯ ПЕРЕПИСИ:\n${piece}` },
      ]);

      // Вторую попытку берём, только если она не хуже: бывает, что
      // исправив объём, модель роняет ссылку.
      const secondLost = lostFacts(piece, second);
      const secondDropped = lostRefs(piece, second);
      if (secondLost.length + secondDropped.length
          <= lost.length + dropped.length) {
        text = second;
        lost = secondLost;
        dropped = secondDropped;
        short = text.length < piece.length * KEEP_SHARE;
      }
    }

    if (lost.length || dropped.length) {
      // Фактуру вернуть не удалось — берём черновой кусок. Корявая
      // фраза лучше пропавшей ссылки на закон.
      fallbacks += 1;
      text = piece;
    } else if (short) {
      shortfalls += 1;
    }

    done.push(text);
    if (onPiece) onPiece(i + 1, pieces.length);
  }

  const result = done.join('\n\n');
  return {
    text: result,
    pieces: pieces.length,
    retries,
    fallbacks,
    shortfalls,
    lost: lostFacts(draft, result),
    droppedRefs: lostRefs(draft, result),
  };
}

module.exports = {
  MIN_PIECE,
  MAX_PIECE,
  KEEP_SHARE,
  TASK,
  splitPieces,
  styleRules,
  polishDraft,
};
