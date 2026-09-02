"""Объединённый поиск источников по нескольким базам.

Ни одна бесплатная база не покрывает русскую научную периодику целиком.
OpenAlex даёт DOI, счётчик цитирований и честный фильтр по годам, но
хранит только абстракты и по узким русским темам редеет. КиберЛенинка
целиком русскоязычная и отдаёт полные тексты, но без DOI, без
цитируемости и без фильтра по дате.

Поэтому базы складываются, а не заменяют друг друга: ищем в обеих,
сливаем по нормализованному заголовку, ранжируем общим ключом.
"""

from __future__ import annotations

import asyncio
from datetime import date
from typing import Iterable

from app.modules.sources import cyberleninka, openalex
from app.modules.sources.openalex import (
    Source, deduplicate, normalize_title, relevance)

#: Глубина поиска по умолчанию — последние пять лет.
DEFAULT_YEARS_BACK = 5

#: Сколько статей догружать полным текстом.
FULLTEXT_LIMIT = 3


def merge(*groups: Iterable[Source]) -> list[Source]:
    """Слить выдачи разных баз, предпочитая записи с DOI.

    Если одна статья нашлась в обеих базах, у записи OpenAlex есть DOI
    и цитируемость, а у КиберЛенинки — полный текст. Берём запись с
    DOI и переносим в неё текст.
    """
    by_title: dict[str, Source] = {}
    order: list[str] = []

    for group in groups:
        for source in group:
            key = normalize_title(source.title)
            if not key:
                continue
            existing = by_title.get(key)
            if existing is None:
                by_title[key] = source
                order.append(key)
                continue
            # Дубль. Собираем лучшее из двух записей.
            if not existing.doi and source.doi:
                source.fulltext = source.fulltext or existing.fulltext
                source.abstract = source.abstract or existing.abstract
                by_title[key] = source
            else:
                existing.fulltext = existing.fulltext or source.fulltext
                existing.abstract = existing.abstract or source.abstract
                if not existing.url:
                    existing.url = source.url

    return [by_title[k] for k in order]


def rank(sources: Iterable[Source], topic: str) -> list[Source]:
    """Отсортировать: релевантность, потом свежесть, потом цитируемость.

    Порядок важен именно такой. Когда свежесть стояла первой, выдачу
    забивали статьи текущего года не по теме.
    """
    def key(s: Source) -> tuple:
        return (
            round(relevance(s, topic), 2),
            s.year or 0,
            s.cited_by,
            # Полный текст ценнее абстракта при прочих равных.
            1 if s.fulltext else 0,
        )

    return sorted(sources, key=key, reverse=True)


async def find_sources(
    topic: str,
    directions: list[str],
    *,
    limit: int = 6,
    years_back: int = DEFAULT_YEARS_BACK,
    min_relevance: float = 0.3,
    with_fulltext: bool = True,
    providers: tuple[str, ...] = ("openalex", "cyberleninka"),
) -> list[Source]:
    """Найти источники по теме сразу в нескольких базах.

    Базы опрашиваются параллельно: каждая делает несколько сетевых
    запросов, последовательно это заняло бы вдвое дольше. Отказ одной
    базы не роняет поиск — обе возвращают пустой список при ошибке.
    """
    since = date.today().year - years_back
    tasks = []

    if "openalex" in providers:
        tasks.append(asyncio.to_thread(
            openalex.find_sources_for_topic,
            directions, topic=topic, limit=limit * 3))
    if "cyberleninka" in providers:
        tasks.append(asyncio.to_thread(
            cyberleninka.find_sources,
            topic, directions, min_year=since,
            min_relevance=min_relevance, limit=limit * 3))

    if not tasks:
        return []

    groups = await asyncio.gather(*tasks, return_exceptions=True)
    clean = [g for g in groups if isinstance(g, list)]

    merged = deduplicate(merge(*clean))
    scored = [(relevance(s, topic), s) for s in merged]
    relevant = [s for r, s in scored if r >= min_relevance]
    # Слабые источники лучше пустоты: анализ хотя бы на чём-то стоит.
    pool = relevant or [s for _, s in scored]

    top = rank(pool, topic)[:limit]

    # Сохраняем оценку: дальше её читает check_grounding, а показать её
    # пользователю честнее, чем прятать.
    for source in top:
        source.relevance = round(relevance(source, topic), 2)

    if with_fulltext:
        top = await cyberleninka.enrich_with_fulltext(
            top, limit=FULLTEXT_LIMIT)

    return top
