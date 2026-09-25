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
import logging
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Iterable

API_URL = "https://api.openalex.org/works"

# OpenAlex просит представляться: вежливый пул даёт больше квоты.
CONTACT_EMAIL = os.getenv("OPENALEX_EMAIL", "dev@studservis.ru")
USER_AGENT = f"StudServis/1.0 (mailto:{CONTACT_EMAIL})"

DEFAULT_TIMEOUT = 30.0
MIN_ABSTRACT_CHARS = 150

log = logging.getLogger(__name__)

#: Сколько раз повторить запрос, упёршийся в лимит. Осенью 2026 OpenAlex
#: начал резать анонимный полнотекстовый поиск: два-три запроса подряд
#: проходят, следующий получает 429 с просьбой подождать. Раньше это
#: означало молча пустую выдачу — пользователь видел «источников нет» и
#: думал, что их правда нет.
RETRY_ON_LIMIT = 2

#: Сколько ждать между попытками, если сервер не назвал своё время.
RETRY_PAUSE = 4.0

#: Дольше этого не ждём за один раз: человек смотрит на крутилку, а у
#: нас есть вторая база, которая ответит сразу.
MAX_RETRY_WAIT = 8.0

#: Сколько всего секунд за один подбор источников позволено потратить на
#: ожидание лимитов. Запросов в подборе несколько, и если каждый будет
#: честно отстаивать свою очередь, поиск растянется на минуту.
#:
#: Без ключа не ждём вовсе. С февраля 2026 OpenAlex требует ключ, а
#: анонимам оставил около сотни запросов в сутки на всех — упёршись в
#: этот потолок, ждать бесполезно: он снимается не через секунды, а
#: назавтра. Ключ бесплатный, поэтому лечится это не кодом.
RETRY_BUDGET = 8.0


def _has_api_key() -> bool:
    return bool(os.getenv("OPENALEX_API_KEY", "").strip())


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
    #: Насколько статья отвечает теме. Проставляется при отборе.
    relevance: float = 0.0
    #: Откуда пришла запись: openalex или cyberleninka.
    provider: str = "openalex"
    #: Полный текст статьи, если база его отдаёт (КиберЛенинка).
    fulltext: str = ""
    #: Выходные данные для библиографического описания по ГОСТ. Без них
    #: запись неполна: вуз требует том, номер и страницы.
    pages: str = ""
    volume: str = ""
    issue: str = ""
    issn: str = ""
    publisher: str = ""

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
            "relevance": round(self.relevance, 2),
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


#: Агрегаторы, которые OpenAlex записывает в качестве «журнала». Для
#: библиографической записи это мусор: «КиберЛенинка» — не издание, в
#: котором вышла статья, а сайт, где она выложена.
_NOT_A_JOURNAL = ("cyberlenin", "киберленин", "elibrary", "researchgate",
                  "semantic scholar", "ssrn", "zenodo", "figshare")


def surname_first(name: str) -> str:
    """Переставляет имя в порядок «фамилия, потом имя».

    Базы отдают латинские имена в европейском порядке («Natalia Yu.
    Erpyleva»), а русские — в нашем («Ерпылева Наталия Ю.»). Для
    библиографической записи нужен один порядок, иначе в списке
    литературы появляется «Erpyleva, N. Y. U.» — фамилией становится
    имя, а отчество распадается на две буквы.

    Признак латинского имени — отсутствие кириллицы. Тогда фамилией
    считается последнее слово, кроме случая, когда оно инициал.
    """
    clean = " ".join((name or "").split())
    if not clean or re.search(r"[а-яёА-ЯЁ]", clean):
        return clean

    parts = clean.replace(",", " ").split()
    if len(parts) < 2:
        return clean
    # «Smith, J.» база уже отдала в нужном порядке — не трогаем.
    if parts[-1].endswith(".") or len(parts[-1]) == 1:
        return clean
    return " ".join([parts[-1]] + parts[:-1])


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
    # Агрегатор вместо журнала сделает библиографическую запись
    # неверной: «// CyberLeninka» научрук не примет.
    if any(mark in venue.lower() for mark in _NOT_A_JOURNAL):
        venue = ""

    doi = (raw.get("doi") or "").replace("https://doi.org/", "")
    url = oa.get("oa_url") or raw.get("doi") or raw.get("id") or ""

    return Source(
        title=(raw.get("title") or "").strip(),
        year=raw.get("publication_year"),
        doi=doi,
        abstract=restore_abstract(raw.get("abstract_inverted_index")),
        url=url,
        authors=[surname_first(a) for a in authors if a],
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

    # Представляемся всегда — это «вежливый пул» с большей квотой.
    # Ключ (раздаётся бесплатно на openalex.org/rest-api) снимает лимит
    # совсем; без него работаем, просто с повторами.
    params["mailto"] = CONTACT_EMAIL
    api_key = os.getenv("OPENALEX_API_KEY", "").strip()
    if api_key:
        params["api_key"] = api_key

    return f"{API_URL}?{urllib.parse.urlencode(params)}"


def _fetch(url: str, timeout: float) -> dict[str, Any]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _retry_after(err: urllib.error.HTTPError) -> float:
    """Сколько сервер просит подождать. Своё число он кладёт в тело."""
    try:
        body = json.loads(err.read().decode("utf-8"))
        wait = float(body.get("retryAfter") or 0)
    except Exception:
        wait = 0.0
    if wait <= 0:
        wait = RETRY_PAUSE
    return min(wait, MAX_RETRY_WAIT)


class _Budget:
    """Общий запас ожидания на серию запросов."""

    def __init__(self, seconds: float | None = None) -> None:
        if seconds is None:
            seconds = RETRY_BUDGET if _has_api_key() else 0.0
        self.left = seconds

    def take(self, seconds: float) -> float:
        """Выдаёт паузу, какую может себе позволить. 0 — ждать нельзя."""
        allowed = min(seconds, self.left)
        if allowed <= 0:
            return 0.0
        self.left -= allowed
        return allowed


def _fetch_with_retry(url: str, timeout: float, fetcher=None,
                      budget: _Budget | None = None) -> dict[str, Any]:
    """Запрос с повтором при 429.

    Лимит у OpenAlex временный и снимается через несколько секунд, так
    что одна повторная попытка возвращает большую часть потерянной
    выдачи. Общее время ожидания ограничено бюджетом на весь подбор.
    """
    call = fetcher or _fetch
    # Одиночный запрос тоже считает бюджет: иначе он ждал бы по полному
    # разу на каждую попытку и без ключа — совершенно впустую.
    budget = budget or _Budget()
    for attempt in range(RETRY_ON_LIMIT + 1):
        try:
            return call(url, timeout)
        except urllib.error.HTTPError as err:
            if err.code != 429 or attempt == RETRY_ON_LIMIT:
                raise
            wait = _retry_after(err)
            wait = budget.take(min(wait, MAX_RETRY_WAIT))
            if wait <= 0:
                raise
            log.info("OpenAlex ограничил запросы, ждём %.0f с", wait)
            time.sleep(wait)
    raise RuntimeError("недостижимо")


def search(query: str, *, since_year: int | None = None,
           per_page: int = 25, oa_only: bool = True,
           timeout: float = DEFAULT_TIMEOUT,
           fetcher=None, budget: "_Budget | None" = None) -> list[Source]:
    """Ищет публикации. Сетевые ошибки не пробрасываются наверх.

    Поиск источников не должен ронять анализ темы: если OpenAlex
    недоступен, работаем без источников и честно об этом сообщаем.
    """
    url = build_query_url(query, since_year=since_year,
                          per_page=per_page, oa_only=oa_only)
    try:
        data = _fetch_with_retry(url, timeout, fetcher, budget)
    except Exception as err:
        # Молчать нельзя: пустая выдача выглядит как «по теме ничего не
        # написано», хотя на деле упал провайдер. Однажды это уже стоило
        # нам суток уверенности, что OpenAlex просто не знает русского.
        hint = ""
        if isinstance(err, urllib.error.HTTPError) and err.code == 429 \
                and not _has_api_key():
            hint = (" — задайте OPENALEX_API_KEY, бесплатный ключ "
                    "берётся на openalex.org/settings/api")
        log.warning("OpenAlex не ответил на «%s»: %s: %s%s",
                    query[:60], type(err).__name__, err, hint)
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


#: Слова, которые встречаются едва ли не в каждой научной статье по
#: праву или экономике. Совпадение по ним ничего не говорит о теме:
#: выдуманная тема про дрифт-соревнования набрала 0.33 исключительно
#: на «правовое регулирование» и прошла порог, притащив в анализ
#: коллизионное право и таможенное законодательство.
GENERIC_WORDS = {
    "правовой", "правовые", "правовое", "правового", "правовая",
    "право", "права", "прав", "правом", "регулирование", "регулирования",
    "проблема", "проблемы", "проблем", "вопрос", "вопросы", "вопросов",
    "анализ", "análisis", "аспекты", "аспект", "особенности", "понятие",
    "сущность", "развитие", "система", "системы", "современный",
    "современные", "российской", "российского", "россии", "федерации",
    "государственный", "государственного", "деятельность", "механизм",
    "совершенствование", "значение", "роль", "основы", "основные",
    "порядок", "применение", "реализация", "обеспечение", "институт",
    "законодательство", "законодательства", "нормы", "норм",
    "экономический", "экономические", "управление", "организация",
    "формирование", "оценка", "методы", "условия", "факторы",
    "study", "analysis", "problem", "problems", "legal", "research",
    "development", "system", "modern", "russian", "issues",
}

#: Насколько слабее считается совпадение по общеупотребительному слову.
GENERIC_WEIGHT = 0.2


def _word_weight(word: str) -> float:
    """Вес слова темы: общеюридические слова почти ничего не значат."""
    return GENERIC_WEIGHT if word in GENERIC_WORDS else 1.0


def relevance(source: Source, topic: str) -> float:
    """Взвешенная доля слов темы, встретившихся в статье.

    Простая доля совпавших слов не работает: у темы «правовое
    регулирование дрифт-соревнований» два слова из четырёх — дежурные
    для всей отрасли, и любая юридическая статья набирает по ним
    проходной балл. Поэтому слова из GENERIC_WORDS считаются с малым
    весом, а решают редкие, собственно тематические слова.

    Без этого выдача по узкой теме забивалась случайными статьями,
    а check_grounding не видел проблемы.
    """
    topic_words = _significant_words(topic)
    if not topic_words:
        return 0.0

    total = sum(_word_weight(w) for w in topic_words)
    if total <= 0:
        return 0.0

    # Совпадение по началу слова: «ответственность» ~ «ответственности».
    haystack = _significant_words(f"{source.title} {source.content}")
    hits = 0.0
    for tw in topic_words:
        stem = tw[:6]
        if any(hw.startswith(stem) for hw in haystack):
            hits += _word_weight(tw)
    return hits / total


def specific_hit_ratio(source: Source, topic: str) -> float:
    """Доля именно тематических (не дежурных) слов темы в статье.

    Отдельная метрика для диагностики: показывает, попала ли статья в
    суть темы или только в общеотраслевую лексику.
    """
    words = {w for w in _significant_words(topic) if w not in GENERIC_WORDS}
    if not words:
        return 1.0
    haystack = _significant_words(f"{source.title} {source.content}")
    hits = sum(1 for w in words
               if any(h.startswith(w[:6]) for h in haystack))
    return hits / len(words)


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

    # Бюджет один на весь подбор, а не на каждый запрос.
    budget = _Budget()
    for d in queries:
        kw = {"since_year": since_year, "per_page": per_query}
        if run is search:
            kw["budget"] = budget
        collected.extend(run(d, **kw))

    usable = [s for s in deduplicate(collected) if s.has_usable_abstract]
    if topic:
        relevant = filter_relevant(usable, topic, min_relevance=min_relevance)
        # Если фильтр отсёк всё, лучше вернуть слабое, чем ничего.
        usable = relevant or usable
    return rank_sources(usable, topic=topic)[:limit]
