// api/providers.js
// Поставщики моделей. Раньше код умел только OpenRouter, и когда ключ
// перестал работать, сервис встал целиком. Теперь провайдер выбирается
// в .env, а при отказе одного можно переключиться на другой, не трогая
// код.
//
// Все провайдеры приводятся к одному виду: функция получает messages,
// возвращает поток в формате OpenAI (SSE с choices[].delta.content).
// Дальше server.js разбирает поток одинаково для всех.

const crypto = require('crypto');

// ---------------------------------------------------------------- OpenRouter

/**
 * OpenRouter — витрина сотен моделей, включая бесплатные (:free).
 *
 * Лимиты бесплатного тарифа: 20 запросов в минуту и 50 в сутки, если
 * на счёт никогда не клали денег. После разовой покупки кредитов на
 * $10 суточный лимит поднимается до 1000 и остаётся таким навсегда,
 * даже когда баланс снова обнулится. Покупка не тратится на free-модели
 * — это просто порог доверия против регистрации пачками аккаунтов.
 *
 * Отрицательный баланс блокирует даже бесплатные модели.
 */
const openrouter = {
  id: 'openrouter',
  title: 'OpenRouter',
  needsKey: 'OPENROUTER_API_KEY',
  defaultModels: [
    'minimax/minimax-m3:free',
    'minimax/minimax-m2.7:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'dots-studio/dots-3-note-preview:free',
    'poolside/laguna-s-2.1:free',
  ],

  async stream(model, messages, env) {
    return fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': env.PUBLIC_URL || 'http://localhost:3000',
        'X-Title': 'Studservice',
      },
      body: JSON.stringify({ model, messages, stream: true }),
    });
  },
};

// ------------------------------------------------------------------ GigaChat

/**
 * GigaChat от Сбера — основной вариант для России.
 *
 * Работает без VPN и без иностранной карты. Физлицам даётся 365 млн
 * бесплатных токенов на год: 250 млн на Lite, 40 млн на Pro, 25 млн на
 * Max, 50 млн на Ultra. Для курсовых это очень много — одна работа
 * съедает порядка сотни тысяч токенов.
 *
 * Две особенности, из-за которых он не «просто ещё один OpenAI API»:
 *
 * 1. Двухэтапная авторизация. Сначала ключ (Authorization Key из
 *    личного кабинета) меняется на access_token, который живёт 30 минут.
 *    Токен кэшируется, иначе на каждый запрос уходил бы лишний round-trip.
 *
 * 2. TLS. Сервер Сбера подписан сертификатом Минцифры, которого нет в
 *    хранилище Node. Правильный путь — установить корневой сертификат
 *    (см. docs/LLM_PROVIDERS.md). Если он не установлен, включается
 *    GIGACHAT_INSECURE_TLS=1 — тогда проверка сертификата отключается.
 *    Это ослабляет защиту от подмены, поэтому в проде так делать не
 *    стоит, но для локальной разработки приемлемо.
 */
let gigachatToken = { value: null, expiresAt: 0 };
let tlsWarned = false;

/**
 * Отключение проверки TLS-сертификата для GigaChat.
 *
 * Встроенный в Node fetch не позволяет задать доверенные сертификаты
 * для отдельного запроса без внешних библиотек, поэтому переключаем
 * глобальный флаг — но только когда пользователь явно попросил, и с
 * заметным предупреждением в консоли, чтобы это не осталось включённым
 * в продакшене незамеченным.
 */
function applyGigachatTls(env) {
  if (env.GIGACHAT_INSECURE_TLS !== '1') return;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  if (!tlsWarned) {
    tlsWarned = true;
    console.warn(
      '\n  ВНИМАНИЕ: GIGACHAT_INSECURE_TLS=1 — проверка TLS-сертификатов '
      + 'отключена.\n  Так можно работать локально, но для продакшена '
      + 'установите сертификат\n  Минцифры и уберите этот флаг '
      + '(docs/LLM_PROVIDERS.md).\n'
    );
  }
}

const gigachat = {
  id: 'gigachat',
  title: 'GigaChat (Сбер)',
  needsKey: 'GIGACHAT_AUTH_KEY',
  defaultModels: [
    'GigaChat-2-Max',
    'GigaChat-2-Pro',
    'GigaChat-2',
  ],

  async getToken(env) {
    applyGigachatTls(env);
    const now = Date.now();
    // Обновляем за минуту до истечения, чтобы не попасть на границу.
    if (gigachatToken.value && now < gigachatToken.expiresAt - 60_000) {
      return gigachatToken.value;
    }

    const scope = env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';
    const res = await fetch(
      'https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'RqUID': crypto.randomUUID(),
          'Authorization': `Basic ${env.GIGACHAT_AUTH_KEY}`,
        },
        body: `scope=${scope}`,
      });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `GigaChat: не удалось получить токен (${res.status}). ${text.slice(0, 200)}`
      );
    }

    const data = await res.json();
    gigachatToken = {
      value: data.access_token,
      // expires_at приходит в миллисекундах epoch.
      expiresAt: data.expires_at || (now + 25 * 60_000),
    };
    return gigachatToken.value;
  },

  async stream(model, messages, env) {
    applyGigachatTls(env);
    const token = await this.getToken(env);
    return fetch('https://gigachat.devices.sberbank.ru/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ model, messages, stream: true }),
    });
  },
};

// ------------------------------------------------- любой OpenAI-совместимый

/**
 * Универсальный провайдер для всего, что говорит на диалекте OpenAI:
 * Groq, Cerebras, Together, Mistral, локальная Ollama, LM Studio,
 * российские агрегаторы.
 *
 * Настраивается двумя переменными:
 *   CUSTOM_API_URL=https://api.groq.com/openai/v1/chat/completions
 *   CUSTOM_API_KEY=...
 *   CUSTOM_MODELS=llama-3.3-70b-versatile,llama-3.1-8b-instant
 *
 * Для локальной Ollama ключ не нужен:
 *   CUSTOM_API_URL=http://127.0.0.1:11434/v1/chat/completions
 *   CUSTOM_MODELS=qwen2.5:14b
 */
const custom = {
  id: 'custom',
  title: 'Свой OpenAI-совместимый сервер',
  needsKey: null,   // ключ может не требоваться (локальные модели)
  defaultModels: [],

  async stream(model, messages, env) {
    const url = env.CUSTOM_API_URL;
    if (!url) {
      throw new Error('CUSTOM_API_URL не задан в .env');
    }
    const headers = { 'Content-Type': 'application/json' };
    if (env.CUSTOM_API_KEY) {
      headers['Authorization'] = `Bearer ${env.CUSTOM_API_KEY}`;
    }
    return fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, stream: true }),
    });
  },
};

// ------------------------------------------------------------------- выбор

const PROVIDERS = { openrouter, gigachat, custom };

/**
 * Список провайдеров для попытки, в порядке приоритета.
 *
 * LLM_PROVIDER задаёт основной, LLM_FALLBACK_PROVIDER — запасной.
 * Запасной нужен ровно для той ситуации, из-за которой всё это
 * написано: у основного кончились лимиты или отвалился ключ.
 */
function resolveProviders(env) {
  const names = [
    env.LLM_PROVIDER || 'openrouter',
    env.LLM_FALLBACK_PROVIDER || '',
  ].filter(Boolean);

  const seen = new Set();
  const out = [];
  for (const name of names) {
    const p = PROVIDERS[name.trim()];
    if (!p || seen.has(p.id)) continue;
    // Провайдер без ключа пропускаем молча: пользователь мог задать
    // запасного «на будущее», но ключ ещё не завёл.
    if (p.needsKey && !env[p.needsKey]) continue;
    if (p.id === 'custom' && !env.CUSTOM_API_URL) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/** Модели конкретного провайдера: из .env или список по умолчанию. */
function modelsFor(provider, env) {
  const key = {
    openrouter: 'OPENROUTER_MODELS',
    gigachat: 'GIGACHAT_MODELS',
    custom: 'CUSTOM_MODELS',
  }[provider.id];

  const raw = env[key];
  if (raw) {
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }

  // Обратная совместимость со старой переменной OPENROUTER_MODEL.
  if (provider.id === 'openrouter' && env.OPENROUTER_MODEL) {
    const first = env.OPENROUTER_MODEL.trim();
    return [first, ...provider.defaultModels.filter(m => m !== first)];
  }

  return provider.defaultModels;
}

module.exports = { PROVIDERS, resolveProviders, modelsFor };
