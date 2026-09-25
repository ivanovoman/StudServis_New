"""Core & API — точка входа FastAPI."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.modules.ai_engine.router import get_router
from app.modules.documents.api import router as documents_router
from app.modules.ai_engine.api import router as ai_router
from app.modules.humanizer.api import router as humanizer_router
from app.modules.projects.api import router as projects_router
from app.modules.projects.works_api import router as works_router
from app.modules.sources.api import router as sources_router

logging.basicConfig(
    level=logging.DEBUG if settings.debug else logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
)
logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Создать таблицы хранения работ при старте.

    Без этого первый же запрос к /works упал бы с «no such table», а
    человек решил бы, что сервис сломан. Операция идемпотентная.

    Падать на старте нельзя: без БД остальные модули — разбор темы,
    ГОСТ-экспорт, детектор — работают и нужны.
    """
    from app.db import init_models

    # Ключи из .env читает pydantic, а модули научных баз — обычное
    # окружение. Прокидываем, иначе ключ лежит в файле и не работает:
    # именно так OpenAlex однажды и «перестал искать».
    if settings.openalex_api_key:
        os.environ.setdefault("OPENALEX_API_KEY", settings.openalex_api_key)
    if settings.openalex_email:
        os.environ.setdefault("OPENALEX_EMAIL", settings.openalex_email)

    try:
        await init_models()
    except Exception as exc:  # noqa: BLE001
        logger.error("Хранение работ недоступно: %s", exc)
    yield


app = FastAPI(
    title=settings.app_name,
    version="0.2.0",
    description="Генератор курсовых работ: RAG, ГОСТ-вёрстка, проверка источников",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(documents_router, prefix=settings.api_prefix)
app.include_router(projects_router, prefix=settings.api_prefix)
app.include_router(humanizer_router, prefix=settings.api_prefix)
app.include_router(ai_router, prefix=settings.api_prefix)
app.include_router(sources_router, prefix=settings.api_prefix)
app.include_router(works_router, prefix=settings.api_prefix)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request, exc: Exception):
    logger.exception("Необработанная ошибка на %s", request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Внутренняя ошибка сервера", "error": str(exc)},
    )


@app.get(f"{settings.api_prefix}/health", tags=["core"])
async def health() -> dict:
    """Статус сервиса и конфигурации моделей."""
    try:
        router = get_router()
        models = [m.id for m in router.models]
        stats = router.stats_report()
    except Exception as e:  # noqa: BLE001
        models, stats = [], []
        logger.error("AI Router не инициализирован: %s", e)

    return {
        "ok": True,
        "app": settings.app_name,
        "has_openrouter_key": bool(settings.openrouter_api_key),
        "models": models,
        "model_stats": stats,
        "vector_db": "qdrant",
        "modules": {
            "core": "ready",
            "documents": "ready",
            "ai_engine": "ready",
            "rag_service": "planned",
            "auth": "planned",
            "projects": "planned",
            "sources": "planned",
            "humanizer": "planned",
            "payments": "planned",
            "tasks": "planned",
        },
    }
