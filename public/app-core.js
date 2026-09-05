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
         short: 'Три главы с параграфами и логикой переходов',
         docTitle: 'План работы', free: true, needsSettings: true,
         placeholder: 'Вставьте анализ темы или укажите тему' },

    3: { step: 'introduction', title: 'Введение',
         short: 'Актуальность, объект, предмет, цель и задачи',
         docTitle: 'Введение', needsSettings: true,
         placeholder: 'Вставьте план работы' },

    4: { step: null, title: 'Собрать курсовую',
         short: 'Полная сборка работы по готовому плану' },

    5: { step: null, title: 'Подобрать источники',
         short: 'Публикации из открытого доступа с проверкой ссылок' },

    6: { step: null, title: 'Оформить по ГОСТ',
         short: 'Поля, шрифты, нумерация, список литературы' },

    7: { step: null, title: 'Проверить на ИИ',
         short: 'Оценка машинности текста и советы по правке' },

    8: { step: 'speech', title: 'Речь для защиты',
         short: 'Доклад на 7 минут и вопросы комиссии с ответами',
         docTitle: 'Речь для защиты', needsSettings: true,
         placeholder: 'Вставьте текст готовой работы' },
  };

  /**
   * Читает SSE-поток генерации.
   *
   * @param {object} opts
   *   step    — идентификатор шага для бэкенда
   *   input   — текст пользователя
   *   onDelta — очередной кусок текста
   *   onEvent — служебное событие: список источников или предупреждение
   *   onDone  — завершение; аргумент не пуст, если произошла ошибка
   */
  function generate(opts) {
    fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: opts.step, input: opts.input }),
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

  window.StudCore = {
    STEPS: STEPS,
    generate: generate,
    exportDocx: exportDocx,
  };
})();
