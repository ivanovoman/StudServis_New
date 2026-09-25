"""Логика оплаты: создать платёж, принять уведомление, начислить доступ.

## Главное правило

**Телу уведомления не верим.** В нём может прийти что угодно: адрес
вебхука публичный, и «оплату» ничего не стоит подделать обычным curl.
Поэтому на каждое уведомление мы сами спрашиваем ЮKassa: что там с этим
платежом? Начисляем, только если она отвечает `succeeded`, `paid` и
сумма совпадает с той, что мы выставляли.

Совпадение суммы проверяется отдельно от статуса: без этого оплата
одной работы за 490 рублей могла бы открыть подписку за 1490, если
подменить тариф в метаданных.

## Повторные уведомления

ЮKassa шлёт уведомление сутки, пока не получит HTTP 200. Значит одно и
то же событие придёт не раз. Доступ начисляется однократно — по отметке
`granted_at` в платеже.
"""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.payments import yookassa_client as gateway
from app.modules.payments.catalog import Tariff, get_tariff
from app.modules.payments.models import (
    STATUS_CANCELED,
    STATUS_PENDING,
    STATUS_SUCCEEDED,
    AccessGrant,
    Payment,
    _now,
)

log = logging.getLogger(__name__)


class PaymentError(Exception):
    """Ошибка, которую можно показать пользователю."""


async def get_grant(session: AsyncSession, user_id: str) -> AccessGrant:
    """Права пользователя. Заводит пустую запись, если её ещё нет."""
    grant = await session.get(AccessGrant, user_id)
    if grant is None:
        grant = AccessGrant(user_id=user_id, works_left=0)
        session.add(grant)
        await session.flush()
    return grant


async def start_payment(session: AsyncSession, user_id: str,
                        tariff_code: str, return_url: str,
                        *, creator=None) -> Payment:
    """Создаёт платёж и возвращает запись со ссылкой на оплату.

    Запись в нашей базе появляется раньше похода в ЮKassa: если связь
    оборвётся, останется след, по которому платёж можно найти и
    доразобрать, а не молчаливая пропажа денег.
    """
    tariff = get_tariff(tariff_code)
    if tariff is None:
        raise PaymentError("Неизвестный тариф")

    payment = Payment(
        user_id=user_id,
        tariff_code=tariff.code,
        amount_kopecks=tariff.price_kopecks,
        status=STATUS_PENDING,
    )
    session.add(payment)
    await session.flush()

    make = creator or gateway.create_payment
    try:
        response = make(
            amount_rubles=tariff.price_rubles,
            description=f"{tariff.title} — StudRabots",
            return_url=return_url,
            # По метаданным мы найдём свою запись, когда придёт
            # уведомление. Сумму из них не берём — только из своей базы.
            metadata={"payment_id": payment.id, "user_id": user_id,
                      "tariff": tariff.code},
            idempotence_key=payment.id,
        )
    except gateway.YooKassaError as err:
        payment.status = STATUS_CANCELED
        await session.flush()
        raise PaymentError(str(err)) from err

    payment.external_id = str(response.get("id") or "")
    confirmation = response.get("confirmation") or {}
    payment.confirmation_url = str(confirmation.get("confirmation_url") or "")
    await session.flush()

    if not payment.confirmation_url:
        # Без ссылки платить негде. Лучше честно сказать сразу, чем
        # отдать пустую кнопку.
        raise PaymentError("ЮKassa не вернула ссылку на оплату")

    return payment


def _grant_for(tariff: Tariff, grant: AccessGrant) -> None:
    """Начисляет купленное."""
    if tariff.is_subscription:
        grant.extend_subscription(tariff.days or 0)
    if tariff.works:
        grant.add_works(tariff.works)


async def apply_notification(session: AsyncSession, body: dict,
                             *, fetcher=None) -> str:
    """Разбирает уведомление от ЮKassa.

    Возвращает короткое описание исхода — оно идёт в лог, а не
    пользователю. Ошибок не бросает без нужды: на любой разумный исход
    надо ответить HTTP 200, иначе ЮKassa будет повторять сутки.
    """
    obj = (body or {}).get("object") or {}
    external_id = str(obj.get("id") or "")
    if not external_id:
        return "в уведомлении нет идентификатора платежа"

    payment = await session.scalar(
        select(Payment).where(Payment.external_id == external_id))
    if payment is None:
        # Чужой или очень старый платёж. Отвечаем успехом: повторять
        # такое уведомление сутки бессмысленно.
        return f"платёж {external_id} нам неизвестен"

    if payment.granted_at is not None:
        return f"платёж {external_id} уже учтён"

    # Не верим телу: спрашиваем ЮKassa напрямую.
    ask = fetcher or gateway.get_payment
    try:
        actual = ask(external_id)
    except gateway.YooKassaError as err:
        # Отвечать 200 нельзя: пусть повторит, когда связь наладится.
        raise PaymentError(str(err)) from err

    status = str(actual.get("status") or "")
    paid = bool(actual.get("paid"))

    if status == STATUS_CANCELED:
        payment.status = STATUS_CANCELED
        await session.flush()
        return f"платёж {external_id} отменён"

    if status != STATUS_SUCCEEDED or not paid:
        return f"платёж {external_id} ещё не оплачен (статус {status})"

    # Сумма должна совпасть с выставленной. Иначе подменой тарифа в
    # метаданных можно было бы купить подписку по цене одной работы.
    amount = (actual.get("amount") or {}).get("value")
    expected = f"{payment.amount_kopecks // 100}.{payment.amount_kopecks % 100:02d}"
    if str(amount) != expected:
        log.error("Сумма платежа %s не совпала: пришло %s, ожидали %s",
                  external_id, amount, expected)
        return f"платёж {external_id}: сумма не совпала"

    tariff = get_tariff(payment.tariff_code)
    if tariff is None:
        log.error("Платёж %s: тариф %s больше не существует",
                  external_id, payment.tariff_code)
        return f"платёж {external_id}: неизвестный тариф"

    grant = await get_grant(session, payment.user_id)
    _grant_for(tariff, grant)

    payment.status = STATUS_SUCCEEDED
    payment.granted_at = _now()
    await session.flush()

    log.info("Оплата зачтена: пользователь %s, тариф %s",
             payment.user_id, tariff.code)
    return f"платёж {external_id} зачтён"


async def spend_work(session: AsyncSession, user_id: str) -> bool:
    """Списывает одну оплаченную работу.

    Подписка ничего не списывает — она на то и подписка. Возвращает
    False, если платить нечем: вызывающий код решает, что делать.
    """
    grant = await get_grant(session, user_id)

    if grant.subscription_active:
        return True
    if grant.works_left > 0:
        grant.works_left -= 1
        await session.flush()
        return True
    return False


async def history(session: AsyncSession, user_id: str,
                  limit: int = 50) -> list[Payment]:
    result = await session.scalars(
        select(Payment)
        .where(Payment.user_id == user_id)
        .order_by(Payment.created_at.desc())
        .limit(limit))
    return list(result)
