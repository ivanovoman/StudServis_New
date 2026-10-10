"""Схема БД и подключение (PostgreSQL, async SQLAlchemy 2.0).

Таблицы соответствуют схеме из ТЗ: users, projects, project_sections,
sources, transactions.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    ARRAY,
    Boolean,
    DateTime,
    Enum as SAEnum,
    Float,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from app.config import settings


class Base(DeclarativeBase):
    pass


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


# ------------------------------------------------------------------ enums

class UserRole(str, enum.Enum):
    student = "student"
    admin = "admin"


class WorkStatus(str, enum.Enum):
    """Состояния конвейера генерации (см. Generation Pipeline в ТЗ)."""
    draft = "draft"
    analysis = "analysis"
    planning = "planning"
    generating = "generating"
    verifying = "verifying"
    humanizing = "humanizing"
    formatting = "formatting"
    completed = "completed"
    failed = "failed"


class SectionType(str, enum.Enum):
    intro = "intro"
    chapter = "chapter"
    conclusion = "conclusion"
    bibliography = "bibliography"


class TransactionStatus(str, enum.Enum):
    pending = "pending"
    succeeded = "succeeded"
    failed = "failed"
    canceled = "canceled"


# ----------------------------------------------------------------- модели

class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = _uuid_pk()
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[UserRole] = mapped_column(
        SAEnum(UserRole, name="user_role"), default=UserRole.student
    )
    is_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    # Настройки стиля пользователя (в т.ч. ссылка на профиль «Коколов»).
    style_profile: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    projects: Mapped[list["Project"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=True
    )
    topic: Mapped[str] = mapped_column(Text)
    subject: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[WorkStatus] = mapped_column(
        SAEnum(WorkStatus, name="work_status"), default=WorkStatus.draft, index=True
    )
    # Текущий шаг конвейера, например "section_write:1.2".
    current_step: Mapped[str | None] = mapped_column(String(100), nullable=True)
    progress_percent: Mapped[int] = mapped_column(Integer, default=0)
    style_profile: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # Результаты бесплатных этапов — держим прямо в проекте.
    analysis_md: Mapped[str | None] = mapped_column(Text, nullable=True)
    plan_md: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Названия глав/разделов, вытащенные из плана: {"1": "Теория"}.
    chapter_titles: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    section_titles: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_paid: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    user: Mapped["User | None"] = relationship(back_populates="projects")
    sections: Mapped[list["ProjectSection"]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="ProjectSection.number",
    )


class ProjectSection(Base):
    """Работа хранится по частям — так удобнее генерировать и править."""

    __tablename__ = "project_sections"

    id: Mapped[uuid.UUID] = _uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    section_type: Mapped[SectionType] = mapped_column(
        SAEnum(SectionType, name="section_type"), default=SectionType.chapter
    )
    number: Mapped[str | None] = mapped_column(String(20), nullable=True)  # "1.1"
    title: Mapped[str | None] = mapped_column(String(500), nullable=True)
    content_md: Mapped[str | None] = mapped_column(Text, nullable=True)
    content_humanized: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Таблица раздела: {"number": "1.1", "title": "...", "markdown": "|..|"}
    table_data: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    sources_used: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # Оценка вашего ИИ-детектора, 0.0-1.0.
    ai_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    project: Mapped["Project"] = relationship(back_populates="sections")


class Source(Base):
    __tablename__ = "sources"

    id: Mapped[uuid.UUID] = _uuid_pk()
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    title: Mapped[str] = mapped_column(Text)
    authors: Mapped[list[str] | None] = mapped_column(ARRAY(String), nullable=True)
    year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    doi: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # ГЛАВНОЕ ПОЛЕ: в библиографию идут только is_verified=True.
    # Модели уверенно выдумывают номера дел и статей — проверено на практике,
    # см. docs/MODEL_AUDIT.md.
    is_verified: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    verification_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_text_md: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_metadata: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Transaction(Base):
    __tablename__ = "transactions"

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL"), nullable=True
    )
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    currency: Mapped[str] = mapped_column(String(3), default="RUB")
    status: Mapped[TransactionStatus] = mapped_column(
        SAEnum(TransactionStatus, name="transaction_status"),
        default=TransactionStatus.pending,
    )
    yookassa_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


# ------------------------------------------------------------ подключение

engine = create_async_engine(settings.database_url, echo=settings.debug, future=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_session():
    """FastAPI-зависимость: сессия БД на запрос."""
    async with SessionLocal() as session:
        yield session
