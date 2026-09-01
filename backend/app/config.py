"""Конфигурация приложения.

Всё читается из переменных окружения / .env. Секреты в коде не хранятся.
"""

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(BASE_DIR / ".env", BASE_DIR.parent / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ---- Приложение ----
    app_name: str = "StudRabots Retro"
    debug: bool = False
    api_prefix: str = "/api/v1"
    public_url: str = "http://localhost:8000"

    # ---- OpenRouter ----
    # Ключ ТОЛЬКО из окружения. Значения по умолчанию нет намеренно:
    # пусть падает явно, а не уходит в прод с чужим ключом.
    openrouter_api_key: str = ""
    openrouter_url: str = "https://openrouter.ai/api/v1/chat/completions"
    # Пустая строка = взять первую модель из models.yaml.
    openrouter_model: str = ""

    # ---- PostgreSQL ----
    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_user: str = "studservis"
    postgres_password: str = "studservis"
    postgres_db: str = "studservis"

    # ---- Qdrant (векторная база) ----
    qdrant_host: str = "localhost"
    qdrant_port: int = 6333
    qdrant_api_key: str | None = None
    # Модель эмбеддингов. multilingual — обязательно, работаем с русским.
    embedding_model: str = "intfloat/multilingual-e5-base"
    embedding_dim: int = 768

    # ---- Redis / Celery ----
    redis_host: str = "localhost"
    redis_port: int = 6379
    redis_db: int = 0

    # ---- Хранилище файлов ----
    storage_dir: Path = BASE_DIR / "storage"
    # Через сколько дней удалять сгенерированные работы (0 = не удалять).
    retention_days: int = 30

    # ---- Безопасность ----
    jwt_secret: str = Field(default="CHANGE-ME-IN-PRODUCTION")
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24 * 7
    cors_origins: list[str] = ["*"]

    # ---- ЮKassa ----
    yookassa_shop_id: str = ""
    yookassa_secret_key: str = ""

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+asyncpg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def redis_url(self) -> str:
        return f"redis://{self.redis_host}:{self.redis_port}/{self.redis_db}"

    @property
    def qdrant_url(self) -> str:
        return f"http://{self.qdrant_host}:{self.qdrant_port}"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
