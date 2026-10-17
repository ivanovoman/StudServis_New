"""HTTP-интерфейс входа.

## Как браузер предъявляет себя

Заголовком `Authorization: Bearer <токен>`. Токен выдаётся при
регистрации и входе, браузер хранит его у себя.

Печенье (cookie) было бы удобнее — оно отправляется само и недоступно
чужому скрипту при флаге HttpOnly. Но тогда нужна защита от CSRF, а
статика у нас отдаётся с другого порта, чем API. Заголовок проще и
честнее; к печенью вернёмся, когда фронтенд и API будут за одним
доменом.

## Ограничение попыток

Пароль из восьми символов перебирается за разумное время, если пробовать
без счёта. Поэтому попытки входа считаются по адресу почты и по IP:
превысил — подожди. Счётчик живёт в памяти процесса: для одного сервера
этого достаточно, а когда их станет несколько, счётчик переедет в Redis
вместе с очередями.
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.modules.auth import service
from app.modules.auth.models import SESSION_TTL, User

log = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

#: Сколько неудачных попыток подряд допустимо и на сколько потом
#: запирается вход. Пять попыток покрывают обычные опечатки, пятнадцать
#: минут делают перебор бессмысленным.
MAX_ATTEMPTS = 5
LOCKOUT_SECONDS = 15 * 60

_attempts: dict[str, list[float]] = defaultdict(list)


def _too_many_attempts(key: str) -> bool:
    """Считает неудачи за последние LOCKOUT_SECONDS."""
    now = time.time()
    recent = [t for t in _attempts[key] if now - t < LOCKOUT_SECONDS]
    _attempts[key] = recent
    return len(recent) >= MAX_ATTEMPTS


def _remember_failure(key: str) -> None:
    _attempts[key].append(time.time())


def _forget_failures(key: str) -> None:
    _attempts.pop(key, None)


def reset_attempts() -> None:
    """Сбрасывает счётчики. Нужно тестам, чтобы не влиять друг на друга."""
    _attempts.clear()


# ------------------------------------------------------------- схемы

class RegisterIn(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=200)
    display_name: str = Field(default="", max_length=200)
    #: Ключ браузера, под которым работы собирались до регистрации.
    #: Если прислан — эти работы достанутся новой учётной записи.
    owner_key: str = Field(default="", max_length=128)


class LoginIn(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=200)
    owner_key: str = Field(default="", max_length=128)


class PasswordChangeIn(BaseModel):
    old_password: str = Field(max_length=200)
    new_password: str = Field(max_length=200)


def _user_out(user: User, *, claimed: int = 0) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "display_name": user.display_name,
        "claimed_works": claimed,
    }


# --------------------------------------------------------- зависимости

async def current_user(
    authorization: str = Header(default=""),
    session: AsyncSession = Depends(get_session),
) -> User:
    """Пользователь по токену. Без токена — 401."""
    token = ""
    if authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()

    user = await service.resolve_token(session, token) if token else None
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Нужно войти",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


async def optional_user(
    authorization: str = Header(default=""),
    session: AsyncSession = Depends(get_session),
) -> User | None:
    """Пользователь, если вошёл. Иначе None — без ошибки.

    Нужно там, где вход необязателен: бесплатные функции работают и без
    учётной записи, как вы и просили.
    """
    if not authorization.lower().startswith("bearer "):
        return None
    return await service.resolve_token(session, authorization[7:].strip())


def _token_of(authorization: str) -> str:
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return ""


# ------------------------------------------------------------ маршруты

@router.post("/register", summary="Регистрация", status_code=201)
async def register(payload: RegisterIn, request: Request,
                   session: AsyncSession = Depends(get_session)) -> dict:
    try:
        user = await service.register(
            session, payload.email, payload.password,
            display_name=payload.display_name)
    except service.EmailTaken as err:
        raise HTTPException(status_code=409, detail=str(err)) from err
    except service.AuthError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err

    # Работы, собранные до регистрации, достаются новому пользователю:
    # иначе регистрация выглядит как их потеря.
    claimed = await service.claim_works(session, user, payload.owner_key)

    token, _ = await service.start_session(
        session, user, user_agent=request.headers.get("user-agent", ""))
    await session.commit()

    return {
        "token": token,
        "expires_in": int(SESSION_TTL.total_seconds()),
        "user": _user_out(user, claimed=claimed),
    }


@router.post("/login", summary="Вход")
async def login(payload: LoginIn, request: Request,
                session: AsyncSession = Depends(get_session)) -> dict:
    email_key = service.normalize_email(payload.email)
    ip_key = f"ip:{request.client.host if request.client else 'unknown'}"

    for key in (email_key, ip_key):
        if _too_many_attempts(key):
            raise HTTPException(
                status_code=429,
                detail="Слишком много попыток входа. Повторите через "
                       "15 минут.",
            )

    try:
        user = await service.authenticate(session, payload.email,
                                          payload.password)
    except service.BadCredentials as err:
        _remember_failure(email_key)
        _remember_failure(ip_key)
        log.info("Неудачный вход: %s", email_key)
        raise HTTPException(status_code=401, detail=str(err)) from err

    _forget_failures(email_key)
    _forget_failures(ip_key)

    claimed = await service.claim_works(session, user, payload.owner_key)
    token, _ = await service.start_session(
        session, user, user_agent=request.headers.get("user-agent", ""))
    await session.commit()

    return {
        "token": token,
        "expires_in": int(SESSION_TTL.total_seconds()),
        "user": _user_out(user, claimed=claimed),
    }


@router.post("/logout", summary="Выход")
async def logout(authorization: str = Header(default=""),
                 session: AsyncSession = Depends(get_session)) -> dict:
    token = _token_of(authorization)
    closed = await service.end_session(session, token) if token else False
    await session.commit()
    # Отвечаем успехом в любом случае: «выйти» не должно падать оттого,
    # что сеанс уже закрыт в другой вкладке.
    return {"ok": True, "closed": closed}


@router.post("/logout-all", summary="Выход на всех устройствах")
async def logout_all(user: User = Depends(current_user),
                     authorization: str = Header(default=""),
                     session: AsyncSession = Depends(get_session)) -> dict:
    closed = await service.end_all_sessions(
        session, user, keep_token=_token_of(authorization))
    await session.commit()
    return {"ok": True, "closed": closed}


@router.get("/me", summary="Кто я")
async def me(user: User = Depends(current_user)) -> dict:
    return _user_out(user)


@router.post("/password", summary="Смена пароля")
async def change_password(payload: PasswordChangeIn,
                          user: User = Depends(current_user),
                          authorization: str = Header(default=""),
                          session: AsyncSession = Depends(get_session)) -> dict:
    try:
        await service.change_password(
            session, user, payload.old_password, payload.new_password,
            keep_token=_token_of(authorization))
    except service.BadCredentials as err:
        raise HTTPException(status_code=401, detail=str(err)) from err
    except service.AuthError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err

    await session.commit()
    return {"ok": True}
