/**
 * Проверка сценария входа: ретро — только заставка.
 *
 * Правило, которое здесь закрепляется: рабочим интерфейсом всегда
 * оказывается современный. Ретро-тема показывается один раз за сессию
 * ради вступления и сама передаёт человека дальше. Единственное
 * исключение — ?retro=1 для отладки шестнадцати тем.
 *
 * Проверяются именно переходы, поэтому вместо полной загрузки страниц
 * выполняется их скрипт входа с подставленными окружением и хранилищем:
 * jsdom честно ушёл бы по location.replace, и следующую проверку делать
 * было бы уже негде.
 *
 * Запуск: node tools/check-entry.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function ok(cond, text) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + text);
  if (!cond) process.exitCode = 1;
}

/** Достаёт скрипт входа из index.html и выполняет его на фальшивом окне. */
function enter(search, seen) {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];

  const store = { studservis_intro_seen: seen ? '1' : null };
  let went = null;

  const win = {
    location: {
      search,
      replace: (url) => { if (went === null) went = url; },
    },
  };
  const storage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
  };

  const THEMES = ['Windows_95.html', 'amber-crt.html'];
  const fn = new Function('THEMES', 'window', 'sessionStorage',
    'URLSearchParams', code);
  fn(THEMES, win, storage, URLSearchParams);

  return went;
}

console.log('\nВход на сайт');
ok(/^themes\//.test(enter('', false)),
  'первый заход — ретро-тема с заставкой: ' + enter('', false));
ok(enter('', true) === 'modern.html',
  'заставку уже видели — сразу современный: ' + enter('', true));
ok(enter('?intro=off', false) === 'modern.html',
  '?intro=off — сразу современный, без ретро');
ok(/^themes\//.test(enter('?retro=1', true)),
  '?retro=1 — ретро даже после заставки (отладка тем)');
ok(enter('?theme=amber-crt.html', false).includes('amber-crt.html'),
  '?theme= по-прежнему открывает нужную тему');

console.log('\nЗаставка передаёт дальше');
const intro = fs.readFileSync(path.join(ROOT, 'public/intro.js'), 'utf8');
ok(/function goModern/.test(intro), 'переход в современный вынесен в goModern');
ok(/if \(!stayInRetro\) goModern\(\);/.test(intro),
  'пропуск (Esc, кнопка) уводит в современный, а не оставляет в ретро');
ok(/window\.location\.replace\('\/modern\.html'\)/.test(intro),
  'при отключённых анимациях тоже уходим в современный');
ok(/stayInRetro = params\.get\('retro'\) === '1'/.test(intro),
  '?retro=1 удерживает в ретро намеренно');

console.log('\nИз современного в ретро вернуться нельзя');
const mhtml = fs.readFileSync(path.join(ROOT, 'public/modern.html'), 'utf8');
const mjs = fs.readFileSync(path.join(ROOT, 'public/modern.js'), 'utf8');
ok(!/btn-retro/.test(mhtml + mjs), 'кнопки «Ретро-режим» нет');
ok(!/intro=off/.test(mjs), 'ссылок обратно в ретро не осталось');

console.log(process.exitCode ? '\nЕсть провалы' : '\nВсё сходится');
