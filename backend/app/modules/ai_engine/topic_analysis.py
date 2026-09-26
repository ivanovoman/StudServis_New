"""Этап 1: анализ темы.

Первый шаг конвейера и единственный, который увидят все пользователи:
он бесплатный и не ограничивается лимитами.

## Почему выход структурированный

Промпт из `api/prompts.js` просит «структурированные заметки». Свободный
текст нельзя ни проверить автоматически, ни передать следующему этапу:
план работы должен строиться на тезисах анализа, а выцарапывать их
регулярками из прозы — источник ошибок.

Поэтому модель обязана вернуть JSON фиксированной формы. Это же даёт
возможность проверять результат по существу: сколько тезисов, есть ли
спорные моменты, не выдуманы ли номера дел.

## Про выдуманную фактуру

Ранняя проверка показала: чистая LLM галлюцинирует юридические реквизиты
уверенно и правдоподобно — «ФЗ №208-ФЗ „О несостоятельности“» (на деле
208-ФЗ об АО), дело №А40-15002/2019 с несуществующими фирмами,
«ст. 61.2» вместо 61.10.

На этапе анализа темы у нас ещё нет RAG и проверки источников, поэтому
правило простое: **модель не называет конкретные реквизиты, а описывает,
что искать.** Всё, что похоже на точный номер дела или статьи, здесь
считается дефектом и переносится в `search_directions` как задание на
поиск. Проверка ссылок появится на этапе Sources & Verification.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from app.modules.projects.preferences import Subject, WorkPreferences

MIN_THESES = 3
MAX_THESES = 7
MIN_DIRECTIONS = 5
MAX_DIRECTIONS = 8


SYSTEM_PROMPT = """Ты — научный руководитель, который разбирает тему \
студенческой работы перед тем, как её писать.

ЗАДАЧА: проанализировать тему. НЕ писать саму работу.

Верни СТРОГО JSON без пояснений до или после, по схеме:

{
  "core": "одно предложение: в чём суть темы, что именно исследуется",
  "theses": ["тезис 1", "тезис 2", ...],
  "logic_arc": ["этап 1", "этап 2", ...],
  "controversies": ["спорный момент 1", ...],
  "banality_risks": ["где легко скатиться в банальность", ...],
  "search_directions": ["что искать 1", ...]
}

ТРЕБОВАНИЯ:
- theses: от 3 до 7 ключевых утверждений, которые работа должна \
раскрыть. Для сложной многогранной темы — больше, для узкой — меньше. \
Каждый тезис содержательный, а не название раздела.
- logic_arc: в каком порядке раскрывать тему и почему такой порядок.
- controversies: где в теме есть реальные разногласия — позиции судов, \
споры в доктрине, пробелы регулирования. Если тема бесспорная, верни \
пустой список, не выдумывай.
- banality_risks: конкретные формулировки-ловушки, куда скатываются \
слабые работы по этой теме.
- search_directions: от 5 до 8 направлений поиска источников.

КРИТИЧЕСКИ ВАЖНО ПРО ФАКТУРУ:
Не называй конкретные номера дел, статей, законов, даты и суммы. \
На этом этапе они не проверены, а выдуманные реквизиты хуже, чем их \
отсутствие. Вместо «дело № А40-1234/2022» пиши «практика окружных \
судов по оспариванию сделок за последние 3 года». Вместо «ст. 61.10» \
пиши «нормы о контролирующих лицах в законе о банкротстве».
Исключение: общеизвестные кодексы можно называть по имени (ГК РФ, УК РФ).

Отвечай на русском языке."""


def build_user_prompt(topic: str, prefs: WorkPreferences) -> str:
    subject_ru = {
        Subject.legal: "юридическая",
        Subject.economics: "экономическая",
        Subject.other: "общая",
    }[prefs.subject]
    lo, hi = prefs.theses_per_section
    parts = [
        f"Тема: {topic}",
        f"Предмет: {subject_ru}",
        f"Вид работы: {prefs.kind.value}",
        f"Планируется глав: {' или '.join(map(str, prefs.allowed_chapter_counts))}",
    ]
    if prefs.subject is Subject.legal:
        parts.append(
            "Работа юридическая: в направлениях поиска учти нормы права "
            "и судебную практику."
        )
    else:
        parts.append(
            "Работа не юридическая: не навязывай ссылки на нормы права, "
            "если тема их не требует."
        )
    parts.append(
        f"Ориентир по числу тезисов: около {lo}-{hi}, "
        "но исходи из сложности темы."
    )
    return "\n".join(parts)


# Похоже на точный реквизит, который модель не могла проверить.
RE_CASE_NUMBER = re.compile(r"№\s*[АA]\d{1,2}[-–]\d+")
RE_ARTICLE_NUMBER = re.compile(r"(?i)\bст(?:атья|\.)\s*\d+")
RE_LAW_NUMBER = re.compile(r"№\s*\d+[-–]?\s*ФЗ")
RE_MONEY = re.compile(r"\d[\d\s]{2,}\s*(?:руб|тыс|млн|млрд)")

FABRICATION_PATTERNS = [
    ("номер дела", RE_CASE_NUMBER),
    ("номер статьи", RE_ARTICLE_NUMBER),
    ("номер закона", RE_LAW_NUMBER),
    ("конкретная сумма", RE_MONEY),
]


@dataclass
class TopicAnalysis:
    core: str = ""
    theses: list[str] = field(default_factory=list)
    logic_arc: list[str] = field(default_factory=list)
    controversies: list[str] = field(default_factory=list)
    banality_risks: list[str] = field(default_factory=list)
    search_directions: list[str] = field(default_factory=list)
    model: str = ""
    raw: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "core": self.core,
            "theses": self.theses,
            "logic_arc": self.logic_arc,
            "controversies": self.controversies,
            "banality_risks": self.banality_risks,
            "search_directions": self.search_directions,
            "model": self.model,
        }


@dataclass
class AnalysisIssue:
    rule: str
    message: str
    severity: str = "error"


@dataclass
class AnalysisCheck:
    issues: list[AnalysisIssue] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not any(i.severity == "error" for i in self.issues)

    def add(self, rule: str, message: str, severity: str = "error") -> None:
        self.issues.append(AnalysisIssue(rule, message, severity))

    def report(self) -> str:
        if not self.issues:
            return "OK"
        return "\n".join(f"[{i.severity}] {i.rule}: {i.message}" for i in self.issues)


def extract_json(text: str) -> dict[str, Any]:
    """Достаёт JSON из ответа модели.

    Модели любят обрамлять JSON пояснениями и ```-блоками, несмотря на
    запрет в промпте. Поэтому берём первый сбалансированный объект.
    """
    if not text:
        raise ValueError("пустой ответ модели")
    cleaned = re.sub(r"```(?:json)?", "", text).strip()
    start = cleaned.find("{")
    if start == -1:
        raise ValueError("в ответе нет JSON")
    depth = 0
    in_str = False
    esc = False
    for i, ch in enumerate(cleaned[start:], start):
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return json.loads(cleaned[start:i + 1])
    raise ValueError("незакрытый JSON в ответе модели")


def parse_analysis(raw: str, model: str = "") -> TopicAnalysis:
    data = extract_json(raw)

    def as_list(key: str) -> list[str]:
        v = data.get(key, [])
        if isinstance(v, str):
            v = [v]
        return [str(x).strip() for x in v if str(x).strip()]

    return TopicAnalysis(
        core=str(data.get("core", "")).strip(),
        theses=as_list("theses"),
        logic_arc=as_list("logic_arc"),
        controversies=as_list("controversies"),
        banality_risks=as_list("banality_risks"),
        search_directions=as_list("search_directions"),
        model=model,
        raw=raw,
    )


def check_analysis(a: TopicAnalysis, *,
                   prefs: WorkPreferences | None = None) -> AnalysisCheck:
    """Проверяет анализ темы по существу, а не по объёму."""
    prefs = prefs or WorkPreferences()
    res = AnalysisCheck()

    if not a.core:
        res.add("core", "не сформулировано ядро темы")
    elif len(a.core.split()) < 5:
        res.add("core", f"ядро темы слишком куцее: «{a.core}»")

    n = len(a.theses)
    if n < MIN_THESES:
        res.add("theses", f"тезисов {n}, нужно минимум {MIN_THESES}")
    elif n > MAX_THESES:
        res.add("theses", f"тезисов {n}, максимум {MAX_THESES} — дробится",
                severity="warning")

    # Тезис должен быть утверждением, а не заголовком раздела.
    short = [t for t in a.theses if len(t.split()) < 5]
    if short:
        res.add("theses",
                f"это заголовки, а не тезисы: {short[:3]}")

    if len(a.logic_arc) < 2:
        res.add("logic_arc", "не описана логика раскрытия темы")

    if len(a.search_directions) < MIN_DIRECTIONS:
        res.add("search_directions",
                f"направлений поиска {len(a.search_directions)}, "
                f"нужно минимум {MIN_DIRECTIONS}")

    if not a.banality_risks:
        res.add("banality_risks",
                "не указано, где тема скатывается в банальность",
                severity="warning")

    # Главное: выдуманная фактура.
    everything = " ".join(
        [a.core] + a.theses + a.logic_arc + a.controversies
        + a.banality_risks + a.search_directions
    )
    for label, pattern in FABRICATION_PATTERNS:
        found = pattern.findall(everything)
        if found:
            res.add(
                "fabrication",
                f"на этапе анализа назван {label} ({found[:2]}) — "
                "он не проверен и может быть выдуман; "
                "нужно описание того, что искать",
            )

    # Дубликаты тезисов.
    norm = [re.sub(r"\W+", " ", t.lower()).strip() for t in a.theses]
    if len(set(norm)) < len(norm):
        res.add("theses", "есть повторяющиеся тезисы")

    return res


async def analyze_topic(topic: str, *,
                        prefs: WorkPreferences | None = None,
                        router: Any = None) -> tuple[TopicAnalysis, AnalysisCheck]:
    """Прогоняет анализ темы через роутер моделей."""
    prefs = prefs or WorkPreferences()
    if router is None:
        from app.modules.ai_engine.router import get_router
        router = get_router()

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": build_user_prompt(topic, prefs)},
    ]
    chunks: list[str] = []
    async for delta in router.stream(messages):
        chunks.append(delta)
    raw = "".join(chunks)

    analysis = parse_analysis(raw)
    return analysis, check_analysis(analysis, prefs=prefs)
