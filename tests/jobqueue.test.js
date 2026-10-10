'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createQueue } = require('../api/jobqueue');

const tick = () => new Promise((r) => setTimeout(r, 10));

test('свободный слот отдаётся сразу, без ожидания', async () => {
  const q = createQueue({ limit: 1 });
  const release = await q.acquire();
  assert.deepStrictEqual(q.stats().running, 1);
  assert.deepStrictEqual(q.stats().waiting, 0);
  release();
});

test('второй запрос встаёт в очередь и узнаёт своё место', async () => {
  const q = createQueue({ limit: 1 });
  const seen = [];
  const r1 = await q.acquire();
  const p2 = q.acquire((place, total) => seen.push([place, total]));
  await tick();

  assert.strictEqual(q.stats().waiting, 1);
  assert.deepStrictEqual(seen[0], [1, 1], 'ждущий должен узнать место сразу');

  r1();
  const r2 = await p2;
  assert.strictEqual(q.stats().waiting, 0);
  r2();
});

test('места пересчитываются, когда очередь двигается', async () => {
  const q = createQueue({ limit: 1 });
  const third = [];
  const r1 = await q.acquire();
  const p2 = q.acquire(() => {});
  const p3 = q.acquire((place) => third.push(place));
  await tick();

  assert.deepStrictEqual(third, [2], 'третий изначально второй в очереди');

  r1();
  const r2 = await p2;
  await tick();
  assert.deepStrictEqual(third, [2, 1], 'после ухода первого третий сдвинулся');

  r2();
  const r3 = await p3;
  r3();
  assert.strictEqual(q.stats().running, 0);
});

test('переполненная очередь отказывает понятной ошибкой', async () => {
  const q = createQueue({ limit: 1, maxWaiting: 1 });
  const r1 = await q.acquire();
  const p2 = q.acquire(() => {});
  await tick();

  await assert.rejects(
    () => q.acquire(() => {}),
    (e) => {
      assert.strictEqual(e.code, 'QUEUE_FULL');
      assert.match(e.message, /очеред/i, 'текст ошибки должен быть для человека');
      return true;
    },
  );

  r1();
  (await p2)();
});

test('несколько слотов работают параллельно', async () => {
  const q = createQueue({ limit: 3 });
  const r1 = await q.acquire();
  const r2 = await q.acquire();
  const r3 = await q.acquire();
  assert.strictEqual(q.stats().running, 3);

  let started = false;
  const p4 = q.acquire(() => { started = true; });
  await tick();
  assert.ok(started, 'четвёртый обязан ждать');

  r1(); r2(); r3();
  (await p4)();
});

test('повторное освобождение не списывает чужой слот', async () => {
  const q = createQueue({ limit: 2 });
  const first = await q.acquire();
  const second = await q.acquire();
  assert.strictEqual(q.stats().running, 2);

  // Обрыв соединения и ошибка приходят оба — освобождение вызывается
  // дважды. Второй вызов обязан быть пустым, иначе он освободит слот
  // соседней задачи и работ пойдёт больше лимита.
  first();
  first();
  assert.strictEqual(q.stats().running, 1, 'второй захват должен уцелеть');

  second();
  assert.strictEqual(q.stats().running, 0);

  // Слоты после этого обязаны остаться рабочими: отрицательный счётчик
  // раньше позволял бы запускать больше задач, чем разрешено.
  const a = await q.acquire();
  const b = await q.acquire();
  assert.strictEqual(q.stats().running, 2);
  let waited = false;
  const c = q.acquire(() => { waited = true; });
  await tick();
  assert.ok(waited, 'третий при лимите 2 обязан ждать');
  a(); b();
  (await c)();
});
