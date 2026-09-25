"""Тарифы.

Всё, что касается денег, собрано в одном месте: цены, названия,
длительность. Менять их правкой этого файла, а не поиском чисел по
коду — иначе однажды цена в письме разойдётся с ценой на кнопке.

## Что бесплатно

Анализ темы и план работы — бесплатны и без ограничений. Это не
маркетинговая уловка, а сознательное требование: человек должен видеть,
на что он тратит деньги, до того как их потратил.

Платными остаются сборка работы целиком и выгрузка .docx — то, ради
чего сервис и существует.

## Почему цена в копейках

В рублях с копейками — дробные числа, а дробные числа нельзя складывать
без потерь: 0.1 + 0.2 даёт 0.30000000000000004. В деньгах такие хвосты
превращаются в расхождение с банком. Поэтому внутри всё в копейках
целыми числами, а в рубли переводится только на границе — при разговоре
с ЮKassa и при показе человеку.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Tariff:
    """Что человек покупает."""

    code: str
    title: str
    #: Цена в копейках: целое число, чтобы не терять хвосты.
    price_kopecks: int
    #: Сколько работ открывает. None — сколько угодно (подписка).
    works: int | None
    #: Срок действия в днях. None — бессрочно (разовая покупка).
    days: int | None
    description: str

    @property
    def price_rubles(self) -> str:
        """Цена строкой для ЮKassa: «490.00»."""
        return f"{self.price_kopecks // 100}.{self.price_kopecks % 100:02d}"

    @property
    def is_subscription(self) -> bool:
        return self.days is not None


#: Стартовые цены. Меняются здесь и нигде больше.
TARIFFS: dict[str, Tariff] = {
    "single": Tariff(
        code="single",
        title="Одна работа",
        price_kopecks=49000,          # 490 ₽
        works=1,
        days=None,
        description="Сборка одной работы целиком и выгрузка в Word. "
                    "Без срока — используйте, когда будет нужно.",
    ),
    "month": Tariff(
        code="month",
        title="Подписка на месяц",
        price_kopecks=149000,         # 1490 ₽
        works=None,
        days=30,
        description="Сколько угодно работ в течение 30 дней.",
    ),
}

DEFAULT_TARIFF = "single"


def get_tariff(code: str) -> Tariff | None:
    return TARIFFS.get((code or "").strip())


def all_tariffs() -> list[Tariff]:
    return list(TARIFFS.values())
