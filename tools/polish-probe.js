#!/usr/bin/env node
/**
 * Опыт: можно ли переписывать работу маленькими кусками.
 *
 * Заказчик предложил конвейер: сначала черновик целиком, потом
 * переписывание по 350-500 знаков за раз. У идеи есть сильная
 * сторона и явный риск, и спорить о них бессмысленно — надо мерить.
 *
 * Сильная сторона: на коротком куске стиль держится лучше. Замер по
 * шести прогонам показал, что на целом разделе модель выравнивает
 * ритм к средней длине фразы, как её ни проси.
 *
 * Риск: кусок в 350 знаков — это два-три предложения. Модель не
 * видит, что было до и будет после. Значит возможны разрывы связи
 * («данный подход» — какой?), повторы уже сказанного и потерянные
 * переходы между мыслями.
 *
 * Опыт сравнивает два режима переписи:
 *   вслепую  — кусок переписывается сам по себе;
 *   с окном  — модель видит хвост уже переписанного и начало
 *              следующего куска чернового текста.
 *
 * Запуск:
 *   node tools/polish-probe.js --in черновик.txt --out /tmp/итог
 */

const fs = require('fs');
const { relaunchWithCA } = require('../api/ca.js');
if (relaunchWithCA(__filename)) return;

require('dotenv').config();
const { resolveProviders, modelsFor } = require('../api/providers.js');
const { extractFacts, lostFacts } = require('../api/facts.js');

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}

// Доля исходного объёма, ниже которой кусок считается усохшим.
// Девять десятых: небольшое уплотнение при переписи естественно,
// потеря пятой части — уже недобор по объёму работы.
const KEEP_SHARE = Number(arg('keep', 0.9));
const MIN_PIECE = Number(arg('min', 350));
const MAX_PIECE = Number(arg('max', 500));
const BASE = arg('base', 'http://localhost:8000');
const OWNER = arg('owner', 'bench-style-owner-001');

/**
 * Нарезка на куски по границам предложений.
 *
 * Резать ровно по счётчику знаков нельзя: граница попадёт в середину
 * фразы, и переписывать придётся обрубок. Поэтому набираем целые
 * предложения, пока кусок не дорастёт до нижней границы.
 *
 * Точка в «ст. 15» предложение не кончает — на юридическом тексте
 * это главный источник ложных разрывов.
 */
function splitPieces(text, min = MIN_PIECE, max = MAX_PIECE) {
  const GUARD = '\u0000';
  const abbr = /(?<![А-Яа-яЁёA-Za-z])(ст|стт|п|пп|ч|абз|гл|разд|подп|г|гг|руб|тыс|млн|см|ср|рис|табл|стр|изд|им|др|пр|т|е|д)\./gi;
  const guarded = text
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
    // Фразу не рвём: если кусок уже набрал нижнюю границу, а
    // следующее предложение выводит за верхнюю — закрываем кусок.
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

async function fetchStyle(limit = 3) {
  try {
    const r = await fetch(`${BASE}/api/v1/library/style?limit=${limit}`, {
      headers: { 'X-Owner-Key': OWNER },
    });
    if (!r.ok) return [];
    return (await r.json()).samples || [];
  } catch {
    return [];
  }
}

function styleRules(samples) {
  return 'КАК ПИШЕТ АВТОР, В ЧЬЕЙ МАНЕРЕ НУЖНО ПЕРЕПИСАТЬ\n\n'
    + 'Предложения РАЗНОЙ длины — это главное. Почти каждое третье '
    + 'короткое, пять-восемь слов. Попадаются и длинные, одно из семи. '
    + 'Выравнивать все фразы под одну длину нельзя: ровный текст '
    + 'машинный.\n'
    + 'Канцелярит под запретом: «является», «осуществляется», '
    + '«в целях», «в рамках», «данный» в значении «этот».\n'
    + 'Прямая оценка вместо уклончивости.\n\n'
    + samples.map((s, i) => `ОТРЫВОК ${i + 1}\n${s}`).join('\n\n');
}

/** Один вызов модели без потока: ответ короткий, поток не нужен. */
async function ask(messages) {
  const [provider] = resolveProviders(process.env);
  const models = modelsFor(provider, process.env);
  const res = await provider.stream(models[0], messages, process.env);
  if (!res.ok) throw new Error(`модель ответила ${res.status}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let out = '';
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
        const ev = JSON.parse(raw);
        out += ev.choices?.[0]?.delta?.content || '';
      } catch { /* служебная строка потока */ }
    }
  }
  return out.trim();
}

const TASK = 'Перепиши фрагмент научной работы в манере автора.\n\n'
  + 'ЖЁСТКИЕ ПРАВИЛА:\n'
  + '- Содержание не меняй: ни одного нового факта, ни одной новой '
  + 'ссылки на норму. Ничего не выбрасывай.\n'
  + '- Объём примерно тот же.\n'
  + '- Не добавляй вступлений и выводов, не пиши «итак» и «таким '
  + 'образом» в начале.\n'
  + '- В ответе только переписанный фрагмент, без пояснений.';

// Извлечение и сверка фактуры вынесены в api/facts.js: те же правила
// нужны и сторожу переписи, и сведению вариантов, а держать их
// копиями уже выходило боком — в копии жила ошибка с кириллицей.


async function rewriteBlind(piece, style) {
  return ask([
    { role: 'system', content: style },
    { role: 'user', content: `${TASK}\n\nФРАГМЕНТ:\n${piece}` },
  ]);
}

async function rewriteWithWindow(piece, style, prevDone, nextDraft) {
  let user = TASK;
  if (prevDone) {
    user += '\n\nЧЕМ ЗАКАНЧИВАЕТСЯ УЖЕ ГОТОВЫЙ ТЕКСТ ПЕРЕД ЭТИМ '
      + `ФРАГМЕНТОМ (не переписывай его, он нужен для связности):\n`
      + `«…${prevDone.slice(-400)}»`;
  }
  if (nextDraft) {
    user += '\n\nО ЧЁМ ПОЙДЁТ РЕЧЬ ДАЛЬШЕ (чтобы не забегать вперёд '
      + `и не повторяться):\n«${nextDraft.slice(0, 250)}…»`;
  }
  user += `\n\nФРАГМЕНТ ДЛЯ ПЕРЕПИСИ:\n${piece}`;
  return ask([{ role: 'system', content: style }, { role: 'user', content: user }]);
}

(async () => {
  const inFile = arg('in');
  if (!inFile) {
    console.error('Нужен --in с черновиком');
    process.exit(2);
  }
  const draft = fs.readFileSync(inFile, 'utf8');
  const pieces = splitPieces(draft);
  const style = styleRules(await fetchStyle());

  console.log(`Черновик: ${draft.length} знаков → ${pieces.length} кусков `
    + `(в среднем ${Math.round(draft.length / pieces.length)} знаков)`);

  const out = arg('out', '/tmp/polish');
  const modes = [
    ['blind', 'вслепую'],
    ['window', 'с окном'],
    ['guard', 'с окном и сторожем фактуры'],
  ];

  for (const [id, title] of modes) {
    const t0 = Date.now();
    const done = [];
    let retries = 0;
    let fallbacks = 0;
    let lostTotal = 0;
    let shortfalls = 0;

    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      let text;

      if (id === 'blind') {
        text = await rewriteBlind(piece, style);
      } else {
        text = await rewriteWithWindow(piece, style, done.join(' '),
          pieces[i + 1] || '');
      }

      if (id === 'guard') {
        // Сторож: пропажу ссылки видно сравнением множеств, и это
        // единственный надёжный способ. Просим переписать заново,
        // назвав пропавшее поимённо.
        //
        // Сторож следит за двумя вещами сразу. Первая — фактура.
        // Вторая — объём: замер показал, что перепись молча ужимает
        // кусок на пятую часть, и раздел на 5500 знаков превращается
        // в 4500. Слова «объём примерно тот же» в задании на это не
        // влияют, поэтому недобор ловится счётом знаков.
        let lost = lostFacts(piece, text);
        let short = text.length < piece.length * KEEP_SHARE;

        if (lost.length || short) {
          retries += 1;
          const claims = [];
          if (lost.length) {
            claims.push(`ОБЯЗАТЕЛЬНО сохрани в тексте: ${lost.join(', ')}. `
              + 'В прошлый раз ты это потерял.');
          }
          if (short) {
            claims.push(`Объём: в исходном фрагменте ${piece.length} знаков, `
              + `в твоём прошлом ответе ${text.length}. Нужно не меньше `
              + `${Math.round(piece.length * KEEP_SHARE)} знаков — `
              + 'разверни мысль подробнее, но ничего не придумывай сверх '
              + 'сказанного.');
          }
          const demand = `${TASK}\n\n${claims.join('\n')}`
            + `\n\nФРАГМЕНТ ДЛЯ ПЕРЕПИСИ:\n${piece}`;
          const second = await ask([
            { role: 'system', content: style },
            { role: 'user', content: demand },
          ]);
          // Берём вторую попытку, только если она действительно лучше:
          // бывает, что исправив объём, модель роняет ссылку.
          const secondLost = lostFacts(piece, second);
          if (secondLost.length <= lost.length) {
            text = second;
            lost = secondLost;
            short = text.length < piece.length * KEEP_SHARE;
          }
        }

        if (lost.length) {
          // Фактуру вернуть не удалось — берём черновой кусок.
          // Корявая фраза лучше пропавшей ссылки на закон.
          fallbacks += 1;
          lostTotal += lost.length;
          text = piece;
        } else if (short) {
          // Фактура цела, но кусок усох. Это не повод терять стиль:
          // оставляем переписанное и просто считаем недобор, чтобы
          // добрать объём на уровне всего раздела.
          shortfalls += 1;
        }
      }

      done.push(text);
      process.stdout.write(`\r  ${title}: ${i + 1}/${pieces.length}`);
    }

    const result = done.join('\n\n');
    fs.writeFileSync(`${out}_${id}.txt`, result, 'utf8');
    const lost = lostFacts(draft, result);
    console.log(`\r  ${title}: ${result.length} знаков за `
      + `${Math.round((Date.now() - t0) / 1000)} с`
      + (id === 'guard' ? `; переписей на бис ${retries}, `
        + `откатов к черновику ${fallbacks}, усохших кусков ${shortfalls}` : '')
      + `\n      потеряно фактуры: ${lost.length}`
      + (lost.length ? ` (${lost.join(', ')})` : '')
      + `\n      объём: ${Math.round((result.length / draft.length - 1) * 100)} % `
      + `к черновику`);
  }
})();
