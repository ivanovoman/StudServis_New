const test = require('node:test');
const assert = require('node:assert');
const { dossierBlock } = require('../api/dossier.js');

const ОБРАЗЕЦ = {
  heading: 'Понятие коллизии',
  sources: ['Иванов И. И. Статья (Журнал, 2020)'],
  norms: ['ст. 76', 'Конституция РФ'],
  names: ['Тихомиров Ю. А.'],
  excerpts: 2,
  chars: 1200,
  prompt_block: 'ВЫДЕРЖКИ ИЗ ПРОЧИТАННЫХ СТАТЕЙ\n\n[1] Иванов И. И.\n    «текст»',
};

test('пустое досье не даёт блока', () => {
  assert.strictEqual(dossierBlock(null), '');
  assert.strictEqual(dossierBlock({}), '');
  assert.strictEqual(dossierBlock({ prompt_block: '' }), '');
});

test('выдержки попадают в задание', () => {
  const block = dossierBlock(ОБРАЗЕЦ);
  assert.ok(block.includes('ВЫДЕРЖКИ ИЗ ПРОЧИТАННЫХ СТАТЕЙ'));
  assert.ok(block.includes('[1] Иванов И. И.'));
});

test('разрешённые нормы перечислены поимённо', () => {
  const block = dossierBlock(ОБРАЗЕЦ);
  assert.ok(block.includes('ст. 76'));
  assert.ok(block.includes('Конституция РФ'));
  assert.ok(/ЗАПРЕЩЕНО/.test(block), 'прочее должно быть под запретом');
});

test('без норм в источниках запрет становится полным', () => {
  // Это главный случай: в теоретических статьях номеров статей может
  // не быть вовсе, и тогда модели нельзя называть ни одного — иначе
  // она возьмёт их по памяти и ошибётся в привязке.
  const block = dossierBlock({ ...ОБРАЗЕЦ, norms: [] });
  assert.ok(block.includes('называть ЗАПРЕЩЕНО'));
  assert.ok(!block.includes('Нормы, которые можно называть'));
});

test('требование объёма не теряется', () => {
  const block = dossierBlock(ОБРАЗЕЦ);
  assert.ok(/объём раздела выдержи/i.test(block),
    'без этого модель ужимает раздел до пересказа выдержек');
});

test('ссылаться велено номером', () => {
  assert.ok(/\[1\], \[2\]/.test(dossierBlock(ОБРАЗЕЦ)));
});
