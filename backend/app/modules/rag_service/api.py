"""Библиотека материалов пользователя — HTTP-интерфейс.

Ключ владельца приходит в заголовке ``X-Owner-Key`` — тем же способом,
что и для работ: вход в сервис добровольный, а материалы нужны и до
регистрации.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Header, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.modules.rag_service import research
from app.modules.rag_service.library import (
    add_document,
    get_style_samples,
    list_documents,
    remove_document,
    search_documents,
)

router = APIRouter(prefix="/library", tags=["library"])

OWNER_KEY_MIN = 8


async def owner_key(x_owner_key: str = Header(default="")) -> str:
    key = (x_owner_key or "").strip()
    if len(key) < OWNER_KEY_MIN:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Нужен заголовок X-Owner-Key длиной не меньше "
                f"{OWNER_KEY_MIN} знаков"
            ),
        )
    return key


class HarvestIn(BaseModel):
    #: Поисковые формулировки. Их готовит модель, разложив тему на
    #: исследовательские вопросы: по одной формулировке находится
    #: втрое меньше, чем по шести разным.
    queries: list[str] = Field(min_length=1, max_length=12)
    topic: str = Field(default="", max_length=500)
    read_limit: int = Field(default=research.DEFAULT_READ_LIMIT, ge=1, le=25)
    #: Второй круг добычи идёт без очистки: он дополняет первый, а не
    #: заменяет его.
    clear_before: bool = True


class SearchIn(BaseModel):
    query: str = Field(min_length=2)
    limit: int = Field(default=5, ge=1, le=20)


@router.post("/upload", summary="Загрузить материал в библиотеку")
async def upload(
    file: UploadFile = File(...),
    kind: str = "материал",
    key: str = Depends(owner_key),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Принимает PDF, DOCX, RTF или TXT и режет его на фрагменты."""
    from app.modules.sources.user_upload import UploadError, extract_text

    data = await file.read()
    try:
        text = extract_text(file.filename or "документ", data)
    except UploadError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    # Файл без текста — это скан. Распознавания у нас нет, и молчаливо
    # сохранить пустышку хуже, чем честно отказать: человек будет
    # думать, что материал учитывается.
    if len(text.strip()) < 200:
        raise HTTPException(
            status_code=422,
            detail=(
                "В файле почти нет текста. Если это скан, его нужно "
                "сначала распознать — картинку сервис прочитать не может."
            ),
        )

    try:
        doc = await add_document(
            session,
            owner_key=key,
            filename=file.filename or "документ",
            text=text,
            kind=kind,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return {
        "id": doc.id,
        "filename": doc.filename,
        "kind": doc.kind,
        "chars": doc.chars,
        "chunks": doc.chunks,
    }


@router.get("", summary="Что лежит в библиотеке")
async def index(
    key: str = Depends(owner_key),
    session: AsyncSession = Depends(get_session),
) -> dict:
    docs = await list_documents(session, owner_key=key)
    return {
        "count": len(docs),
        "documents": [
            {
                "id": d.id,
                "filename": d.filename,
                "kind": d.kind,
                "chars": d.chars,
                "chunks": d.chunks,
                "created_at": d.created_at.isoformat(),
            }
            for d in docs
        ],
    }


@router.delete("/{doc_id}", summary="Убрать материал")
async def remove(
    doc_id: str,
    key: str = Depends(owner_key),
    session: AsyncSession = Depends(get_session),
) -> dict:
    removed = await remove_document(session, owner_key=key, doc_id=doc_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Документ не найден")
    return {"removed": True}


@router.post("/search", summary="Найти фрагменты по вопросу")
async def search(
    payload: SearchIn,
    key: str = Depends(owner_key),
    session: AsyncSession = Depends(get_session),
) -> dict:
    hits = await search_documents(
        session, owner_key=key, query=payload.query, limit=payload.limit,
    )
    return {"count": len(hits), "hits": hits}


@router.get("/style", summary="Образцы авторской манеры письма")
async def style(
    limit: int = 3,
    key: str = Depends(owner_key),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Отрывки из загруженных образцов стиля.

    Отдаются отдельно от тематического поиска: это материал для
    подражания манере, а не источник содержания.
    """
    samples = await get_style_samples(
        session, owner_key=key, limit=max(1, min(limit, 5)))
    return {"count": len(samples), "samples": samples}


@router.post("/research/harvest", summary="Найти и прочитать статьи целиком")
async def harvest(
    payload: HarvestIn,
    key: str = Depends(owner_key),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Собрать материал для глубокого разбора темы.

    Прежний разбор видел только аннотации — полторы тысячи знаков на
    всю тему, из которых нельзя узнать ни кто с кем спорит, ни где в
    регулировании дыра. Здесь статьи читаются целиком: пятнадцать
    статей дают около трёхсот тысяч знаков, и дальше по ним работает
    обычный поиск библиотеки.
    """
    result = await research.harvest(
        session,
        owner_key=key,
        queries=payload.queries,
        topic=payload.topic,
        read_limit=payload.read_limit,
        clear_before=payload.clear_before,
    )
    return {
        "found": result.found,
        "read": result.read_count,
        "skipped": result.skipped,
        "chars": result.total_chars,
        "articles": [
            {
                "title": a.title,
                "authors": a.authors,
                "year": a.year,
                "journal": a.journal,
                "url": a.url,
                "chars": a.chars,
                "chunks": a.chunks,
            }
            for a in result.read
        ],
    }
