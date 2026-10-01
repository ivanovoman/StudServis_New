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
    get_style_samples,
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


# ------------------------------------------------------------- стиль

СТАТЬИ = """Защита авторских прав

Авторские права возникают сразу после создания произведения.
Регистрация не нужна. Поэтому многие нарушают их, сами того не замечая.
Например, берут чужое фото из интернета для своего сайта.

Что делать правообладателю

Сначала стоит зафиксировать нарушение. Подойдёт нотариальный осмотр
страницы. Он стоит денег, но без него суд может не поверить.

Наши специалисты подготовят заявление в суд и сопроводят дело до
решения. Обращайтесь за бесплатной консультацией.

Способы защиты

Закон даёт выбор. Можно требовать убытки, а можно компенсацию.
Компенсация проще: размер убытков доказывать не нужно.
"""


@pytest.mark.asyncio
async def test_образец_стиля_не_попадает_в_тематический_поиск(session):
    """Иначе статьи про авторское право всплывут в работе про коллизии."""
    key = "owner-style-1111"
    await add_document(session, owner_key=key, filename="статьи.pdf",
                       text=СТАТЬИ, kind="стиль")

    hits = await search_documents(
        session, owner_key=key, query="защита авторских прав", limit=5)

    assert hits == []


@pytest.mark.asyncio
async def test_образцы_стиля_отдаются_отдельно(session):
    key = "owner-style-2222"
    await add_document(session, owner_key=key, filename="статьи.pdf",
                       text=СТАТЬИ, kind="стиль")

    samples = await get_style_samples(session, owner_key=key, limit=3)

    assert samples
    assert any("Авторские права" in s for s in samples)


@pytest.mark.asyncio
async def test_рекламные_куски_не_идут_в_образец(session):
    """Иначе в курсовой появится «мы подготовим заявление»."""
    key = "owner-style-3333"
    await add_document(session, owner_key=key, filename="статьи.pdf",
                       text=СТАТЬИ, kind="стиль")

    samples = await get_style_samples(session, owner_key=key, limit=5)
    joined = " ".join(samples).lower()

    assert "обращайтесь" not in joined
    assert "наши специалисты" not in joined


@pytest.mark.asyncio
async def test_обычный_материал_не_считается_образцом_стиля(session):
    key = "owner-style-4444"
    await add_document(session, owner_key=key, filename="методичка.pdf",
                       text=METHODICHKA, kind="методичка")

    assert await get_style_samples(session, owner_key=key) == []
    # А в тематическом поиске он, наоборот, обязан находиться.
    assert await search_documents(session, owner_key=key,
                                  query="оригинальность", limit=1)


@pytest.mark.asyncio
async def test_примечания_рецензента_вычищаются_из_образца(session):
    """PDF со статьями приходит с правкой рецензента поверх текста."""
    key = "owner-style-5555"
    текст_с_правкой = (
        "Авторские права возникают сразу после создания произведения. "
        "Регистрация для этого не требуется, что подтверждается статьёй "
        "1259 Гражданского кодекса.\n\n"
        "Добавлено примечание ([РБ1]): здесь нужна ссылка на практику\n\n"
        "Нарушением считается любое использование без согласия автора. "
        "Например, публикация чужой фотографии на своём сайте."
    )
    await add_document(session, owner_key=key, filename="статьи.pdf",
                       text=текст_с_правкой, kind="стиль")

    samples = await get_style_samples(session, owner_key=key, limit=5)

    assert all("примечание" not in s.lower() for s in samples)


def test_разрывы_от_pdf_чинятся():
    from app.modules.rag_service.library import _repair_pdf_spacing

    assert _repair_pdf_spacing("защиты из -за формы") == "защиты из-за формы"
    assert _repair_pdf_spacing("на флеш -накопителе") == "на флеш-накопителе"
    # Висячий дефис в перечислении законен и остаётся.
    assert _repair_pdf_spacing("теле - и радиопередачи") == "теле - и радиопередачи"
