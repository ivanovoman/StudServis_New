"""Тесты критериев готовности (объёмы согласованы с заказчиком)."""

import pytest

from app.modules.ai_engine.acceptance import (
    WorkKind,
    chars_no_spaces,
    check_conclusion,
    check_introduction,
    check_plan,
    check_section,
    check_style,
)


def make_text(chars_target: int, legal: bool = True) -> str:
    """Текст нужного объёма с ЖИВЫМ ритмом и ссылками.

    Длины предложений намеренно разные — иначе фикстура сама не проходит
    проверку ритма (и это правильное поведение детектора: повторяющийся
    блок текста читается как машинный).
    """
    sentences = [
        "Это важно.",
        "Норма закреплена в ст. 61.10 Закона о банкротстве.",
        "Практика идет по этому пути.",
        "Суд оценивает фактическое влияние лица на решения должника, а не "
        "только формальное владение долей в уставном капитале общества, что "
        "прямо подтверждается позицией Пленума и сложившейся практикой "
        "окружных судов по делу № А40-1234/2022.",
        "Вывод очевиден.",
        "Кредиторы получили инструмент защиты, которым активно пользуются.",
        "Бенефициар отвечает лично, если довел организацию до банкротства "
        "своими решениями, а доказательства этого суд оценивает в "
        "совокупности с обстоятельствами конкретного спора.",
        "Так бывает не всегда.",
    ]
    if not legal:
        sentences = [
            s.replace("ст. 61.10 Закона о банкротстве", "методике расчета")
             .replace("по делу № А40-1234/2022", "по данным отчета за 2024 год")
             .replace("позицией Пленума", "данными статистики")
            for s in sentences
        ]
    out, i = "", 0
    while chars_no_spaces(out) < chars_target:
        out += sentences[i % len(sentences)] + " "
        i += 1
    return out


class TestCharsNoSpaces:
    def test_ignores_whitespace(self):
        assert chars_no_spaces("аб вг\nде") == 6

    def test_empty(self):
        assert chars_no_spaces("") == 0


class TestIntroduction:
    def _intro(self, size=4200, hypothesis=False):
        head = (
            "Актуальность темы обусловлена ростом числа дел. "
            "Цель работы состоит в анализе института. "
            "Задачи исследования вытекают из цели. "
            "Объект исследования составляют отношения. "
            "Предмет исследования образуют нормы. "
            "Структура работы включает три главы. "
        )
        if hypothesis:
            head += "Гипотеза исследования состоит в следующем предположении. "
        return head + make_text(size - chars_no_spaces(head))

    def test_valid_coursework_intro(self):
        assert check_introduction(self._intro(), kind=WorkKind.coursework).passed

    def test_too_short_rejected(self):
        r = check_introduction(self._intro(2000))
        assert not r.passed
        assert any("нужно от 3800" in v.message for v in r.violations)

    def test_too_long_rejected(self):
        r = check_introduction(self._intro(6000))
        assert not r.passed
        assert any("не более 5000" in v.message for v in r.violations)

    def test_boundaries_accepted(self):
        assert check_introduction(self._intro(3850)).passed
        assert check_introduction(self._intro(4950)).passed

    def test_missing_elements_flagged(self):
        text = "Актуальность высока. " + make_text(4000)
        r = check_introduction(text)
        assert not r.passed
        msg = r.report()
        assert "цель" in msg and "объект" in msg

    def test_thesis_requires_hypothesis(self):
        r = check_introduction(self._intro(hypothesis=False), kind=WorkKind.thesis)
        assert not r.passed
        assert any("гипотез" in v.message for v in r.violations)

    def test_thesis_with_hypothesis_ok(self):
        """У диссертации свои объёмы: введения автора 9.5 и 10.7 тыс. б/п,
        курсовые 3800-5000 её забраковали бы."""
        assert check_introduction(
            self._intro(9000, hypothesis=True), kind=WorkKind.thesis
        ).passed

    def test_thesis_volumes_differ_from_coursework(self):
        """Курсовое введение слишком короткое для диссертации."""
        r = check_introduction(self._intro(4200, hypothesis=True),
                               kind=WorkKind.thesis)
        assert not r.passed
        assert any(v.rule == "length" for v in r.violations)

    def test_coursework_hypothesis_is_warning_only(self):
        r = check_introduction(self._intro(hypothesis=True), kind=WorkKind.coursework)
        assert r.passed, "лишняя гипотеза в курсовой — замечание, не брак"
        assert any(v.severity == "warning" for v in r.violations)

    def test_leading_heading_rejected(self):
        r = check_introduction("Введение\n" + self._intro())
        assert any(v.rule == "heading" for v in r.violations)


class TestSection:
    def test_valid_section(self):
        assert check_section(make_text(5500)).passed

    def test_too_short(self):
        r = check_section(make_text(3000))
        assert not r.passed
        assert any("нужно от 5000" in v.message for v in r.violations)

    def test_too_long(self):
        r = check_section(make_text(7000))
        assert not r.passed
        assert any("не более 6000" in v.message for v in r.violations)

    def test_missing_law_reference_in_legal_work(self):
        r = check_section(make_text(5500, legal=False), subject_is_legal=True)
        assert not r.passed
        assert any(v.rule == "law_ref" for v in r.violations)

    def test_economics_work_not_required_to_cite_law(self):
        """В экономической работе автора ссылок на нормы 0.04/1k —
        общий порог был бы бессмысленным."""
        r = check_section(make_text(5500, legal=False), subject_is_legal=False)
        assert r.passed

    def test_detects_verbatim_repetition(self):
        prev = make_text(5200)
        r = check_section(prev, previous_texts=[prev])
        assert any(v.rule == "repetition" for v in r.violations)

    def test_leading_section_number_rejected(self):
        r = check_section("1.1. Понятие\n" + make_text(5300))
        assert any(v.rule == "heading" for v in r.violations)


class TestPlan:
    def _plan(self, chapters: int, per_chapter: int = 3) -> str:
        out = []
        for c in range(1, chapters + 1):
            out.append(f"ГЛАВА {c}. Название главы")
            for s in range(1, per_chapter + 1):
                out.append(f"{c}.{s}. Название раздела")
            out.append(f"Выводы по главе {c}")
        return "\n".join(out)

    def test_three_chapters_ok(self):
        assert check_plan(self._plan(3)).passed

    def test_two_chapters_allowed(self):
        """Курсовая из 2 глав допустима, если так в методичке."""
        assert check_plan(self._plan(2)).passed

    def test_four_chapters_rejected(self):
        r = check_plan(self._plan(4))
        assert not r.passed
        assert any("больше, чем нужно" in v.message.lower() for v in r.violations)

    def test_methodichka_override(self):
        assert check_plan(self._plan(2), required_chapters=2).passed
        assert not check_plan(self._plan(3), required_chapters=2).passed

    def test_too_many_sections_warns(self):
        r = check_plan(self._plan(3, per_chapter=7))
        assert any(v.rule == "granularity" for v in r.violations)

    def test_missing_chapter_conclusions_warns(self):
        plan = "ГЛАВА 1. Т\n1.1. А\n1.2. Б\nГЛАВА 2. П\n2.1. В\n2.2. Г"
        r = check_plan(plan)
        assert any(v.rule == "chapter_conclusions" for v in r.violations)


class TestStyleThresholds:
    def test_flat_rhythm_rejected(self):
        flat = " ".join(
            f"Предложение номер {i} содержит ровно столько же слов сколько нужно."
            for i in range(40)
        )
        r = check_style(flat)
        assert not r.passed
        assert any(v.rule == "rhythm" for v in r.violations)

    def test_author_level_cliche_allowed(self):
        """Автор сам пишет «таким образом» — порог не ноль."""
        text = make_text(5000) + " Таким образом, вывод очевиден. "
        assert check_style(text).passed

    def test_excessive_cliche_rejected(self):
        text = ("Таким образом, следует отметить, что в целом это важно. "
                "По сути, безусловно, очевидно, необходимо учитывать это. ") * 8
        r = check_style(text)
        assert any(v.rule == "cliche" for v in r.violations)


class TestConclusion:
    def test_valid(self):
        assert check_conclusion(make_text(3500)).passed

    def test_leading_heading_rejected(self):
        r = check_conclusion("Заключение\n" + make_text(3500))
        assert any(v.rule == "heading" for v in r.violations)


class TestCalibrationAgainstAuthor:
    """Пороги обязаны пропускать тексты самого автора.

    Порог, который бракует эталон, — неверный порог. Эти тесты
    ловят регресс калибровки.
    """

    def test_author_cliche_level_passes(self):
        """Медиана клише по разделам автора 1.87, p75 = 2.92."""
        from app.modules.ai_engine.acceptance import (
            MAX_CLICHE_PER_1K,
            WARN_CLICHE_PER_1K,
        )
        assert MAX_CLICHE_PER_1K >= 3.5, "порог ниже p75 автора забракует эталон"
        assert WARN_CLICHE_PER_1K < MAX_CLICHE_PER_1K

    def test_rhythm_threshold_below_author_p10(self):
        """У автора есть разделы с разбросом 7.5-9.0."""
        from app.modules.ai_engine.acceptance import MIN_SENTENCE_STDEV
        assert MIN_SENTENCE_STDEV <= 8.7, "порог выше p10 автора забракует эталон"

    def test_machine_flat_text_still_caught(self):
        """Калибровка не должна сделать детектор слепым."""
        flat = " ".join(
            f"Данное обстоятельство имеет существенное значение в случае {i}."
            for i in range(40)
        )
        assert not check_style(flat).passed
