#!/usr/bin/env node
/**
 * Точка входа сервера.
 *
 * Нужна из-за одной особенности GigaChat: его серверы подписаны
 * сертификатом Минцифры, которого нет в хранилище Node, и запрос падает
 * с SELF_SIGNED_CERT_IN_CHAIN. Список доверенных сертификатов Node читает
 * из переменной NODE_EXTRA_CA_CERTS один раз при старте процесса —
 * выставить её из кода уже поздно.
 *
 * Поэтому: если сертификат лежит в certs/ и переменная не задана, этот
 * файл перезапускает сам себя с нужной переменной и уходит в сторону.
 * Пользователю ничего настраивать не надо, и, что важнее, не нужно
 * отключать проверку TLS целиком ради одного провайдера.
 *
 * Работает одинаково в Windows, macOS и Linux — в отличие от
 * "NODE_EXTRA_CA_CERTS=... node server.js" в package.json, который в
 * cmd и PowerShell не запускается.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, 'server.js');
const CA = path.join(__dirname, '..', 'certs', 'russian_trusted_ca.pem');

function alreadyTrusted() {
  const cur = process.env.NODE_EXTRA_CA_CERTS;
  if (!cur) return false;
  try {
    return path.resolve(cur) === path.resolve(CA) || fs.existsSync(cur);
  } catch (e) {
    return false;
  }
}

if (!alreadyTrusted() && fs.existsSync(CA)) {
  const child = spawn(process.execPath, [SERVER, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_EXTRA_CA_CERTS: CA },
  });
  // Пробрасываем сигналы, иначе Ctrl+C оставит сервер висеть в фоне.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => child.kill(sig));
  }
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
} else {
  require('./server.js');
}
