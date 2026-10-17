#!/usr/bin/env node
/**
 * Какие признаки отличают окна, помеченные Антиплагиат.ВУЗ как ИИ.
 *
 *   node research/antiplagiat/features.js incoming/ap_blocks.json
 *
 * Текст каждой работы режется на окна ~1000 знаков по границам
 * предложений (так размечает сам Антиплагиат); метка окна — большинство
 * его знаков. Оглавления и списки литературы отбрасываются. Для каждого
 * признака — AUC (0,5 — не различает; >0,5 — выше в ИИ-окнах).
 */
const fs = require('fs');
const path = require('path');
const { findColloquial } = require('../../api/register');
const det = require('../../backend/app/modules/humanizer/vendor/detector_engine.js');

const B = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const WIN = Number(process.env.WIN) || 1000;

const sents = (t) => t.split(/(?<=[.!?…])\s+(?=[«"(А-ЯЁA-Z0-9])/).filter((s) => s.trim());
const words = (t) => t.toLowerCase().match(/[а-яёa-z]+/g) || [];

// Окна: по работам, каждое предложение несёт долю ИИ-знаков.
function windows() {
  const out = [];
  for (const [doc, blocks] of Object.entries(B)) {
    const ss = [];
    for (const b of blocks) for (const s of sents(b.text)) ss.push({ s, ai: b.ai });
    let cur = [];
    let len = 0;
    const flush = () => {
      if (!cur.length) return;
      const text = cur.map((x) => x.s).join(' ');
      const aiChars = cur.filter((x) => x.ai).reduce((n, x) => n + x.s.length, 0);
      out.push({ doc, text, ai: aiChars / text.length > 0.5, aiShare: aiChars / text.length });
      cur = []; len = 0;
    };
    for (const x of ss) {
      cur.push(x); len += x.s.length + 1;
      if (len >= WIN) flush();
    }
    flush();
  }
  // Оглавления, списки литературы, титулы.
  return out.filter((w) => w.text.length > 500
    && !/\.{6,}|URL|дата обращения|— \d+ с\.|ISBN|СОДЕРЖАНИЕ|ОГЛАВЛЕНИЕ/.test(w.text));
}

const REF = /№\s?[А-ЯA-Z0-9]|\d{1,2}\.\d{2}\.\d{4}|от \d{1,2} [а-я]+ \d{4}|дел[уоа] № |ст\. \d|стать[еийя] \d|ч\. \d|п\. \d|\d{4} г/;
const GENERIC = /(^|\s)(Суды|Арбитражные суды|Судебная практика|Суд) (указыва|исход|часто|нередко|обычно|выработал|встают|признают|сходятся)|Суды указывают|практика (округов|уже|показывает)|Практика показывает/;
const SCEN = /Представьте|компани[яи] [АБ]\b|В итоге|Например, компания|Если у компании|Типичная ситуация|Классический пример|Типичный (пример|кейс)/;
const META = /логично перейти|Критическим моментом|стоит упомянуть|Однако и здесь|ключевым навыком|Мы перешли|Таким образом|Подводя итог|В заключение|Итак,|рассмотрим далее|перейдем к/;
const KANC = /(?<![а-яё])(является|являются|осуществля[а-яё]*|в рамках|позволя[а-яё]*|обеспечива[а-яё]*|играет (важную|ключевую) роль|ключев[а-яё]*|данн(ый|ая|ое|ые|ого|ой))(?![а-яё])/gi;
const CONN = /^(Однако|При этом|Кроме того|Более того|Таким образом|Вместе с тем|Также|Помимо этого|В свою очередь|Следовательно|Поэтому|Тем не менее|Наконец|Во-первых|Во-вторых)[ ,]/;

function feats(t) {
  const ss = sents(t);
  const L = ss.map((s) => words(s).length).filter((n) => n > 0);
  const m = L.reduce((a, b) => a + b, 0) / L.length;
  const sd = Math.sqrt(L.reduce((a, b) => a + (b - m) ** 2, 0) / L.length);
  const per = (n) => (n / t.length) * 1000;
  const r = det.formula(det.compute(t), det.detectGenre(t));
  return {
    'ваш детектор pAI': r.pAI,
    'ссылки/нормы на предл.': ss.filter((s) => REF.test(s)).length / ss.length,
    'цифр на 1000 зн.': per((t.match(/\d/g) || []).length),
    'суды без ссылки': ss.filter((s) => GENERIC.test(s) && !REF.test(s)).length,
    'сценарий-пример': ss.filter((s) => SCEN.test(s)).length,
    'служебные фразы': ss.filter((s) => META.test(s)).length,
    'разговорность (сторож)': per(findColloquial(t).length),
    'канцелярит на 1000': per((t.match(KANC) || []).length),
    'средн. длина предл.': m,
    'разброс длины (CV)': sd / m,
    'доля коротких (≤8 сл.)': L.filter((n) => n <= 8).length / L.length,
    'связка в начале предл.': ss.filter((s) => CONN.test(s)).length / ss.length,
    'предл. начинается с «Это»': ss.filter((s) => /^Это[ ,]/.test(s)).length / ss.length,
    'средн. длина слова': words(t).reduce((a, w) => a + w.length, 0) / Math.max(1, words(t).length),
    'разнообразие слов (TTR)': new Set(words(t)).size / Math.max(1, words(t).length),
    '«который» на 1000': per((t.match(/(?<![а-яё])котор[а-яё]+/gi) || []).length),
    'вопросы на 1000': per((t.match(/\?/g) || []).length),
    'тире на 1000': per((t.match(/ [–—] /g) || []).length),
    'двоеточия на 1000': per((t.match(/:/g) || []).length),
    'кавычки « на 1000': per((t.match(/«/g) || []).length),
    'скобки на 1000': per((t.match(/\(/g) || []).length),
    'сноски [N]/цифра-сноска': per((t.match(/\[\d+[^\]]*\]|[а-я»]\d{1,2}(?=[\s.,])/g) || []).length),
  };
}

function auc(pos, neg) {
  let s = 0;
  for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

const W = windows().map((w) => ({ ...w, f: feats(w.text) }));
const pos = W.filter((w) => w.ai);
const neg = W.filter((w) => !w.ai);
console.log(`Окон: ${W.length} (ИИ ${pos.length}, не ИИ ${neg.length}), работ ${new Set(W.map((w) => w.doc)).size}\n`);
const names = Object.keys(W[0].f);
// AUC внутри работ: сравниваем окна только одной работы (тема и автор
// одинаковы), пары складываем по всем работам.
function aucWithin(n) {
  let s = 0; let k = 0;
  for (const d of new Set(W.map((w) => w.doc))) {
    const p = W.filter((w) => w.doc === d && w.ai).map((w) => w.f[n]);
    const q = W.filter((w) => w.doc === d && !w.ai).map((w) => w.f[n]);
    for (const x of p) for (const y of q) { s += x > y ? 1 : x === y ? 0.5 : 0; k += 1; }
  }
  return k ? s / k : 0.5;
}
const rows = names.map((n) => {
  const a = auc(pos.map((w) => w.f[n]), neg.map((w) => w.f[n]));
  const aw = aucWithin(n);
  const mean = (arr) => arr.reduce((x, w) => x + w.f[n], 0) / arr.length;
  return { признак: n, 'AUC внутри работ': +aw.toFixed(2), 'AUC общий': +a.toFixed(2), 'среднее ИИ': +mean(pos).toFixed(2), 'среднее не ИИ': +mean(neg).toFixed(2) };
}).sort((a, b) => Math.abs(b['AUC внутри работ'] - 0.5) - Math.abs(a['AUC внутри работ'] - 0.5));
console.table(rows);

// По работам: доля ИИ-окон и та же статистика по ключевым признакам.
const docs = [...new Set(W.map((w) => w.doc))];
console.table(docs.map((d) => {
  const ws = W.filter((w) => w.doc === d);
  return { работа: d, окон: ws.length, 'ИИ-окон': ws.filter((w) => w.ai).length };
}));
if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify(W, null, 1));
