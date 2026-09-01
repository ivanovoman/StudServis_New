"""Ингестия материалов в RAG: PDF → чистый текст → чанки.

Два типа источников, разная обработка:

1. `стиль_коколов.pdf` — сборник статей автора. Источник СТИЛЯ.
   Чанкуется по смысловым заголовкам, чтобы каждый чанк был законченным
   куском рассуждения, а не обрывком.

2. `субсидиарнаяКЛ1.pdf` — магистерская диссертация. Источник СТРУКТУРЫ
   и эталонных разделов (введение, главы, выводы, заключение).
   Чанкуется по структурным границам работы.

ВАЖНО про очистку. В PDF со статьями 308 комментариев рецензента вида
«Добавлено примечание ([РБ1]): Лишние абзацы и...» — это правки ЧУЖОГО
человека, а не текст Коколова. Если скормить их в RAG как образец стиля,
модель начнёт воспроизводить замечания редактора вместо авторской речи.
Плюс 92 упоминания «Ezybrand» и рекламные вставки «Мы обладаем большим
опытом...» — это коммерческие блоки, в курсовой работе они недопустимы.
Всё это вырезается до чанкования.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Literal

logger = logging.getLogger(__name__)

Collection = Literal[
    "style_kokolov", "examples_good", "gost_rules", "sources_verified", "user_context"
]


@dataclass
class Chunk:
    """Кусок текста с метаданными для векторного поиска."""
    text: str
    collection: Collection
    metadata: dict = field(default_factory=dict)

    @property
    def char_count(self) -> int:
        return len(self.text)

    @property
    def word_count(self) -> int:
        return len(self.text.split())


# ------------------------------------------------------------- очистка PDF

# Комментарии рецензента: «Добавлено примечание ([РБ1]): текст до конца абзаца».
# Хвост примечания не имеет чёткой границы, поэтому режем до двойного
# перевода строки или до следующего примечания.
RE_REVIEWER_NOTE = re.compile(
    r"Добавлено примечание\s*\(\[[^\]]*\]\)\s*:.*?(?=\n\s*\n|Добавлено примечание|\Z)",
    re.S,
)

# Рекламные блоки патентного бюро — коммерция, не стиль.
RE_PROMO = re.compile(
    r"[^.!?\n]*(?:Ezybrand|[Пп]атентн\w+ бюро|Мы обладаем|[Нн]аши специалисты)"
    r"[^.!?]*[.!?]",
)

# Колонтитулы: номер страницы на отдельной строке.
RE_PAGE_NUM = re.compile(r"^\s*\d{1,3}\s*$", re.M)

# Точечные лидеры в оглавлении: «ВВЕДЕНИЕ ......... 4»
RE_TOC_DOTS = re.compile(r"\.{4,}\s*\d*")

# Разрывы слов от кернинга PDF: «а втор», «и х», «при званы», «регул ирует».
# Чиним только по словарю известных случаев — общее правило склейки
# поломало бы нормальные пары слов вроде «и др».
KERNING_FIXES = {
    "а втор": "автор",
    "а вторы": "авторы",
    "и х ": "их ",
    "при званы": "призваны",
    "регул ирует": "регулирует",
    "представляе т": "представляет",
    "нужн о": "нужно",
    "следу ет": "следует",
    "с делать": "сделать",
    "Интернет -": "Интернет-",
}


def clean_pdf_text(raw: str, *, drop_reviewer_notes: bool = True,
                   drop_promo: bool = True, collapse_lines: bool = True) -> str:
    """Приводит извлечённый из PDF текст к пригодному для RAG виду.

    `collapse_lines=False` сохраняет построчную структуру — она нужна,
    чтобы найти заголовки (заголовок это отдельная короткая строка).
    Схлопывать переносы надо уже ПОСЛЕ разбивки по заголовкам, иначе
    заголовки склеятся с текстом и разбивка развалится.
    """
    text = raw

    if drop_reviewer_notes:
        text, n = RE_REVIEWER_NOTE.subn(" ", text)
        if n:
            logger.info("Удалено комментариев рецензента: %d", n)

    if drop_promo:
        text, n = RE_PROMO.subn(" ", text)
        if n:
            logger.info("Удалено рекламных предложений: %d", n)

    text = RE_TOC_DOTS.sub(" ", text)
    text = RE_PAGE_NUM.sub("", text)

    for bad, good in KERNING_FIXES.items():
        text = text.replace(bad, good)

    # Переносы по дефису в конце строки: «ответствен-\nность» → «ответственность»
    text = re.sub(r"(\w)-\s*\n\s*(\w)", r"\1\2", text)

    if collapse_lines:
        # Внутри абзаца перевод строки — это перенос вёрстки, а не новый абзац.
        text = re.sub(r"(?<![.!?:;])\n(?!\s*\n)", " ", text)

    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_pdf(path: Path) -> list[str]:
    """Постранично извлекает текст. Отдельная функция — чтобы тесты
    могли подсунуть страницы без настоящего PDF."""
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    return [(page.extract_text() or "") for page in reader.pages]


# ------------------------------------------------------- разбивка на чанки

# Медианная строка в PDF ~64 символа: текст свёрстан в колонку, и любая
# строка абзаца выглядит «короткой». Поэтому одной длины мало —
# нужен контекст предыдущей строки.
_HEADING_MAX_LEN = 55
_SENTENCE_END = (".", "!", "?", ":")


def _looks_like_heading(line: str, prev_line: str | None = None) -> bool:
    """Заголовок статьи/раздела.

    Критерии (все обязательны):
      - короткая строка (заголовки короче строк вёрстки);
      - не заканчивается знаком препинания предложения;
      - начинается с заглавной, не с цифры;
      - ПРЕДЫДУЩАЯ строка закончена точкой (или это начало документа).

    Последнее условие — ключевое. Без него любая строка, на которой
    закончился абзац, ошибочно считается заголовком: на статьях это
    давало 275 «заголовков» и чанки по 30 символов.
    """
    s = line.strip()
    if not (10 <= len(s) <= _HEADING_MAX_LEN):
        return False
    if s.endswith((".", ",", ":", ";", "!", "?")):
        return False
    if not s[0].isupper():
        return False
    if prev_line is not None:
        prev = prev_line.strip()
        if prev and not prev.endswith(_SENTENCE_END):
            return False
    return True


# Остаточные маркеры рекламы: RE_PROMO режет предложениями, но целый
# рекламный абзац («Рекламный блок», «Наши патентные поверенные...»)
# может уцелеть. Такие чанки не должны попадать в образцы стиля.
_PROMO_MARKERS = (
    "ezybrand", "рекламный блок", "наши патентные поверенные",
    "мы обеспечим", "мы обладаем", "наши специалисты", "мы также дадим",
    "оставьте заявку", "звоните", "стоимость услуг",
)

_MIN_USEFUL_CHARS = 250
_MIN_USEFUL_WORDS = 35


def _is_useful_chunk(text: str) -> bool:
    """Отсеивает обрывки и рекламу.

    Короткий чанк даёт размытый эмбеддинг и тянет поиск в шум,
    а рекламный — учит модель продавать услуги патентного бюро
    посреди курсовой работы.
    """
    s = text.strip()
    if len(s) < _MIN_USEFUL_CHARS or len(s.split()) < _MIN_USEFUL_WORDS:
        return False
    low = s.lower()
    if any(m in low for m in _PROMO_MARKERS):
        return False
    # Должно быть хотя бы одно законченное предложение.
    return s.count(".") >= 2


def _collapse(text: str) -> str:
    """Схлопывает переносы вёрстки внутри абзаца, сохраняя границы абзацев."""
    text = re.sub(r"(?<![.!?:;])\n(?!\s*\n)", " ", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def split_into_paragraphs(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]


def pack_paragraphs(
    paragraphs: Iterable[str],
    *,
    target_chars: int = 1200,
    max_chars: int = 2000,
    overlap_chars: int = 150,
) -> list[str]:
    """Склеивает абзацы в чанки около target_chars.

    Границы абзацев не разрываются: чанк, оборванный на середине мысли,
    даёт мусорный эмбеддинг. Перекрытие сохраняет связность между чанками.
    """
    chunks: list[str] = []
    buf: list[str] = []
    size = 0

    for para in paragraphs:
        p_len = len(para)
        # Абзац-гигант отправляем отдельным чанком, порезав по предложениям.
        if p_len > max_chars:
            if buf:
                chunks.append("\n\n".join(buf))
                buf, size = [], 0
            chunks.extend(_split_long_paragraph(para, max_chars))
            continue

        if size + p_len > max_chars and buf:
            chunks.append("\n\n".join(buf))
            tail = buf[-1] if overlap_chars and len(buf[-1]) <= overlap_chars else ""
            buf = [tail] if tail else []
            size = len(tail)

        buf.append(para)
        size += p_len

        if size >= target_chars:
            chunks.append("\n\n".join(buf))
            tail = buf[-1] if overlap_chars and len(buf[-1]) <= overlap_chars else ""
            buf = [tail] if tail else []
            size = len(tail)

    if buf:
        last = "\n\n".join(buf).strip()
        if last:
            chunks.append(last)
    return [c for c in chunks if c.strip()]


def _split_long_paragraph(para: str, max_chars: int) -> list[str]:
    sentences = re.split(r"(?<=[.!?])\s+", para)
    out, buf, size = [], [], 0
    for s in sentences:
        if size + len(s) > max_chars and buf:
            out.append(" ".join(buf))
            buf, size = [], 0
        buf.append(s)
        size += len(s)
    if buf:
        out.append(" ".join(buf))
    return out


# ------------------------------------------------ статьи Коколова (стиль)

def chunk_style_articles(text: str, *, source: str = "стиль_коколов.pdf") -> list[Chunk]:
    """Режет сборник статей на чанки по смысловым заголовкам.

    На вход ожидает текст с СОХРАНЁННОЙ построчной структурой
    (clean_pdf_text(collapse_lines=False)) — иначе заголовки не найти.
    """
    lines = [l for l in text.split("\n")]
    sections: list[tuple[str, list[str]]] = []
    current_title = "Без заголовка"
    current: list[str] = []
    prev_nonempty: str | None = None

    for line in lines:
        if _looks_like_heading(line, prev_nonempty):
            if current:
                sections.append((current_title, current))
            current_title = line.strip()
            current = []
        else:
            current.append(line)
        if line.strip():
            prev_nonempty = line
    if current:
        sections.append((current_title, current))

    chunks: list[Chunk] = []
    for title, body_lines in sections:
        # Схлопываем переносы вёрстки только теперь, когда границы найдены.
        body = _collapse(("\n".join(body_lines)).strip())
        if len(body) < 200:  # слишком короткий фрагмент — не несёт стиля
            continue
        for i, piece in enumerate(pack_paragraphs(split_into_paragraphs(body))):
            if not _is_useful_chunk(piece):
                continue
            chunks.append(
                Chunk(
                    text=piece,
                    collection="style_kokolov",
                    metadata={
                        "source": source,
                        "author": "Коколов С.",
                        "doc_type": "article",
                        "section_title": title,
                        "chunk_index": i,
                        "type": "example",
                    },
                )
            )
    return chunks


# ------------------------------------------ диссертация (структура/эталон)

RE_CHAPTER = re.compile(r"^ГЛАВА\s+(\d+)\.\s*(.+)$")
RE_SECTION = re.compile(r"^(\d+\.\d+)\.\s*(.+)$")
RE_CONCLUSIONS = re.compile(r"^Выводы по главе\s+(\d+)")


def _strip_toc(pages: list[str]) -> list[str]:
    """Убирает страницы оглавления — там только заголовки с номерами."""
    out = []
    for p in pages:
        dots = len(re.findall(r"\.{4,}", p))
        if dots >= 5:  # характерный признак страницы СОДЕРЖАНИЕ
            continue
        out.append(p)
    return out


def chunk_thesis(
    pages: list[str], *, source: str = "субсидиарнаяКЛ1.pdf", topic: str = ""
) -> list[Chunk]:
    """Режет диссертацию по структурным границам.

    Введение, заключение и выводы по главам попадают в `examples_good` —
    это эталоны для соответствующих этапов генерации. Тело глав идёт
    в `style_kokolov` как образец академической манеры того же автора.
    """
    body_pages = _strip_toc(pages)
    text = clean_pdf_text("\n".join(body_pages), drop_reviewer_notes=True,
                          drop_promo=False, collapse_lines=False)

    # Разбираем на блоки по структурным заголовкам.
    blocks: list[tuple[str, str, dict]] = []  # (kind, title, text)
    current_kind, current_title, buf = "preamble", "Титул", []
    meta: dict = {}

    for line in text.split("\n"):
        s = line.strip()
        kind = title = None

        if s.startswith("ВВЕДЕНИЕ"):
            kind, title, meta = "introduction", "ВВЕДЕНИЕ", {}
        elif s.startswith("ЗАКЛЮЧЕНИЕ"):
            kind, title, meta = "conclusion", "ЗАКЛЮЧЕНИЕ", {}
        elif s.startswith("СПИСОК ИСПОЛЬЗОВАННЫХ"):
            kind, title, meta = "bibliography", "СПИСОК ИСТОЧНИКОВ", {}
        elif m := RE_CHAPTER.match(s):
            kind, title = "chapter", s
            meta = {"chapter": m.group(1)}
        elif m := RE_SECTION.match(s):
            kind, title = "section", s
            meta = {"number": m.group(1)}
        elif m := RE_CONCLUSIONS.match(s):
            kind, title = "chapter_conclusions", s
            meta = {"chapter": m.group(1)}

        if kind:
            if buf:
                blocks.append((current_kind, current_title, "\n".join(buf)))
            current_kind, current_title, buf = kind, title, []
            blocks and blocks[-1]
            continue
        buf.append(line)

    if buf:
        blocks.append((current_kind, current_title, "\n".join(buf)))

    # Куда какой блок кладём.
    to_examples = {"introduction", "conclusion", "chapter_conclusions"}
    chunks: list[Chunk] = []

    for kind, title, body in blocks:
        body = _collapse(body.strip())
        if kind in ("preamble", "bibliography") or len(body) < 300:
            continue

        collection: Collection = (
            "examples_good" if kind in to_examples else "style_kokolov"
        )
        for i, piece in enumerate(pack_paragraphs(split_into_paragraphs(body))):
            if not _is_useful_chunk(piece):
                continue
            chunks.append(
                Chunk(
                    text=piece,
                    collection=collection,
                    metadata={
                        "source": source,
                        "author": "Коколов С.",
                        "doc_type": "thesis",
                        "section_type": kind,
                        "section_title": title,
                        "topic": topic,
                        "chunk_index": i,
                        "quality": "high",
                    },
                )
            )
    return chunks


# ------------------------------------------------------------ точка входа

def ingest_pdf(path: Path, kind: Literal["articles", "thesis"], **kw) -> list[Chunk]:
    pages = extract_pdf(path)
    if kind == "articles":
        cleaned = clean_pdf_text("\n".join(pages), collapse_lines=False)
        return chunk_style_articles(cleaned, source=path.name)
    return chunk_thesis(pages, source=path.name, **kw)
