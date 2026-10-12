// Названия глав в скачанной работе.
//
// Жалоба заказчика: в .docx стояли голые «ГЛАВА 1», «ГЛАВА 2» без
// названий. Части работы несли только номер и название параграфа, а
// название главы жило в плане и до экспорта не доходило. Тесты проверяют
// и сборщик словаря, и готовый файл — по тексту внутри document.xml.

const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');

const { resolveChapterTitles } = require('../api/outline');
const { generateFullDocx } = require('../api/docxExport');

const PLAN = `
ВВЕДЕНИЕ
ГЛАВА 1. ТЕОРЕТИЧЕСКИЕ ОСНОВЫ ПРАВОВЫХ КОЛЛИЗИЙ
1.1. Понятие и признаки коллизии
1.2. Виды коллизий
**ГЛАВА 2. Способы разрешения коллизий**
2.1. Коллизионные правила
2.2. Роль судебной практики
ЗАКЛЮЧЕНИЕ
СПИСОК ИСПОЛЬЗУЕМЫХ ИСТОЧНИКОВ
`;

const SECTIONS = [
  { number: '1.1', text: 'Текст первого параграфа.' },
  { number: '1.2', text: 'Текст второго параграфа.' },
  { number: '2.1', text: 'Текст третьего параграфа.' },
  { number: '2.2', text: 'Текст четвёртого параграфа.' },
];

async function docText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml').async('string');
  // Абзацы — по строке, внутри абзаца склеиваем куски <w:t>.
  return xml.split('</w:p>')
    .map((p) => [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''))
    .filter(Boolean);
}

test('названия глав берутся из плана, звёздочки и регистр не мешают', () => {
  const t = resolveChapterTitles({ plan: PLAN, sections: SECTIONS });
  assert.strictEqual(t['1'], 'ТЕОРЕТИЧЕСКИЕ ОСНОВЫ ПРАВОВЫХ КОЛЛИЗИЙ');
  assert.strictEqual(t['2'], 'Способы разрешения коллизий');
});

test('без плана выручает chapterTitle у части', () => {
  const t = resolveChapterTitles({
    sections: [{ number: '1.1', chapterTitle: 'Общие положения' }],
  });
  assert.deepStrictEqual(t, { 1: 'Общие положения' });
});

test('глава без параграфов: название из её заголовка, без «Глава 1.»', () => {
  const t = resolveChapterTitles({
    sections: [{ number: '3', text: '…' }],
    sectionTitles: { 3: 'Глава 3. Практика применения' },
  });
  assert.deepStrictEqual(t, { 3: 'Практика применения' });
});

test('явный словарь перекрывает план, пустые названия не пишутся', () => {
  const t = resolveChapterTitles({
    plan: PLAN,
    chapterTitles: { 1: 'Исправлено руками', 2: '   ' },
  });
  assert.strictEqual(t['1'], 'Исправлено руками');
  assert.strictEqual(t['2'], 'Способы разрешения коллизий');
});

test('пусто на входе — пустой словарь, а не падение', () => {
  assert.deepStrictEqual(resolveChapterTitles({}), {});
  assert.deepStrictEqual(resolveChapterTitles(), {});
});

test('в готовом .docx у глав есть названия — и в тексте, и в содержании', async () => {
  const chapterTitles = resolveChapterTitles({ plan: PLAN, sections: SECTIONS });
  const buf = await generateFullDocx({
    topic: 'Правовые коллизии',
    introduction: 'Введение.',
    conclusion: 'Заключение.',
    sections: SECTIONS,
    sectionTitles: { 1.1: 'Понятие и признаки коллизии', 2.1: 'Коллизионные правила' },
    chapterTitles,
  });
  const lines = await docText(buf);

  // Дважды: строка содержания и заголовок в тексте. В тексте заголовок
  // главы набран прописными (ГОСТ), в содержании — как в плане.
  const same = (want) => (l) => l.toUpperCase() === want.toUpperCase();
  const ch1 = lines.filter(same('ГЛАВА 1. ТЕОРЕТИЧЕСКИЕ ОСНОВЫ ПРАВОВЫХ КОЛЛИЗИЙ'));
  const ch2 = lines.filter(same('ГЛАВА 2. Способы разрешения коллизий'));
  assert.strictEqual(ch1.length, 2, lines.join('\n'));
  assert.strictEqual(ch2.length, 2);
  assert.ok(!lines.includes('ГЛАВА 1'), 'голого «ГЛАВА 1» быть не должно');
});

test('глава без параграфов не получает второй заголовок «1. Глава 1. …»', async () => {
  const sections = [{ number: '1', text: 'Глава 1. Общие положения\nСам текст главы.' }];
  const sectionTitles = { 1: 'Глава 1. Общие положения' };
  const buf = await generateFullDocx({
    topic: 'Т', introduction: 'В.', conclusion: 'З.',
    sections,
    sectionTitles,
    chapterTitles: resolveChapterTitles({ sections, sectionTitles }),
  });
  const lines = await docText(buf);

  assert.strictEqual(lines.filter((l) => l === 'ГЛАВА 1. Общие положения').length, 1);
  assert.strictEqual(lines.filter((l) => l === 'ГЛАВА 1. ОБЩИЕ ПОЛОЖЕНИЯ').length, 1);
  assert.ok(!lines.some((l) => /^1\. Глава 1/.test(l)), lines.join('\n'));
  // Повтор заголовка в первой строке текста тоже снят.
  assert.ok(lines.includes('Сам текст главы.'));
  assert.ok(!lines.includes('Глава 1. Общие положения'));
});
