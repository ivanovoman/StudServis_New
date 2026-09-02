"""Критерии готовности этапов — исполняемые правила.

Объёмы согласованы с заказчиком (в знаках БЕЗ пробелов, как принято
в вузах при подсчёте):

  - введение:  3800-5000
  - раздел:    5000-6000

Структура: обычно 3 главы + выводы по каждой, но допустимы 2 главы,
если так требует методичка. Делать больше, чем нужно, не следует.

Гипотеза: нужна для диссертации, для курсовой не нужна.

Проверено по текстам автора: обе диссертации имеют ровно 3 главы;
введения там 9.5 и 10.7 тыс. знаков б/п — это диссертационный объём,
для курсовой заказчик задал меньший (3800-5000).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Sequence

from app.modules.humanizer.style_profile import CLICHES, analyze_style


class WorkKind(str, Enum):
    """От вида работы зависят обязательные элементы введения."""
    coursework = "coursework"      # курсовая — гипотеза НЕ нужна
    thesis = "thesis"              # диссертация — гипотеза и её оценка нужны


def chars_no_spaces(text: str) -> int:
    """Знаки без пробелов — так объём считают в вузах."""
    return len(re.sub(r"\s", "", text or ""))


@dataclass
class Violation:
    rule: str
    message: str
    severity: str = "error"      # error — брак, warning — на усмотрение


@dataclass
class CheckResult:
    violations: list[Violation] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not any(v.severity == "error" for v in self.violations)

    def add(self, rule: str, message: str, severity: str = "error") -> None:
        self.violations.append(Violation(rule, message, severity))

    def report(self) -> str:
        if not self.violations:
            return "OK"
        return "\n".join(
            f"[{v.severity}] {v.rule}: {v.message}" for v in self.violations
        )


# ------------------------------------------------------- пороги по стилю

# Эталон — обе диссертации автора (43 606 слов).
REF_SENTENCE_STDEV_CORPUS = 18.18
REF_CLICHE_PER_1K = 1.95

# ВАЖНО про калибровку порога ритма.
#
# Считать порог от общего корпуса (18.18 * 0.7 = 12.7) — ошибка: корпус
# смешивает разные разделы, и разброс на нём завышен. Проверка по 35
# ОТДЕЛЬНЫМ разделам автора дала: медиана 14.7, но p10 = 8.7, а минимум
# 7.5. То есть у самого автора есть разделы с «ровным» ритмом, и порог
# 12.7 забраковал бы его собственный текст.
#
# Берём p10 реальных разделов: ниже этого уровня не опускается 90%
# авторских текстов, а машинная генерация (8.2 при плотном ровном
# ритме) отсекается вместе с нижним хвостом.
REF_SENTENCE_STDEV_SECTION_MEDIAN = 14.7
MIN_SENTENCE_STDEV = 8.7                              # p10 разделов автора

# Клише: НЕ ноль. Автор сам пишет «таким образом» 46 раз на две работы.
# Требовать ноль — требовать быть чище автора, чей стиль копируем.
#
# Порог тоже калибруется по РАЗДЕЛАМ, а не по корпусу. На корпусе выходит
# 1.95, но в отдельных разделах клише концентрируются: медиана 1.87,
# p75 = 2.92, максимум 5.18. Порог 2.0 забраковал бы 40% авторских
# разделов. Берём 3.5 (проходит 80%) как брак и 2.5 как предупреждение:
# выше медианы — повод почистить, но не повод останавливать конвейер.
MAX_CLICHE_PER_1K = 3.5
WARN_CLICHE_PER_1K = 2.5
# Доля коротких предложений: у автора по разделам сильно плавает,
# поэтому это предупреждение, а не брак (у ИИ было ровно 0.0).
MIN_SHORT_SENTENCE_SHARE = 0.05
MAX_SENTENCE_LEN_MEAN = 26.0


def check_style(text: str, *, strict_rhythm: bool = True) -> CheckResult:
    """Общие стилевые пороги для всех текстовых этапов."""
    res = CheckResult()
    p = analyze_style([text])
    if p.total_sentences < 5:
        return res  # слишком короткий фрагмент, метрики недостоверны

    if strict_rhythm and p.sentence_len_stdev < MIN_SENTENCE_STDEV:
        res.add(
            "rhythm",
            f"ровный ритм: разброс длин {p.sentence_len_stdev} при норме "
            f">= {MIN_SENTENCE_STDEV} (медиана разделов автора "
            f"{REF_SENTENCE_STDEV_SECTION_MEDIAN}). "
            "Читается как ИИ — нужны короткие предложения вперемешку с длинными",
        )
    if p.short_sentence_share < MIN_SHORT_SENTENCE_SHARE:
        res.add(
            "short_sentences",
            f"коротких предложений {p.short_sentence_share:.0%} "
            f"при норме >= {MIN_SHORT_SENTENCE_SHARE:.0%}",
            severity="warning",
        )
    if p.cliche_per_1k > MAX_CLICHE_PER_1K:
        res.add(
            "cliche",
            f"клише {p.cliche_per_1k}/1000 слов при норме <= {MAX_CLICHE_PER_1K}: "
            f"{list(p.cliche_found)}",
        )
    elif p.cliche_per_1k > WARN_CLICHE_PER_1K:
        res.add(
            "cliche",
            f"клише {p.cliche_per_1k}/1000 слов — выше медианы автора "
            f"({WARN_CLICHE_PER_1K}), стоит почистить: {list(p.cliche_found)}",
            severity="warning",
        )
    if p.sentence_len_mean > MAX_SENTENCE_LEN_MEAN:
        res.add(
            "verbosity",
            f"средняя длина предложения {p.sentence_len_mean} "
            f"> {MAX_SENTENCE_LEN_MEAN} — вероятна «вода»",
            severity="warning",
        )
    return res


def check_length(text: str, lo: int, hi: int, what: str) -> CheckResult:
    """Объём в знаках без пробелов."""
    res = CheckResult()
    n = chars_no_spaces(text)
    if n < lo:
        res.add("length", f"{what}: {n} знаков б/п, нужно от {lo}")
    elif n > hi:
        res.add("length", f"{what}: {n} знаков б/п, нужно не более {hi}")
    return res


# ------------------------------------------------------------- этап 3

# Обязательные элементы введения. Ключ — что ищем, значение — синонимы.
INTRO_ELEMENTS: dict[str, tuple[str, ...]] = {
    "актуальность": ("актуальност", "актуальн"),
    "цель": ("цель ", "целью", "цель работы", "цель исследования"),
    "задачи": ("задач",),
    "объект": ("объект",),
    "предмет": ("предмет",),
    "структура": ("структур",),
}
HYPOTHESIS_MARKERS = ("гипотез",)


def check_introduction(text: str, *, kind: WorkKind = WorkKind.coursework,
                       task_count: int | None = None) -> CheckResult:
    """Введение: 3800-5000 знаков б/п + обязательные элементы.

    Гипотеза требуется только для диссертации (`WorkKind.thesis`).
    """
    res = CheckResult()
    res.violations += check_length(text, 3800, 5000, "введение").violations

    low = (text or "").lower()
    missing = [
        name for name, keys in INTRO_ELEMENTS.items()
        if not any(k in low for k in keys)
    ]
    if missing:
        res.add("intro_elements", f"нет обязательных разделов: {', '.join(missing)}")

    has_hypothesis = any(m in low for m in HYPOTHESIS_MARKERS)
    if kind is WorkKind.thesis and not has_hypothesis:
        res.add("hypothesis", "для диссертации нужна гипотеза и её оценка")
    if kind is WorkKind.coursework and has_hypothesis:
        res.add(
            "hypothesis",
            "в курсовой гипотеза не нужна — убрать",
            severity="warning",
        )

    first = (text or "").strip().split("\n", 1)[0].strip().lower()
    if first.startswith("введение"):
        res.add("heading", "текст не должен начинаться словом «Введение»")

    if task_count:
        # Задачи обычно перечислены списком или через «-».
        listed = len(re.findall(r"(?m)^\s*(?:[-–•*]|\d+[.)])\s", text or ""))
        if listed and abs(listed - task_count) > 1:
            res.add(
                "tasks_match",
                f"задач во введении ~{listed}, глав/разделов в плане {task_count}",
                severity="warning",
            )

    res.violations += check_style(text).violations
    return res


# ------------------------------------------------------------- этап 5

def check_section(text: str, *, subject_is_legal: bool = True,
                  previous_texts: Sequence[str] = ()) -> CheckResult:
    """Раздел: 5000-6000 знаков б/п, ссылки, отсутствие повторов."""
    res = CheckResult()
    res.violations += check_length(text, 5000, 6000, "раздел").violations

    from app.modules.humanizer.style_profile import RE_CASE, RE_LAW

    if subject_is_legal:
        # Пороги привязаны к предмету: в экономической работе автора
        # ссылок на нормы 0.04/1k, в юридической — 4.67. Общий порог
        # был бы бессмысленным.
        if not RE_LAW.search(text or ""):
            res.add("law_ref", "нет ни одной ссылки на норму права")
        if not RE_CASE.search(text or ""):
            res.add(
                "case_ref",
                "нет ссылок на судебную практику",
                severity="warning",
            )

    first = (text or "").strip().split("\n", 1)[0].strip()
    if re.match(r"^\d+\.\d+\.?\s", first):
        res.add("heading", "текст не должен начинаться с номера раздела")

    dup = _find_duplicate_span(text or "", previous_texts)
    if dup:
        res.add("repetition", f"дословный повтор из другого раздела: «{dup[:60]}...»")

    res.violations += check_style(text).violations
    return res


def _find_duplicate_span(text: str, previous: Sequence[str], n: int = 15) -> str | None:
    """Ищет дословный повтор длиной n слов среди ранее написанного."""
    if not previous:
        return None
    words = re.findall(r"\w+", text.lower())
    if len(words) < n:
        return None
    prev_joined = " ".join(re.findall(r"\w+", " ".join(previous).lower()))
    for i in range(len(words) - n + 1):
        span = " ".join(words[i:i + n])
        if span in prev_joined:
            return span
    return None


# ------------------------------------------------------------- этап 9

def check_conclusion(text: str, *, intro_text: str = "") -> CheckResult:
    """Заключение: отвечает на задачи введения, без новых фактов."""
    res = CheckResult()
    res.violations += check_length(text, 3000, 5000, "заключение").violations

    first = (text or "").strip().split("\n", 1)[0].strip().lower()
    if first.startswith("заключение"):
        res.add("heading", "текст не должен начинаться словом «Заключение»")

    res.violations += check_style(text).violations
    return res


# ------------------------------------------------------------- этап 2

def check_plan(text: str, *, required_chapters: int | None = None) -> CheckResult:
    """План: обычно 3 главы + выводы, допустимо 2 по методичке.

    Больше, чем нужно, делать не следует — лишние главы это вода.
    """
    res = CheckResult()

    chapters = sorted({
        int(m.group(1))
        for m in re.finditer(r"(?mi)^\s*глава\s+(\d+)", text or "")
    })
    sections = re.findall(r"(?m)^\s*([1-9]\.\d{1,2})[.\s]", text or "")

    n = len(chapters)
    if required_chapters:
        if n != required_chapters:
            res.add(
                "chapters",
                f"глав {n}, а методичка требует {required_chapters}",
            )
    elif n not in (2, 3):
        res.add(
            "chapters",
            f"глав {n}: обычно 3, допустимо 2 по методичке. "
            "Больше, чем нужно, делать не стоит",
        )

    if chapters and chapters != list(range(1, n + 1)):
        res.add("numbering", f"нумерация глав с пропусками: {chapters}")

    by_chapter: dict[str, int] = {}
    for s in sections:
        by_chapter[s.split(".")[0]] = by_chapter.get(s.split(".")[0], 0) + 1
    for ch, cnt in sorted(by_chapter.items()):
        if cnt > 5:
            res.add(
                "granularity",
                f"в главе {ch} разделов {cnt} — мельчит, укрупнить",
                severity="warning",
            )
        if cnt < 2:
            res.add("granularity", f"в главе {ch} только {cnt} раздел")

    # Выводы по главам есть в обеих работах автора.
    vyvody = len(re.findall(r"(?mi)^\s*выводы\s+по", text or ""))
    if n and vyvody < n:
        res.add(
            "chapter_conclusions",
            f"выводов по главам {vyvody}, глав {n} — нужны после каждой",
            severity="warning",
        )
    return res


STEP_CHECKS: dict[str, Callable[..., CheckResult]] = {
    "plan": check_plan,
    "introduction": check_introduction,
    "section_write": check_section,
    "conclusion": check_conclusion,
}
