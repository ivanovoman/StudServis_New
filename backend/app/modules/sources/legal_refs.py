"""Извлечение ссылок на нормы из текста и сверка их с первоисточником.

Зачем это нужно. Шаг «Анализ» опирается на реальные публикации, и
галлюцинации там прекратились. А шаг «План» идёт без опоры на источники,
и модель уверенно пишет номера статей по памяти — с ошибками. Разбор
одного плана дал три неверные ссылки подряд:

* «ст. 4 ТК РФ» как коллизионная норма — на деле это запрещение
  принудительного труда, иерархия источников лежит в ст. 5;
* «ст. 10 ТК РФ» в контексте разрешения коллизий — она о нормах
  международного права;
* «ч. 7 ст. 125 Конституции» как основание полномочий КС по коллизиям —
  часть 7 про обвинение Президента, нужны части 2–4.

Обидная деталь:Модель пометила «проверить» совсем другие места, а эти
три выдала как твёрдо известные. То есть доверять её собственной оценке
уверенности нельзя, нужна внешняя сверка.

Подход простой и потому надёжный: у большинства кодексов есть публичное
оглавление вида «Статья 4. Запрещение принудительного труда». Этого
достаточно, чтобы ответить на главный вопрос — существует ли статья с
таким номером и о том ли она, о чём пишет модель. Полные тексты для
этого не нужны, что экономит и трафик, и время.

Модуль намеренно не выносит вердикт «ложь». Он говорит «номер есть, а
заголовок про другое» и показывает настоящий заголовок — решение
остаётся за человеком.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, field

import httpx

#: Откуда берём оглавления. Ключ — то, как кодекс называют в тексте.
#: Значение — идентификатор документа в правовой базе.
CODE_DOCS: dict[str, str] = {
    "ТК": "34683",
    "ГК": "5142",       # часть первая; остальные части добавляются ниже
    "ГК-2": "9027",
    "ГК-3": "34154",
    "ГК-4": "64629",
    "ЖК": "51057",
    "СК": "8982",
    "УК": "10699",
    "КоАП": "34661",
    "ГПК": "39570",
    "АПК": "37800",
    "НК": "19671",
    "УПК": "34481",
    "ЗК": "33773",
}

#: Части ГК ищутся все сразу: в тексте пишут просто «ст. 1102 ГК РФ»,
#: не уточняя часть.
CODE_ALIASES: dict[str, tuple[str, ...]] = {
    "ГК": ("ГК", "ГК-2", "ГК-3", "ГК-4"),
}

BASE_URL = "https://www.consultant.ru/document/cons_doc_LAW_{doc}/"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

#: Полные названия кодексов для читаемых сообщений.
CODE_NAMES: dict[str, str] = {
    "ТК": "Трудовой кодекс РФ",
    "ГК": "Гражданский кодекс РФ",
    "ЖК": "Жилищный кодекс РФ",
    "СК": "Семейный кодекс РФ",
    "УК": "Уголовный кодекс РФ",
    "КоАП": "Кодекс РФ об административных правонарушениях",
    "ГПК": "Гражданский процессуальный кодекс РФ",
    "АПК": "Арбитражный процессуальный кодекс РФ",
    "НК": "Налоговый кодекс РФ",
    "УПК": "Уголовно-процессуальный кодекс РФ",
    "ЗК": "Земельный кодекс РФ",
}

#: «ст. 4 ТК РФ», «статья 61.11 Закона о банкротстве», «ст. ст. 10, 12 ГК»
_REF_RE = re.compile(
    r"ст(?:атьи|атья|атьёй|атьей|\.)\s*(?:ст\.\s*)?"
    r"(?P<nums>\d+(?:\.\d+)?(?:\s*[,и]\s*\d+(?:\.\d+)?)*)"
    r"[^.;:)\n]{0,40}?"
    r"(?P<code>ТК|ГК|ЖК|СК|УК|КоАП|ГПК|АПК|НК|УПК|ЗК)\b",
    re.IGNORECASE,
)

#: «Статья 4. Запрещение принудительного труда» в оглавлении.
_TOC_RE = re.compile(
    r"Статья\s+(?P<num>\d+(?:\.\d+)?)\.\s*(?P<title>[^<\n]{3,200})"
)

#: Слова, по которым сравниваем смысл. Служебные выкидываем.
_STOP = {
    "и", "или", "в", "во", "на", "о", "об", "от", "по", "с", "со", "к",
    "для", "при", "не", "за", "до", "из", "их", "а", "но", "что", "как",
    "это", "рф", "российской", "федерации", "иные", "иных", "также",
}


@dataclass
class Reference:
    """Одна ссылка на статью, найденная в тексте."""

    code: str                 #: «ТК», «ГК» …
    article: str              #: «4», «61.11»
    context: str              #: фраза, в которой стоит ссылка
    claim: str = ""           #: что именно текст утверждает про статью
    real_title: str = ""      #: настоящий заголовок статьи
    status: str = "unknown"   #: ok | mismatch | unclear | missing | listed | unknown
    note: str = ""            #: пояснение для человека

    @property
    def label(self) -> str:
        return f"ст. {self.article} {self.code} РФ"


@dataclass
class CheckResult:
    """Итог проверки одного текста."""

    references: list[Reference] = field(default_factory=list)

    @property
    def suspicious(self) -> list[Reference]:
        """Ссылки, которые стоит посмотреть глазами.

        Статус ``listed`` сюда не попадает: если статья просто
        перечислена в ряду других, сверять её смысл не с чем, и
        поднимать тревогу не на чем.
        """
        return [r for r in self.references
                if r.status in ("mismatch", "missing")]

    @property
    def listed(self) -> list[Reference]:
        """Ссылки из перечней — их смысл машина сверить не может."""
        return [r for r in self.references if r.status == "listed"]

    @property
    def unclear(self) -> list[Reference]:
        """Ссылки, которые машина не смогла сопоставить с заголовком.

        Отдельно от ``suspicious`` намеренно. Это не ошибки, а места,
        где автор пересказал статью своими словами. Если валить их в
        одну кучу с настоящими расхождениями, человек привыкает
        пролистывать красное — и настоящая ошибка теряется в шуме.
        """
        return [r for r in self.references if r.status == "unclear"]

    def summary(self) -> str:
        """Человекочитаемый итог проверки.

        Перечисленные статьи выводятся вместе с настоящими заголовками
        и без них не обойтись: именно в перечне пряталась ошибочная
        «ст. 4 ТК РФ» из разобранного плана. Машина не может сказать,
        уместна ли она в этом ряду, но показать «а называется она
        «Запрещение принудительного труда» — может, и дальше человек
        видит несоответствие сам.
        """
        if not self.references:
            return "Ссылок на статьи кодексов в тексте не найдено."

        bad = self.suspicious
        listed = self.listed
        lines: list[str] = []

        if bad:
            lines.append(f"Проверено ссылок: {len(self.references)}, "
                         f"расхождений: {len(bad)}.")
            lines.append("")
            lines.append("Не сходится:")
            for r in bad:
                lines.append(f"* {r.label} — {r.note}")
        else:
            lines.append(f"Проверено ссылок: {len(self.references)}. "
                         f"Явных расхождений нет.")

        unclear = self.unclear
        if unclear:
            lines.append("")
            lines.append("Не удалось сверить автоматически — проверьте "
                         "глазами (скорее всего, всё в порядке):")
            for r in unclear:
                lines.append(f"* {r.label} — «{r.real_title}»")

        if listed:
            lines.append("")
            lines.append("Перечислены без пояснений — сверьте по смыслу "
                         "сами:")
            for r in listed:
                lines.append(f"* {r.label} — «{r.real_title}»")

        return "\n".join(lines)


#: Границы утверждения: точка, точка с запятой, скобка, перевод строки.
#: Запятую границей не считаем - она часто соединяет ссылку с оборотом
#: «ст. 4 ТК РФ, определяющей иерархию источников».
_CLAIM_BOUND = ".;:()\n\u2014"


def _claim_around(text: str, start: int, end: int) -> str:
    """Вырезать фразу, в которой стоит ссылка.

    Граница по знакам препинания, а не по числу символов: фиксированное
    окно втягивает соседние предложения, и тогда любая ссылка выглядит
    осмысленно подтверждённой словами из чужой фразы.
    """
    left = start
    while left > 0 and text[left - 1] not in _CLAIM_BOUND:
        left -= 1
    right = end
    while right < len(text) and text[right] not in _CLAIM_BOUND:
        right += 1
    return re.sub(r"\s+", " ", text[left:right]).strip()


def extract(text: str) -> list[Reference]:
    """Вытащить из текста все ссылки на статьи кодексов.

    Одна запись вида «ст. ст. 10, 12 ГК РФ» разворачивается в две
    ссылки: проверять их всё равно придётся по отдельности.
    """
    found: list[Reference] = []
    seen: set[tuple[str, str]] = set()

    for m in _REF_RE.finditer(text):
        code = _canonical_code(m.group("code"))
        start = max(0, m.start() - 120)
        end = min(len(text), m.end() + 120)
        context = re.sub(r"\s+", " ", text[start:end]).strip()
        claim = _claim_around(text, m.start(), m.end())

        for num in re.findall(r"\d+(?:\.\d+)?", m.group("nums")):
            key = (code, num)
            if key in seen:
                continue
            seen.add(key)
            found.append(Reference(code=code, article=num,
                                   context=context, claim=claim))

    return found


def _canonical_code(raw: str) -> str:
    """Привести написание кодекса к единому виду."""
    up = raw.upper()
    if up == "КОАП":
        return "КоАП"
    return up


async def fetch_toc(code: str, client: httpx.AsyncClient) -> dict[str, str]:
    """Скачать оглавление кодекса: номер статьи → заголовок.

    Для ГК опрашиваются все четыре части: в тексте их не различают.
    Сетевая ошибка не поднимается наверх — вернётся пустой словарь, и
    проверка честно скажет «не удалось сверить».
    """
    toc: dict[str, str] = {}

    for key in CODE_ALIASES.get(code, (code,)):
        doc = CODE_DOCS.get(key)
        if not doc:
            continue
        try:
            resp = await client.get(
                BASE_URL.format(doc=doc),
                headers={"User-Agent": USER_AGENT},
                timeout=20.0,
                follow_redirects=True,
            )
            if resp.status_code != 200:
                continue
            page = resp.text
        except (httpx.HTTPError, UnicodeDecodeError):
            continue

        for m in _TOC_RE.finditer(page):
            num = m.group("num")
            title = html.unescape(m.group("title")).strip(" .;—-")
            # В оглавлении статья встречается раз, в тексте — снова.
            # Первое вхождение и есть заголовок из оглавления.
            if num not in toc and title:
                toc[num] = title

    return toc


def _words(text: str) -> set[str]:
    """Значимые слова, обрезанные до основы.

    Обрубание хвоста заменяет полноценную лемматизацию: «коллизия» и
    «коллизий» дают общее начало, а тянуть pymorphy ради одной проверки
    не стоит.
    """
    raw = re.findall(r"[а-яёa-z]{3,}", text.lower())
    return {w[:6] for w in raw if w not in _STOP}


def _same_stem(a: str, b: str) -> bool:
    """Одно ли это слово в разных формах.

    Сравниваются первые буквы по длине более короткой основы, но не
    меньше четырёх. Так «норм» и «нормы» совпадают (одно слово в разных
    падежах), а «труда» и «трудов» — нет, и это правильно: статья про
    принудительный труд не относится к трудовому праву вообще.
    """
    n = max(4, min(len(a), len(b)))
    return a[:n] == b[:n]


def _overlap(left: set[str], right: set[str]) -> set[str]:
    """Пересечение двух наборов основ с поправкой на падежи."""
    return {a for a in left if any(_same_stem(a, b) for b in right)}


#: Перечень статей: «(ст. 2 ГК РФ, ст. 1 ЖК РФ, ст. 4 ТК РФ)».
#: В таком ряду соседние слова относятся ко всей группе сразу, а не к
#: каждой статье, поэтому сверять смысл не с чем.
_LIST_NEIGHBOUR_RE = re.compile(
    r"ст(?:\.|атья|атьи)\s*\d+[^;.]{0,30}?"
    r"(?:ТК|ГК|ЖК|СК|УК|КоАП|ГПК|АПК|НК|УПК|ЗК)\s*(?:РФ)?\s*[,;и]\s*"
    r"ст(?:\.|атья|атьи)\s*\d+",
    re.IGNORECASE,
)


def _is_enumeration(claim: str) -> bool:
    """Стоит ли ссылка в перечне однородных ссылок.

    Отличить важно. Фраза «коллизионные нормы (ст. 2 ГК РФ, ст. 1 ЖК РФ,
    ст. 4 ТК РФ)» не утверждает, что каждая из статей называется
    «коллизионная норма» — это список для проверки. А фраза «ст. 4 ТК РФ,
    определяющая иерархию источников» уже утверждает конкретное, и вот
    её можно сверять с заголовком.

    Признак простой: вырезаем из фрагмента все ссылки на статьи и
    смотрим, что осталось. Если осталась пара служебных слов — это
    перечень. Если осталось утверждение («определяющей иерархию
    источников») — есть что сверять.

    Без этого различения проверка захлёбывается ложными тревогами: на
    реальном плане она пометила шесть ссылок из девяти, хотя ошибочной
    была одна.
    """
    rest = _REF_RE.sub(" ", claim)
    rest = re.sub(r"\bРФ\b", " ", rest)
    return len(_words(rest)) < 2


def compare(ref: Reference, toc: dict[str, str]) -> Reference:
    """Сверить одну ссылку с оглавлением и проставить статус.

    Возможные статусы:

    * ``ok`` — номер есть, и смысл сходится с заголовком;
    * ``missing`` — статьи с таким номером в кодексе нет;
    * ``mismatch`` — номер есть, но описанное подходит другой статье;
    * ``unclear`` — сверить не удалось, нужен человек;
    * ``listed`` — ссылка стоит в перечне, сверять смысл не с чем;
    * ``unknown`` — не удалось получить оглавление.
    """
    if not toc:
        ref.status = "unknown"
        ref.note = "не удалось получить оглавление кодекса"
        return ref

    title = toc.get(ref.article)
    if title is None:
        ref.status = "missing"
        ref.note = (f"статьи с таким номером в кодексе нет "
                    f"({CODE_NAMES.get(ref.code, ref.code)})")
        return ref

    ref.real_title = title

    if title.lower().startswith("утратил"):
        ref.status = "mismatch"
        ref.note = f"статья утратила силу — «{title}»"
        return ref

    # Номер существует и статья действует. Дальше вопрос смысла, а он
    # решается только если текст что-то про эту статью утверждает.
    if _is_enumeration(ref.claim or ref.context):
        ref.status = "listed"
        ref.note = f"упомянута в перечне; статья называется «{title}»"
        return ref

    claim_words = _words(ref.claim or ref.context)
    overlap = _overlap(_words(title), claim_words)
    if overlap:
        ref.status = "ok"
        ref.note = f"«{title}»"
        return ref

    # Слова не сошлись. Само по себе это НЕ ошибка: научный текст
    # пересказывает статью своими словами, а не цитирует заголовок.
    # На живом прогоне так было помечено 4 ссылки из 9, и все четыре
    # оказались верными («ст. 3 ГК провозглашает приоритет кодекса» —
    # заголовок «Гражданское законодательство и иные акты…»).
    #
    # Красный статус имеет смысл только тогда, когда видно, что автор
    # перепутал номер: описание подходит к другой статье того же
    # кодекса заметно лучше, чем к названной. Тогда мы не просто
    # ругаемся, а подсказываем номер.
    better = _better_article(claim_words, toc, exclude=ref.article)
    if better:
        number, other_title = better
        ref.status = "mismatch"
        ref.note = (
            f"статья называется «{title}», а описанное в тексте похоже "
            f"на ст. {number} — «{other_title}». Проверьте номер"
        )
        return ref

    ref.status = "unclear"
    ref.note = (
        f"статья называется «{title}» — сверьте по смыслу сами: "
        f"машина не поняла, о том ли она"
    )
    return ref


#: Насколько описание должно совпасть с чужим заголовком, чтобы counted
#: как подсказка. Одно общее слово — это шум («нормы», «право»),
#: поэтому берём от двух.
_BETTER_MIN_WORDS = 2


def _better_article(
    claim_words: set[str], toc: dict[str, str], exclude: str
) -> tuple[str, str] | None:
    """Найти статью того же кодекса, к которой описание подходит лучше.

    Нужна, чтобы отличить перепутанный номер от обычного пересказа.
    Если в тексте сказано «ст. 61.12 ГК о непередаче документов», а
    статья с таким названием в кодексе есть под другим номером — это
    настоящая ошибка, и полезно назвать правильный номер.

    Возвращает пару (номер, заголовок) либо None, если ничего заметно
    лучшего нет.
    """
    best: tuple[int, str, str] | None = None

    for number, title in toc.items():
        if number == exclude:
            continue
        if title.lower().startswith("утратил"):
            continue
        score = len(_overlap(_words(title), claim_words))
        if score < _BETTER_MIN_WORDS:
            continue
        if best is None or score > best[0]:
            best = (score, number, title)

    if best is None:
        return None
    return best[1], best[2]


async def check_text(text: str) -> CheckResult:
    """Найти в тексте ссылки на статьи и сверить их с кодексами.

    Оглавления качаются по одному разу на кодекс, а не на ссылку:
    в плане курсовой на один кодекс приходится по десятку ссылок.
    """
    refs = extract(text)
    if not refs:
        return CheckResult()

    result = CheckResult(references=refs)
    codes = sorted({r.code for r in refs})

    async with httpx.AsyncClient() as client:
        tocs: dict[str, dict[str, str]] = {}
        for code in codes:
            tocs[code] = await fetch_toc(code, client)

    for ref in refs:
        compare(ref, tocs.get(ref.code, {}))

    return result
