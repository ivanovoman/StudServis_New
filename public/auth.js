/**
 * Вход и регистрация.
 *
 * Токен хранится в localStorage. Это осознанный компромисс: печенье с
 * флагом HttpOnly безопаснее, потому что недоступно чужому скрипту, но
 * требует защиты от CSRF и общего домена у статики и API. Пока их
 * отдают разные порты, заголовок Authorization проще и честнее.
 *
 * Вход необязателен. Без него сервис работает как раньше: работы
 * привязаны к ключу браузера. Войдя, человек получает их на любом
 * устройстве — и при первом входе прежние работы присваиваются его
 * учётной записи, иначе регистрация выглядела бы как их потеря.
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'studrabots.token';
  var USER_KEY = 'studrabots.user';
  var FONT = "'Courier New', monospace";

  var overlay = null;

  // --- хранение -------------------------------------------------------

  function token() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function user() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
    catch (e) { return null; }
  }

  function remember(data) {
    try {
      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    } catch (e) {
      // Приватный режим: вход проживёт до закрытия вкладки.
      window.__studToken = data.token;
    }
    notify();
  }

  function forget() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch (e) { /* см. выше */ }
    window.__studToken = null;
    notify();
  }

  /** Заголовок для защищённых запросов. Пустой объект, если не вошёл. */
  function authHeaders() {
    var t = token() || window.__studToken || '';
    return t ? { Authorization: 'Bearer ' + t } : {};
  }

  var listeners = [];
  function onChange(fn) { listeners.push(fn); }
  function notify() { listeners.forEach(function (fn) { try { fn(user()); } catch (e) {} }); }

  // --- запросы --------------------------------------------------------

  function api(path, body) {
    return fetch('/api/v1/auth' + path, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.text().then(function (text) {
        var data = {};
        try { data = JSON.parse(text); } catch (e) {}
        if (!r.ok) throw new Error(data.detail || ('Ошибка ' + r.status));
        return data;
      });
    });
  }

  function ownerKey() {
    return (window.StudWorks && window.StudWorks.ownerKey)
      ? window.StudWorks.ownerKey() : '';
  }

  function register(email, password) {
    // Ключ браузера передаём, чтобы собранные до регистрации работы
    // достались новой учётной записи.
    return api('/register', { email: email, password: password, owner_key: ownerKey() })
      .then(function (data) { remember(data); return data; });
  }

  function login(email, password) {
    return api('/login', { email: email, password: password, owner_key: ownerKey() })
      .then(function (data) { remember(data); return data; });
  }

  function logout() {
    return api('/logout').catch(function () { /* всё равно забываем */ })
      .then(forget);
  }

  // --- окно -----------------------------------------------------------

  function el(tag, style, text) {
    var node = document.createElement(tag);
    if (style) for (var k in style) node.style[k] = style[k];
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function btnStyle() {
    return {
      background: '#000', color: '#e8e8e8', border: '1px solid #e8e8e8',
      padding: '4px 10px', cursor: 'pointer', fontFamily: FONT, fontSize: '13px',
    };
  }

  function field(type, placeholder) {
    var input = document.createElement('input');
    input.type = type;
    input.placeholder = placeholder;
    input.style.width = '100%';
    input.style.fontFamily = FONT;
    input.style.fontSize = '13px';
    input.style.background = '#000';
    input.style.color = '#e8e8e8';
    input.style.border = '1px solid #666';
    input.style.padding = '5px';
    input.style.boxSizing = 'border-box';
    return input;
  }

  function link(href, text) {
    var a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = text;
    a.style.color = '#8fbf8f';
    return a;
  }

  function close() {
    if (overlay) { overlay.remove(); overlay = null; }
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function openAuth(mode) {
    close();
    var signup = mode === 'register';

    overlay = el('div', {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.75)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: '10000',
    });

    var panel = el('div', {
      background: '#000', color: '#e8e8e8', border: '1px solid #e8e8e8',
      padding: '16px', width: 'min(420px, 92vw)', fontFamily: FONT,
      display: 'flex', flexDirection: 'column', gap: '10px',
    });

    var head = el('div', { display: 'flex', justifyContent: 'space-between' });
    head.appendChild(el('div', { fontWeight: 'bold', letterSpacing: '2px' },
      signup ? '▓ РЕГИСТРАЦИЯ ▓' : '▓ ВХОД ▓'));
    var x = el('button', btnStyle(), '[X]');
    x.onclick = close;
    head.appendChild(x);
    panel.appendChild(head);

    var email = field('email', 'почта');
    var pass = field('password', signup ? 'пароль, не короче 8 символов' : 'пароль');
    panel.appendChild(email);
    panel.appendChild(pass);

    var hint = el('div', { fontSize: '12px', opacity: '0.75', minHeight: '16px' }, '');
    panel.appendChild(hint);

    var actions = el('div', { display: 'flex', gap: '8px', alignItems: 'center' });

    var go = el('button', btnStyle(), signup ? '[Зарегистрироваться]' : '[Войти]');
    go.onclick = function () {
      hint.textContent = 'Проверяю…';
      go.disabled = true;
      (signup ? register : login)(email.value.trim(), pass.value)
        .then(function (data) {
          var claimed = data.user && data.user.claimed_works;
          close();
          if (claimed) {
            // Главное, что человек хочет знать после регистрации:
            // его работы на месте.
            alert('Готово. Работ перенесено в вашу учётную запись: ' + claimed);
          }
        })
        .catch(function (err) {
          hint.textContent = err.message;
          go.disabled = false;
        });
    };
    actions.appendChild(go);

    var swap = el('button', btnStyle(),
      signup ? '[У меня уже есть вход]' : '[Регистрация]');
    swap.onclick = function () { openAuth(signup ? 'login' : 'register'); };
    actions.appendChild(swap);

    panel.appendChild(actions);

    panel.appendChild(el('div', { fontSize: '11px', opacity: '0.65' },
      'Без входа сервис тоже работает — просто работы будут видны '
      + 'только в этом браузере.'));

    // Согласие спрашиваем при регистрации, а не прячем в мелкий шрифт:
    // человек должен понимать, что его тексты уходят на обработку.
    if (signup) {
      var legal = el('div', { fontSize: '11px', opacity: '0.7',
                              lineHeight: '1.5' });
      legal.appendChild(document.createTextNode('Регистрируясь, вы '
        + 'принимаете '));
      legal.appendChild(link('/legal/oferta.html', 'оферту'));
      legal.appendChild(document.createTextNode(' и '));
      legal.appendChild(link('/legal/privacy.html',
        'политику конфиденциальности'));
      legal.appendChild(document.createTextNode('.'));
      panel.appendChild(legal);
    }

    overlay.appendChild(panel);
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) close();
    });
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    email.focus();

    // Enter в любом поле запускает вход: заставлять целиться в кнопку
    // невежливо.
    [email, pass].forEach(function (f) {
      f.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') go.click();
      });
    });
  }

  /** Проверяет сохранённый токен. Просроченный молча забываем. */
  function refresh() {
    if (!token() && !window.__studToken) return Promise.resolve(null);
    return fetch('/api/v1/auth/me', { headers: authHeaders() })
      .then(function (r) {
        if (r.status === 401) { forget(); return null; }
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        if (data) {
          try { localStorage.setItem(USER_KEY, JSON.stringify(data)); } catch (e) {}
          notify();
        }
        return data;
      })
      .catch(function () { return null; });
  }

  window.StudAuth = {
    openAuth: openAuth,
    login: login,
    register: register,
    logout: logout,
    user: user,
    token: token,
    authHeaders: authHeaders,
    onChange: onChange,
    refresh: refresh,
  };
})();
