"""Разбор методички вуза в настройки работы.

Идея: пользователь загружает методичку (PDF/DOCX/текст), парсер
достаёт из неё формальные требования и превращает их в
`WorkPreferences`. Всё, что удалось распознать, показывается человеку
на подтверждение — молча применять распознанное нельзя.

Почему именно так. Методичка — источник жёстких требований («работа
должна содержать две главы», «объём 25-30 страниц»), и они важнее
наших умолчаний. Но парсер текста ошибается, поэтому каждое найденное
требование несёт с собой цитату из методички: пользователь видит, на
каком основании выставлено значение, и может поправить.

Приоритет источников (от низкого к высокому):
    умолчания < пресет < методичка < явные пожелания пользователя
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from app.modules.projects.preferences import (
    Requirement,
    Subject,
    VolumeLimits,
    WorkKind,
    WorkPreferences,
)

# Страница ГОСТ (14 pt, 1.5 интервала) ≈ 1800 знаков с пробелами.
# Коэффициент пересчёта, посчитанный по текстам автора:
# знаки без пробелов × 1.141 = знаки с пробелами.
CHARS_PER_PAGE_WITH_SPACES = 1800
SPACES_COEFF = 1.141


def pages_to_chars_no_spaces(pages: float) -> int:
    """Страницы ГОСТ → знаки без пробелов."""
    return int(pages * CHARS_PER_PAGE_WITH_SPACES / SPACES_COEFF)


@dataclass
class Finding:
    """Одно распознанное требование с обоснованием."""
    field: str
    value: Any
    quote: str
    confidence: float = 0.8

    def short_quote(self, limit: int = 120) -> str:
        q = re.sub(r"\s+", " ", self.quote).strip()
        return q if len(q) <= limit else q[:limit] + "…"


@dataclass
class MethodichkaResult:
    findings: list[Finding] = field(default_factory=list)
    unparsed_notes: list[str] = field(default_factory=list)

    def as_overrides(self, min_confidence: float = 0.5) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for f in self.findings:
            if f.confidence >= min_confidence:
                out[f.field] = f.value
        return out

    def report(self) -> str:
        if not self.findings:
            return "Из методички ничего распознать не удалось."
        lines = ["Распознано из методички (проверьте перед запуском):"]
        for f in self.findings:
            lines.append(f"  • {f.field} = {f.value}")
            lines.append(f"      основание: «{f.short_quote()}»")
        if self.unparsed_notes:
            lines.append("")
            lines.append("Замечено, но не применено автоматически:")
            for n in self.unparsed_notes:
                lines.append(f"  • {n}")
        return "\n".join(lines)


# --------------------------------------------------------------- правила

RE_CHAPTERS = re.compile(
    r"(?i)(?:работа|исследование)?[^.]{0,60}?"
    r"(?:должна\s+(?:состоять|содержать)|состоит|включа\w+)[^.]{0,40}?"
    r"\bиз\s+(двух|трёх|трех|двух-трёх|2|3)\s+глав",
)
RE_CHAPTERS_ALT = re.compile(r"(?i)\b(двух|трёх|трех|2|3)\s+глав(?:ы|ах)?\b")

RE_PAGES = re.compile(
    r"(?i)объ[её]м[^.]{0,80}?(\d{2})\s*[-–—]\s*(\d{2})\s*(?:страниц|стр\.?|с\.)",
)
RE_PAGES_MIN = re.compile(
    r"(?i)объ[её]м[^.]{0,60}?не\s+менее\s+(\d{2})\s*(?:страниц|стр\.?|с\.)",
)

_WORD_NUM = {
    "двух": 2, "трёх": 3, "трех": 3, "2": 2, "3": 3, "двух-трёх": 3,
}


def _kind_rules(text: str, res: MethodichkaResult) -> None:
    low = text.lower()
    for pattern, kind, quote_key in [
        (r"курсов\w+\s+работ", WorkKind.coursework, "курсовая работа"),
        (r"выпускн\w+\s+квалификацион", WorkKind.diploma, "ВКР"),
        (r"диплом\w*\s+работ", WorkKind.diploma, "дипломная работа"),
        (r"магистерск\w+\s+диссертац", WorkKind.thesis, "магистерская диссертация"),
        (r"кандидатск\w+\s+диссертац", WorkKind.thesis, "кандидатская диссертация"),
    ]:
        m = re.search(pattern, low)
        if m:
            res.findings.append(Finding(
                "kind", kind.value, _context(text, m.start()), 0.9,
            ))
            return


def _subject_rules(text: str, res: MethodichkaResult) -> None:
    low = text.lower()
    legal = len(re.findall(
        r"юридическ|юриспруденц|правов\w+\s+дисциплин|гк\s+рф|ук\s+рф|"
        r"судебн\w+\s+практик", low))
    econ = len(re.findall(
        r"экономическ|финансов\w+\s+анализ|бухгалтерск|менеджмент", low))
    if legal >= 2 and legal > econ:
        m = re.search(r"юридическ|правов", low)
        res.findings.append(Finding(
            "subject", Subject.legal.value, _context(text, m.start()), 0.7))
    elif econ >= 2 and econ > legal:
        m = re.search(r"экономическ|финансов", low)
        res.findings.append(Finding(
            "subject", Subject.economics.value, _context(text, m.start()), 0.7))


def _chapter_rules(text: str, res: MethodichkaResult) -> None:
    m = RE_CHAPTERS.search(text)
    conf = 0.9
    if not m:
        m = RE_CHAPTERS_ALT.search(text)
        conf = 0.6
    if not m:
        return
    word = m.group(1).lower()
    n = _WORD_NUM.get(word)
    if n:
        res.findings.append(Finding("chapters", n, _context(text, m.start()), conf))


def _volume_rules(text: str, res: MethodichkaResult) -> None:
    """Объём в страницах → объёмы разделов в знаках."""
    m = RE_PAGES.search(text)
    pages_lo = pages_hi = None
    if m:
        pages_lo, pages_hi = int(m.group(1)), int(m.group(2))
    else:
        m = RE_PAGES_MIN.search(text)
        if m:
            pages_lo = int(m.group(1))
            pages_hi = int(pages_lo * 1.3)
    if not pages_lo:
        return

    # Из общего объёма вычитаем титульник, содержание, список
    # источников и приложения — примерно 20% и 4 страницы.
    body_lo = max(4.0, pages_lo * 0.8 - 4)
    body_hi = max(6.0, pages_hi * 0.8 - 4)

    res.unparsed_notes.append(
        f"общий объём {pages_lo}–{pages_hi} стр.: на основной текст "
        f"остаётся ~{body_lo:.0f}–{body_hi:.0f} стр. после титульника, "
        "содержания и списка источников"
    )
    # Введение обычно 8-10% основного текста, но не больше 4 страниц.
    intro_pages_lo = min(2.0, body_lo * 0.08)
    intro_pages_hi = min(3.5, body_hi * 0.12)
    res.findings.append(Finding(
        "volumes",
        {
            "intro_min": pages_to_chars_no_spaces(intro_pages_lo),
            "intro_max": pages_to_chars_no_spaces(intro_pages_hi),
            "section_min": pages_to_chars_no_spaces(max(2.5, body_lo / 8)),
            "section_max": pages_to_chars_no_spaces(max(4.0, body_hi / 6)),
            "conclusion_min": pages_to_chars_no_spaces(intro_pages_lo),
            "conclusion_max": pages_to_chars_no_spaces(intro_pages_hi),
        },
        _context(text, m.start()),
        0.6,
    ))


def _element_rules(text: str, res: MethodichkaResult) -> None:
    low = text.lower()

    if re.search(r"гипотез\w+\s+исследован|сформулиров\w+\s+гипотез", low):
        m = re.search(r"гипотез", low)
        res.findings.append(Finding(
            "requires_hypothesis", True, _context(text, m.start()), 0.85))

    for pattern, fld, val in [
        (r"выводы\s+по\s+(?:кажд\w+\s+)?глав", "chapter_conclusions", True),
        (r"обязательн\w+[^.]{0,40}(?:таблиц|иллюстративн)", "tables",
         Requirement.required.value),
        (r"(?:обязательн|необходим)\w+[^.]{0,40}судебн\w+\s+практик", "cases",
         Requirement.required.value),
        (r"предложени\w+\s+по\s+совершенствованию\s+законодательств",
         "law_proposals", Requirement.required.value),
    ]:
        m = re.search(pattern, low)
        if m:
            res.findings.append(Finding(
                fld, val, _context(text, m.start()), 0.75))


def _context(text: str, pos: int, width: int = 90) -> str:
    lo = max(0, pos - width // 3)
    hi = min(len(text), pos + width)
    return text[lo:hi]


def parse_methodichka(text: str) -> MethodichkaResult:
    """Достаёт формальные требования из текста методички."""
    res = MethodichkaResult()
    if not (text or "").strip():
        return res
    _kind_rules(text, res)
    _subject_rules(text, res)
    _chapter_rules(text, res)
    _volume_rules(text, res)
    _element_rules(text, res)
    return res


# --------------------------------------------------------- пожелания

# Свободные пожелания клиента: «побольше практики», «без воды».
WISH_RULES: list[tuple[str, str, Any, str]] = [
    (r"(?i)(больше|побольше)\s+(судебн\w+\s+)?практик", "cases",
     Requirement.required.value, "просили больше практики"),
    (r"(?i)без\s+судебн\w+\s+практик|практика\s+не\s+нужна", "cases",
     Requirement.forbidden.value, "просили без практики"),
    (r"(?i)(больше|побольше)\s+таблиц|обязательно\s+таблиц", "tables",
     Requirement.required.value, "просили таблицы"),
    (r"(?i)без\s+таблиц", "tables", Requirement.forbidden.value,
     "просили без таблиц"),
    (r"(?i)(больше|побольше)\s+график|нужн\w+\s+график|с\s+график",
     "charts", Requirement.required.value, "просили графики"),
    (r"(?i)(без\s+воды|не\s+лить\s+воду|покороче|сжат)", "liveliness",
     "high", "просили без воды — усиливаем живость и краткость"),
    (r"(?i)(живо|легче\s+читал|проще\s+читал|не\s+сухо)", "liveliness",
     "high", "просили живее"),
    (r"(?i)(строг\w+\s+научн|academ|максимально\s+формальн)", "liveliness",
     "normal", "просили строгий научный стиль"),
    (r"(?i)предложени\w+\s+по\s+(?:совершенствованию\s+)?законодательств",
     "law_proposals", Requirement.required.value,
     "просили предложения по законодательству"),
    (r"(?i)(две|2)\s+глав", "chapters", 2, "просили две главы"),
    (r"(?i)(три|3)\s+глав", "chapters", 3, "просили три главы"),
]


def parse_wishes(text: str) -> MethodichkaResult:
    """Разбирает свободные пожелания клиента."""
    res = MethodichkaResult()
    if not (text or "").strip():
        return res
    for pattern, fld, val, why in WISH_RULES:
        m = re.search(pattern, text)
        if m:
            res.findings.append(Finding(fld, val, _context(text, m.start()), 0.7))
    return res


def build_preferences(
    *,
    base: WorkPreferences | None = None,
    methodichka_text: str = "",
    wishes_text: str = "",
    explicit: dict[str, Any] | None = None,
) -> tuple[WorkPreferences, MethodichkaResult, MethodichkaResult]:
    """Собирает итоговые настройки из всех источников.

    Приоритет: умолчания < пресет < методичка < пожелания < явный выбор.
    Явный выбор пользователя в форме побеждает всегда — методичка не
    должна молча переписывать то, что человек указал руками.
    """
    prefs = base or WorkPreferences()
    data = prefs.to_dict()

    m_res = parse_methodichka(methodichka_text)
    w_res = parse_wishes(wishes_text)

    m_over = m_res.as_overrides()
    # `requires_hypothesis` не поле настроек: методичка с гипотезой
    # означает, что работа квалификационная.
    if m_over.pop("requires_hypothesis", False):
        data["kind"] = WorkKind.thesis.value

    data.update(m_over)
    data.update(w_res.as_overrides())
    if explicit:
        data.update(explicit)

    return WorkPreferences.from_dict(data), m_res, w_res
