/**
 * Подключение сертификата Минцифры.
 *
 * Серверы GigaChat подписаны сертификатом Минцифры, которого нет в
 * хранилище Node, и запрос падает с SELF_SIGNED_CERT_IN_CHAIN. Список
 * доверенных сертификатов Node читает из переменной NODE_EXTRA_CA_CERTS
 * один раз при старте процесса — выставить её из кода уже поздно.
 *
 * Отсюда приём: если сертификат лежит в certs/, а переменная не задана,
 * процесс перезапускает сам себя с нужной переменной и уходит в сторону.
 * Пользователю ничего настраивать не надо, и, что важнее, не нужно
 * отключать проверку TLS целиком ради одного провайдера.
 *
 * Работает одинаково в Windows, macOS и Linux — в отличие от
 * "NODE_EXTRA_CA_CERTS=... node server.js" в package.json, который в
 * cmd и PowerShell не запускается.
 *
 * Модуль общий, потому что на этом уже один раз обожглись: сервер
 * поднимался через start.js и сертификат подхватывал, а диагностика
 * `npm run check:gigachat` запускалась напрямую и падала с ошибкой
 * сертификата. Выглядело так, будто ключ негоден, хотя он был рабочим.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CA = path.join(__dirname, '..', 'certs', 'russian_trusted_ca.pem');

/** Сертификат уже подключён к текущему процессу? */
function alreadyTrusted() {
  const cur = process.env.NODE_EXTRA_CA_CERTS;
  if (!cur) return false;
  try {
    return path.resolve(cur) === path.resolve(CA) || fs.existsSync(cur);
  } catch (e) {
    return false;
  }
}

/**
 * Перезапускает указанный скрипт с сертификатом.
 *
 * Возвращает true, если перезапуск состоялся — вызывающий код должен
 * сразу прекратить работу: настоящую работу сделает дочерний процесс.
 * Возвращает false, если перезапуск не нужен (сертификат уже подключён
 * или файла сертификата нет) — значит, можно работать дальше.
 */
function relaunchWithCA(scriptPath) {
  if (alreadyTrusted() || !fs.existsSync(CA)) return false;

  const child = spawn(process.execPath, [scriptPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_EXTRA_CA_CERTS: CA },
  });

  // Пробрасываем сигналы, иначе Ctrl+C оставит процесс висеть в фоне.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => child.kill(sig));
  }
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });

  return true;
}

module.exports = { CA, alreadyTrusted, relaunchWithCA };
