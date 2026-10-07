"""Извлечение фактуры из юридического текста.

Повторяет правила из ``api/facts.js``. Дублирование здесь осознанное:
сторож переписи живёт в Node, а сбор досье по добытым статьям — в
Python, и тянуть одно через другое по сети ради десятка регулярных
выражений дороже, чем держать две копии под общими проверками.

Чему научил опыт с версией на JavaScript:

* ссылка на норму встречается и сокращением («ст. 15»), и словом («в
  статье 15 Конституции») — ловить надо обе записи, иначе половина
  фактуры проходит мимо;
* записи надо приводить к одному виду, иначе «ст. 105» и «статьёй
  105» считаются разными фактами.
"""

from __future__ import annotations

import re

# Единицы текста нормы: сокращение и слово во всех падежах.
_UNITS: list[tuple[str, str, str]] = [
    ("ст", r"стать(?:я|и|е|ю|ёй|ей)", "ст"),
    ("п", r"пункт(?:а|у|ом|е|ы|ов)?", "п"),
    ("ч", r"част(?:ь|и|ью|ей)", "ч"),
    ("абз", r"абзац(?:а|у|ем|е)?", "абз"),
    ("гл", r"глав(?:а|ы|е|у|ой)", "гл"),
]

_UNIT_RE = re.compile(
    "(?:" + "|".join(rf"{short}\.|{words}" for short, words, _ in _UNITS) + r")"
    r"\s*(\d+(?:\.\d+)?)",
    re.IGNORECASE,
)

_CODES_RE = re.compile(
    r"(?<![А-Яа-яЁёA-Za-z])(?:ГК|УК|ТК|КоАП|ГПК|АПК|УПК|НК|СК|ЖК|БК|ЗК)\s*РФ"
    r"|Конституци(?:я|и|ей|ю)\s+(?:РФ|Российской\s+Федерации)",
    re.IGNORECASE,
)

_NUMBER_RE = re.compile(r"№\s*\d+[-–]?[А-ЯA-Zа-яa-z]*")

_YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")

# Фамилия с инициалами — два написания, двумя отдельными выражениями.
#
# Одним общим выражением не выходит: в «Профессор А. Ф. Черданцев»
# первая половина съедает «Профессор А. Ф.», это сочетание
# отбрасывается как звание, и настоящая фамилия остаётся непрочитанной.
# Два прохода по одному и тому же тексту дают обе пары.
_NAME_AFTER = re.compile(
    r"(?<![А-Яа-яЁё])([А-ЯЁ][а-яё]{2,})\s+([А-ЯЁ]\.\s*[А-ЯЁ]\.)"
)
_NAME_BEFORE = re.compile(
    r"([А-ЯЁ]\.\s*[А-ЯЁ]\.)\s+([А-ЯЁ][а-яё]{2,})"
)


def _normalize_unit(head: str, number: str) -> str:
    low = head.lower()
    for short, words, out in _UNITS:
        if low.startswith(short + ".") or re.match(words, low, re.IGNORECASE):
            return f"{out}. {number}"
    return f"{low} {number}"


def _normalize_code(raw: str) -> str:
    text = re.sub(r"\s+", " ", raw).strip()
    if text.lower().startswith("конституци"):
        return "Конституция РФ"
    return text.upper()


def extract_facts(text: str) -> set[str]:
    """Набор единиц фактуры, приведённых к одному виду."""
    out: set[str] = set()
    if not text:
        return out

    for match in _UNIT_RE.finditer(text):
        out.add(_normalize_unit(match.group(0), match.group(1)))
    for match in _CODES_RE.finditer(text):
        out.add(_normalize_code(match.group(0)))
    for match in _NUMBER_RE.finditer(text):
        out.add(re.sub(r"№\s*", "№", match.group(0)))
    for match in _YEAR_RE.finditer(text):
        out.add(match.group(0))

    return out


# Названия кодексов и Конституции — тем же перечнем, что и выше, но
# без границы слова слева: здесь он идёт хвостом связки.
_ACT_TAIL = (r"(?:ГК|УК|ТК|КоАП|ГПК|АПК|УПК|НК|СК|ЖК|БК|ЗК)\s*РФ"
             r"|Конституци(?:я|и|ей|ю)\s+(?:РФ|Российской\s+Федерации)"
             r"|№\s*\d+[-–]\s*ФЗ")

# Связка «единица текста + акт». Между ними допускается немного слов
# («ст. 15 Конституции РФ», «ч. 1 ст. 3 ГК РФ», «статьёй 6 названного
# ГК РФ»), но не точка: за точкой уже другое предложение.
_NORM_REF_RE = re.compile(
    r"(?:(?:ч(?:\.|аст(?:ь|и|ью))\s*\d+\s*)?"
    r"(?:(?:п(?:\.|ункт(?:а|ом)?)\s*\d+\s*)?)"
    r"(?:ст\.|стать(?:я|и|е|ю|ёй|ей)))\s*(\d+(?:\.\d+)?)"
    r"[^.«»\n]{0,40}?(" + _ACT_TAIL + r")",
    re.IGNORECASE,
)

# Постановление Пленума с реквизитами — отдельная, самая ценная
# разновидность ссылки: в эталонной работе автора их одиннадцать.
_PLENUM_RE = re.compile(
    r"Пленум\w*\s+(?:Верховного|Высшего\s+Арбитражного)\s+Суда"
    # Точку пропускаем только внутри числа: в реквизитах стоит дата
    # «от 23.06.2015», а конец предложения связку обрывает.
    r"(?:[^.\n]|\.(?=\d)){0,60}?№\s*\d+",
    re.IGNORECASE,
)


def extract_norm_refs(text: str) -> list[str]:
    """Ссылки на нормы целыми связками, а не россыпью.

    ``extract_facts`` разбирает текст на отдельные единицы: «ст. 15»
    в одну сторону, «Конституция РФ» в другую. Для сторожа переписи
    этого хватает — он следит, чтобы ничего не пропало. А вот модели
    такой перечень вреден: увидев «ст. 15, ст. 76, Конституция РФ,
    ГК РФ», она соберёт из них пару, которой в источнике не было.
    Поэтому связку надо отдавать целиком и только ту, что в тексте
    действительно есть.
    """
    out: list[str] = []
    if not text:
        return out

    for match in _NORM_REF_RE.finditer(text):
        number, act = match.group(1), match.group(2)
        act = re.sub(r"\s+", " ", act).strip()
        if act.lower().startswith("конституци"):
            act = "Конституции РФ"
        elif act.startswith("№"):
            act = re.sub(r"№\s*", "№ ", act).replace("– ФЗ", "-ФЗ")
            act = re.sub(r"\s*-\s*ФЗ", "-ФЗ", act)
        else:
            act = act.upper().replace("КОАП", "КоАП")
            act = re.sub(r"\s+", " ", act)
        ref = f"ст. {number} {act}"
        if ref not in out:
            out.append(ref)

    for match in _PLENUM_RE.finditer(text):
        ref = re.sub(r"\s+", " ", match.group(0)).strip()
        if ref not in out:
            out.append(ref)

    return out


def norm_hits(text: str) -> int:
    """Сколько проверяемых ссылок на нормы в куске."""
    return len(extract_norm_refs(text))


# Слова, которые выглядят как фамилия, но ею не являются. Берутся из
# живых текстов: «Профессор А. Ф. Черданцев» давал пару «Профессор А. Ф.».
_NOT_SURNAMES = {
    "профессор", "доцент", "академик", "автор", "редакцией", "ответ",
    "москва", "санкт", "издательство", "глава", "статья", "пункт",
    "часть", "смотри", "указ", "решение", "постановление",
}

# Падежные окончания фамилий. Нужны, чтобы «Васевым И. Н.» и «Васев
# И. Н.» не считались двумя разными учёными: в статьях фамилию
# склоняют, а в перечень для модели она должна попасть один раз и в
# именительном падеже.
_CASE_ENDINGS = ("ами", "ого", "ему", "ым", "ом", "ой", "ых", "ев",
                 "ым", "а", "у", "е", "ы", "и")


def _merge_cases(names: set[str]) -> set[str]:
    """Схлопывает падежные варианты одной и той же фамилии."""
    by_initials: dict[str, list[str]] = {}
    for name in names:
        surname, _, initials = name.partition(" ")
        by_initials.setdefault(initials, []).append(surname)

    out: set[str] = set()
    for initials, surnames in by_initials.items():
        kept: list[str] = []
        for surname in sorted(set(surnames), key=len):
            merged = False
            for i, existing in enumerate(kept):
                short, long = sorted((existing, surname), key=len)
                if not long.startswith(short):
                    continue
                tail = long[len(short):]
                # «Васев» + «ым» — тот же человек, берём именительный.
                # «Чердан» + «цев» — обрезанное слово, берём полное.
                kept[i] = short if tail in _CASE_ENDINGS else long
                merged = True
                break
            if not merged:
                kept.append(surname)
        for surname in kept:
            out.add(f"{surname} {initials}")
    return out


def extract_names(text: str) -> set[str]:
    """Фамилии с инициалами — кого цитируют в найденных статьях."""
    found: set[str] = set()
    if not text:
        return found

    # Сначала «Матузов Н. И.», потом «Н. И. Матузов» — и только для
    # тех инициалов, которые не разобраны первым проходом.
    #
    # Порядок важен. В строке «Матузов Н.И. Актуальные проблемы»
    # обратное выражение читает «Н.И. Актуальные» и выдаёт учёного по
    # фамилии Актуальные. А в строке «Профессор А. Ф. Черданцев»
    # прямое выражение даёт звание, которое отбрасывается, и фамилию
    # должно подобрать именно обратное. Поэтому занятыми считаются
    # только те инициалы, по которым фамилия действительно принята.
    pairs: list[tuple[str, str]] = []
    taken_initials: set[int] = set()

    for m in _NAME_AFTER.finditer(text):
        if m.group(1).lower() in _NOT_SURNAMES:
            continue
        pairs.append((m.group(1), m.group(2)))
        taken_initials.add(m.start(2))

    for m in _NAME_BEFORE.finditer(text):
        if m.start(1) in taken_initials:
            continue
        pairs.append((m.group(2), m.group(1)))

    for surname, initials in pairs:
        if surname.lower() in _NOT_SURNAMES:
            continue
        initials = re.sub(r"\s+", " ", initials).strip()
        # Инициалы пишут и «А.Ф.», и «А. Ф.» — приводим к одному виду.
        initials = re.sub(r"\.\s*([А-ЯЁ])", r". \1", initials)
        found.add(f"{surname} {initials}")

    return _merge_cases(found)


def lost_facts(before: str, after: str) -> list[str]:
    """Что было в исходном тексте, но пропало в переписанном."""
    was = extract_facts(before)
    now = extract_facts(after)
    return sorted(was - now)
