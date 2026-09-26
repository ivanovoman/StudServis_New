"""Тесты оплаты.

Проверяется прежде всего то, чем можно злоупотребить: поддельное
уведомление, повторное начисление, подмена суммы и тарифа, чужой
платёж. Деньги — та часть системы, где ошибка стоит дороже всего.

Сеть никуда не ходит: запросы к ЮKassa подменяются заглушками.
"""

from __future__ import annotations

import asyncio
import os
import tempfile

import pytest
from fastapi.testclient import TestClient

_TMP_DIR = tempfile.mkdtemp(prefix="pay_test_")
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_TMP_DIR}/test_pay.db"

from app.db import get_session_factory, init_models, reset_engine  # noqa: E402
from app.main import app  # noqa: E402
from app.modules.payments import service  # noqa: E402
from app.modules.payments.api import is_trusted_ip  # noqa: E402
from app.modules.payments.catalog import get_tariff  # noqa: E402
from app.modules.payments.models import (  # noqa: E402
    STATUS_SUCCEEDED, AccessGrant, Payment)

PASSWORD = "правильный-конь-батарейка"
#: Адрес из списка ЮKassa — с чужого уведомление не примут.
YOOKASSA_IP = "185.71.76.1"


@pytest.fixture(scope="module", autouse=True)
def _prepare_db():
    asyncio.run(init_models())
    yield
    asyncio.run(reset_engine())


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


_counter = iter(range(1, 10_000))


def new_user(client) -> tuple[str, str]:
    """Регистрирует пользователя, возвращает (токен, id)."""
    email = f"payer{next(_counter)}@example.com"
    body = client.post("/api/v1/auth/register",
                       json={"email": email, "password": PASSWORD}).json()
    return body["token"], body["user"]["id"]


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _make_payment(user_id: str, tariff: str = "single",
                        external_id: str = "yoo-1") -> str:
    """Кладёт в базу платёж, как будто он уже создан в ЮKassa."""
    async with get_session_factory()() as session:
        t = get_tariff(tariff)
        payment = Payment(user_id=user_id, tariff_code=tariff,
                          amount_kopecks=t.price_kopecks,
                          external_id=external_id)
        session.add(payment)
        await session.commit()
        return payment.id


def notification(external_id: str, status: str = "succeeded") -> dict:
    return {"type": "notification", "event": f"payment.{status}",
            "object": {"id": external_id, "status": status, "paid": True}}


def gateway_says(status="succeeded", paid=True, amount="290.00"):
    """Заглушка ответа ЮKassa на запрос о платеже."""
    def fetch(payment_id, **kw):
        return {"id": payment_id, "status": status, "paid": paid,
                "amount": {"value": amount, "currency": "RUB"}}
    return fetch


# --- проверка отправителя ---------------------------------------------

def test_yookassa_addresses_are_trusted():
    for ip in ("185.71.76.1", "185.71.77.30", "77.75.153.10",
               "77.75.156.11", "77.75.154.200"):
        assert is_trusted_ip(ip), ip


def test_other_addresses_are_not_trusted():
    for ip in ("127.0.0.1", "8.8.8.8", "185.71.78.1", "", "не-адрес"):
        assert not is_trusted_ip(ip), ip


def test_webhook_rejects_stranger(client):
    """Адрес вебхука публичный: кто угодно может постучаться."""
    r = client.post("/api/v1/payments/webhook", json=notification("yoo-x"))
    assert r.status_code == 403


# --- начисление -------------------------------------------------------

def test_successful_payment_grants_access(client, monkeypatch):
    token, user_id = new_user(client)
    asyncio.run(_make_payment(user_id, "single", "yoo-ok"))

    monkeypatch.setattr(service.gateway, "get_payment", gateway_says())
    r = client.post("/api/v1/payments/webhook", json=notification("yoo-ok"),
                    headers={"X-Forwarded-For": YOOKASSA_IP})
    assert r.status_code == 200

    access = client.get("/api/v1/payments/access", headers=auth(token)).json()
    assert access["works_left"] == 1
    assert access["can_assemble"] is True


def test_subscription_grants_unlimited(client, monkeypatch):
    token, user_id = new_user(client)
    asyncio.run(_make_payment(user_id, "month", "yoo-sub"))

    monkeypatch.setattr(service.gateway, "get_payment",
                        gateway_says(amount="590.00"))
    client.post("/api/v1/payments/webhook", json=notification("yoo-sub"),
                headers={"X-Forwarded-For": YOOKASSA_IP})

    access = client.get("/api/v1/payments/access", headers=auth(token)).json()
    assert access["subscription_active"] is True
    assert access["can_assemble"] is True


def test_repeated_notification_does_not_double_grant(client, monkeypatch):
    """ЮKassa шлёт уведомление сутки, пока не получит 200. Одно и то же
    событие придёт не раз — начислить нужно однократно."""
    token, user_id = new_user(client)
    asyncio.run(_make_payment(user_id, "single", "yoo-twice"))

    monkeypatch.setattr(service.gateway, "get_payment", gateway_says())
    for _ in range(3):
        r = client.post("/api/v1/payments/webhook",
                        json=notification("yoo-twice"),
                        headers={"X-Forwarded-For": YOOKASSA_IP})
        assert r.status_code == 200

    access = client.get("/api/v1/payments/access", headers=auth(token)).json()
    assert access["works_left"] == 1


def test_unpaid_payment_grants_nothing(client, monkeypatch):
    """Тело уведомления говорит «оплачено», а ЮKassa — «нет»."""
    token, user_id = new_user(client)
    asyncio.run(_make_payment(user_id, "single", "yoo-pending"))

    monkeypatch.setattr(service.gateway, "get_payment",
                        gateway_says(status="pending", paid=False))
    r = client.post("/api/v1/payments/webhook",
                    json=notification("yoo-pending"),
                    headers={"X-Forwarded-For": YOOKASSA_IP})
    assert r.status_code == 200

    access = client.get("/api/v1/payments/access", headers=auth(token)).json()
    assert access["works_left"] == 0


def test_wrong_amount_grants_nothing(client, monkeypatch):
    """Иначе подменой тарифа подписку покупали бы по цене одной работы."""
    token, user_id = new_user(client)
    asyncio.run(_make_payment(user_id, "month", "yoo-cheap"))

    monkeypatch.setattr(service.gateway, "get_payment",
                        gateway_says(amount="1.00"))
    client.post("/api/v1/payments/webhook", json=notification("yoo-cheap"),
                headers={"X-Forwarded-For": YOOKASSA_IP})

    access = client.get("/api/v1/payments/access", headers=auth(token)).json()
    assert access["subscription_active"] is False


def test_unknown_payment_is_answered_with_200(client, monkeypatch):
    """Чужой платёж повторять сутки незачем."""
    monkeypatch.setattr(service.gateway, "get_payment", gateway_says())
    r = client.post("/api/v1/payments/webhook",
                    json=notification("yoo-not-ours"),
                    headers={"X-Forwarded-For": YOOKASSA_IP})
    assert r.status_code == 200


def test_gateway_failure_asks_to_retry(client, monkeypatch):
    """Связи нет — нужен повтор, поэтому не 200."""
    _, user_id = new_user(client)
    asyncio.run(_make_payment(user_id, "single", "yoo-down"))

    def boom(payment_id, **kw):
        raise service.gateway.YooKassaError("сеть недоступна")

    monkeypatch.setattr(service.gateway, "get_payment", boom)
    r = client.post("/api/v1/payments/webhook", json=notification("yoo-down"),
                    headers={"X-Forwarded-For": YOOKASSA_IP})
    assert r.status_code == 503


# --- списание ---------------------------------------------------------

def test_work_is_spent_once(client, monkeypatch):
    token, user_id = new_user(client)
    asyncio.run(_make_payment(user_id, "single", "yoo-spend"))
    monkeypatch.setattr(service.gateway, "get_payment", gateway_says())
    client.post("/api/v1/payments/webhook", json=notification("yoo-spend"),
                headers={"X-Forwarded-For": YOOKASSA_IP})

    async def spend():
        async with get_session_factory()() as s:
            first = await service.spend_work(s, user_id)
            await s.commit()
        async with get_session_factory()() as s:
            second = await service.spend_work(s, user_id)
            await s.commit()
        return first, second

    first, second = asyncio.run(spend())
    assert first is True
    assert second is False        # вторая работа уже не оплачена


def test_subscription_is_not_spent(client, monkeypatch):
    """Подписка на то и подписка: работы с неё не списываются."""
    _, user_id = new_user(client)
    asyncio.run(_make_payment(user_id, "month", "yoo-sub2"))
    monkeypatch.setattr(service.gateway, "get_payment",
                        gateway_says(amount="590.00"))
    client.post("/api/v1/payments/webhook", json=notification("yoo-sub2"),
                headers={"X-Forwarded-For": YOOKASSA_IP})

    async def spend_many():
        out = []
        for _ in range(5):
            async with get_session_factory()() as s:
                out.append(await service.spend_work(s, user_id))
                await s.commit()
        return out

    assert all(asyncio.run(spend_many()))


# --- тарифы и доступ --------------------------------------------------

def test_tariffs_are_public(client):
    r = client.get("/api/v1/payments/tariffs")
    assert r.status_code == 200
    codes = {t["code"] for t in r.json()["tariffs"]}
    assert codes == {"single", "month"}


def test_price_has_two_decimals():
    """ЮKassa принимает сумму строкой вида «490.00»."""
    assert get_tariff("single").price_rubles == "290.00"
    assert get_tariff("month").price_rubles == "590.00"


def test_access_requires_login(client):
    assert client.get("/api/v1/payments/access").status_code == 401


def test_create_requires_login(client):
    assert client.post("/api/v1/payments/create",
                       json={"tariff": "single"}).status_code == 401


def test_create_without_keys_says_so(client):
    """Без ключей магазина — честный отказ, а не ошибка библиотеки."""
    token, _ = new_user(client)
    r = client.post("/api/v1/payments/create", json={"tariff": "single"},
                    headers=auth(token))
    assert r.status_code == 503
    assert "не подключена" in r.json()["detail"]


def test_subscription_extends_without_losing_days():
    """Второй месяц, купленный заранее, прибавляется к остатку."""
    from datetime import datetime, timedelta, timezone
    grant = AccessGrant(user_id="u1")
    grant.extend_subscription(30)
    first = grant.subscription_until
    grant.extend_subscription(30)
    assert grant.subscription_until - first >= timedelta(days=29)
    assert grant.subscription_until > datetime.now(timezone.utc) + timedelta(days=58)
