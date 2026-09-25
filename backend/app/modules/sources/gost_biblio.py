"""Библиографическая запись по ГОСТ Р 7.0.100-2018.

## Зачем это здесь

Список литературы — единственная часть курсовой, которую проверяют
буквально: научный руководитель открывает ссылку и смотрит, существует
ли такая статья. Модель в этом месте бесполезна: реквизиты она
сочиняет — журнал настоящий, год правдоподобный, страницы выдуманы.

Поэтому запись собирается не из текста, а из метаданных баз, которые мы
и так получили при подборе источников. Чего в метаданных нет, того в
записи не будет: лучше короткое честное описание, чем полное выдуманное.

## Что именно требует ГОСТ

Для статьи из журнала схема такая:

    Фамилия, И. О. Заглавие статьи / И. О. Фамилия // Заглавие журнала.
    – 2023. – Т. 97, № 5. – С. 153–156.

Тонкости, на которых обычно спотыкаются:

* **Первый автор выносится в начало** с инвертированным именем
  («Вопленко, Н. Н.»), а в сведениях об ответственности после косой
  черты идёт прямой порядок («Н. Н. Вопленко»);
* авторов больше трёх — в начале указывается только первый, а после
  косой черты допустимо «[и др.]»;
* разделитель — тире (–), а не дефис, и с пробелами по обе стороны.
  Программы проверки это замечают;
* диапазон страниц пишется через тире без пробелов: «С. 153–156»;
* у электронного ресурса обязательны URL и **дата обращения** — без
  неё описание считается неполным.

## Чего мы сознательно не делаем

Не додумываем недостающее. Если база не дала страниц, в записи не будет
блока «С. …»: выдуманный диапазон хуже его отсутствия, потому что
выглядит достоверно и разваливается при первой проверке.
"""

from __future__ import annotations

import re
from datetime import date

from app.modules.sources.openalex import Source

#: Тире, которого требует ГОСТ. Дефис вместо него — самая частая
#: придирка нормоконтроля.
DASH = "\u2013"

#: Больше трёх авторов перечислять в начале записи нельзя.
MAX_AUTHORS_IN_HEAD = 3


def _initials(name: str) -> tuple[str, str]:
    """Разбирает «Вопленко Николай Николаевич» на фамилию и инициалы.

    Базы отдают имена как попало: «Вопленко Н. Н.», «Николай Вопленко»,
    «Vоплenko N.». Берём за фамилию первое слово, если оно длиннее
    инициала, — на русских именах это работает, а латинские записи
    приходят уже в виде «Family Given».
    """
    clean = re.sub(r"\s+", " ", (name or "").strip(" ,"))
    if not clean:
        return "", ""

    parts = clean.split(" ")
    family = parts[0].rstrip(",")
    rest = parts[1:]

    initials = []
    for part in rest:
        # Базы пишут инициалы то раздельно («Н. Н.»), то слитно
        # («Н.Н.»), то полным именем («Николай Николаевич»). Слитную
        # запись нельзя резать по первой букве: пропадёт отчество.
        if "." in part:
            # «А.А.» — это два инициала, а «Yu.» — один: транслитерация
            # русского «Ю» латиницей занимает две буквы. Режем по
            # точкам, а не по буквам, иначе получается «Y. U.».
            for chunk in part.split("."):
                letter = re.sub(r"[^A-Za-zА-Яа-яЁё]", "", chunk)[:1]
                if letter:
                    initials.append(f"{letter.upper()}.")
        else:
            letter = re.sub(r"[^A-Za-zА-Яа-яЁё]", "", part)[:1]
            if letter:
                initials.append(f"{letter.upper()}.")
    return family, " ".join(initials)


def format_author(name: str, *, inverted: bool) -> str:
    """Имя автора в прямом или инвертированном виде.

    Инвертированный — для начала записи («Вопленко, Н. Н.»), прямой —
    после косой черты («Н. Н. Вопленко»). ГОСТ требует обоих, и это
    не прихоть: по первому элементу список сортируется.
    """
    family, initials = _initials(name)
    if not family:
        return ""
    if not initials:
        return family
    return f"{family}, {initials}" if inverted else f"{initials} {family}"


def _responsibility(authors: list[str]) -> str:
    """Сведения об ответственности — то, что идёт после косой черты."""
    named = [format_author(a, inverted=False) for a in authors if a.strip()]
    named = [n for n in named if n]
    if not named:
        return ""
    if len(named) > MAX_AUTHORS_IN_HEAD:
        return f"{named[0]} [и др.]"
    return ", ".join(named)


def _issue_block(source: Source) -> str:
    """Том и номер: «Т. 97, № 5», «№ 5» или пусто."""
    parts = []
    if source.volume:
        parts.append(f"Т. {source.volume}")
    if source.issue:
        parts.append(f"№ {source.issue}")
    return ", ".join(parts)


def _pages_block(pages: str) -> str:
    """Страницы в виде «С. 153–156».

    Базы пишут диапазон через обычный дефис, ГОСТ требует тире.
    """
    clean = re.sub(r"\s+", "", pages or "")
    if not clean:
        return ""
    clean = re.sub(r"[-\u2010\u2011\u2012\u2014]", DASH, clean)
    return f"С. {clean}"


def format_source(source: Source, *,
                  accessed: date | None = None,
                  with_url: bool | None = None) -> str:
    """Собирает библиографическую запись по ГОСТ Р 7.0.100-2018.

    `accessed` — дата обращения для электронных ресурсов; по умолчанию
    сегодняшняя. `with_url` позволяет заставить или запретить блок
    ссылки; по умолчанию ссылка добавляется, когда у записи нет
    страниц, то есть найти её в бумажном виде читатель не сможет.
    """
    title = re.sub(r"\s+", " ", (source.title or "").strip()).rstrip(".")
    if not title:
        return ""

    authors = [a for a in (source.authors or []) if a and a.strip()]

    # Заголовок записи: фамилия первого автора с инициалами.
    head = format_author(authors[0], inverted=True) if authors else ""
    body = f"{head} {title}" if head else title

    responsibility = _responsibility(authors)
    if responsibility:
        body = f"{body} / {responsibility}"

    tail: list[str] = []

    venue = re.sub(r"\s+", " ", (source.venue or "").strip())
    if venue:
        # Две косые черты отделяют статью от издания, в котором она
        # напечатана. Это обязательный знак, а не украшение.
        body = f"{body} // {venue}"

    if source.year:
        tail.append(str(source.year))

    issue = _issue_block(source)
    if issue:
        tail.append(issue)

    pages = _pages_block(source.pages)
    if pages:
        tail.append(pages)

    if source.doi:
        tail.append(f"DOI {source.doi}")

    show_url = (not pages) if with_url is None else with_url
    if show_url and source.url:
        when = (accessed or date.today()).strftime("%d.%m.%Y")
        tail.append(f"URL: {source.url} (дата обращения: {when})")

    record = body
    if tail:
        record = f"{body}. {DASH} " + f". {DASH} ".join(tail)
    return record.rstrip(".") + "."


def format_list(sources: list[Source], *,
                accessed: date | None = None,
                numbered: bool = True) -> str:
    """Готовый список литературы.

    Записи сортируются по алфавиту — так требует большинство методичек,
    и так их проще сверять. Русские источники идут перед латинскими:
    смешанный алфавит в одном списке выглядит неряшливо.
    """
    records = [r for r in
               (format_source(s, accessed=accessed) for s in sources) if r]

    def key(record: str) -> tuple:
        first = record[0].lower() if record else ""
        cyrillic = "а" <= first <= "я" or first == "ё"
        return (0 if cyrillic else 1, record.lower())

    records = sorted(dict.fromkeys(records), key=key)
    if not numbered:
        return "\n".join(records)
    return "\n".join(f"{i}. {r}" for i, r in enumerate(records, 1))
