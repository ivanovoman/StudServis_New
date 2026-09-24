#!/usr/bin/env node
/**
 * Проверка ключа GigaChat без раскрытия самого ключа.
 *
 * Запуск:
 *   node tools/check-gigachat.js
 *
 * Ключ берётся из .env (строка GIGACHAT_AUTH_KEY=...).
 * Скрипт печатает только статусы и список моделей — ключ в вывод не попадает,
 * поэтому результат можно спокойно переслать в переписку.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Читаем .env вручную, чтобы не тянуть лишнюю зависимость.
function loadEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = { ...loadEnv(), ...process.env };
const key = env.GIGACHAT_AUTH_KEY;
const scope = env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';

function mask(s) {
  if (!s) return '(пусто)';
  if (s.length < 12) return `(слишком короткий, длина ${s.length})`;
  return `${s.slice(0, 4)}...${s.slice(-4)} (длина ${s.length})`;
}

function ok(t) { console.log(`  [OK]    ${t}`); }
function bad(t) { console.log(`  [ОШИБКА] ${t}`); }
function info(t) { console.log(`  ${t}`); }

async function main() {
  console.log('\n=== Проверка ключа GigaChat ===\n');

  if (!key) {
    bad('GIGACHAT_AUTH_KEY не найден.');
    info('Добавьте в файл .env строку:');
    info('  GIGACHAT_AUTH_KEY=сюда_authorization_key');
    process.exit(1);
  }

  // Шаг 1. Формат ключа.
  console.log('1. Формат ключа');
  info(`Ключ: ${mask(key)}`);
  let looksBase64 = false;
  try {
    const decoded = Buffer.from(key, 'base64').toString('utf8');
    // Authorization key = base64("client_id:client_secret"), внутри должен быть UUID:UUID
    if (/^[0-9a-f-]{30,40}:[0-9a-f-]{30,40}$/i.test(decoded.trim())) {
      looksBase64 = true;
      ok('это Authorization Key (внутри Client ID : Client Secret)');
    }
  } catch (e) { /* не base64 */ }

  if (!looksBase64) {
    if (/^[0-9a-f-]{30,40}$/i.test(key.trim())) {
      bad('похоже, это Client Secret или Client ID, а нужен Authorization Key.');
      info('Authorization Key — длинная строка Base64 из окна');
      info('"Сохраните ваш Authorization Key".');
      process.exit(1);
    }
    info('(!) не удалось разобрать как Base64 — всё равно пробую запрос');
  }

  // Шаг 2. Получение access token.
  console.log('\n2. Получение access token');
  info(`scope = ${scope}`);
  if (env.GIGACHAT_INSECURE_TLS === '1') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    info('(!) TLS-проверка отключена (GIGACHAT_INSECURE_TLS=1)');
  }

  let token;
  try {
    const res = await fetch('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'RqUID': crypto.randomUUID(),
        'Authorization': `Basic ${key}`,
      },
      body: `scope=${scope}`,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      bad(`HTTP ${res.status}. ${text.slice(0, 200)}`);
      if (res.status === 401) {
        info('401 = ключ неверный. Частая причина: вставили Client Secret');
        info('вместо Authorization Key.');
      }
      if (res.status === 403) {
        info('403 = ключ верный, но scope не тот. Для физлица нужен');
        info('GIGACHAT_API_PERS.');
      }
      process.exit(1);
    }

    const data = await res.json();
    token = data.access_token;
    const mins = data.expires_at
      ? Math.round((data.expires_at - Date.now()) / 60000)
      : null;
    ok(`токен получен${mins !== null ? `, живёт ещё ~${mins} мин` : ''}`);
  } catch (e) {
    // У fetch настоящая причина лежит в e.cause, а не в e.message.
    const cause = e.cause || {};
    const code = cause.code || '';
    bad(`сеть: ${e.message}${code ? ` (${code})` : ''}`);

    const certCodes = [
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'CERT_HAS_EXPIRED',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    ];
    if (certCodes.includes(code) || /certificate/i.test(String(cause.message || e.message))) {
      info('');
      info('Это сертификат, а не ключ. GigaChat подписан сертификатом');
      info('Минцифры, которого нет в системе. Варианты:');
      info('  1) установить сертификат: gosuslugi.ru/crt');
      info('  2) для проверки добавить в .env строку:');
      info('     GIGACHAT_INSECURE_TLS=1');
    } else if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'UND_ERR_CONNECT_TIMEOUT') {
      info('Хост недоступен: проверьте интернет и что VPN выключен');
      info('(GigaChat работает из России напрямую, через VPN может не пустить).');
    }
    process.exit(1);
  }

  // Шаг 3. Список моделей — пробуем оба адреса, старый и новый.
  console.log('\n3. Доступные модели');
  const hosts = [
    ['новый', 'https://api.giga.chat/v1/models'],
    ['старый', 'https://gigachat.devices.sberbank.ru/api/v1/models'],
  ];

  for (const [label, url] of hosts) {
    try {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      });
      if (!res.ok) {
        bad(`${label} адрес: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const ids = (data.data || []).map((m) => m.id);
      ok(`${label} адрес: ${ids.length} моделей`);
      for (const id of ids) info(`    - ${id}`);
    } catch (e) {
      bad(`${label} адрес: ${e.message}`);
    }
  }

  console.log('\nГотово. В этом выводе ключа нет — можно пересылать.\n');
}

main().catch((e) => {
  console.error('Непредвиденная ошибка:', e.message);
  process.exit(1);
});
