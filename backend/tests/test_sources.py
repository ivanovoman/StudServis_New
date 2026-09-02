"""Тесты поиска источников и анализа с опорой на них.

Сеть в тестах не используется: OpenAlex подменяется фикстурой.
"""

import asyncio
import json

import pytest

from app.modules.sources.grounding import (
    GroundedAnalysis,
    GroundedThesis,
    check_grounding,
    format_sources_for_prompt,
    parse_grounded,
    sources_to_chunks,
)
from app.modules.sources.openalex import (
    Source,
    build_query_url,
    deduplicate,
    filter_relevant,
    find_sources_for_topic,
    parse_work,
    rank_sources,
    relevance,
    restore_abstract,
    search,
)

TOPIC = "Субсидиарная ответственность контролирующих должника лиц"


def src(title, year=2025, doi="10.1/x", abstract="а" * 200, **kw):
    return Source(title=title, year=year, doi=doi, abstract=abstract,
                  url="https://example.org", **kw)


class TestRestoreAbstract:
    def test_restores_word_order(self):
        inv = {"мир": [1], "Привет": [0], "и": [2], "люди": [3]}
        assert restore_abstract(inv) == "Привет мир и люди"

    def test_repeated_words(self):
        assert restore_abstract({"да": [0, 1, 2]}) == "да да да"

    def test_empty(self):
        assert restore_abstract(None) == ""
        assert restore_abstract({}) == ""


class TestParseWork:
    RAW = {
        "title": "Субсидиарная ответственность",
        "publication_year": 2025,
        "doi": "https://doi.org/10.123/abc",
        "cited_by_count": 7,
        "language": "ru",
        "open_access": {"is_oa": True, "oa_url": "https://oa.example/pdf"},
        "authors": [],
        "authorships": [{"author": {"display_name": "Иванов И.И."}}],
        "primary_location": {"source": {"display_name": "Право и жизнь"}},
        "abstract_inverted_index": {"Текст": [0], "аннотации": [1]},
    }

    def test_parses_fields(self):
        s = parse_work(self.RAW)
        assert s.year == 2025
        assert s.doi == "10.123/abc"          # префикс снят
        assert s.authors == ["Иванов И.И."]
        assert s.venue == "Право и жизнь"
        assert s.is_oa and s.cited_by == 7
        assert s.abstract == "Текст аннотации"

    def test_handles_missing_fields(self):
        s = parse_work({"title": "Пусто"})
        assert s.year is None and s.doi == "" and s.authors == []

    def test_gost_ref_has_doi(self):
        assert "DOI: 10.123/abc" in parse_work(self.RAW).gost_ref()


class TestDeduplicate:
    def test_by_doi(self):
        a, b = src("Раз", doi="10.1/same"), src("Два", doi="10.1/same")
        assert len(deduplicate([a, b])) == 1

    def test_by_title_when_doi_differs(self):
        """Один депозит Zenodo под двумя DOI — частый случай."""
        a = src("Одна и та же статья", doi="10.5281/zenodo.20379051")
        b = src("Одна и та же статья", doi="10.5281/zenodo.20379052")
        assert len(deduplicate([a, b])) == 1

    def test_keeps_distinct(self):
        assert len(deduplicate([src("Раз", doi="1"), src("Два", doi="2")])) == 2


class TestRelevance:
    def test_on_topic_scores_high(self):
        s = src("Субсидиарная ответственность контролирующих должника лиц")
        assert relevance(s, TOPIC) > 0.8

    def test_off_topic_scores_low(self):
        s = src("Искусственный интеллект в государственном управлении",
                abstract="Цифровизация госуслуг и нейросети " * 8)
        assert relevance(s, TOPIC) < 0.3

    def test_matches_different_word_forms(self):
        s = src("Ответственности контролирующего лица при банкротстве",
                abstract="Субсидиарной ответственности должника " * 8)
        assert relevance(s, TOPIC) > 0.5

    def test_filter_removes_off_topic(self):
        good = src("Субсидиарная ответственность контролирующих лиц должника")
        bad = src("Закупки по 44-ФЗ", abstract="Тендеры и контракты " * 10)
        assert filter_relevant([good, bad], TOPIC) == [good]


class TestRanking:
    def test_relevance_beats_recency(self):
        """Свежая статья не по теме бесполезнее старой по теме."""
        fresh_off = src("Третейское разбирательство", year=2026,
                        abstract="Арбитраж и медиация " * 10)
        old_on = src("Субсидиарная ответственность контролирующих должника лиц",
                     year=2021)
        assert rank_sources([fresh_off, old_on], topic=TOPIC)[0] is old_on

    def test_abstract_required_first(self):
        no_abs = src("Субсидиарная ответственность", abstract="")
        with_abs = src("Субсидиарная ответственность контролирующих лиц")
        assert rank_sources([no_abs, with_abs], topic=TOPIC)[0] is with_abs

    def test_recency_breaks_tie(self):
        a = src("Субсидиарная ответственность контролирующих должника лиц", year=2020)
        b = src("Субсидиарная ответственность контролирующих должника лиц", year=2025)
        # дедупликация по заголовку тут не применяется, ранжируем напрямую
        assert rank_sources([a, b], topic=TOPIC)[0].year == 2025


class TestQueryUrl:
    def test_oa_filter_present(self):
        assert "is_oa%3Atrue" in build_query_url("тест") or \
               "is_oa:true" in build_query_url("тест")

    def test_year_filter(self):
        assert "2021-01-01" in build_query_url("тест", since_year=2021)

    def test_per_page_capped(self):
        assert "per-page=50" in build_query_url("тест", per_page=999)


class TestSearchResilience:
    def test_network_error_returns_empty(self):
        """Падение OpenAlex не должно ронять анализ темы."""
        def boom(url, timeout):
            raise ConnectionError("нет сети")
        assert search("тема", fetcher=boom) == []

    def test_parses_results(self):
        def fake(url, timeout):
            return {"results": [TestParseWork.RAW]}
        assert len(search("тема", fetcher=fake)) == 1


class TestFindSourcesForTopic:
    def _searcher(self, works):
        def run(q, **kw):
            return list(works)
        return run

    def test_filters_and_limits(self):
        works = [
            src(f"Субсидиарная ответственность контролирующих лиц {i}", doi=f"10/{i}")
            for i in range(10)
        ] + [src("Кофейня как бизнес", doi="10/x",
                 abstract="Обжарка зерна и логистика " * 10)]
        out = find_sources_for_topic(["направление"], topic=TOPIC, limit=3,
                                     searcher=self._searcher(works))
        assert len(out) == 3
        assert all("убсидиарн" in s.title for s in out)

    def test_falls_back_when_filter_empties(self):
        """Лучше слабые источники, чем пустой список."""
        works = [src("Совсем другая тема", doi="10/1",
                     abstract="Про погоду и климат " * 10)]
        out = find_sources_for_topic(["x"], topic=TOPIC, limit=3,
                                     searcher=self._searcher(works))
        assert len(out) == 1


class TestGroundedParsing:
    RAW = json.dumps({
        "core": "Суть темы в двух словах про ответственность",
        "theses": [
            {"text": "Первый тезис из источника", "source": 1},
            {"text": "Второй тезис из источника", "source": 2},
            {"text": "Собственный вывод", "source": None},
        ],
        "controversies": [{"text": "Авторы расходятся", "source": 1}],
        "logic_arc": ["сначала", "потом"],
        "banality_risks": ["пересказ норм"],
        "search_directions": ["ещё поискать"],
        "gaps": ["нет статистики"],
    })

    def _sources(self):
        return [src("Статья один", doi="10/1"), src("Статья два", doi="10/2")]

    def test_parses_thesis_sources(self):
        a = parse_grounded(self.RAW, self._sources())
        assert a.theses[0].source_index == 1
        assert a.theses[2].source_index is None

    def test_grounded_share(self):
        a = parse_grounded(self.RAW, self._sources())
        assert a.grounded_share == pytest.approx(2 / 3)

    def test_plain_strings_tolerated(self):
        raw = json.dumps({"theses": ["просто строка без источника"]})
        a = parse_grounded(raw, self._sources())
        assert a.theses[0].source_index is None

    def test_string_digit_source_tolerated(self):
        raw = json.dumps({"theses": [{"text": "тезис", "source": "2"}]})
        assert parse_grounded(raw, self._sources()).theses[0].source_index == 2

    def test_to_dict_resolves_source(self):
        d = parse_grounded(self.RAW, self._sources()).to_dict()
        assert d["theses"][0]["doi"] == "10/1"
        assert d["sources"][0]["index"] == 1


class TestGroundingChecks:
    def test_too_few_sources(self):
        a = GroundedAnalysis(sources=[src("Одна")])
        assert any("источников найдено 1" in p for p in check_grounding(a))

    def test_low_grounded_share_flagged(self):
        a = GroundedAnalysis(
            sources=[src("A", doi="1"), src("B", doi="2")],
            theses=[GroundedThesis("свой", None), GroundedThesis("свой2", None)],
            gaps=["чего-то нет"],
        )
        assert any("придумала" in p for p in check_grounding(a))

    def test_dangling_source_reference(self):
        """Ссылка на источник, которого нет в подборке."""
        a = GroundedAnalysis(
            sources=[src("A", doi="1"), src("B", doi="2")],
            theses=[GroundedThesis("тезис", 9)],
            gaps=["нет"],
        )
        assert any("которого нет" in p for p in check_grounding(a))

    def test_good_analysis_has_no_problems(self):
        a = GroundedAnalysis(
            sources=[src("A", doi="1"), src("B", doi="2")],
            theses=[GroundedThesis("раз", 1), GroundedThesis("два", 2)],
            gaps=["нет статистики"],
        )
        assert check_grounding(a) == []


class TestPromptAndRag:
    def test_prompt_lists_sources_with_numbers(self):
        text = format_sources_for_prompt([src("Первая"), src("Вторая")])
        assert "[1]" in text and "[2]" in text

    def test_long_abstract_truncated(self):
        text = format_sources_for_prompt([src("Длинная", abstract="я" * 5000)])
        assert len(text) < 2000

    def test_sources_become_rag_chunks(self):
        chunks = sources_to_chunks([src("Статья", doi="10/1")], "proj42")
        assert chunks[0].collection == "user_project_proj42"
        assert chunks[0].metadata["doi"] == "10/1"
        assert chunks[0].metadata["kind"] == "source_abstract"

    def test_sources_without_abstract_skipped(self):
        assert sources_to_chunks([src("Пусто", abstract="")], "p") == []


class TestGroundedAPI:
    @pytest.fixture
    def client(self):
        from fastapi.testclient import TestClient
        from app.main import app
        return TestClient(app)

    @pytest.fixture
    def stub(self, monkeypatch):
        payload = TestGroundedParsing.RAW
        sources = [src("Статья один", doi="10/1"), src("Статья два", doi="10/2")]

        class R:
            async def stream(self, messages):
                yield payload

        import app.modules.ai_engine.router as rmod
        import app.modules.sources.registry as reg

        async def fake_find(*a, **k):
            return sources

        monkeypatch.setattr(rmod, "get_router", lambda: R())
        monkeypatch.setattr(reg, "find_sources", fake_find)

    def test_returns_sources_and_theses(self, client, stub):
        r = client.post("/api/v1/ai/analyze-topic/grounded",
                        json={"topic": "Субсидиарная ответственность",
                              "preferences": {"subject": "legal"}})
        assert r.status_code == 200
        b = r.json()
        assert b["grounded"]
        assert len(b["analysis"]["sources"]) == 2
        assert b["analysis"]["theses"][0]["doi"] == "10/1"

    def test_reports_when_not_grounded(self, client, monkeypatch):
        import app.modules.sources.registry as reg

        async def empty(*a, **k):
            return []

        monkeypatch.setattr(reg, "find_sources", empty)

        class R:
            async def stream(self, messages):
                yield json.dumps({"core": "c", "theses": [],
                                  "search_directions": ["a", "b", "c", "d", "e"],
                                  "logic_arc": ["x", "y"]})

        import app.modules.ai_engine.router as rmod
        monkeypatch.setattr(rmod, "get_router", lambda: R())
        r = client.post("/api/v1/ai/analyze-topic/grounded",
                        json={"topic": "Совершенно неизвестная тема"})
        assert r.status_code == 200
        assert not r.json()["grounded"]
        assert r.json()["problems"]


# --- КиберЛенинка -----------------------------------------------------

SEARCH_ITEM = {
    "name": "ПРОБЛЕМЫ <b>СУБСИДИАРНОЙ</b> ОТВЕТСТВЕННОСТИ",
    "annotation": "Статья посвящена <b>субсидиарной</b> ответственности "
                  "контролирующих должника лиц в делах о банкротстве, "
                  "анализируется практика привлечения к ответственности.",
    "link": "/article/n/problemy-subsidiarnoy",
    "authors": ["Саркисянц Арсен Вячеславович"],
    "year": 2024,
    "journal": "ГлаголЪ правосудия",
    "ocr": ["\ufeffУДК 347.51", "текст статьи"],
}


def cl_fetcher(items, found=1):
    def fetch(url, payload):
        return json.dumps({"found": found, "articles": items},
                          ensure_ascii=False)
    return fetch


class TestCyberleninkaParsing:
    def test_strips_highlight_tags(self):
        from app.modules.sources.cyberleninka import parse_article
        s = parse_article(SEARCH_ITEM)
        assert "<b>" not in s.title
        assert s.title == "ПРОБЛЕМЫ СУБСИДИАРНОЙ ОТВЕТСТВЕННОСТИ"
        assert "<b>" not in s.abstract

    def test_fills_metadata(self):
        from app.modules.sources.cyberleninka import parse_article
        s = parse_article(SEARCH_ITEM)
        assert s.year == 2024
        assert s.provider == "cyberleninka"
        assert s.is_oa
        assert s.doi is None
        assert s.url == "https://cyberleninka.ru/article/n/problemy-subsidiarnoy"
        assert s.venue == "ГлаголЪ правосудия"

    def test_falls_back_to_ocr_when_no_annotation(self):
        from app.modules.sources.cyberleninka import parse_article
        item = dict(SEARCH_ITEM, annotation="")
        s = parse_article(item)
        assert "текст статьи" in s.abstract
        assert "\ufeff" not in s.abstract

    def test_rejects_entry_without_link(self):
        from app.modules.sources.cyberleninka import parse_article
        assert parse_article(dict(SEARCH_ITEM, link="")) is None

    def test_handles_missing_year(self):
        from app.modules.sources.cyberleninka import parse_article
        assert parse_article(dict(SEARCH_ITEM, year=None)).year is None

    def test_unescapes_entities(self):
        from app.modules.sources.cyberleninka import strip_tags
        assert strip_tags("&laquo;&nbsp;X&raquo;").strip() == "« X»".strip()


class TestCyberleninkaSearch:
    def test_returns_sources(self):
        from app.modules.sources.cyberleninka import search
        got = search("субсидиарная", fetcher=cl_fetcher([SEARCH_ITEM]))
        assert len(got) == 1

    def test_network_error_is_silent(self):
        from app.modules.sources.cyberleninka import search

        def boom(url, payload):
            raise OSError("connection reset")

        assert search("x", fetcher=boom) == []

    def test_broken_json_is_silent(self):
        from app.modules.sources.cyberleninka import search
        assert search("x", fetcher=lambda u, p: "<html>502</html>") == []

    def test_unexpected_shape_is_silent(self):
        from app.modules.sources.cyberleninka import search
        assert search("x", fetcher=lambda u, p: '{"articles": "нет"}') == []

    def test_search_many_deduplicates(self):
        from app.modules.sources.cyberleninka import search_many
        got = search_many(["a", "b"], fetcher=cl_fetcher([SEARCH_ITEM]))
        assert len(got) == 1

    def test_filter_by_year_keeps_undated(self):
        from app.modules.sources.cyberleninka import filter_by_year
        items = [src("Старая", year=2010), src("Новая", year=2025),
                 src("Без года", year=None)]
        kept = {s.title for s in filter_by_year(items, 2021)}
        assert kept == {"Новая", "Без года"}


class TestFulltext:
    PAGE = ('<html><body><div class="ocr" itemprop="articleBody">'
            '<div class="ocr-banner"><div id="ad"></div></div>'
            '<p>Аннотация. ' + "Содержательный текст статьи. " * 40 + '</p>'
            '</div></div></body></html>')

    def test_extracts_body(self):
        from app.modules.sources.cyberleninka import extract_fulltext
        text = extract_fulltext(self.PAGE)
        assert "Содержательный текст" in text
        assert "<p>" not in text
        assert "ad" not in text

    def test_missing_block_gives_empty(self):
        from app.modules.sources.cyberleninka import extract_fulltext
        assert extract_fulltext("<html><body>пусто</body></html>") == ""

    def test_short_text_rejected(self):
        from app.modules.sources.cyberleninka import fetch_fulltext
        s = src("X")
        s.url = "https://cyberleninka.ru/article/n/x"
        page = '<div class="ocr" itemprop="articleBody"><p>Коротко</p></div></div>'
        assert fetch_fulltext(s, fetcher=lambda u: page) == ""

    def test_network_error_gives_empty(self):
        from app.modules.sources.cyberleninka import fetch_fulltext
        s = src("X")
        s.url = "https://cyberleninka.ru/article/n/x"

        def boom(url):
            raise OSError("timeout")

        assert fetch_fulltext(s, fetcher=boom) == ""

    def test_enrich_only_touches_cyberleninka(self):
        from app.modules.sources.cyberleninka import enrich_with_fulltext
        a = src("Из OpenAlex", doi="10/1")
        b = src("Из КиберЛенинки")
        b.provider = "cyberleninka"
        b.url = "https://cyberleninka.ru/article/n/b"
        out = asyncio.run(
            enrich_with_fulltext([a, b], fetcher=lambda u: self.PAGE))
        assert not out[0].fulltext
        assert "Содержательный текст" in out[1].fulltext


class TestRegistry:
    def test_merge_prefers_record_with_doi(self):
        from app.modules.sources.registry import merge
        cl = src("Одна и та же статья")
        cl.provider = "cyberleninka"
        cl.doi = None
        cl.fulltext = "полный текст"
        oa = src("Одна и та же статья!", doi="10.1/x")
        got = merge([cl], [oa])
        assert len(got) == 1
        assert got[0].doi == "10.1/x"
        assert got[0].fulltext == "полный текст"

    def test_merge_keeps_distinct(self):
        from app.modules.sources.registry import merge
        got = merge([src("Первая", doi="10/1")], [src("Вторая", doi="10/2")])
        assert len(got) == 2

    def test_rank_puts_relevance_before_year(self):
        from app.modules.sources.registry import rank
        fresh = src("Искусственный интеллект в закупках", year=2026)
        old = src("Субсидиарная ответственность руководителя", year=2019)
        got = rank([fresh, old], "субсидиарная ответственность")
        assert got[0] is old

    def test_one_provider_failing_does_not_break(self, monkeypatch):
        from app.modules.sources import registry

        def boom(*a, **k):
            raise RuntimeError("openalex down")

        monkeypatch.setattr(registry.openalex, "find_sources_for_topic", boom)
        monkeypatch.setattr(
            registry.cyberleninka, "find_sources",
            lambda *a, **k: [src("Субсидиарная ответственность", doi=None)])
        got = asyncio.run(registry.find_sources(
            "субсидиарная ответственность", [], with_fulltext=False))
        assert len(got) == 1

    def test_both_failing_gives_empty(self, monkeypatch):
        from app.modules.sources import registry

        def boom(*a, **k):
            raise RuntimeError("down")

        monkeypatch.setattr(registry.openalex, "find_sources_for_topic", boom)
        monkeypatch.setattr(registry.cyberleninka, "find_sources", boom)
        got = asyncio.run(
            registry.find_sources("тема", [], with_fulltext=False))
        assert got == []


class TestFulltextInPrompt:
    def test_fulltext_labelled_and_longer(self):
        from app.modules.sources.grounding import format_sources_for_prompt
        s = src("Статья", doi="10/1")
        s.fulltext = "Полный текст. " * 300
        out = format_sources_for_prompt([s])
        assert "Фрагмент статьи" in out
        assert "Аннотация" not in out

    def test_abstract_used_when_no_fulltext(self):
        from app.modules.sources.grounding import format_sources_for_prompt
        out = format_sources_for_prompt([src("Статья", doi="10/1")])
        assert "Аннотация" in out
