"""Поведение OpenAlex при отказах и лимитах.

Тесты офлайновые: сеть подменяется фиктивным `fetcher`. Настоящий
OpenAlex с февраля 2026 отвечает 429 всем, у кого нет ключа, и
привязываться к его настроению нельзя.
"""

from __future__ import annotations

import io
import logging
import urllib.error

from app.modules.sources import openalex


# --- лимиты OpenAlex (осень 2026) -------------------------------------
#
# С февраля 2026 OpenAlex требует ключ, а анонимам оставил около сотни
# запросов в сутки на всех. Раньше отказ провайдера выглядел как «по
# теме ничего не написано»: исключение глушилось, наверх шёл пустой
# список. Теперь отказ обязан быть видимым в логе, а ожидание —
# осмысленным: без ключа ждать нечего, потолок снимается назавтра.

def test_limit_without_key_is_not_awaited(monkeypatch):
    """Без ключа повторов нет: ждать сутки мы не станем."""
    monkeypatch.delenv("OPENALEX_API_KEY", raising=False)
    calls = []

    def fetcher(url, timeout):
        calls.append(url)
        raise urllib.error.HTTPError(url, 429, "Too Many Requests", {},
                                     io.BytesIO(b'{"retryAfter": 36}'))

    assert openalex.search("тема", fetcher=fetcher) == []
    assert len(calls) == 1


def test_limit_with_key_is_retried(monkeypatch):
    """С ключом короткая пауза оправдана: лимит посекундный."""
    monkeypatch.setenv("OPENALEX_API_KEY", "тест")
    monkeypatch.setattr(openalex.time, "sleep", lambda s: None)
    calls = []

    def fetcher(url, timeout):
        calls.append(url)
        if len(calls) == 1:
            raise urllib.error.HTTPError(url, 429, "Too Many Requests", {},
                                         io.BytesIO(b'{"retryAfter": 2}'))
        return {"results": []}

    openalex.search("тема", fetcher=fetcher)
    assert len(calls) == 2


def test_failure_is_logged(monkeypatch, caplog):
    """Молчаливый ноль однажды уже стоил нам суток догадок."""
    monkeypatch.delenv("OPENALEX_API_KEY", raising=False)

    def fetcher(url, timeout):
        raise urllib.error.URLError("сеть недоступна")

    with caplog.at_level(logging.WARNING):
        openalex.search("тема", fetcher=fetcher)
    assert "OpenAlex не ответил" in caplog.text


def test_api_key_goes_into_url(monkeypatch):
    monkeypatch.setenv("OPENALEX_API_KEY", "секрет")
    assert "api_key=%D1%81" in openalex.build_query_url("тема") \
        or "api_key=" in openalex.build_query_url("тема")


def test_budget_is_shared_across_queries(monkeypatch):
    """Бюджет ожидания один на весь подбор, а не на каждый запрос."""
    budget = openalex._Budget(5.0)
    assert budget.take(4.0) == 4.0
    assert budget.take(4.0) == 1.0
    assert budget.take(4.0) == 0.0
