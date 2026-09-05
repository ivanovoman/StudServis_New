/**
 * Вступительная заставка: путешествие из прошлого в будущее.
 *
 * Сценарий:
 *   1. Курсор последовательно подсвечивает 8 пунктов меню.
 *   2. Всплывает окно с кнопкой «Вперёд в прошлое».
 *   3. Окно схлопывается в точку.
 *   4. Из точки разворачивается окно «Назад в будущее» с мигающей
 *      надписью «нажмите любую клавишу».
 *   5. Любая клавиша — и ретро-интерфейс сменяется современным.
 *
 * Заставка показывается один раз за сессию: повторно открывая вкладку
 * с рабочей задачей, ждать анимацию никто не захочет. Отметка лежит в
 * sessionStorage, так что новая сессия снова покажет вступление.
 *
 * Пропустить можно в любой момент: Esc, кнопка «Пропустить», или
 * ?intro=off в адресе. Полностью выключить — ?intro=off,
 * принудительно повторить — ?intro=1.
 */
(function () {
  'use strict';

  var SEEN_KEY = 'studservis_intro_seen';
  var MODERN_KEY = 'studservis_modern_ui';

  var params = new URLSearchParams(window.location.search);
  var force = params.get('intro') === '1';
  var disabled = params.get('intro') === 'off';

  // Уважаем системную настройку: если человек просил меньше движения,
  // анимацию не навязываем.
  var reduceMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (disabled || (!force && (sessionStorage.getItem(SEEN_KEY)
      || reduceMotion))) {
    return;
  }

  // --------------------------------------------------------- утилиты

  function el(tag, styles, text) {
    var node = document.createElement(tag);
    if (styles) for (var k in styles) node.style[k] = styles[k];
    if (text) node.textContent = text;
    return node;
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /** Пункты меню темы. Классы у разных тем отличаются. */
  function menuItems() {
    var nodes = document.querySelectorAll('.menu-item, .item, .popup-item');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      // Настройки — девятый пункт, в обходе не участвуют.
      if (nodes[i].getAttribute('data-action') === 'settings') continue;
      if (/^\s*[1-8][.)]/.test(nodes[i].textContent)) out.push(nodes[i]);
    }
    return out;
  }

  // ------------------------------------------------------------ слой

  var layer = el('div', {
    position: 'fixed', inset: '0', zIndex: '9000',
    pointerEvents: 'none',
    fontFamily: '"Courier New", Courier, monospace',
  });
  document.body.appendChild(layer);

  var finished = false;

  function cleanup() {
    if (finished) return;
    finished = true;
    sessionStorage.setItem(SEEN_KEY, '1');
    document.removeEventListener('keydown', onSkipKey);
    if (layer.parentNode) layer.remove();
    restoreHighlights();
  }

  // Подсветку наводим через инлайновый стиль, чтобы не спорить с CSS
  // темы и уметь вернуть всё как было.
  var touched = [];

  function highlight(node, on) {
    if (on) {
      touched.push([node, node.style.cssText]);
      node.style.outline = '2px solid currentColor';
      node.style.outlineOffset = '1px';
      node.style.filter = 'brightness(1.6)';
      node.style.transition = 'filter .12s linear';
    } else {
      node.style.outline = '';
      node.style.outlineOffset = '';
      node.style.filter = '';
    }
  }

  function restoreHighlights() {
    for (var i = 0; i < touched.length; i++) {
      touched[i][0].style.cssText = touched[i][1];
    }
    touched = [];
  }

  function onSkipKey(e) {
    if (e.key === 'Escape') { cleanup(); }
  }
  document.addEventListener('keydown', onSkipKey);

  // Ненавязчивая кнопка выхода: анимация не должна брать в заложники.
  var skip = el('button', {
    position: 'fixed', right: '14px', bottom: '12px',
    pointerEvents: 'auto', cursor: 'pointer',
    background: 'transparent', color: '#9a9a9a',
    border: '1px solid #6a6a6a', padding: '4px 10px',
    fontFamily: 'inherit', fontSize: '11px', opacity: '0.75',
  }, 'Пропустить [Esc]');
  skip.onclick = cleanup;
  layer.appendChild(skip);

  // ------------------------------------------------------- 1. курсор

  /** Блочный курсор, какой был в текстовых интерфейсах. */
  function makeCursor() {
    var c = el('div', {
      position: 'fixed', width: '9px', height: '16px',
      background: 'currentColor', opacity: '0.9',
      transition: 'left .18s ease-out, top .18s ease-out',
      boxShadow: '0 0 6px currentColor',
    });
    layer.appendChild(c);
    return c;
  }

  function moveCursorTo(cursor, node) {
    var r = node.getBoundingClientRect();
    cursor.style.left = Math.max(2, r.left - 14) + 'px';
    cursor.style.top = (r.top + r.height / 2 - 8) + 'px';
  }

  async function runCursor() {
    var items = menuItems();
    if (!items.length) return;

    var cursor = makeCursor();
    // Ставим курсор у первого пункта без анимации перелёта из угла.
    moveCursorTo(cursor, items[0]);
    await wait(120);

    for (var i = 0; i < items.length && !finished; i++) {
      moveCursorTo(cursor, items[i]);
      highlight(items[i], true);
      await wait(150);
      highlight(items[i], false);
    }
    cursor.remove();
  }

  // -------------------------------------------------- 2-4. окна

  /** Рамка в духе системных диалогов той эпохи. */
  function dialog(inner) {
    var box = el('div', {
      position: 'fixed', left: '50%', top: '50%',
      transform: 'translate(-50%, -50%) scale(1)',
      background: '#0b0b0b', color: '#e8e8e8',
      border: '2px solid #e8e8e8',
      boxShadow: '8px 8px 0 rgba(0,0,0,.65)',
      padding: '26px 34px', textAlign: 'center',
      pointerEvents: 'auto',
      transition: 'transform .45s cubic-bezier(.6,-0.28,.74,.05), opacity .3s',
    });
    box.appendChild(inner);
    layer.appendChild(box);
    return box;
  }

  function retroButton(text) {
    return el('button', {
      cursor: 'pointer', pointerEvents: 'auto',
      background: '#e8e8e8', color: '#0b0b0b',
      border: '2px solid #0b0b0b', boxShadow: '3px 3px 0 #555',
      padding: '10px 22px', fontFamily: 'inherit',
      fontSize: '15px', fontWeight: 'bold', letterSpacing: '1px',
    }, text);
  }

  /** Окно с кнопкой «Вперёд в прошлое». Ждёт клика. */
  function forwardToPast() {
    return new Promise(function (resolve) {
      var inner = el('div');
      inner.appendChild(el('div', {
        fontSize: '12px', opacity: '.7', marginBottom: '14px',
        letterSpacing: '2px',
      }, 'СЕРВИС СТУДРАБОТ'));

      var btn = retroButton('▶ Вперёд в прошлое');
      inner.appendChild(btn);

      var box = dialog(inner);
      // Небольшая задержка, иначе кнопка появляется под курсором,
      // который ещё бежит по меню.
      btn.focus();

      btn.onclick = function () { resolve(box); };
    });
  }

  /** Схлопывание окна в точку. */
  async function collapse(box) {
    box.style.transform = 'translate(-50%, -50%) scale(0.001)';
    box.style.opacity = '0.9';
    await wait(460);
    box.remove();

    // Точка живёт мгновение — как гаснущий кинескоп.
    var dot = el('div', {
      position: 'fixed', left: '50%', top: '50%',
      width: '6px', height: '6px', marginLeft: '-3px', marginTop: '-3px',
      borderRadius: '50%', background: '#ffffff',
      boxShadow: '0 0 18px 6px rgba(255,255,255,.85)',
      transition: 'transform .25s ease-in, opacity .25s',
    });
    layer.appendChild(dot);
    await wait(260);
    return dot;
  }

  /** Из точки разворачивается окно «Назад в будущее». */
  function backToFuture(dot) {
    return new Promise(function (resolve) {
      dot.remove();

      var inner = el('div');
      inner.appendChild(el('div', {
        fontSize: '20px', fontWeight: 'bold', letterSpacing: '2px',
        marginBottom: '16px',
      }, 'Назад в будущее'));

      var blink = el('div', {
        fontSize: '13px', letterSpacing: '1px', opacity: '1',
      }, 'нажмите любую клавишу');
      inner.appendChild(blink);

      var box = dialog(inner);
      // Разворачиваем из нуля — эффект «выросло из точки».
      box.style.transition = 'transform .42s cubic-bezier(.16,1,.3,1)';
      box.style.transform = 'translate(-50%, -50%) scale(0.001)';
      // Форсируем пересчёт стиля, иначе браузер объединит оба
      // присваивания и анимации не будет.
      void box.offsetWidth;
      box.style.transform = 'translate(-50%, -50%) scale(1)';

      var visible = true;
      var timer = setInterval(function () {
        visible = !visible;
        blink.style.opacity = visible ? '1' : '0.05';
      }, 520);

      function done() {
        clearInterval(timer);
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('mousedown', onKey);
        resolve();
      }

      function onKey(e) {
        if (e.key === 'Escape') return;   // Esc — это выход, не переход
        done();
      }

      // Клавиатура — основной путь, мышь — для тех, кто на телефоне.
      setTimeout(function () {
        document.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onKey);
      }, 250);
    });
  }

  /** Вспышка перехода и загрузка современного интерфейса. */
  async function toModern() {
    var flash = el('div', {
      position: 'fixed', inset: '0', background: '#ffffff',
      opacity: '0', transition: 'opacity .28s ease-in',
    });
    layer.appendChild(flash);
    void flash.offsetWidth;
    flash.style.opacity = '1';
    await wait(300);

    sessionStorage.setItem(SEEN_KEY, '1');
    localStorage.setItem(MODERN_KEY, '1');
    window.location.href = '/modern.html';
  }

  // ------------------------------------------------------ сценарий

  async function play() {
    // Даём теме дорисоваться: getBoundingClientRect на неготовой
    // раскладке вернёт нули, и курсор улетит в угол.
    await wait(260);
    if (finished) return;

    await runCursor();
    if (finished) return;

    var box = await forwardToPast();
    if (finished) return;

    var dot = await collapse(box);
    if (finished) return;

    await backToFuture(dot);
    if (finished) return;

    await toModern();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', play);
  } else {
    play();
  }
})();
