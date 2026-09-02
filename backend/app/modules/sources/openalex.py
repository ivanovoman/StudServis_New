"""Поиск научных источников через OpenAlex.

Зачем. Анализ темы без источников — это пересказ того, что модель
«помнит», то есть в лучшем случае общие места, в худшем — выдуманные
реквизиты. Чтобы разбирать реальные проблемы, нужны реальные работы
последних лет.

Почему OpenAlex, а не SERPAPI из OpenDeepResearcher: бесплатно и без
ключа, только научные публикации, есть DOI (проверяемый идентификатор)
и флаг Open Access — ровно то, что требуется по условию «только
Open Access».

## Про абстракты

OpenAlex не отдаёт абстракт строкой. Он хранит `abstract_inverted_index`
— словарь «слово → позиции в тексте». Это наследие лицензионных
ограничений: инвертированный индекс формально не является копией
текста. Восстанавливается однозначно, функция `restore_abstract`.

## Про дубликаты

Одна и та же статья попадается под разными DOI (например, две записи
Zenodo, отличающиеся последней цифрой). Дедупликация только по DOI
их не ловит, поэтому дополнительно сравниваем нормализованные
заголовки.
"""

from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Iterable

API_URL = "https://api.openalex.org/works"

# OpenAlex просит представляться: вежливый пул даёт больше квоты.
USER_AGENT = "StudServis/1.0 (mailto:dev@studservis.ru)"

DEFAULT_TIMEOUT = 30.0
MIN_ABSTRACT_CHARS = 150


@dataclass
class Source:
    """Научная публикация, пригодная для цитирования."""

    title: str
    year: int | None = None
    doi: str | None = ""
    abstract: str = ""
    url: str = ""
    authors: list[str] = field(default_factory=list)
    venue: str | None = ""
    cited_by: int = 0
    is_oa: bool = False
    language: str = ""
    #: Откуда пришла запись: openalex или cyberleninka.
    provider: str = "openalex"
    #: Полный текст статьи, если база его отдаёт (КиберЛенинка).
    fulltext: str = ""

    @property
    def has_usable_abstract(self) -> bool:
        return len(self.abstract) >= MIN_ABSTRACT_CHARS or bool(self.fulltext)

    @property
    def content(self) -> str:
        """Текст для промпта: полный, если он есть, иначе абстракт."""
        return self.fulltext or self.abstract

    @property
    def is_russian(self) -> bool:
        if self.language:
            return self.language == "ru"
        return bool(re.search(r"[а-яА-ЯёЁ]", self.title))

    def short_ref(self) -> str:
        """Короткая ссылка для промпта."""
        who = self.authors[0] if self.authors else "Коллектив авторов"
        return f"{who} ({self.year or 'б.г.'}). {self.title}"

    def gost_ref(self) -> str:
        """Черновик ссылки по ГОСТ. Точное оформление — в модуле documents."""
        parts = []
        if self.authors:
            parts.append(f"{self.authors[0]}.")
        parts.append(f"{self.title} //")
        if self.venue:
            parts.append(f"{self.venue}.")
        if self.year:
            parts.append(f"{self.year}.")
        if self.doi:
            parts.append(f"DOI: {self.doi}")
        return " ".join(parts)

    def to_dict(self) -> dict[str, Any]:
        return {
            "title": self.title, "year": self.year, "doi": self.doi,
            "abstract": self.abstract, "url": self.url,
            "authors": self.authors, "venue": self.venue,
            "cited_by": self.cited_by, "is_oa": self.is_oa,
            "provider": self.provider,
            "language": self.language,
        }


def restore_abstract(inverted: dict[str, list[int]] | None) -> str:
    """Восстанавливает текст из inverted index OpenAlex."""
    if not inverted:
        return ""
    positions: dict[int, str] = {}
    for word, idxs in inverted.items():
        for i in idxs:
            positions[i] = word
    if not positions:
        return ""
    text = " ".join(positions[i] for i in sorted(positions))
    return re.sub(r"\s+", " ", text).strip()


def normalize_title(title: str) -> str:
    return re.sub(r"\W+", " ", (title or "").lower()).strip()


def parse_work(raw: dict[str, Any]) -> Source:
    oa = raw.get("open_access") or {}
    authorships = raw.get("authorships") or []
    authors = [
        (a.get("author") or {}).get("display_name", "")
        for a in authorships
    ]
    venue = ""
    loc = raw.get("primary_location") or {}
    if isinstance(loc.get("source"), dict):
        venue = loc["source"].get("display_name") or ""

    doi = (raw.get("doi") or "").replace("https://doi.org/", "")
    url = oa.get("oa_url") or raw.get("doi") or raw.get("id") or ""

    return Source(
        title=(raw.get("title") or "").strip(),
        year=raw.get("publication_year"),
        doi=doi,
        abstract=restore_abstract(raw.get("abstract_inverted_index")),
        url=url,
        authors=[a for a in authors if a],
        venue=venue,
        cited_by=raw.get("cited_by_count") or 0,
        is_oa=bool(oa.get("is_oa")),
        language=raw.get("language") or "",
    )


def deduplicate(sources: Iterable[Source]) -> list[Source]:
    """Убирает повторы по DOI и по нормализованному заголовку.

    Одна статья попадается под разными DOI (два депозита Zenodo),
    поэтому одного DOI мало.
    """
    seen_doi: set[str] = set()
    seen_title: set[str] = set()
    out: list[Source] = []
    for s in sources:
        doi = (s.doi or "").lower()
        title = normalize_title(s.title)
        if doi and doi in seen_doi:
            continue
        if title and title in seen_title:
            continue
        if doi:
            seen_doi.add(doi)
        if title:
            seen_title.add(title)
        out.append(s)
    return out


def build_query_url(query: str, *, since_year: int | None = None,
                    per_page: int = 25, oa_only: bool = True) -> str:
    filters = []
    if oa_only:
        filters.append("is_oa:true")
    if since_year:
        filters.append(f"from_publication_date:{since_year}-01-01")
    params = {
        "search": query,
        "per-page": str(max(1, min(per_page, 50))),
        "sort": "relevance_score:desc",
    }
    if filters:
        params["filter"] = ",".join(filters)
    return f"{API_URL}?{urllib.parse.urlencode(params)}"


def _fetch(url: str, timeout: float) -> dict[str, Any]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def search(query: str, *, since_year: int | None = None,
           per_page: int = 25, oa_only: bool = True,
           timeout: float = DEFAULT_TIMEOUT,
           fetcher=None) -> list[Source]:
    """Ищет публикации. Сетевые ошибки не пробрасываются наверх.

    Поиск источников не должен ронять анализ темы: если OpenAlex
    недоступен, работаем без источников и честно об этом сообщаем.
    """
    url = build_query_url(query, since_year=since_year,
                          per_page=per_page, oa_only=oa_only)
    try:
        data = (fetcher or _fetch)(url, timeout)
    except Exception:
        return []
    works = data.get("results") or []
    return [parse_work(w) for w in works]


# Служебные слова, которые не несут темы.
_STOP = {
    "и", "в", "во", "не", "на", "с", "со", "по", "за", "к", "о", "об",
    "от", "для", "при", "из", "как", "что", "это", "или", "а", "но",
    "the", "of", "and", "in", "on", "for", "to", "a", "is", "are",
}


def _significant_words(text: str) -> set[str]:
    words = re.findall(r"[а-яёa-z]{4,}", (text or "").lower())
    return {w for w in words if w not in _STOP}


def relevance(source: Source, topic: str) -> float:
    """Доля значимых слов темы, встретившихся в заголовке или абстракте.

    Без этого фильтра выдача забивается свежими статьями из того же
    журнала: на запрос про субсидиарную ответственность приходили
    работы про ИИ в госуправлении и закупки — они были 2026 года, и
    свежесть перевешивала всё остальное.
    """
    topic_words = _significant_words(topic)
    if not topic_words:
        return 0.0
    # Совпадение по началу слова: «ответственность» ~ «ответственности».
    haystack = _significant_words(f"{source.title} {source.content}")
    hits = 0
    for tw in topic_words:
        stem = tw[:6]
        if any(hw.startswith(stem) for hw in haystack):
            hits += 1
    return hits / len(topic_words)


def filter_relevant(sources: Iterable[Source], topic: str, *,
                    min_relevance: float = 0.3) -> list[Source]:
    """Отсекает работы, не относящиеся к теме."""
    return [s for s in sources if relevance(s, topic) >= min_relevance]


def rank_sources(sources: Iterable[Source], *,
                 prefer_russian: bool = True,
                 current_year: int | None = None,
                 topic: str = "") -> list[Source]:
    """Сортирует источники по пригодности для анализа темы.

    Приоритеты: есть содержательный абстракт (без него источник
    бесполезен для анализа), свежесть, язык, цитируемость.
    """
    year_now = current_year or date.today().year

    def key(s: Source) -> tuple:
        recency = 0
        if s.year:
            age = max(0, year_now - s.year)
            recency = max(0, 10 - age)          # 10 баллов за этот год
        # Релевантность идёт ПЕРЕД свежестью: свежая статья не по теме
        # бесполезнее старой по теме.
        rel = round(relevance(s, topic), 1) if topic else 0.0
        return (
            s.has_usable_abstract,
            rel,
            prefer_russian and s.is_russian,
            recency,
            min(s.cited_by, 50),
        )

    return sorted(sources, key=key, reverse=True)


def find_sources_for_topic(directions: list[str], *,
                           topic: str = "",
                           limit: int = 6,
                           since_year: int | None = None,
                           per_query: int = 15,
                           min_relevance: float = 0.3,
                           searcher=None) -> list[Source]:
    """Собирает источники по направлениям поиска из анализа темы.

    `directions` — это `search_directions`, которые вернул этап 1;
    `topic` нужен, чтобы отсеять нерелевантное.
    """
    if since_year is None:
        since_year = date.today().year - 5

    collected: list[Source] = []
    run = searcher or search
    queries = list(directions)
    if topic and topic not in queries:
        queries.insert(0, topic)          # сама тема — самый точный запрос
    for d in queries:
        collected.extend(run(d, since_year=since_year, per_page=per_query))

    usable = [s for s in deduplicate(collected) if s.has_usable_abstract]
    if topic:
        relevant = filter_relevant(usable, topic, min_relevance=min_relevance)
        # Если фильтр отсёк всё, лучше вернуть слабое, чем ничего.
        usable = relevant or usable
    return rank_sources(usable, topic=topic)[:limit]
