"""Действия с учётными записями: регистрация, вход, выход.

Здесь только логика, без HTTP: так её можно проверить тестами напрямую
и вызвать из фоновой задачи, когда появятся очереди.

## Об ошибках входа

Сервис никогда не сообщает, существует ли адрес. И на незнакомую почту,
и на неверный пароль ответ один: «Неверная почта или пароль». Иначе
форма входа превращается в справочник зарегистрированных пользователей —
подобрать по ней список клиентов сервиса курсовых работ было бы
некрасиво по отношению к этим людям.

По той же причине при неизвестном адресе всё равно считается хеш
пароля: без этого «нет такого пользователя» отвечалось бы за доли
миллисекунды, а «неверный пароль» — за полсотни, и разницу во времени
видно снаружи.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth.models import SESSION_TTL, LoginSession, User, _now
from app.modules.auth.security import (
    WeakPassword,
    hash_password,
    new_token,
    normalize_email,
    token_fingerprint,
    validate_password,
    verify_password,
)

log = logging.getLogger(__name__)

#: Проверка адреса нарочно простая. Полная проверка по RFC отвергает
#: существующие адреса и пропускает несуществующие; единственный
#: надёжный способ — письмо со ссылкой, и оно появится отдельно.
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$")

#: Хеш-заглушка для несуществующих адресов: нужен, чтобы ответ занимал
#: столько же времени, сколько проверка настоящего пароля.
_DUMMY_HASH = hash_password("время-должно-совпадать")


class AuthError(Exception):
    """Ошибка, которую можно показать пользователю."""


class EmailTaken(AuthError):
    pass


class BadCredentials(AuthError):
    pass


def validate_email(email: str) -> str:
    clean = normalize_email(email)
    if not clean or not EMAIL_RE.match(clean):
        raise AuthError("Похоже, в адресе почты опечатка")
    return clean


async def register(session: AsyncSession, email: str, password: str,
                   *, display_name: str = "") -> User:
    """Создаёт учётную запись."""
    clean_email = validate_email(email)
    try:
        validate_password(password)
    except WeakPassword as err:
        raise AuthError(str(err)) from err

    user = User(
        email=clean_email,
        password_hash=hash_password(password),
        display_name=(display_name or "").strip()[:200],
    )
    # Вставка в точке сохранения. Обычный rollback откатил бы всю
    # транзакцию целиком — вместе с тем, что вызывающий код успел
    # сделать до нас. Здесь откатывается только неудавшаяся вставка.
    try:
        async with session.begin_nested():
            session.add(user)
            await session.flush()
    except IntegrityError as err:
        # Гонка двух одновременных регистраций на один адрес: уникальный
        # индекс — единственная надёжная защита, проверка «есть ли уже
        # такой» её не заменяет.
        raise EmailTaken("Такая почта уже зарегистрирована") from err

    return user


async def authenticate(session: AsyncSession, email: str,
                       password: str) -> User:
    """Проверяет почту и пароль. Бросает BadCredentials."""
    clean_email = normalize_email(email)
    found = await session.scalar(
        select(User).where(User.email == clean_email))

    stored = found.password_hash if found else _DUMMY_HASH
    ok = verify_password(password, stored)

    if not found or not ok:
        raise BadCredentials("Неверная почта или пароль")
    if not found.is_active:
        raise BadCredentials("Учётная запись отключена")

    return found


async def start_session(session: AsyncSession, user: User,
                        *, user_agent: str = "") -> tuple[str, LoginSession]:
    """Открывает сеанс и возвращает токен — он отдаётся браузеру.

    Токен возвращается ровно один раз: в базе лежит только его
    отпечаток, восстановить исходную строку оттуда нельзя.
    """
    token = new_token()
    record = LoginSession(
        user_id=user.id,
        token_hash=token_fingerprint(token),
        user_agent=(user_agent or "")[:300],
        expires_at=_now() + SESSION_TTL,
    )
    session.add(record)

    user.last_login_at = _now()
    await session.flush()
    return token, record


async def resolve_token(session: AsyncSession,
                        token: str) -> User | None:
    """Находит пользователя по токену. Просроченный сеанс удаляет."""
    if not token:
        return None

    record = await session.scalar(
        select(LoginSession).where(
            LoginSession.token_hash == token_fingerprint(token)))
    if record is None:
        return None

    if record.is_expired:
        # Чистим сразу: иначе таблица копит мусор, а следующий запрос
        # снова тратится на ту же проверку.
        await session.delete(record)
        await session.flush()
        return None

    user = await session.get(User, record.user_id)
    if user is None or not user.is_active:
        return None
    return user


async def end_session(session: AsyncSession, token: str) -> bool:
    """Выход с текущего устройства."""
    record = await session.scalar(
        select(LoginSession).where(
            LoginSession.token_hash == token_fingerprint(token)))
    if record is None:
        return False
    await session.delete(record)
    await session.flush()
    return True


async def end_all_sessions(session: AsyncSession, user: User,
                           *, keep_token: str = "") -> int:
    """Выход на всех устройствах. Возвращает число закрытых сеансов."""
    records = await session.scalars(
        select(LoginSession).where(LoginSession.user_id == user.id))
    keep = token_fingerprint(keep_token) if keep_token else None

    closed = 0
    for record in records:
        if keep and record.token_hash == keep:
            continue
        await session.delete(record)
        closed += 1

    await session.flush()
    return closed


async def change_password(session: AsyncSession, user: User,
                          old_password: str, new_password: str,
                          *, keep_token: str = "") -> None:
    """Смена пароля.

    Старый пароль спрашиваем обязательно: иначе чужой человек, добравшийся
    до незаблокированного компьютера, сменит пароль и заберёт учётку.

    Все прочие сеансы после смены закрываются — если пароль меняют из-за
    подозрений, взломщик должен вылететь немедленно.
    """
    if not verify_password(old_password, user.password_hash):
        raise BadCredentials("Текущий пароль указан неверно")
    try:
        validate_password(new_password)
    except WeakPassword as err:
        raise AuthError(str(err)) from err

    user.password_hash = hash_password(new_password)
    await end_all_sessions(session, user, keep_token=keep_token)
    await session.flush()


async def claim_works(session: AsyncSession, user: User,
                      owner_key: str) -> int:
    """Присваивает пользователю работы, собранные до регистрации.

    До появления входа работы привязывались к случайному ключу из
    браузера. Человек, который собрал курсовую, а потом решил
    зарегистрироваться, должен найти её на месте — иначе регистрация
    выглядит как потеря работы.

    Возвращает число присвоенных работ.
    """
    if not owner_key:
        return 0

    # Импорт внутри функции: модуль работ не должен зависеть от auth,
    # и наоборот — иначе получится кольцо.
    from app.modules.projects.works import Work

    result = await session.execute(
        update(Work)
        .where(Work.owner_key == owner_key, Work.user_id.is_(None))
        .values(user_id=user.id)
    )
    await session.flush()

    count = result.rowcount or 0
    if count:
        log.info("Пользователю %s присвоено работ: %d", user.email, count)
    return count
