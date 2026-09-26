"""Извлечение измеримого профиля стиля из текстов автора.

Промпт описывает стиль словами («короткие ясные предложения», «неровный
ритм»). Это работает как инструкция модели, но по этому нельзя ПРОВЕРИТЬ
результат. Здесь стиль превращается в числа, которые считаются и с
эталонных текстов, и со сгенерированных — и сравниваются.

Так humanizer получает критерий остановки, а не «на глаз».
"""

from __future__ import annotations

import json
import re
import statistics
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

# Клише из BASE_ROLE — считаем частоту в эталоне и в генерации.
CLICHES = (
    "в целом", "следует отметить", "важно понимать", "по сути", "безусловно",
    "необходимо учитывать", "очевидно", "несомненно", "таким образом",
    "в конечном итоге", "стоит отметить", "в современном мире",
    "данная проблема", "вышеизложенное", "следует подчеркнуть",
    "нельзя не отметить", "в рамках настоящего исследования", "данный аспект",
)

# Маркеры конкретики — то, ради чего промпт требует «цифры, даты, номера дел».
RE_LAW = re.compile(r"ст\.\s*\d+|стать[яию]\s+\d+|№\s*\d+[-–]?ФЗ|\d+[-–]ФЗ", re.I)
RE_CASE = re.compile(r"дел[оау]?\s*№|№\s*А\d{2}[-–]\d+|Пленум|Верховн\w+\s+[СC]уд", re.I)
RE_MONEY = re.compile(r"\d[\d\s]*(?:млн|тыс|миллион|тысяч)?\.?\s*(?:руб|рубл)", re.I)
RE_YEAR = re.compile(r"\b(19|20)\d{2}\b")
RE_PERCENT = re.compile(r"\d+\s*%")


@dataclass
class StyleProfile:
    """Числовой портрет стиля."""

    # Ритм
    sentence_len_mean: float = 0.0
    sentence_len_median: float = 0.0
    sentence_len_stdev: float = 0.0      # ГЛАВНОЕ: разброс = живой ритм
    sentence_len_p10: float = 0.0
    sentence_len_p90: float = 0.0
    short_sentence_share: float = 0.0    # доля предложений < 8 слов
    long_sentence_share: float = 0.0     # доля предложений > 30 слов

    paragraph_len_mean: float = 0.0
    paragraph_len_stdev: float = 0.0

    # Конкретика на 1000 слов
    law_refs_per_1k: float = 0.0
    case_refs_per_1k: float = 0.0
    money_per_1k: float = 0.0
    year_per_1k: float = 0.0
    percent_per_1k: float = 0.0

    # Клише на 1000 слов
    cliche_per_1k: float = 0.0
    cliche_found: dict[str, int] = field(default_factory=dict)

    # Лексика
    avg_word_len: float = 0.0
    lexical_diversity: float = 0.0       # уникальные слова / все слова
    list_marker_share: float = 0.0       # доля абзацев-списков

    total_words: int = 0
    total_sentences: int = 0
    total_paragraphs: int = 0

    def to_json(self, path: Path) -> None:
        path.write_text(
            json.dumps(asdict(self), ensure_ascii=False, indent=2), encoding="utf-8"
        )


def _sentences(text: str) -> list[str]:
    # Не режем по точке в «ст. 61.10», «№ 53.» и инициалах.
    protected = re.sub(r"(\bст|\bп|\bч|\bабз|\bг|\bгг|\bт\.д|\bт\.п|\bруб)\.", r"\1<DOT>", text)
    protected = re.sub(r"(\d)\.(\d)", r"\1<DOT>\2", protected)
    parts = re.split(r"(?<=[.!?])\s+", protected)
    out = []
    for p in parts:
        s = p.replace("<DOT>", ".").strip()
        if len(s.split()) >= 3:
            out.append(s)
    return out


def _paragraphs(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]


def _pct(values: Sequence[float], q: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    idx = min(int(len(s) * q), len(s) - 1)
    return float(s[idx])


def analyze_style(texts: Iterable[str]) -> StyleProfile:
    """Считает профиль по набору текстов."""
    joined = "\n\n".join(t for t in texts if t and t.strip())
    if not joined.strip():
        return StyleProfile()

    sents = _sentences(joined)
    paras = _paragraphs(joined)
    words = re.findall(r"[А-Яа-яЁёA-Za-z]+", joined)
    n_words = len(words) or 1
    per_1k = 1000.0 / n_words

    s_lens = [len(s.split()) for s in sents] or [0]
    p_lens = [len(p.split()) for p in paras] or [0]

    low = joined.lower()
    found = {c: low.count(c) for c in CLICHES if c in low}

    list_paras = sum(
        1 for p in paras if re.match(r"^\s*(?:[-–•*]|\d+[.)])\s", p)
    )

    return StyleProfile(
        sentence_len_mean=round(statistics.mean(s_lens), 2),
        sentence_len_median=round(statistics.median(s_lens), 2),
        sentence_len_stdev=round(statistics.pstdev(s_lens), 2) if len(s_lens) > 1 else 0.0,
        sentence_len_p10=round(_pct(s_lens, 0.10), 1),
        sentence_len_p90=round(_pct(s_lens, 0.90), 1),
        short_sentence_share=round(sum(1 for l in s_lens if l < 8) / len(s_lens), 3),
        long_sentence_share=round(sum(1 for l in s_lens if l > 30) / len(s_lens), 3),
        paragraph_len_mean=round(statistics.mean(p_lens), 2),
        paragraph_len_stdev=round(statistics.pstdev(p_lens), 2) if len(p_lens) > 1 else 0.0,
        law_refs_per_1k=round(len(RE_LAW.findall(joined)) * per_1k, 2),
        case_refs_per_1k=round(len(RE_CASE.findall(joined)) * per_1k, 2),
        money_per_1k=round(len(RE_MONEY.findall(joined)) * per_1k, 2),
        year_per_1k=round(len(RE_YEAR.findall(joined)) * per_1k, 2),
        percent_per_1k=round(len(RE_PERCENT.findall(joined)) * per_1k, 2),
        cliche_per_1k=round(sum(found.values()) * per_1k, 2),
        cliche_found=dict(Counter(found).most_common()),
        avg_word_len=round(sum(len(w) for w in words) / n_words, 2),
        lexical_diversity=round(len({w.lower() for w in words}) / n_words, 3),
        list_marker_share=round(list_paras / len(paras), 3) if paras else 0.0,
        total_words=n_words,
        total_sentences=len(sents),
        total_paragraphs=len(paras),
    )


def compare(reference: StyleProfile, candidate: StyleProfile) -> dict:
    """Сравнивает сгенерированный текст с эталоном.

    Возвращает отклонения по ключевым метрикам и вердикт. Это и есть
    «критерий готовности» для humanizer, пока заказчик не пришлёт свои.
    """
    def dev(a: float, b: float) -> float:
        return round(b - a, 2)

    checks = {
        "sentence_len_mean": dev(reference.sentence_len_mean, candidate.sentence_len_mean),
        "sentence_len_stdev": dev(reference.sentence_len_stdev, candidate.sentence_len_stdev),
        "short_sentence_share": dev(reference.short_sentence_share, candidate.short_sentence_share),
        "law_refs_per_1k": dev(reference.law_refs_per_1k, candidate.law_refs_per_1k),
        "case_refs_per_1k": dev(reference.case_refs_per_1k, candidate.case_refs_per_1k),
        "cliche_per_1k": dev(reference.cliche_per_1k, candidate.cliche_per_1k),
    }

    problems = []
    # Ровный ритм — главный маркер ИИ.
    if candidate.sentence_len_stdev < reference.sentence_len_stdev * 0.7:
        problems.append(
            f"ритм слишком ровный (разброс {candidate.sentence_len_stdev} "
            f"против {reference.sentence_len_stdev} у автора) — читается как ИИ"
        )
    if candidate.cliche_per_1k > max(reference.cliche_per_1k * 1.5, 0.5):
        problems.append(
            f"клише {candidate.cliche_per_1k}/1000 слов против "
            f"{reference.cliche_per_1k} у автора: {list(candidate.cliche_found)}"
        )
    if candidate.law_refs_per_1k < reference.law_refs_per_1k * 0.5:
        problems.append(
            f"мало ссылок на нормы ({candidate.law_refs_per_1k} против "
            f"{reference.law_refs_per_1k}) — текст абстрактный"
        )
    if candidate.sentence_len_mean > reference.sentence_len_mean * 1.3:
        problems.append("предложения длиннее авторских — вероятна «вода»")

    return {"deviations": checks, "problems": problems, "passed": not problems}
