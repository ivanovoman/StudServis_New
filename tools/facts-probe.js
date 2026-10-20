/**
 * Опыт: слушается ли модель, когда фактуру ей подают готовой.
 *
 * Замер «сведения вариантов» показал неприятное: три модели GigaChat
 * выдают почти непересекающиеся наборы статей и фамилий (подтверждено
 * двумя моделями 0–6 %). Значит, фактура берётся не из знания, а из
 * воображения, и складывать варианты — значит складывать выдумку.
 *
 * Здесь проверяется обратный ход: дать модели готовый список норм и
 * посмотреть, (а) сколько она из него возьмёт, (б) сколько насочиняет
 * сверх списка.
 */
const { relaunchWithCA } = require('../api/ca.js');
if (relaunchWithCA(__filename)) return;
require('dotenv').config();
const { PROVIDERS } = require('../api/providers.js');

const MODEL = process.env.PROBE_MODEL || 'GigaChat-3-Ultra';
const HEADING = 'Способы разрешения коллизий между нормами права';

// Реальные, проверяемые нормы — то, что в бою пришло бы из базы источников.
const GIVEN = [
  'ч. 4 ст. 15 Конституции РФ — приоритет международного договора',
  'ст. 76 Конституции РФ — соотношение федеральных законов и актов субъектов',
  'ст. 7 ГК РФ — международные договоры в гражданском праве',
  'ст. 3 ГК РФ — приоритет ГК РФ над иными законами гражданского права',
  'ст. 120 Конституции РФ — суд решает дело по закону при противоречии акта',
];
const FACT = /(?:ст|п|ч|абз|гл)\.\s*\d+(?:\.\d+)?|№\s*\d+[-–]?[А-ЯA-Zа-яa-z]*|\b(?:ГК|УК|ТК|КоАП|ГПК|АПК|УПК|НК|СК|ЖК|БК|ЗК)\s*РФ|\b(?:19|20)\d{2}\b/g;
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const factsOf = (t) => [...new Set((t.match(FACT) || []).map(norm))];

async function write(messages) {
  const res = await PROVIDERS.gigachat.stream(MODEL, messages, process.env);
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
  // Ответ приходит потоком SSE, а не одним куском JSON.
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') continue;
      try {
        text += JSON.parse(raw).choices?.[0]?.delta?.content || '';
      } catch { /* служебная строка */ }
    }
  }
  return text;
}

const RULES = 'Пиши раздел курсовой работы по теории права, 2500–3000 знаков. '
  + 'Научный стиль, без воды и без списков — сплошной текст.';

(async () => {
  console.log(`Модель: ${MODEL}\nРаздел: «${HEADING}»\n`);

  // 1. Без подсказки — как сейчас.
  const blind = await write([
    { role: 'system', content: RULES },
    { role: 'user', content: `Напиши раздел «${HEADING}».` },
  ]);

  // 2. С поданной фактурой и прямым запретом добавлять свою.
  const fed = await write([
    { role: 'system', content: RULES },
    { role: 'system', content:
        'Опирайся ТОЛЬКО на нормы из списка ниже. Используй как можно больше '
        + 'из них. Другие статьи, законы, постановления и годы называть '
        + 'ЗАПРЕЩЕНО: если нормы нет в списке — пиши без ссылки.\n\n'
        + GIVEN.map((g, i) => `${i + 1}. ${g}`).join('\n') },
    { role: 'user', content: `Напиши раздел «${HEADING}».` },
  ]);

  // Что из выданного списка реально попало в текст.
  const wanted = GIVEN.map((g) => norm(g.match(/^(?:ч\.\s*\d+\s*)?ст\.\s*\d+/)[0]));
  const used = (t) => wanted.filter((w) => t.includes(w));

  for (const [name, text] of [['без подсказки', blind], ['с поданной фактурой', fed]]) {
    const f = factsOf(text);
    const u = used(text);
    // «Лишнее» — фактура, которой не было в поданном списке.
    const extra = f.filter((x) => !GIVEN.some((g) => g.includes(x)));
    console.log(`${name}: ${text.replace(/\s/g, '').length} зн.`);
    console.log(`   взято из списка: ${u.length} из ${wanted.length}${u.length ? ' — ' + u.join(', ') : ''}`);
    console.log(`   фактуры всего: ${f.length}; вне списка (сочинено): ${extra.length} — ${extra.join(', ').slice(0, 200)}`);
  }

  require('fs').writeFileSync('/tmp/facts_blind.txt', blind);
  require('fs').writeFileSync('/tmp/facts_fed.txt', fed);
})().catch((e) => { console.error('Сорвалось:', e.message); process.exit(1); });
