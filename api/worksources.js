/**
 * Один список публикаций на всю работу.
 *
 * Сносочные номера [1], [3] — это позиции в списке найденных
 * публикаций. При сборке целиком список подбирается один раз, и номера
 * везде означают одно и то же. При письме по разделам каждый раздел —
 * отдельный запрос, и раньше каждый искал публикации заново. Внешние
 * базы отвечают не всегда одинаково: другой набор или порядок — и [3]
 * в параграфе 2.1 указывает уже на другую статью, чем [3] в 1.1, а
 * список литературы расходится со сносками.
 *
 * Поэтому найденный список закрепляется за работой. Порядок поиска:
 *
 * 1. Закреплённый на сервере (по workId, а до появления workId — по
 *    владельцу и теме). В нём есть полные тексты и аннотации, то есть
 *    самый содержательный блок для промпта.
 * 2. Список, присланный клиентом. Сервер мог перезапуститься, и
 *    закреплённое в памяти пропало, а клиент свой список хранит. Блок
 *    для промпта из него беднее (только реквизиты), зато номера те же.
 * 3. Новый поиск — только для первого раздела работы.
 */

'use strict';

const DEFAULT_TTL = 12 * 60 * 60 * 1000;
const DEFAULT_MAX = 500;

/** Хранилище в памяти с ограниченным сроком и размером. */
function createSourcePins({ ttlMs = DEFAULT_TTL, max = DEFAULT_MAX, now = Date.now } = {}) {
  const map = new Map();

  function get(key) {
    if (!key) return null;
    const hit = map.get(key);
    if (!hit) return null;
    if (now() - hit.at > ttlMs) {
      map.delete(key);
      return null;
    }
    return hit.found;
  }

  function set(key, found) {
    if (!key || !found) return;
    map.delete(key);
    map.set(key, { found, at: now() });
    // Map хранит порядок вставки: первым идёт самый старый.
    while (map.size > max) map.delete(map.keys().next().value);
  }

  return { get, set, size: () => map.size };
}

/** Ключи работы: по workId и по паре «владелец + тема». */
function pinKeys({ workId, ownerKey, topic } = {}) {
  const keys = [];
  if (workId) keys.push(`w:${workId}`);
  const t = String(topic || '').trim().toLowerCase();
  if (ownerKey && t) keys.push(`t:${ownerKey}|${t}`);
  return keys;
}

/**
 * Блок промпта из списка, присланного клиентом.
 *
 * Формат тот же, что у Python (grounding.format_sources_for_prompt),
 * только без фрагмента статьи: полного текста у клиента нет. Поля
 * режем по длине — список пришёл из браузера, и раздувать им запрос
 * к модели нельзя.
 */
function foundFromList(list, { maxItems = 12 } = {}) {
  const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  const sources = (Array.isArray(list) ? list : [])
    .filter((s) => s && typeof s === 'object' && clip(s.title, 400))
    .slice(0, maxItems)
    .map((s) => ({
      title: clip(s.title, 400),
      authors: (Array.isArray(s.authors) ? s.authors : []).slice(0, 6).map((a) => clip(a, 120)),
      year: Number.isInteger(s.year) ? s.year : null,
      venue: clip(s.venue, 200),
      doi: clip(s.doi, 120),
      url: clip(s.url, 400),
      gost: clip(s.gost, 1000),
      footnote: clip(s.footnote, 1000),
    }));
  if (!sources.length) return null;

  const prompt = sources.map((s, i) => {
    const who = s.authors.length ? s.authors.slice(0, 2).join(', ') : 'автор не указан';
    return `[${i + 1}] ${s.title}\n    ${who}, ${s.year || 'год не указан'}`
      + (s.venue ? `, ${s.venue}` : '');
  }).join('\n\n');

  return { count: sources.length, sources, prompt_block: prompt, pinnedFrom: 'client' };
}

module.exports = { createSourcePins, pinKeys, foundFromList };
