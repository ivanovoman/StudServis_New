"""Проверки сборщика досье и извлечения фактуры."""

from __future__ import annotations

import pytest
import pytest_asyncio

from app.db import get_session_factory, init_models
from app.modules.rag_service.dossier import (
    MAX_EXCERPTS_PER_SOURCE,
    Dossier,
    Excerpt,
    _queries_for,
    _shorten,
    build_dossier,
    format_dossier,
    useful_norms,
)
from app.modules.rag_service.facts import (
    extract_facts,
    extract_names,
    lost_facts,
)
from app.modules.rag_service.library import add_document
from app.modules.rag_service.research import KIND_RESEARCH

OWNER = "dossier-test-owner"


@pytest_asyncio.fixture
async def session():
    await init_models()
    factory = get_session_factory()
    async with factory() as s:
        yield s


# --- извлечение фактуры ---------------------------------------------


def test_фактура_сокращением_и_словом():
    facts = extract_facts("В статье 76 Конституции РФ и ст. 15 ГК РФ.")
    assert "ст. 76" in facts
    assert "ст. 15" in facts
    assert "Конституция РФ" in facts
    assert "ГК РФ" in facts


def test_падеж_не_меняет_факт():
    assert extract_facts("ст. 105 УК РФ") == extract_facts("статьёй 105 УК РФ")


def test_название_кодекса_ловится_рядом_с_кириллицей():
    # Граница слова в кириллице — то место, где версия на JavaScript
    # молча не находила ничего.
    assert "УК РФ" in extract_facts("предусмотрено УК РФ прямо")


def test_потеря_нормы_видна():
    assert lost_facts("ст. 1193 и ст. 1210 ГК РФ", "ст. 1193 ГК РФ") == ["ст. 1210"]


def test_смена_падежа_не_потеря():
    assert lost_facts("согласно ст. 15 ГК РФ", "в статье 15 ГК РФ") == []


def test_имена_в_двух_записях():
    names = extract_names("Алексеев С. С. спорил с Ю. А. Тихомировым")
    assert "Алексеев С. С." in names


def test_номера_актов_и_годы():
    facts = extract_facts("Закон № 184-ФЗ, постановление №1-П от 2003 года")
    assert "№184-ФЗ" in facts
    assert "№1-П" in facts
    assert "2003" in facts


# --- вспомогательное ------------------------------------------------


def test_запросы_не_повторяются():
    queries = _queries_for("Понятие коллизии", "Понятие коллизии", None)
    assert len(queries) == len(set(q.lower() for q in queries))


def test_запросы_учитывают_тему_работы():
    queries = _queries_for("Понятие и признаки", "Коллизии в праве", None)
    assert any("Коллизии" in q for q in queries)


def test_обрезка_по_границе_предложения():
    text = "Первое предложение здесь. Второе предложение тут. Третье."
    assert _shorten(text, 30) == "Первое предложение здесь."


def test_короткий_текст_не_режется():
    assert _shorten("Короткий текст.", 100) == "Короткий текст."


# --- сборка досье ---------------------------------------------------


@pytest.mark.asyncio
async def test_досье_пустое_без_материала(session):
    result = await build_dossier(
        session, owner_key="пустой-владелец-досье", heading="Любой раздел")
    assert result.excerpts == []
    assert result.prompt_block == ""


@pytest.mark.asyncio
async def test_досье_собирает_выдержки_и_фактуру(session):
    await add_document(
        session,
        owner_key=OWNER,
        filename="Иванов И. И. Коллизии норм (Право и жизнь, 2020)",
        text=(
            "Коллизия в праве представляет собой противоречие между "
            "нормами, регулирующими одно отношение. Согласно статье 76 "
            "Конституции РФ приоритет имеет федеральный закон. "
            "Эту позицию развивал Тихомиров Ю. А. в своих работах. "
        ) * 6,
        kind=KIND_RESEARCH,
    )

    result = await build_dossier(
        session, owner_key=OWNER, heading="Понятие коллизии в праве",
        topic="Коллизии норм",
    )

    assert result.excerpts, "выдержки должны найтись"
    assert result.chars > 0
    assert "ст. 76" in result.facts
    assert "Конституция РФ" in result.facts
    assert any("Тихомиров" in n for n in result.names)
    assert "ВЫДЕРЖКИ" in result.prompt_block
    assert "[1]" in result.prompt_block


@pytest.mark.asyncio
async def test_досье_не_берёт_методички(session):
    await add_document(
        session,
        owner_key="владелец-с-методичкой",
        filename="Методичка вуза",
        text="Поля страницы: левое 30 мм, правое 10 мм. " * 40,
        kind="методичка",
    )

    result = await build_dossier(
        session, owner_key="владелец-с-методичкой", heading="Поля страницы",
    )
    assert result.excerpts == [], "методичка — не научный источник"


@pytest.mark.asyncio
async def test_досье_держится_в_бюджете(session):
    await add_document(
        session,
        owner_key="владелец-бюджет",
        filename="Петров П. П. Большая статья (Журнал, 2021)",
        text="Коллизия норм права возникает при противоречии предписаний. " * 300,
        kind=KIND_RESEARCH,
    )

    result = await build_dossier(
        session, owner_key="владелец-бюджет", heading="Коллизия норм права",
        budget_chars=2000,
    )
    assert result.chars <= 2000


def test_в_досье_не_больше_четырёх_кусков_с_источника():
    # Проверяем саму договорённость: одна статья не должна вытеснить
    # все прочие, иначе раздел станет её пересказом.
    assert MAX_EXCERPTS_PER_SOURCE == 4


def test_вывод_нумерует_источники():
    dossier = Dossier(
        heading="Раздел",
        excerpts=[
            Excerpt(source="Иванов И. И. Статья (2020)", text="Текст один.", score=1),
            Excerpt(source="Петров П. П. Статья (2021)", text="Текст два.", score=1),
        ],
        sources=["Иванов И. И. Статья (2020)", "Петров П. П. Статья (2021)"],
        facts=["ст. 15"],
        names=["Тихомиров Ю. А."],
    )
    block = format_dossier(dossier)
    assert "[1] Иванов" in block
    assert "[2] Петров" in block
    assert "ст. 15" in block
    assert "Тихомиров" in block


def test_годы_не_попадают_в_перечень_норм():
    dossier = Dossier(
        heading="Раздел",
        excerpts=[Excerpt(source="И. Статья", text="Текст.", score=1)],
        sources=["И. Статья"],
        facts=["2020", "ст. 15"],
    )
    block = format_dossier(dossier)
    norms_line = [ln for ln in block.splitlines() if "НОРМЫ И АКТЫ" in ln][0]
    assert "ст. 15" in norms_line
    assert "2020" not in norms_line


def test_номер_сноски_не_попадает_в_перечень_норм():
    # «№ 1» в научной статье — почти всегда сноска. Модель, увидев
    # его в списке разрешённого, сошлётся на несуществующий акт.
    assert useful_norms(["№1", "№23", "№ 184-ФЗ", "ст. 76", "2003"]) == [
        "№ 184-ФЗ", "ст. 76",
    ]


def test_звание_не_принимается_за_фамилию():
    assert extract_names("Профессор А. Ф. Черданцев") == {"Черданцев А. Ф."}


def test_падежные_варианты_фамилии_схлопываются():
    names = extract_names("Васев И.Н. писал, с Васевым И. Н. спорили")
    assert names == {"Васев И. Н."}


def test_слово_после_фамилии_не_становится_учёным():
    # «Матузов Н.И. Актуальные проблемы» — обратное выражение читало
    # отсюда учёного по фамилии Актуальные.
    assert extract_names("Матузов Н.И. Актуальные проблемы теории") == {
        "Матузов Н. И.",
    }


def test_фамилия_после_отброшенного_звания_читается():
    assert extract_names("отв. ред. В.Н. Кудрявцев") == {"Кудрявцев В. Н."}
