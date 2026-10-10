"""Поиск по загруженным документам.

Зачем это нужно. Модель пишет работу по своим общим знаниям, и если
у студента есть методичка кафедры, конспект лекций или сборник
практики, всё это остаётся за бортом. Поиск по загруженным файлам
позволяет подмешать в задание модели те абзацы, которые относятся к
делу: не весь документ (он не влезет в запрос), а три-четыре
фрагмента, отвечающих на вопрос раздела.

Почему BM25, а не векторная база. Проверено замером на юридических
текстах (`tools/bench-search.py`): лексический поиск дал MRR 0,794,
нейросетевые эмбеддинги — 0,744, то есть проиграли. Юридический текст
держится на редких терминах — «lex specialis», «виндикация»,
«подряд», — а именно на редких словах BM25 и силён. Вдобавок он не
требует ни модели в памяти, ни ключа к платному API, ни видеокарты.

Если позже появится качественный эмбеддер, векторный слой встанет
поверх этого же индекса: интерфейс `search()` менять не придётся.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass, field

# Параметры BM25. Классические значения из литературы: k1 отвечает за
# насыщение по частоте слова, b — за поправку на длину документа.
K1 = 1.5
B = 0.75

# Слова, которые есть в каждом тексте и только мешают: по ним
# «находится» что угодно. Падежные формы включены, потому что
# стемминг их не всегда сводит воедино.
STOP_WORDS = frozenset("""
и в во не что он на я с со как а то все она так его но да ты к у же вы за
бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну
вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там
потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была
сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому
этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были
куда зачем всех никогда можно при наконец два об другой хоть после над больше
тот через эти нас про всего них какая много разве три эту моя впрочем хорошо
свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно
всю между также является могут данном случае том числе этом том является
это почему зачем каков какое каким каких какому нужно должен должна должно
""".split())

WORD_RE = re.compile(r"[а-яёa-z0-9]+", re.IGNORECASE)

# Морфология русского языка, усечённый алгоритм Портера.
#
# Свой, а не из библиотеки: nltk в проекте оказался транзитивной
# зависимостью, а строить поиск на том, что может исчезнуть при
# следующей переустановке, нельзя. Алгоритм открытый и умещается в
# полсотни строк.
VOWELS = "аеиоуыэюяё"

RE_PERFECTIVE_GERUND = re.compile(
    r"(ив|ивши|ившись|ыв|ывши|ывшись)$|((?<=[ая])(в|вши|вшись))$")
RE_ADJECTIVE = re.compile(
    r"(ее|ие|ые|ое|ими|ыми|ей|ий|ый|ой|ем|им|ым|ом|его|ого|ему|ому|их|ых"
    r"|ую|юю|ая|яя|ою|ею)$")
RE_PARTICIPLE = re.compile(
    r"(ивш|ывш|ующ)$|((?<=[ая])(ем|нн|вш|ющ|щ))$")
RE_REFLEXIVE = re.compile(r"(ся|сь)$")
RE_VERB = re.compile(
    # «ат» нужно наравне с «ят»: без него «противоречат» оставалось
    # нетронутым и не сходилось с «противоречие».
    r"(ила|ыла|ена|ейте|уйте|ите|или|ыли|ей|уй|ил|ыл|им|ым|ен|ило|ыло|ено"
    r"|ат|ят|ует|уют|ит|ыт|ены|ить|ыть|ишь|ую|ю)$"
    r"|((?<=[ая])(ла|на|ете|йте|ли|й|л|ем|н|ло|но|ет|ют|ны|ть|ешь|нно))$")
RE_NOUN = re.compile(
    r"(а|ев|ов|ие|ье|е|иями|ями|ами|еи|ии|и|ией|ей|ой|ий|й|иям|ям|ием|ем"
    r"|ам|ом|о|у|ах|иях|ях|ы|ь|ию|ью|ю|ия|ья|я)$")
RE_DERIVATIONAL = re.compile(r"(ост|ость)$")
RE_SUPERLATIVE = re.compile(r"(ейш|ейше)$")
RE_I = re.compile(r"и$")
RE_NN = re.compile(r"нн$")
RE_SOFT = re.compile(r"ь$")


def _rv_position(word: str) -> int:
    """Начало области RV — после первой гласной.

    Окончания отрезаются только внутри неё: иначе короткие слова
    съедаются целиком и «иск» превращается в пустую строку.
    """
    for i, ch in enumerate(word):
        if ch in VOWELS:
            return i + 1
    return len(word)


def stem(word: str) -> str:
    """Приводит слово к основе: «коллизиями», «коллизия» → «коллиз»."""
    word = word.lower().replace("ё", "е")
    if len(word) <= 3:
        return word

    rv_start = _rv_position(word)
    head, rv = word[:rv_start], word[rv_start:]

    def sub(pattern: re.Pattern, text: str) -> tuple[str, bool]:
        new = pattern.sub("", text, count=1)
        return new, new != text

    # Шаг 1: деепричастие, иначе возвратность + прилагательное/причастие,
    # иначе глагол, иначе существительное.
    rv, done = sub(RE_PERFECTIVE_GERUND, rv)
    if not done:
        rv, _ = sub(RE_REFLEXIVE, rv)
        rv, done = sub(RE_ADJECTIVE, rv)
        if done:
            rv, _ = sub(RE_PARTICIPLE, rv)
        else:
            rv, done = sub(RE_VERB, rv)
            if not done:
                rv, _ = sub(RE_NOUN, rv)

    # Шаг 2-4: хвостовое «и», словообразование, превосходная степень.
    rv, _ = sub(RE_I, rv)
    rv, _ = sub(RE_DERIVATIONAL, rv)
    rv, changed = sub(RE_NN, rv)
    if changed:
        rv += "н"
    rv, _ = sub(RE_SUPERLATIVE, rv)
    rv, _ = sub(RE_NN, rv)
    rv, _ = sub(RE_SOFT, rv)

    return head + rv


def tokenize(text: str) -> list[str]:
    """Текст → список основ без стоп-слов."""
    out = []
    for raw in WORD_RE.findall(text.lower()):
        if raw in STOP_WORDS or len(raw) < 2:
            continue
        s = stem(raw)
        if s and s not in STOP_WORDS:
            out.append(s)
    return out


@dataclass
class Document:
    """Проиндексированный фрагмент."""

    id: str
    text: str
    source: str = ""
    metadata: dict = field(default_factory=dict)


@dataclass
class Hit:
    document: Document
    score: float

    @property
    def text(self) -> str:
        return self.document.text


class SearchIndex:
    """Индекс BM25 по фрагментам документов.

    Держится в памяти целиком. Это сознательно: один пользователь
    загружает методичку и пару конспектов — десятки тысяч слов, то
    есть единицы мегабайт. Поднимать ради этого отдельную базу значит
    добавить точку отказа там, где её можно не иметь.
    """

    def __init__(self) -> None:
        self._docs: list[Document] = []
        self._tokens: list[list[str]] = []
        self._freqs: list[Counter] = []
        self._df: Counter = Counter()
        self._avg_len: float = 0.0

    def __len__(self) -> int:
        return len(self._docs)

    @property
    def sources(self) -> list[str]:
        return sorted({d.source for d in self._docs if d.source})

    def add(self, documents: list[Document]) -> int:
        """Добавляет фрагменты в индекс. Возвращает число принятых."""
        added = 0
        for doc in documents:
            tokens = tokenize(doc.text)
            # Фрагмент без единого значимого слова искать бессмысленно:
            # это колонтитул, номер страницы или строка из точек. Одних
            # цифр мало — «12» в индексе только засоряет выдачу, тогда
            # как «60 процентов» попадёт сюда вместе со словом.
            if not any(any(ch.isalpha() for ch in tok) for tok in tokens):
                continue
            self._docs.append(doc)
            self._tokens.append(tokens)
            self._freqs.append(Counter(tokens))
            self._df.update(set(tokens))
            added += 1

        if self._tokens:
            self._avg_len = sum(len(t) for t in self._tokens) / len(self._tokens)
        return added

    # Вес неточного совпадения по началу основы. Ниже единицы, потому
    # что «закон» и «законодательный» — родственники, но не синонимы:
    # такое попадание должно уступать точному.
    PREFIX_WEIGHT = 0.4
    PREFIX_MIN_LEN = 5

    def _prefix_matches(self, term: str) -> list[str]:
        """Основы индекса, начинающиеся с основы запроса.

        Стемминг сводит падежи, но не родственные слова: «законы» даёт
        «закон», а «законодательной» — «законодательн», и запрос про
        законы не находил абзац про законодательную технику. Поиск по
        началу основы закрывает этот разрыв, не требуя словаря.
        """
        if len(term) < self.PREFIX_MIN_LEN:
            return []
        return [t for t in self._df
                if t != term and t.startswith(term)]

    def _idf(self, term: str) -> float:
        n_docs = len(self._docs)
        df = self._df.get(term, 0)
        # Сглаженная форма: слово, которое есть во всех документах,
        # получает вес около нуля, но не отрицательный.
        return math.log(1 + (n_docs - df + 0.5) / (df + 0.5))

    def search(self, query: str, limit: int = 5, *,
               min_score: float = 0.0) -> list[Hit]:
        """Находит фрагменты, отвечающие на запрос."""
        terms = tokenize(query)
        if not terms or not self._docs:
            return []

        # Для каждого слова запроса — оно само с полным весом плюс
        # родственные основы с пониженным.
        weighted: list[tuple[str, float]] = []
        for term in terms:
            weighted.append((term, 1.0))
            for near in self._prefix_matches(term):
                weighted.append((near, self.PREFIX_WEIGHT))

        scores: list[tuple[float, int]] = []
        for i, freqs in enumerate(self._freqs):
            doc_len = len(self._tokens[i])
            total = 0.0
            for term, weight in weighted:
                tf = freqs.get(term, 0)
                if not tf:
                    continue
                norm = tf + K1 * (1 - B + B * doc_len / (self._avg_len or 1))
                total += weight * self._idf(term) * tf * (K1 + 1) / norm
            if total > min_score:
                scores.append((total, i))

        scores.sort(key=lambda pair: (-pair[0], pair[1]))
        return [Hit(document=self._docs[i], score=s)
                for s, i in scores[:limit]]

    def snippet(self, hit: Hit, query: str, *, width: int = 300) -> str:
        """Кусок фрагмента вокруг самого «тяжёлого» совпадения.

        Нужен для показа человеку: целый абзац на 2000 знаков в списке
        результатов читать невозможно.
        """
        terms = set(tokenize(query))
        text = hit.document.text
        if len(text) <= width:
            return text

        best_at, best_hits = 0, -1
        step = max(1, width // 4)
        for start in range(0, max(1, len(text) - width + 1), step):
            window = text[start:start + width]
            found = sum(1 for t in tokenize(window) if t in terms)
            if found > best_hits:
                best_hits, best_at = found, start

        piece = text[best_at:best_at + width].strip()
        prefix = "…" if best_at > 0 else ""
        suffix = "…" if best_at + width < len(text) else ""
        return f"{prefix}{piece}{suffix}"
