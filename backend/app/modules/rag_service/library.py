"""Библиотека пользователя: загруженные документы и поиск по ним.

Студент приносит с собой материалы — методичку кафедры, конспект
лекций, сборник судебной практики, статьи научного руководителя. Всё
это модель не знает, а именно на это ей и нужно опираться: научрук
узнаёт собственные формулировки и спрашивает, почему их нет в работе.

Документ при загрузке режется на фрагменты и складывается в базу.
Поиск строится поверх BM25 (`search.py`) и собирается в памяти при
первом обращении: индекс по десятку документов строится за доли
секунды, и держать его на диске незачем.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.modules.projects.works import OWNER_KEY_MAX, new_id
from app.modules.rag_service.search import Document, SearchIndex

# Границы фрагмента. Слишком короткий кусок не отвечает на вопрос
# целиком, слишком длинный съедает место в запросе к модели: при
# подмешивании четырёх фрагментов по 2000 знаков уходит 8000 знаков
# только на цитаты.
MIN_CHUNK = 120
MAX_CHUNK = 1200

MAX_DOCS_PER_OWNER = 50


def _now() -> datetime:
    return datetime.now(timezone.utc)


class UserDocument(Base):
    """Загруженный пользователем файл."""

    __tablename__ = "user_documents"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    owner_key: Mapped[str] = mapped_column(
        String(OWNER_KEY_MAX), nullable=False, index=True)
    user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)

    filename: Mapped[str] = mapped_column(String(300), default="")
    # Для чего документ: «методичка», «практика», «статья», «конспект».
    # Свободная строка, а не перечисление: заранее не угадать, что
    # принесёт студент, а жёсткий список заставил бы врать.
    kind: Mapped[str] = mapped_column(String(50), default="материал")
    chars: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now)


class UserDocumentChunk(Base):
    """Фрагмент документа — единица поиска."""

    __tablename__ = "user_document_chunks"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    document_id: Mapped[str] = mapped_column(
        ForeignKey("user_documents.id", ondelete="CASCADE"),
        nullable=False, index=True)
    owner_key: Mapped[str] = mapped_column(
        String(OWNER_KEY_MAX), nullable=False, index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    text: Mapped[str] = mapped_column(Text, default="")


# ------------------------------------------------------------- нарезка

# Строка оглавления: «3. ОБЪЁМ ДИССЕРТАЦИИ ............ 7». Таких
# строк в методичках десятки, они состоят из тех же слов, что и сами
# разделы, и забивают выдачу пустыми ссылками на номера страниц.
RE_TOC_LINE = re.compile(r"\.{4,}\s*\d+\s*$", re.M)


def _is_toc(chunk: str) -> bool:
    """Похож ли фрагмент на оглавление."""
    lines = [ln for ln in chunk.split("\n") if ln.strip()]
    if not lines:
        return True
    dotted = sum(1 for ln in lines if RE_TOC_LINE.search(ln))
    # Половина строк с отточием — это оглавление, а не текст, где
    # случайно встретилось многоточие.
    return dotted >= max(2, len(lines) // 2)


def _is_heading(para: str) -> bool:
    """Похож ли абзац на заголовок раздела.

    Методички и конспекты разбиты на озаглавленные куски, и граница
    раздела — куда более честное место для разреза, чем счётчик
    знаков. Без этого «Нумерация страниц» и «Требования к объёму»
    слипались в один фрагмент, и поиск по объёму выдавал абзац про
    поля страницы.
    """
    s = para.strip()
    if "\n" in s or not (3 <= len(s) <= 120):
        return False
    if s.endswith((".", ",", ";", "!", "?")):
        return False
    # Заголовок — это назывная строка, а не предложение. Строку из
    # нескольких предложений без точки в конце заголовком не считаем.
    if len(s.split()) > 12:
        return False
    return s[:1].isupper() or s[:1].isdigit()


def split_text(text: str) -> list[str]:
    """Режет документ на фрагменты по абзацам и заголовкам.

    Нарезка идёт по смысловым границам, а не по числу знаков: фраза,
    разорванная посередине, в выдаче выглядит обрывком и сбивает
    модель, когда попадает к ней в задание.
    """
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]

    chunks: list[str] = []
    buffer = ""

    for para in paragraphs:
        para = re.sub(r"[ \t]+", " ", para)

        # Заголовок закрывает предыдущий фрагмент и открывает новый,
        # оставаясь в его начале: так у найденного куска видно, из
        # какого он раздела.
        if _is_heading(para):
            if buffer:
                chunks.append(buffer)
            buffer = para
            continue

        # Абзац длиннее предела режем по предложениям.
        if len(para) > MAX_CHUNK:
            if buffer:
                chunks.append(buffer)
                buffer = ""
            sentences = re.split(r"(?<=[.!?])\s+", para)
            piece = ""
            for sentence in sentences:
                if len(piece) + len(sentence) + 1 > MAX_CHUNK and piece:
                    chunks.append(piece.strip())
                    piece = sentence
                else:
                    piece = f"{piece} {sentence}".strip()
            if piece:
                buffer = piece
            continue

        if len(buffer) + len(para) + 2 > MAX_CHUNK and buffer:
            chunks.append(buffer)
            buffer = para
        else:
            buffer = f"{buffer}\n{para}".strip()

    if buffer:
        chunks.append(buffer)

    # Одинокий заголовок без текста под ним приклеиваем к соседу:
    # искать по строке «Нумерация страниц» нечего, а вот вместе с
    # разделом она полезна. Короткий, но содержательный фрагмент
    # оставляем как есть — именно в нём обычно и лежит ответ
    # («оригинальность не менее 60 процентов»).
    merged: list[str] = []
    for chunk in chunks:
        lonely_heading = _is_heading(chunk)
        # Фрагмент, начинающийся с заголовка, — самостоятельный раздел,
        # даже если он короткий. Раньше такие приклеивались к соседу, и
        # «Требования к объёму» растворялись в разделе про поля
        # страницы: поиск по объёму отвечал про поля.
        starts_with_heading = _is_heading(chunk.split("\n", 1)[0])
        too_short = len(chunk) < MIN_CHUNK and not starts_with_heading

        if merged and (lonely_heading or too_short):
            merged[-1] = f"{merged[-1]}\n{chunk}"
        else:
            merged.append(chunk)

    return [c for c in merged
            if len(c.strip()) >= 40 and not _is_toc(c)]


# ------------------------------------------------------------- хранение

@dataclass
class StoredDocument:
    id: str
    filename: str
    kind: str
    chars: int
    chunks: int
    created_at: datetime


async def add_document(
    session: AsyncSession,
    *,
    owner_key: str,
    filename: str,
    text: str,
    kind: str = "материал",
    user_id: str | None = None,
) -> StoredDocument:
    """Сохраняет документ и его фрагменты."""
    existing = await session.scalar(
        select(UserDocument).where(
            UserDocument.owner_key == owner_key,
            UserDocument.filename == filename,
        )
    )
    # Повторная загрузка того же файла — это замена, а не второй
    # экземпляр: иначе выдача наполнится дублями одного абзаца.
    if existing is not None:
        await remove_document(session, owner_key=owner_key, doc_id=existing.id)

    total = len((await session.scalars(
        select(UserDocument.id).where(UserDocument.owner_key == owner_key)
    )).all())
    if total >= MAX_DOCS_PER_OWNER:
        raise ValueError(
            f"Больше {MAX_DOCS_PER_OWNER} документов хранить нельзя — "
            "удалите ненужные."
        )

    doc = UserDocument(
        owner_key=owner_key,
        user_id=user_id,
        filename=filename,
        kind=kind,
        chars=len(text),
    )
    session.add(doc)
    await session.flush()

    pieces = split_text(text)
    for position, piece in enumerate(pieces):
        session.add(UserDocumentChunk(
            document_id=doc.id,
            owner_key=owner_key,
            position=position,
            text=piece,
        ))
    await session.commit()

    _invalidate(owner_key)
    return StoredDocument(
        id=doc.id, filename=doc.filename, kind=doc.kind,
        chars=doc.chars, chunks=len(pieces), created_at=doc.created_at,
    )


async def list_documents(session: AsyncSession, *,
                         owner_key: str) -> list[StoredDocument]:
    rows = (await session.scalars(
        select(UserDocument)
        .where(UserDocument.owner_key == owner_key)
        .order_by(UserDocument.created_at.desc())
    )).all()

    out = []
    for doc in rows:
        chunk_ids = (await session.scalars(
            select(UserDocumentChunk.id)
            .where(UserDocumentChunk.document_id == doc.id)
        )).all()
        out.append(StoredDocument(
            id=doc.id, filename=doc.filename, kind=doc.kind,
            chars=doc.chars, chunks=len(chunk_ids), created_at=doc.created_at,
        ))
    return out


async def remove_document(session: AsyncSession, *, owner_key: str,
                          doc_id: str) -> bool:
    doc = await session.scalar(
        select(UserDocument).where(
            UserDocument.id == doc_id,
            UserDocument.owner_key == owner_key,
        )
    )
    if doc is None:
        return False

    await session.execute(
        delete(UserDocumentChunk).where(UserDocumentChunk.document_id == doc_id)
    )
    await session.delete(doc)
    await session.commit()
    _invalidate(owner_key)
    return True


# ------------------------------------------------------------- поиск

# Индексы держим в памяти процесса и пересобираем после изменений.
# Кэш нужен не ради скорости поиска (он и так мгновенный), а чтобы не
# читать все фрагменты из базы на каждый запрос раздела: при сборке
# работы таких запросов десяток подряд.
_INDEX_CACHE: dict[str, SearchIndex] = {}


def _invalidate(owner_key: str) -> None:
    _INDEX_CACHE.pop(owner_key, None)


async def get_index(session: AsyncSession, *, owner_key: str) -> SearchIndex:
    cached = _INDEX_CACHE.get(owner_key)
    if cached is not None:
        return cached

    rows = (await session.execute(
        select(UserDocumentChunk, UserDocument)
        .join(UserDocument, UserDocument.id == UserDocumentChunk.document_id)
        .where(UserDocumentChunk.owner_key == owner_key)
        .order_by(UserDocumentChunk.position)
    )).all()

    index = SearchIndex()
    index.add([
        Document(
            id=chunk.id,
            text=chunk.text,
            source=doc.filename,
            metadata={"kind": doc.kind, "document_id": doc.id,
                      "position": chunk.position},
        )
        for chunk, doc in rows
    ])
    _INDEX_CACHE[owner_key] = index
    return index


async def search_documents(session: AsyncSession, *, owner_key: str,
                           query: str, limit: int = 5) -> list[dict]:
    """Ищет по библиотеке и отдаёт готовые к показу записи."""
    index = await get_index(session, owner_key=owner_key)
    hits = index.search(query, limit=limit)

    return [
        {
            "text": hit.document.text,
            "snippet": index.snippet(hit, query),
            "source": hit.document.source,
            "kind": hit.document.metadata.get("kind", ""),
            "score": round(hit.score, 3),
        }
        for hit in hits
    ]
