#!/usr/bin/env node
/**
 * Разбор пометок внешнего ИИ-детектора на курсовой о ЕНС (скриншоты заказчика).
 * H1–H6 — фрагменты, отмеченные розовым; N1–N6 — соседние без пометок.
 *
 *   node research/ens_detect/compare.js
 *
 * 1) Детектор заказчика (vendor/detector_engine.js) пометки не повторяет:
 *    среднее pAI 0,63 (H) против 0,61 (N).
 * 2) Ручные признаки шаблонности разделяют выборку: суды без реквизитов,
 *    выдуманные сценарии («компания А/Б», «Представьте»), служебные фразы.
 *    Признаки подобраны ПОСЛЕ просмотра H — это гипотеза, 12 фрагментов мало.
 */
const path = require('path');
const d = require('../../backend/app/modules/humanizer/vendor/detector_engine.js');
const F = require(path.join(__dirname, 'frags.json'));

const sents = (t) => t.split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z«])/);
const REF = /№\s?[А-ЯA-Z0-9]|\d{1,2}\.\d{2}\.\d{4}|от \d{1,2} [а-я]+ \d{4}|дел[уоа] № |ст\. \d|стать[еи] \d|\d{4} год/;
const GENERIC = /^(Суды|Арбитражные суды|Судебная практика|Суд )|Суды указывают|суды (часто|нередко|обычно)|практика (округов|уже)/;
const SCEN = /Представьте|компания [АБ]\b|В итоге|Например, компания|Если у компании|компания (не может|направляет|добросовестно)/;
const META = /логично перейти|Критическим моментом|стоит упомянуть|Однако и здесь|ключевым навыком|Мы перешли/;

const rows = Object.entries(F).map(([k, t]) => {
  const r = d.formula(d.compute(t), d.detectGenre(t));
  const ss = sents(t);
  return {
    фрагмент: k,
    pAI: +r.pAI.toFixed(3),
    ссылок: ss.filter((s) => REF.test(s)).length,
    суды_без_ссылки: ss.filter((s) => GENERIC.test(s) && !REF.test(s)).length,
    сценарий: ss.filter((s) => SCEN.test(s)).length,
    служебные: ss.filter((s) => META.test(s)).length,
  };
});
console.table(rows);
