"""HTTP-интерфейс хранения работ.

Ключ владельца приходит в заголовке ``X-Owner-Key``. В теле запроса его
намеренно нет: так он не попадёт в сохранённый JSON и его труднее
случайно залогировать вместе с телом.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.modules.projects import works as store

router = APIRouter(prefix="/works", tags=["works"])


async def owner_key(x_owner_key: str = Header(default="")) -> str:
    """Проверка ключа владельца.

    Слишком короткий ключ отбиваем: он означает либо ошибку клиента,
    либо попытку подобрать чужой.
    """
    key = (x_owner_key or "").strip()
    if len(key) < store.OWNER_KEY_MIN:
        raise HTTPException(
            status_code=400,
            detail=(
                "Нужен заголовок X-Owner-Key длиной не меньше "
                f"{store.OWNER_KEY_MIN} символов. Его заводит браузер при "
                "первом открытии сервиса."
            ),
        )
    return key[: store.OWNER_KEY_MAX]


class WorkCreate(BaseModel):
    topic: str = ""
    plan: str = ""
    settings: dict = Field(default_factory=dict)


class WorkPatch(BaseModel):
    topic: str | None = None
    plan: str | None = None
    settings: dict | None = None
    status: str | None = None


class PieceIn(BaseModel):
    kind: str
    heading: str = ""
    text: str
    number: str | None = None
    position: int | None = None


ALLOWED_KINDS = {"introduction", "section", "conclusion"}
ALLOWED_STATUS = {"draft", "assembling", "done"}


async def _load(session: AsyncSession, work_id: str, key: str):
    work = await store.get_work(session, work_id, key)
    if work is None:
        # Одна и та же формулировка для «нет такой» и «чужая»: иначе по
        # разнице ответов можно перебором узнать, какие id существуют.
        raise HTTPException(status_code=404, detail="Работа не найдена")
    return work


@router.post("")
async def create_work(
    body: WorkCreate,
    key: str = Depends(owner_key),
    session: AsyncSession = Depends(get_session),
):
    work = await store.create_work(
        session,
        owner_key=key,
        topic=body.topic,
        plan=body.plan,
        settings_json=json.dumps(body.settings, ensure_ascii=False),
    )
    return {"id": work.id, "status": work.status}


@router.get("")
async def list_works(
    limit: int = Query(default=100, ge=1, le=500),
    key: str = Depends(owner_key),
    session: AsyncSession = Depends(get_session),
):
    items = await store.list_works(session, key, limit=limit)
    return {"count": len(items), "works": items}


@router.get("/{work_id}")
async def get_work(
    work_id: str,
    key: str = Depends(owner_key),
    session: AsyncSession = Depends(get_session),
):
    work = await _load(session, work_id, key)
    return store.work_to_dict(work)


@router.patch("/{work_id}")
async def patch_work(
    work_id: str,
    body: WorkPatch,
    key: str = Depends(owner_key),
    session: AsyncSession = Depends(get_session),
):
    if body.status is not None and body.status not in ALLOWED_STATUS:
        raise HTTPException(
            status_code=400,
            detail=f"status должен быть одним из: {', '.join(sorted(ALLOWED_STATUS))}",
        )
    work = await _load(session, work_id, key)
    await store.update_work(
        session,
        work,
        topic=body.topic,
        plan=body.plan,
        settings_json=(
            json.dumps(body.settings, ensure_ascii=False)
            if body.settings is not None
            else None
        ),
        status=body.status,
    )
    return store.work_to_dict(work, with_text=False)


@router.post("/{work_id}/pieces")
async def add_piece(
    work_id: str,
    body: PieceIn,
    key: str = Depends(owner_key),
    session: AsyncSession = Depends(get_session),
):
    if body.kind not in ALLOWED_KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"kind должен быть одним из: {', '.join(sorted(ALLOWED_KINDS))}",
        )
    work = await _load(session, work_id, key)
    piece = await store.add_piece(
        session,
        work,
        kind=body.kind,
        heading=body.heading,
        text=body.text,
        number=body.number,
        position=body.position,
    )
    return {
        "id": piece.id,
        "position": piece.position,
        "chars": piece.chars,
        "work_id": work.id,
    }


@router.delete("/{work_id}")
async def delete_work(
    work_id: str,
    key: str = Depends(owner_key),
    session: AsyncSession = Depends(get_session),
):
    work = await _load(session, work_id, key)
    await store.delete_work(session, work)
    return {"deleted": work_id}
