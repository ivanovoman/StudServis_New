/**
 * Подстрочные сноски: разбор маркеров и сборка ссылок.
 *
 * Модель, когда опирается на подобранную статью, ставит в тексте
 * маркер вида `[3]` — номер источника из списка, который ей передали.
 * Полное описание статьи она не пишет никогда: реквизиты публикаций —
 * то самое место, где модель уверенно врёт. Описание подставляется
 * здесь, из метаданных, полученных от научных баз.
 *
 * Маркеры превращаются в настоящие подстрочные сноски Word: номер
 * надстрочный, текст внизу страницы, нумерация сквозная по работе.
 */

/** Маркер ссылки на источник: [3] или [3, с. 45]. */
const MARKER = /\[(\d{1,2})(?:\s*,\s*с\.\s*([\d\-–]+))?\]/g;

/**
 * Разбирает текст на куски и найденные ссылки.
 *
 * Возвращает `{ parts, used }`, где parts — чередование обычного текста
 * и ссылок, а used — номера использованных источников по порядку
 * появления. Ссылки на несуществующие источники **удаляются**: модель
 * иногда пишет [12], когда источников восемь, и оставить такой маркер
 * в тексте хуже, чем убрать — читатель решит, что потерялась сноска.
 */
function parseMarkers(text, sourceCount) {
  const parts = [];
  const used = [];
  let last = 0;
  let m;

  MARKER.lastIndex = 0;
  while ((m = MARKER.exec(String(text || ''))) !== null) {
    const number = Number(m[1]);
    const valid = number >= 1 && number <= sourceCount;

    if (m.index > last) {
      parts.push({ type: 'text', text: String(text).slice(last, m.index) });
    }
    if (valid) {
      parts.push({ type: 'ref', source: number, page: m[2] || '' });
      used.push(number);
    }
    last = m.index + m[0].length;
  }

  if (last < String(text || '').length) {
    parts.push({ type: 'text', text: String(text).slice(last) });
  }
  return { parts, used };
}

/** Есть ли в тексте хоть одна ссылка на источник. */
function hasMarkers(text) {
  MARKER.lastIndex = 0;
  return MARKER.test(String(text || ''));
}

/** Убирает маркеры, не превращая их в сноски (для предпросмотра). */
function stripMarkers(text) {
  return String(text || '').replace(MARKER, '').replace(/ +([,.;:])/g, '$1');
}

module.exports = { parseMarkers, hasMarkers, stripMarkers, MARKER };
