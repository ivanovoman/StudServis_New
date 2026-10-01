"""Проверки библиотеки материалов: нарезка, хранение, изоляция владельцев."""

from __future__ import annotations

import os
import tempfile

import pytest
import pytest_asyncio

# База подменяется до импорта приложения: иначе тесты пойдут в рабочую.
os.environ.setdefault(
    "DATABASE_URL", "sqlite+aiosqlite:///" + tempfile.mktemp(suffix=".db"))

from app.db import get_session_factory, init_models  # noqa: E402
from app.modules.rag_service.library import (  # noqa: E402
    add_document,
    list_documents,
    remove_document,
    search_documents,
    split_text,
)

METHODICHKA = """Общие требования к оформлению

Работа выполняется шрифтом Times New Roman, кегль 14, межстрочный
интервал полуторный. Поля страницы: левое 30 мм, правое 10 мм.

Нумерация страниц

Страницы нумеруются арабскими цифрами в правом нижнем углу без точки.
Титульный лист считается первой страницей, но номер на нём не ставится.

Требования к объёму

Объём курсовой работы составляет от 30 до 40 страниц без учёта
приложений.

Оригинальность текста

Оригинальность работы по системе Антиплагиат должна быть не менее
60 процентов.
"""


@pytest_asyncio.fixture
async def session():
    await init_models()
    factory = get_session_factory()
    async with factory() as s:
        yield s


# ------------------------------------------------------------- нарезка

def test_нарезка_идёт_по_заголовкам():
    """Иначе разделы методички слипаются и поиск отвечает невпопад."""
    chunks = split_text(METHODICHKA)

    assert len(chunks) == 4
    assert chunks[0].startswith("Общие требования")
    assert "Оригинальность" in chunks[-1]


def test_заголовок_остаётся_в_начале_своего_фрагмента():
    chunks = split_text(METHODICHKA)
    про_объём = [c for c in chunks if "30 до 40 страниц" in c][0]

    assert про_объём.startswith("Требования к объёму")


def test_длинный_абзац_режется_по_предложениям():
    long_para = " ".join(
        f"Предложение номер {i} о правовом регулировании отношений." 
        for i in range(60)
    )
    chunks = split_text(long_para)

    assert len(chunks) > 1
    # Фраза не должна обрываться на середине.
    assert all(c.strip().endswith((".", "!", "?")) for c in chunks)


def test_пустой_текст_не_даёт_фрагментов():
    assert split_text("") == []
    assert split_text("\n\n   \n") == []


# ------------------------------------------------------------- хранение

@pytest.mark.asyncio
async def test_документ_сохраняется_и_ищется(session):
    doc = await add_document(
        session, owner_key="owner-aaaa-1111",
        filename="методичка.pdf", text=METHODICHKA, kind="методичка",
    )

    assert doc.chunks == 4
    assert doc.chars == len(METHODICHKA)

    hits = await search_documents(
        session, owner_key="owner-aaaa-1111",
        query="какая нужна оригинальность", limit=1,
    )
    assert hits
    assert "60 процентов" in hits[0]["text"]
    assert hits[0]["source"] == "методичка.pdf"
    assert hits[0]["kind"] == "методичка"


@pytest.mark.asyncio
async def test_повторная_загрузка_заменяет_а_не_дублирует(session):
    """Иначе выдача наполнится копиями одного абзаца."""
    key = "owner-bbbb-2222"
    await add_document(session, owner_key=key, filename="м.pdf",
                       text=METHODICHKA)
    await add_document(session, owner_key=key, filename="м.pdf",
                       text=METHODICHKA)

    docs = await list_documents(session, owner_key=key)
    assert len(docs) == 1


@pytest.mark.asyncio
async def test_материалы_чужого_владельца_не_видны(session):
    await add_document(session, owner_key="owner-cccc-3333",
                       filename="моё.pdf", text=METHODICHKA)

    чужие = await search_documents(
        session, owner_key="owner-dddd-4444",
        query="оригинальность", limit=5,
    )
    assert чужие == []
    assert await list_documents(session, owner_key="owner-dddd-4444") == []


@pytest.mark.asyncio
async def test_удаление_убирает_и_фрагменты(session):
    key = "owner-eeee-5555"
    doc = await add_document(session, owner_key=key, filename="м.pdf",
                             text=METHODICHKA)

    assert await remove_document(session, owner_key=key, doc_id=doc.id)
    assert await list_documents(session, owner_key=key) == []
    assert await search_documents(session, owner_key=key,
                                  query="оригинальность") == []


@pytest.mark.asyncio
async def test_нельзя_удалить_чужой_документ(session):
    doc = await add_document(session, owner_key="owner-ffff-6666",
                             filename="м.pdf", text=METHODICHKA)

    removed = await remove_document(
        session, owner_key="owner-gggg-7777", doc_id=doc.id)

    assert removed is False


@pytest.mark.asyncio
async def test_индекс_обновляется_после_загрузки(session):
    """Кэш индекса не должен переживать изменение библиотеки."""
    key = "owner-hhhh-8888"
    await add_document(session, owner_key=key, filename="первый.pdf",
                       text=METHODICHKA)
    await search_documents(session, owner_key=key, query="оригинальность")

    await add_document(
        session, owner_key=key, filename="второй.pdf",
        text="Виндикационный иск предъявляется невладеющим собственником "
             "к владеющему несобственнику. Срок давности три года.",
    )
    hits = await search_documents(session, owner_key=key,
                                  query="виндикационный иск", limit=1)

    assert hits
    assert hits[0]["source"] == "второй.pdf"
