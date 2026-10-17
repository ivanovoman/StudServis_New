"""HTTP-интерфейс оплаты.

## Вебхук и его защита

Адрес вебхука публичный — на него может постучаться кто угодно. Защиты
две, и они независимы друг от друга:

1. **Проверка отправителя.** ЮKassa шлёт уведомления с известного
   списка адресов; всё, что пришло с других, отбрасывается.
2. **Переспрос платежа.** Даже пройдя первую проверку, тело не считается
   правдой: состояние платежа выясняется прямым запросом в ЮKassa.

Второй пункт важнее первого. Список адресов может измениться, а сервис
может стоять за прокси, который подменит адрес отправителя, — но
подделать ответ самой ЮKassa нельзя.

## Коды ответа

На разобранное уведомление отвечаем 200, даже если платёж нам неизвестен
или ещё не оплачен: ЮKassa повторяет уведомление сутки, пока не получит
200, и заваливать себя повторами из-за чужого платежа незачем.

А вот если не удалось связаться с ЮKassa, отвечаем 503 — тогда повтор
как раз нужен.
"""

from __future__ import annotations

import ipaddress
import logging

from fastapi import APIRouter, Depends, Request, Response
from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.modules.auth.api import current_user
from app.modules.auth.models import User
from app.modules.payments import service, yookassa_client as gateway
from app.modules.payments.catalog import all_tariffs, get_tariff

log = logging.getLogger(__name__)

router = APIRouter(prefix="/payments", tags=["payments"])

#: Адреса, с которых ЮKassa шлёт уведомления.
#: https://yookassa.ru/developers/using-api/webhooks
TRUSTED_NETWORKS = tuple(ipaddress.ip_network(net) for net in (
    "185.71.76.0/27",
    "185.71.77.0/27",
    "77.75.153.0/25",
    "77.75.156.11/32",
    "77.75.156.35/32",
    "77.75.154.128/25",
    "2a02:5180::/32",
))


def is_trusted_ip(raw_ip: str) -> bool:
    try:
        address = ipaddress.ip_address((raw_ip or "").strip())
    except ValueError:
        return False
    return any(address in network for network in TRUSTED_NETWORKS)


class StartPaymentIn(BaseModel):
    tariff: str = Field(default="single", max_length=32)
    #: Куда вернуть человека после оплаты.
    return_url: str = Field(default="", max_length=500)


@router.get("/tariffs", summary="Список тарифов")
async def tariffs() -> dict:
    return {
        "configured": gateway.is_configured(),
        "tariffs": [
            {
                "code": t.code,
                "title": t.title,
                "price": t.price_rubles,
                "price_kopecks": t.price_kopecks,
                "works": t.works,
                "days": t.days,
                "description": t.description,
            }
            for t in all_tariffs()
        ],
    }


@router.get("/access", summary="Что оплачено")
async def access(user: User = Depends(current_user),
                 session: AsyncSession = Depends(get_session)) -> dict:
    grant = await service.get_grant(session, user.id)
    await session.commit()
    return {
        "works_left": grant.works_left,
        "subscription_active": grant.subscription_active,
        "subscription_until": (grant.subscription_until.isoformat()
                               if grant.subscription_until else None),
        "can_assemble": grant.can_assemble,
    }


@router.post("/create", summary="Создать платёж")
async def create(payload: StartPaymentIn, request: Request,
                 user: User = Depends(current_user),
                 session: AsyncSession = Depends(get_session)) -> dict:
    if not gateway.is_configured():
        # Честный отказ вместо непонятной ошибки от библиотеки.
        raise HTTPException(
            status_code=503,
            detail="Оплата пока не подключена. Загляните позже.")

    tariff = get_tariff(payload.tariff)
    if tariff is None:
        raise HTTPException(status_code=400, detail="Неизвестный тариф")

    return_url = payload.return_url or str(request.base_url)

    try:
        payment = await service.start_payment(
            session, user.id, tariff.code, return_url)
    except service.PaymentError as err:
        await session.rollback()
        raise HTTPException(status_code=502, detail=str(err)) from err

    await session.commit()
    return {
        "payment_id": payment.id,
        "confirmation_url": payment.confirmation_url,
        "amount": tariff.price_rubles,
        "tariff": tariff.code,
    }


@router.get("/history", summary="История платежей")
async def payment_history(user: User = Depends(current_user),
                          session: AsyncSession = Depends(get_session)) -> dict:
    items = await service.history(session, user.id)
    return {
        "count": len(items),
        "payments": [
            {
                "id": p.id,
                "tariff": p.tariff_code,
                "amount": f"{p.amount_kopecks / 100:.2f}",
                "status": p.status,
                "created_at": p.created_at.isoformat() if p.created_at else None,
            }
            for p in items
        ],
    }


@router.post("/spend", summary="Списать оплаченную работу")
async def spend(user: User = Depends(current_user),
                session: AsyncSession = Depends(get_session)) -> dict:
    """Проверяет право собрать работу и списывает его.

    Пока ключи магазина не заданы, право есть у всех: иначе включение
    модуля оплаты мгновенно остановило бы работающий сервис. Это не
    дыра — без ключей платить всё равно негде.
    """
    if not gateway.is_configured():
        return {"allowed": True, "reason": "payments_off"}

    allowed = await service.spend_work(session, user.id)
    await session.commit()

    if not allowed:
        return {"allowed": False, "reason": "no_access"}
    return {"allowed": True, "reason": "spent"}


@router.post("/refund-work", summary="Вернуть списанную работу")
async def refund_work(user: User = Depends(current_user),
                      session: AsyncSession = Depends(get_session)) -> dict:
    """Возвращает списанное, если собрать работу не удалось.

    Списываем до сборки — иначе оборванным соединением можно получить
    работу бесплатно. Но за неудачу платить человек не должен, поэтому
    при полном провале списание отменяется.
    """
    if not gateway.is_configured():
        return {"restored": False}

    grant = await service.get_grant(session, user.id)
    if not grant.subscription_active:
        grant.add_works(1)
    await session.commit()
    return {"restored": not grant.subscription_active}


@router.post("/webhook", summary="Уведомление от ЮKassa")
async def webhook(request: Request,
                  session: AsyncSession = Depends(get_session)) -> Response:
    client_ip = request.client.host if request.client else ""
    # За обратным прокси настоящий адрес приходит заголовком. Доверять
    # ему можно только потому, что вторая проверка — переспрос платежа —
    # всё равно не даст подделке пройти.
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        client_ip = forwarded.split(",")[0].strip()

    if not is_trusted_ip(client_ip):
        log.warning("Уведомление с чужого адреса: %s", client_ip)
        raise HTTPException(status_code=403, detail="Not allowed")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Bad JSON")

    try:
        outcome = await service.apply_notification(session, body)
    except service.PaymentError as err:
        # Связи с ЮKassa нет — пусть повторит попозже.
        await session.rollback()
        log.error("Уведомление не разобрано: %s", err)
        return Response(status_code=503)

    await session.commit()
    log.info("Уведомление ЮKassa: %s", outcome)
    return Response(status_code=200)
