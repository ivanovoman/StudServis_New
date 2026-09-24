"""Подключение к базе данных.

По ТЗ хранилище — PostgreSQL. Но требовать его для локального запуска
нельзя: человек, который просто хочет посмотреть сервис, не станет
поднимать сервер БД, а без хранения работа теряется при закрытии вкладки
— ровно та проблема, ради которой этот модуль и написан.

Поэтому адрес БД берётся так:

1. переменная ``DATABASE_URL`` — если задана, используется она
   (``postgresql+asyncpg://user:pass@host/db``);
2. иначе, если в окружении заданы настройки PostgreSQL и он доступен —
   собирается адрес из них;
3. иначе — файл SQLite в ``storage/works.db``.

Весь код работает через SQLAlchemy и одинаков для обоих движков, так
что переезд на PostgreSQL — это смена одной переменной, а не правка
запросов.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.config import settings


class Base(DeclarativeBase):
    """Общий базовый класс для всех таблиц."""


def resolve_database_url() -> str:
    """Адрес БД: явная переменная, иначе SQLite рядом с файлами."""
    explicit = os.getenv("DATABASE_URL", "").strip()
    if explicit:
        return explicit

    storage = settings.storage_dir
    storage.mkdir(parents=True, exist_ok=True)
    return f"sqlite+aiosqlite:///{storage / 'works.db'}"


_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    """Движок создаётся лениво: при импорте модуля БД может быть не нужна."""
    global _engine
    if _engine is None:
        url = resolve_database_url()
        # SQLite не любит обращения из разных потоков; FastAPI ходит
        # в БД из пула, поэтому проверку потока отключаем.
        kwargs: dict = {"echo": False, "future": True}
        if url.startswith("sqlite"):
            kwargs["connect_args"] = {"check_same_thread": False}
        _engine = create_async_engine(url, **kwargs)
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(
            get_engine(), expire_on_commit=False, class_=AsyncSession
        )
    return _session_factory


async def init_models() -> None:
    """Создать таблицы, которых ещё нет.

    Для SQLite этого достаточно. На PostgreSQL в проде схему будет вести
    Alembic, но сейчас миграций нет, и create_all — честный минимум,
    который не мешает добавить их позже.
    """
    # Импорт внутри функции, иначе получается кольцо:
    # db -> works -> db.
    from app.modules.projects import works  # noqa: F401

    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def get_session() -> AsyncIterator[AsyncSession]:
    """Зависимость FastAPI: сессия на один запрос."""
    factory = get_session_factory()
    async with factory() as session:
        yield session


async def reset_engine() -> None:
    """Сбросить движок — нужно тестам, которые подменяют DATABASE_URL."""
    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _session_factory = None
