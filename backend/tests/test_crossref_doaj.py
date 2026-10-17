"""Crossref и DOAJ: разбор ответов и поведение при отказах.

Тесты офлайновые — сеть подменяется фиктивным `fetcher`. Ходить в
настоящие базы на каждом прогоне нельзя: они иногда медленные, иногда
сердитые, и весь набор тестов становится заложником чужого сервера.

Образцы ответов взяты из настоящей выдачи по теме «коллизии в праве»,
включая их особенности: JATS-разметку в абстрактах Crossref, переносы
строк в заголовках, тонкие пробелы в именах авторов DOAJ.
"""

from __future__ import annotations

import logging

from app.modules.sources import crossref, doaj

# --- образцы настоящих ответов ----------------------------------------

CROSSREF_ITEM = {
    "title": ["Интерперсональные коллизии\nв международном частном праве"],
    "author": [
        {"family": "Ерпылева", "given": "Наталия Ю."},
        {"family": "Гетьман-Павлова", "given": "Ирина В."},
    ],
    "issued": {"date-parts": [[2019, 9, 1]]},
    "container-title": ["Law. Journal of the Higher School of Economics"],
    "DOI": "10.17323/2072-8166.2019.3.220.249",
    "URL": "https://doi.org/10.17323/2072-8166.2019.3.220.249",
    "abstract": ("<jats:title>Аннотация</jats:title><jats:p>Целью "
                 "исследования является анализ интерперсональных "
                 "коллизий.</jats:p>"),
    "is-referenced-by-count": 7,
    "license": [{"URL": "http://creativecommons.org/licenses/by-nc-nd/4.0"}],
}

DOAJ_ITEM = {
    "bibjson": {
        "title": "О субъективных и объективных факторах коллизий",
        "year": "2018",
        "author": [{"name": "А.\u2009Г. Упоров"}],
        "journal": {"title": "Российско-азиатский правовой журнал",
                    "language": ["EN", "RU"]},
        "identifier": [{"type": "doi", "id": "10.14258/ralj(2018)1.16"},
                       {"type": "pissn", "id": "2618-9313"}],
        "link": [{"url": "https://ralj.ru/article/view/18914"}],
        "abstract": "<p>Статья посвящена причинам возникновения коллизий.</p>",
    }
}


# --- Crossref ---------------------------------------------------------

def test_jats_markup_is_stripped():
    """Разметку нельзя отдавать модели: она копирует теги в текст."""
    source = crossref.parse_work(CROSSREF_ITEM)
    assert "<jats" not in source.abstract
    assert source.abstract.startswith("Целью исследования")
    # Служебный заголовок «Аннотация» пользы не несёт.
    assert "Аннотация" not in source.abstract


def test_line_breaks_in_title_are_flattened():
    """Перенос из журнальной вёрстки разваливает заголовок в оглавлении."""
    assert "\n" not in crossref.parse_work(CROSSREF_ITEM).title
    assert crossref.parse_work(CROSSREF_ITEM).title.startswith(
        "Интерперсональные коллизии в международном")


def test_author_names_are_assembled():
    source = crossref.parse_work(CROSSREF_ITEM)
    assert source.authors[0] == "Ерпылева Наталия Ю."
    assert len(source.authors) == 2


def test_bibliography_fields_survive():
    """Ради этих полей Crossref и подключён: из них растёт список
    литературы, который модель иначе выдумывает."""
    source = crossref.parse_work(CROSSREF_ITEM)
    assert source.year == 2019
    assert source.doi == "10.17323/2072-8166.2019.3.220.249"
    assert source.venue.startswith("Law. Journal")
    assert source.cited_by == 7
    assert source.provider == "crossref"


def test_open_license_recognised():
    assert crossref.parse_work(CROSSREF_ITEM).is_oa is True


def test_unknown_license_is_not_called_open():
    """Обещать бесплатный доступ, которого нет, — злить пользователя."""
    item = dict(CROSSREF_ITEM)
    item.pop("license")
    assert crossref.parse_work(item).is_oa is False


def test_crossref_failure_is_logged(caplog):
    def fetcher(url, timeout):
        raise TimeoutError("не дождались")

    with caplog.at_level(logging.WARNING):
        assert crossref.search("тема", fetcher=fetcher) == []
    assert "Crossref не ответил" in caplog.text


def test_crossref_query_url_has_filters():
    url = crossref.build_query_url("коллизии", since_year=2020, rows=5)
    assert "from-pub-date%3A2020-01-01" in url
    assert "mailto=" in url          # вежливый пул
    assert "rows=5" in url


def test_crossref_searches_every_direction():
    seen = []

    def searcher(q, **kw):
        seen.append(q)
        return []

    crossref.find_sources("тема", ["первое", "второе"], searcher=searcher)
    assert seen == ["тема", "первое", "второе"]


# --- DOAJ -------------------------------------------------------------

def test_doaj_parses_article():
    source = doaj.parse_article(DOAJ_ITEM)
    assert source.title.startswith("О субъективных")
    assert source.year == 2018
    assert source.doi == "10.14258/ralj(2018)1.16"
    assert source.url == "https://ralj.ru/article/view/18914"
    assert source.provider == "doaj"


def test_doaj_is_always_open_access():
    """Весь каталог по определению открытый — ради этого он и создан."""
    assert doaj.parse_article(DOAJ_ITEM).is_oa is True


def test_thin_space_in_author_is_replaced():
    """Тонкий пробел в DOCX превращается в странный разрыв строки."""
    assert "\u2009" not in doaj.parse_article(DOAJ_ITEM).authors[0]


def test_doaj_markup_is_stripped():
    assert "<p>" not in doaj.parse_article(DOAJ_ITEM).abstract


def test_doaj_russian_language_detected():
    assert doaj.parse_article(DOAJ_ITEM).language == "ru"


def test_doaj_query_is_fully_encoded():
    """Запрос идёт частью пути: незакодированный пробел даёт 404."""
    url = doaj.build_query_url("право коллизии")
    assert " " not in url
    assert "%D0%BF" in url


def test_doaj_filters_old_articles():
    def fetcher(url, timeout):
        return {"results": [DOAJ_ITEM]}          # 2018 год

    assert doaj.search("тема", min_year=2020, fetcher=fetcher) == []
    assert len(doaj.search("тема", min_year=2015, fetcher=fetcher)) == 1


def test_doaj_absurd_year_is_dropped():
    """В базе попадаются годы вроде 12 или 3025."""
    item = {"bibjson": dict(DOAJ_ITEM["bibjson"], year="12")}
    assert doaj.parse_article(item).year is None


def test_doaj_failure_is_logged(caplog):
    def fetcher(url, timeout):
        raise OSError("сеть недоступна")

    with caplog.at_level(logging.WARNING):
        assert doaj.search("тема", fetcher=fetcher) == []
    assert "DOAJ не ответил" in caplog.text
