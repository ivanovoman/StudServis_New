"""Анализ темы, опирающийся на реальные источники.

Идея заказчика: чтобы анализ был качественным, надо сначала вытащить
2-3 релевантных источника последних лет и разбирать проблемы, которые
подняты в них, а не те, что модель придумала.

## Как это меняет этап 1

Было:
    тема → LLM по памяти → тезисы (проверяем, чтобы не выдумывала
    реквизиты)

Стало:
    тема → предварительные направления поиска
         → OpenAlex: реальные OA-работы последних лет
         → абстракты в контекст модели
         → LLM разбирает то, что написано в источниках
         → каждый тезис привязан к источнику

## Почему абстрактов достаточно на этом этапе

Проверил на живых данных: у 9 из 10 работ по юридической теме абстракт
есть, у свежих — 800-2300 знаков. Это полноценная постановка проблемы:
что исследуется, в чём спор, к какому выводу пришёл автор. Для анализа
темы этого хватает; полные тексты понадобятся позже, при написании
разделов, и тянуть их надо только для OA-работ.

## Про RAG

Источники кладутся в коллекцию `user_project_{id}` как чанки — той же
формы, что и остальной корпус (`rag_service.ingest.Chunk`). Тогда при
написании разделов они находятся поиском наравне с прочими
материалами, а не живут отдельной сущностью.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from app.modules.sources.openalex import Source, find_sources_for_topic

MAX_ABSTRACT_IN_PROMPT = 1200

#: Полного текста берём больше, чем аннотации, но не весь: шесть статей
#: целиком не поместятся в контекст free-модели.
MAX_FULLTEXT_IN_PROMPT = 3500
MIN_SOURCES_FOR_GROUNDING = 2


GROUNDED_SYSTEM_PROMPT = """Ты — научный руководитель, который разбирает \
тему студенческой работы, опираясь на реальные научные публикации.

Тебе даны АБСТРАКТЫ реальных статей последних лет. Твой анализ должен \
опираться на них, а не на общие рассуждения.

Верни СТРОГО JSON без пояснений до или после:

{
  "core": "одно предложение: в чём суть темы",
  "theses": [
    {"text": "тезис", "source": 2}
  ],
  "logic_arc": ["этап 1", "этап 2"],
  "controversies": [
    {"text": "в чём именно расходятся авторы или суды", "source": 1}
  ],
  "banality_risks": ["куда скатываются слабые работы"],
  "search_directions": ["что ещё поискать"],
  "gaps": ["что источники НЕ покрывают"]
}

ПРАВИЛА:
- theses: 3-7 тезисов. Поле source — номер источника из списка ниже, \
на котором тезис основан. Если тезис твой собственный вывод, а не из \
источника, ставь source: null и формулируй осторожно.
- controversies: реальные разногласия, видные из абстрактов. Если \
источники не спорят друг с другом, верни пустой список — не выдумывай \
полемику.
- gaps: чего в найденных источниках нет, но для темы нужно. Это \
честная оценка ограничений подборки.
- Не называй номера дел, статей, законов и суммы, которых нет в \
абстрактах. Если реквизит есть в источнике — можешь его привести.
- Опирайся на то, что действительно написано в абстрактах. Не \
приписывай авторам выводы, которых там нет.

Отвечай на русском."""


def format_sources_for_prompt(sources: list[Source]) -> str:
    """Готовит блок источников для промпта.

    Где есть полный текст (КиберЛенинка), в промпт идёт его начало —
    там обычно постановка проблемы и обзор позиций, то есть самое
    полезное для разбора темы. Где текста нет — аннотация.
    """
    lines = []
    for i, s in enumerate(sources, 1):
        body = s.content
        limit = (MAX_FULLTEXT_IN_PROMPT if s.fulltext
                 else MAX_ABSTRACT_IN_PROMPT)
        if len(body) > limit:
            body = body[:limit].rsplit(" ", 1)[0] + "…"
        label = "Фрагмент статьи" if s.fulltext else "Аннотация"
        who = ", ".join(s.authors[:2]) if s.authors else "автор не указан"
        lines.append(
            f"[{i}] {s.title}\n"
            f"    {who}, {s.year or 'год не указан'}"
            + (f", {s.venue}" if s.venue else "")
            + f"\n    {label}: {body}"
        )
    return "\n\n".join(lines)


@dataclass
class GroundedThesis:
    text: str
    source_index: int | None = None

    @property
    def is_grounded(self) -> bool:
        return self.source_index is not None


@dataclass
class GroundedAnalysis:
    core: str = ""
    theses: list[GroundedThesis] = field(default_factory=list)
    logic_arc: list[str] = field(default_factory=list)
    controversies: list[GroundedThesis] = field(default_factory=list)
    banality_risks: list[str] = field(default_factory=list)
    search_directions: list[str] = field(default_factory=list)
    gaps: list[str] = field(default_factory=list)
    sources: list[Source] = field(default_factory=list)

    @property
    def grounded_share(self) -> float:
        """Доля тезисов, опирающихся на источник."""
        if not self.theses:
            return 0.0
        return sum(t.is_grounded for t in self.theses) / len(self.theses)

    def source_of(self, t: GroundedThesis) -> Source | None:
        if t.source_index is None:
            return None
        i = t.source_index - 1
        return self.sources[i] if 0 <= i < len(self.sources) else None

    def to_dict(self) -> dict[str, Any]:
        def dump(items: list[GroundedThesis]) -> list[dict]:
            out = []
            for t in items:
                s = self.source_of(t)
                out.append({
                    "text": t.text,
                    "source_index": t.source_index,
                    "source": s.short_ref() if s else None,
                    "doi": s.doi if s else None,
                })
            return out

        return {
            "core": self.core,
            "theses": dump(self.theses),
            "controversies": dump(self.controversies),
            "logic_arc": self.logic_arc,
            "banality_risks": self.banality_risks,
            "search_directions": self.search_directions,
            "gaps": self.gaps,
            "grounded_share": round(self.grounded_share, 2),
            "sources": [
                {**s.to_dict(), "index": i, "gost": s.gost_ref()}
                for i, s in enumerate(self.sources, 1)
            ],
        }


def _as_thesis_list(raw: Any) -> list[GroundedThesis]:
    out: list[GroundedThesis] = []
    if isinstance(raw, str):
        raw = [raw]
    for item in raw or []:
        if isinstance(item, str):
            text, idx = item.strip(), None
        elif isinstance(item, dict):
            text = str(item.get("text", "")).strip()
            src = item.get("source")
            idx = int(src) if isinstance(src, (int, float)) else None
            if isinstance(src, str) and src.strip().isdigit():
                idx = int(src.strip())
        else:
            continue
        if text:
            out.append(GroundedThesis(text=text, source_index=idx))
    return out


def parse_grounded(raw: str, sources: list[Source]) -> GroundedAnalysis:
    from app.modules.ai_engine.topic_analysis import extract_json

    data = extract_json(raw)

    def strlist(key: str) -> list[str]:
        v = data.get(key, [])
        if isinstance(v, str):
            v = [v]
        return [str(x).strip() for x in v if str(x).strip()]

    return GroundedAnalysis(
        core=str(data.get("core", "")).strip(),
        theses=_as_thesis_list(data.get("theses")),
        controversies=_as_thesis_list(data.get("controversies")),
        logic_arc=strlist("logic_arc"),
        banality_risks=strlist("banality_risks"),
        search_directions=strlist("search_directions"),
        gaps=strlist("gaps"),
        sources=sources,
    )


def check_grounding(a: GroundedAnalysis, *,
                    min_grounded_share: float = 0.5) -> list[str]:
    """Проверяет, что анализ действительно опирается на источники."""
    problems: list[str] = []

    if len(a.sources) < MIN_SOURCES_FOR_GROUNDING:
        problems.append(
            f"источников найдено {len(a.sources)}, "
            f"нужно минимум {MIN_SOURCES_FOR_GROUNDING}"
        )

    if a.theses and a.grounded_share < min_grounded_share:
        problems.append(
            f"на источники опирается лишь {a.grounded_share:.0%} тезисов "
            f"(нужно {min_grounded_share:.0%}) — остальное модель придумала"
        )

    # Ссылка на источник, которого нет в подборке.
    n = len(a.sources)
    for t in a.theses + a.controversies:
        if t.source_index is not None and not (1 <= t.source_index <= n):
            problems.append(
                f"ссылка на источник [{t.source_index}], которого нет "
                f"в подборке из {n}: «{t.text[:60]}…»"
            )

    if not a.gaps:
        problems.append(
            "не указано, чего в найденных источниках не хватает "
            "(это предупреждение, а не брак)"
        )

    return problems


def sources_to_chunks(sources: list[Source], project_id: str) -> list[Any]:
    """Кладёт источники в RAG той же формы, что остальной корпус."""
    from app.modules.rag_service.ingest import Chunk

    chunks = []
    for i, s in enumerate(sources, 1):
        if not s.abstract:
            continue
        chunks.append(Chunk(
            text=f"{s.title}\n\n{s.abstract}",
            collection=f"user_project_{project_id}",
            metadata={
                "kind": "source_abstract",
                "source_index": i,
                "title": s.title,
                "year": s.year,
                "doi": s.doi,
                "url": s.url,
                "authors": s.authors,
                "venue": s.venue,
                "is_oa": s.is_oa,
                "gost": s.gost_ref(),
            },
        ))
    return chunks


async def analyze_topic_grounded(
    topic: str, *,
    prefs=None,
    router=None,
    sources: list[Source] | None = None,
    directions: list[str] | None = None,
) -> tuple[GroundedAnalysis, list[str]]:
    """Полный этап 1: предварительный разбор → поиск → анализ по источникам."""
    from app.modules.ai_engine.topic_analysis import analyze_topic
    from app.modules.projects.preferences import WorkPreferences

    prefs = prefs or WorkPreferences()

    # Шаг 1: черновой разбор, чтобы получить направления поиска.
    if directions is None:
        draft, _ = await analyze_topic(topic, prefs=prefs, router=router)
        directions = draft.search_directions[:4] or [topic]

    # Шаг 2: реальные источники из всех доступных баз.
    if sources is None:
        from app.modules.sources.registry import find_sources
        sources = await find_sources(topic, directions, limit=6)

    if len(sources) < MIN_SOURCES_FOR_GROUNDING:
        return (
            GroundedAnalysis(sources=sources),
            [f"источников найдено {len(sources)} — анализ по источникам "
             "невозможен, нужен запасной путь"],
        )

    # Шаг 3: анализ с опорой на абстракты.
    if router is None:
        from app.modules.ai_engine.router import get_router
        router = get_router()

    user_prompt = (
        f"Тема работы: {topic}\n\n"
        f"НАЙДЕННЫЕ ИСТОЧНИКИ:\n\n{format_sources_for_prompt(sources)}"
    )
    messages = [
        {"role": "system", "content": GROUNDED_SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt},
    ]
    raw = "".join([c async for c in router.stream(messages)])

    analysis = parse_grounded(raw, sources)
    return analysis, check_grounding(analysis)
