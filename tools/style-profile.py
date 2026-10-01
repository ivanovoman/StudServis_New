"""Профиль авторского стиля в числах.

Нужен, чтобы «пишет в стиле автора» перестало быть делом вкуса.
Скрипт снимает с текста несколько измеримых признаков и показывает,
насколько готовый раздел приблизился к образцу.

Признаки выбраны не наугад: это то, чем публицистика практикующего
юриста отличается от машинного академического текста. Длина фразы —
главный из них: модель по умолчанию строит периоды на двадцать пять
слов с причастными оборотами, а живой автор рубит фразу короче.

Запуск:
    python3 tools/style-profile.py образец.txt [готовый_раздел.txt ...]

Без аргументов берёт тексты из /tmp, оставшиеся от прогонов.
"""

from __future__ import annotations

import re
import statistics
import sys
from pathlib import Path

# Канцелярские обороты, по которым машинный юридический текст узнаётся
# мгновенно. У живого автора их единицы на весь текст.
CLERICAL = [
    r"осуществляется",
    r"является",
    r"данн(?:ый|ая|ое|ым|ого|ые|ых)",
    r"указанн",
    r"в целях",
    r"в рамках",
    r"необходимо отметить",
    r"представляется",
    r"вышеуказанн",
    r"в настоящее время",
]


def profile(text: str) -> dict[str, float]:
    sentences = [
        s.strip() for s in re.split(r"(?<=[.!?])\s+", text)
        if len(s.strip()) > 15
    ]
    if not sentences:
        return {}

    lengths = [len(s.split()) for s in sentences]
    clerical = sum(
        len(re.findall(pattern, text, re.IGNORECASE)) for pattern in CLERICAL
    )

    per_100 = 100 / len(sentences)
    return {
        "предложений": len(sentences),
        "медиана слов": statistics.median(lengths),
        "среднее слов": round(statistics.mean(lengths), 1),
        "коротких ≤8 слов, %": round(
            100 * sum(1 for n in lengths if n <= 8) / len(lengths), 1),
        "длинных ≥25 слов, %": round(
            100 * sum(1 for n in lengths if n >= 25) / len(lengths), 1),
        "«например» на 100": round(
            len(re.findall(r"[Нн]апример", text)) * per_100, 1),
        "ссылок на нормы на 100": round(
            len(re.findall(r"ст\.\s*\d+", text)) * per_100, 1),
        "скобочных пояснений на 100": round(
            len(re.findall(r"\([^)]{10,80}\)", text)) * per_100, 1),
        "канцелярит на 100": round(clerical * per_100, 1),
    }


def main(paths: list[str]) -> int:
    if not paths:
        print(__doc__)
        return 1

    profiles = []
    for path in paths:
        text = Path(path).read_text(encoding="utf-8")
        p = profile(text)
        if not p:
            print(f"{path}: текста слишком мало")
            continue
        profiles.append((Path(path).name, p))

    if not profiles:
        return 1

    keys = list(profiles[0][1])
    width = max(len(k) for k in keys) + 2
    header = " " * width + "".join(f"{name[:14]:>16}" for name, _ in profiles)
    print(header)
    print("-" * len(header))
    for key in keys:
        row = f"{key:{width}}"
        for _, p in profiles:
            row += f"{p.get(key, 0):>16}"
        print(row)

    if len(profiles) > 1:
        print(
            "\nПервый столбец — образец. Чем ближе к нему остальные, тем "
            "лучше воспроизведён стиль.\nСамый показательный признак — "
            "доля длинных фраз: именно они выдают машинный текст."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
