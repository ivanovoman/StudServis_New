"""Извлечение разметки «ИИ» из отчётов Антиплагиат.ВУЗ (PDF).

Отчёт рисует под фрагментами, которые модуль ИИ счёл сгенерированными,
розовые прямоугольники заливки (RGB 1.0 / 0.7 / 0.79). Строка текста
считается помеченной, если её середина по вертикали лежит внутри такого
прямоугольника и есть перекрытие по горизонтали.

    python research/antiplagiat/extract.py ~/uploads/*ии*.pdf > lines.json

Одинаковые по содержимому файлы (md5) берутся один раз.
"""
import hashlib
import json
import sys

import pymupdf

PINK = (1.0, 0.7, 0.79)


def is_pink(c):
    return c and all(abs(a - b) < 0.03 for a, b in zip(c, PINK))


def doc_lines(path):
    d = pymupdf.open(path)
    out = []
    for pno, page in enumerate(d):
        rects = [x['rect'] for x in page.get_drawings() if is_pink(x.get('fill'))]
        for b in page.get_text('dict')['blocks']:
            for ln in b.get('lines', []):
                text = ''.join(s['text'] for s in ln['spans']).strip()
                if not text:
                    continue
                x0, y0, x1, y1 = ln['bbox']
                ym = (y0 + y1) / 2
                ai = any(r.y0 - 1 <= ym <= r.y1 + 1 and min(x1, r.x1) - max(x0, r.x0) > 5 for r in rects)
                out.append({'page': pno + 1, 'y': round(y0, 1), 'text': text, 'ai': ai})
    return out


def main(paths):
    seen = set()
    docs = {}
    for p in paths:
        h = hashlib.md5(open(p, 'rb').read()).hexdigest()
        if h in seen or 'ии' not in p.lower().split('/')[-1][:12]:
            continue
        seen.add(h)
        docs[p.split('/')[-1]] = doc_lines(p)
    json.dump(docs, sys.stdout, ensure_ascii=False, indent=0)


if __name__ == '__main__':
    main(sys.argv[1:])
