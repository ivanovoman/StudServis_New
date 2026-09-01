"""AI Router — переключение моделей с fallback.

Порт логики из api/server.js, дополненный тремя вещами, которых там не было:

1. Список моделей вынесен в models.yaml — менять без правки кода.
2. Различаются 429 (временный лимит общего пула → повтор с паузой) и
   404/403 (модель мертва → сразу следующая). В оригинале любая ошибка
   означала переход к следующей модели, из-за чего временный 429 списывал
   рабочую модель.
3. Проверка доли кириллицы. Некоторые free-модели уходят в англоязычный
   reasoning ("We need to produce 4 sentences..."). Формально это успешный
   ответ 200, но для русской курсовой — брак. Такой ответ отбраковывается
   и роутер идёт дальше.

Статистика успешности пишется в ModelStats — по ТЗ нужна для динамической
корректировки приоритетов.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncIterator

import httpx
import yaml

from app.config import settings

logger = logging.getLogger(__name__)

CONFIG_PATH = Path(__file__).parent / "models.yaml"


class AllModelsFailedError(RuntimeError):
    """Ни одна модель из списка не ответила."""


@dataclass
class ModelConfig:
    id: str
    priority: int
    notes: str = ""


@dataclass
class RetryConfig:
    max_attempts_per_model: int = 2
    backoff_seconds: int = 5
    timeout_seconds: int = 180
    min_cyrillic_ratio: float = 0.6


@dataclass
class ModelStats:
    """Счётчики успешности — основа для динамических приоритетов."""
    success: int = 0
    failure: int = 0
    not_russian: int = 0
    total_latency: float = 0.0

    @property
    def attempts(self) -> int:
        return self.success + self.failure + self.not_russian

    @property
    def success_rate(self) -> float:
        return self.success / self.attempts if self.attempts else 0.0

    @property
    def avg_latency(self) -> float:
        return self.total_latency / self.success if self.success else 0.0


def cyrillic_ratio(text: str) -> float:
    """Доля кириллицы — ловит уход модели в англоязычный reasoning."""
    if not text:
        return 0.0
    cyr = sum(1 for c in text if "а" <= c.lower() <= "я" or c.lower() == "ё")
    return cyr / len(text)


def load_config(path: Path = CONFIG_PATH) -> tuple[list[ModelConfig], RetryConfig]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    models = [ModelConfig(**m) for m in data.get("models", [])]
    models.sort(key=lambda m: m.priority)
    return models, RetryConfig(**(data.get("retry") or {}))


class ModelRouter:
    """Перебирает модели по приоритету, пока одна не отдаст годный ответ."""

    def __init__(self, config_path: Path = CONFIG_PATH) -> None:
        self.models, self.retry = load_config(config_path)
        self.stats: dict[str, ModelStats] = defaultdict(ModelStats)
        if not self.models:
            raise ValueError("models.yaml пуст — нечего вызывать")

    def _ordered_models(self) -> list[str]:
        ids = [m.id for m in self.models]
        # Явное указание в .env выигрывает у файла конфигурации.
        override = settings.openrouter_model
        if override:
            ids = [override] + [m for m in ids if m != override]
        return ids

    def _headers(self) -> dict[str, str]:
        if not settings.openrouter_api_key:
            raise RuntimeError(
                "Не задан OPENROUTER_API_KEY. Пропиши его в .env "
                "(см. .env.example) — в коде ключей нет намеренно."
            )
        return {
            "Authorization": f"Bearer {settings.openrouter_api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": settings.public_url,
            "X-Title": "StudRabots Retro",
        }

    async def stream(
        self, messages: list[dict], *, check_russian: bool = True
    ) -> AsyncIterator[str]:
        """Отдаёт текст кусками (SSE от OpenRouter).

        Кириллица проверяется по первым ~400 символам: если модель начала
        отвечать по-английски, нет смысла ждать конец — переключаемся.
        """
        last_error: Exception | None = None

        for model_id in self._ordered_models():
            for attempt in range(self.retry.max_attempts_per_model):
                try:
                    buffer: list[str] = []
                    checked = False
                    async for delta in self._stream_one(model_id, messages):
                        buffer.append(delta)
                        if check_russian and not checked:
                            head = "".join(buffer)
                            if len(head) >= 400:
                                checked = True
                                if cyrillic_ratio(head) < self.retry.min_cyrillic_ratio:
                                    self.stats[model_id].not_russian += 1
                                    logger.warning(
                                        "%s отвечает не по-русски (кириллица %.2f) — "
                                        "переключаюсь",
                                        model_id, cyrillic_ratio(head),
                                    )
                                    raise _NotRussianError(model_id)
                                # Накопленное отдаём только после проверки,
                                # иначе пользователь увидит английский текст.
                                for chunk in buffer:
                                    yield chunk
                                buffer = []
                        elif checked:
                            yield buffer.pop()
                    # Короткий ответ — проверка не успела сработать.
                    if buffer:
                        tail = "".join(buffer)
                        if check_russian and not checked and tail.strip():
                            if cyrillic_ratio(tail) < self.retry.min_cyrillic_ratio:
                                self.stats[model_id].not_russian += 1
                                raise _NotRussianError(model_id)
                        yield tail

                    self.stats[model_id].success += 1
                    logger.info("Модель %s отработала успешно", model_id)
                    return

                except _NotRussianError as e:
                    last_error = e
                    break  # повтор не поможет — модель просто такая
                except _RetryableError as e:
                    last_error = e
                    self.stats[model_id].failure += 1
                    if attempt + 1 < self.retry.max_attempts_per_model:
                        await asyncio.sleep(e.retry_after or self.retry.backoff_seconds)
                        continue
                    break
                except Exception as e:  # noqa: BLE001
                    last_error = e
                    self.stats[model_id].failure += 1
                    logger.warning("Модель %s недоступна: %s", model_id, e)
                    break

        raise AllModelsFailedError(
            f"Ни одна из {len(self.models)} моделей не ответила. "
            f"Последняя ошибка: {last_error}. "
            "Проверь список: node scripts/check-models.js --all"
        )

    async def _stream_one(self, model: str, messages: list[dict]) -> AsyncIterator[str]:
        payload = {"model": model, "messages": messages, "stream": True}
        timeout = httpx.Timeout(self.retry.timeout_seconds, connect=30.0)

        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream(
                "POST", settings.openrouter_url,
                headers=self._headers(), json=payload,
            ) as response:
                if response.status_code != 200:
                    body = (await response.aread()).decode("utf-8", "replace")
                    raise self._classify(response.status_code, body, model)

                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:].strip()
                    if data == "[DONE]":
                        return
                    try:
                        parsed = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if "error" in parsed:
                        raise self._classify(
                            parsed["error"].get("code", 500), data, model
                        )
                    choices = parsed.get("choices") or [{}]
                    delta = (choices[0].get("delta") or {}).get("content")
                    if delta:
                        yield delta

    @staticmethod
    def _classify(status: int, body: str, model: str) -> Exception:
        """429 — повторяемо, остальное — модель списываем."""
        retry_after = None
        try:
            meta = json.loads(body).get("error", {}).get("metadata", {})
            retry_after = meta.get("retry_after_seconds")
        except Exception:  # noqa: BLE001
            pass
        snippet = body[:200]
        if status == 429:
            return _RetryableError(
                f"{model}: лимит общего пула провайдера (429)", retry_after
            )
        return RuntimeError(f"{model}: HTTP {status} — {snippet}")

    def stats_report(self) -> list[dict]:
        return [
            {
                "model": mid,
                "attempts": s.attempts,
                "success": s.success,
                "failure": s.failure,
                "not_russian": s.not_russian,
                "success_rate": round(s.success_rate, 3),
                "avg_latency": round(s.avg_latency, 2),
            }
            for mid, s in self.stats.items()
        ]


class _RetryableError(Exception):
    def __init__(self, message: str, retry_after: int | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class _NotRussianError(Exception):
    pass


_router: ModelRouter | None = None


def get_router() -> ModelRouter:
    global _router
    if _router is None:
        _router = ModelRouter()
    return _router
