/**
 * Общее ядро для обоих интерфейсов — ретро и современного.
 *
 * Здесь живёт всё, что не зависит от оформления: описание шагов,
 * чтение SSE-потока генерации и выгрузка результата в .docx. Раньше
 * это лежало внутри app.js вперемешку с рисованием ретро-окон, и
 * второй интерфейс пришлось бы писать копипастой — с риском, что
 * починка бага в одном месте не доедет до другого.
 *
 * Экспортируется как window.StudCore.
 */
(function () {
  'use strict';

  /**
   * Шаги протокола. null означает, что бэкенд ещё не умеет этот пункт.
   *
   * needsSettings — нужны ли пункту настройки работы. Их требуют шаги,
   * которые пишут текст: им важны тема, вуз, методичка, объёмы.
   */
  var STEPS = {
    1: { step: 'analysis', title: 'Анализ проблемы',
         short: 'Ядро исследования, спорные места, направления поиска',
         docTitle: 'Анализ проблемы', free: true, needsSettings: true,
         placeholder: 'Тема работы. Например: Коллизии в праве' },

    2: { step: 'plan', title: 'План работы',
         short: 'Главы с параграфами и логикой переходов',
         docTitle: 'План работы', free: true, needsSettings: true,
         placeholder: 'Вставьте анализ темы или укажите тему' },

    3: { step: 'introduction', title: 'Введение',
         short: 'Актуальность, объект, предмет, цель и задачи',
         docTitle: 'Введение', needsSettings: true,
         placeholder: 'Вставьте план работы' },

    4: { assemble: true, title: 'Написать работу',
         short: 'По разделам с правкой или сборка целиком',
         needsSettings: true },

    5: { tool: 'sources', title: 'Подобрать источники',
         short: 'Публикации из открытого доступа с проверкой ссылок',
         needsSettings: true },

    6: { tool: 'gost', title: 'Оформить по ГОСТ',
         short: 'Поля, шрифты, нумерация, список литературы' },

    7: { tool: 'detector', title: 'Проверить на ИИ',
         short: 'Оценка машинности текста и советы по правке' },

    8: { step: 'speech', title: 'Речь для защиты',
         short: 'Доклад на 7 минут и вопросы комиссии с ответами',
         docTitle: 'Речь для защиты', needsSettings: true,
         placeholder: 'Вставьте текст готовой работы' },
  };



  // -------------------------------------- владелец работ и вход

  var OWNER_KEY_NAME = 'studrabots.ownerKey';
  var TOKEN_KEY = 'studrabots.token';

  /**
   * Ключ устройства: по нему сервер узнаёт работы, собранные до входа.
   *
   * Вход добровольный — бесплатные функции не должны требовать учётной
   * записи. Поэтому владельцем сначала выступает браузер, а при входе
   * накопленные работы привязываются к учётной записи (claim_works на
   * стороне бэкенда).
   */
  function ownerKey() {
    try {
      var key = localStorage.getItem(OWNER_KEY_NAME) || '';
      if (!key) {
        if (window.crypto && crypto.randomUUID) {
          key = crypto.randomUUID().replace(/-/g, '');
        } else {
          key = String(Date.now())
              + Math.random().toString(16).slice(2)
              + Math.random().toString(16).slice(2);
        }
        localStorage.setItem(OWNER_KEY_NAME, key);
      }
      return key;
    } catch (e) {
      // Приватный режим: работы соберутся, но после перезагрузки к ним
      // уже не вернуться — ключ будет другой.
      if (!window.__studTempKey) {
        window.__studTempKey = 'temp' + String(Date.now())
                             + Math.random().toString(16).slice(2);
      }
      return window.__studTempKey;
    }
  }

  function getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch (e) {
      return window.__studToken || '';
    }
  }

  function setToken(token) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {
      window.__studToken = token || '';
    }
  }

  /**
   * Заголовки владельца для запросов к бэкенду.
   *
   * X-Owner-Key нужен всегда, Authorization — только если вошли.
   * Node пересылает в Python лишь явно перечисленные заголовки, эти
   * два в списке есть.
   */
  function ownerHeaders(extra) {
    var h = extra || {};
    h['X-Owner-Key'] = ownerKey();
    var token = getToken();
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }

  // ------------------------------------------------- настройки работы

  var SETTINGS_KEY = 'studrabots.settings';

  var DEFAULTS = {
    topic: '',
    university: '',
    methodichka: '',
    wishes: '',
    // null — «решает модель по теме» (2 или 3 главы). Жёстко
    // фиксировать тройку нельзя: курсовая бывает и двухглавой, а
    // методичка вуза может прямо требовать две.
    chapters: null,
  };

  var settings = load();

  /**
   * Настройки переживают перезагрузку страницы.
   *
   * Раньше они жили в памяти вкладки и вдобавок у каждого интерфейса
   * были свои: человек заполнял вуз и пожелания в ретро, переходил в
   * современный вид — и генерация шла без них, молча и с худшим
   * результатом. Теперь значение одно на оба интерфейса.
   */
  function load() {
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { out[k] = DEFAULTS[k]; });
    try {
      var saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      Object.keys(DEFAULTS).forEach(function (k) {
        if (saved[k] !== undefined && saved[k] !== null) out[k] = saved[k];
      });
    } catch (e) {
      // Битое или недоступное хранилище — работаем на умолчаниях.
    }
    return out;
  }

  function getSettings() {
    var copy = {};
    Object.keys(settings).forEach(function (k) { copy[k] = settings[k]; });
    return copy;
  }

  function saveSettings(patch) {
    Object.keys(patch || {}).forEach(function (k) {
      if (k in DEFAULTS) settings[k] = patch[k];
    });
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      // Приватный режим браузера: настройки проживут хотя бы вкладку.
    }
    return getSettings();
  }

  /**
   * Читает SSE-поток генерации.
   *
   * @param {object} opts
   *   step     — идентификатор шага для бэкенда
   *   input    — текст пользователя
   *   settings — настройки работы: тема, вуз, методичка, пожелания,
   *              число глав. Без них модель не знает требований
   *              заказчика и решает всё за него
   *   onDelta — очередной кусок текста
   *   onEvent — служебное событие: список источников или предупреждение
   *   onDone  — завершение; аргумент не пуст, если произошла ошибка
   */
  function generate(opts) {
    fetch('/api/generate', {
      method: 'POST',
      headers: ownerHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        step: opts.step,
        input: opts.input,
        settings: opts.settings || {},
      }),
    }).then(function (res) {
      if (!res.ok) {
        return res.json().then(function (j) {
          throw new Error(j.error || ('HTTP ' + res.status));
        });
      }

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { opts.onDone(null); return; }

          buffer += decoder.decode(r.value, { stream: true });
          var lines = buffer.split('\n');
          // Последняя строка может быть обрезана на границе чанка.
          buffer = lines.pop();

          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.indexOf('data:') !== 0) continue;

            var data = line.slice(5).trim();
            if (data === '[DONE]') continue;

            try {
              var parsed = JSON.parse(data);
              if (parsed.error) { opts.onDone(parsed.error); return; }
              if (parsed.delta && opts.onDelta) opts.onDelta(parsed.delta);
              if (opts.onEvent && (parsed.sources || parsed.notice)) {
                opts.onEvent(parsed);
              }
            } catch (e) {
              // Служебные строки потока (комментарии keep-alive).
            }
          }
          return pump();
        });
      }
      return pump();
    }).catch(function (e) {
      opts.onDone(e.message);
    });
  }

  /** Собирает .docx на сервере и отдаёт браузеру на скачивание. */

  /**
   * Читает поток событий SSE и отдаёт их разобранными.
   *
   * Тем же механизмом работают генерация шага и сборка работы, поэтому
   * разбор потока живёт в одном месте: сборка идёт ~3 минуты, и
   * вторая копия этого кода разошлась бы с первой на первой же правке.
   *
   * @param {string} url     адрес обработчика
   * @param {object} body    тело запроса
   * @param {function} onEvent  разобранный объект события
   * @param {function} onDone   завершение; аргумент не пуст при ошибке
   */
  function stream(url, body, onEvent, onDone) {
    fetch(url, {
      method: 'POST',
      headers: ownerHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    }).then(function (res) {
      if (!res.ok) {
        return res.json().then(function (j) {
          throw new Error(j.error || ('HTTP ' + res.status));
        });
      }

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { onDone(null); return; }

          buffer += decoder.decode(r.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop();

          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.indexOf('data:') !== 0) continue;
            var payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              onEvent(JSON.parse(payload));
            } catch (e) {
              // Битая строка события не повод ронять всю сборку.
            }
          }
          return pump();
        });
      }

      return pump();
    }).catch(function (e) {
      onDone(e.message || String(e));
    });
  }

  function exportDocx(title, text) {
    return fetch('/api/export-docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title, text: text, isH1: true }),
    }).then(function (r) {
      if (!r.ok) {
        return r.json().then(function (j) {
          throw new Error(j.error || ('HTTP ' + r.status));
        });
      }
      return r.blob();
    }).then(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = title.slice(0, 60) + '.docx';
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }


  /**
   * Собирает .docx всей работы из её частей.
   *
   * Эндпоинт ждёт введение и заключение отдельно от разделов, а
   * заголовки — словарём по номерам, иначе документ получится слитным
   * текстом без структуры по ГОСТ. Раскладка одна и та же и после
   * сборки, и при скачивании сохранённой работы, поэтому живёт здесь:
   * разошлись бы — один из путей молча отдавал бы кривой файл.
   *
   * @param {Array} pieces   части работы: {kind, number, heading, text}
   * @param {object} opts    {settings, sources}
   */
  function exportFullDocx(pieces, opts) {
    opts = opts || {};
    var settings = opts.settings || getSettings();

    var intro = '';
    var conclusion = '';
    var sections = [];
    var sectionTitles = {};

    (pieces || []).forEach(function (p) {
      if (p.kind === 'introduction') intro = p.text;
      else if (p.kind === 'conclusion') conclusion = p.text;
      else {
        sections.push({ number: p.number, text: p.text, table: p.table });
        if (p.heading) {
          sectionTitles[p.number] = String(p.heading).replace(/^[\d.]+\s*/, '');
        }
      }
    });

    var topic = settings.topic || opts.topic || 'Курсовая работа';

    return fetch('/api/export-docx-full', {
      method: 'POST',
      headers: ownerHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        topic: topic,
        introduction: intro,
        sections: sections,
        conclusion: conclusion,
        sectionTitles: sectionTitles,
        sources: opts.sources || [],
        titlePage: {
          topic: topic,
          university: settings.university || '',
        },
      }),
    }).then(function (r) {
      if (!r.ok) {
        return r.json().then(function (j) {
          throw new Error(j.error || ('сервер ответил ' + r.status));
        });
      }
      return r.blob();
    }).then(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = topic.slice(0, 60) + '.docx';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
    });
  }

  window.StudCore = {
    STEPS: STEPS,
    generate: generate,
    exportDocx: exportDocx,
    getSettings: getSettings,
    saveSettings: saveSettings,
    stream: stream,
    ownerKey: ownerKey,
    ownerHeaders: ownerHeaders,
    getToken: getToken,
    setToken: setToken,
    exportFullDocx: exportFullDocx,
  };
})();
