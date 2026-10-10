"""Учётные записи и сеансы входа.

## Что здесь хранится

Две таблицы. `users` — сама учётная запись: почта, хеш пароля, дата
создания. `login_sessions` — активные входы: по одной строке на каждое
устройство, с которого человек вошёл.

## Почему сеансы в базе, а не JWT

JWT не отзывается. Пока он не истёк, им можно пользоваться — даже если
человек нажал «выйти», сменил пароль или заметил, что его взломали.
Обходят это чёрными списками, то есть всё равно приходят к таблице в
базе, только более запутанным путём.

Здесь таблица с самого начала: «выйти» удаляет строку, «выйти везде» —
все строки пользователя. Смена пароля закрывает все сеансы, кроме
текущего.

Цена — запрос к базе на каждую проверку токена. Для нашей нагрузки это
несущественно: сборка курсовой занимает минуты, лишний запрос на
несколько миллисекунд там не виден.

## Почему работы не переезжают на user_id немедленно

Работы уже лежат в базе, привязанные к `owner_key` — случайной строке
из браузера. Просто удалить это поле значит стереть чужие черновики.
Поэтому у работы теперь два владельца: `user_id` для тех, кто вошёл, и
прежний `owner_key` для тех, кто ещё нет. При первом входе работы,
собранные до регистрации, можно присвоить учётной записи — этим
занимается `claim_works` в сервисе.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import DateTime, ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

#: Сколько живёт сеанс без повторного входа. Тридцать дней — привычный
#: для веба срок: реже, чем раз в месяц, вводить пароль не раздражает,
#: а забытый в чужом браузере вход не остаётся навсегда.
SESSION_TTL = timedelta(days=30)

EMAIL_MAX = 254          # предел длины адреса по RFC 5321
PASSWORD_HASH_MAX = 255


def _now() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return uuid.uuid4().hex


class User(Base):
    """Учётная запись."""

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True,
                                    default=new_id)
    #: Почта хранится уже приведённой к нижнему регистру.
    email: Mapped[str] = mapped_column(String(EMAIL_MAX), unique=True,
                                       nullable=False)
    password_hash: Mapped[str] = mapped_column(String(PASSWORD_HASH_MAX),
                                               nullable=False)

    #: Имя необязательно: просить его при регистрации незачем, а на
    #: титульном листе оно берётся из настроек работы.
    display_name: Mapped[str] = mapped_column(String(200), default="")

    #: Выключенная запись не может войти. Удалять учётку целиком
    #: нельзя — вместе с ней уйдут работы.
    is_active: Mapped[bool] = mapped_column(default=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 default=_now)
    last_login_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True)

    sessions: Mapped[list["LoginSession"]] = relationship(
        back_populates="user", cascade="all, delete-orphan", lazy="selectin")


class LoginSession(Base):
    """Один вход с одного устройства."""

    __tablename__ = "login_sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True,
                                    default=new_id)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    #: SHA-256 от токена. Сам токен есть только у браузера: если база
    #: утечёт, войти по её содержимому будет нельзя.
    token_hash: Mapped[str] = mapped_column(String(64), unique=True,
                                            nullable=False)

    #: Чем человек входил. Нужно, чтобы в списке своих сеансов он узнал
    #: устройство и отключил лишнее.
    user_agent: Mapped[str] = mapped_column(String(300), default="")

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 default=_now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 nullable=False)

    user: Mapped[User] = relationship(back_populates="sessions")

    __table_args__ = (
        # Проверка токена — самый частый запрос во всём приложении.
        Index("ix_sessions_token", "token_hash"),
        Index("ix_sessions_user", "user_id"),
    )

    @property
    def is_expired(self) -> bool:
        expires = self.expires_at
        # SQLite возвращает время без часового пояса — сравнение с
        # aware-датой в этом случае падает с TypeError.
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        return expires <= _now()
