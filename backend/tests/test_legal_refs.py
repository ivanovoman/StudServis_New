"""Проверка ссылок на статьи кодексов.

Тесты офлайновые: оглавление подставляется вручную. Ходить в сеть на
каждом прогоне нельзя — правовые базы иногда отвечают медленно, и весь
набор тестов становится заложником чужого сервера.

Опорный материал — настоящие ошибки из сгенерированного плана по теме
«Коллизии в праве», где модель уверенно сослалась на ст. 4 ТК РФ как на
коллизионную норму.
"""

from __future__ import annotations

import pytest

from app.modules.sources.legal_refs import (
    CheckResult, Reference, compare, extract)

#: Кусочки настоящих оглавлений.
TK = {
    "4": "Запрещение принудительного труда",
    "5": "Трудовое законодательство и иные акты, содержащие нормы "
         "трудового права",
    "10": "Трудовое законодательство, иные акты, содержащие нормы "
          "трудового права, и нормы международного права",
    "7": "Утратила силу",
}

GK = {
    "6": "Применение гражданского законодательства по аналогии",
    "1102": "Обязанность возвратить неосновательное обогащение",
    "174.1": "Последствия совершения сделки в отношении имущества, "
             "распоряжение которым запрещено или ограничено",
}

SK = {"34": "Совместная собственность супругов"}


# --- извлечение -------------------------------------------------------

def test_extract_simple():
    refs = extract("Согласно ст. 4 ТК РФ труд свободен.")
    assert len(refs) == 1
    assert refs[0].code == "ТК"
    assert refs[0].article == "4"


def test_extract_several_numbers():
    """«ст. ст. 10, 12 ГК РФ» — это две ссылки, а не одна."""
    refs = extract("См. ст. ст. 10, 12 ГК РФ.")
    assert {r.article for r in refs} == {"10", "12"}


def test_extract_decimal_article():
    refs = extract("Применяется ст. 174.1 ГК РФ.")
    assert refs[0].article == "174.1"


def test_extract_full_word():
    refs = extract("Статья 34 СК РФ говорит о собственности супругов.")
    assert refs[0].code == "СК"
    assert refs[0].article == "34"


def test_extract_koap_case():
    """«КоАП» не должен превратиться в «КОАП»."""
    refs = extract("Ответственность по ст. 12 КоАП РФ.")
    assert refs[0].code == "КоАП"


def test_extract_deduplicates():
    refs = extract("ст. 4 ТК РФ ... снова ст. 4 ТК РФ")
    assert len(refs) == 1


def test_extract_nothing():
    assert extract("Обычный текст без ссылок.") == []


# --- сверка -----------------------------------------------------------

def test_real_error_from_generated_plan():
    """Та самая ошибка: ст. 4 ТК выдана за коллизионную норму."""
    refs = extract(
        "Коллизионные нормы-отсылки закреплены в ст. 4 ТК РФ, "
        "определяющей иерархию источников трудового права."
    )
    ref = compare(refs[0], TK)
    assert ref.status == "mismatch"
    assert "Запрещение принудительного труда" in ref.note


def test_correct_reference_passes():
    refs = extract(
        "Иерархия источников трудового права закреплена в ст. 5 ТК РФ."
    )
    assert compare(refs[0], TK).status == "ok"


def test_missing_article():
    refs = extract("См. ст. 9999 ГК РФ.")
    ref = compare(refs[0], GK)
    assert ref.status == "missing"
    assert "нет" in ref.note


def test_repealed_article():
    refs = extract("Согласно ст. 7 ТК РФ применяется правило.")
    ref = compare(refs[0], TK)
    assert ref.status == "mismatch"
    assert "утратила силу" in ref.note


def test_enumeration_is_not_an_error():
    """Перечень статей нельзя судить по соседним словам.

    Раньше эта фраза давала три ложные тревоги подряд.
    """
    text = ("Роль коллизионных норм (ст. 2 ГК РФ, ст. 1 ЖК РФ, "
            "ст. 4 ТК РФ).")
    for ref in extract(text):
        if ref.code == "ТК":
            assert compare(ref, TK).status == "listed"


def test_listed_shows_real_title():
    """У перечисленной статьи всё равно виден настоящий заголовок."""
    text = "Коллизионные нормы (ст. 5 ТК РФ, ст. 4 ТК РФ)."
    results = [compare(r, TK) for r in extract(text)]
    four = [r for r in results if r.article == "4"][0]
    assert four.real_title == "Запрещение принудительного труда"


def test_case_forms_match():
    """«нормы» и «норм» — одно слово, падеж роли не играет."""
    refs = extract(
        "Обязанность возвратить неосновательное обогащение "
        "предусмотрена ст. 1102 ГК РФ."
    )
    assert compare(refs[0], GK).status == "ok"


def test_no_toc_is_not_a_verdict():
    """Если база недоступна, это «не знаю», а не «ошибка»."""
    refs = extract("См. ст. 4 ТК РФ.")
    ref = compare(refs[0], {})
    assert ref.status == "unknown"
    assert ref not in CheckResult(references=[ref]).suspicious


# --- сводка -----------------------------------------------------------

def test_summary_empty():
    assert "не найдено" in CheckResult().summary()


def test_summary_lists_problems():
    bad = Reference(code="ТК", article="4", context="",
                    status="mismatch", note="статья про другое")
    text = CheckResult(references=[bad]).summary()
    assert "ст. 4 ТК РФ" in text
    assert "Не сходится" in text


def test_summary_mentions_enumerated():
    """Перечисленные статьи попадают в сводку с заголовками."""
    listed = Reference(code="ТК", article="4", context="",
                       status="listed",
                       real_title="Запрещение принудительного труда")
    text = CheckResult(references=[listed]).summary()
    assert "Запрещение принудительного труда" in text


def test_suspicious_excludes_listed():
    listed = Reference(code="ТК", article="4", context="", status="listed")
    ok = Reference(code="ТК", article="5", context="", status="ok")
    assert CheckResult(references=[listed, ok]).suspicious == []


@pytest.mark.parametrize("code,toc,article", [
    ("ТК", TK, "5"),
    ("ГК", GK, "6"),
    ("СК", SK, "34"),
])
def test_known_codes_resolve(code, toc, article):
    ref = Reference(code=code, article=article, context="", claim="")
    assert compare(ref, toc).real_title == toc[article]


# --- «не сошлось» против «не удалось сверить» -------------------------
#
# Живой прогон работы «Коллизии в праве» дал 4 красных из 9, и все
# четыре оказались ложными: текст пересказывал статью своими словами, а
# сверка требовала буквального совпадения слов с заголовком. Красный
# цвет обесценивается, если в половине случаев он врёт, поэтому теперь
# обвинение предъявляется, только когда видно, какая статья имелась в
# виду на самом деле.

def test_paraphrase_is_unclear_not_mismatch():
    """Пересказ своими словами — повод посмотреть, а не приговор."""
    refs = extract(
        "Ст. 6 ГК РФ позволяет восполнять отсутствие прямой нормы "
        "сходным регулированием."
    )
    ref = compare(refs[0], GK)
    assert ref.status == "unclear"
    assert "сверьте по смыслу сами" in ref.note


def test_wrong_number_is_named():
    """Если подходит другая статья того же кодекса — называем её номер."""
    toc = dict(GK)
    toc["13"] = ("Признание недействительным акта государственного "
                 "органа или органа местного самоуправления")
    toc["10"] = "Пределы осуществления гражданских прав"
    refs = extract(
        "Ст. 10 ГК РФ о признании недействительным акта "
        "государственного органа применяется судами."
    )
    ref = compare(refs[0], toc)
    assert ref.status == "mismatch"
    assert "ст. 13" in ref.note


def test_repealed_stays_mismatch():
    """«Утратила силу» — всегда ошибка, гадать тут не о чем."""
    refs = extract("Согласно ст. 7 ТК РФ работник вправе требовать.")
    assert compare(refs[0], TK).status == "mismatch"


def test_unclear_separate_from_suspicious():
    """Жёлтое не должно попадать в список красного."""
    unclear = Reference(code="ГК", article="6", context="",
                        status="unclear")
    wrong = Reference(code="ТК", article="7", context="",
                      status="mismatch")
    result = CheckResult(references=[unclear, wrong])
    assert result.unclear == [unclear]
    assert result.suspicious == [wrong]


def test_summary_separates_unclear():
    unclear = Reference(code="ГК", article="6", context="",
                        status="unclear", real_title="Аналогия закона")
    text = CheckResult(references=[unclear]).summary()
    assert "проверьте глазами" in text


# --- федеральные законы (оглавление в проекте) -----------------------

from app.modules.sources.legal_refs import _static_toc  # noqa: E402

IPOTEKA_MODEL = (
    "Закон об ипотеке в ст. 5 прямо перечисляет объекты: земельные участки. "
    "Это правило сбалансировано ст. 54.1 и 61 Закона об ипотеке: если банк "
    "оставляет предмет залога за собой или продает его, но вырученных "
    "средств не хватило, остаток долга прекращается. "
    "Другой пример — ст. 64.2 Закона об ипотеке: при строительстве здания "
    "на бюджетные средства здание находится в ипотеке у субъекта РФ."
)


def test_law_refs_extracted_both_orders():
    refs = [(r.code, r.article) for r in extract(IPOTEKA_MODEL)]
    assert refs == [("ИПОТ", "5"), ("ИПОТ", "54.1"), ("ИПОТ", "61"),
                    ("ИПОТ", "64.2")]
    assert extract(IPOTEKA_MODEL)[0].label == "ст. 5 Закона об ипотеке"


def test_law_ref_with_full_requisites():
    text = ("Статья 5 Федерального закона от 16 июля 1998 г. № 102-ФЗ "
            "«Об ипотеке (залоге недвижимости)» относит к таким объектам")
    assert [r.article for r in extract(text)] == ["5"]


def test_static_toc_loaded():
    toc = _static_toc("ИПОТ")
    assert len(toc) >= 90
    assert toc["21"].startswith("Утратила")


def test_wrong_article_for_shortfall_rule():
    """Остаток долга после реализации — не предмет ст. 54.1."""
    toc = _static_toc("ИПОТ")
    ref = next(r for r in extract(IPOTEKA_MODEL) if r.article == "54.1")
    ref = compare(ref, toc)
    assert ref.status == "mismatch"
    assert "Основания для отказа" in ref.note


def test_law_name_words_do_not_confirm():
    """«ипотеке» из названия закона не подтверждает «Ипотека …» в заголовке."""
    toc = _static_toc("ИПОТ")
    ref = extract("Это установлено ст. 69.1 Закона об ипотеке.")[0]
    assert compare(ref, toc).status in {"listed", "unclear"}


def test_missing_law_article():
    toc = _static_toc("ИПОТ")
    ref = extract("Согласно ст. 99 Закона об ипотеке залог возникает.")[0]
    assert compare(ref, toc).status == "missing"


def test_law_ref_after_code_ref_not_swallowed():
    """«Ст. 342 ГК РФ и ст. 43 Закона об ипотеке» — обе ссылки."""
    refs = [(r.code, r.article) for r in extract(
        "Ст. 342 ГК РФ и ст. 43 Закона об ипотеке допускают это.")]
    assert ("ГК", "342") in refs
    assert ("ИПОТ", "43") in refs
