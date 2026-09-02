// api/server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const { STEP_PROMPTS } = require('./prompts');
const { generateFragmentDocx, generateFullDocx } = require('./docxExport');

const app = express();
const key = process.env.OPENROUTER_API_KEY;
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
const MODEL = process.env.OPENROUTER_MODEL || 'minimax/minimax-m3:free';

// Если основная модель недоступна, сервер перебирает эти по очереди.
const FALLBACK_MODELS = [
  'minimax/minimax-m3:free',
  'minimax/minimax-m2.7:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'dots-studio/dots-3-note-preview:free',
  'poolside/laguna-s-2.1:free',
];

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

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
  const modelsToTry = [MODEL, ...FALLBACK_MODELS.filter(m => m !== MODEL)];
  let lastError = null;

  for (const model of modelsToTry) {
    try {
      const upstream = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': process.env.PUBLIC_URL || 'http://localhost:3000',
          'X-Title': 'Studservice',
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
        }),
      });

      if (upstream.ok && upstream.body) {
        return { upstream, usedModel: model };
      }

      const errText = await upstream.text().catch(() => '');
      lastError = `(${upstream.status}) модель ${model}: ${errText.slice(0, 200)}`;
      // Если это не ошибка "модель недоступна", нет смысла пробовать другие модели —
      // вероятно, проблема в ключе или запросе, а не в конкретной модели.
      if (upstream.status !== 404 && upstream.status !== 400) {
        break;
      }
    } catch (err) {
      lastError = `модель ${model}: ${err.message}`;
    }
  }

  throw new Error(lastError || 'Все модели недоступны');
}


app.post('/api/generate', async (req, res) => {
  const { step, input, history } = req.body;

  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'OPENROUTER_API_KEY не настроен на сервере' });
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
    if (usedModel !== MODEL) {
      console.log(`Основная модель недоступна, использована резервная: ${usedModel}`);
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            // Пробрасываем кусочек текста клиенту как есть
            res.write(`data: ${JSON.stringify({ delta })}\n\n`);
          }
        } catch {
          // Пропускаем строки, которые не являются валидным JSON (keep-alive комментарии и т.п.)
        }
      }
    }

    res.end();
  } catch (err) {
    console.error('Generate error:', err);
    res.write(`data: ${JSON.stringify({ error: 'Внутренняя ошибка сервера: ' + err.message })}\n\n`);
    res.end();
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, model: MODEL, hasKey: Boolean(process.env.OPENROUTER_API_KEY) });
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
