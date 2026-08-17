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

// Модель по умолчанию — бесплатная на OpenRouter.
// ВАЖНО: список бесплатных моделей на OpenRouter меняется без предупреждения.
// Если получаешь ошибку "model is unavailable for free" — зайди на
// https://openrouter.ai/models?max_price=0, выбери любую модель с пометкой ":free"
// и впиши её id в переменную OPENROUTER_MODEL (в .env локально, или в Vercel Settings).
// nvidia/nemotron-3-super-120b-a12b:free подтверждена рабочей на практике (20.06.2026) —
// поставлена первой, чтобы не терять время на заведомо недоступную kimi на каждом шаге.
const MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free';

// Если основная модель вдруг станет недоступна, сервер автоматически
// попробует эти по очереди — чтобы сервис не падал из-за того, что
// провайдер снял одну конкретную бесплатную модель.
const FALLBACK_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'deepseek/deepseek-v4-flash:free',
  'google/gemma-4-31b-it:free',
  'moonshotai/kimi-k2.6:free',
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
