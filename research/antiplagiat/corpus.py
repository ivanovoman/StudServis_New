"""Строки отчётов → размеченные блоки (ИИ / не ИИ) по каждой работе.

Работы внутри отчёта разделены метками @@номер@@. Соседние строки с
одинаковой меткой склеиваются в блок; переносы со знаком «-» убираются.
"""
import json
import re
import sys


def blocks(lines):
    out = []
    for l in lines:
        t = l['text']
        if out and out[-1]['ai'] == l['ai']:
            prev = out[-1]['text']
            out[-1]['text'] = prev[:-1] + t if prev.endswith('-') else prev + ' ' + t
            out[-1]['pages'].add(l['page'])
        else:
            out.append({'ai': l['ai'], 'text': t, 'pages': {l['page']}})
    for b in out:
        b['pages'] = sorted(b['pages'])
        b['text'] = re.sub(r'\s+', ' ', b['text']).strip()
    return out


if __name__ == '__main__':
    D = json.load(open(sys.argv[1]))
    res = {k: blocks(v) for k, v in D.items()}
    json.dump(res, sys.stdout, ensure_ascii=False, indent=0)
