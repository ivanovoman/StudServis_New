"""Тесты входа и учётных записей.

Проверяется в первую очередь то, что касается безопасности: пароль не
хранится, токен из базы не восстанавливается, чужой вход не срабатывает,
перебор упирается в ограничитель, а форма входа не выдаёт, кто у нас
зарегистрирован.
"""

from __future__ import annotations

import asyncio
import os
import tempfile

import pytest
from fastapi.testclient import TestClient

# БД подменяем до импорта приложения: иначе движок создастся на боевом
# файле и тесты начнут писать в реальное хранилище.
_TMP_DIR = tempfile.mkdtemp(prefix="auth_test_")
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_TMP_DIR}/test_auth.db"

from app.db import init_models, reset_engine  # noqa: E402
from app.main import app  # noqa: E402
from app.modules.auth.api import reset_attempts  # noqa: E402
from app.modules.auth.security import (  # noqa: E402
    hash_password, token_fingerprint, verify_password)

PASSWORD = "правильный-конь-батарейка"


@pytest.fixture(scope="module", autouse=True)
def _prepare_db():
    asyncio.run(init_models())
    yield
    asyncio.run(reset_engine())


@pytest.fixture()
def client():
    reset_attempts()
    with TestClient(app) as c:
        yield c


_counter = iter(range(1, 10_000))


def fresh_email() -> str:
    return f"user{next(_counter)}@example.com"


def register(client, email=None, password=PASSWORD, **extra):
    return client.post("/api/v1/auth/register", json={
        "email": email or fresh_email(), "password": password, **extra})


def auth_header(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# --- хранение пароля --------------------------------------------------

def test_password_is_not_stored_in_plain_text():
    stored = hash_password(PASSWORD)
    assert PASSWORD not in stored
    assert stored.startswith("scrypt$")


def test_same_password_gives_different_hashes():
    """Одинаковые пароли не должны выглядеть одинаково: иначе по базе
    видно, у кого пароли совпадают."""
    assert hash_password(PASSWORD) != hash_password(PASSWORD)


def test_broken_hash_does_not_crash_login():
    assert verify_password(PASSWORD, "мусор") is False
    assert verify_password(PASSWORD, "") is False


def test_token_is_stored_only_as_fingerprint():
    """Из базы нельзя достать токен — только его отпечаток."""
    token = "какой-то-токен"
    assert token not in token_fingerprint(token)
    assert len(token_fingerprint(token)) == 64


# --- регистрация ------------------------------------------------------

def test_register_returns_token_and_user(client):
    r = register(client)
    assert r.status_code == 201
    body = r.json()
    assert body["token"]
    assert body["user"]["email"]
    assert "password" not in str(body)


def test_email_case_and_spaces_ignored(client):
    email = fresh_email()
    assert register(client, f"  {email.upper()} ").status_code == 201
    # Иначе «Ivan@mail.ru» и «ivan@mail.ru» стали бы разными учётками.
    assert register(client, email).status_code == 409


def test_short_password_rejected(client):
    r = register(client, password="корот")
    assert r.status_code == 400
    assert "8" in r.json()["detail"]


def test_broken_email_rejected(client):
    assert register(client, "не-почта").status_code == 400


# --- вход -------------------------------------------------------------

def test_login_works(client):
    email = fresh_email()
    register(client, email)
    r = client.post("/api/v1/auth/login",
                    json={"email": email, "password": PASSWORD})
    assert r.status_code == 200
    assert r.json()["token"]


def test_wrong_password_rejected(client):
    email = fresh_email()
    register(client, email)
    r = client.post("/api/v1/auth/login",
                    json={"email": email, "password": "не тот пароль"})
    assert r.status_code == 401


def test_unknown_email_looks_the_same_as_wrong_password(client):
    """Форма входа не должна выдавать, кто у нас зарегистрирован."""
    email = fresh_email()
    register(client, email)

    wrong_pass = client.post("/api/v1/auth/login",
                             json={"email": email, "password": "неверный"})
    no_user = client.post("/api/v1/auth/login",
                          json={"email": fresh_email(), "password": PASSWORD})

    assert wrong_pass.status_code == no_user.status_code == 401
    assert wrong_pass.json()["detail"] == no_user.json()["detail"]


def test_too_many_attempts_locks_login(client):
    email = fresh_email()
    register(client, email)

    for _ in range(5):
        client.post("/api/v1/auth/login",
                    json={"email": email, "password": "неверный"})

    # Даже с правильным паролем — отказ: перебор должен упираться.
    r = client.post("/api/v1/auth/login",
                    json={"email": email, "password": PASSWORD})
    assert r.status_code == 429


def test_successful_login_clears_attempts(client):
    email = fresh_email()
    register(client, email)

    for _ in range(3):
        client.post("/api/v1/auth/login",
                    json={"email": email, "password": "неверный"})
    assert client.post("/api/v1/auth/login",
                       json={"email": email, "password": PASSWORD}
                       ).status_code == 200

    # Счётчик обнулён — значит опечатки не копятся годами.
    for _ in range(3):
        client.post("/api/v1/auth/login",
                    json={"email": email, "password": "неверный"})
    assert client.post("/api/v1/auth/login",
                       json={"email": email, "password": PASSWORD}
                       ).status_code == 200


# --- защищённые запросы -----------------------------------------------

def test_me_requires_token(client):
    assert client.get("/api/v1/auth/me").status_code == 401


def test_me_rejects_fake_token(client):
    # Латиницей: в HTTP-заголовок кириллица не помещается физически.
    r = client.get("/api/v1/auth/me", headers=auth_header("poddelnyj-token"))
    assert r.status_code == 401


def test_me_returns_user(client):
    email = fresh_email()
    token = register(client, email).json()["token"]
    r = client.get("/api/v1/auth/me", headers=auth_header(token))
    assert r.status_code == 200
    assert r.json()["email"] == email


def test_logout_kills_token(client):
    token = register(client).json()["token"]
    assert client.post("/api/v1/auth/logout",
                       headers=auth_header(token)).status_code == 200
    assert client.get("/api/v1/auth/me",
                      headers=auth_header(token)).status_code == 401


def test_logout_twice_is_not_an_error(client):
    """Вторая вкладка не должна получать ошибку из-за первой."""
    token = register(client).json()["token"]
    client.post("/api/v1/auth/logout", headers=auth_header(token))
    assert client.post("/api/v1/auth/logout",
                       headers=auth_header(token)).status_code == 200


def test_logout_all_keeps_current_session(client):
    email = fresh_email()
    first = register(client, email).json()["token"]
    second = client.post("/api/v1/auth/login",
                         json={"email": email, "password": PASSWORD}
                         ).json()["token"]

    r = client.post("/api/v1/auth/logout-all", headers=auth_header(second))
    assert r.status_code == 200
    assert r.json()["closed"] == 1
    # Текущее устройство остаётся в строю, остальные вылетают.
    assert client.get("/api/v1/auth/me",
                      headers=auth_header(second)).status_code == 200
    assert client.get("/api/v1/auth/me",
                      headers=auth_header(first)).status_code == 401


# --- смена пароля -----------------------------------------------------

def test_password_change_requires_old_password(client):
    token = register(client).json()["token"]
    r = client.post("/api/v1/auth/password",
                    json={"old_password": "не тот",
                          "new_password": "новый-длинный-пароль"},
                    headers=auth_header(token))
    assert r.status_code == 401


def test_password_change_closes_other_sessions(client):
    email = fresh_email()
    old_device = register(client, email).json()["token"]
    new_device = client.post("/api/v1/auth/login",
                             json={"email": email, "password": PASSWORD}
                             ).json()["token"]

    r = client.post("/api/v1/auth/password",
                    json={"old_password": PASSWORD,
                          "new_password": "новый-длинный-пароль"},
                    headers=auth_header(new_device))
    assert r.status_code == 200

    # Если пароль меняют из-за взлома, чужой сеанс обязан прекратиться.
    assert client.get("/api/v1/auth/me",
                      headers=auth_header(old_device)).status_code == 401
    assert client.post("/api/v1/auth/login",
                       json={"email": email,
                             "password": "новый-длинный-пароль"}
                       ).status_code == 200


# --- работы, собранные до регистрации ---------------------------------

def test_works_made_before_registration_are_claimed(client):
    """Человек собрал курсовую, потом зарегистрировался — она должна
    остаться на месте, иначе регистрация равна потере работы."""
    owner_key = "owner-before-signup-1"
    client.post("/api/v1/works",
                json={"topic": "Коллизии в праве", "plan": "## ГЛАВА 1"},
                headers={"X-Owner-Key": owner_key})

    body = register(client, owner_key=owner_key).json()
    assert body["user"]["claimed_works"] == 1


def test_claim_does_not_touch_other_peoples_works(client):
    client.post("/api/v1/works", json={"topic": "Чужая работа"},
                headers={"X-Owner-Key": "owner-someone-else"})
    body = register(client, owner_key="owner-unrelated-key").json()
    assert body["user"]["claimed_works"] == 0


# --- работы и учётная запись ------------------------------------------

def test_work_is_visible_from_another_device(client):
    """Ради этого всё и затевалось: вошёл с другого компьютера —
    увидел свои работы. Раньше они были привязаны к браузеру."""
    email = fresh_email()
    token = register(client, email).json()["token"]

    client.post("/api/v1/works",
                json={"topic": "Коллизии в праве", "plan": "## ГЛАВА 1"},
                headers={"X-Owner-Key": "device-one-key-aaa", **auth_header(token)})

    # Другое устройство: свой ключ браузера, тот же вход.
    other = client.post("/api/v1/auth/login",
                        json={"email": email, "password": PASSWORD}
                        ).json()["token"]
    r = client.get("/api/v1/works",
                   headers={"X-Owner-Key": "device-two-key-bbb",
                            **auth_header(other)})
    assert r.status_code == 200
    topics = [w["topic"] for w in r.json()["works"]]
    assert "Коллизии в праве" in topics


def test_other_users_work_is_not_visible(client):
    first = register(client).json()["token"]
    created = client.post("/api/v1/works", json={"topic": "Секретная работа"},
                          headers={"X-Owner-Key": "key-of-first-user",
                                   **auth_header(first)})
    work_id = created.json()["id"]

    second = register(client).json()["token"]
    r = client.get(f"/api/v1/works/{work_id}",
                   headers={"X-Owner-Key": "key-of-second-user",
                            **auth_header(second)})
    assert r.status_code == 404


def test_guest_cannot_reach_work_by_owner_key_after_claim(client):
    """Работа присвоена учётной записи — по старому ключу её больше
    не отдаём: иначе ключ из браузера остаётся лазейкой навсегда."""
    owner_key = "key-before-signup-xyz"
    created = client.post("/api/v1/works", json={"topic": "Моя работа"},
                          headers={"X-Owner-Key": owner_key})
    work_id = created.json()["id"]

    register(client, owner_key=owner_key)

    r = client.get(f"/api/v1/works/{work_id}",
                   headers={"X-Owner-Key": owner_key})
    assert r.status_code == 404


def test_guest_still_works_without_account(client):
    """Вход необязателен: бесплатные функции работают и без него."""
    r = client.post("/api/v1/works", json={"topic": "Без регистрации"},
                    headers={"X-Owner-Key": "guest-key-1234567"})
    assert r.status_code == 200
    listing = client.get("/api/v1/works",
                         headers={"X-Owner-Key": "guest-key-1234567"})
    assert listing.json()["works"][0]["topic"] == "Без регистрации"
