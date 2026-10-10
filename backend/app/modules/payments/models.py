"""Платежи и доступ к платным возможностям.

## Две таблицы

`payments` — история: кто, когда, за что и чем кончилось. Строка
создаётся до похода в ЮKassa и живёт даже если человек передумал
платить. Ничего оттуда не удаляем: это денежные записи, по ним
разбираются спорные случаи.

`access_grants` — что человек купил: оплаченные работы и срок подписки.
Отдельно от платежей, потому что начисление может прийти и не от
платежа — промокод, компенсация за сбой, подарок.

## Почему не флажок «оплачено» прямо в работе

Работа собирается один раз, а платят до сборки. Флажок в работе значил
бы, что человек оплачивает конкретный черновик, — а он оплачивает
возможность собрать любую. Разделение позволяет купить пакет заранее и
потратить, когда тема утвердят.

## Идемпотентность

Уведомление от ЮKassa приходит повторно, если мы ответили не 200 — и
так целые сутки. Начислять доступ дважды нельзя, поэтому у платежа есть
отметка `granted_at`: начисление происходит ровно один раз, а повторное
уведомление просто подтверждается.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

#: Статусы платежа. Совпадают с терминами ЮKassa, чтобы не заводить
#: свой словарь поверх чужого и не путаться при разборе жалоб.
STATUS_PENDING = "pending"
STATUS_SUCCEEDED = "succeeded"
STATUS_CANCELED = "canceled"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return uuid.uuid4().hex


class Payment(Base):
    """Одна попытка оплаты."""

    __tablename__ = "payments"

    id: Mapped[str] = mapped_column(String(32), primary_key=True,
                                    default=new_id)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    #: Идентификатор платежа в ЮKassa. Пустой, пока платёж не создан.
    external_id: Mapped[str] = mapped_column(String(64), default="",
                                             index=True)

    tariff_code: Mapped[str] = mapped_column(String(32), nullable=False)
    #: Сумма в копейках — на момент покупки. Цены меняются, а в истории
    #: должна остаться та, по которой человек заплатил.
    amount_kopecks: Mapped[int] = mapped_column(Integer, nullable=False)

    status: Mapped[str] = mapped_column(String(20), default=STATUS_PENDING)

    #: Ссылка, куда отправляется человек платить.
    confirmation_url: Mapped[str] = mapped_column(Text, default="")

    #: Когда по этому платежу начислен доступ. Защита от повторного
    #: начисления: уведомление ЮKassa может прийти не один раз.
    granted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now)

    __table_args__ = (
        Index("ix_payments_user_created", "user_id", "created_at"),
    )


class AccessGrant(Base):
    """Что у человека куплено."""

    __tablename__ = "access_grants"

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)

    #: Сколько работ оплачено и ещё не потрачено.
    works_left: Mapped[int] = mapped_column(Integer, default=0)

    #: До какого момента действует подписка. None — подписки нет.
    subscription_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now)

    @property
    def subscription_active(self) -> bool:
        until = self.subscription_until
        if until is None:
            return False
        # SQLite возвращает время без часового пояса: сравнение с
        # aware-датой в этом случае падает с TypeError.
        if until.tzinfo is None:
            until = until.replace(tzinfo=timezone.utc)
        return until > _now()

    @property
    def can_assemble(self) -> bool:
        """Есть ли право собрать работу прямо сейчас."""
        return self.subscription_active or self.works_left > 0

    def add_works(self, count: int) -> None:
        self.works_left = max(0, self.works_left) + count

    def extend_subscription(self, days: int) -> None:
        """Продлевает подписку.

        Если подписка ещё действует, дни прибавляются к остатку, а не
        затирают его: человек, купивший второй месяц заранее, не должен
        терять оплаченное.
        """
        base = _now()
        current = self.subscription_until
        if current is not None:
            if current.tzinfo is None:
                current = current.replace(tzinfo=timezone.utc)
            if current > base:
                base = current
        self.subscription_until = base + timedelta(days=days)
