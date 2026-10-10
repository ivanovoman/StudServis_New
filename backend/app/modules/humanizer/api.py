"""API диагностики текста."""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.modules.humanizer.diagnostics import AUTHOR_CORPUS_SIZE, diagnose

router = APIRouter(prefix="/humanizer", tags=["humanizer"])


class AnalyzeIn(BaseModel):
    text: str = Field(min_length=1, max_length=200_000)


@router.post("/analyze")
def analyze(payload: AnalyzeIn) -> dict:
    """Разбор текста по кластерам: что именно переписать.

    Возвращает конкретные претензии с указанием, насколько текст вышел
    за диапазон автора, и готовые задания на переписывание. Итоговый
    pAI отдаётся отдельно и помечен как справочный.
    """
    d = diagnose(payload.text)
    out = d.to_dict()
    out["author_corpus_size"] = AUTHOR_CORPUS_SIZE
    return out
