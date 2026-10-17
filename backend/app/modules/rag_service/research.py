"""Добыча материала для глубокого разбора темы.

Зачем это понадобилось. Прежний разбор темы строился на аннотациях из
баз: восемь карточек по две-три сотни знаков, всего полторы тысячи
знаков материала на весь анализ. Из такого материала нельзя узнать ни
кто с кем спорит, ни какие позиции существуют, ни где в регулировании
дыра. Модель честно писала то единственное, что могла написать на
таком входе, — общие слова, подходящие к любой теме.

При этом полные тексты лежат рядом и даются даром: КиберЛенинка
отдаёт статью целиком за полсекунды, по двадцать-сорок тысяч знаков.
Пятнадцать статей — это триста тысяч знаков настоящего научного
текста вместо полутора тысяч аннотаций, в двести раз больше.

Что делает этот модуль: добывает такой материал и укладывает его в ту
же библиотеку, где лежат методички пользователя. Дальше с ним
работает уже готовый поиск — и при разборе темы, и когда пишутся
разделы. Сами рассуждения по материалу остаются на стороне Node:
рабочая модель с запасными вариантами живёт там.

Важное ограничение: материал исследования живёт отдельно от того, что
принёс пользователь. Своё он загрузил сам и удалять его без спроса
нельзя, а добытое — черновой материал, который перед новым поиском
вычищается целиком.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.sources import cyberleninka, registry
from app.modules.sources.openalex import Source

from .library import (
    MAX_DOCS_PER_OWNER,
    UserDocument,
    add_document,
    remove_document,
)

logger = logging.getLogger(__name__)

#: Вид документа для добытого автоматически. Отдельный вид нужен, чтобы
#: отличать находки от того, что принёс пользователь: своё не трогаем,
#: найденное вычищаем перед каждым новым поиском.
KIND_RESEARCH = "найдено"

#: Сколько статей читаем целиком. Пятнадцать — это около трёхсот тысяч
#: знаков научного текста и примерно десять секунд на скачивание.
#: Больше упирается не во время, а в то, что дальше этот материал
#: придётся просеивать поиском, а хвост выдачи по релевантности уже
#: мусорный.
DEFAULT_READ_LIMIT = 15

#: Нижняя граница полезного текста. Короче — это либо аннотация, либо
#: страница с ошибкой: читать там нечего, а место в библиотеке займёт.
MIN_USEFUL_CHARS = 2000

#: Потолок на один документ. Отдельные статьи КиберЛенинки доходят до
#: ста тысяч знаков; целиком они вытеснят из библиотеки всё остальное.
MAX_DOC_CHARS = 60000

#: Сколько своих документов гарантированно остаётся пользователю.
#: Библиотека ограничена пятьюдесятью документами, и находки не должны
#: занять её целиком: методички важнее.
RESERVED_FOR_USER = 20


@dataclass
class ReadArticle:
    """Прочитанная статья: что это и сколько из неё удалось взять."""

    title: str
    url: str
    authors: str = ""
    year: str = ""
    journal: str = ""
    chars: int = 0
    chunks: int = 0
    doc_id: str = ""


@dataclass
class HarvestResult:
    """Итог одного круга добычи."""

    queries: list[str] = field(default_factory=list)
    found: int = 0
    read: list[ReadArticle] = field(default_factory=list)
    skipped: int = 0
    total_chars: int = 0

    @property
    def read_count(self) -> int:
        return len(self.read)


#: Служебная шапка статьи: индекс УДК, рубрикатор, DOI, ORCID, почта
#: авторов, сведения о рецензировании. Для поиска по смыслу это мусор,
#: который к тому же отлично находится: «5.1.1. Теоретико-исторические
#: правовые науки» состоит ровно из тех слов, которые ищет студент.
RE_SERVICE_LINE = re.compile(
    r"(?mi)^\s*(?:"
    r"УДК\b|ББК\b|DOI\s*:|ORCID|https?://orcid|©|"
    # Рубрикатор ВАК: «5.1.1. Теоретико-исторические правовые науки».
    r"\d+\.\d+\.\d+\.?\s+[А-ЯЁA-Z]|"
    r"Научная статья\b|Обзорная статья\b|Оригинальная статья\b|"
    r"\d+\s*\[email|\[email|"
    r"Дата поступления|Поступила в редакцию|Received\s*:|Revised\s*:|"
    r"Accepted\s*:|For citation|Для цитирования"
    r").*$"
)

#: Заголовок, с которого начинается список литературы. Всё после него
#: из текста для размышления убирается: фамилии и названия чужих работ
#: забивают поиск, а смысла в них для разбора нет.
#:
#: Сам список при этом ценен — из него берутся источники для работы, —
#: но это отдельная задача, и решать её вперемешку с поиском по смыслу
#: нельзя.
RE_BIBLIOGRAPHY = re.compile(
    r"(?mi)^\s*(?:список\s+(?:литературы|источников|использованн\w+\s+"
    r"(?:литературы|источников))|библиографическ\w+\s+список|references)\b"
)

#: Английские служебные блоки в конце русской статьи.
RE_TAIL_BLOCK = re.compile(
    r"(?mi)^\s*(?:CONFLICT OF INTEREST|CONTRIBUTION OF THE AUTHORS|"
    r"КОНФЛИКТ ИНТЕРЕСОВ|ВКЛАД АВТОРОВ|Information about the authors?|"
    r"Сведения об авторах?)\b"
)


def clean_article_text(raw: str) -> str:
    """Убрать из статьи то, по чему нельзя рассуждать.

    Научная статья с сайта приходит вместе с обёрткой: индексом УДК,
    рубрикатором, почтой авторов, сведениями о рецензировании и
    списком литературы на девятую часть объёма.

    Всё это не просто бесполезно — оно активно вредит. Служебные
    строки состоят из тех же слов, что и запрос («правовые науки»,
    «теоретико-исторические»), поэтому исправно всплывают в выдаче
    поиска вместо содержательных кусков. А в списке литературы на
    каждый вопрос найдётся десяток похожих названий.
    """
    if not raw:
        return ""

    text = raw

    # Список литературы и английские хвосты — отрезаем всё, что после.
    for pattern in (RE_BIBLIOGRAPHY, RE_TAIL_BLOCK):
        m = pattern.search(text)
        # Проверка на четверть длины: если «References» встретилось в
        # первой четверти статьи, это не хвост, а упоминание внутри
        # текста, и резать по нему нельзя.
        if m and m.start() > len(text) // 4:
            text = text[:m.start()]

    text = RE_SERVICE_LINE.sub("", text)
    # DOI и почта попадаются и в середине строки, вместе с полезным
    # текстом: вырезаем их отдельно, не трогая саму строку.
    text = re.sub(r"DOI\s*:\s*\S+", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\[email[^\]]*\]", "", text)

    # После вычистки строк остаются дыры из пустых строк подряд.
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def citation_label(source: Source) -> str:
    """Короткая подпись источника — она же имя документа в библиотеке.

    Подпись нужна не для красоты. Когда по этому материалу будут
    писаться разделы, модель увидит именно её и по ней сошлётся.
    Поэтому в подписи обязаны быть автор и год: «статья из интернета»
    в список литературы не поставишь.
    """
    parts: list[str] = []

    authors = getattr(source, "authors", None) or []
    if isinstance(authors, str):
        authors = [authors]
    if authors:
        head = str(authors[0]).strip()
        if head:
            parts.append(head if len(authors) == 1 else f"{head} и др.")

    title = (getattr(source, "title", "") or "").strip()
    if title:
        parts.append(title if len(title) <= 120 else title[:117] + "…")

    tail: list[str] = []
    # Журнал в модели источника называется venue.
    journal = (getattr(source, "venue", "") or "").strip()
    if journal:
        tail.append(journal if len(journal) <= 60 else journal[:57] + "…")
    year = getattr(source, "year", None)
    if year:
        tail.append(str(year))
    if tail:
        parts.append("(" + ", ".join(tail) + ")")

    label = ". ".join(p for p in parts if p) or "Источник без названия"
    # Имя документа ограничено тремястами знаками на уровне таблицы.
    return label[:290]


def _dedupe(sources: list[Source]) -> list[Source]:
    """Убрать повторы: один круг добычи делает несколько запросов.

    Запросы намеренно пересекаются — так находится больше, — и одна и
    та же статья приходит по двум-трём из них. Сравниваем по адресу, а
    при его отсутствии по названию: в разных базах у одной статьи
    бывают разные адреса, но название совпадает.
    """
    seen_url: set[str] = set()
    seen_title: set[str] = set()
    out: list[Source] = []

    for s in sources:
        url = (getattr(s, "url", "") or "").strip().rstrip("/")
        title = (getattr(s, "title", "") or "").strip().casefold()
        if url and url in seen_url:
            continue
        if title and title in seen_title:
            continue
        if url:
            seen_url.add(url)
        if title:
            seen_title.add(title)
        out.append(s)

    return out


def _readable(source: Source) -> bool:
    """Можно ли вообще получить полный текст.

    Целиком статью отдаёт только КиберЛенинка. У Crossref и OpenAlex
    есть метаданные и в лучшем случае аннотация, у DOAJ — ссылка на
    журнал. Тратить время на попытку скачать их страницу бессмысленно.
    """
    url = (getattr(source, "url", "") or "")
    return "cyberleninka.ru" in url


async def clear_previous(session: AsyncSession, *, owner_key: str) -> int:
    """Убрать находки прошлого круга.

    Без этого библиотека за три запуска забивается статьями по трём
    разным темам, и поиск по ней начинает отвечать не из той области.
    Удаляется только добытое автоматически: загруженное пользователем
    неприкосновенно.
    """
    rows = await session.scalars(
        select(UserDocument).where(
            UserDocument.owner_key == owner_key,
            UserDocument.kind == KIND_RESEARCH,
        )
    )
    doc_ids = [d.id for d in rows]
    for doc_id in doc_ids:
        await remove_document(session, owner_key=owner_key, doc_id=doc_id)
    return len(doc_ids)


async def _count_user_docs(session: AsyncSession, *, owner_key: str) -> int:
    rows = await session.scalars(
        select(UserDocument).where(
            UserDocument.owner_key == owner_key,
            UserDocument.kind != KIND_RESEARCH,
        )
    )
    return len(list(rows))


async def search_many(
    queries: list[str],
    *,
    topic: str,
    per_query: int = 6,
) -> list[Source]:
    """Обойти базы сразу по нескольким запросам.

    Запросы идут параллельно: каждый сам по себе ходит в четыре базы,
    и последовательно десяток запросов занял бы минуты вместо секунд.
    Отказ отдельного запроса не роняет круг — пустой список и дальше.
    """
    async def one(q: str) -> list[Source]:
        try:
            return await registry.find_sources(
                q, [q], limit=per_query, with_fulltext=False,
                with_bibliography=False,
            )
        except Exception as exc:  # noqa: BLE001 — один запрос не критичен
            logger.warning("Запрос «%s» не дал результата: %s", q, exc)
            return []

    groups = await asyncio.gather(*(one(q) for q in queries))
    merged: list[Source] = []
    for g in groups:
        merged.extend(g)

    deduped = _dedupe(merged)
    try:
        return registry.rank(deduped, topic)
    except Exception:  # noqa: BLE001 — ранжирование необязательно
        return deduped


async def read_fulltexts(
    sources: list[Source],
    *,
    limit: int = DEFAULT_READ_LIMIT,
) -> list[tuple[Source, str]]:
    """Скачать полные тексты — параллельно, иначе это минуты.

    Скачивание синхронное и сетевое, поэтому уходит в поток. Отказ
    отдельной статьи ожидаем и не должен ронять круг: у части записей
    битый адрес или страница без текста.
    """
    candidates = [s for s in sources if _readable(s)][:limit]

    async def one(s: Source) -> tuple[Source, str]:
        try:
            text = await asyncio.to_thread(cyberleninka.fetch_fulltext, s)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Не удалось прочитать %s: %s",
                           getattr(s, "url", "?"), exc)
            return s, ""
        return s, text or ""

    return list(await asyncio.gather(*(one(s) for s in candidates)))


async def harvest(
    session: AsyncSession,
    *,
    owner_key: str,
    queries: list[str],
    topic: str = "",
    read_limit: int = DEFAULT_READ_LIMIT,
    clear_before: bool = True,
    user_id: str | None = None,
) -> HarvestResult:
    """Найти статьи, прочитать целиком и сложить в библиотеку.

    Возвращает отчёт о том, что прочитано: он нужен и для показа
    пользователю, и для того, чтобы решить, нужен ли второй круг по
    недобранным вопросам.
    """
    queries = [q.strip() for q in queries if q and q.strip()]
    if not queries:
        return HarvestResult()

    if clear_before:
        await clear_previous(session, owner_key=owner_key)

    found = await search_many(queries, topic=topic or queries[0])
    pairs = await read_fulltexts(found, limit=read_limit)

    # Сколько находок вообще поместится: библиотека ограничена, и место
    # пользователя под его методички трогать нельзя.
    own = await _count_user_docs(session, owner_key=owner_key)
    room = max(0, MAX_DOCS_PER_OWNER - max(own, RESERVED_FOR_USER))

    result = HarvestResult(queries=queries, found=len(found))

    for source, text in pairs:
        if len(result.read) >= room:
            break
        text = clean_article_text(text)
        if len(text) < MIN_USEFUL_CHARS:
            result.skipped += 1
            continue

        label = citation_label(source)
        try:
            stored = await add_document(
                session,
                owner_key=owner_key,
                filename=label,
                text=text[:MAX_DOC_CHARS],
                kind=KIND_RESEARCH,
                user_id=user_id,
            )
        except Exception as exc:  # noqa: BLE001 — одна статья не критична
            logger.warning("Не удалось сохранить «%s»: %s", label, exc)
            result.skipped += 1
            continue

        authors = getattr(source, "authors", None) or []
        if isinstance(authors, str):
            authors = [authors]

        result.read.append(ReadArticle(
            title=(getattr(source, "title", "") or "").strip(),
            url=getattr(source, "url", "") or "",
            authors=", ".join(str(a) for a in authors[:3]),
            year=str(getattr(source, "year", "") or ""),
            journal=getattr(source, "venue", "") or "",
            chars=stored.chars,
            chunks=stored.chunks,
            doc_id=stored.id,
        ))
        result.total_chars += stored.chars

    return result
