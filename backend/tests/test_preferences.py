"""Тесты предварительных настроек работы.

Отдельный класс `TestUserDecisions` фиксирует ответы заказчика как
исполняемые требования: если кто-то потом поменяет поведение, тест
упадёт и напомнит, что решение было принято сознательно.
"""

import pytest

from app.modules.ai_engine.acceptance import (
    check_conclusion,
    check_plan,
    check_section,
    check_section_plan,
    check_style,
)
from app.modules.projects.preferences import (
    PRESETS,
    THESIS_VOLUMES,
    Requirement,
    Subject,
    VolumeLimits,
    WorkKind,
    WorkPreferences,
)
from tests.test_acceptance import make_text


def _strip_cases(text: str) -> str:
    """Убирает все маркеры судебной практики (не только номер дела)."""
    return (text.replace("по делу № А40-1234/2022", "в обзоре")
                .replace("позицией Пленума", "доктриной")
                .replace("Пленума", "доктрины"))


class TestDefaults:
    def test_defaults_are_coursework_legal(self):
        p = WorkPreferences()
        assert p.kind is WorkKind.coursework
        assert p.subject is Subject.legal
        assert not p.needs_hypothesis

    def test_default_volumes_are_coursework(self):
        v = WorkPreferences().resolved_volumes()
        assert (v.intro_min, v.intro_max) == (3800, 5000)
        assert (v.section_min, v.section_max) == (5000, 6000)

    def test_thesis_gets_larger_volumes(self):
        v = WorkPreferences(kind=WorkKind.thesis).resolved_volumes()
        assert v.intro_min > 5000
        assert v == THESIS_VOLUMES

    def test_explicit_volumes_win(self):
        custom = VolumeLimits(intro_min=100, intro_max=200)
        p = WorkPreferences(kind=WorkKind.thesis, volumes=custom)
        assert p.resolved_volumes() is custom


class TestValidation:
    def test_rejects_inverted_thesis_range(self):
        with pytest.raises(ValueError):
            WorkPreferences(theses_per_section=(9, 3))

    def test_rejects_absurd_chapter_count(self):
        with pytest.raises(ValueError):
            WorkPreferences(chapters=42)

    def test_accepts_string_enums_from_json(self):
        p = WorkPreferences.from_dict({
            "kind": "thesis", "subject": "economics", "cases": "forbidden",
        })
        assert p.kind is WorkKind.thesis
        assert p.cases is Requirement.forbidden

    def test_roundtrip(self):
        p = PRESETS["thesis_legal"]
        assert WorkPreferences.from_dict(p.to_dict()).to_dict() == p.to_dict()

    def test_ignores_unknown_keys(self):
        p = WorkPreferences.from_dict({"kind": "coursework", "hacker": 1})
        assert p.kind is WorkKind.coursework


class TestUserDecisions:
    """Ответы заказчика, зафиксированные как требования."""

    def test_cliche_threshold_is_author_level_not_zero(self):
        """«Да — порог не выше авторского»."""
        assert WorkPreferences().cliche_policy == "author_level"
        text = make_text(5000) + " Таким образом, вывод очевиден. "
        assert check_style(text).passed

    def test_strict_cliche_is_opt_in(self):
        """Жёсткий ноль доступен, но только если его явно попросят."""
        strict = WorkPreferences(cliche_policy="strict")
        text = make_text(5000) + (" Таким образом, следует отметить это. " * 6)
        assert not check_style(text, prefs=strict).passed

    def test_theses_count_depends_on_topic(self):
        """«Зависит от темы» — диапазон, а не фиксированное число."""
        simple = WorkPreferences(theses_per_section=(3, 5))
        complex_ = WorkPreferences(theses_per_section=(6, 12))
        eight = [f"Тезис номер {i} с содержательным раскрытием" for i in range(8)]
        # Перебор пунктов — предупреждение (укрупнить), а не брак:
        # решение о дроблении за автором темы.
        assert any(v.rule == "theses"
                   for v in check_section_plan(eight, prefs=simple).violations)
        assert check_section_plan(eight, prefs=complex_).violations == []

        # А вот нехватка пунктов для сложной темы — именно брак.
        three = eight[:3]
        assert not check_section_plan(three, prefs=complex_).passed

    def test_two_or_three_chapters(self):
        """«2 или 3»."""
        assert WorkPreferences().allowed_chapter_counts == (2, 3)

        def plan(n):
            out = []
            for c in range(1, n + 1):
                out += [f"ГЛАВА {c}. Название", f"{c}.1. Раздел",
                        f"{c}.2. Раздел", f"Выводы по главе {c}"]
            return "\n".join(out)

        assert check_plan(plan(2)).passed
        assert check_plan(plan(3)).passed
        assert not check_plan(plan(4)).passed

    def test_cases_optional_by_default(self):
        """«Кейсы могут быть, а могут и не быть — в зависимости от темы»."""
        assert WorkPreferences().cases is Requirement.when_relevant
        no_cases = _strip_cases(make_text(5500))
        assert check_section(no_cases).passed

    def test_cases_enforced_when_requested(self):
        p = WorkPreferences(cases=Requirement.required, min_cases_per_section=2)
        no_cases = _strip_cases(make_text(5500))
        r = check_section(no_cases, prefs=p)
        assert not r.passed
        assert any(v.rule == "case_ref" for v in r.violations)

    def test_tables_are_optional_not_mandatory(self):
        """«Таблица там, где она уместна»."""
        assert WorkPreferences().tables is Requirement.when_relevant
        assert check_section(make_text(5500)).passed

    def test_empty_table_rejected(self):
        """«Пустые таблицы не нужны — то есть без смысла»."""
        body = make_text(5200)
        empty = body + "\n\nТаблица 1 — Данные\n| Показатель | Значение |\n|---|---|\n"
        r = check_section(empty)
        assert not r.passed
        assert any(v.rule == "empty_table" for v in r.violations)

    def test_meaningful_table_accepted(self):
        body = make_text(5200)
        good = body + (
            "\n\nТаблица 1 — Практика судов\n"
            "| Округ | Дел | Удовлетворено |\n|---|---|---|\n"
            "| Московский | 120 | 45 |\n"
            "| Уральский | 80 | 30 |\n"
            "| Северо-Западный | 95 | 41 |\n"
        )
        assert check_section(good).passed

    def test_law_proposals_expected_in_legal_work(self):
        """«Если работа юридическая — желательны»."""
        assert WorkPreferences().expects_law_proposals
        assert not WorkPreferences(subject=Subject.economics).expects_law_proposals

    def test_law_proposals_must_be_justified(self):
        """«Но они должны быть обоснованы»."""
        text = make_text(3500) + " Предлагается дополнить статью 61.10 Закона. "
        r = check_conclusion(text)
        assert any(
            v.rule == "law_proposals" and "не обоснован" in v.message
            for v in r.violations
        ), r.report()

    def test_justified_proposal_accepted(self):
        text = (
            make_text(3400)
            + " Предлагается дополнить ст. 61.10 Закона о банкротстве, "
            "поскольку существующая редакция создаёт правовую "
            "неопределённость при оценке фактического контроля. "
        )
        assert check_conclusion(text).passed, check_conclusion(text).report()

    def test_economics_work_not_asked_for_proposals(self):
        p = WorkPreferences(subject=Subject.economics)
        assert check_conclusion(make_text(3500), prefs=p).passed


class TestPresets:
    @pytest.mark.parametrize("name", list(PRESETS))
    def test_presets_valid(self, name):
        assert PRESETS[name].summary()

    def test_economics_preset_drops_legal_requirements(self):
        p = PRESETS["coursework_economics"]
        assert p.cases is Requirement.forbidden
        assert not p.expects_law_proposals

    def test_thesis_preset_requires_hypothesis_and_cases(self):
        p = PRESETS["thesis_legal"]
        assert p.needs_hypothesis
        assert p.cases is Requirement.required
        assert p.allowed_chapter_counts == (3,)


class TestSummary:
    def test_summary_mentions_key_choices(self):
        s = WorkPreferences().summary()
        assert "3800" in s and "5000" in s
        assert "без гипотезы" in s
        assert "где уместно" in s

    def test_thesis_summary_mentions_hypothesis(self):
        assert "с гипотезой" in WorkPreferences(kind=WorkKind.thesis).summary()


class TestPreferencesAPI:
    """Настройки должны быть доступны фронтенду."""

    @pytest.fixture
    def client(self):
        from fastapi.testclient import TestClient
        from app.main import app
        return TestClient(app)

    def test_schema_lists_requirement_options(self, client):
        r = client.get("/api/v1/projects/preferences/schema")
        assert r.status_code == 200
        data = r.json()
        values = {o["value"] for o in data["requirement_options"]}
        assert values == {"required", "when_relevant", "forbidden"}
        assert "coursework_legal" in data["presets"]

    def test_validate_returns_summary(self, client):
        r = client.post("/api/v1/projects/preferences/validate",
                        json={"kind": "coursework", "subject": "legal"})
        assert r.status_code == 200
        body = r.json()
        assert body["resolved"]["volumes"]["intro"] == [3800, 5000]
        assert body["resolved"]["chapters_allowed"] == [2, 3]
        assert not body["resolved"]["needs_hypothesis"]

    def test_thesis_switches_volumes_and_hypothesis(self, client):
        r = client.post("/api/v1/projects/preferences/validate",
                        json={"kind": "thesis", "subject": "legal"})
        body = r.json()
        assert body["resolved"]["needs_hypothesis"]
        assert body["resolved"]["volumes"]["intro"][0] > 5000

    def test_invalid_chapters_rejected(self, client):
        r = client.post("/api/v1/projects/preferences/validate",
                        json={"chapters": 42})
        assert r.status_code == 422

    def test_preset_endpoint(self, client):
        r = client.get("/api/v1/projects/preferences/preset/coursework_economics")
        assert r.status_code == 200
        assert r.json()["preferences"]["cases"] == "forbidden"

    def test_unknown_preset_404(self, client):
        r = client.get("/api/v1/projects/preferences/preset/nope")
        assert r.status_code == 404


class TestVisualsFalsePositives:
    """Проверка пустых таблиц не должна срабатывать на тексте из PDF."""

    def test_caption_without_markdown_not_flagged(self):
        """В тексте из PDF разметка потеряна — одна подпись «Таблица 1»
        не означает, что таблица пустая."""
        body = make_text(5300) + "\n\nТаблица 1 — Динамика поступлений\n"
        r = check_section(body)
        assert not any(v.rule == "empty_table" for v in r.violations), r.report()

    def test_real_empty_markdown_table_still_flagged(self):
        body = make_text(5200) + "\n\n| Показатель | Значение |\n|---|---|\n"
        assert any(v.rule == "empty_table"
                   for v in check_section(body).violations)


class TestLiveliness:
    """Живость уместна и в научном тексте (правка заказчика).

    Замеры: доля коротких предложений в диссертациях автора 14%
    (медиана), в статьях 31%. Живость там уже есть, вопрос дозировки.
    """

    def test_default_is_normal(self):
        assert WorkPreferences().liveliness == "normal"

    def test_thresholds_match_author(self):
        from app.modules.ai_engine.acceptance import (
            MIN_SHORT_SENTENCE_SHARE,
            TARGET_SHORT_SENTENCE_SHARE,
        )
        # p25 и медиана по 30 разделам автора.
        assert MIN_SHORT_SENTENCE_SHARE == pytest.approx(0.08, abs=0.01)
        assert TARGET_SHORT_SENTENCE_SHARE == pytest.approx(0.14, abs=0.01)
        assert MIN_SHORT_SENTENCE_SHARE < TARGET_SHORT_SENTENCE_SHARE

    def _monotone(self) -> str:
        """Текст без единого короткого предложения."""
        return " ".join(
            "Данное обстоятельство имеет существенное значение для "
            f"правоприменительной практики в рассматриваемом случае номер {i}."
            for i in range(30)
        )

    def test_dead_text_flagged(self):
        r = check_style(self._monotone())
        assert any(v.rule == "short_sentences" for v in r.violations)

    def test_high_liveliness_makes_it_an_error(self):
        p = WorkPreferences(liveliness="high")
        r = check_style(self._monotone(), prefs=p)
        assert not r.passed
        assert any(v.rule == "short_sentences" and v.severity == "error"
                   for v in r.violations)

    def test_high_liveliness_nudges_toward_target(self):
        """Текст живой, но ниже медианы автора — подсказка, не брак."""
        text = make_text(5200)
        p = WorkPreferences(liveliness="high")
        r = check_style(text, prefs=p)
        assert r.passed or all(v.severity == "warning" for v in r.violations)

    def test_summary_mentions_liveliness(self):
        assert "живость" in WorkPreferences().summary().lower()
        assert "повышенная" in WorkPreferences(liveliness="high").summary().lower()


class TestMethodichka:
    """Настройки из методички вуза."""

    SAMPLE = """
    МЕТОДИЧЕСКИЕ УКАЗАНИЯ по выполнению курсовой работы
    для студентов юридического факультета.
    Курсовая работа должна состоять из двух глав.
    Общий объём работы 30-35 страниц машинописного текста.
    После каждой главы приводятся выводы по главе.
    Обязательно использование судебной практики Верховного Суда РФ.
    """

    def test_extracts_chapters(self):
        from app.modules.projects.methodichka import parse_methodichka
        r = parse_methodichka(self.SAMPLE)
        assert r.as_overrides()["chapters"] == 2

    def test_extracts_kind_and_subject(self):
        from app.modules.projects.methodichka import parse_methodichka
        o = parse_methodichka(self.SAMPLE).as_overrides()
        assert o["kind"] == "coursework"
        assert o["subject"] == "legal"

    def test_extracts_cases_requirement(self):
        from app.modules.projects.methodichka import parse_methodichka
        assert parse_methodichka(self.SAMPLE).as_overrides()["cases"] == "required"

    def test_every_finding_has_a_quote(self):
        """Пользователь должен видеть, откуда взялось значение."""
        from app.modules.projects.methodichka import parse_methodichka
        r = parse_methodichka(self.SAMPLE)
        assert r.findings
        assert all(f.quote.strip() for f in r.findings)

    def test_pages_converted_to_chars(self):
        from app.modules.projects.methodichka import pages_to_chars_no_spaces
        # страница ГОСТ ~1800 знаков с пробелами -> ~1578 без
        assert 1400 < pages_to_chars_no_spaces(1) < 1700

    def test_empty_input_safe(self):
        from app.modules.projects.methodichka import parse_methodichka
        assert parse_methodichka("").findings == []

    def test_garbage_input_does_not_crash(self):
        from app.modules.projects.methodichka import parse_methodichka
        parse_methodichka("рыба текст без требований ¯\\_(ツ)_/¯")


class TestWishes:
    """Свободные пожелания клиента."""

    def test_more_practice(self):
        from app.modules.projects.methodichka import parse_wishes
        assert parse_wishes("хочу побольше практики").as_overrides()["cases"] == "required"

    def test_no_water_boosts_liveliness(self):
        from app.modules.projects.methodichka import parse_wishes
        o = parse_wishes("только без воды, пожалуйста").as_overrides()
        assert o["liveliness"] == "high"

    def test_strict_style_keeps_normal(self):
        from app.modules.projects.methodichka import parse_wishes
        o = parse_wishes("нужен строго научный стиль").as_overrides()
        assert o["liveliness"] == "normal"

    def test_no_tables(self):
        from app.modules.projects.methodichka import parse_wishes
        assert parse_wishes("без таблиц").as_overrides()["tables"] == "forbidden"


class TestPriorityOrder:
    """Приоритет: умолчания < пресет < методичка < пожелания < явный выбор."""

    def test_methodichka_beats_preset(self):
        from app.modules.projects.methodichka import build_preferences
        prefs, _, _ = build_preferences(
            base=PRESETS["thesis_legal"],          # там chapters=3
            methodichka_text="Работа должна состоять из двух глав.",
        )
        assert prefs.chapters == 2

    def test_explicit_beats_methodichka(self):
        """Явный выбор пользователя нельзя молча переписывать."""
        from app.modules.projects.methodichka import build_preferences
        prefs, _, _ = build_preferences(
            methodichka_text="Работа должна состоять из двух глав.",
            explicit={"chapters": 3},
        )
        assert prefs.chapters == 3

    def test_wishes_beat_methodichka(self):
        from app.modules.projects.methodichka import build_preferences
        prefs, _, _ = build_preferences(
            methodichka_text="Обязательно использование судебной практики.",
            wishes_text="без судебной практики",
        )
        assert prefs.cases is Requirement.forbidden

    def test_hypothesis_in_methodichka_implies_thesis(self):
        from app.modules.projects.methodichka import build_preferences
        prefs, _, _ = build_preferences(
            methodichka_text="Автор должен сформулировать гипотезу исследования.",
        )
        assert prefs.needs_hypothesis


class TestSetupAPI:
    @pytest.fixture
    def client(self):
        from fastapi.testclient import TestClient
        from app.main import app
        return TestClient(app)

    def test_setup_returns_justifications(self, client):
        r = client.post("/api/v1/projects/setup", json={
            "methodichka_text": "Курсовая работа состоит из двух глав. "
                                "Обязательно использование судебной практики.",
            "wishes_text": "побольше таблиц",
        })
        assert r.status_code == 200
        b = r.json()
        assert b["preferences"]["chapters"] == 2
        assert b["preferences"]["tables"] == "required"
        assert b["needs_confirmation"]
        assert all("quote" in f for f in b["from_methodichka"])

    def test_setup_without_input_uses_defaults(self, client):
        r = client.post("/api/v1/projects/setup", json={})
        assert r.status_code == 200
        assert not r.json()["needs_confirmation"]

    def test_unknown_preset_404(self, client):
        r = client.post("/api/v1/projects/setup", json={"preset": "nope"})
        assert r.status_code == 404
