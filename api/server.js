// api/server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const { STEP_PROMPTS, applyChapters } = require('./prompts');
const { parseOutline, buildQueue } = require('./outline');
const { fixHybrids } = require('./textfix');
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
  // Ключ владельца обязан дойти до бэкенда: без него хранилище отвечает
  // 400, и «Мои работы» выглядят сломанными, хотя браузер ключ прислал.
  if (req.headers['x-owner-key']) headers['x-owner-key'] = req.headers['x-owner-key'];

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
/**
 * Собирает требования пользователя в текст для модели.
 *
 * Настройки заполняются в окне «Настройки работы», но до сих пор
 * никуда не отправлялись: в /api/generate уходили только шаг и текст.
 * Пользователь заполнял вуз, методичку и пожелания, а генерация о них
 * не знала - самая обидная разновидность поломки, потому что внешне
 * всё работает.
 */
function buildBrief(s = {}) {
  const parts = [];

  if (s.topic) parts.push(`Тема работы: ${s.topic}`);
  if (s.university) parts.push(`Учебное заведение: ${s.university}`);

  if (s.chapters === 2 || s.chapters === 3) {
    parts.push(`Число глав: ${s.chapters} (задано пользователем).`);
  }

  if (s.methodichka) {
    // Методичка может быть длинной; в промпт идёт начало, где обычно
    // и стоят требования к структуре и объёму.
    const m = String(s.methodichka).slice(0, 4000);
    parts.push(`Требования методички вуза (выполнять в первую очередь):\n${m}`);
  }

  if (s.wishes) {
    parts.push(`Пожелания заказчика:\n${s.wishes}`);
  }

  if (!parts.length) return '';

  return 'НАСТРОЙКИ РАБОТЫ, заданные пользователем.\n\n'
    + parts.join('\n\n')
    + '\n\nПри расхождении между этими требованиями и общими правилами '
    + 'выше\nприоритет у методички и пожеланий: их задал заказчик.';
}

function buildMessages(step, userInput, history = [], settings = {}) {
  const raw = STEP_PROMPTS[step];
  if (!raw) {
    throw new Error(`Неизвестный шаг протокола: ${step}`);
  }

  // Число глав приходит из настроек работы. Если не задано, модель
  // выбирает сама между двумя и тремя - фиксировать тройку нельзя,
  // курсовая бывает и двухглавой.
  const systemPrompt = applyChapters(raw, settings.chapters);

  const messages = [{ role: 'system', content: systemPrompt }];

  // Настройки работы - отдельным системным сообщением, чтобы модель
  // считала их требованиями заказчика, а не частью текста задания.
  const brief = buildBrief(settings);
  if (brief) messages.push({ role: 'system', content: brief });

  // Добавляем контекст предыдущих шагов (например, план нужен на этапе написания введения)
  for (const turn of history) {
    messages.push({ role: turn.role, content: turn.content });
  }

  messages.push({ role: 'user', content: userInput });
  return messages;
}

//: Шаги, которые опираются на реальные публикации. Анализ темы —
//: фундамент: всё, что он напутает в нормах и делах, разойдётся по
//: плану, введению и разделам.
const GROUNDED_STEPS = new Set(['analysis']);
/**
 * Сверить ссылки на статьи кодексов с оглавлениями первоисточников.
 *
 * Возвращает готовый текст справки либо null, если проверять нечего
 * или правовые базы недоступны. Молчание здесь лучше ложной тревоги:
 * «не удалось проверить» ничего не говорит пользователю о качестве
 * текста, а место на экране занимает.
 */
async function verifyLegalRefs(text) {
  const base = process.env.PY_BACKEND_URL || 'http://127.0.0.1:8000';

  try {
    const r = await fetch(`${base}/api/v1/sources/verify-legal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) return null;

    const data = await r.json();
    if (!data.checked) return null;

    return data;
  } catch {
    // Бэкенд не поднят или базы не отвечают. Текст уже отдан
    // пользователю, ломать выдачу из-за справки нельзя.
    return null;
  }
}


// Шаги, после которых сверяем ссылки на статьи кодексов с
// первоисточником. План и введение модель пишет по памяти, и номера
// статей там регулярно не те: разбор одного плана дал ссылку на ст. 4
// ТК РФ как на коллизионную норму, хотя это запрещение принудительного
// труда. Причём «проверить» модель пометила совсем другие места.
const VERIFIED_STEPS = new Set(['plan', 'introduction', 'section_write']);

/**
 * Запрашивает у Python-бэкенда реальные публикации по теме.
 *
 * Зачем: без источников модель воспроизводит реквизиты по памяти и
 * уверенно ошибается — приписывает статье чужой предмет, путает акт,
 * в котором норма находится. Причём ошибается именно там, где не
 * сомневается, так что пометки «нужно проверить» её не ловят.
 *
 * Возвращает null, если источников нет или бэкенд недоступен: анализ
 * без опоры всё равно полезнее пустого экрана, просто он честно
 * помечается как основанный на памяти модели.
 */
async function fetchSources(topic) {
  const base = process.env.PY_BACKEND_URL || 'http://127.0.0.1:8000';
  const timeout = Number(process.env.SOURCES_TIMEOUT_MS || 45000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const r = await fetch(`${base}/api/v1/sources/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, limit: 6 }),
      signal: controller.signal,
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.count > 0 ? data : null;
  } catch (err) {
    // Внешние базы иногда молчат. Это не повод ронять генерацию.
    console.warn('Поиск источников не удался:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Врезает найденные публикации в запрос отдельным системным
 * сообщением — перед пользовательским, чтобы модель считала их
 * материалом, а не частью задания.
 */
function sourcesBlock(sourcesData) {
  if (!sourcesData) return '';

  return 'МАТЕРИАЛЫ ДЛЯ ОПОРЫ — реальные публикации, найденные '
    + 'по теме.\n\n'
    + sourcesData.prompt_block
    + '\n\nКАК ИМИ ПОЛЬЗОВАТЬСЯ:\n'
    + '- Это единственные источники, которые ты можешь считать '
    + 'проверенными. Опирайся в первую очередь на них.\n'
    + '- Ссылаясь на материал, указывай его номер в квадратных '
    + 'скобках: [1], [3].\n'
    + '- Реквизиты, которых в материалах нет (номера дел, статей, '
    + 'постановлений), по-прежнему помечай как [нужно проверить: ...]. '
    + 'Наличие материалов не разрешает воспроизводить остальное по '
    + 'памяти.\n'
    + '- Если материалы теме не отвечают, так и напиши, а не '
    + 'подгоняй тезисы под них.\n'
    + '- Ссылка обязательна там, где ты излагаешь чужую позицию, '
    + 'приводишь определение или статистику. Своё рассуждение '
    + 'помечать не нужно.\n'
    + '- Если ссылаешься на конкретное место в статье, указывай '
    + 'страницу: [2, с. 205]. Номер страницы бери только из самого '
    + 'материала, не придумывай.';
}

/**
 * Врезает найденные публикации отдельным системным сообщением — перед
 * пользовательским, чтобы модель считала их материалом, а не частью
 * задания.
 */
function withSources(messages, sourcesData) {
  const block = sourcesBlock(sourcesData);
  if (!block) return messages;
  return [messages[0], { role: 'system', content: block },
          ...messages.slice(1)];
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
            // Если до этого кто-то отказал, это надо видеть. Иначе
            // подключаешь GigaChat, он молча падает, отвечает запасной
            // OpenRouter — и выглядит так, будто всё работает.
            if (errors.size) {
              for (const [title, msg] of errors) {
                console.warn(`  ! ${title}: ${msg}`);
              }
            }
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
  const { step, input, history, settings } = req.body;

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
    messages = buildMessages(step, input, history || [], settings || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Настраиваем SSE-заголовки для стриминга в браузер
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    // На анализе темы сначала ищем реальные публикации: этот шаг
    // задаёт фактическую базу для всей работы, и ошибки в нём тянутся
    // дальше по цепочке. Остальные шаги опираются на уже готовый
    // анализ, который приходит в history.
    if (GROUNDED_STEPS.has(step)) {
      const found = await fetchSources(input);
      if (found) {
        messages = withSources(messages, found);
        // Отдаём список в поток до текста: пользователь видит, на чём
        // построен разбор, пока модель ещё печатает.
        res.write(`data: ${JSON.stringify({ sources: found.sources })}\n\n`);
        console.log(`Источников найдено: ${found.count}`);
      } else {
        res.write(`data: ${JSON.stringify({
          notice: 'Источники найти не удалось — разбор построен на '
                + 'знаниях модели. Реквизиты обязательно проверьте.',
        })}\n\n`);
      }
    }

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
    // Копим текст целиком: ссылки на статьи проверяются по готовому
    // ответу, в потоке «ст. 4 ТК РФ» может приехать пятью кусками.
    let fullText = '';

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
            fullText += delta;
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

    // Текст готов — сверяем ссылки на нормы. Именно после генерации, а
    // не до: проверка ходит в правовые базы, и задерживать из-за неё
    // начало вывода нельзя.
    if (sentAny && VERIFIED_STEPS.has(step)) {
      const check = await verifyLegalRefs(fullText);
      if (check) {
        res.write(`data: ${JSON.stringify({ legal: check })}\n\n`);
        console.log(`Ссылок на статьи: ${check.checked}, `
                  + `расхождений: ${check.problems}`);
      }
    }

    res.end();
  } catch (err) {
    console.error('Generate error:', err);
    res.write(`data: ${JSON.stringify({ error: 'Внутренняя ошибка сервера: ' + err.message })}\n\n`);
    res.end();
  }
});

/**
 * Сборка всей работы по готовому плану (пункт 4 меню).
 *
 * Отличается от остальных шагов тем, что это не один запрос к модели, а
 * десяток: введение, каждый раздел по очереди, заключение. На плане из
 * трёх глав по три раздела выходит одиннадцать обращений и минут
 * пятнадцать ожидания.
 *
 * Отсюда три решения. Первое - прогресс идёт в поток по мере готовности
 * каждого куска, а не одним пакетом в конце: пользователь должен видеть,
 * что работа движется. Второе - написанные разделы копятся и передаются
 * модели как контекст, иначе третий раздел пересказывает первый. Третье -
 * отказ на одном разделе не роняет сборку: раздел помечается и работа
 * идёт дальше, дописать один кусок проще, чем начинать всё заново.
 */
app.post('/api/assemble', async (req, res) => {
  const { plan, settings, ownerKey } = req.body || {};

  if (!plan || String(plan).trim().length < 100) {
    return res.status(400).json({
      error: 'Нужен план работы. Сначала выполните пункт 2.',
    });
  }

  const outline = parseOutline(plan);
  if (!outline.chapters.length) {
    return res.status(400).json({
      error: 'В плане не нашлось глав. Проверьте, что вставлен план '
           + 'работы, а не анализ темы.',
    });
  }

  const queue = buildQueue(outline);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // Сразу отдаём структуру: пользователь видит, что именно будет
  // написано и сколько это шагов, до начала долгого ожидания.
  send({
    outline: outline.chapters.map((c) => ({
      number: c.number,
      title: c.title,
      sections: c.sections.map((s) => ({ number: s.number, title: s.title })),
    })),
    warnings: outline.warnings,
    total: queue.length,
  });

  const done = [];      // готовые куски
  const failed = [];    // что не получилось
  let aborted = false;

  // Публикации подбираются ОДИН раз на всю работу. Так номера ссылок
  // [1], [3] означают одно и то же в любом разделе — иначе сноска в
  // третьем разделе указывала бы на чужую статью.
  const sources = await fetchSources((settings && settings.topic) || plan.slice(0, 200));
  if (sources) {
    send({ sources: sources.sources });
  } else {
    send({
      notice: 'Источники найти не удалось — работа будет написана по '
            + 'знаниям модели, без сносок. Реквизиты проверьте сами.',
    });
  }

  // Итог по ссылкам на закон за всю работу — показываем в конце, чтобы
  // предупреждения, пролетевшие мимо глаз по ходу сборки, не пропали.
  const legalTotals = { checked: 0, wrong: 0, unclear: 0 };

  // Работа заводится в хранилище до первого куска и пополняется по
  // ходу сборки. Смысл — не потерять написанное: раньше всё жило в
  // памяти вкладки, и закрытый браузер стоил двух минут генерации и
  // куска суточного лимита модели.
  //
  // Хранилище необязательно: если Python-бэкенд не поднят, сборка идёт
  // как прежде, просто без сохранения. Ронять её из-за этого нельзя.
  const storage = createWorkStorage(ownerKey, settings, plan);
  await storage.start();
  if (storage.id) send({ saved: { workId: storage.id } });

  // Слушать надо ОТВЕТ, а не запрос. У req событие close срабатывает,
  // как только прочитано тело - то есть сразу, ещё до первого куска.
  // С подпиской на req сборка тихо останавливалась после первой части:
  // ошибки нет, поток просто закрывался. Уход клиента виден по res.
  res.on('close', () => { aborted = true; });

  for (let i = 0; i < queue.length; i += 1) {
    if (aborted) break;

    const task = queue[i];
    send({ progress: { index: i + 1, total: queue.length, title: task.heading || task.title } });

    try {
      const raw = await writeFullPiece(task, { plan, settings, done, sources }, send);

      // Модель изредка мешает латиницу с кириллицей внутри слова
      // («kompetенции»). В готовой работе это брак, а глазами такое
      // почти не видно - чиним и показываем, что именно поправили.
      const { text, fixed } = fixHybrids(raw);
      done.push({ task, text });
      await storage.savePiece(task, text, i);

      // Сверяем ссылки сразу: оглавления кодексов кэшируются на
      // бэкенде, поэтому со второй части проверка почти бесплатна.
      const legal = await checkLegalRefs(text);
      if (legal && (legal.wrong.length || legal.unclear.length)) {
        legalTotals.wrong += legal.wrong.length;
        legalTotals.unclear += legal.unclear.length;
        send({
          legal: {
            heading: task.heading || task.title,
            checked: legal.checked,
            wrong: legal.wrong,
            unclear: legal.unclear,
          },
        });
      }
      if (legal) legalTotals.checked += legal.checked;

      send({
        piece: {
          kind: task.kind,
          number: task.number || null,
          heading: task.heading || task.title,
          text,
          chars: text.replace(/\s/g, '').length,
          fixed: fixed.length ? fixed : undefined,
        },
      });
    } catch (e) {
      failed.push({ heading: task.heading || task.title, reason: e.message });
      send({
        failed: { heading: task.heading || task.title, reason: e.message },
      });
    }
  }

  // Статус проставляем и при обрыве: работа осталась незаконченной, и
  // в списке это должно быть видно.
  await storage.finish(aborted ? 'assembling' : 'done');

  if (!aborted) {
    send({
      finished: {
        written: done.length,
        failed: failed.length,
        workId: storage.id || undefined,
        legal: legalTotals.checked ? legalTotals : undefined,
      },
    });
    res.write('data: [DONE]\n\n');
  }
  res.end();
});

/**
 * Сверка ссылок на статьи кодексов с оглавлениями с consultant.ru.
 *
 * Зачем прямо в сборке. Модель уверенно выдумывает номера статей — это
 * самая опасная ошибка в юридической работе, потому что выглядит она
 * безупречно. Проверять постфактум пользователь забывает, а увидев
 * предупреждение сразу под разделом, он его прочитает.
 *
 * Возвращает null, если проверка недоступна: Python-бэкенд не запущен
 * или consultant.ru не ответил. Ронять сборку из-за этого нельзя —
 * текст уже написан и стоит потраченного лимита модели.
 */
async function checkLegalRefs(text) {
  try {
    const r = await fetch(`${PY_BACKEND}/api/v1/sources/verify-legal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) return null;

    const data = await r.json();
    const refs = data.references || [];

    // Наружу отдаём только то, что требует внимания. Совпавшие ссылки
    // перечислять незачем: длинный зелёный список читать не будут, а
    // важное в нём потеряется.
    const pick = (status) => refs
      .filter((x) => x.status === status)
      .map((x) => ({ label: x.label, note: x.note || '' }));

    return {
      checked: refs.length,
      wrong: [...pick('missing'), ...pick('mismatch')],
      unclear: pick('unclear'),
    };
  } catch (e) {
    return null;
  }
}

/**
 * Сохранение работы по ходу сборки.
 *
 * Обёртка над /api/v1/works Python-бэкенда. Все ошибки глушатся
 * намеренно: хранение — приятное дополнение, а не условие работы
 * генератора. Если бэкенд не запущен, пользователь всё равно получит
 * текст, просто он не сохранится, и об этом скажет UI.
 */
function createWorkStorage(ownerKey, settings, plan) {
  const key = String(ownerKey || '').trim();
  const enabled = key.length >= 8;

  const api = async (path, method, body) => {
    const r = await fetch(`${PY_BACKEND}/api/v1/works${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Owner-Key': key },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  };

  return {
    id: null,
    failedOnce: false,

    async start() {
      if (!enabled) return;
      try {
        const created = await api('', 'POST', {
          topic: (settings && settings.topic) || '',
          plan: String(plan || ''),
          settings: settings || {},
        });
        this.id = created.id;
        await api(`/${this.id}`, 'PATCH', { status: 'assembling' });
      } catch (e) {
        this.failedOnce = true;
      }
    },

    async savePiece(task, text, index) {
      if (!this.id) return;
      try {
        await api(`/${this.id}/pieces`, 'POST', {
          kind: task.kind,
          number: task.number || null,
          heading: task.heading || task.title || '',
          text,
          position: index,
        });
      } catch (e) {
        this.failedOnce = true;
      }
    },

    async finish(status) {
      if (!this.id) return;
      try {
        await api(`/${this.id}`, 'PATCH', { status });
      } catch (e) {
        this.failedOnce = true;
      }
    },
  };
}

/** Знаки без пробелов — в них заданы все нормы объёма. */
function charsNoSpace(text) {
  return String(text).replace(/\s/g, '').length;
}

/**
 * Нижняя граница объёма для куска работы.
 *
 * Держим в одном месте, потому что эти же числа зашиты в промптах, и
 * расходиться они не должны.
 */
const MIN_CHARS = { section: 5000, introduction: 3800, conclusion: 2000 };

/**
 * Куда целимся при доборе — середина диапазона, а не нижняя граница.
 * Целиться в минимум нельзя: промахнувшись на сотню знаков вниз, мы
 * запустим ещё один круг ради мелочи.
 */
const TARGET_CHARS = { section: 5500, introduction: 4400, conclusion: 3000 };

/**
 * Коэффициент запроса при доборе.
 *
 * На доборе модель ведёт себя ровно наоборот, чем на основном шаге:
 * там она не дотягивает до заданного объёма, здесь — пишет примерно
 * вдвое больше, чем попросили (замер: просили 2785 знаков, получили
 * 3944; просили 711 — получили 1304). Поэтому просим примерно половину
 * недостающего. Если промахнёмся вниз, сработает вторая попытка.
 */
const EXPAND_RATIO = 0.5;

/**
 * Написать кусок и, если он вышел коротким, дописать до нормы.
 *
 * Зачем отдельный проход. Модель стабильно останавливается раньше
 * заданного объёма: на живом прогоне все четыре раздела вышли по
 * 3100-4700 знаков при норме 5000-6000. В промпте объём указан, но
 * модель считает мысль законченной и заканчивает. Увеличивать давление
 * в основном промпте вредно — начинается вода.
 *
 * Поэтому объём добирается вторым вызовом, который видит уже написанное
 * и получает жёсткий запрет на воду со списком допустимых содержательных
 * ходов. Попыток не больше двух: если и после них коротко, отдаём как
 * есть и говорим об этом пользователю, а не крутим цикл бесконечно.
 */
async function writeFullPiece(task, ctx, send) {
  let text = await writePiece(task, ctx);

  const min = MIN_CHARS[task.kind];
  if (!min) return text;

  const MAX_TRIES = 2;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    const have = charsNoSpace(text);
    if (have >= min) break;

    const target = TARGET_CHARS[task.kind] || min;
    // Меньше 400 знаков просить бессмысленно — это один абзац, модель
    // всё равно напишет больше.
    const need = Math.max(400, Math.round((target - have) * EXPAND_RATIO));
    if (send) {
      send({
        expanding: {
          heading: task.heading || task.title,
          have,
          need: min,
          attempt,
        },
      });
    }

    let added;
    try {
      added = await writePiece(task, ctx, { expand: { text, need } });
    } catch (e) {
      // Добор не удался — раздел уже есть, терять его из-за этого
      // нельзя. Отдаём что написано.
      break;
    }

    if (charsNoSpace(added) < 200) break;   // модель отказалась дописывать
    text = `${text.trim()}\n\n${added.trim()}`;
  }

  return text;
}

/**
 * Написать один кусок работы: введение, раздел или заключение.
 *
 * Готовые куски передаются в сжатом виде - только заголовки и первые
 * строки. Целиком они не влезут в контекст к середине работы, а для
 * борьбы с повторами достаточно знать, о чём уже сказано.
 */
async function writePiece(task, ctx, opts = {}) {
  const { plan, settings, done, sources } = ctx;
  const expand = opts.expand || null;

  const stepName = expand
    ? 'section_expand'
    : (task.kind === 'section' ? 'section_write' : task.kind);
  const raw = STEP_PROMPTS[stepName];
  if (!raw) throw new Error(`нет промпта для шага ${stepName}`);

  const messages = [
    { role: 'system', content: applyChapters(raw, settings && settings.chapters) },
  ];

  const brief = buildBrief(settings || {});
  if (brief) messages.push({ role: 'system', content: brief });

  // Найденные публикации — тем же блоком, что и на анализе темы.
  // Без них модель пишет по памяти, и сослаться в тексте ей не на что:
  // список литературы в конце работы выглядит тогда декорацией.
  const srcBlock = sourcesBlock(sources);
  if (srcBlock) messages.push({ role: 'system', content: srcBlock });

  // План целиком нужен всегда: из него видно место куска в работе.
  messages.push({
    role: 'system',
    content: `ПЛАН ВСЕЙ РАБОТЫ (для ориентира):\n\n${String(plan).slice(0, 12000)}`,
  });

  if (done.length) {
    const written = done.map((d) => {
      const head = d.task.heading || d.task.title;
      return `${head}\n${d.text.slice(0, 400)}...`;
    }).join('\n\n');
    messages.push({
      role: 'system',
      content: 'УЖЕ НАПИСАНО (не повторяй эти мысли и формулировки, '
             + `двигай работу дальше):\n\n${written.slice(0, 8000)}`,
    });
  }

  let user;
  if (expand) {
    // Написанную часть даём целиком: дописывать продолжение, видя лишь
    // краткую выжимку, нельзя — получится повтор уже сказанного.
    user = `Раздел ${task.heading || task.title} написан не полностью.`;
    if (task.brief) user += `\n\nПлан этого раздела:\n${task.brief}`;
    user += `\n\nУЖЕ НАПИСАННАЯ ЧАСТЬ РАЗДЕЛА:\n\n${expand.text}`;
    user += `\n\nДопиши примерно ${expand.need} знаков без пробелов — только`
          + ' новые абзацы, продолжающие этот текст. Повторять написанное'
          + ' выше нельзя.';
  } else if (task.kind === 'section') {
    user = `Напиши раздел ${task.heading}.`;
    if (task.chapterTitle) user += `\nОн входит в главу «${task.chapterTitle}».`;
    if (task.brief) user += `\n\nПлан этого раздела:\n${task.brief}`;
  } else if (task.kind === 'introduction') {
    user = 'Напиши введение к работе по плану выше.';
  } else {
    user = 'Напиши заключение работы по плану выше и написанным разделам.';
  }
  messages.push({ role: 'user', content: user });

  const { upstream } = await callOpenRouterWithFallback(messages);

  // Ответ читаем целиком: поток здесь не нужен, наружу уходит готовый
  // кусок, а прогресс показывается по кускам, а не по буквам.
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';

  while (true) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        const choice = parsed.choices?.[0];
        text += choice?.delta?.content || choice?.delta?.reasoning_content || '';
      } catch { /* keep-alive и прочий мусор */ }
    }
  }

  if (!text.trim()) throw new Error('модель вернула пустой ответ');
  return text.trim();
}

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
/**
 * Список литературы по ГОСТ для готовой работы.
 *
 * Берётся из метаданных научных баз, а не из текста модели: реквизиты
 * публикаций — то самое место, где она уверенно врёт. Журнал настоящий,
 * год правдоподобный, страницы выдуманы, и вскрывается это ровно тогда,
 * когда научный руководитель решает открыть ссылку.
 *
 * Пустой массив — приемлемый исход: работа без списка литературы всё же
 * лучше, чем несобранный файл. Пользователю об этом говорится отдельно.
 */
async function fetchBibliography(topic) {
  if (!topic) return [];
  try {
    const r = await fetch(`${PY_BACKEND}/api/v1/sources/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, limit: 10, with_fulltext: false }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) return [];

    const data = await r.json();
    return String(data.bibliography || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    console.error('Список литературы собрать не удалось:', e.message);
    return [];
  }
}

app.post('/api/export-docx-full', async (req, res) => {
  try {
    const { topic, introduction, sections, conclusion, chapterTitles, sectionTitles, titlePage, sources } = req.body;
    if (!topic) {
      return res.status(400).json({ error: 'Нет темы работы для экспорта' });
    }

    // Откуда брать список литературы, по убыванию важности:
    //
    // 1. Прислал клиент — например, отредактированный руками.
    // 2. Публикации, на которые ссылается текст. Это главный случай:
    //    список обязан совпадать со сносками. Подбор заново дал бы
    //    работы, которых в тексте нет, и научрук справедливо спросит,
    //    где именно они использованы.
    // 3. Подбор по теме — когда источников сборки нет (старая работа
    //    из хранилища, ручная склейка).
    const fromSources = (Array.isArray(sources) ? sources : [])
      .map((s) => s && s.gost)
      .filter(Boolean);

    const bibliography = Array.isArray(req.body.bibliography)
      && req.body.bibliography.length
      ? req.body.bibliography
      : (fromSources.length ? fromSources : await fetchBibliography(topic));

    // Титул строится, только если пользователь что-то о себе сообщил:
    // лист с одними прочерками никому не нужен.
    const hasTitleData = titlePage && Object.keys(titlePage)
      .some((k) => k !== 'topic' && String(titlePage[k] || '').trim());

    const buffer = await generateFullDocx({
      topic, introduction, sections, conclusion, chapterTitles, sectionTitles,
      bibliography,
      titlePage: hasTitleData ? titlePage : null,
      // Источники приходят от клиента — ровно те, на которых построен
      // текст. Подбирать их заново нельзя: выдача изменится, и сноска
      // укажет на чужую статью.
      sources: Array.isArray(sources) ? sources : [],
    });
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
  const server = app.listen(PORT,
    () => console.log(`Студсервис запущен на http://localhost:${PORT}`));

  // Node по умолчанию обрывает запрос через 5 минут (requestTimeout =
  // 300000 мс). Для обычных шагов это незаметно, но сборка работы идёт
  // десятком запросов к модели подряд и легко занимает полчаса, а
  // генерация плана на длинном входе упиралась в ровно 303 секунды и
  // падала с «terminated». Снимаем ограничение на время запроса и
  // оставляем щедрый keep-alive: поток SSE должен жить, пока идёт
  // работа.
  server.requestTimeout = 0;          // без предела на длительность
  server.headersTimeout = 120000;     // но заголовки обязаны прийти быстро
  server.keepAliveTimeout = 120000;
  server.timeout = 0;
}

module.exports = app;
