#!/usr/bin/env node
/**
 * Сторож регистра на корпусе автора (data/style/*.pdf).
 *
 *   node tools/register-corpus.js        — число срабатываний по файлам
 *   node tools/register-corpus.js -v     — с контекстом каждой находки
 *
 * Академические работы автора — эталон: срабатывание на них почти всегда
 * ложное (так пишет сам автор). Статьи живее, там находки ожидаемы.
 * Текст из PDF извлекается через pypdf и кешируется в .cache/corp
 * (папка в снапшот не попадает и восстанавливается сама).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { findColloquial } = require('../api/register');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'style');
const CACHE = path.join(ROOT, '.cache', 'corp');

if (!fs.existsSync(CACHE) || !fs.readdirSync(CACHE).length) {
  fs.mkdirSync(CACHE, { recursive: true });
  execFileSync('python3', ['-c', `
import glob, os
from pypdf import PdfReader
for f in glob.glob(os.path.join(${JSON.stringify(SRC)}, '*.pdf')):
    t = '\\n'.join((p.extract_text() or '') for p in PdfReader(f).pages)
    open(os.path.join(${JSON.stringify(CACHE)}, os.path.basename(f)[:-4] + '.txt'), 'w').write(t)
`]);
}

const verbose = process.argv.includes('-v');
for (const f of fs.readdirSync(CACHE).filter((x) => x.endsWith('.txt')).sort()) {
  const t = fs.readFileSync(path.join(CACHE, f), 'utf8');
  const hits = findColloquial(t);
  console.log(`### ${f}: ${hits.length} на ${t.replace(/\s/g, '').length} зн.`);
  if (verbose && !/стиль/.test(f)) {
    for (const h of hits) {
      console.log(`    ${h.kind} | ${h.match} | ${t.slice(Math.max(0, h.index - 50), h.index + 60).replace(/\s+/g, ' ')}`);
    }
  }
}
