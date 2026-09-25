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

from app.modules.sources.gost_biblio import format_list, format_source
from app.modules.sources.grounding import format_sources_for_prompt
from app.modules.sources.legal_refs import check_text
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
        # Готовый список литературы по ГОСТ Р 7.0.100-2018. Собран из
        # метаданных баз, а не придуман моделью: реквизиты — то самое
        # место, где она уверенно врёт.
        "bibliography": format_list(sources) if sources else "",
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
                "pages": s.pages,
                "volume": s.volume,
                "issue": s.issue,
                "gost": format_source(s),
            }
            for s in sources
        ],
    }


class VerifyIn(BaseModel):
    """Текст, в котором нужно проверить ссылки на статьи кодексов."""

    text: str = Field(min_length=1, max_length=200_000)


@router.post("/verify-legal")
async def verify_legal(payload: VerifyIn) -> dict:
    """Сверить ссылки на статьи кодексов с оглавлениями первоисточников.

    Отдельный эндпоинт, а не часть генерации, по двум причинам. Проверять
    нужно и то, что модель написала сама, и то, что пользователь принёс
    со стороны. И проверка ходит в правовые базы — это секунды, которые
    нельзя вешать на поток генерации: пользователь ждёт текст, а не
    справку.

    Ответ намеренно не содержит вердикта «ложь». Машина отвечает на
    проверяемый вопрос — существует ли статья и как она называется, —
    а сопоставление с замыслом остаётся за человеком.
    """
    result = await check_text(payload.text)

    return {
        "checked": len(result.references),
        "problems": len(result.suspicious),
        "summary": result.summary(),
        "references": [
            {
                "code": r.code,
                "article": r.article,
                "label": r.label,
                "status": r.status,
                "real_title": r.real_title,
                "note": r.note,
                "claim": r.claim,
            }
            for r in result.references
        ],
    }
