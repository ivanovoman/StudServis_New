#!/usr/bin/env node
/* scripts/check-models.js
 *
 * Проверяет, живы ли модели из FALLBACK_MODELS и что ещё есть бесплатного
 * на OpenRouter. Список free-моделей там меняется без предупреждения:
 * модель может исчезнуть, начать отдавать 404/429 или внезапно перейти
 * на англоязычный reasoning. Запускать, когда генерация начала сбоить.
 *
 *   node scripts/check-models.js          — проверить текущий список
 *   node scripts/check-models.js --all    — проверить ВСЕ free-модели и
 *                                            предложить замену
 */
require('dotenv').config();

const KEY = process.env.OPENROUTER_API_KEY;
const CHECK_ALL = process.argv.includes('--all');

// Должен совпадать со списком в api/server.js
const CURRENT = [
  'minimax/minimax-m3:free',
  'minimax/minimax-m2.7:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'dots-studio/dots-3-note-preview:free',
  'poolside/laguna-s-2.1:free',
];

const SYS = 'Ты практикующий юрист. Отвечай ТОЛЬКО на русском языке, коротко и по делу.';
const USER = 'Напиши 3 предложения о целях процедуры банкротства. Сошлись на конкретную норму.';

if (!KEY) {
  console.error('Нет OPENROUTER_API_KEY. Пропиши его в .env');
  process.exit(1);
}

async function listFree() {
  const r = await fetch('https://openrouter.ai/api/v1/models');
  const { data } = await r.json();
  return data.map(m => m.id).filter(id => id.endsWith(':free'));
}

/** Доля кириллицы — ловит модели, которые «думают» и отвечают по-английски. */
function cyrillicRatio(text) {
  if (!text) return 0;
  const cyr = (text.match(/[а-яё]/gi) || []).length;
  return cyr / text.length;
}

async function probe(model, attempt = 0) {
  const started = Date.now();
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.PUBLIC_URL || 'http://localhost:3000',
        'X-Title': 'Studservice model check',
      },
      body: JSON.stringify({
        model, max_tokens: 250,
        messages: [{ role: 'system', content: SYS }, { role: 'user', content: USER }],
      }),
      signal: AbortSignal.timeout(120000),
    });
    const d = await r.json();
    const secs = (Date.now() - started) / 1000;

    if (d.error) {
      const code = d.error.code;
      const retry = d.error.metadata?.retry_after_seconds;
      // 429 — общий пул провайдера, а не смерть модели. Пробуем ещё раз.
      if (code === 429 && attempt < 2) {
        await new Promise(res => setTimeout(res, ((retry || 5) + 3) * 1000));
        return probe(model, attempt + 1);
      }
      const raw = d.error.metadata?.raw || d.error.message || '';
      return { model, ok: false, code, note: String(raw).slice(0, 70) };
    }

    const msg = d.choices?.[0]?.message || {};
    const text = (msg.content || '').trim();
    if (!text) return { model, ok: false, code: 'EMPTY', note: 'пустой content' };

    const ru = cyrillicRatio(text);
    if (ru < 0.6) {
      return { model, ok: false, code: 'NOT_RU', note: `кириллица ${ru.toFixed(2)} — отвечает не по-русски` };
    }
    return { model, ok: true, secs, ru, sample: text.replace(/\s+/g, ' ').slice(0, 90) };
  } catch (e) {
    if (attempt < 2) {
      await new Promise(res => setTimeout(res, 8000));
      return probe(model, attempt + 1);
    }
    return { model, ok: false, code: 'EXC', note: String(e.message).slice(0, 60) };
  }
}

/** Ограниченный параллелизм — иначе сами себе устроим 429. */
async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) out[i] = await fn(items[i++]);
  }));
  return out;
}

(async () => {
  const free = await listFree();
  console.log(`На OpenRouter сейчас ${free.length} бесплатных моделей.\n`);

  const missing = CURRENT.filter(m => !free.includes(m));
  if (missing.length) {
    console.log('ИСЧЕЗЛИ ИЗ КАТАЛОГА (id больше не существует):');
    missing.forEach(m => console.log('   ' + m));
    console.log();
  }

  const targets = CHECK_ALL ? free : CURRENT;
  console.log(`Проверяю ${targets.length} моделей реальным запросом на русском...\n`);
  const results = await mapLimit(targets, 3, probe);

  const ok = results.filter(r => r.ok).sort((a, b) => a.secs - b.secs);
  const bad = results.filter(r => !r.ok);

  console.log('='.repeat(72));
  console.log(`РАБОТАЮТ И ОТВЕЧАЮТ ПО-РУССКИ: ${ok.length}`);
  console.log('='.repeat(72));
  ok.forEach(r => {
    console.log(`${r.secs.toFixed(1).padStart(6)}s  ru=${r.ru.toFixed(2)}  ${r.model}`);
    console.log(`         ${r.sample}`);
  });

  if (bad.length) {
    console.log('\n' + '='.repeat(72));
    console.log('НЕ ГОДЯТСЯ');
    console.log('='.repeat(72));
    bad.forEach(r => console.log(`  ${String(r.code).padEnd(8)} ${r.model} — ${r.note}`));
  }

  const brokenCurrent = CURRENT.filter(m => bad.some(b => b.model === m));
  if (brokenCurrent.length) {
    console.log('\nВ рабочем списке сломано: ' + brokenCurrent.length + ' из ' + CURRENT.length);
    if (CHECK_ALL) {
      const replacements = ok.filter(r => !CURRENT.includes(r.model)).slice(0, 5);
      if (replacements.length) {
        console.log('Кандидаты на замену (вставить в FALLBACK_MODELS в api/server.js):');
        replacements.forEach(r => console.log(`  '${r.model}',`));
      }
    } else {
      console.log('Запусти с --all, чтобы найти замену среди всех free-моделей.');
    }
    process.exitCode = 1;
  } else {
    console.log('\nВсе модели рабочего списка живы.');
  }
})();
