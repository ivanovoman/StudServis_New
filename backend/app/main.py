"""Core & API — точка входа FastAPI."""

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.modules.ai_engine.router import get_router
from app.modules.documents.api import router as documents_router
from app.modules.ai_engine.api import router as ai_router
from app.modules.humanizer.api import router as humanizer_router
from app.modules.projects.api import router as projects_router

logging.basicConfig(
    level=logging.DEBUG if settings.debug else logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title=settings.app_name,
    version="0.2.0",
    description="Генератор курсовых работ: RAG, ГОСТ-вёрстка, проверка источников",
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
