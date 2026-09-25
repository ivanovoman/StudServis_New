"""Библиографическая запись по ГОСТ Р 7.0.100-2018.

Список литературы — единственная часть работы, которую проверяют
буквально: научный руководитель открывает ссылку и смотрит, существует
ли статья. Поэтому запись собирается из метаданных баз, а не из текста
модели, и проверяется придирчиво: тире вместо дефиса, порядок имени,
отсутствие выдуманных страниц.

Образцы взяты из настоящей выдачи по теме «коллизии в праве».
"""

from __future__ import annotations

from datetime import date

from app.modules.sources.gost_biblio import (
    DASH, format_author, format_list, format_source)
from app.modules.sources.openalex import Source, surname_first


def article(**kw) -> Source:
    base = dict(
        title="Некоторые проблемы пробелов и коллизий в праве",
        authors=["Рябов Сергей Иванович", "Поляков Вячеслав Александрович"],
        year=2024,
        venue="Право и управление",
        pages="301-304",
        issue="9",
        provider="cyberleninka",
        url="https://cyberleninka.ru/article/n/nekotorye-problemy",
    )
    base.update(kw)
    return Source(**base)


# --- имена ------------------------------------------------------------

def test_head_author_is_inverted():
    """По первому элементу список сортируется — там фамилия."""
    assert format_author("Вопленко Николай Николаевич",
                         inverted=True) == "Вопленко, Н. Н."


def test_responsibility_author_is_direct():
    """После косой черты порядок прямой — так требует ГОСТ."""
    assert format_author("Вопленко Николай Николаевич",
                         inverted=False) == "Н. Н. Вопленко"


def test_glued_initials_are_split():
    """«А.А.» — два инициала, и оба должны остаться."""
    assert format_author("Кузнецов А.А.", inverted=True) == "Кузнецов, А. А."


def test_transliterated_initial_stays_single():
    """«Yu.» — это один инициал «Ю», а не «Y. U.»."""
    assert format_author("Erpyleva Natalia Yu.",
                         inverted=True) == "Erpyleva, N. Y."


def test_latin_name_order_is_fixed():
    """Базы дают латиницу как «Имя Фамилия» — иначе фамилией станет имя."""
    assert surname_first("Natalia Yu. Erpyleva") == "Erpyleva Natalia Yu."


def test_russian_name_order_is_untouched():
    assert surname_first("Ерпылева Наталия Ю.") == "Ерпылева Наталия Ю."


def test_more_than_three_authors_collapse():
    """ГОСТ разрешает «[и др.]» — перечислять всех незачем."""
    record = format_source(article(authors=[
        "Первый А. А.", "Второй Б. Б.", "Третий В. В.", "Четвёртый Г. Г."]))
    assert "[и др.]" in record
    assert "Четвёртый" not in record


# --- состав записи ----------------------------------------------------

def test_full_record_matches_gost():
    record = format_source(article())
    assert record == (
        "Рябов, С. И. Некоторые проблемы пробелов и коллизий в праве "
        "/ С. И. Рябов, В. А. Поляков // Право и управление. "
        f"{DASH} 2024. {DASH} № 9. {DASH} С. 301{DASH}304."
    )


def test_dash_is_not_hyphen():
    """Дефис вместо тире — самая частая придирка нормоконтроля."""
    record = format_source(article())
    assert f" {DASH} " in record
    assert " - " not in record


def test_page_range_uses_dash():
    assert f"С. 301{DASH}304" in format_source(article())


def test_volume_and_issue_together():
    record = format_source(article(volume="97", issue="5"))
    assert "Т. 97, № 5" in record


def test_missing_pages_are_not_invented():
    """Выдуманный диапазон хуже отсутствующего: он выглядит достоверно."""
    record = format_source(article(pages=""))
    # Именно блок страниц, а не инициал «С. И.» в имени автора.
    assert f"{DASH} С. " not in record


def test_url_appears_when_pages_unknown():
    """Без страниц источник ищут по ссылке — и ГОСТ требует даты."""
    record = format_source(article(pages=""), accessed=date(2026, 9, 25))
    assert "URL: https://cyberleninka.ru" in record
    assert "(дата обращения: 25.09.2026)" in record


def test_url_omitted_when_pages_known():
    assert "URL:" not in format_source(article())


def test_doi_included():
    assert "DOI 10.1234/abc" in format_source(article(doi="10.1234/abc"))


def test_double_slash_separates_journal():
    """Две косые черты — обязательный знак, а не украшение."""
    assert " // Право и управление" in format_source(article())


def test_record_ends_with_single_period():
    record = format_source(article())
    assert record.endswith(".")
    assert not record.endswith("..")


def test_empty_title_gives_nothing():
    assert format_source(article(title="")) == ""


def test_article_without_authors_starts_with_title():
    record = format_source(article(authors=[]))
    assert record.startswith("Некоторые проблемы")
    assert " / " not in record


# --- список -----------------------------------------------------------

def test_list_is_numbered_and_sorted():
    text = format_list([
        article(title="Яблоко", authors=["Яковлев И. И."]),
        article(title="Арбуз", authors=["Аверин П. П."]),
    ])
    lines = text.splitlines()
    assert lines[0].startswith("1. Аверин")
    assert lines[1].startswith("2. Яковлев")


def test_russian_sources_go_before_latin():
    """Смешанный алфавит в одном списке выглядит неряшливо."""
    text = format_list([
        article(title="Regime collisions", authors=["Smith John"]),
        article(title="Коллизии", authors=["Яковлев И. И."]),
    ])
    lines = text.splitlines()
    assert "Яковлев" in lines[0]
    assert "Smith" in lines[1]


def test_duplicates_are_removed():
    text = format_list([article(), article()])
    assert len(text.splitlines()) == 1
