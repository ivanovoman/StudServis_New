"""Тесты ингестии PDF и профиля стиля."""

import pytest

from app.modules.humanizer.style_profile import analyze_style, compare
from app.modules.rag_service.ingest import (
    Chunk,
    _is_useful_chunk,
    _looks_like_heading,
    chunk_style_articles,
    chunk_thesis,
    clean_pdf_text,
    pack_paragraphs,
)


class TestCleanPdfText:
    def test_removes_reviewer_notes(self):
        """Комментарии рецензента — правки чужого человека, не стиль автора."""
        raw = (
            "Авторские права возникают сразу.\n\n"
            "Добавлено примечание ([РБ1]): Лишние абзацы убрать\n\n"
            "Регистрация не требуется."
        )
        out = clean_pdf_text(raw)
        assert "Добавлено примечание" not in out
        assert "РБ1" not in out
        assert "Авторские права" in out
        assert "Регистрация не требуется" in out

    def test_removes_promo_sentences(self):
        raw = "Право возникает сразу. Патентное бюро Ezybrand окажет услуги. Это важно."
        out = clean_pdf_text(raw)
        assert "Ezybrand" not in out
        assert "Право возникает сразу" in out

    def test_fixes_kerning_breaks(self):
        raw = "После смерти а втор произведения остается автором."
        assert "автор произведения" in clean_pdf_text(raw)

    def test_joins_hyphen_wrap(self):
        raw = "субсидиарная ответствен-\nность контролирующих лиц"
        assert "ответственность" in clean_pdf_text(raw)

    def test_collapse_lines_false_keeps_structure(self):
        raw = "Заголовок статьи\nПервая строка.\nВторая строка."
        kept = clean_pdf_text(raw, collapse_lines=False)
        assert "\n" in kept, "структура строк нужна для поиска заголовков"

    def test_strips_toc_dots(self):
        assert "...." not in clean_pdf_text("ВВЕДЕНИЕ ................ 4")


class TestHeadingDetection:
    def test_accepts_real_heading_after_finished_sentence(self):
        assert _looks_like_heading("Поиск нарушителя", "Это конец абзаца.")

    def test_rejects_line_that_continues_paragraph(self):
        """Ключевая защита: в PDF медианная строка ~64 символа, поэтому
        почти любая строка «короткая». Без проверки предыдущей строки
        детектор давал 275 ложных заголовков."""
        assert not _looks_like_heading(
            "Авторские права делятся на две составляющие", "продолжение строки без точки"
        )

    def test_rejects_sentence_with_period(self):
        assert not _looks_like_heading("Это обычное предложение.", "Конец.")

    def test_rejects_too_long(self):
        long_line = "Очень длинная строка " * 5
        assert not _looks_like_heading(long_line, "Конец.")

    def test_rejects_lowercase_start(self):
        assert not _looks_like_heading("продолжение мысли автора", "Конец.")


class TestUsefulChunk:
    def test_rejects_short(self):
        assert not _is_useful_chunk("Слишком коротко.")

    def test_rejects_promo(self):
        text = (
            "Наши патентные поверенные учтут все требования и подготовят "
            "документы для регистрации товарного знака в Роспатенте. "
        ) * 3
        assert not _is_useful_chunk(text)

    def test_accepts_substantive_text(self):
        text = (
            "Контролирующее должника лицо определено в ст. 61.10 Закона о "
            "банкротстве. Это лицо, имевшее право давать обязательные указания. "
            "Суд оценивает фактическое влияние, а не только формальное владение "
            "долей в уставном капитале общества. Практика идет по этому пути."
        )
        assert _is_useful_chunk(text)


class TestPackParagraphs:
    def test_respects_paragraph_boundaries(self):
        paras = ["А" * 500, "Б" * 500, "В" * 500]
        chunks = pack_paragraphs(paras, target_chars=900, max_chars=1200)
        assert len(chunks) >= 2
        # Абзацы не рвутся посередине.
        for c in chunks:
            assert "А" not in c or c.count("А") in (0, 500)

    def test_splits_giant_paragraph_by_sentences(self):
        giant = " ".join(f"Предложение номер {i}." for i in range(200))
        chunks = pack_paragraphs([giant], target_chars=800, max_chars=1000)
        assert len(chunks) > 1
        assert all(len(c) <= 1200 for c in chunks)

    def test_empty_input(self):
        assert pack_paragraphs([]) == []


class TestChunkThesis:
    @pytest.fixture
    def pages(self):
        return [
            "ВВЕДЕНИЕ\n\n" + ("Актуальность темы обусловлена ростом числа дел. " * 20),
            "ГЛАВА 1. ТЕОРЕТИЧЕСКИЕ ОСНОВЫ\n\n"
            "1.1. Понятие\n\n" + ("Понятие раскрывается через ст. 61.10 Закона. " * 20),
            "Выводы по главе 1\n\n" + ("Институт развивается последовательно. " * 20),
            "ЗАКЛЮЧЕНИЕ\n\n" + ("Проведенное исследование позволило сделать выводы. " * 20),
        ]

    def test_intro_and_conclusion_go_to_examples(self, pages):
        chunks = chunk_thesis(pages)
        kinds = {
            c.metadata["section_type"]
            for c in chunks
            if c.collection == "examples_good"
        }
        assert "introduction" in kinds
        assert "conclusion" in kinds

    def test_body_sections_go_to_style(self, pages):
        chunks = chunk_thesis(pages)
        style = [c for c in chunks if c.collection == "style_kokolov"]
        assert style, "тело глав должно попасть в style_kokolov"

    def test_toc_page_is_skipped(self):
        toc = "СОДЕРЖАНИЕ\nВВЕДЕНИЕ ....... 4\nГЛАВА 1 ....... 9\n1.1 ....... 9\n1.2 ...... 16\n2.1 ...... 20"
        body = "ВВЕДЕНИЕ\n\n" + ("Реальный текст введения здесь. " * 30)
        chunks = chunk_thesis([toc, body])
        assert all("......." not in c.text for c in chunks)

    def test_metadata_carries_topic(self, pages):
        chunks = chunk_thesis(pages, topic="Субсидиарка")
        assert all(c.metadata["topic"] == "Субсидиарка" for c in chunks)


class TestStyleProfile:
    def test_detects_flat_rhythm_as_ai(self):
        """Главный маркер ИИ — ровный ритм."""
        human = (
            "Это короткое. А вот это предложение значительно длиннее и содержит "
            "несколько уточнений, придаточных оборотов и дополнительных деталей, "
            "которые растягивают мысль. Коротко. Затем снова идет развернутое "
            "рассуждение с примерами, ссылками на нормы и обстоятельствами дела. "
            "Все. Практика показывает обратное."
        )
        ai = (
            "Первое предложение содержит ровно столько слов сколько нужно тут. "
            "Второе предложение содержит примерно такое же количество слов вот. "
            "Третье предложение также содержит сопоставимое количество слов да. "
            "Четвертое предложение имеет аналогичную длину и структуру построения."
        )
        assert analyze_style([human]).sentence_len_stdev > analyze_style([ai]).sentence_len_stdev

    def test_counts_legal_references(self):
        p = analyze_style(["Согласно ст. 61.10 Закона № 127-ФЗ, по делу № А40-123/2022."])
        assert p.law_refs_per_1k > 0
        assert p.case_refs_per_1k > 0

    def test_counts_cliches(self):
        p = analyze_style(["Таким образом, следует отметить, что в целом это важно."])
        assert p.cliche_per_1k > 0
        assert "таким образом" in p.cliche_found

    def test_abbreviation_does_not_split_sentence(self):
        """«ст. 61.10» не должно считаться концом предложения."""
        p = analyze_style(["Норма закреплена в ст. 61.10 Закона о банкротстве прямо."])
        assert p.total_sentences == 1

    def test_empty_input_safe(self):
        p = analyze_style([])
        assert p.total_words == 0
        assert p.sentence_len_mean == 0.0


class TestCompare:
    def test_flags_flat_rhythm(self):
        ref = analyze_style([
            "Коротко. А это предложение намного длиннее и содержит развернутое "
            "пояснение с деталями и уточнениями по существу вопроса. Все. "
            "Далее следует еще одно достаточно объемное рассуждение автора."
        ])
        flat = analyze_style([
            "Первое предложение имеет некоторую среднюю длину в словах. "
            "Второе предложение имеет примерно такую же среднюю длину. "
            "Третье предложение имеет также сходную среднюю длину слов."
        ])
        result = compare(ref, flat)
        assert not result["passed"]
        assert any("ритм" in p for p in result["problems"])

    def test_passes_on_similar_text(self):
        text = (
            "Коротко. А это предложение намного длиннее и содержит развернутое "
            "пояснение со ссылкой на ст. 61.10 и обстоятельствами дела № А40-1/2022. "
            "Все. Далее автор приводит еще одно объемное рассуждение по существу."
        )
        p = analyze_style([text])
        assert compare(p, p)["passed"]
