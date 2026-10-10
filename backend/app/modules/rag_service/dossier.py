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

from .facts import extract_facts, extract_names, extract_norm_refs, norm_hits
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
# Доля бюджета досье, отложенная под выдержки со ссылками на нормы.
NORM_RESERVE_SHARE = 0.3

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
    norm_refs: list[str] = field(default_factory=list)
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


# Слова-приманки для фактурных запросов.
#
# Поиск по смыслу раздела находит рассуждения, а ссылки на нормы в
# научных статьях редки — одна на пять тысяч знаков — и в такую
# выдачу просто не попадают. Проверено на живой библиотеке: по трём
# обычным запросам пул из семнадцати кусков не содержал ни одной
# ссылки, а те же статьи по запросу со словами ниже дают двенадцать
# связок на двенадцати кусках.
_NORM_BAIT = ("Конституция Российской Федерации статья "
              "высшая юридическая сила ГК РФ норма закона")
_PRACTICE_BAIT = ("Верховный Суд Конституционный Суд постановление "
                  "Пленума определение практика")


def _fact_queries(heading: str, topic: str) -> list[str]:
    """Запросы, нацеленные не на смысл, а на фактуру."""
    ядро = " ".join(
        dict.fromkeys(re.findall(r"[А-Яа-яЁёA-Za-z]{5,}", f"{heading} {topic}"))
    ).strip()
    if not ядро:
        return []
    return [f"{ядро} {_NORM_BAIT}", f"{ядро} {_PRACTICE_BAIT}"]


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
    norm_pool: list[Excerpt] = []

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

    # Второй заход — за фактурой. Эти куски в общий пул не кладём:
    # по смыслу они слабее и вытеснили бы содержательные рассуждения.
    # Их место — в отложенной под нормы части бюджета.
    for query in _fact_queries(heading, topic):
        try:
            hits = await search_documents(
                session, owner_key=owner_key, query=query, limit=12,
            )
        except Exception as exc:  # noqa: BLE001 — поиск не критичен
            logger.warning("Запрос за фактурой «%s» не удался: %s", query, exc)
            continue

        for hit in hits:
            if research_only and hit.get("kind") != KIND_RESEARCH:
                continue
            text = (hit.get("text") or "").strip()
            if len(text) < MIN_EXCERPT_CHARS or not norm_hits(text):
                continue
            key = text[:120]
            if key in seen_texts:
                continue
            seen_texts.add(key)
            norm_pool.append(Excerpt(
                source=hit.get("source") or "Источник без названия",
                text=text,
                score=float(hit.get("score") or 0),
            ))

    if not pool and not norm_pool:
        return Dossier(heading=heading, queries=search_queries)

    pool.sort(key=lambda e: e.score, reverse=True)

    # Отбор с оглядкой на разнообразие источников.
    #
    # Отбирать по одной смысловой близости оказалось мало. В разделе
    # эталонной курсовой ссылка на норму приходится примерно на
    # восемьсот знаков, а в наших разделах их не было вовсе. Причина
    # не в модели: нормы в добытых статьях есть, но редко — одна на
    # пять тысяч знаков, — и в девятитысячное досье при отборе по
    # близости попадала хорошо если одна.
    #
    # Поэтому часть бюджета отложена под выдержки со ссылками на
    # нормы. Близость остаётся главной: сначала обычный отбор на
    # урезанный бюджет, и только потом остаток добирается фактурой.
    # Если фактурных выдержек не нашлось, резерв возвращается общему
    # отбору — пустым досье не останется.
    taken: list[Excerpt] = []
    per_source: dict[str, int] = {}
    used = 0
    reserve = int(budget_chars * NORM_RESERVE_SHARE)

    def _try_take(excerpt: Excerpt, ceiling: int) -> bool:
        nonlocal used
        if used >= ceiling:
            return False
        if per_source.get(excerpt.source, 0) >= MAX_EXCERPTS_PER_SOURCE:
            return False
        text = _shorten(excerpt.text, min(len(excerpt.text), ceiling - used))
        if len(text) < MIN_EXCERPT_CHARS:
            return False
        # Обрезка по бюджету может отсечь как раз ту часть, ради
        # которой кусок и брали. Тогда он бесполезен.
        if norm_hits(excerpt.text) and not norm_hits(text):
            return False
        taken.append(Excerpt(source=excerpt.source, text=text,
                             score=excerpt.score))
        per_source[excerpt.source] = per_source.get(excerpt.source, 0) + 1
        used += len(text)
        return True

    for excerpt in pool:
        if used >= budget_chars - reserve:
            break
        _try_take(excerpt, budget_chars - reserve)

    # Добор фактурой: по убыванию числа ссылок на нормы, при равенстве
    # — по смысловой близости.
    if reserve:
        rest = norm_pool + [e for e in pool if e not in taken]
        with_norms = [(norm_hits(e.text), e) for e in rest]
        with_norms = [(n, e) for n, e in with_norms if n]
        with_norms.sort(key=lambda pair: (pair[0], pair[1].score), reverse=True)
        for _, excerpt in with_norms:
            if used >= budget_chars:
                break
            _try_take(excerpt, budget_chars)

    # Резерв не израсходован — отдаём его обычному отбору.
    for excerpt in pool:
        if used >= budget_chars:
            break
        if excerpt in taken:
            continue
        _try_take(excerpt, budget_chars)

    # Фактура и имена считаются по отобранному, а не по всей
    # библиотеке: модели нельзя обещать нормы, которых она не увидит.
    joined = "\n".join(e.text for e in taken)
    facts = sorted(extract_facts(joined))
    names = sorted(extract_names(joined))
    norm_refs = extract_norm_refs(joined)

    sources = list(dict.fromkeys(e.source for e in taken))

    dossier = Dossier(
        heading=heading,
        queries=search_queries,
        excerpts=taken,
        sources=sources,
        facts=facts,
        names=names,
        norm_refs=norm_refs,
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

    # Связки «статья + акт» идут впереди россыпи: именно ими модель
    # и должна ссылаться. Россыпь из «ст. 15» и «ГК РФ» порознь
    # провоцирует собрать пару, которой в источнике не было.
    if dossier.norm_refs:
        parts.append(
            "ССЫЛКИ НА НОРМЫ, ПРЯМО ВСТРЕЧАЮЩИЕСЯ В ЭТИХ ВЫДЕРЖКАХ "
            "(ссылаться можно только на них, и желательно на большую "
            "их часть — в научной работе ссылка на норму приходится "
            "примерно на каждые восемьсот знаков): "
            + "; ".join(dossier.norm_refs) + "."
        )

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
