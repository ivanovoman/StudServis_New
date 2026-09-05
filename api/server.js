// api/server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const { STEP_PROMPTS } = require('./prompts');
const { generateFragmentDocx, generateFullDocx } = require('./docxExport');
const { resolveProviders, modelsFor } = require('./providers');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Запросы /api/v1/* обслуживает Python-бэкенд (FastAPI): загрузка
// источников и методички, анализ темы с опорой на публикации,
// детектор ИИ. Node остаётся раздатчиком статики и старого
// /api/generate, а браузеру не приходится знать про второй порт.
//
// express.json выше уже прочитал тело для JSON-запросов, поэтому
// пересылаем либо разобранный объект, либо сырой поток (multipart
// с файлами читать нельзя — он пойдёт как есть).
const PY_BACKEND = process.env.PY_BACKEND_URL || 'http://127.0.0.1:8000';

app.use('/api/v1', async (req, res) => {
  const target = PY_BACKEND + '/api/v1' + req.url;
  const headers = {};
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];

  const isJson = req.is('application/json');
  const init = { method: req.method, headers };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (isJson) {
      init.body = JSON.stringify(req.body || {});
    } else {
      // multipart и прочее — пересылаем поток как есть
      init.body = req;
      init.duplex = 'half';
    }
  }

  try {
    const upstream = await fetch(target, init);
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.set('content-type', ct);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(502).json({
      error: 'Python-бэкенд недоступен: ' + e.message +
             '. Запустите его: cd backend && uvicorn app.main:app --port 8000',
    });
  }
});

// Модель по умолчанию — бесплатная на OpenRouter.
// ВАЖНО: список бесплатных моделей на OpenRouter меняется без предупреждения.
// Список ниже ПРОВЕРЕН вживую 01.09.2026 реальными запросами на русском языке.
//
// Порядок подобран по результатам теста (русский юридический текст, 250-300 слов):
//   1. minimax/minimax-m3        — лучший баланс: русский 0.84-0.88, живой ритм
//                                   (разброс длин предложений 12.3 — самый человечный),
//                                   ссылки на нормы и практику, 4.4 с.
//   2. minimax/minimax-m2.7      — тот же вендор, чуть медленнее (8.6 с), стабильный русский.
//   3. nvidia/nemotron-3-ultra   — русский стабильный, много ссылок на нормы,
//                                   но ритм ровнее (разброс 6.0) — текст суше.
//   4. dots-studio/dots-3-note   — русский хороший, но склонен к клише и к тому,
//                                   чтобы выдавать "Вариант 1 / Вариант 2" вместо текста.
//   5. poolside/laguna-s-2.1     — качественный русский, но нестабильная доступность (2 из 3).
//
// ОСОЗНАННО ИСКЛЮЧЕНЫ (не добавлять обратно без повторной проверки):
//   nvidia/nemotron-3-super-120b-a12b:free — БЫЛА ПЕРВОЙ В СПИСКЕ, но сейчас отдаёт
//       404 от провайдера Nvidia, а когда отвечает — думает и пишет по-АНГЛИЙСКИ
//       ("We need to produce 4 sentences...", доля кириллицы 0.10). Для русской курсовой непригодна.
//   deepseek/deepseek-v4-flash:free  — такой модели на OpenRouter НЕ СУЩЕСТВУЕТ (id выдуман).
//   moonshotai/kimi-k2.6:free        — такой модели на OpenRouter НЕ СУЩЕСТВУЕТ (id выдуман).
//   google/gemma-4-31b-it:free       — существует, но стабильно отдаёт 429 (общий пул исчерпан).
//   nvidia/nemotron-3.5-lightning / ling-3.0-flash-fin — отвечают англоязычным reasoning.
//   nvidia/nemotron-3.5-content-safety — это модерационная модель, а не генеративная.
//   cohere/north-mini-code — код-модель; на прозу даёт нестабильный результат.
//
// Проверить актуальность списка: node scripts/check-models.js
// Список моделей и адреса эндпоинтов переехали в api/providers.js,
// чтобы сервис не зависел от одного поставщика.

/**
 * Собирает сообщения для запроса к модели.
 * history — массив { role, content } из предыдущих шагов диалога (контекст).
 */
function buildMessages(step, userInput, history = []) {
  const systemPrompt = STEP_PROMPTS[step];
  if (!systemPrompt) {
    throw new Error(`Неизвестный шаг протокола: ${step}`);
  }

  const messages = [{ role: 'system', content: systemPrompt }];

  // Добавляем контекст предыдущих шагов (например, план нужен на этапе написания введения)
  for (const turn of history) {
    messages.push({ role: turn.role, content: turn.content });
  }

  messages.push({ role: 'user', content: userInput });
  return messages;
}

/**
 * Пытается выполнить запрос к OpenRouter, перебирая модели из списка,
 * пока одна из них не ответит успешно (статус 200 + поток данных).
 * Это защищает сервис от ситуации, когда конкретная бесплатная модель
 * внезапно становится недоступна (что на OpenRouter случается часто).
 */
async function callOpenRouterWithFallback(messages) {
  const providers = resolveProviders(process.env);

  if (providers.length === 0) {
    throw new Error(
      'Не настроен ни один поставщик моделей. Откройте .env и задайте '
      + 'ключ: OPENROUTER_API_KEY, либо GIGACHAT_AUTH_KEY, либо '
      + 'CUSTOM_API_URL. Подробнее — docs/LLM_PROVIDERS.md'
    );
  }

  // Копим по одной последней ошибке на поставщика. Если не выйдет
  // совсем ничего, пользователь должен увидеть причину по каждому,
  // а не только по тому, кого пробовали последним: иначе при связке
  // «GigaChat + запасной OpenRouter» настоящая проблема с GigaChat
  // остаётся невидимой.
  const errors = new Map();
  let fatal = false;

  // Бесплатные модели упираются в общий пул пачками: бывает, что все
  // подряд отдают 429, а через пару секунд отвечают нормально.
  // Поэтому после полного круга ждём и пробуем ещё раз.
  const ROUNDS = 2;
  const PAUSE_MS = 2500;

  for (let round = 0; round < ROUNDS && !fatal; round++) {
    if (round > 0) {
      await new Promise(r => setTimeout(r, PAUSE_MS));
    }

    for (const provider of providers) {
      const models = modelsFor(provider, process.env);

      for (const model of models) {
        try {
          const upstream = await provider.stream(model, messages, process.env);

          if (upstream.ok && upstream.body) {
            return { upstream, usedModel: `${provider.title} · ${model}` };
          }

          const errText = await upstream.text().catch(() => '');
          errors.set(provider.title,
            `${model} — ${upstream.status} ${shortError(errText)}`);

          // 401/403 — проблема с ключом этого поставщика, перебирать
          // его модели дальше бессмысленно. Но у следующего поставщика
          // ключ может быть в порядке, поэтому выходим только из
          // цикла моделей.
          if (upstream.status === 401 || upstream.status === 403) {
            errors.set(provider.title,
              `ключ отклонён (${upstream.status} ${shortError(errText)})`);
            break;
          }
          // Всё остальное (404 модель убрали, 400 битый id, 429 упёрлись
          // в лимит, 5xx сбой у провайдера) — повод взять следующую.
        } catch (err) {
          errors.set(provider.title, `${model} — ${err.message}`);
        }
      }
    }
  }

  const report = [...errors.entries()]
    .map(([title, msg]) => `${title}: ${msg}`)
    .join('; ');
  throw new Error(
    (report || 'все модели недоступны')
    + '. Если ключ отклонён — перевыпустите его; если исчерпан лимит — '
    + 'подключите второго поставщика (docs/LLM_PROVIDERS.md)'
  );
}

/** Достаёт человекочитаемое сообщение из ответа-ошибки провайдера. */
function shortError(text) {
  try {
    const j = JSON.parse(text);
    const msg = j.error?.message || j.message || j.error;
    if (msg) return String(msg).slice(0, 160);
  } catch { /* не JSON — вернём как есть */ }
  return String(text).replace(/\s+/g, ' ').slice(0, 160);
}


app.post('/api/generate', async (req, res) => {
  const { step, input, history } = req.body;

  if (resolveProviders(process.env).length === 0) {
    return res.status(500).json({
      error: 'Не настроен ни один поставщик моделей. Задайте в .env '
           + 'OPENROUTER_API_KEY, GIGACHAT_AUTH_KEY или CUSTOM_API_URL. '
           + 'Подробнее — docs/LLM_PROVIDERS.md',
    });
  }

  if (!step || !input) {
    return res.status(400).json({ error: 'Нужны поля step и input' });
  }

  let messages;
  try {
    messages = buildMessages(step, input, history || []);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Настраиваем SSE-заголовки для стриминга в браузер
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const { upstream, usedModel } = await callOpenRouterWithFallback(messages);
    console.log(`Отвечает: ${usedModel}`);

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // Считаем, пришёл ли хоть один кусок текста. Бывает, что модель
    // отвечает 200, но поток пустой: она ушла в reasoning и не выдала
    // ни одного content-токена. Раньше это выглядело как «нажал и
    // ничего не произошло» — хуже явной ошибки.
    let sentAny = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // последняя строка может быть неполной

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          res.write('data: [DONE]\n\n');
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          // Часть моделей кладёт текст в reasoning_content, а не в
          // content — забираем оба варианта.
          const delta = choice?.delta?.content
            || choice?.delta?.reasoning_content
            || '';
          if (delta) {
            sentAny = true;
            // Пробрасываем кусочек текста клиенту как есть
            res.write(`data: ${JSON.stringify({ delta })}\n\n`);
          }
        } catch {
          // Пропускаем строки, которые не являются валидным JSON (keep-alive комментарии и т.п.)
        }
      }
    }

    if (!sentAny) {
      res.write(`data: ${JSON.stringify({
        error: `модель ${usedModel} вернула пустой ответ. `
             + 'Нажмите «Выполнить» ещё раз — запрос уйдёт на другую модель.',
      })}\n\n`);
    }

    res.end();
  } catch (err) {
    console.error('Generate error:', err);
    res.write(`data: ${JSON.stringify({ error: 'Внутренняя ошибка сервера: ' + err.message })}\n\n`);
    res.end();
  }
});

app.get('/api/health', (req, res) => {
  // Показываем, какие поставщики реально настроены — это первое,
  // что нужно знать, когда генерация перестала работать.
  const providers = resolveProviders(process.env).map(p => ({
    id: p.id,
    title: p.title,
    models: modelsFor(p, process.env),
  }));
  res.json({
    ok: providers.length > 0,
    providers,
    hint: providers.length ? undefined
      : 'Не настроен ни один поставщик. См. .env.example и docs/LLM_PROVIDERS.md',
  });
});

// Скачивание текста с ЛЮБОГО шага протокола как .docx — план, введение,
// план раздела, текст раздела, заключение и т.д. Используется на каждом
// экране, где появляется кнопка "Скачать .docx".
app.post('/api/export-docx', async (req, res) => {
  try {
    const {
      title, text, tableMarkdown, isH1,
      chapterHeading, tableNumber, tableTitle, referenceSentence,
    } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'Нет текста для экспорта' });
    }

    const buffer = await generateFragmentDocx({
      title, text, tableMarkdown, isH1,
      chapterHeading, tableNumber, tableTitle, referenceSentence,
    });
    const filename = (title || 'Документ').slice(0, 60).replace(/[\\/:*?"<>|]/g, '_');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}.docx"`);
    res.send(buffer);
  } catch (err) {
    console.error('Export fragment docx error:', err);
    res.status(500).json({ error: 'Не удалось собрать файл: ' + err.message });
  }
});

// Скачивание всей работы целиком как .docx — тема, введение, все разделы
// с таблицами, заключение.
app.post('/api/export-docx-full', async (req, res) => {
  try {
    const { topic, introduction, sections, conclusion, chapterTitles, sectionTitles } = req.body;
    if (!topic) {
      return res.status(400).json({ error: 'Нет темы работы для экспорта' });
    }

    const buffer = await generateFullDocx({ topic, introduction, sections, conclusion, chapterTitles, sectionTitles });
    const filename = String(topic).slice(0, 60).replace(/[\\/:*?"<>|]/g, '_');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}.docx"`);
    res.send(buffer);
  } catch (err) {
    console.error('Export full docx error:', err);
    res.status(500).json({ error: 'Не удалось собрать файл: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Студсервис запущен на http://localhost:${PORT}`));
}

module.exports = app;
