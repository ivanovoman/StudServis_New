"""Тесты хранения работ.

Главное, что здесь проверяется, — что работа не теряется и что чужую
работу нельзя ни прочитать, ни испортить.
"""

from __future__ import annotations

import asyncio
import os
import tempfile

import pytest
from fastapi.testclient import TestClient

# БД подменяем до импорта приложения: иначе движок создастся на боевом
# файле и тесты начнут писать в реальное хранилище.
_TMP_DIR = tempfile.mkdtemp(prefix="works_test_")
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_TMP_DIR}/test_works.db"

from app.db import init_models, reset_engine  # noqa: E402
from app.main import app  # noqa: E402

KEY_A = "owner-aaaaaaaaaaaa"
KEY_B = "owner-bbbbbbbbbbbb"


@pytest.fixture(scope="module", autouse=True)
def _prepare_db():
    asyncio.run(init_models())
    yield
    asyncio.run(reset_engine())


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _create(client, key=KEY_A, topic="Коллизии в праве"):
    r = client.post(
        "/api/v1/works",
        json={"topic": topic, "plan": "## ГЛАВА 1", "settings": {"chapters": 2}},
        headers={"X-Owner-Key": key},
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_create_and_read(client):
    work_id = _create(client)
    r = client.get(f"/api/v1/works/{work_id}", headers={"X-Owner-Key": KEY_A})
    assert r.status_code == 200
    data = r.json()
    assert data["topic"] == "Коллизии в праве"
    assert data["status"] == "draft"
    assert data["pieces"] == []


def test_owner_key_required(client):
    r = client.post("/api/v1/works", json={"topic": "x"})
    assert r.status_code == 400
    assert "X-Owner-Key" in r.json()["detail"]

    # Слишком короткий ключ тоже не проходит.
    r = client.post(
        "/api/v1/works", json={"topic": "x"}, headers={"X-Owner-Key": "abc"}
    )
    assert r.status_code == 400


def test_foreign_work_is_invisible(client):
    """Чужую работу нельзя ни прочитать, ни изменить, ни удалить."""
    work_id = _create(client, key=KEY_A)

    for method, url, kwargs in [
        ("get", f"/api/v1/works/{work_id}", {}),
        ("patch", f"/api/v1/works/{work_id}", {"json": {"topic": "чужое"}}),
        ("delete", f"/api/v1/works/{work_id}", {}),
        (
            "post",
            f"/api/v1/works/{work_id}/pieces",
            {"json": {"kind": "introduction", "text": "чужое"}},
        ),
    ]:
        r = getattr(client, method)(url, headers={"X-Owner-Key": KEY_B}, **kwargs)
        assert r.status_code == 404, f"{method} {url} -> {r.status_code}"

    # И в списке другого владельца её нет.
    r = client.get("/api/v1/works", headers={"X-Owner-Key": KEY_B})
    assert all(w["id"] != work_id for w in r.json()["works"])

    # А у владельца работа цела.
    r = client.get(f"/api/v1/works/{work_id}", headers={"X-Owner-Key": KEY_A})
    assert r.status_code == 200
    assert r.json()["topic"] == "Коллизии в праве"


def test_pieces_are_saved_in_order(client):
    work_id = _create(client)
    parts = [
        ("introduction", None, "Введение " * 100),
        ("section", "1.1", "Первый раздел " * 200),
        ("section", "1.2", "Второй раздел " * 200),
        ("conclusion", None, "Заключение " * 80),
    ]
    for kind, number, text in parts:
        r = client.post(
            f"/api/v1/works/{work_id}/pieces",
            json={"kind": kind, "number": number, "heading": number or kind,
                  "text": text},
            headers={"X-Owner-Key": KEY_A},
        )
        assert r.status_code == 200, r.text

    r = client.get(f"/api/v1/works/{work_id}", headers={"X-Owner-Key": KEY_A})
    got = r.json()["pieces"]
    assert [p["kind"] for p in got] == [p[0] for p in parts]
    assert [p["position"] for p in got] == [0, 1, 2, 3]
    # Знаки считаются без пробелов.
    assert got[0]["chars"] == len("".join(("Введение " * 100).split()))


def test_rewriting_piece_replaces_it(client):
    """Пересборка раздела заменяет прежний вариант, а не плодит копии."""
    work_id = _create(client)
    for text in ("первый вариант", "второй вариант"):
        client.post(
            f"/api/v1/works/{work_id}/pieces",
            json={"kind": "section", "number": "1.1", "text": text, "position": 0},
            headers={"X-Owner-Key": KEY_A},
        )

    pieces = client.get(
        f"/api/v1/works/{work_id}", headers={"X-Owner-Key": KEY_A}
    ).json()["pieces"]
    assert len(pieces) == 1
    assert pieces[0]["text"] == "второй вариант"


def test_bad_kind_rejected(client):
    work_id = _create(client)
    r = client.post(
        f"/api/v1/works/{work_id}/pieces",
        json={"kind": "приложение", "text": "x"},
        headers={"X-Owner-Key": KEY_A},
    )
    assert r.status_code == 400
    assert "kind" in r.json()["detail"]


def test_list_shows_totals_without_text(client):
    work_id = _create(client, topic="Работа со списком")
    client.post(
        f"/api/v1/works/{work_id}/pieces",
        json={"kind": "introduction", "text": "а" * 500},
        headers={"X-Owner-Key": KEY_A},
    )

    r = client.get("/api/v1/works", headers={"X-Owner-Key": KEY_A})
    assert r.status_code == 200
    item = next(w for w in r.json()["works"] if w["id"] == work_id)
    assert item["pieces"] == 1
    assert item["chars"] == 500
    # В списке текстов быть не должно — он весит сотни килобайт.
    assert "text" not in item


def test_patch_status_and_validation(client):
    work_id = _create(client)
    r = client.patch(
        f"/api/v1/works/{work_id}",
        json={"status": "done", "topic": "Новая тема"},
        headers={"X-Owner-Key": KEY_A},
    )
    assert r.status_code == 200
    assert r.json()["status"] == "done"
    assert r.json()["topic"] == "Новая тема"

    r = client.patch(
        f"/api/v1/works/{work_id}",
        json={"status": "чепуха"},
        headers={"X-Owner-Key": KEY_A},
    )
    assert r.status_code == 400


def test_delete_removes_work_and_pieces(client):
    work_id = _create(client)
    client.post(
        f"/api/v1/works/{work_id}/pieces",
        json={"kind": "introduction", "text": "текст"},
        headers={"X-Owner-Key": KEY_A},
    )
    r = client.delete(f"/api/v1/works/{work_id}", headers={"X-Owner-Key": KEY_A})
    assert r.status_code == 200

    r = client.get(f"/api/v1/works/{work_id}", headers={"X-Owner-Key": KEY_A})
    assert r.status_code == 404


def test_work_survives_restart(client):
    """Ради этого всё и делалось: работа переживает перезапуск сервера."""
    work_id = _create(client, topic="Переживёт перезапуск")
    client.post(
        f"/api/v1/works/{work_id}/pieces",
        json={"kind": "section", "number": "1.1", "text": "важный текст"},
        headers={"X-Owner-Key": KEY_A},
    )

    # Полный сброс подключения — как будто процесс перезапустили.
    asyncio.run(reset_engine())

    with TestClient(app) as fresh:
        r = fresh.get(f"/api/v1/works/{work_id}", headers={"X-Owner-Key": KEY_A})
        assert r.status_code == 200
        data = r.json()
        assert data["topic"] == "Переживёт перезапуск"
        assert data["pieces"][0]["text"] == "важный текст"
