"""Тесты этапа 1 — анализ темы."""

import json

import pytest

from app.modules.ai_engine.topic_analysis import (
    MAX_THESES,
    MIN_THESES,
    SYSTEM_PROMPT,
    TopicAnalysis,
    build_user_prompt,
    check_analysis,
    extract_json,
    parse_analysis,
)
from app.modules.projects.preferences import Subject, WorkPreferences


def good_analysis(**over) -> TopicAnalysis:
    base = dict(
        core="Работа исследует основания привлечения контролирующих лиц "
             "к ответственности по долгам компании",
        theses=[
            "Контроль определяется фактическим влиянием, а не долей в капитале",
            "Презумпции вины смещают бремя доказывания на контролирующее лицо",
            "Практика судов расходится в оценке номинальных руководителей",
            "Размер ответственности привязан к непогашенным требованиям кредиторов",
        ],
        logic_arc=[
            "Сначала разобрать понятие контролирующего лица",
            "Затем основания и презумпции",
            "В конце проблемы правоприменения",
        ],
        controversies=["Суды по-разному оценивают роль номинального директора"],
        banality_risks=[
            "Пересказ норм закона без анализа практики",
            "Общие слова о защите кредиторов без конкретики",
        ],
        search_directions=[
            "Нормы о контролирующих лицах в законе о банкротстве",
            "Разъяснения Пленума по субсидиарной ответственности",
            "Практика окружных судов за последние три года",
            "Доктринальные статьи о природе ответственности",
            "Зарубежный опыт piercing the corporate veil",
        ],
    )
    base.update(over)
    return TopicAnalysis(**base)


class TestExtractJson:
    def test_plain_json(self):
        assert extract_json('{"a": 1}')["a"] == 1

    def test_fenced_json(self):
        assert extract_json('```json\n{"a": 2}\n```')["a"] == 2

    def test_json_with_prose_around(self):
        raw = 'Вот результат анализа:\n{"a": 3}\nНадеюсь, помог!'
        assert extract_json(raw)["a"] == 3

    def test_braces_inside_strings(self):
        raw = '{"core": "текст со скобкой } внутри", "n": 1}'
        assert extract_json(raw)["n"] == 1

    def test_escaped_quotes(self):
        raw = '{"core": "он сказал \\"да\\" и ушёл"}'
        assert "да" in extract_json(raw)["core"]

    def test_empty_raises(self):
        with pytest.raises(ValueError):
            extract_json("")

    def test_no_json_raises(self):
        with pytest.raises(ValueError):
            extract_json("просто текст без объекта")

    def test_unclosed_raises(self):
        with pytest.raises(ValueError):
            extract_json('{"a": 1')


class TestParse:
    def test_parses_full(self):
        a = parse_analysis(json.dumps(good_analysis().to_dict()))
        assert len(a.theses) == 4
        assert a.core

    def test_string_instead_of_list_tolerated(self):
        raw = json.dumps({"core": "ядро", "theses": "единственный тезис"})
        assert parse_analysis(raw).theses == ["единственный тезис"]

    def test_missing_keys_default_empty(self):
        a = parse_analysis('{"core": "только ядро"}')
        assert a.theses == [] and a.search_directions == []

    def test_strips_blank_entries(self):
        raw = json.dumps({"theses": ["норм", "  ", ""]})
        assert parse_analysis(raw).theses == ["норм"]


class TestCheck:
    def test_good_analysis_passes(self):
        assert check_analysis(good_analysis()).passed

    def test_missing_core_fails(self):
        assert not check_analysis(good_analysis(core="")).passed

    def test_too_few_theses_fails(self):
        r = check_analysis(good_analysis(theses=["один содержательный тезис тут"]))
        assert not r.passed
        assert any(i.rule == "theses" for i in r.issues)

    def test_headings_instead_of_theses_flagged(self):
        r = check_analysis(good_analysis(theses=[
            "Понятие контроля", "Основания", "Практика", "Проблемы",
        ]))
        assert not r.passed
        assert any("заголовки" in i.message for i in r.issues)

    def test_too_many_theses_is_warning(self):
        many = [f"Содержательный тезис номер {i} про институт" for i in range(9)]
        r = check_analysis(good_analysis(theses=many))
        assert r.passed
        assert any(i.severity == "warning" for i in r.issues)

    def test_few_search_directions_fails(self):
        r = check_analysis(good_analysis(search_directions=["одно", "два"]))
        assert not r.passed

    def test_duplicate_theses_flagged(self):
        t = good_analysis().theses
        r = check_analysis(good_analysis(theses=t + [t[0]]))
        assert any("повторя" in i.message for i in r.issues)

    def test_no_banality_risks_is_warning(self):
        r = check_analysis(good_analysis(banality_risks=[]))
        assert r.passed
        assert any(i.rule == "banality_risks" for i in r.issues)


class TestFabricationGuard:
    """Главная защита этапа: модель не должна называть непроверенные реквизиты.

    Живая проверка показала, что LLM уверенно выдумывает и номера дел,
    и номера статей — «ст. 61.2» вместо 61.10, дело №А40-15002/2019
    с несуществующими фирмами.
    """

    def test_case_number_rejected(self):
        r = check_analysis(good_analysis(
            controversies=["Спор решён в деле № А40-1234/2022"]))
        assert not r.passed
        assert any(i.rule == "fabrication" for i in r.issues)

    def test_article_number_rejected(self):
        r = check_analysis(good_analysis(
            theses=good_analysis().theses + ["Ответственность закреплена в ст. 61.10"]))
        assert not r.passed

    def test_federal_law_number_rejected(self):
        r = check_analysis(good_analysis(
            core="Работа о банкротстве по № 127-ФЗ и его применении судами"))
        assert not r.passed

    def test_money_amount_rejected(self):
        r = check_analysis(good_analysis(
            controversies=["Взыскано 5 092 000 руб. с директора"]))
        assert not r.passed

    def test_descriptive_reference_allowed(self):
        """Описание того, что искать, — норма."""
        assert check_analysis(good_analysis(search_directions=[
            "Нормы о контролирующих лицах в законе о банкротстве",
            "Практика окружных судов за последние три года",
            "Разъяснения Пленума Верховного Суда",
            "Доктрина о природе субсидиарной ответственности",
            "Зарубежные подходы к снятию корпоративной вуали",
        ])).passed

    def test_code_names_allowed(self):
        assert check_analysis(good_analysis(
            core="Работа исследует нормы ГК РФ о недействительности сделок")).passed


class TestPrompt:
    def test_system_prompt_forbids_fabrication(self):
        assert "Не называй конкретные номера" in SYSTEM_PROMPT
        assert "JSON" in SYSTEM_PROMPT

    def test_legal_prompt_mentions_practice(self):
        p = build_user_prompt("Тема", WorkPreferences(subject=Subject.legal))
        assert "судебную практику" in p

    def test_economics_prompt_does_not_force_law(self):
        p = build_user_prompt("Тема", WorkPreferences(subject=Subject.economics))
        assert "не навязывай" in p

    def test_prompt_carries_thesis_range(self):
        p = build_user_prompt("Тема", WorkPreferences(theses_per_section=(6, 12)))
        assert "6-12" in p

    def test_prompt_carries_chapters(self):
        p = build_user_prompt("Тема", WorkPreferences(chapters=2))
        assert "2" in p


class TestAnalyzeTopicAPI:
    @pytest.fixture
    def client(self):
        from fastapi.testclient import TestClient
        from app.main import app
        return TestClient(app)

    @pytest.fixture
    def fake_router(self, monkeypatch):
        """Подменяем модель — тесты не должны ходить в сеть."""
        payload = json.dumps(good_analysis().to_dict())

        class FakeRouter:
            async def stream(self, messages):
                yield payload

        import app.modules.ai_engine.topic_analysis as mod
        monkeypatch.setattr(mod, "get_router", lambda: FakeRouter(), raising=False)
        import app.modules.ai_engine.router as rmod
        monkeypatch.setattr(rmod, "get_router", lambda: FakeRouter())
        return FakeRouter()

    def test_returns_analysis_and_check(self, client, fake_router):
        r = client.post("/api/v1/ai/analyze-topic",
                        json={"topic": "Субсидиарная ответственность"})
        assert r.status_code == 200
        b = r.json()
        assert b["check"]["passed"]
        assert len(b["analysis"]["theses"]) >= MIN_THESES

    def test_short_topic_rejected(self, client):
        r = client.post("/api/v1/ai/analyze-topic", json={"topic": "abc"})
        assert r.status_code == 422

    def test_bad_model_output_returns_502(self, client, monkeypatch):
        class BadRouter:
            async def stream(self, messages):
                yield "извините, не могу"

        import app.modules.ai_engine.router as rmod
        monkeypatch.setattr(rmod, "get_router", lambda: BadRouter())
        r = client.post("/api/v1/ai/analyze-topic",
                        json={"topic": "Нормальная тема работы"})
        assert r.status_code == 502

    def test_failed_check_still_returns_analysis(self, client, monkeypatch):
        bad = json.dumps({
            "core": "Тема про ответственность по делу № А40-1234/2022",
            "theses": ["Содержательный тезис про институт ответственности"],
            "logic_arc": ["сначала одно", "потом другое"],
            "search_directions": ["раз", "два", "три", "четыре", "пять"],
        })

        class Router:
            async def stream(self, messages):
                yield bad

        import app.modules.ai_engine.router as rmod
        monkeypatch.setattr(rmod, "get_router", lambda: Router())
        r = client.post("/api/v1/ai/analyze-topic",
                        json={"topic": "Нормальная тема работы"})
        assert r.status_code == 200
        b = r.json()
        assert not b["check"]["passed"]
        assert b["analysis"]["core"]
        assert any(i["rule"] == "fabrication" for i in b["check"]["issues"])
