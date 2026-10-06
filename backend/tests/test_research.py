"""Проверки добычи материала для глубокого разбора.

Главное, что здесь проверяется: из статьи убирается то, по чему
нельзя рассуждать. Служебная шапка и список литературы не просто
бесполезны — они состоят ровно из тех слов, которые ищет студент, и
исправно всплывают в выдаче вместо содержательных кусков.
"""

from __future__ import annotations

import pytest
import pytest_asyncio

from app.db import get_session_factory, init_models
from app.modules.rag_service import research
from app.modules.sources.openalex import Source


@pytest_asyncio.fixture
async def session():
    await init_models()
    factory = get_session_factory()
    async with factory() as s:
        yield s


# ----------------------------------------------------------- очистка текста

def test_удк_и_рубрикатор_вырезаны():
    raw = (
        "Научная статья С. 17-21\n\n"
        "УДК 340.113\n\n"
        "5.1.1. Теоретико-исторические правовые науки\n\n"
        "НОРМАТИВНЫЕ КОЛЛИЗИИ КАК КОРРУПЦИОГЕННЫЙ ФАКТОР\n\n"
        "В статье исследуется природа нормативных коллизий и их связь "
        "с коррупциогенными факторами при проведении экспертизы."
    )
    out = research.clean_article_text(raw)

    assert "УДК" not in out
    assert "Теоретико-исторические правовые науки" not in out
    assert "Научная статья" not in out
    # Содержание осталось нетронутым.
    assert "природа нормативных коллизий" in out


def test_doi_вырезан_даже_в_середине_строки():
    raw = ("Публично-правовые науки DOI: 10.47475/2311-696X-2025\n\n"
           + "Коллизия возникает там, где две нормы дают разный ответ. " * 8)
    out = research.clean_article_text(raw)

    assert "10.47475" not in out
    assert "Коллизия возникает" in out


def test_список_литературы_отрезан():
    body = "Коллизия есть противоречие между нормами одной силы. " * 40
    raw = body + "\n\nСписок литературы:\n[1] Толковый словарь. М., 1939.\n"
    out = research.clean_article_text(raw)

    assert "Толковый словарь" not in out
    assert "противоречие между нормами" in out


def test_библиографический_список_тоже_отрезан():
    body = "Толкование помогает устранить противоречие норм. " * 40
    raw = body + "\n\nБиблиографический список\nАрзуманян А. Э. Конкуренция.\n"
    out = research.clean_article_text(raw)

    assert "Арзуманян" not in out


def test_слово_references_в_начале_не_режет_статью():
    """Упоминание в первой четверти — это не хвост, а часть текста.

    Если резать по первому совпадению, статья, которая во введении
    ссылается на «references», потеряет девять десятых объёма.
    """
    raw = ("References in foreign doctrine. "
           + "Коллизия норм разрешается по правилу приоритета. " * 60)
    out = research.clean_article_text(raw)

    assert len(out) > len(raw) * 0.8
    assert "правилу приоритета" in out


def test_английский_хвост_отрезан():
    body = "Юридическая техника снижает число коллизий. " * 40
    raw = body + "\n\nCONFLICT OF INTEREST\nThe authors declare nothing.\n"
    out = research.clean_article_text(raw)

    assert "authors declare" not in out


def test_пустой_текст_не_ломает():
    assert research.clean_article_text("") == ""


# -------------------------------------------------------------- подпись
# Подпись — это то, что увидит модель, когда будет ссылаться на
# источник. Без автора и года сослаться невозможно.

def test_подпись_содержит_автора_название_и_год():
    s = Source(
        title="Коллизии в гражданском праве",
        year=2024,
        authors=["Мусалов Магомед Абдулаевич"],
        venue="Аграрное и земельное право",
        url="https://cyberleninka.ru/article/n/kollizii",
    )
    label = research.citation_label(s)

    assert "Мусалов" in label
    assert "Коллизии в гражданском праве" in label
    assert "2024" in label
    assert "Аграрное и земельное право" in label


def test_несколько_авторов_сокращаются():
    s = Source(title="Пробелы и коллизии", year=2024,
               authors=["Рябов С. И.", "Поляков В. А.", "Сидоров П. П."])
    assert "и др." in research.citation_label(s)


def test_подпись_влезает_в_поле_таблицы():
    s = Source(title="О" * 500, year=2024, authors=["А" * 200],
               venue="Ж" * 300)
    assert len(research.citation_label(s)) <= 290


def test_подпись_без_данных_не_пустая():
    assert research.citation_label(Source(title="")) != ""


# ------------------------------------------------------------- отбор статей

def test_читаем_только_то_что_отдаёт_полный_текст():
    """Crossref и OpenAlex полного текста не дают.

    Попытка скачать их страницу — это секунды впустую на каждую
    запись, а на выходе всё равно ничего.
    """
    cyber = Source(title="А", url="https://cyberleninka.ru/article/n/a")
    doi = Source(title="Б", url="https://doi.org/10.1234/x")
    nothing = Source(title="В", url="")

    assert research._readable(cyber)
    assert not research._readable(doi)
    assert not research._readable(nothing)


def test_повторы_между_запросами_убраны():
    """Запросы намеренно пересекаются, статьи приходят по два раза."""
    same_url = "https://cyberleninka.ru/article/n/kollizii"
    sources = [
        Source(title="Коллизии", url=same_url),
        Source(title="Коллизии (повтор)", url=same_url),
        Source(title="Другая статья", url="https://cyberleninka.ru/n/two"),
    ]
    out = research._dedupe(sources)

    assert len(out) == 2


def test_повтор_по_названию_без_адреса():
    sources = [
        Source(title="Пробелы в праве", url=""),
        Source(title="пробелы в праве", url=""),
    ]
    assert len(research._dedupe(sources)) == 1


# ------------------------------------------------------------ живая добыча

@pytest.mark.asyncio
async def test_добыча_складывает_статьи_в_библиотеку(session):
    """Проверка на подставных данных: сеть здесь не нужна.

    Настоящий поиск и скачивание проверяются вживую отдельно — в
    тестах они дали бы ложные падения при недоступности базы.
    """
    owner = "research-test-owner"

    async def fake_search(queries, *, topic, per_query=6):
        return [
            Source(title="Коллизии и конкуренция норм", year=2024,
                   authors=["Емельянов А. А."], venue="Вестник",
                   url="https://cyberleninka.ru/article/n/one"),
            Source(title="Без полного текста", year=2020,
                   url="https://doi.org/10.1/x"),
        ]

    async def fake_read(sources, *, limit=15):
        body = ("Коллизия и конкуренция норм различаются по предмету. " * 60)
        return [(sources[0], body + "\n\nСписок литературы:\n[1] Иванов.")]

    research_search = research.search_many
    research_read = research.read_fulltexts
    research.search_many = fake_search
    research.read_fulltexts = fake_read
    try:
        res = await research.harvest(
            session, owner_key=owner,
            queries=["коллизия конкуренция норм"], topic="Коллизии")
    finally:
        research.search_many = research_search
        research.read_fulltexts = research_read

    assert res.read_count == 1
    article = res.read[0]
    assert "Емельянов" in article.doc_id or article.chars > 0
    assert article.chars > 1000
    assert article.chunks >= 1

    # Список литературы в сохранённое не попал.
    hits = await _search(session, owner, "Иванов")
    assert not any("Иванов" in (h.get("text") or "") for h in hits)

    # А содержание попало и находится.
    hits = await _search(session, owner, "конкуренция норм предмет")
    assert hits


async def _search(session, owner: str, query: str):
    from app.modules.rag_service import library
    return await library.search_documents(
        session, owner_key=owner, query=query, limit=5)


@pytest.mark.asyncio
async def test_новый_круг_убирает_находки_прошлого(session):
    """Иначе библиотека копит статьи по трём разным темам сразу."""
    from app.modules.rag_service import library

    owner = "research-clear-owner"
    await library.add_document(
        session, owner_key=owner, filename="Старая находка",
        text="Текст прошлого круга исследования. " * 30,
        kind=research.KIND_RESEARCH)
    await library.add_document(
        session, owner_key=owner, filename="Методичка вуза",
        text="Требования к оформлению курсовой работы. " * 30,
        kind="методичка")

    removed = await research.clear_previous(session, owner_key=owner)

    assert removed == 1
    left = await library.list_documents(session, owner_key=owner)
    names = [d.filename for d in left]
    assert "Методичка вуза" in names
    assert "Старая находка" not in names
