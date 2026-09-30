/**
 * Учётная запись, сохранённые работы и оплата в современном интерфейсе.
 *
 * Все три модуля на бэкенде были готовы давно, но подключены только к
 * ретро-версии. Когда ретро перестал быть рабочим интерфейсом, они
 * пропали из продукта целиком: войти было некуда, собранная работа
 * никуда не сохранялась, заплатить было нечем.
 *
 * Вход добровольный. Разбор темы и план обязаны работать без учётной
 * записи — это бесплатные функции, и требовать за них регистрацию
 * нельзя. Учётная запись даёт другое: работы видны с любого
 * устройства, а оплата привязана к человеку, а не к браузеру.
 *
 * Экспортируется как window.ModernAccount.
 */
(function () {
  'use strict';

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = window.StudCore.ownerHeaders(opts.headers || {});
    return fetch(path, opts).then(function (r) {
      return r.text().then(function (body) {
        var data = {};
        try { data = body ? JSON.parse(body) : {}; } catch (e) { data = {}; }
        if (!r.ok) {
          throw new Error(data.detail || data.error || ('сервер ответил ' + r.status));
        }
        return data;
      });
    });
  }

  // ------------------------------------------------- состояние входа

  var me = null;          // {email, display_name} или null
  var onChange = [];

  function notify() {
    onChange.forEach(function (fn) { fn(me); });
  }

  /** Кто вошёл. Молча терпит отсутствие бэкенда: вход не обязателен. */
  function refresh() {
    if (!window.StudCore.getToken()) {
      me = null;
      notify();
      return Promise.resolve(null);
    }
    return api('/api/v1/auth/me')
      .then(function (d) { me = d.user || d; notify(); return me; })
      .catch(function () {
        // Токен протух или бэкенд молчит — считаем, что не вошли.
        window.StudCore.setToken('');
        me = null;
        notify();
        return null;
      });
  }

  function current() { return me; }
  function subscribe(fn) { onChange.push(fn); fn(me); }

  // ------------------------------------------------------- вход

  function openAuth() {
    var shell = window.ModernUI.openShell('Вход в сервис');
    var body = shell.body;

    body.appendChild(el('div', 'hint',
      'Вход не обязателен: разбор темы и план работают и без него. '
    + 'Учётная запись нужна, чтобы работы открывались с любого '
    + 'устройства и не терялись вместе с браузером.'));

    var tabs = el('div', 'row');
    var tabLogin = el('button', 'btn', 'Войти');
    var tabReg = el('button', 'btn ghost', 'Зарегистрироваться');
    tabs.appendChild(tabLogin);
    tabs.appendChild(tabReg);
    body.appendChild(tabs);

    var form = el('div');
    body.appendChild(form);

    var status = el('div', 'hint');
    body.appendChild(status);

    var mode = 'login';

    function draw() {
      form.textContent = '';
      tabLogin.className = mode === 'login' ? 'btn' : 'btn ghost';
      tabReg.className = mode === 'register' ? 'btn' : 'btn ghost';

      var name = null;
      if (mode === 'register') {
        var nrow = el('div', 'frow');
        nrow.appendChild(el('label', 'field', 'Как к вам обращаться'));
        name = el('input');
        name.type = 'text';
        name.placeholder = 'Иван';
        nrow.appendChild(name);
        form.appendChild(nrow);
      }

      var erow = el('div', 'frow');
      erow.appendChild(el('label', 'field', 'Почта'));
      var email = el('input');
      email.type = 'text';
      email.placeholder = 'student@example.ru';
      erow.appendChild(email);
      form.appendChild(erow);

      var prow = el('div', 'frow');
      prow.appendChild(el('label', 'field', 'Пароль'));
      var pass = el('input');
      pass.type = 'password';
      prow.appendChild(pass);
      form.appendChild(prow);

      var row = el('div', 'row');
      var go = el('button', 'btn',
        mode === 'login' ? 'Войти' : 'Создать учётную запись');
      row.appendChild(go);
      form.appendChild(row);

      function submit() {
        var payload = {
          email: email.value.trim(),
          password: pass.value,
          // Ключ устройства отдаём серверу: он привяжет к учётной
          // записи работы, собранные до входа.
          owner_key: window.StudCore.ownerKey(),
        };
        if (!payload.email || !payload.password) {
          status.textContent = 'Заполните почту и пароль.';
          return;
        }
        if (mode === 'register') payload.display_name = name.value.trim();

        go.disabled = true;
        status.textContent = 'Отправляю…';

        api('/api/v1/auth/' + (mode === 'login' ? 'login' : 'register'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then(function (d) {
            window.StudCore.setToken(d.token);
            me = d.user;
            notify();
            var claimed = d.user && d.user.claimed;
            status.textContent = claimed
              ? 'Готово. Перенесено работ: ' + claimed
              : 'Готово.';
            setTimeout(shell.close, 600);
          })
          .catch(function (e) {
            go.disabled = false;
            status.textContent = e.message;
          });
      }

      go.onclick = submit;
      [email, pass].concat(name ? [name] : []).forEach(function (f) {
        f.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
        });
      });
      email.focus();
    }

    tabLogin.onclick = function () { mode = 'login'; draw(); };
    tabReg.onclick = function () { mode = 'register'; draw(); };
    draw();
  }

  function openProfile() {
    var shell = window.ModernUI.openShell('Учётная запись');
    var body = shell.body;

    body.appendChild(el('div', 'score', me.display_name || me.email));
    if (me.display_name) body.appendChild(el('div', 'hint', me.email));

    var row = el('div', 'row');
    var out = el('button', 'btn ghost', 'Выйти');
    row.appendChild(out);
    body.appendChild(row);

    var status = el('div', 'hint');
    body.appendChild(status);

    out.onclick = function () {
      out.disabled = true;
      api('/api/v1/auth/logout', { method: 'POST' })
        .catch(function () { /* сеанс мог истечь — выходим всё равно */ })
        .then(function () {
          window.StudCore.setToken('');
          me = null;
          notify();
          shell.close();
        });
    };
  }

  // -------------------------------------------------- мои работы

  function human(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear()
         + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function openWorks() {
    var shell = window.ModernUI.openShell('Мои работы');
    var body = shell.body;

    body.appendChild(el('div', 'hint',
      'Работы сохраняются по мере сборки: закрытая вкладка больше не '
    + 'стоит трёх минут работы.'));

    var list = el('div');
    body.appendChild(list);

    list.appendChild(el('div', 'hint', 'Загружаю…'));

    api('/api/v1/works')
      .then(function (d) {
        list.textContent = '';
        if (!d.count) {
          list.appendChild(el('div', 'hint',
            'Пока пусто. Соберите работу — она появится здесь.'));
          return;
        }
        (d.works || []).forEach(function (w) {
          var card = el('div', 'piece');
          card.appendChild(el('div', 'ftitle', w.topic || 'Без темы'));
          var bits = [];
          if (w.status) bits.push(w.status === 'done' ? 'готова'
            : (w.status === 'assembling' ? 'собирается' : 'черновик'));
          if (w.pieces) bits.push('частей: ' + w.pieces);
          if (w.chars) bits.push(w.chars + ' знаков');
          if (w.updated_at) bits.push(human(w.updated_at));
          card.appendChild(el('div', 'hint', bits.join(' · ')));

          var row = el('div', 'row');
          var open = el('button', 'btn ghost', 'Скачать .docx');
          row.appendChild(open);
          var del = el('button', 'btn ghost', 'Удалить');
          row.appendChild(del);
          var st = el('span', 'status');
          row.appendChild(st);
          card.appendChild(row);

          open.onclick = function () {
            st.textContent = 'Собираю файл…';
            api('/api/v1/works/' + w.id)
              .then(function (full) {
                if (!(full.pieces || []).length) {
                  throw new Error('в работе нет частей');
                }
                var settings = {};
                try {
                  settings = JSON.parse(full.settings_json || '{}') || {};
                } catch (e) { settings = {}; }
                settings.topic = settings.topic || full.topic || '';
                return window.StudCore.exportFullDocx(full.pieces,
                  { settings: settings, topic: full.topic });
              })
              .then(function () { st.textContent = 'Скачано'; })
              .catch(function (e) { st.textContent = e.message; });
          };

          del.onclick = function () {
            del.disabled = true;
            st.textContent = 'Удаляю…';
            api('/api/v1/works/' + w.id, { method: 'DELETE' })
              .then(function () { card.remove(); })
              .catch(function (e) {
                del.disabled = false;
                st.textContent = e.message;
              });
          };

          list.appendChild(card);
        });
      })
      .catch(function (e) {
        list.textContent = '';
        list.appendChild(el('div', 'warn-line',
          'Список не загрузился: ' + e.message
        + '. Проверьте, что запущен Python-бэкенд на порту 8000.'));
      });
  }

  // ------------------------------------------------------- оплата

  function openPayments() {
    var shell = window.ModernUI.openShell('Оплата');
    var body = shell.body;

    var status = el('div', 'hint', 'Загружаю тарифы…');
    body.appendChild(status);

    var list = el('div');
    body.appendChild(list);

    Promise.all([
      api('/api/v1/payments/tariffs'),
      api('/api/v1/payments/access').catch(function () { return null; }),
    ])
      .then(function (res) {
        var tariffs = res[0];
        var access = res[1];
        status.textContent = '';

        if (access) {
          var bits = [];
          if (access.works_left != null) bits.push('доступно работ: ' + access.works_left);
          if (access.until) bits.push('подписка до ' + human(access.until));
          if (bits.length) {
            body.insertBefore(el('div', 'ok-line', bits.join(', ')), list);
          }
        }

        var items = tariffs.tariffs || tariffs.items || [];
        if (!items.length) {
          list.appendChild(el('div', 'hint', 'Тарифы не настроены.'));
          return;
        }

        // Пока в .env нет ключей ЮKassa, платёж создать нельзя. Лучше
        // сказать об этом заранее, чем дать кнопку, которая ответит
        // ошибкой после нажатия.
        var ready = tariffs.configured !== false;
        if (!ready) {
          list.appendChild(el('div', 'warn-line',
            'Приём платежей ещё не подключён: нет ключей ЮKassa. '
          + 'Тарифы показаны для ознакомления.'));
        }

        items.forEach(function (t) {
          var card = el('div', 'piece');
          card.appendChild(el('div', 'ftitle',
            t.title + ' — ' + t.price + ' ₽'));
          if (t.description) card.appendChild(el('div', 'hint', t.description));

          var row = el('div', 'row');
          var pay = el('button', 'btn', 'Оплатить');
          if (!ready) pay.disabled = true;
          row.appendChild(pay);
          var st = el('span', 'status');
          row.appendChild(st);
          card.appendChild(row);

          pay.onclick = function () {
            if (!me) {
              st.textContent = 'Сначала войдите: оплата привязывается '
                             + 'к учётной записи.';
              return;
            }
            pay.disabled = true;
            st.textContent = 'Создаю платёж…';
            api('/api/v1/payments/create', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tariff: t.code || t.id }),
            })
              .then(function (d) {
                if (d.confirmation_url) window.location.href = d.confirmation_url;
                else { pay.disabled = false; st.textContent = 'Ссылка на оплату не пришла'; }
              })
              .catch(function (e) {
                pay.disabled = false;
                st.textContent = e.message;
              });
          };

          list.appendChild(card);
        });
      })
      .catch(function (e) {
        status.textContent = '';
        // Без ключей ЮKassa модуль отвечает ошибкой — это не поломка,
        // а нерабочая пока оплата. Говорим об этом прямо.
        list.appendChild(el('div', 'warn-line',
          'Оплата пока не настроена: ' + e.message));
      });
  }

  window.ModernAccount = {
    refresh: refresh,
    current: current,
    subscribe: subscribe,
    openAuth: openAuth,
    openProfile: openProfile,
    openWorks: openWorks,
    openPayments: openPayments,
  };
})();
