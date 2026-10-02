"""Диагностика текста по кластерам ИИ-детектора.

Главный продукт этого модуля — не вероятность «текст машинный», а
**список конкретных претензий к тексту**, каждая с указанием, что
переписать. Итоговый pAI отдаётся отдельно и помечен как справочный.

Почему так. Проверка показала, что pAI обманывается припиской двух
фальшивых сносок и фразы «возможно, я ошибаюсь»: оценка падает с 0.776
до 0.500 без единого изменения по существу. Кластерные подсчёты так
обмануть нельзя — они считают ритм, симметрию списков, долю
номинализаций, и приписка их не сдвинет.

## Надёжность кластеров измерена, а не предположена

На калибровочной выборке (7 статей автора против 8 текстов
free-моделей, разметка снята с обеих сторон) посчитан AUC каждого
кластера. Результат оказался не тем, что я ожидал:

    K6 Нейтральность  AUC 1.000  ← идеальное разделение
    K7 Синтаксис      AUC 0.000  ← идеальное, но ОБРАТНОЕ
    K4 Ритм           AUC 0.848
    H1 Маркеры        AUC 0.125  (человеческий кластер, инверсия ожидаема)
    K5 Структура      AUC 0.241  ← слабее, чем я предполагал
    K1 Лексика        AUC 0.277  ← слабее, чем я предполагал
    K3 Статистика     AUC 0.536  ← шум
    KG, H4, HA, HE    AUC ~0.5   ← шум, не используются

То есть «K1 Лексика, K5 Структура», которые я советовал раньше,
на честных данных работают слабо, а K6 и K4 — сильно. Поэтому веса
здесь взяты из замера, а не из интуиции.

Выборка мала (15 текстов), поэтому крайние значения AUC 1.000 и 0.000
почти наверняка оптимистичны. Кластеры с |AUC−0.5| < 0.15 исключены
как шум.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.modules.humanizer.detector_bridge import strip_markdown

ENGINE = Path(__file__).parent / "vendor" / "detector_engine.js"

# AUC каждого кластера, измеренный на калибровочной выборке.
# Значение > 0.5 — кластер выше у ИИ; < 0.5 — выше у человека.
CLUSTER_AUC: dict[str, float] = {
    "K6": 1.000, "K7": 0.000, "K4": 0.848, "H1": 0.125,
    "H3": 0.214, "K5": 0.241, "K1": 0.277, "K8": 0.714,
    "K9": 0.696, "K2": 0.661, "H2": 0.607, "H5": 0.438,
    "K3": 0.536, "KG": 0.491, "H4": 0.500, "HA": 0.500, "HE": 0.500,
}

# Ниже этого уровня разделения кластер считаем шумом.
MIN_SIGNAL = 0.15

# Эталон автора: медиана и p90 каждого кластера по 33 его текстам
# (7 фрагментов статей + 26 разделов диссертаций).
#
# Без эталона диагностика бесполезна: например, медиана H1 «живые
# маркеры» у автора всего 0.021, то есть их почти нет и в его
# собственных текстах. Жаловаться на низкий H1 — требовать от
# генерации быть живее автора. Претензию предъявляем только когда
# кластер вышел за ЕГО диапазон, а не за абстрактную норму.
AUTHOR_MEDIAN: dict[str, float] = {
    "K1": 0.0222, "K2": 0.0210, "K3": 0.4316, "K4": 0.2803,
    "K5": 0.0527, "K6": 0.4166, "K7": 0.0564, "K8": 0.0575,
    "KG": 0.2333, "H1": 0.0209, "H2": 0.3006, "H3": 0.2025,
    "H4": 0.0, "H5": 0.6840, "K9": 0.0, "HA": 0.0, "HE": 0.0,
}
AUTHOR_P90: dict[str, float] = {
    "K1": 0.0486, "K2": 0.0840, "K3": 0.4799, "K4": 0.4066,
    "K5": 0.1792, "K6": 0.4568, "K7": 0.0836, "K8": 0.1382,
    "KG": 0.4200, "H1": 0.0897, "H2": 0.3646, "H3": 0.3525,
    "H4": 0.0081, "H5": 1.0, "K9": 0.0, "HA": 0.5542, "HE": 0.0,
}
AUTHOR_CORPUS_SIZE = 33

# Что означает высокий балл кластера и что с этим делать.
CLUSTER_ADVICE: dict[str, tuple[str, str]] = {
    "K1": ("Шаблонная лексика",
           "Убрать штампы и канцелярит, заменить на конкретные формулировки"),
    "K2": ("Машинное оформление",
           "Убрать избыточные выделения и симметричную разметку"),
    "K3": ("Бедный словарь",
           "Разнообразить лексику, убрать повторы одних и тех же слов"),
    "K4": ("Ровный ритм",
           "Перемешать длины предложений: добавить короткие фразы между длинными"),
    "K5": ("Шаблонная структура",
           "Сломать симметрию: разной длины абзацы, не три пункта подряд"),
    "K6": ("Стерильная нейтральность",
           "Добавить авторскую позицию и оценку, а не только изложение фактов"),
    "K7": ("Однотипный синтаксис",
           "Менять конструкции: не начинать предложения одинаково"),
    "K8": ("Обобщённый дискурс",
           "Добавить конкретику: цифры, названия, ссылки на нормы и дела"),
    "KG": ("Признаки Grok/GigaChat", "Переписать характерные обороты"),
}

HUMAN_ADVICE: dict[str, tuple[str, str]] = {
    "H1": ("Нет живых маркеров",
           "Добавить авторский голос там, где это уместно жанру"),
    "H2": ("Нет живого ритма", "Добавить перепады длины предложений"),
    "H3": ("Слишком линейно",
           "Разрешить отступления и возвраты к мысли, а не строгий список"),
    "H5": ("Бедная пунктуация",
           "Использовать тире, скобки, вопросы — там, где они уместны"),
}


@dataclass
class ClusterFinding:
    code: str
    name: str
    score: float
    auc: float
    title: str
    advice: str
    is_human_cluster: bool
    author_median: float = 0.0
    excess: float = 0.0
    """Насколько кластер вышел за диапазон автора, в долях."""

    @property
    def signal(self) -> float:
        """Насколько кластер надёжен: 0 — монетка, 0.5 — идеал."""
        return abs(self.auc - 0.5)

    @property
    def reliability(self) -> str:
        s = self.signal
        return "сильный" if s >= 0.30 else "средний" if s >= 0.20 else "слабый"


@dataclass
class Diagnosis:
    genre: str
    p_ai: float
    findings: list[ClusterFinding] = field(default_factory=list)
    noisy_clusters: list[str] = field(default_factory=list)
    error: str | None = None

    @property
    def available(self) -> bool:
        return self.error is None

    def top(self, n: int = 5) -> list[ClusterFinding]:
        """Сортировка по величине отклонения от автора × надёжности."""
        return sorted(
            self.findings,
            key=lambda f: f.excess * (0.5 + f.signal),
            reverse=True,
        )[:n]

    @property
    def clean(self) -> bool:
        """Ни один кластер не вышел за диапазон автора."""
        return self.available and not self.findings

    def rewrite_tasks(self, n: int = 5) -> list[str]:
        """Готовые задания humanizer'у: что именно править."""
        return [f"{f.title}: {f.advice}" for f in self.top(n)]

    def report(self) -> str:
        if not self.available:
            return f"Диагностика недоступна: {self.error}"
        lines = [
            f"Жанр: {self.genre}",
            f"pAI = {self.p_ai:.2f} — справочно, порогом не является "
            "(зависит от длины текста и обманывается приписками)",
            "",
        ]
        if self.clean:
            lines.append(
                "Претензий нет: все кластеры укладываются в диапазон "
                f"автора (эталон — {AUTHOR_CORPUS_SIZE} его текста)."
            )
        else:
            lines.append("Претензии к тексту (по убыванию важности):")
        for f in self.top():
            lines.append(
                f"  • {f.title} — {f.score:.2f} при норме автора "
                f"{f.author_median:.2f} (превышение {f.excess:+.0%}) "
                f"[{f.name}, сигнал {f.reliability}]"
            )
            lines.append(f"      что делать: {f.advice}")
        if self.noisy_clusters:
            lines.append("")
            lines.append(
                "Не учитывались (на нашей выборке неотличимы от шума): "
                + ", ".join(self.noisy_clusters)
            )
        return "\n".join(lines)

    def to_dict(self) -> dict[str, Any]:
        return {
            "available": self.available,
            "clean": self.clean,
            "error": self.error,
            "genre": self.genre,
            "p_ai": self.p_ai,
            "p_ai_note": (
                "справочно: зависит от длины текста и обманывается "
                "приписками, порогом приёмки не является"
            ),
            "findings": [
                {
                    "code": f.code, "name": f.name, "title": f.title,
                    "score": round(f.score, 3), "auc": f.auc,
                    "author_median": f.author_median,
                    "excess": round(f.excess, 3),
                    "reliability": f.reliability, "advice": f.advice,
                    "human_cluster": f.is_human_cluster,
                }
                for f in self.top(8)
            ],
            "rewrite_tasks": self.rewrite_tasks(),
            "ignored_as_noise": self.noisy_clusters,
        }


def _run_engine(text: str, timeout: float = 20.0) -> dict[str, Any]:
    if not ENGINE.exists():
        raise RuntimeError(f"движок детектора не найден: {ENGINE}")
    node = shutil.which("node") or shutil.which("nodejs")
    if not node:
        raise RuntimeError("node не установлен")
    proc = subprocess.run(
        [node, str(ENGINE)],
        input=json.dumps({"text": text}),
        capture_output=True, text=True, timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"движок вернул код {proc.returncode}: {proc.stderr[:200]}")
    data = json.loads(proc.stdout)
    if not data.get("ok"):
        raise RuntimeError(data.get("error", "неизвестная ошибка движка"))
    return data


def diagnose(text: str) -> Diagnosis:
    """Разбирает текст по кластерам и выдаёт задания на переписывание.

    Разметка снимается обязательно: без этого детектор разделяет
    источник данных (markdown против PDF), а не авторство.
    """
    clean = strip_markdown(text or "")
    if len(clean.split()) < 40:
        return Diagnosis(genre="", p_ai=0.0,
                         error="текст слишком короткий для диагностики")
    try:
        data = _run_engine(clean)
    except Exception as exc:              # движок не должен ронять пайплайн
        return Diagnosis(genre="", p_ai=0.0, error=str(exc))

    clusters = data.get("clusters", {})
    meta = data.get("meta", {})
    diag = Diagnosis(genre=data.get("genre", ""), p_ai=float(data.get("pAI", 0.0)))

    for code, raw in clusters.items():
        auc = CLUSTER_AUC.get(code, 0.5)
        if abs(auc - 0.5) < MIN_SIGNAL:
            diag.noisy_clusters.append(code)
            continue

        score = float(raw)
        is_human = bool(meta.get(code, {}).get("human"))
        median = AUTHOR_MEDIAN.get(code, 0.0)
        ceiling = max(AUTHOR_P90.get(code, 0.0), median + 0.05)

        if is_human:
            # Человеческий кластер: тревожит провал НИЖЕ авторского уровня.
            title, advice = HUMAN_ADVICE.get(
                code, ("Мало человеческих признаков", "Добавить живости"))
            floor = min(median, AUTHOR_P90.get(code, median))
            if score >= floor or median <= 0.001:
                continue                      # в норме автора либо у него самого нет
            excess = (floor - score) / max(floor, 1e-6)
        else:
            # Машинный кластер: тревожит превышение авторского потолка.
            title, advice = CLUSTER_ADVICE.get(
                code, ("Машинный признак", "Переписать фрагмент"))
            if score <= ceiling:
                continue                      # укладывается в разброс автора
            excess = (score - ceiling) / max(ceiling, 1e-6)

        diag.findings.append(ClusterFinding(
            code=code, name=meta.get(code, {}).get("name", code),
            score=score, auc=auc, title=title, advice=advice,
            is_human_cluster=is_human,
            author_median=median, excess=excess,
        ))
    return diag
