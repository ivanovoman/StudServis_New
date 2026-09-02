"""Тесты кластерной диагностики.

Главное требование: диагностика должна опираться на эталон автора,
а не на абстрактную норму, и выдавать конкретные задания, а не число.
"""

import json

import pytest

from app.modules.humanizer.diagnostics import (
    AUTHOR_MEDIAN,
    AUTHOR_P90,
    CLUSTER_AUC,
    MIN_SIGNAL,
    diagnose,
)


LIVE = """
Открыть кофейню просто только на словах. Аренда съедает половину выручки,
персонал — ещё треть. Считайте заранее, иначе вылетите в первый же год.
Оборудование можно взять бэушное, а вот кофемашина решает всё: на ней
не экономят. Локация важнее интерьера, это проверено многими. Поток
людей считают ногами — встаньте у витрины и посчитайте сами, сколько
человек пройдёт за час. Меню держите коротким: гость не любит выбирать
долго, а вы не любите списывать просрочку. Себестоимость чашки
копеечная, наценка живёт за счёт места и скорости обслуживания.
Мы открывали три точки. Две выжили, одна нет — и виновата была аренда,
которую подняли на сорок процентов через год.
"""

MACHINE = """
В современном мире открытие кофейни представляет собой комплексный
процесс. Важно отметить, что данный вид бизнеса имеет ряд особенностей.
Рассмотрим основные аспекты. Во-первых, необходимо учитывать локацию.
Во-вторых, следует принимать во внимание конкуренцию. В-третьих,
важную роль играет качество продукции. Таким образом, можно сделать
вывод о необходимости системного подхода. Следует подчеркнуть, что
успешная реализация проекта возможна только при условии тщательного
планирования. В заключение стоит отметить комплексный характер
рассматриваемой проблематики и необходимость дальнейшего изучения.
"""


class TestBaseline:
    def test_author_baseline_present(self):
        assert set(AUTHOR_MEDIAN) == set(AUTHOR_P90)
        assert len(AUTHOR_MEDIAN) == 17

    def test_p90_not_below_median(self):
        for k in AUTHOR_MEDIAN:
            assert AUTHOR_P90[k] >= AUTHOR_MEDIAN[k], k

    def test_noise_clusters_excluded(self):
        """Кластеры без сигнала не должны порождать претензии."""
        noisy = [k for k, v in CLUSTER_AUC.items() if abs(v - 0.5) < MIN_SIGNAL]
        assert "K3" in noisy and "KG" in noisy
        d = diagnose(MACHINE)
        assert all(f.code not in noisy for f in d.findings)


class TestDiagnosis:
    def test_short_text_rejected(self):
        d = diagnose("Слишком коротко.")
        assert not d.available
        assert "коротк" in d.error

    def test_machine_text_has_more_findings(self):
        assert len(diagnose(MACHINE).findings) > len(diagnose(LIVE).findings)

    def test_findings_are_actionable(self):
        """Каждая претензия говорит, что делать."""
        for f in diagnose(MACHINE).findings:
            assert f.advice and len(f.advice) > 10
            assert f.title

    def test_rewrite_tasks_generated(self):
        tasks = diagnose(MACHINE).rewrite_tasks()
        assert tasks
        assert all(":" in t for t in tasks)

    def test_findings_reference_author_norm(self):
        """Претензия предъявляется относительно эталона автора."""
        for f in diagnose(MACHINE).findings:
            assert f.author_median == pytest.approx(
                AUTHOR_MEDIAN[f.code], abs=1e-6)
            assert f.excess > 0

    def test_report_marks_pai_as_advisory(self):
        r = diagnose(MACHINE).report()
        assert "справочно" in r
        assert "порогом не является" in r

    def test_engine_failure_does_not_crash(self, monkeypatch):
        """Падение движка не должно ронять пайплайн."""
        import app.modules.humanizer.diagnostics as mod
        monkeypatch.setattr(mod, "_run_engine",
                            lambda *a, **k: (_ for _ in ()).throw(RuntimeError("нет node")))
        d = diagnose(MACHINE)
        assert not d.available
        assert "нет node" in d.error


class TestSeparation:
    """Диагностика должна разделять классы не хуже pAI."""

    def _load(self, path):
        try:
            return [f["text"] for f in json.load(open(path))]
        except FileNotFoundError:
            pytest.skip("калибровочная выборка недоступна")

    def test_findings_count_separates(self):
        hum = self._load("/tmp/human_articles.json")
        ai = self._load("/tmp/ai_articles.json")
        h = [len(diagnose(t).findings) for t in hum]
        a = [len(diagnose(t).findings) for t in ai]
        assert sum(a) / len(a) > sum(h) / len(h)


class TestDiagnosticsAPI:
    @pytest.fixture
    def client(self):
        from fastapi.testclient import TestClient
        from app.main import app
        return TestClient(app)

    def test_analyze_returns_tasks(self, client):
        r = client.post("/api/v1/humanizer/analyze", json={"text": MACHINE})
        assert r.status_code == 200
        b = r.json()
        assert b["available"]
        assert b["rewrite_tasks"]
        assert "справочно" in b["p_ai_note"]
        assert b["author_corpus_size"] == 33

    def test_short_text_reported_not_crashed(self, client):
        r = client.post("/api/v1/humanizer/analyze", json={"text": "мало"})
        assert r.status_code == 200
        assert not r.json()["available"]
