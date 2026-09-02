"""API этапа 1 — анализ темы.

Этап бесплатный и лимитами не ограничивается.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.modules.ai_engine.topic_analysis import analyze_topic
from app.modules.projects.preferences import WorkPreferences

router = APIRouter(prefix="/ai", tags=["ai"])


class AnalyzeTopicIn(BaseModel):
    topic: str = Field(min_length=5, max_length=500)
    preferences: dict = Field(default_factory=dict)


@router.post("/analyze-topic")
async def analyze_topic_endpoint(payload: AnalyzeTopicIn) -> dict:
    """Разбор темы: тезисы, логика, спорные места, направления поиска.

    Возвращает результат вместе с итогом проверки. Даже если проверка
    не пройдена, анализ отдаётся — пользователь видит и результат, и
    претензии к нему.
    """
    try:
        prefs = WorkPreferences.from_dict(payload.preferences)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    try:
        analysis, check = await analyze_topic(payload.topic, prefs=prefs)
    except ValueError as exc:
        # Модель вернула не-JSON.
        raise HTTPException(
            status_code=502,
            detail=f"модель вернула некорректный ответ: {exc}",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"все модели недоступны: {exc}"
        ) from exc

    return {
        "analysis": analysis.to_dict(),
        "check": {
            "passed": check.passed,
            "issues": [
                {"rule": i.rule, "message": i.message, "severity": i.severity}
                for i in check.issues
            ],
        },
    }
