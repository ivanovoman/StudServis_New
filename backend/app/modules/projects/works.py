"""Хранение работ пользователя.

Зачем. До этого модуля всё жило в памяти вкладки браузера: собранная
курсовая существовала ровно до закрытия страницы. Сборка занимает пару
минут и расходует лимит модели, так что потерять её — обидно и дорого.

Что хранится. Работа (тема, план, настройки) и её части — введение,
разделы, заключение. Части пишутся по одной, прямо во время сборки:
если браузер закроется на середине, написанное останется.

Чьё это. Полноценных учётных записей ещё нет (модуль Users & Auth по
ТЗ отдельный), поэтому работа привязывается к ``owner_key`` — случайной
строке, которую браузер хранит у себя и присылает с каждым запросом.
Это разделяет работы разных людей и переживает перезагрузку страницы,
но не защищает от того, кто ключ подсмотрел. Когда появится вход по
паролю, ключ заменится на идентификатор пользователя — поля и запросы
останутся теми же.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    delete,
    func,
    select,
)
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

# Длина ключа владельца: 32 шестнадцатеричных символа хватает, чтобы
# ключи не совпали случайно.
OWNER_KEY_MIN = 8
OWNER_KEY_MAX = 128


def _now() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return uuid.uuid4().hex


class Work(Base):
    """Одна работа пользователя."""

    __tablename__ = "works"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    owner_key: Mapped[str] = mapped_column(String(OWNER_KEY_MAX), nullable=False)

    topic: Mapped[str] = mapped_column(String(500), default="")
    plan: Mapped[str] = mapped_column(Text, default="")
    # Настройки храним как JSON-строку: состав полей ещё меняется, и
    # заводить колонку под каждое — только плодить миграции.
    settings_json: Mapped[str] = mapped_column(Text, default="{}")

    # draft — создана, ещё не собиралась
    # assembling — сборка идёт
    # done — сборка завершена
    status: Mapped[str] = mapped_column(String(20), default="draft")

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )

    pieces: Mapped[list["WorkPiece"]] = relationship(
        back_populates="work",
        cascade="all, delete-orphan",
        order_by="WorkPiece.position",
        lazy="selectin",
    )

    __table_args__ = (
        # Список работ всегда запрашивается по владельцу и сортируется
        # по свежести — индекс ровно под этот запрос.
        Index("ix_works_owner_updated", "owner_key", "updated_at"),
    )


class WorkPiece(Base):
    """Часть работы: введение, раздел или заключение."""

    __tablename__ = "work_pieces"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    work_id: Mapped[str] = mapped_column(
        ForeignKey("works.id", ondelete="CASCADE"), nullable=False
    )

    # Порядок в документе. Отдельное поле, а не сортировка по номеру:
    # введение и заключение номера не имеют.
    position: Mapped[int] = mapped_column(Integer, default=0)

    kind: Mapped[str] = mapped_column(String(20))          # introduction/section/conclusion
    number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    heading: Mapped[str] = mapped_column(String(500), default="")
    text: Mapped[str] = mapped_column(Text, default="")
    chars: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    work: Mapped[Work] = relationship(back_populates="pieces")

    __table_args__ = (Index("ix_pieces_work_pos", "work_id", "position"),)


# --------------------------------------------------------------- операции


def chars_no_space(text: str) -> int:
    """Знаки без пробелов — в них заданы все нормы объёма."""
    return len("".join(str(text).split()))


async def create_work(
    session: AsyncSession,
    owner_key: str,
    topic: str = "",
    plan: str = "",
    settings_json: str = "{}",
) -> Work:
    work = Work(
        id=new_id(),
        owner_key=owner_key,
        topic=(topic or "").strip()[:500],
        plan=plan or "",
        settings_json=settings_json or "{}",
        status="draft",
    )
    session.add(work)
    await session.commit()
    await session.refresh(work)
    return work


async def get_work(
    session: AsyncSession, work_id: str, owner_key: str
) -> Work | None:
    """Работа по id — только своя.

    Проверка владельца именно в запросе, а не после выборки: так чужую
    работу нельзя достать даже случайно, забыв сравнить ключ.
    """
    res = await session.execute(
        select(Work).where(Work.id == work_id, Work.owner_key == owner_key)
    )
    return res.scalar_one_or_none()


async def list_works(
    session: AsyncSession, owner_key: str, limit: int = 100
) -> list[dict]:
    """Список работ без текстов — для экрана «Мои работы».

    Тексты здесь не нужны, а весят они сотни килобайт, поэтому объём
    считается в SQL, а не вычитыванием всех частей в память.
    """
    totals = (
        select(
            WorkPiece.work_id.label("wid"),
            func.count(WorkPiece.id).label("pieces"),
            func.coalesce(func.sum(WorkPiece.chars), 0).label("chars"),
        )
        .group_by(WorkPiece.work_id)
        .subquery()
    )

    res = await session.execute(
        select(
            Work.id,
            Work.topic,
            Work.status,
            Work.created_at,
            Work.updated_at,
            func.coalesce(totals.c.pieces, 0),
            func.coalesce(totals.c.chars, 0),
        )
        .outerjoin(totals, totals.c.wid == Work.id)
        .where(Work.owner_key == owner_key)
        .order_by(Work.updated_at.desc())
        .limit(limit)
    )

    out: list[dict] = []
    for row in res.all():
        out.append(
            {
                "id": row[0],
                "topic": row[1],
                "status": row[2],
                "created_at": row[3].isoformat() if row[3] else None,
                "updated_at": row[4].isoformat() if row[4] else None,
                "pieces": int(row[5]),
                "chars": int(row[6]),
            }
        )
    return out


async def add_piece(
    session: AsyncSession,
    work: Work,
    kind: str,
    heading: str,
    text: str,
    number: str | None = None,
    position: int | None = None,
) -> WorkPiece:
    """Добавить часть. Повторная запись той же части заменяет прежнюю.

    Замена нужна для пересборки раздела: иначе в работе копились бы
    дубли, и пользователь не понимал бы, какой вариант пойдёт в документ.
    """
    if position is None:
        res = await session.execute(
            select(func.coalesce(func.max(WorkPiece.position), -1)).where(
                WorkPiece.work_id == work.id
            )
        )
        position = int(res.scalar_one()) + 1
    else:
        await session.execute(
            delete(WorkPiece).where(
                WorkPiece.work_id == work.id, WorkPiece.position == position
            )
        )

    piece = WorkPiece(
        id=new_id(),
        work_id=work.id,
        position=position,
        kind=kind,
        number=number,
        heading=heading[:500],
        text=text,
        chars=chars_no_space(text),
    )
    session.add(piece)
    work.updated_at = _now()
    await session.commit()
    await session.refresh(piece)
    return piece


async def update_work(
    session: AsyncSession,
    work: Work,
    topic: str | None = None,
    plan: str | None = None,
    settings_json: str | None = None,
    status: str | None = None,
) -> Work:
    if topic is not None:
        work.topic = topic.strip()[:500]
    if plan is not None:
        work.plan = plan
    if settings_json is not None:
        work.settings_json = settings_json
    if status is not None:
        work.status = status
    work.updated_at = _now()
    await session.commit()
    await session.refresh(work)
    return work


async def delete_work(session: AsyncSession, work: Work) -> None:
    await session.delete(work)
    await session.commit()


def work_to_dict(work: Work, with_text: bool = True) -> dict:
    return {
        "id": work.id,
        "topic": work.topic,
        "plan": work.plan,
        "settings_json": work.settings_json,
        "status": work.status,
        "created_at": work.created_at.isoformat() if work.created_at else None,
        "updated_at": work.updated_at.isoformat() if work.updated_at else None,
        "pieces": [
            {
                "id": p.id,
                "position": p.position,
                "kind": p.kind,
                "number": p.number,
                "heading": p.heading,
                "chars": p.chars,
                **({"text": p.text} if with_text else {}),
            }
            for p in work.pieces
        ],
    }
