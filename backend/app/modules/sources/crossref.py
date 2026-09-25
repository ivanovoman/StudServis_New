"""Crossref — библиографическая база по DOI.

## Зачем она нам

Crossref регистрирует DOI, а значит знает почти всё, что вышло в
журналах с нормальной редакцией, — включая российские, в том числе
ваковские. По запросу «коллизии в праве» она находит полторы тысячи
русских статей: «Вестник МГПУ. Серия Юридические науки», «Law. Journal
of the Higher School of Economics», сборники конференций.

Чем она дополняет то, что уже есть:

* КиберЛенинка знает только то, что выложено у неё, и не даёт DOI;
* OpenAlex силён англоязычной наукой, а русскую отдаёт выборочно;
* Crossref даёт **точную библиографию** — авторы, журнал, том, год, DOI.
  Именно из этого собирается список литературы по ГОСТ, и именно этого
  модель не знает: реквизиты она придумывает.

## Чего Crossref не умеет

Полных текстов здесь нет и не будет — база про метаданные. Абстракт
есть примерно у половины записей, и приходит он в разметке JATS
(`<jats:p>`), которую нужно счищать.

Открытость доступа Crossref знает плохо: поле `license` есть далеко не
у всех. Поэтому `is_oa` мы выставляем осторожно — только когда лицензия
действительно открытая. Врать пользователю, что статья доступна
бесплатно, нельзя: он пойдёт по ссылке и упрётся в платную стену.

## Про вежливость

Crossref просит указывать почту (`mailto`) и за это пускает в «вежливый
пул», который работает стабильнее анонимного. Ключей и регистрации не
требуется — это единственная крупная база, куда мы ходим совсем без
учётных данных.
"""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

from app.modules.sources.openalex import Source

API_URL = "https://api.crossref.org/works"

CONTACT_EMAIL = os.getenv("CROSSREF_EMAIL", "dev@studservis.ru")
USER_AGENT = f"StudServis/1.0 (mailto:{CONTACT_EMAIL})"

DEFAULT_TIMEOUT = 25.0

#: Абстракт короче этого бесполезен: по нему нельзя понять, о чём
#: статья, и в промпт его класть незачем.
MIN_ABSTRACT_CHARS = 150

#: Типы записей, которые нам подходят. Всё остальное — редакционные
#: заметки, рецензии, отчёты о наборах данных — в курсовой не цитируют.
USEFUL_TYPES = ("journal-article", "proceedings-article", "book-chapter")

#: Лицензии, по которым текст точно можно читать бесплатно.
OPEN_LICENSE_MARKS = ("creativecommons.org", "/licenses/by", "open-access")

log = logging.getLogger(__name__)


def strip_jats(text: str | None) -> str:
    """Убирает JATS-разметку из абстракта.

    Crossref отдаёт абстракт как кусок XML: `<jats:p>Текст</jats:p>`,
    иногда с заголовком `<jats:title>Аннотация</jats:title>`. В промпт
    это класть нельзя — модель начинает копировать теги в текст работы.
    """
    if not text:
        return ""
    # Заголовки внутри абстракта («Аннотация», «Abstract») только мешают.
    text = re.sub(r"<jats:title>.*?</jats:title>", " ", text,
                  flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = (text.replace("&amp;", "&").replace("&lt;", "<")
                .replace("&gt;", ">").replace("&quot;", '"')
                .replace("&#x2018;", "'").replace("&#x2019;", "'"))
    return re.sub(r"\s+", " ", text).strip()


def _author_name(raw: dict) -> str:
    """Собирает имя автора из частей, как их хранит Crossref."""
    family = (raw.get("family") or "").strip()
    given = (raw.get("given") or "").strip()
    if family and given:
        return f"{family} {given}"
    return family or given or (raw.get("name") or "").strip()


def _year(raw: dict) -> int | None:
    for field in ("issued", "published-print", "published-online",
                  "published"):
        parts = (raw.get(field) or {}).get("date-parts") or []
        if parts and parts[0] and parts[0][0]:
            try:
                return int(parts[0][0])
            except (TypeError, ValueError):
                continue
    return None


def _is_open(raw: dict) -> bool:
    """Осторожная проверка открытости.

    Считаем открытым только то, у чего лицензия явно свободная. Ошибка
    в эту сторону безобидна (пользователь просто увидит меньше пометок
    «открытый доступ»), а в обратную — злит: человек идёт по ссылке и
    видит просьбу заплатить.
    """
    for lic in raw.get("license") or []:
        url = str(lic.get("URL") or "").lower()
        if any(mark in url for mark in OPEN_LICENSE_MARKS):
            return True
    return False


def parse_work(raw: dict) -> Source:
    """Превращает запись Crossref в наш Source."""
    titles = raw.get("title") or []
    # В заголовках Crossref живут переносы строк с вёрстки журнала —
    # в оглавлении работы такой заголовок разваливается пополам.
    title = re.sub(r"\s+", " ", str(titles[0])).strip() if titles else ""

    doi = (raw.get("DOI") or "").strip()
    venues = raw.get("container-title") or []

    return Source(
        title=title,
        authors=[_author_name(a) for a in (raw.get("author") or [])
                 if _author_name(a)],
        year=_year(raw),
        venue=re.sub(r"\s+", " ", str(venues[0])).strip() if venues else "",
        doi=doi,
        url=(raw.get("URL") or (f"https://doi.org/{doi}" if doi else "")),
        abstract=strip_jats(raw.get("abstract")),
        is_oa=_is_open(raw),
        cited_by=int(raw.get("is-referenced-by-count") or 0),
        provider="crossref",
    )


def build_query_url(query: str, *, since_year: int | None = None,
                    rows: int = 20) -> str:
    filters = [f"type:{USEFUL_TYPES[0]}"]
    if since_year:
        filters.append(f"from-pub-date:{since_year}-01-01")

    params = {
        "query": query,
        "rows": str(max(1, min(rows, 100))),
        "filter": ",".join(filters),
        "mailto": CONTACT_EMAIL,
        "select": ("title,author,issued,container-title,DOI,URL,abstract,"
                   "is-referenced-by-count,license,type"),
    }
    return f"{API_URL}?{urllib.parse.urlencode(params)}"


def _fetch(url: str, timeout: float) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def search(query: str, *, since_year: int | None = None,
           rows: int = 20, timeout: float = DEFAULT_TIMEOUT,
           fetcher=None) -> list[Source]:
    """Ищет публикации в Crossref.

    Сетевые ошибки не пробрасываются: отказ одной базы не должен
    ронять подбор источников. Но и молчать о нём нельзя — пустая
    выдача выглядит как «по теме ничего не написано».
    """
    url = build_query_url(query, since_year=since_year, rows=rows)
    try:
        data = (fetcher or _fetch)(url, timeout)
    except Exception as err:
        log.warning("Crossref не ответил на «%s»: %s: %s",
                    query[:60], type(err).__name__, err)
        return []

    items = (data.get("message") or {}).get("items") or []
    return [parse_work(it) for it in items if it.get("title")]


def find_sources(query: str, directions: list[str] | None = None, *,
                 min_year: int | None = None,
                 limit: int = 20,
                 searcher=None) -> list[Source]:
    """Ищет по теме и направлениям сразу, как это делают другие базы.

    Направления дают разные формулировки одного и того же вопроса —
    выдача получается шире, чем по одному запросу.
    """
    if min_year is None:
        min_year = date.today().year - 5

    run = searcher or search
    queries = [query] + [d for d in (directions or []) if d != query]

    collected: list[Source] = []
    for q in queries:
        collected.extend(run(q, since_year=min_year, rows=limit))
        if len(collected) >= limit * 2:
            break
    return collected
