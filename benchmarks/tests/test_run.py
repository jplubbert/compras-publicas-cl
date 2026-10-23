import datetime as dt
import math
import re
from pathlib import Path

import pytest
import run
from google.api_core.exceptions import NotFound

HERE = Path(__file__).resolve().parents[1]
GIB = 1024**3
FILTER = re.compile(r"fecha_publicacion\s+BETWEEN\s+DATE\s+'\d{4}-\d{2}-\d{2}'\s+AND\s+DATE\s+'\d{4}-\d{2}-\d{2}'")


def test_measured_job_config_has_no_cache_bench_run_and_a_cap():
    config = run.job_config("20261022t120000", "q1_mart_organismo_mes", "licitaciones_sin_particion", 5 * GIB, False)
    assert config.use_query_cache is False
    assert config.labels["bench_run"] == "20261022t120000"
    assert config.labels["bench_query"] == "q1_mart_organismo_mes"
    assert config.maximum_bytes_billed == 5 * GIB
    assert not config.dry_run


def test_dry_run_job_config_has_bench_estimate_and_no_bench_run():
    config = run.job_config("20261022t120000", "q1_mart_organismo_mes", "licitaciones_sin_particion", GIB, True)
    assert config.dry_run is True
    assert config.labels == {"bench_estimate": "20261022t120000"}


def test_run_id_is_a_valid_label():
    rid = run.run_id(dt.datetime(2026, 10, 22, 9, 0, tzinfo=dt.timezone(dt.timedelta(hours=-3))))
    assert rid == "20261022t120000"
    assert re.fullmatch(r"[a-z0-9_-]{1,63}", rid)


def test_cap_bytes_respects_floor_ceiling_and_factor():
    assert run.cap_bytes(0) == 100 * 1024**2
    assert run.cap_bytes(None) == 100 * 1024**2
    assert run.cap_bytes(GIB) == math.ceil(GIB * 1.2)
    assert run.cap_bytes(100 * GIB) == 20 * GIB


def test_available_bytes_is_the_min_of_budget_and_quota_left():
    assert run.available_bytes(18, 20, 0) == 18 * GIB
    assert run.available_bytes(18, 20, 5 * GIB) == 15 * GIB
    assert run.available_bytes(18, 20, 25 * GIB) == 0


def test_plan_jobs_gives_variants_times_three_and_rewrites_on_the_clustered_table():
    jobs = run.plan_jobs(run.load_queries(HERE / "queries"), "p.bench")
    assert len(jobs) == 13
    variant_jobs = [job for job in jobs if job[0].startswith("q")]
    assert {(q, v) for q, v, _ in variant_jobs} == {
        (q, v)
        for q in ("q1_mart_organismo_mes", "q2_organismo_trimestre", "q3_adjudicadas_mes")
        for v in run.report.VARIANTS
    }
    rewrites = [job for job in jobs if job[0].startswith("r")]
    assert len(rewrites) == 4
    assert {v for _, v, _ in rewrites} == {"licitaciones_particionada_cluster"}
    assert all("`p.bench.licitaciones_particionada_cluster`" in sql for _, _, sql in rewrites)


@pytest.mark.parametrize("path", sorted((HERE / "queries").glob("*.sql")), ids=lambda p: p.name)
def test_every_table_reference_has_its_own_partition_filter(path):
    sql = path.read_text(encoding="utf-8")
    assert re.fullmatch(r"-- kind: (variant|rewrite)", sql.splitlines()[0])
    references = sql.count("{tabla}")
    assert references >= 1
    assert len(FILTER.findall(sql)) == references
    if path.name == "r2_self_join_antes.sql":
        assert references == 2


def test_variants_sql_has_the_three_variants():
    statements = dict(run.variant_statements("p.bench", "SELECT 1"))
    assert list(statements) == list(run.report.VARIANTS)
    cluster = statements["licitaciones_particionada_cluster"]
    assert "require_partition_filter = TRUE" in cluster
    assert "CLUSTER BY" in cluster
    assert "p.bench.licitaciones_particionada_cluster" in cluster
    assert all(s.rstrip().endswith("SELECT 1") for s in statements.values())


class FakeJob:
    def __init__(self, rows=(), processed=None):
        self.job_id = "fake"
        self.total_bytes_processed = processed
        self._rows = rows

    def result(self):
        return self._rows


class FakeClient:
    location = "us-central1"

    def __init__(self, used=0, estimate=GIB, tables=True):
        self.used, self.estimate, self.tables = used, estimate, tables
        self.measured = 0
        self.created = 0

    def query(self, sql, job_config):
        if "JOBS_BY_USER" in sql:
            return FakeJob([(self.used,)])
        if job_config.dry_run:
            return FakeJob(processed=self.estimate)
        if "bench_run" in (job_config.labels or {}):
            self.measured += 1
        elif sql.lstrip().startswith("CREATE"):
            self.created += 1
        return FakeJob()

    def get_table(self, name):
        if not self.tables:
            raise NotFound(name)
        return object()


def main_with(monkeypatch, client, *args):
    monkeypatch.setattr(run, "make_client", lambda project, location: client)
    return run.main(["--project", "p", *args])


def test_main_aborts_before_measuring_when_the_estimate_exceeds_the_budget(monkeypatch, tmp_path, capsys):
    client = FakeClient(estimate=2 * GIB)
    assert main_with(monkeypatch, client, "--budget-gib", "18", "--results-dir", str(tmp_path)) == 1
    assert client.measured == 0
    assert "available" in capsys.readouterr().err
    assert not any(tmp_path.iterdir())


def test_main_aborts_when_todays_usage_leaves_too_little_quota(monkeypatch, tmp_path):
    client = FakeClient(used=15 * GIB, estimate=GIB // 2)
    assert main_with(monkeypatch, client, "--results-dir", str(tmp_path)) == 1
    assert client.measured == 0


def test_main_dry_run_writes_the_estimate_report(monkeypatch, tmp_path):
    client = FakeClient(estimate=GIB // 4)
    assert main_with(monkeypatch, client, "--dry-run", "--results-dir", str(tmp_path)) == 0
    assert client.measured == 0 and client.created == 0
    written = list(tmp_path.iterdir())
    assert len(written) == 1 and written[0].name.endswith("-estimado.md")
    assert "bytes estimados (cota superior)" in written[0].read_text(encoding="utf-8")


def test_main_dry_run_without_variants_exits_1(monkeypatch, tmp_path, capsys):
    client = FakeClient(tables=False)
    assert main_with(monkeypatch, client, "--dry-run", "--results-dir", str(tmp_path)) == 1
    assert "sin --dry-run" in capsys.readouterr().err
