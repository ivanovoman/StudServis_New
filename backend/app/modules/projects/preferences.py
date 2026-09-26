"""Предварительные настройки работы, задаваемые пользователем.

Зачем это нужно. Часть требований к работе нельзя зашить константой,
потому что правильный ответ звучит «зависит от темы»:

  - число тезисов в разделе: сложная многогранная тема требует больше
    пунктов, чем узкая;
  - кейсы (судебная практика): могут быть, а могут и не быть — смотря
    какая тема;
  - таблицы и графики: нужны там, где уместны, и только если дополняют
    мысль, а не пересказывают её;
  - предложения по совершенствованию законодательства: желательны в
    юридической работе, бессмысленны в экономической.

Поэтому всё это вынесено в настройки, которые пользователь задаёт до
генерации. Значения по умолчанию подобраны так, чтобы обычная курсовая
работала без единой правки.

Настройки — единственный источник правды для модуля проверок
(`ai_engine.acceptance`): пороги не должны быть захардкожены в двух
местах.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any


class WorkKind(str, Enum):
    """Вид работы. Влияет на гипотезу и на объёмы."""
    coursework = "coursework"      # курсовая — гипотеза НЕ нужна
    diploma = "diploma"            # ВКР/диплом
    thesis = "thesis"              # диссертация — гипотеза и её оценка нужны


class Subject(str, Enum):
    """Предметная область.

    Важно не косметически: у автора в юридической работе ссылок на
    нормы 4.67 на 1000 слов, а в экономической — 0.04. Единый порог
    по ссылкам был бы бессмысленным.
    """
    legal = "legal"
    economics = "economics"
    other = "other"


class Requirement(str, Enum):
    """Трёхпозиционное требование вместо булева флага.

    «Таблица обязательна?» — неверный вопрос. Правильный ответ:
    там, где уместна. Это отдельное состояние, не «да» и не «нет».
    """
    required = "required"          # обязательно, отсутствие — брак
    when_relevant = "when_relevant"  # по уместности, не проверяем наличие
    forbidden = "forbidden"        # не нужно совсем


@dataclass
class VolumeLimits:
    """Объёмы в знаках БЕЗ пробелов — так считают в вузах."""
    intro_min: int = 3800
    intro_max: int = 5000
    section_min: int = 5000
    section_max: int = 6000
    conclusion_min: int = 3000
    conclusion_max: int = 5000


# Диссертация — другой жанр. У автора введения 9 468 и 10 749 знаков б/п,
# медианы разделов 11 468 и 7 500. Курсовые пороги её забракуют.
THESIS_VOLUMES = VolumeLimits(
    intro_min=7000, intro_max=12000,
    section_min=7000, section_max=14000,
    conclusion_min=4000, conclusion_max=8000,
)


@dataclass
class WorkPreferences:
    """Пожелания пользователя к работе, заданные до генерации."""

    # --- что за работа
    kind: WorkKind = WorkKind.coursework
    subject: Subject = Subject.legal
    topic: str = ""

    # --- структура
    chapters: int | None = None
    """Число глав. None — авто (разрешены 2 или 3).

    Если методичка требует конкретное число — задать его, тогда
    проверка станет жёсткой.
    """
    chapter_conclusions: bool = True
    """«Выводы по главе N» после каждой главы — есть в обеих работах автора."""

    # --- содержание разделов
    theses_per_section: tuple[int, int] = (3, 8)
    """Диапазон тезисов на раздел, а не фиксированное число.

    Пользователь: «зависит от темы — для сложной и многогранной темы
    нужно раскрыть нюансы, и пунктов будет больше». Ширину диапазона
    выбирает автор темы; узкой теме хватит нижней границы.
    """

    cases: Requirement = Requirement.when_relevant
    """Судебная практика. «Кейсы могут быть, а могут и не быть —
    в зависимости от темы»."""
    min_cases_per_section: int = 0
    """Жёсткий минимум кейсов. Работает только при cases=required."""

    tables: Requirement = Requirement.when_relevant
    charts: Requirement = Requirement.when_relevant
    """Таблицы и графики — «там, где уместны». Пустые таблицы без
    смысла не нужны; см. `forbid_empty_visuals`."""
    forbid_empty_visuals: bool = True
    """Бракуем таблицу/график, который дублирует текст или пуст по
    содержанию. Это требование пользователя, и оно проверяемо."""

    law_proposals: Requirement = Requirement.when_relevant
    """Предложения по совершенствованию законодательства.
    «Если работа юридическая — желательны, но должны быть обоснованы»."""

    # --- стиль
    liveliness: str = "normal"
    """Живость изложения: `normal` | `high`.

    Заказчик: «статьи живее академических работ, вместе с тем я допускаю
    использование определённой живости и в научных работах — так работы
    легче воспринимаются».

    Замеры подтверждают: доля коротких предложений в его диссертациях
    14% (медиана), в статьях 31%. Живость в науке уместна, вопрос
    дозировки. При `high` целевой ориентир — медиана автора, и недобор
    становится браком, а не замечанием.
    """

    cliche_policy: str = "author_level"
    """`author_level` — порог не выше авторского (выбор пользователя).
    `strict` — жёсткий ноль, но тогда текст перестанет быть похож на
    авторский; оставлено как осознанный опт-ин."""

    # --- объёмы
    volumes: VolumeLimits = field(default_factory=VolumeLimits)

    # --- источники
    require_source_verification: bool = True
    """Каждая ссылка на норму и дело проверяется. Отключать нельзя без
    веской причины: чистая LLM выдумывает и номера статей, и дела."""

    def __post_init__(self) -> None:
        if isinstance(self.kind, str):
            self.kind = WorkKind(self.kind)
        if isinstance(self.subject, str):
            self.subject = Subject(self.subject)
        for f_ in ("cases", "tables", "charts", "law_proposals"):
            v = getattr(self, f_)
            if isinstance(v, str):
                setattr(self, f_, Requirement(v))
        if isinstance(self.theses_per_section, list):
            self.theses_per_section = tuple(self.theses_per_section)

        lo, hi = self.theses_per_section
        if lo > hi:
            raise ValueError(f"theses_per_section: {lo} > {hi}")
        if self.chapters is not None and not 1 <= self.chapters <= 6:
            raise ValueError(f"chapters={self.chapters} вне разумных границ")

    # ------------------------------------------------ производные правила

    @property
    def needs_hypothesis(self) -> bool:
        """Гипотеза и её оценка — только для диссертации."""
        return self.kind is WorkKind.thesis

    @property
    def is_legal(self) -> bool:
        return self.subject is Subject.legal

    @property
    def allowed_chapter_counts(self) -> tuple[int, ...]:
        """2 или 3 — стандарт. Больше, чем нужно, делать не стоит."""
        if self.chapters is not None:
            return (self.chapters,)
        return (2, 3)

    @property
    def expects_law_proposals(self) -> bool:
        """В юридической работе предложения желательны по умолчанию."""
        if self.law_proposals is Requirement.required:
            return True
        if self.law_proposals is Requirement.forbidden:
            return False
        return self.is_legal

    def resolved_volumes(self) -> VolumeLimits:
        """Объёмы с поправкой на жанр."""
        if self.volumes != VolumeLimits():
            return self.volumes          # пользователь задал явно
        if self.kind is WorkKind.thesis:
            return THESIS_VOLUMES
        return self.volumes

    # ------------------------------------------------ сериализация

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        for k, v in d.items():
            if isinstance(v, Enum):
                d[k] = v.value
        d["kind"] = self.kind.value
        d["subject"] = self.subject.value
        for f_ in ("cases", "tables", "charts", "law_proposals"):
            d[f_] = getattr(self, f_).value
        d["theses_per_section"] = list(self.theses_per_section)
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "WorkPreferences":
        known = {f for f in cls.__dataclass_fields__}
        payload = {k: v for k, v in (data or {}).items() if k in known}
        if isinstance(payload.get("volumes"), dict):
            payload["volumes"] = VolumeLimits(**payload["volumes"])
        return cls(**payload)

    def summary(self) -> str:
        """Человекочитаемая сводка — показать пользователю перед стартом."""
        v = self.resolved_volumes()
        ch = (f"{self.chapters} (по методичке)" if self.chapters
              else "2 или 3")
        rus = {
            Requirement.required: "обязательно",
            Requirement.when_relevant: "где уместно",
            Requirement.forbidden: "не нужно",
        }
        lo, hi = self.theses_per_section
        return "\n".join([
            f"Вид работы: {self.kind.value}, предмет: {self.subject.value}",
            f"Глав: {ch}"
            + (", выводы по каждой" if self.chapter_conclusions else ""),
            f"Введение: {v.intro_min}–{v.intro_max} знаков б/п"
            + (", с гипотезой" if self.needs_hypothesis else ", без гипотезы"),
            f"Раздел: {v.section_min}–{v.section_max} знаков б/п, "
            f"тезисов {lo}–{hi}",
            f"Судебная практика: {rus[self.cases]}",
            f"Таблицы: {rus[self.tables]}, графики: {rus[self.charts]}"
            + (" (пустые не принимаются)" if self.forbid_empty_visuals else ""),
            f"Предложения по законодательству: "
            f"{'да' if self.expects_law_proposals else 'нет'}",
            f"Клише: {'не выше авторского уровня' if self.cliche_policy == 'author_level' else 'жёсткий ноль'}",
            f"Живость изложения: "
            f"{'повышенная (как в статьях)' if self.liveliness == 'high' else 'обычная для науки'}",
        ])


# Готовые пресеты — чтобы пользователь не заполнял всё с нуля.
PRESETS: dict[str, WorkPreferences] = {
    "coursework_legal": WorkPreferences(
        kind=WorkKind.coursework, subject=Subject.legal,
    ),
    "coursework_economics": WorkPreferences(
        kind=WorkKind.coursework, subject=Subject.economics,
        cases=Requirement.forbidden,
        tables=Requirement.when_relevant,
        charts=Requirement.when_relevant,
        law_proposals=Requirement.forbidden,
    ),
    "thesis_legal": WorkPreferences(
        kind=WorkKind.thesis, subject=Subject.legal,
        chapters=3,
        theses_per_section=(5, 12),
        cases=Requirement.required, min_cases_per_section=1,
        law_proposals=Requirement.required,
        volumes=THESIS_VOLUMES,
    ),
}
