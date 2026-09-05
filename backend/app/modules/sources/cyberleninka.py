"""Поиск научных статей в КиберЛенинке.

Дополняет OpenAlex там, где тот слаб: КиберЛенинка целиком русскоязычная
и отдаёт полные тексты статей, а не только абстракты. Взамен у неё нет
ни DOI, ни фильтра по годам, ни счётчика цитирований — поэтому источники
из двух баз объединяются, а не заменяют друг друга.

API недокументированный: POST /api/search, тот же эндпоинт, которым
пользуется поиск на сайте. Ключа не требует. Раз он не обещан публике,
любая сетевая ошибка гасится и поиск возвращает пустой список — модуль
не должен ронять анализ темы, если КиберЛенинка сменит разметку.
"""

from __future__ import annotations

import asyncio
import html
import json
import re
import urllib.error
import urllib.request
from typing import Callable, Iterable

from app.modules.sources.openalex import Source, normalize_title, relevance

SEARCH_URL = "https://cyberleninka.ru/api/search"
BASE_URL = "https://cyberleninka.ru"

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

TIMEOUT = 30.0

#: Сколько статей просить у поиска за один запрос.
PAGE_SIZE = 25

#: Полный текст статьи обрезается: в промпт всё равно уйдёт фрагмент,
#: а держать в памяти сотню килобайт OCR-мусора незачем.
MAX_FULLTEXT_CHARS = 40_000

#: Короче этого — не текст статьи, а обрывок вёрстки.
MIN_FULLTEXT_CHARS = 500


def strip_tags(raw: str) -> str:
    """Убрать HTML-разметку и восстановить пробелы.

    Поиск подсвечивает совпадения тегами <b>, а тело статьи размечено
    абзацами. И то и другое в тексте для модели лишнее.
    """
    if not raw:
        return ""
    text = re.sub(r"<br\s*/?>", "\n", raw, flags=re.I)
    text = re.sub(r"</p\s*>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = text.replace("\ufeff", "").replace("\xa0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _post(url: str, payload: dict) -> str:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return response.read().decode("utf-8", "replace")


def _get(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return response.read().decode("utf-8", "replace")


def parse_article(raw: dict) -> Source | None:
    """Собрать Source из записи поисковой выдачи.

    У КиберЛенинки нет DOI, поэтому идентификатором служит ссылка на
    статью — она стабильна и уникальна.
    """
    title = strip_tags(raw.get("name") or "")
    link = (raw.get("link") or "").strip()
    if not title or not link:
        return None

    year = raw.get("year")
    if isinstance(year, str) and year.isdigit():
        year = int(year)
    if not isinstance(year, int):
        year = None

    # ocr в выдаче — это куски статьи вокруг совпадений. Как абстракт
    # они хуже annotation, но если аннотации нет, лучше их, чем ничего.
    abstract = strip_tags(raw.get("annotation") or "")
    if not abstract:
        chunks = raw.get("ocr")
        if isinstance(chunks, list):
            abstract = strip_tags(" ".join(str(c) for c in chunks))

    authors = [
        strip_tags(a) for a in (raw.get("authors") or []) if isinstance(a, str)
    ]

    return Source(
        title=title,
        abstract=abstract,
        year=year,
        authors=[a for a in authors if a],
        doi=None,
        url=BASE_URL + link if link.startswith("/") else link,
        venue=strip_tags(raw.get("journal") or "") or None,
        cited_by=0,
        is_oa=True,
        provider="cyberleninka",
    )


def _slice_balanced_div(page_html: str, start: int) -> str:
    """Вырезать содержимое div, начинающегося в позиции start.

    Регулярка тут не работает: внутри тела статьи есть вложенные div
    (рекламные врезки), и нежадный поиск закрывающего тега обрывает
    текст на первой же из них. Считаем вложенность.
    """
    open_tag = page_html.find(">", start)
    if open_tag == -1:
        return ""
    depth = 1
    pos = open_tag + 1
    body_start = pos
    for match in re.finditer(r"<(/?)div\b", page_html[pos:], re.I):
        depth += -1 if match.group(1) else 1
        if depth == 0:
            return page_html[body_start:pos + match.start()]
    return page_html[body_start:]


def extract_fulltext(page_html: str) -> str:
    """Вытащить тело статьи со страницы КиберЛенинки.

    Текст лежит в <div class="ocr" itemprop="articleBody">. Внутри
    попадаются рекламные врезки — они вырезаются вместе с тегами.
    """
    match = re.search(r'<div[^>]*class="ocr"[^>]*>', page_html, re.I)
    if not match:
        match = re.search(r'<div[^>]*itemprop="articleBody"[^>]*>',
                          page_html, re.I)
    if not match:
        return ""
    body = _slice_balanced_div(page_html, match.start())
    body = re.sub(r"<div[^>]*class=\"ocr-banner\".*?</div>", " ", body,
                  flags=re.S | re.I)
    body = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", body,
                  flags=re.S | re.I)
    return strip_tags(body)[:MAX_FULLTEXT_CHARS]


def search(
    query: str,
    limit: int = PAGE_SIZE,
    *,
    fetcher: Callable[[str, dict], str] | None = None,
) -> list[Source]:
    """Найти статьи по запросу. При любой ошибке — пустой список."""
    post = fetcher or _post
    payload = {
        "mode": "articles",
        "q": query,
        "size": max(1, min(limit, 100)),
        "from": 0,
    }
    try:
        raw = post(SEARCH_URL, payload)
        data = json.loads(raw)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
            OSError, json.JSONDecodeError, ValueError):
        return []

    articles = data.get("articles")
    if not isinstance(articles, list):
        return []

    found: list[Source] = []
    for item in articles:
        if not isinstance(item, dict):
            continue
        source = parse_article(item)
        if source is not None:
            found.append(source)
    return found


def fetch_fulltext(
    source: Source,
    *,
    fetcher: Callable[[str], str] | None = None,
) -> str:
    """Загрузить полный текст статьи. При ошибке — пустая строка."""
    if not source.url:
        return ""
    get = fetcher or _get
    try:
        page = get(source.url)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
            OSError):
        return ""
    text = extract_fulltext(page)
    return text if len(text) >= MIN_FULLTEXT_CHARS else ""


async def enrich_with_fulltext(
    sources: Iterable[Source],
    *,
    limit: int = 3,
    fetcher: Callable[[str], str] | None = None,
) -> list[Source]:
    """Догрузить полные тексты для первых нескольких статей.

    Только для КиберЛенинки и только для верхушки списка: каждая
    статья — отдельный HTTP-запрос, а в промпт всё равно поместится
    ограниченный объём. Загрузки идут параллельно.
    """
    items = list(sources)
    targets = [
        s for s in items
        if s.provider == "cyberleninka" and not s.fulltext
    ][:limit]
    if not targets:
        return items

    async def load(source: Source) -> None:
        text = await asyncio.to_thread(fetch_fulltext, source, fetcher=fetcher)
        if text:
            source.fulltext = text

    await asyncio.gather(*(load(s) for s in targets))
    return items


def search_many(
    queries: Iterable[str],
    *,
    limit_per_query: int = PAGE_SIZE,
    fetcher: Callable[[str, dict], str] | None = None,
) -> list[Source]:
    """Выполнить несколько запросов и слить результаты без дублей."""
    seen: set[str] = set()
    merged: list[Source] = []
    for query in queries:
        for source in search(query, limit_per_query, fetcher=fetcher):
            key = normalize_title(source.title)
            if not key or key in seen:
                continue
            seen.add(key)
            merged.append(source)
    return merged


def filter_by_year(sources: Iterable[Source], min_year: int) -> list[Source]:
    """Отсечь старые статьи.

    Поисковый API не умеет фильтровать по дате, приходится делать это
    на своей стороне. Статьи без года сохраняются: год у КиберЛенинки
    иногда отсутствует, а выбрасывать статью за это слишком строго.
    """
    return [s for s in sources
            if s.year is None or s.year >= min_year]


def find_sources(
    topic: str,
    directions: Iterable[str],
    *,
    min_year: int | None = None,
    min_relevance: float = 0.3,
    limit: int = 10,
    fetcher: Callable[[str, dict], str] | None = None,
) -> list[Source]:
    """Подобрать статьи по теме и направлениям поиска.

    Тема идёт первым запросом: она точнее всего описывает, что нужно.
    """
    queries = [topic] + [d for d in directions if d and d.strip()]
    found = search_many(queries, fetcher=fetcher)

    if min_year is not None:
        found = filter_by_year(found, min_year)

    scored = [(relevance(s, topic), s) for s in found]
    relevant = [(r, s) for r, s in scored if r >= min_relevance]
    # Как и в OpenAlex: пустая выдача хуже слабых совпадений.
    pool = relevant or scored
    pool.sort(key=lambda pair: (pair[0], pair[1].year or 0), reverse=True)
    return [s for _, s in pool[:limit]]
