/**
 * Опыт: насколько черновик богаче, когда его пишут по досье.
 *
 * Проверяется главная перестройка конвейера. Раньше раздел писался
 * по метаданным публикаций — автор, название, год, — то есть модель
 * знала, что такая статья есть, но не знала, что в ней написано.
 * Теперь перед разделом из прочитанных целиком статей собирается
 * досье: выдержки по теме раздела, перечень реально упомянутых норм
 * и фамилии учёных.
 *
 * Что меряем:
 *   - объём и плотность содержания;
 *   - сколько ссылок на источники проставлено;
 *   - сколько фамилий названо и сколько из них есть в досье
 *     (остальные выдуманы);
 *   - сколько норм названо и сколько из них подтверждено досье.
 *
 * Запуск:
 *   node tools/dossier-probe.js --owner ключ --heading "Название"
 *     [--topic "Тема работы"] [--out /tmp/dossier_probe]
 */

'use strict';

const fs = require('fs');
const { relaunchWithCA } = require('../api/ca.js');
if (relaunchWithCA(__filename)) return;

require('dotenv').config();
const { PROVIDERS } = require('../api/providers.js');
const { extractFacts } = require('../api/facts.js');
const { dossierBlock } = require('../api/dossier.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PY = process.env.PY_BACKEND_URL || 'http://127.0.0.1:8000';
const MODEL = arg('model', 'GigaChat-3-Ultra');
const OWNER = arg('owner', 'dossier-live-owner-001');
const HEADING = arg('heading', 'Понятие правовой коллизии и её отличие от конкуренции норм');
const TOPIC = arg('topic', 'Коллизии в праве и способы их разрешения');
const OUT = arg('out', '/tmp/dossier_probe');

const RULES = 'Ты пишешь раздел курсовой работы по юриспруденции. '
  + 'Научный язык, сплошной текст без списков и подзаголовков. '
  + 'Объём 5000-5500 знаков без пробелов.';

// Фамилия с инициалами — те же правила, что в Python.
const NAME_RE = /(?<![А-Яа-яЁё])([А-ЯЁ][а-яё]{2,})\s+([А-ЯЁ]\.\s*[А-ЯЁ]\.)|([А-ЯЁ]\.\s*[А-ЯЁ]\.)\s+([А-ЯЁ][а-яё]{2,})/g;

// Звания и обороты, которые выражение принимает за фамилию.
const NOT_SURNAMES = new Set(['профессор', 'доцент', 'академик', 'автор',
  'редакцией', 'москва', 'статья', 'глава', 'пункт', 'часть']);

function surnames(text) {
  const out = new Set();
  for (const m of text.matchAll(NAME_RE)) {
    const s = m[1] || m[4];
    if (!NOT_SURNAMES.has(s.toLowerCase())) out.add(s);
  }
  return out;
}

async function getDossier() {
  const r = await fetch(`${PY}/api/v1/library/research/dossier`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Owner-Key': OWNER },
    body: JSON.stringify({ heading: HEADING, topic: TOPIC }),
  });
  if (!r.ok) throw new Error(`досье не собралось: ${r.status}`);
  return r.json();
}

async function write(messages) {
  const res = await PROVIDERS.gigachat.stream(MODEL, messages, process.env);
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 150)}`);
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

function report(title, text, dossier, seconds) {
  const clean = text.replace(/\s/g, '').length;
  const refs = [...text.matchAll(/\[(\d{1,2})(?:,[^\]]*)?\]/g)].length;

  // Законными считаются и те, кого цитируют внутри статей, и авторы
  // самих статей: сослаться на автора источника — обычное дело.
  // Сравнение по основе фамилии, иначе «Морозова» и «Морозовой»
  // сойдут за разных людей.
  const stem = (s) => s.toLowerCase().replace(/(ой|ым|ом|ых|ами|ого|ему|а|у|е|ы|и)$/, '');
  const known = new Set();
  for (const n of dossier.names || []) known.add(stem(n.split(' ')[0]));
  for (const s of dossier.sources || []) {
    const head = String(s).match(/^([А-ЯЁ][а-яё]+)/);
    if (head) known.add(stem(head[1]));
  }
  const named = surnames(text);
  const invented = [...named].filter((s) => !known.has(stem(s)));

  const facts = [...extractFacts(text)].filter((f) => !/^\d{4}$/.test(f));
  const allowed = new Set(dossier.norms || []);
  const unconfirmed = facts.filter((f) => !allowed.has(f));

  console.log(`\n${title}`);
  console.log(`  объём: ${clean} знаков без пробелов за ${seconds} с`);
  console.log(`  ссылок на источники [N]: ${refs}`);
  console.log(`  фамилий названо: ${named.size}; из них вне досье: `
    + `${invented.length}${invented.length ? ' — ' + invented.join(', ') : ''}`);
  console.log(`  норм названо: ${facts.length}; из них не подтверждено `
    + `досье: ${unconfirmed.length}`
    + `${unconfirmed.length ? ' — ' + unconfirmed.join(', ') : ''}`);
}

(async () => {
  console.log(`Раздел: «${HEADING}»\nМодель: ${MODEL}`);

  const dossier = await getDossier();
  console.log(`\nДосье: ${dossier.excerpts} выдержек, ${dossier.chars} знаков, `
    + `${dossier.sources.length} источников`);
  console.log(`  нормы в источниках: ${(dossier.norms || []).join(', ') || '—'}`);
  console.log(`  учёные в источниках: ${(dossier.names || []).join(', ') || '—'}`);

  // 1. Как было: только метаданные публикаций.
  const list = dossier.sources
    .map((s, i) => `[${i + 1}] ${s}`).join('\n');
  let t0 = Date.now();
  const plain = await write([
    { role: 'system', content: RULES },
    { role: 'system', content: 'ИСТОЧНИКИ ПО ТЕМЕ (ссылайся номером):\n'
      + list },
    { role: 'user', content: `Напиши раздел «${HEADING}» работы на тему «${TOPIC}».` },
  ]);
  const plainSec = Math.round((Date.now() - t0) / 1000);

  // 2. Как стало: выдержки из прочитанных статей.
  t0 = Date.now();
  const rich = await write([
    { role: 'system', content: RULES },
    { role: 'system', content: dossierBlock(dossier) },
    { role: 'user', content: `Напиши раздел «${HEADING}» работы на тему «${TOPIC}».` },
  ]);
  const richSec = Math.round((Date.now() - t0) / 1000);

  report('БЕЗ ДОСЬЕ (только список источников)', plain, dossier, plainSec);
  report('ПО ДОСЬЕ (выдержки из статей)', rich, dossier, richSec);

  fs.writeFileSync(`${OUT}_plain.txt`, plain, 'utf8');
  fs.writeFileSync(`${OUT}_rich.txt`, rich, 'utf8');
  console.log(`\nТексты: ${OUT}_plain.txt, ${OUT}_rich.txt`);
})().catch((e) => { console.error('Сорвалось:', e.message); process.exit(1); });
