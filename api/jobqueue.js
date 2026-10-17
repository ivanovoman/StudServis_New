/**
 * Очередь тяжёлых задач.
 *
 * Сборка работы занимает три минуты и всё это время держит соединение
 * с языковой моделью. Пока пользователь один, это незаметно. Двое
 * одновременно — и провайдер начинает отвечать ошибками лимита: у
 * бесплатных моделей ограничение на параллельные запросы жёсткое, а
 * GigaChat при перегрузе просто рвёт поток. Снаружи это выглядит как
 * «сервис сломался посреди работы».
 *
 * Поэтому тяжёлые операции идут по очереди. Тот, кто не поместился,
 * не получает отказ: он встаёт в очередь и видит своё место. Это
 * прямо прописано в задании — предупреждать пользователя об ожидании,
 * а не молчать и не обрывать.
 *
 * Очередь живёт в памяти процесса. Для одного сервера этого довольно;
 * когда серверов станет несколько, место этой реализации займёт
 * Celery с Redis, но тогда и инфраструктура будет другая.
 */
'use strict';

const DEFAULT_LIMIT = Number(process.env.MAX_PARALLEL_JOBS || 1);
const DEFAULT_MAX_WAIT = Number(process.env.MAX_QUEUE_LENGTH || 20);

function createQueue(opts = {}) {
  const limit = Math.max(1, Number(opts.limit || DEFAULT_LIMIT));
  const maxWaiting = Math.max(1, Number(opts.maxWaiting || DEFAULT_MAX_WAIT));

  let running = 0;
  const waiting = [];     // [{resolve, reject, onPlace, cancelled}]

  /** Сообщаем каждому ждущему его место: первый в очереди — место 1. */
  function notifyPlaces() {
    waiting.forEach((item, index) => {
      if (item.cancelled) return;
      const place = index + 1;
      if (item.lastPlace === place) return;
      item.lastPlace = place;
      try {
        item.onPlace(place, waiting.length);
      } catch (e) {
        // Клиент мог отвалиться: это не повод ронять очередь.
      }
    });
  }

  function pump() {
    while (running < limit && waiting.length) {
      const item = waiting.shift();
      if (item.cancelled) continue;
      running += 1;
      item.resolve();
    }
    notifyPlaces();
  }

  /**
   * Занять место под тяжёлую задачу.
   *
   * @param {function} onPlace  вызывается при изменении места в очереди
   * @returns {Promise<function>} освобождающая функция; вызвать в finally
   */
  /**
   * Освобождающая функция делается персональной на каждый захват.
   * Общая на всю очередь опасна: повторный вызов (а он случается —
   * ошибка и обрыв соединения приходят оба) списал бы чужой слот, и
   * задач пошло бы больше лимита.
   */
  function makeRelease() {
    let used = false;
    return function releaseOnce() {
      if (used) return;
      used = true;
      running = Math.max(0, running - 1);
      pump();
    };
  }

  function acquire(onPlace) {
    if (running < limit) {
      running += 1;
      return Promise.resolve(makeRelease());
    }

    if (waiting.length >= maxWaiting) {
      const err = new Error(
        'Сейчас слишком много работ в очереди. Попробуйте через '
        + 'несколько минут.');
      err.code = 'QUEUE_FULL';
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      const item = {
        onPlace: onPlace || (() => {}),
        cancelled: false,
        lastPlace: null,
        resolve: () => resolve(makeRelease()),
        reject,
      };
      waiting.push(item);
      // Место сообщаем сразу: ожидание без объяснения читается как
      // зависший сервис.
      notifyPlaces();
    });
  }

  function stats() {
    return { running, waiting: waiting.length, limit, maxWaiting };
  }

  return { acquire, stats };
}

module.exports = { createQueue };
