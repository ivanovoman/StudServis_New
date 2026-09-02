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
from app.modules.projects.preferences import (
    Requirement,
    Subject,
    WorkKind,
    WorkPreferences,
)


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


def check_style(text: str, *, strict_rhythm: bool = True,
                prefs: WorkPreferences | None = None) -> CheckResult:
    """Общие стилевые пороги для всех текстовых этапов."""
    prefs = prefs or WorkPreferences()
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
    max_cliche = (0.5 if prefs.cliche_policy == "strict" else MAX_CLICHE_PER_1K)
    if p.cliche_per_1k > max_cliche:
        res.add(
            "cliche",
            f"клише {p.cliche_per_1k}/1000 слов при норме <= {max_cliche}: "
            f"{list(p.cliche_found)}",
        )
    elif p.cliche_per_1k > WARN_CLICHE_PER_1K and prefs.cliche_policy != "strict":
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


def check_introduction(text: str, *, prefs: WorkPreferences | None = None,
                       task_count: int | None = None,
                       kind: WorkKind | None = None) -> CheckResult:
    """Введение: объём по настройкам + обязательные элементы.

    Гипотеза требуется только для диссертации — см. `prefs.needs_hypothesis`.
    """
    prefs = prefs or WorkPreferences()
    if kind is not None:                     # обратная совместимость
        prefs = WorkPreferences.from_dict({**prefs.to_dict(), "kind": kind})
    vol = prefs.resolved_volumes()

    res = CheckResult()
    res.violations += check_length(
        text, vol.intro_min, vol.intro_max, "введение"
    ).violations

    low = (text or "").lower()
    missing = [
        name for name, keys in INTRO_ELEMENTS.items()
        if not any(k in low for k in keys)
    ]
    if missing:
        res.add("intro_elements", f"нет обязательных разделов: {', '.join(missing)}")

    has_hypothesis = any(m in low for m in HYPOTHESIS_MARKERS)
    if prefs.needs_hypothesis and not has_hypothesis:
        res.add("hypothesis", "для диссертации нужна гипотеза и её оценка")
    if not prefs.needs_hypothesis and has_hypothesis:
        res.add(
            "hypothesis",
            "в курсовой гипотеза не нужна — убрать",
            severity="warning",
        )

    first = (text or "").strip().split("\n", 1)[0].strip().lower()
    if first.startswith("введение"):
        res.add("heading", "текст не должен начинаться словом «Введение»")

    if task_count:
        listed = len(re.findall(r"(?m)^\s*(?:[-–•*]|\d+[.)])\s", text or ""))
        if listed and abs(listed - task_count) > 1:
            res.add(
                "tasks_match",
                f"задач во введении ~{listed}, глав/разделов в плане {task_count}",
                severity="warning",
            )

    res.violations += check_style(text, prefs=prefs).violations
    return res


# ------------------------------------------------------------- этап 5

def check_section(text: str, *, prefs: WorkPreferences | None = None,
                  previous_texts: Sequence[str] = (),
                  subject_is_legal: bool | None = None) -> CheckResult:
    """Раздел: объём, ссылки, визуальные материалы, отсутствие повторов.

    Требования к кейсам и таблицам берутся из настроек, потому что
    правильный ответ на «нужны ли они» — «зависит от темы».
    """
    prefs = prefs or WorkPreferences()
    if subject_is_legal is not None:         # обратная совместимость
        prefs = WorkPreferences.from_dict({
            **prefs.to_dict(),
            "subject": (Subject.legal if subject_is_legal else Subject.economics).value,
        })
    vol = prefs.resolved_volumes()

    res = CheckResult()
    res.violations += check_length(
        text, vol.section_min, vol.section_max, "раздел"
    ).violations

    from app.modules.humanizer.style_profile import RE_CASE, RE_LAW

    if prefs.is_legal:
        # Пороги привязаны к предмету: в экономической работе автора
        # ссылок на нормы 0.04/1k, в юридической — 4.67.
        if not RE_LAW.search(text or ""):
            res.add("law_ref", "нет ни одной ссылки на норму права")

    res.violations += _check_cases(text, prefs).violations
    res.violations += _check_visuals(text, prefs).violations

    first = (text or "").strip().split("\n", 1)[0].strip()
    if re.match(r"^\d+\.\d+\.?\s", first):
        res.add("heading", "текст не должен начинаться с номера раздела")

    dup = _find_duplicate_span(text or "", previous_texts)
    if dup:
        res.add("repetition", f"дословный повтор из другого раздела: «{dup[:60]}...»")

    res.violations += check_style(text, prefs=prefs).violations
    return res


def _check_cases(text: str, prefs: WorkPreferences) -> CheckResult:
    """Судебная практика: «может быть, а может и не быть».

    Наличие требуем только когда пользователь явно попросил.
    """
    from app.modules.humanizer.style_profile import RE_CASE

    res = CheckResult()
    if prefs.cases is Requirement.when_relevant:
        return res                            # по теме — не проверяем
    found = RE_CASE.findall(text or "")
    if prefs.cases is Requirement.required:
        need = max(1, prefs.min_cases_per_section)
        if len(found) < need:
            res.add(
                "case_ref",
                f"судебной практики {len(found)}, требуется минимум {need}",
            )
    elif prefs.cases is Requirement.forbidden and found:
        res.add(
            "case_ref",
            "по теме судебная практика не нужна, а она есть",
            severity="warning",
        )
    return res


# Таблица в markdown и подпись к ней/рисунку.
RE_TABLE_ROW = re.compile(r"(?m)^\s*\|.+\|\s*$")
RE_TABLE_CAPTION = re.compile(r"(?mi)^\s*Таблица\s*\d*")
RE_CHART_CAPTION = re.compile(r"(?mi)^\s*(Рис(?:унок|\.)|График|Диаграмма)\s*\d*")


def _check_visuals(text: str, prefs: WorkPreferences) -> CheckResult:
    """Таблицы и графики — там, где уместны.

    Пустые таблицы «без смысла» не нужны: это прямое требование, и
    оно проверяемо — таблица из одной строки или без данных бракуется.
    """
    res = CheckResult()
    text = text or ""

    has_table = bool(RE_TABLE_CAPTION.search(text) or RE_TABLE_ROW.search(text))
    has_chart = bool(RE_CHART_CAPTION.search(text))

    if prefs.tables is Requirement.required and not has_table:
        res.add("table", "в разделе нужна таблица, её нет")
    if prefs.tables is Requirement.forbidden and has_table:
        res.add("table", "таблицы в этой работе не нужны", severity="warning")
    if prefs.charts is Requirement.required and not has_chart:
        res.add("chart", "в разделе нужен график, его нет")

    # Пустоту проверяем только у markdown-таблиц: в тексте, извлечённом
    # из PDF, разметка потеряна, и одна подпись «Таблица 1» не значит,
    # что таблица пустая. Иначе получаем ложные срабатывания на
    # реальных работах.
    if prefs.forbid_empty_visuals and RE_TABLE_ROW.search(text):
        rows = RE_TABLE_ROW.findall(text)
        # Шапка + разделитель + хотя бы две строки данных.
        data_rows = [
            r for r in rows
            if not re.fullmatch(r"\s*\|[\s|:-]+\|\s*", r)
        ]
        if len(data_rows) < 3:
            res.add(
                "empty_table",
                f"таблица почти пустая ({max(0, len(data_rows) - 1)} строк данных) "
                "— такая таблица не несёт смысла",
            )
        # Ячейки-заглушки.
        if re.search(r"\|\s*(-{1,2}|н/д|нет данных|—|\.\.\.)\s*\|", text, re.I):
            res.add(
                "empty_table",
                "в таблице есть пустые ячейки-заглушки",
                severity="warning",
            )
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

def check_conclusion(text: str, *, prefs: WorkPreferences | None = None,
                     intro_text: str = "") -> CheckResult:
    """Заключение: отвечает на задачи введения, без новых фактов.

    В юридической работе желательны предложения по совершенствованию
    законодательства — но обоснованные, а не декларативные.
    """
    prefs = prefs or WorkPreferences()
    vol = prefs.resolved_volumes()

    res = CheckResult()
    res.violations += check_length(
        text, vol.conclusion_min, vol.conclusion_max, "заключение"
    ).violations

    first = (text or "").strip().split("\n", 1)[0].strip().lower()
    if first.startswith("заключение"):
        res.add("heading", "текст не должен начинаться словом «Заключение»")

    res.violations += _check_law_proposals(text, prefs).violations
    res.violations += check_style(text, prefs=prefs).violations
    return res


RE_PROPOSAL = re.compile(
    r"(?i)(предлага|целесообразн|следует\s+(?:допол|изменить|внести|закрепить)"
    r"|необходимо\s+(?:допол|изменить|внести|закрепить)"
    r"|внести\s+измен|изложить\s+в\s+следующей\s+редакции|дополнить\s+стать)"
)
# Обоснование предложения: ссылка на проблему или причину.
RE_JUSTIFICATION = re.compile(
    r"(?i)(поскольку|так\s+как|потому\s+что|это\s+позволит|обусловлен"
    r"|проблем|пробел|противоречи|неопределённост|неопределенност)"
)


def _check_law_proposals(text: str, prefs: WorkPreferences) -> CheckResult:
    """Предложения по законодательству — «желательны, но обоснованы»."""
    res = CheckResult()
    if not prefs.expects_law_proposals:
        return res

    text = text or ""
    if not RE_PROPOSAL.search(text):
        res.add(
            "law_proposals",
            "в юридической работе желательны предложения по "
            "совершенствованию законодательства",
            severity=(
                "error" if prefs.law_proposals is Requirement.required
                else "warning"
            ),
        )
        return res

    # Предложение без обоснования — декларация.
    if not RE_JUSTIFICATION.search(text):
        res.add(
            "law_proposals",
            "предложения есть, но не обоснованы: не сказано, какую "
            "проблему они решают",
        )
    return res


def check_plan(text: str, *, prefs: WorkPreferences | None = None,
               required_chapters: int | None = None) -> CheckResult:
    """План: число глав и дробность разделов по настройкам.

    Стандарт — 2 или 3 главы. Больше, чем нужно, делать не следует.
    """
    prefs = prefs or WorkPreferences()
    if required_chapters is not None:        # обратная совместимость
        prefs = WorkPreferences.from_dict({
            **prefs.to_dict(), "chapters": required_chapters
        })

    res = CheckResult()

    chapters = sorted({
        int(m.group(1))
        for m in re.finditer(r"(?mi)^\s*глава\s+(\d+)", text or "")
    })
    sections = re.findall(r"(?m)^\s*([1-9]\.\d{1,2})[.\s]", text or "")

    n = len(chapters)
    if n not in prefs.allowed_chapter_counts:
        if prefs.chapters is not None:
            res.add("chapters", f"глав {n}, а методичка требует {prefs.chapters}")
        else:
            res.add(
                "chapters",
                f"глав {n}: стандарт 2 или 3. "
                "Больше, чем нужно, делать не стоит",
            )

    if chapters and chapters != list(range(1, n + 1)):
        res.add("numbering", f"нумерация глав с пропусками: {chapters}")

    by_chapter: dict[str, int] = {}
    for sec in sections:
        key = sec.split(".")[0]
        by_chapter[key] = by_chapter.get(key, 0) + 1
    for ch, cnt in sorted(by_chapter.items()):
        if cnt > 5:
            res.add(
                "granularity",
                f"в главе {ch} разделов {cnt} — мельчит, укрупнить",
                severity="warning",
            )
        if cnt < 2:
            res.add("granularity", f"в главе {ch} только {cnt} раздел")

    vyvody = len(re.findall(r"(?mi)^\s*выводы\s+по", text or ""))
    if prefs.chapter_conclusions and n and vyvody < n:
        res.add(
            "chapter_conclusions",
            f"выводов по главам {vyvody}, глав {n} — нужны после каждой",
            severity="warning",
        )
    return res


def check_section_plan(theses: Sequence[str], *,
                       prefs: WorkPreferences | None = None) -> CheckResult:
    """Поабзацный план раздела: число тезисов зависит от темы.

    «Для сложной и многогранной темы нужно раскрыть нюансы, и пунктов
    будет больше» — поэтому диапазон из настроек, а не жёсткое число.
    """
    prefs = prefs or WorkPreferences()
    lo, hi = prefs.theses_per_section
    res = CheckResult()
    n = len(theses)
    if n < lo:
        res.add("theses", f"тезисов {n}, минимум {lo} — тема раскрыта поверхностно")
    elif n > hi:
        res.add(
            "theses",
            f"тезисов {n}, максимум {hi} — план дробится, укрупните пункты",
            severity="warning",
        )
    empty = [i + 1 for i, t in enumerate(theses) if len((t or "").split()) < 4]
    if empty:
        res.add("theses", f"пункты без содержания: {empty}")
    return res


STEP_CHECKS: dict[str, Callable[..., CheckResult]] = {
    "plan": check_plan,
    "introduction": check_introduction,
    "section_plan": check_section_plan,
    "section_write": check_section,
    "conclusion": check_conclusion,
}
