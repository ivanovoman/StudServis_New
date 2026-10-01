"""Documents — HTTP-интерфейс выгрузки DOCX."""

from __future__ import annotations

import re
from urllib.parse import quote

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator

from app.modules.documents.gost_engine import (
    generate_fragment_docx,
    generate_full_docx,
)
from app.modules.documents.pptx_engine import Slide, build_presentation

router = APIRouter(prefix="/documents", tags=["documents"])

DOCX_MIME = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)
PPTX_MIME = (
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
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
    # Правое поле: по ГОСТ 7.32 — 10 мм, у большинства вузов 15, МФЮА
    # просит 10. Без параметра методичка не могла на это повлиять.
    margin_right_mm: float | None = None
    title: str | None = None
    text: str | None = None
    table_markdown: str | None = None
    is_h1: bool | None = None
    chapter_heading: str | None = None
    table_number: str | None = None
    table_title: str | None = None
    reference_sentence: str | None = None


class FullRequest(BaseModel):
    margin_right_mm: float | None = None
    topic: str | None = None
    introduction: str | None = None
    sections: list[SectionIn] = Field(default_factory=list)
    conclusion: str | None = None
    chapter_titles: dict[str, str] | None = None
    section_titles: dict[str, str] | None = None
    #: Готовые записи по ГОСТ. Принимаем и одной строкой с переводами
    #: строк — так их отдаёт /sources/search, и так их проще передать
    #: из браузера, не разбирая на элементы.
    bibliography: list[str] | str | None = None

    #: Данные титульного листа. Пустой словарь означает «без титула»:
    #: лист с одними прочерками никому не нужен.
    title_page: dict | None = None
    #: Названия разделов: у МФЮА, например, «ОГЛАВЛЕНИЕ» и «СПИСОК
    #: ИСПОЛЬЗУЕМЫХ ИСТОЧНИКОВ» вместо привычных.
    contents_title: str = "СОДЕРЖАНИЕ"
    bibliography_title: str = "СПИСОК ЛИТЕРАТУРЫ"

    @field_validator("bibliography")
    @classmethod
    def _split_lines(cls, value):
        if isinstance(value, str):
            return [line for line in value.splitlines() if line.strip()]
        return value


def _file_response(data: bytes, filename: str, *, ext: str,
                   mime: str) -> Response:
    """Отдаёт файл с корректным именем.

    Кириллица в имени требует RFC 5987 (filename*), иначе Word получит
    мусор вместо названия.
    """
    safe = re.sub(r'[\\/:*?"<>|]', "_", filename).strip() or "document"
    return Response(
        content=data,
        media_type=mime,
        headers={
            "Content-Disposition": (
                f"attachment; filename=document.{ext}; "
                f"filename*=UTF-8''{quote(safe)}.{ext}"
            )
        },
    )


def _docx_response(data: bytes, filename: str) -> Response:
    return _file_response(data, filename, ext="docx", mime=DOCX_MIME)


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
        margin_right_mm=payload.margin_right_mm,
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
        bibliography=payload.bibliography,
        title_page=payload.title_page,
        contents_title=payload.contents_title,
        bibliography_title=payload.bibliography_title,
        margin_right_mm=payload.margin_right_mm,
    )
    return _docx_response(data, payload.topic or "Курсовая работа")


class SlideIn(BaseModel):
    title: str = ""
    bullets: list[str] = Field(default_factory=list)
    table: list[list[str]] = Field(default_factory=list)
    note: str = ""
    levels: list[int] = Field(default_factory=list)


class SlidesRequest(BaseModel):
    """Презентация к защите.

    Реквизиты титульного листа приходят отдельными полями, а не в
    составе слайдов: модель охотно выдумывает ФИО руководителя, и на
    защите это замечают сразу.
    """

    slides: list[SlideIn] = Field(default_factory=list)
    topic: str = ""
    university: str = ""
    author: str = ""
    supervisor: str = ""
    year: str = ""

    @field_validator("slides")
    @classmethod
    def _non_empty(cls, value):
        if not value:
            raise ValueError("Нужен хотя бы один слайд")
        return value


@router.post("/export/slides", summary="PPTX презентации к защите")
async def export_slides(payload: SlidesRequest) -> Response:
    slides = [
        Slide(
            title=s.title,
            bullets=[b for b in s.bullets if b.strip()],
            table=[row for row in s.table if any(c.strip() for c in row)],
            note=s.note,
            levels=s.levels,
        )
        for s in payload.slides
    ]
    data = build_presentation(
        slides,
        topic=payload.topic,
        university=payload.university,
        author=payload.author,
        supervisor=payload.supervisor,
        year=payload.year,
    )
    return _file_response(
        data, payload.topic or "Презентация", ext="pptx", mime=PPTX_MIME,
    )
