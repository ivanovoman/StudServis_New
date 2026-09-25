"""Пароли и токены входа.

## Почему не внешняя библиотека

`bcrypt`, `passlib`, `argon2` — привычный выбор, но здесь достаточно
стандартной библиотеки: `hashlib.scrypt` входит в Python и реализован
на C. Одной зависимостью меньше — одной причиной для «а у нас не
ставится» меньше, тем более что пакеты в этом проекте уже разъезжались
между окружениями.

## Как хранится пароль

Не хранится. В базе лежит результат scrypt с индивидуальной солью:

    scrypt$16384$8$1$<соль в hex>$<хеш в hex>

Параметры записаны прямо в строку. Это позволит однажды поднять их, не
ломая старые записи: проверка читает те параметры, с которыми хеш был
посчитан, а не текущие.

scrypt выбран потому, что он требует памяти, а не только процессорного
времени: перебор на видеокартах становится дорогим. 16 МБ на проверку
(N=16384, r=8) — компромисс для машины с гигабайтом памяти.

## Как устроены токены входа

Токен — 32 случайных байта от `secrets`. В базу пишется его SHA-256, а
не он сам: если база утечёт, войти по её содержимому будет нельзя.

SHA-256 здесь достаточно, хотя для паролей её мало. Разница в том, что
токен — длинная случайная строка, а не слово из словаря: перебирать
нечего, и медленная функция не нужна.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

#: Параметры scrypt. N — объём работы и памяти (16 МБ при r=8).
SCRYPT_N = 16384
SCRYPT_R = 8
SCRYPT_P = 1
#: Ограничение памяти для scrypt: без запаса вызов падает с ошибкой.
SCRYPT_MAXMEM = 64 * 1024 * 1024

SALT_BYTES = 16
TOKEN_BYTES = 32

#: Пароль короче этого не примем. Восемь символов — нижняя граница
#: здравого смысла; верхняя нужна, чтобы гигантской строкой не занять
#: процессор на проверке.
PASSWORD_MIN = 8
PASSWORD_MAX = 200


class WeakPassword(ValueError):
    """Пароль не проходит минимальные требования."""


def validate_password(password: str) -> None:
    """Проверяет пароль до хеширования.

    Сложных правил намеренно нет: требования вроде «заглавная буква,
    цифра и спецсимвол» не делают пароли крепче — люди отвечают на них
    «Password1!». Длина решает больше.
    """
    if not isinstance(password, str) or len(password) < PASSWORD_MIN:
        raise WeakPassword(
            f"Пароль должен быть не короче {PASSWORD_MIN} символов")
    if len(password) > PASSWORD_MAX:
        raise WeakPassword(
            f"Пароль длиннее {PASSWORD_MAX} символов не принимается")


def hash_password(password: str, *, salt: bytes | None = None) -> str:
    """Считает хеш пароля вместе с солью и параметрами."""
    validate_password(password)
    salt = salt or secrets.token_bytes(SALT_BYTES)

    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P,
        maxmem=SCRYPT_MAXMEM,
    )
    return "$".join((
        "scrypt", str(SCRYPT_N), str(SCRYPT_R), str(SCRYPT_P),
        salt.hex(), digest.hex(),
    ))


def verify_password(password: str, stored: str) -> bool:
    """Сверяет пароль с сохранённым хешем.

    Возвращает False на любой поломке разбора: битая строка в базе не
    должна ронять вход, но и пропускать по ней нельзя.
    """
    if not password or not stored:
        return False
    try:
        algo, n, r, p, salt_hex, digest_hex = stored.split("$")
        if algo != "scrypt":
            return False
        digest = hashlib.scrypt(
            password.encode("utf-8"),
            salt=bytes.fromhex(salt_hex),
            n=int(n), r=int(r), p=int(p),
            maxmem=SCRYPT_MAXMEM,
        )
    except (ValueError, TypeError, MemoryError):
        return False

    # Сравнение постоянного времени: обычное «==» выходит из цикла на
    # первом несовпавшем байте и по времени ответа выдаёт, сколько
    # знаков угадано.
    return hmac.compare_digest(digest.hex(), digest_hex)


def new_token() -> str:
    """Новый токен входа. Отдаётся браузеру и больше нигде не хранится."""
    return secrets.token_urlsafe(TOKEN_BYTES)


def token_fingerprint(token: str) -> str:
    """Отпечаток токена для хранения в базе."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def normalize_email(email: str) -> str:
    """Приводит почту к единому виду.

    Регистр в адресе не значим, а пробелы по краям — обычная опечатка
    при копировании. Без этого «Ivan@mail.ru» и «ivan@mail.ru» стали бы
    разными учётными записями, и человек не смог бы войти.
    """
    return (email or "").strip().lower()
