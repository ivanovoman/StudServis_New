"""Пары версий одной работы: как менялись пометки ИИ у совпадающих предложений.

    python research/antiplagiat/pairs.py incoming/ap_blocks.json
"""
import json, re, sys, difflib
from collections import Counter

B = json.load(open(sys.argv[1]))
norm = lambda s: re.sub(r'\W+', ' ', s.lower()).strip()

def body(doc, mark):
    out = []
    started = mark is None
    for b in B[doc]:
        t = b['text']
        if mark and mark in t:
            started = True
            t = t.split(mark, 1)[1]
        if not started:
            continue
        for s in re.split(r'(?<=[.!?])\s+(?=[«"(А-ЯЁA-Z])', t):
            if len(s) > 40 and not re.search(r'\.{5,}|URL|дата обращения', s):
                out.append((s, b['ai']))
    return out

PAIRS = [('200577ии.pdf', '200577ии (1) (1).pdf', '@@200577-1@@'),
         ('200570 ии (1).pdf', '200570ии (1).pdf', None),
         ('200592ии.pdf', '200592-1ии (1).pdf', None)]
res = {}
for a, b, mark in PAIRS:
    A = body(a, mark); Bv = body(b, mark)
    Bn = [norm(s) for s, _ in Bv]
    cnt = Counter(); ex = []
    for s, ai in A:
        m = difflib.get_close_matches(norm(s), Bn, n=1, cutoff=0.5)
        if not m:
            cnt[('нет пары', ai)] += 1
            continue
        j = Bn.index(m[0]); s2, ai2 = Bv[j]
        r = difflib.SequenceMatcher(None, norm(s), m[0]).ratio()
        kind = 'то же' if r > 0.95 else 'правка'
        cnt[(kind, ai, ai2)] += 1
        ex.append({'a': s, 'b': s2, 'ai_a': ai, 'ai_b': ai2, 'sim': round(r, 2)})
    print(f'\n== {a} ({len(A)} предл., ИИ {sum(x for _,x in A)})  →  {b} ({len(Bv)}, ИИ {sum(x for _,x in Bv)})')
    for k, v in sorted(cnt.items(), key=lambda kv: -kv[1]):
        print('   ', k, v)
    res[a] = ex
json.dump(res, open('incoming/ap_pairs.json', 'w'), ensure_ascii=False, indent=1)
