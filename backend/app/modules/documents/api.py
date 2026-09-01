"""Documents — HTTP-интерфейс выгрузки DOCX."""

from __future__ import annotations

import re
from urllib.parse import quote

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.modules.documents.gost_engine import (
    generate_fragment_docx,
    generate_full_docx,
)

router = APIRouter(prefix="/documents", tags=["documents"])

DOCX_MIME = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)


class TableData(BaseModel):
    number: str | None = None
    title: str | None = None
    markdown: str | None = None


class SectionIn(BaseModel):
    number: str | None = None
    text: str | None = None
    table: TableData | None = None


class FragmentRequest(BaseModel):
    title: str | None = None
    text: str | None = None
    table_markdown: str | None = None
    is_h1: bool | None = None
    chapter_heading: str | None = None
    table_number: str | None = None
    table_title: str | None = None
    reference_sentence: str | None = None


class FullRequest(BaseModel):
    topic: str | None = None
    introduction: str | None = None
    sections: list[SectionIn] = Field(default_factory=list)
    conclusion: str | None = None
    chapter_titles: dict[str, str] | None = None
    section_titles: dict[str, str] | None = None


def _docx_response(data: bytes, filename: str) -> Response:
    """Отдаёт файл с корректным именем.

    Кириллица в имени требует RFC 5987 (filename*), иначе Word получит
    мусор вместо названия.
    """
    safe = re.sub(r'[\\/:*?"<>|]', "_", filename).strip() or "document"
    return Response(
        content=data,
        media_type=DOCX_MIME,
        headers={
            "Content-Disposition": (
                f"attachment; filename=document.docx; "
                f"filename*=UTF-8''{quote(safe)}.docx"
            )
        },
    )


@router.post("/export/fragment", summary="DOCX одного фрагмента")
async def export_fragment(payload: FragmentRequest) -> Response:
    data = generate_fragment_docx(
        title=payload.title,
        text=payload.text,
        table_markdown=payload.table_markdown,
        is_h1=payload.is_h1,
        chapter_heading=payload.chapter_heading,
        table_number=payload.table_number,
        table_title=payload.table_title,
        reference_sentence=payload.reference_sentence,
    )
    return _docx_response(data, payload.title or "Фрагмент")


@router.post("/export/full", summary="DOCX всей работы")
async def export_full(payload: FullRequest) -> Response:
    data = generate_full_docx(
        topic=payload.topic,
        introduction=payload.introduction,
        sections=[s.model_dump() for s in payload.sections],
        conclusion=payload.conclusion,
        chapter_titles=payload.chapter_titles,
        section_titles=payload.section_titles,
    )
    return _docx_response(data, payload.topic or "Курсовая работа")
