"""Тесты поиска источников и анализа с опорой на них.

Сеть в тестах не используется: OpenAlex подменяется фикстурой.
"""

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
        import app.modules.sources.grounding as gmod
        monkeypatch.setattr(rmod, "get_router", lambda: R())
        monkeypatch.setattr(gmod, "find_sources_for_topic",
                            lambda *a, **k: sources)

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
        import app.modules.sources.grounding as gmod
        monkeypatch.setattr(gmod, "find_sources_for_topic", lambda *a, **k: [])

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
