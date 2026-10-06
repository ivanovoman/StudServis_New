"""Досье по разделу: выдержки из реально прочитанных статей.

Зачем это понадобилось. Опыт показал, что модель не знает фактуру, а
сочиняет её: три модели, писавшие один раздел, сошлись между собой
почти ни на чём, а приведённые реквизиты при проверке оказывались
настоящими, но притянутыми не к месту. Зато тот же опыт показал и
обратное: когда модели дают готовый список норм, она берёт из него
четыре пункта из пяти и не выдумывает ничего сверх.

Отсюда порядок работы: сначала глубокий разбор темы (``research.py``)
добывает и складывает в библиотеку полные тексты статей, потом по
каждому разделу из этих текстов собирается досье — выдержки по теме
раздела, перечень реально упомянутых норм и фамилии учёных, — и уже
оно идёт в задание на черновик.

Важное решение об объёме. Черновик должен быть густо набит
содержанием, потому что следом идёт перепись кусками, а она умеет
менять форму, но не умеет добавлять знание. Чего нет в черновике, того
не будет и в работе. Поэтому досье берёт столько материала, сколько
влезает в разумный вход модели, а не пару коротких отрывков.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession

from .facts import extract_facts, extract_names
from .library import search_documents
from .research import KIND_RESEARCH

logger = logging.getLogger(__name__)

# Сколько знаков выдержек собирать по умолчанию.
#
# Девять тысяч — это примерно две с половиной тысячи токенов на вход,
# что GigaChat переваривает вместе с планом работы и образцом стиля.
# Меньше нет смысла: раздел на 5000-6000 знаков, написанный по трём
# коротким отрывкам, снова поедет на сочинительство.
DEFAULT_BUDGET_CHARS = 9000

# Сколько выдержек берём с одной статьи.
#
# Ограничение не техническое, а содержательное: без него одна большая
# и хорошо написанная статья вытесняет все прочие, и раздел получается
# её пересказом. Четыре куска с одного источника — потолок.
MAX_EXCERPTS_PER_SOURCE = 4

# Сколько источников должно быть в досье, чтобы раздел не выглядел
# пересказом одной работы.
MIN_SOURCES_WANTED = 2

# Короткие обрывки выбрасываем: смысла в них нет, а место занимают.
MIN_EXCERPT_CHARS = 200

# Номер акта должен иметь буквенный хвост: «№ 184-ФЗ», «№ 1-П».
#
# Голый «№ 1» в научной статье почти всегда оказывается номером
# сноски, а не акта. В перечень норм, которые модели разрешено
# называть, такие попадать не должны: она честно сошлётся на
# «акт № 1», которого не существует.
_ACT_NUMBER = re.compile(r"^№\s*\d+\s*[-–]\s*[А-ЯЁA-Zа-яё]+$")


def useful_norms(facts: list[str]) -> list[str]:
    """Оставляет то, что действительно годится как ссылка на норму."""
    out: list[str] = []
    for fact in facts:
        if fact.isdigit():          # год — не норма
            continue
        if fact.startswith("№") and not _ACT_NUMBER.match(fact):
            continue                # номер сноски
        out.append(fact)
    return out


@dataclass(slots=True)
class Excerpt:
    """Кусок статьи, отобранный под раздел."""

    source: str
    text: str
    score: float


@dataclass(slots=True)
class Dossier:
    """Всё, что собрано по разделу."""

    heading: str = ""
    queries: list[str] = field(default_factory=list)
    excerpts: list[Excerpt] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    facts: list[str] = field(default_factory=list)
    names: list[str] = field(default_factory=list)
    chars: int = 0
    prompt_block: str = ""


def _queries_for(heading: str, topic: str, extra: list[str] | None) -> list[str]:
    """Из чего искать выдержки под раздел.

    Один запрос по заголовку даёт узкую выборку: заголовки разделов
    пишут обобщённо («Понятие и признаки»), а в статьях те же мысли
    изложены другими словами. Поэтому к заголовку добавляются тема
    работы и значимые слова самого заголовка по отдельности.
    """
    queries: list[str] = []
    heading = (heading or "").strip()
    topic = (topic or "").strip()

    if heading:
        queries.append(heading)
    if topic and topic.lower() not in heading.lower():
        queries.append(f"{heading} {topic}".strip())

    for item in extra or []:
        item = (item or "").strip()
        if item:
            queries.append(item)

    # Значимые слова заголовка — отдельным запросом, если заголовок
    # длинный: так находятся места, где нужное сказано иначе.
    words = [w for w in re.findall(r"[А-Яа-яЁёA-Za-z]{5,}", heading)]
    if len(words) >= 3:
        queries.append(" ".join(words[:5]))

    seen: set[str] = set()
    out: list[str] = []
    for q in queries:
        key = q.lower()
        if key not in seen:
            seen.add(key)
            out.append(q)
    return out[:5]


def _shorten(text: str, limit: int) -> str:
    """Обрезает выдержку по границе предложения, а не по счётчику."""
    text = text.strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    # Точка внутри «ст. 15» предложение не кончает — ищем точку,
    # за которой идёт пробел и заглавная буква.
    marks = list(re.finditer(r"[.!?]\s+(?=[А-ЯЁA-Z])", cut))
    if marks and marks[-1].end() > limit * 0.5:
        return cut[:marks[-1].start() + 1].strip()
    return cut.rstrip() + "…"


async def build_dossier(
    session: AsyncSession,
    *,
    owner_key: str,
    heading: str,
    topic: str = "",
    queries: list[str] | None = None,
    budget_chars: int = DEFAULT_BUDGET_CHARS,
    research_only: bool = True,
) -> Dossier:
    """Собирает досье по разделу из прочитанных статей.

    :param research_only: брать только добытое глубоким разбором темы.
        Методички и конспекты пользователя попадают в задание другим
        путём и с другой ролью, мешать их с научной литературой не
        нужно.
    """
    heading = (heading or "").strip()
    search_queries = _queries_for(heading, topic, queries)
    if not search_queries:
        return Dossier(heading=heading)

    # Берём с запасом: часть отсеется по источникам и по длине.
    per_query = max(6, MAX_EXCERPTS_PER_SOURCE * 3)

    seen_texts: set[str] = set()
    pool: list[Excerpt] = []

    for query in search_queries:
        try:
            hits = await search_documents(
                session, owner_key=owner_key, query=query, limit=per_query,
            )
        except Exception as exc:  # noqa: BLE001 — поиск не критичен
            logger.warning("Поиск по «%s» не удался: %s", query, exc)
            continue

        for hit in hits:
            if research_only and hit.get("kind") != KIND_RESEARCH:
                continue
            text = (hit.get("text") or "").strip()
            if len(text) < MIN_EXCERPT_CHARS:
                continue
            key = text[:120]
            if key in seen_texts:
                continue
            seen_texts.add(key)
            pool.append(Excerpt(
                source=hit.get("source") or "Источник без названия",
                text=text,
                score=float(hit.get("score") or 0),
            ))

    if not pool:
        return Dossier(heading=heading, queries=search_queries)

    pool.sort(key=lambda e: e.score, reverse=True)

    # Отбор с оглядкой на разнообразие источников.
    taken: list[Excerpt] = []
    per_source: dict[str, int] = {}
    used = 0

    for excerpt in pool:
        if used >= budget_chars:
            break
        if per_source.get(excerpt.source, 0) >= MAX_EXCERPTS_PER_SOURCE:
            continue
        room = budget_chars - used
        text = _shorten(excerpt.text, min(len(excerpt.text), room))
        if len(text) < MIN_EXCERPT_CHARS:
            continue
        taken.append(Excerpt(source=excerpt.source, text=text,
                             score=excerpt.score))
        per_source[excerpt.source] = per_source.get(excerpt.source, 0) + 1
        used += len(text)

    # Фактура и имена считаются по отобранному, а не по всей
    # библиотеке: модели нельзя обещать нормы, которых она не увидит.
    joined = "\n".join(e.text for e in taken)
    facts = sorted(extract_facts(joined))
    names = sorted(extract_names(joined))

    sources = list(dict.fromkeys(e.source for e in taken))

    dossier = Dossier(
        heading=heading,
        queries=search_queries,
        excerpts=taken,
        sources=sources,
        facts=facts,
        names=names,
        chars=used,
    )
    dossier.prompt_block = format_dossier(dossier)
    return dossier


def format_dossier(dossier: Dossier) -> str:
    """Собирает досье в текст для задания модели.

    Формат рассчитан на то, чтобы модель могла сослаться номером: она
    видит выдержку и рядом номер источника, из которого та взята.
    """
    if not dossier.excerpts:
        return ""

    by_source: dict[str, list[str]] = {}
    for excerpt in dossier.excerpts:
        by_source.setdefault(excerpt.source, []).append(excerpt.text)

    parts: list[str] = ["ВЫДЕРЖКИ ИЗ ПРОЧИТАННЫХ СТАТЕЙ ПО ЭТОМУ РАЗДЕЛУ\n"]

    for number, source in enumerate(dossier.sources, start=1):
        parts.append(f"[{number}] {source}")
        for text in by_source.get(source, []):
            parts.append(f"    «{text}»")
        parts.append("")

    if dossier.facts:
        norms = useful_norms(dossier.facts)
        if norms:
            parts.append(
                "НОРМЫ И АКТЫ, НАЗВАННЫЕ В ЭТИХ ИСТОЧНИКАХ: "
                + ", ".join(norms) + "."
            )

    if dossier.names:
        parts.append(
            "УЧЁНЫЕ, НА КОТОРЫХ ССЫЛАЮТСЯ В ЭТИХ ИСТОЧНИКАХ: "
            + ", ".join(dossier.names[:20]) + "."
        )

    return "\n".join(parts).strip()
