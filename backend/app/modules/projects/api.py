"""API предварительных настроек работы.

Фронтенд получает описание полей (`/preferences/schema`), показывает
форму, отправляет выбор обратно и получает человекочитаемую сводку для
подтверждения перед запуском генерации.
"""

from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app.modules.projects.methodichka import build_preferences
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


class SetupIn(BaseModel):
    """Полная настройка до генерации: методичка + пожелания + форма."""
    preset: str | None = None
    methodichka_text: str = Field(default="", max_length=200_000)
    wishes_text: str = Field(default="", max_length=5_000)
    explicit: dict = Field(default_factory=dict)


@router.post("/setup")
def setup(payload: SetupIn) -> dict:
    """Собирает настройки из методички, пожеланий и явного выбора.

    Возвращает не только результат, но и обоснование каждого
    распознанного требования — пользователь должен видеть, откуда
    взялось значение, и иметь возможность его поправить.
    """
    base = None
    if payload.preset:
        if payload.preset not in PRESETS:
            raise HTTPException(
                status_code=404,
                detail=f"неизвестный пресет {payload.preset}; доступны: {list(PRESETS)}",
            )
        base = PRESETS[payload.preset]

    try:
        prefs, m_res, w_res = build_preferences(
            base=base,
            methodichka_text=payload.methodichka_text,
            wishes_text=payload.wishes_text,
            explicit=payload.explicit or None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    def _dump(res):
        return [
            {
                "field": f.field, "value": f.value,
                "quote": f.short_quote(), "confidence": f.confidence,
            }
            for f in res.findings
        ]

    return {
        "ok": True,
        "summary": prefs.summary(),
        "preferences": prefs.to_dict(),
        "from_methodichka": _dump(m_res),
        "from_wishes": _dump(w_res),
        "notes": m_res.unparsed_notes,
        "needs_confirmation": bool(m_res.findings or w_res.findings),
    }


# ------------------------------------------------- загрузка файлов

#: Сколько файлов принимаем за раз. Больше — это уже не подборка
#: к курсовой, а выгрузка библиотеки.
MAX_UPLOAD_FILES = 10


@router.post("/upload/methodichka")
async def upload_methodichka(file: UploadFile = File(...)) -> dict:
    """Разобрать методичку из файла PDF/DOCX/TXT.

    До сих пор методичку можно было только вставить текстом. Просить
    пользователя копировать двадцать страниц из PDF — плохая идея:
    он скопирует не всё и потеряет как раз требования к объёму.
    """
    from app.modules.sources.user_upload import UploadError, extract_text

    data = await file.read()
    try:
        text = extract_text(file.filename or "methodichka", data)
    except UploadError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    prefs, m_res, _ = build_preferences(methodichka_text=text)
    return {
        "filename": file.filename,
        "chars": len(text),
        "text": text[:200_000],
        "found": [
            {"field": f.field, "value": f.value,
             "quote": f.short_quote(), "confidence": f.confidence}
            for f in m_res.findings
        ],
        "needs_confirmation": bool(m_res.findings),
        "report": m_res.report(),
    }


@router.post("/upload/sources")
async def upload_sources(
    files: list[UploadFile] = File(...),
    titles: str = Form(default=""),
) -> dict:
    """Принять источники, которые пользователь подобрал сам.

    Автопоиск находит не всё: по узкой теме он честно сообщает, что
    релевантных работ нет. Плюс научный руководитель может требовать
    опереться на конкретные статьи. Такие источники загружаются здесь.

    Файлы разбираются независимо: ошибка в одном не отменяет
    остальные. Пользователь увидит, что принято и что нет.
    """
    from app.modules.sources.user_upload import (
        UploadError, load_uploaded_source)

    if len(files) > MAX_UPLOAD_FILES:
        raise HTTPException(
            status_code=422,
            detail=f"за раз можно загрузить не больше {MAX_UPLOAD_FILES} файлов",
        )

    manual_titles = [t.strip() for t in titles.split("|")] if titles else []

    accepted: list[dict] = []
    rejected: list[dict] = []

    for i, file in enumerate(files):
        name = file.filename or f"файл {i + 1}"
        try:
            data = await file.read()
            title = manual_titles[i] if i < len(manual_titles) else None
            result = load_uploaded_source(name, data, title=title or None)
        except UploadError as exc:
            rejected.append({"filename": name, "reason": str(exc)})
            continue
        except Exception as exc:
            rejected.append({
                "filename": name,
                "reason": f"неожиданная ошибка разбора: {exc}",
            })
            continue
        accepted.append(result.to_dict())

    return {
        "accepted": accepted,
        "rejected": rejected,
        "total_chars": sum(a["chars"] for a in accepted),
    }
