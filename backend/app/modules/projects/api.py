"""API предварительных настроек работы.

Фронтенд получает описание полей (`/preferences/schema`), показывает
форму, отправляет выбор обратно и получает человекочитаемую сводку для
подтверждения перед запуском генерации.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.modules.projects.preferences import (
    PRESETS,
    Requirement,
    Subject,
    WorkKind,
    WorkPreferences,
)

router = APIRouter(prefix="/projects", tags=["projects"])


class PreferencesIn(BaseModel):
    kind: WorkKind = WorkKind.coursework
    subject: Subject = Subject.legal
    topic: str = ""
    chapters: int | None = Field(default=None, ge=1, le=6)
    chapter_conclusions: bool = True
    theses_per_section: tuple[int, int] = (3, 8)
    cases: Requirement = Requirement.when_relevant
    min_cases_per_section: int = Field(default=0, ge=0, le=10)
    tables: Requirement = Requirement.when_relevant
    charts: Requirement = Requirement.when_relevant
    forbid_empty_visuals: bool = True
    law_proposals: Requirement = Requirement.when_relevant
    liveliness: str = "normal"
    cliche_policy: str = "author_level"


@router.get("/preferences/schema")
def preferences_schema() -> dict:
    """Описание полей формы — чтобы фронтенд не хардкодил варианты."""
    return {
        "fields": [
            {
                "name": "kind", "label": "Вид работы", "type": "select",
                "options": [
                    {"value": "coursework", "label": "Курсовая"},
                    {"value": "diploma", "label": "Диплом / ВКР"},
                    {"value": "thesis", "label": "Диссертация"},
                ],
                "hint": "От вида зависят объёмы и нужна ли гипотеза",
            },
            {
                "name": "subject", "label": "Предмет", "type": "select",
                "options": [
                    {"value": "legal", "label": "Юридическая"},
                    {"value": "economics", "label": "Экономическая"},
                    {"value": "other", "label": "Другое"},
                ],
                "hint": "Определяет требования к ссылкам на нормы и практику",
            },
            {
                "name": "chapters", "label": "Число глав", "type": "select",
                "options": [
                    {"value": None, "label": "Авто (2 или 3)"},
                    {"value": 2, "label": "2 главы"},
                    {"value": 3, "label": "3 главы"},
                ],
                "hint": "Задайте явно, если методичка требует конкретное число",
            },
            {
                "name": "theses_per_section",
                "label": "Пунктов в разделе", "type": "range",
                "min": 2, "max": 15, "default": [3, 8],
                "hint": "Сложная многогранная тема требует больше пунктов, "
                        "чем узкая",
            },
            {
                "name": "cases", "label": "Судебная практика",
                "type": "requirement",
                "hint": "Кейсы могут быть, а могут и не быть — зависит от темы",
            },
            {
                "name": "tables", "label": "Таблицы", "type": "requirement",
                "hint": "Там, где уместны. Таблица должна дополнять мысль, "
                        "а не повторять её",
            },
            {
                "name": "charts", "label": "Графики", "type": "requirement",
                "hint": "Там, где уместны",
            },
            {
                "name": "law_proposals",
                "label": "Предложения по законодательству",
                "type": "requirement",
                "hint": "В юридической работе желательны, но должны быть "
                        "обоснованы",
            },
            {
                "name": "liveliness", "label": "Живость изложения",
                "type": "select",
                "options": [
                    {"value": "normal", "label": "Обычная для науки"},
                    {"value": "high", "label": "Повышенная (легче читается)"},
                ],
                "hint": "Живость уместна и в научной работе: у автора "
                        "каждое седьмое предложение короткое",
            },
            {
                "name": "cliche_policy", "label": "Отношение к клише",
                "type": "select",
                "options": [
                    {"value": "author_level",
                     "label": "Как у автора (рекомендуется)"},
                    {"value": "strict", "label": "Полностью убирать"},
                ],
                "hint": "Жёсткий ноль сделает текст непохожим на авторский",
            },
        ],
        "requirement_options": [
            {"value": "required", "label": "Обязательно"},
            {"value": "when_relevant", "label": "Где уместно"},
            {"value": "forbidden", "label": "Не нужно"},
        ],
        "presets": {
            name: p.to_dict() for name, p in PRESETS.items()
        },
    }


@router.post("/preferences/validate")
def validate_preferences(payload: PreferencesIn) -> dict:
    """Проверяет настройки и возвращает сводку для подтверждения."""
    try:
        prefs = WorkPreferences.from_dict(payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    vol = prefs.resolved_volumes()
    return {
        "ok": True,
        "summary": prefs.summary(),
        "resolved": {
            "chapters_allowed": list(prefs.allowed_chapter_counts),
            "needs_hypothesis": prefs.needs_hypothesis,
            "expects_law_proposals": prefs.expects_law_proposals,
            "volumes": {
                "intro": [vol.intro_min, vol.intro_max],
                "section": [vol.section_min, vol.section_max],
                "conclusion": [vol.conclusion_min, vol.conclusion_max],
            },
        },
        "preferences": prefs.to_dict(),
    }


@router.get("/preferences/preset/{name}")
def get_preset(name: str) -> dict:
    if name not in PRESETS:
        raise HTTPException(
            status_code=404,
            detail=f"неизвестный пресет {name}; доступны: {list(PRESETS)}",
        )
    p = PRESETS[name]
    return {"name": name, "preferences": p.to_dict(), "summary": p.summary()}
