"""DOAJ — каталог журналов открытого доступа.

## Зачем она нам

DOAJ (Directory of Open Access Journals) — это реестр журналов, которые
проверены на добросовестность редакционной работы и выкладывают статьи
бесплатно. Для нас важны две вещи.

Первая: здесь **гарантированно открытый доступ**. Если статья нашлась в
DOAJ, студент откроет её по ссылке и прочитает целиком — не упрётся в
платную стену, как это бывает с Crossref. Работа, построенная на
источниках, которых научный руководитель не может открыть, вызывает
закономерные вопросы.

Вторая: здесь **длинные абстракты**, по две-три тысячи знаков. Это
почти пересказ статьи, и для наполнения промпта фактурой он ценнее
короткой аннотации OpenAlex.

## Чего ждать по русским темам

Немного. По запросу «право коллизии» DOAJ находит единицы записей
против сотен у КиберЛенинки. Российских журналов в каталоге мало, и
держать DOAJ единственным поставщиком нельзя. Но те несколько статей,
что он даёт, — из приличных изданий вроде «Московского журнала
международного права», и в списке литературы смотрятся уместно.

## Технические особенности

Запрос уходит прямо в путь URL, а не в параметр: `/search/articles/
<запрос>`. Русский текст приходится кодировать, причём кодировать
целиком — DOAJ не любит незакодированные пробелы.

Ключ не нужен. Лимит — примерно два запроса в секунду, нам этого хватает
с большим запасом.
"""

from __future__ import annotations

import json
import logging
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

from app.modules.sources.openalex import Source

API_URL = "https://doaj.org/api/search/articles"

USER_AGENT = "StudServis/1.0 (mailto:dev@studservis.ru)"

DEFAULT_TIMEOUT = 25.0

#: DOAJ отдаёт максимум сто записей за раз.
MAX_PAGE_SIZE = 100

log = logging.getLogger(__name__)


def _clean(text: str | None) -> str:
    """Чистит абстракт от случайной разметки и лишних пробелов."""
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", text)
    # В именах и текстах DOAJ попадаются тонкие пробелы (U+2009) —
    # в DOCX они превращаются в странные разрывы.
    text = text.replace("\u2009", " ").replace("\u00a0", " ")
    return re.sub(r"\s+", " ", text).strip()


def _year(bibjson: dict) -> int | None:
    raw = bibjson.get("year")
    try:
        year = int(str(raw)[:4])
    except (TypeError, ValueError):
        return None
    # Заведомая чушь вроде года 12 или 3025 в базе встречается.
    return year if 1900 <= year <= date.today().year + 1 else None


def _doi(bibjson: dict) -> str:
    for ident in bibjson.get("identifier") or []:
        if str(ident.get("type", "")).lower() == "doi":
            return str(ident.get("id") or "").strip()
    return ""


def _url(bibjson: dict, doi: str) -> str:
    for link in bibjson.get("link") or []:
        url = str(link.get("url") or "").strip()
        if url:
            return url
    return f"https://doi.org/{doi}" if doi else ""


def parse_article(raw: dict) -> Source:
    """Превращает запись DOAJ в наш Source."""
    bib = raw.get("bibjson") or {}
    doi = _doi(bib)
    journal = bib.get("journal") or {}
    languages = [str(x).lower() for x in (journal.get("language") or [])]

    return Source(
        title=_clean(bib.get("title")),
        authors=[_clean(a.get("name")) for a in bib.get("author") or []
                 if a.get("name")],
        year=_year(bib),
        venue=_clean(journal.get("title")),
        doi=doi,
        url=_url(bib, doi),
        abstract=_clean(bib.get("abstract")),
        # Весь DOAJ по определению открытый — ради этого он и существует.
        is_oa=True,
        language="ru" if "ru" in languages else (
            languages[0] if languages else ""),
        provider="doaj",
    )


def build_query_url(query: str, *, page_size: int = 20) -> str:
    # Запрос идёт частью пути, поэтому кодируем его целиком, включая
    # слэши и пробелы: иначе DOAJ отвечает 404 на невинный текст.
    path = urllib.parse.quote(query, safe="")
    params = {"pageSize": str(max(1, min(page_size, MAX_PAGE_SIZE)))}
    return f"{API_URL}/{path}?{urllib.parse.urlencode(params)}"


def _fetch(url: str, timeout: float) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def search(query: str, *, page_size: int = 20,
           min_year: int | None = None,
           timeout: float = DEFAULT_TIMEOUT,
           fetcher=None) -> list[Source]:
    """Ищет статьи открытого доступа.

    Отказ базы не пробрасывается наверх, но пишется в лог: молчаливый
    ноль неотличим от честного «ничего не нашлось».
    """
    url = build_query_url(query, page_size=page_size)
    try:
        data = (fetcher or _fetch)(url, timeout)
    except Exception as err:
        log.warning("DOAJ не ответил на «%s»: %s: %s",
                    query[:60], type(err).__name__, err)
        return []

    found = [parse_article(r) for r in data.get("results") or []]
    found = [s for s in found if s.title]
    if min_year:
        found = [s for s in found if s.year is None or s.year >= min_year]
    return found


def find_sources(query: str, directions: list[str] | None = None, *,
                 min_year: int | None = None,
                 limit: int = 20,
                 searcher=None) -> list[Source]:
    """Ищет по теме и направлениям — единый вид для реестра баз."""
    if min_year is None:
        min_year = date.today().year - 5

    run = searcher or search
    queries = [query] + [d for d in (directions or []) if d != query]

    collected: list[Source] = []
    for q in queries:
        collected.extend(run(q, page_size=limit, min_year=min_year))
        if len(collected) >= limit * 2:
            break
    return collected
