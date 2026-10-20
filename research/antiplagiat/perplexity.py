"""Перплексия окон под русской языковой моделью (ruGPT-3 small) и её связь
с пометками Антиплагиата.

    python research/antiplagiat/perplexity.py incoming/ap_windows.json

Машинный текст обычно предсказуемее для языковой модели: ниже средняя
перплексия и меньше разброс «неожиданности» по токенам.
"""
import json, math, sys
import numpy as np
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM

MODEL = 'ai-forever/rugpt3small_based_on_gpt2'
tok = AutoTokenizer.from_pretrained(MODEL)
lm = AutoModelForCausalLM.from_pretrained(MODEL).eval()
torch.set_num_threads(4)


def surprise(text):
    ids = tok(text, return_tensors='pt', truncation=True, max_length=512).input_ids
    with torch.no_grad():
        logits = lm(ids).logits[0, :-1]
    lp = torch.log_softmax(logits, -1).gather(1, ids[0, 1:, None])[:, 0]
    nll = (-lp).numpy()
    # ранг истинного токена — «насколько очевидным» был выбор
    ranks = (logits > logits.gather(1, ids[0, 1:, None])).sum(1).numpy()
    return {
        'ppl': float(math.exp(nll.mean())),
        'nll_sd': float(nll.std()),
        'top1': float((ranks == 0).mean()),
        'top10': float((ranks < 10).mean()),
        'nll_p90': float(np.percentile(nll, 90)),
    }


if __name__ == '__main__':
    W = json.load(open(sys.argv[1]))
    for i, w in enumerate(W):
        w['lm'] = surprise(w['text'])
        if i % 50 == 0:
            print(i, file=sys.stderr)
    json.dump(W, open(sys.argv[1].replace('.json', '_lm.json'), 'w'), ensure_ascii=False)
