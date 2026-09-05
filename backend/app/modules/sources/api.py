"""API поиска источников.

Нужен фронтенду и Node-серверу перед этапом анализа темы.

Зачем это отдельный эндпоинт, а не часть `/ai/analyze-topic/grounded`:
анализ в интерфейсе идёт потоком (SSE), пользователь видит, как текст
набирается по словам. Готовый grounded-эндпоинт отдаёт результат одним
JSON после полной генерации — для потока он не годится. Поэтому этапы
разделены: здесь только поиск источников, а генерацию со стримингом
делает Node, подставив найденное в промпт.

Побочная польза: источники приходят раньше текста, и интерфейс может
показать «нашёл 5 публикаций» пока модель ещё думает.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.modules.sources.grounding import format_sources_for_prompt
from app.modules.sources.registry import find_sources

router = APIRouter(prefix="/sources", tags=["sources"])

#: Сколько источников отдавать по умолчанию. Шесть — компромисс: в
#: промпт помещается, а тем для перекрёстной проверки уже хватает.
DEFAULT_LIMIT = 6

#: Верхняя граница, чтобы запрос не превратился в долгий обход баз.
MAX_LIMIT = 12


class SearchIn(BaseModel):
    topic: str = Field(min_length=3, max_length=500)
    #: Направления поиска. Если не заданы, ищем по самой теме.
    directions: list[str] = Field(default_factory=list)
    limit: int = Field(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT)
    years_back: int = Field(default=5, ge=1, le=30)
    #: Тянуть ли полные тексты. Дороже по времени, но заметно точнее.
    with_fulltext: bool = True


@router.post("/search", summary="Найти источники по теме")
async def search_sources(payload: SearchIn) -> dict:
    """Найти публикации и вернуть их вместе с готовым блоком для промпта.

    Отдаём сразу два представления. `prompt_block` — текст, который
    подставляется в запрос к модели. `sources` — структурированный
    список для интерфейса: показать пользователю, на чём построен
    анализ, и дать ссылки.
    """
    directions = [d.strip() for d in payload.directions if d.strip()]

    try:
        sources = await find_sources(
            payload.topic,
            directions or [payload.topic],
            limit=payload.limit,
            years_back=payload.years_back,
            with_fulltext=payload.with_fulltext,
        )
    except Exception as exc:
        # Базы внешние: недоступность одной не должна выглядеть как
        # поломка сервиса. Пусть вызывающий решает, генерировать ли
        # без источников.
        raise HTTPException(
            status_code=502,
            detail=f"поиск источников недоступен: {exc}") from exc

    return {
        "count": len(sources),
        "prompt_block": format_sources_for_prompt(sources) if sources else "",
        "sources": [
            {
                "title": s.title,
                "authors": s.authors,
                "year": s.year,
                "venue": s.venue,
                "doi": s.doi,
                "url": s.url,
                "is_oa": s.is_oa,
                "relevance": s.relevance,
                "provider": s.provider,
                "has_fulltext": bool(s.fulltext),
            }
            for s in sources
        ],
    }
