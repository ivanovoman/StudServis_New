/**
 * Оплата.
 *
 * Показывает тарифы и уводит на страницу ЮKassa. Сама оплата проходит
 * на их стороне — реквизиты карты сюда не попадают и попадать не
 * должны: это избавляет сервис от требований PCI DSS.
 *
 * После оплаты человек возвращается обратно. Начисление происходит не
 * по факту возвращения, а по уведомлению от ЮKassa серверу: вернуться
 * можно и не заплатив, просто закрыв вкладку оплаты.
 */
(function () {
  'use strict';

  var FONT = "'Courier New', monospace";
  var overlay = null;

  function el(tag, style, text) {
    var node = document.createElement(tag);
    if (style) for (var k in style) node.style[k] = style[k];
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function btnStyle() {
    return {
      background: '#000', color: '#e8e8e8', border: '1px solid #e8e8e8',
      padding: '5px 12px', cursor: 'pointer', fontFamily: FONT, fontSize: '13px',
    };
  }

  function headers() {
    var h = { 'Content-Type': 'application/json' };
    if (window.StudAuth) Object.assign(h, window.StudAuth.authHeaders());
    return h;
  }

  function close() {
    if (overlay) { overlay.remove(); overlay = null; }
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function openPayments() {
    close();

    overlay = el('div', {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.75)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: '10000',
    });

    var panel = el('div', {
      background: '#000', color: '#e8e8e8', border: '1px solid #e8e8e8',
      padding: '16px', width: 'min(560px, 94vw)', maxHeight: '86vh',
      overflow: 'auto', fontFamily: FONT,
      display: 'flex', flexDirection: 'column', gap: '10px',
    });

    var head = el('div', { display: 'flex', justifyContent: 'space-between' });
    head.appendChild(el('div', { fontWeight: 'bold', letterSpacing: '2px' }, '▓ ОПЛАТА ▓'));
    var x = el('button', btnStyle(), '[X]');
    x.onclick = close;
    head.appendChild(x);
    panel.appendChild(head);

    var status = el('div', { fontSize: '12px', opacity: '0.8' }, 'Загружаю…');
    panel.appendChild(status);

    var list = el('div', { display: 'flex', flexDirection: 'column', gap: '8px' });
    panel.appendChild(list);

    panel.appendChild(el('div', {
      fontSize: '11px', opacity: '0.7', borderTop: '1px solid #444',
      paddingTop: '8px',
    }, 'Анализ темы и план работы бесплатны и без ограничений. '
     + 'Платные — сборка работы целиком и выгрузка в Word.'));

    overlay.appendChild(panel);
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) close();
    });
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);

    load(status, list);
  }

  function load(status, list) {
    var user = window.StudAuth && window.StudAuth.user();
    if (!user) {
      status.textContent = 'Чтобы оплатить, нужно войти: покупка '
        + 'привязывается к учётной записи, иначе она потеряется вместе '
        + 'с браузером.';
      var enter = el('button', btnStyle(), '[Войти]');
      enter.onclick = function () { close(); window.StudAuth.openAuth('login'); };
      list.appendChild(enter);
      return;
    }

    Promise.all([
      fetch('/api/v1/payments/tariffs').then(function (r) { return r.json(); }),
      fetch('/api/v1/payments/access', { headers: headers() })
        .then(function (r) { return r.ok ? r.json() : null; }),
    ]).then(function (res) {
      var data = res[0];
      var access = res[1];

      status.textContent = describeAccess(access);
      if (!data.configured) {
        status.textContent += ' Приём платежей ещё не подключён — '
          + 'сборка пока доступна без оплаты.';
      }

      list.innerHTML = '';
      data.tariffs.forEach(function (t) {
        list.appendChild(tariffRow(t, data.configured, status));
      });
    }).catch(function (e) {
      status.textContent = 'Не удалось загрузить тарифы: ' + e.message;
    });
  }

  function describeAccess(access) {
    if (!access) return '';
    if (access.subscription_active) {
      var until = access.subscription_until
        ? new Date(access.subscription_until).toLocaleDateString('ru-RU') : '';
      return 'Подписка действует' + (until ? ' до ' + until : '') + '.';
    }
    if (access.works_left > 0) {
      return 'Оплачено работ: ' + access.works_left + '.';
    }
    return 'Оплаченных работ нет.';
  }

  function tariffRow(tariff, configured, status) {
    var row = el('div', {
      border: '1px solid #555', padding: '10px',
      display: 'flex', justifyContent: 'space-between', gap: '12px',
      alignItems: 'center',
    });

    var left = el('div', {});
    left.appendChild(el('div', { fontWeight: 'bold' }, tariff.title));
    left.appendChild(el('div', { fontSize: '12px', opacity: '0.8' },
      tariff.description));
    row.appendChild(left);

    var pay = el('button', btnStyle(), '[' + tariff.price + ' ₽]');
    pay.disabled = !configured;
    if (!configured) pay.style.opacity = '0.5';
    pay.onclick = function () {
      pay.disabled = true;
      status.textContent = 'Создаю платёж…';
      fetch('/api/v1/payments/create', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ tariff: tariff.code, return_url: location.href }),
      })
        .then(function (r) {
          return r.json().then(function (d) {
            if (!r.ok) throw new Error(d.detail || ('Ошибка ' + r.status));
            return d;
          });
        })
        .then(function (d) {
          // Уводим на страницу ЮKassa. Реквизиты карты вводятся там.
          location.href = d.confirmation_url;
        })
        .catch(function (e) {
          status.textContent = e.message;
          pay.disabled = false;
        });
    };
    row.appendChild(pay);
    return row;
  }

  window.StudPayments = { openPayments: openPayments };
})();
