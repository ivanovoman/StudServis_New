"""Разговор с ЮKassa.

Только HTTP: создать платёж и спросить его состояние. Решения о
начислении принимает сервис — здесь ни одного «если оплачено».

## Идемпотентность

ЮKassa требует заголовок `Idempotence-Key` при создании платежа. Без
него повторный запрос — например, после обрыва связи — создаст второй
платёж, и человек заплатит дважды. Ключ генерируется один раз на нашу
запись о платеже и не меняется при повторах.

## Почему без официального SDK

Пакет `yookassa` тянет свои зависимости и оборачивает три HTTP-запроса
в классы. Нам нужны ровно два из них, а `httpx` уже в проекте. Меньше
зависимостей — меньше поводов для «у нас не ставится», чего в этом
проекте уже хватило.
"""

from __future__ import annotations

import base64
import logging
import os
import uuid

import httpx

log = logging.getLogger(__name__)

API_URL = "https://api.yookassa.ru/v3"
DEFAULT_TIMEOUT = 20.0


class YooKassaError(Exception):
    """Не удалось поговорить с ЮKassa."""


class NotConfigured(YooKassaError):
    """Ключи магазина не заданы."""


def credentials() -> tuple[str, str]:
    """Идентификатор магазина и секретный ключ из окружения."""
    shop_id = os.getenv("YOOKASSA_SHOP_ID", "").strip()
    secret = os.getenv("YOOKASSA_SECRET_KEY", "").strip()
    return shop_id, secret


def is_configured() -> bool:
    shop_id, secret = credentials()
    return bool(shop_id and secret)


def _auth_header() -> str:
    shop_id, secret = credentials()
    if not shop_id or not secret:
        raise NotConfigured(
            "Оплата не настроена: в окружении нет YOOKASSA_SHOP_ID и "
            "YOOKASSA_SECRET_KEY")
    raw = f"{shop_id}:{secret}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def new_idempotence_key() -> str:
    return str(uuid.uuid4())


def create_payment(*, amount_rubles: str, description: str,
                   return_url: str, metadata: dict,
                   idempotence_key: str,
                   timeout: float = DEFAULT_TIMEOUT,
                   client: httpx.Client | None = None) -> dict:
    """Создаёт платёж и возвращает ответ ЮKassa целиком.

    `capture: true` — одностадийный платёж: деньги списываются сразу,
    без отдельного подтверждения. Двухстадийная схема нужна там, где
    товар может не приехать; у нас услуга оказывается сразу же.
    """
    body = {
        "amount": {"value": amount_rubles, "currency": "RUB"},
        "capture": True,
        "confirmation": {"type": "redirect", "return_url": return_url},
        "description": description[:128],
        "metadata": metadata,
    }
    headers = {
        "Authorization": _auth_header(),
        "Idempotence-Key": idempotence_key,
        "Content-Type": "application/json",
    }

    try:
        if client is not None:
            response = client.post(f"{API_URL}/payments", json=body,
                                   headers=headers, timeout=timeout)
        else:
            with httpx.Client(timeout=timeout) as http:
                response = http.post(f"{API_URL}/payments", json=body,
                                     headers=headers)
    except httpx.HTTPError as err:
        raise YooKassaError(f"ЮKassa не ответила: {err}") from err

    if response.status_code >= 400:
        # Тело ошибки ЮKassa объясняет причину: неверный ключ, кривая
        # сумма. В лог оно нужно целиком, пользователю — не нужно.
        log.error("ЮKassa отклонила создание платежа: %s %s",
                  response.status_code, response.text[:500])
        raise YooKassaError(
            f"ЮKassa отклонила платёж (код {response.status_code})")

    return response.json()


def get_payment(payment_id: str, *, timeout: float = DEFAULT_TIMEOUT,
                client: httpx.Client | None = None) -> dict:
    """Спрашивает состояние платежа у ЮKassa.

    Именно этот запрос делает оплату невозможно подделать: что бы ни
    прислали в уведомлении, начисляем только по ответу отсюда.
    """
    headers = {"Authorization": _auth_header()}
    url = f"{API_URL}/payments/{payment_id}"

    try:
        if client is not None:
            response = client.get(url, headers=headers, timeout=timeout)
        else:
            with httpx.Client(timeout=timeout) as http:
                response = http.get(url, headers=headers)
    except httpx.HTTPError as err:
        raise YooKassaError(f"ЮKassa не ответила: {err}") from err

    if response.status_code >= 400:
        log.error("ЮKassa не отдала платёж %s: %s %s", payment_id,
                  response.status_code, response.text[:300])
        raise YooKassaError(
            f"ЮKassa не отдала платёж (код {response.status_code})")

    return response.json()
