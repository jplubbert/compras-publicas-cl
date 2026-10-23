import json
import re
import subprocess
import sys
from pathlib import Path

import report

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "jobs_completo.json"
REPORT = HERE.parent / "report.py"
FECHA = "2026-10-22"


def rows() -> list[dict]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def section(markdown: str, title: str) -> str:
    return re.search(rf"^## {title}$(.*?)(?=^## |\Z)", markdown, re.MULTILINE | re.DOTALL).group(1)


def table_lines(text: str) -> list[str]:
    return [line for line in text.splitlines() if line.startswith("|")]


def count_tables(text: str) -> int:
    return len(re.findall(r"^### .*\n\n\|", text, re.MULTILINE))


def test_complete_fixture_has_three_variant_tables_two_rewrites_and_no_exclusions():
    markdown = report.render(rows(), FECHA, "prueba")
    assert count_tables(section(markdown, "Variantes")) == 3
    rewrites = section(markdown, "Reescrituras")
    assert count_tables(rewrites) == 2
    antes = [line for line in table_lines(rewrites) if "| antes |" in line]
    assert len(antes) == 2
    assert all(line.endswith("| 0 % |") for line in antes)
    assert section(markdown, "Excluidos").strip() == "Ninguno"
    assert "| q1_mart_organismo_mes | licitaciones_particionada | 250000000 | 250000000 | 12000 | 75 % |" in markdown
    assert "| q1_mart_organismo_mes | licitaciones_particionada_cluster | 125000000 | 125000000 | 7000 | 87,5 % |" in (
        markdown
    )


def test_only_q1_rows_give_one_table_and_no_empty_cells():
    markdown = report.render(rows()[:3], FECHA, "prueba")
    assert count_tables(markdown) == 1
    for name in ("q2_", "q3_", "r1_", "r2_"):
        assert name not in markdown
    assert section(markdown, "Reescrituras").strip() == "Ninguno"
    for line in table_lines(markdown):
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        assert all(cells) and "—" not in cells


def test_group_without_base_gives_dash_without_raising():
    markdown = report.render(rows()[1:3], FECHA, "prueba")
    data = [line for line in table_lines(markdown) if "licitaciones_" in line]
    assert len(data) == 2
    assert all(line.endswith("| — |") for line in data)


def test_error_row_goes_to_excluidos_with_its_reason():
    failed = {**rows()[0], "job_id": "bench_failed", "error_result": "quotaExceeded"}
    markdown = report.render([*rows()[:3], failed], FECHA, "prueba")
    assert "bench_failed" not in "\n".join(table_lines(markdown))
    assert "error: quotaExceeded" in section(markdown, "Excluidos")
    assert "bench_failed" in section(markdown, "Excluidos")


def test_dry_run_shows_only_the_upper_bound_column():
    estimates = [{**row, "total_bytes_billed": None, "total_slot_ms": None} for row in rows()[:3]]
    markdown = report.render(estimates, FECHA, "prueba", dry_run=True)
    header = table_lines(markdown)[0]
    assert "bytes estimados (cota superior)" in header
    for column in ("bytes facturados", "bytes procesados", "slot ms"):
        assert column not in header
    assert "| q1_mart_organismo_mes | licitaciones_particionada_cluster | 125000000 | 87,5 % |" in markdown
    assert "poda por clustering" in markdown


def cli(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(REPORT), *args], check=False, capture_output=True, text=True)


def test_cli_dry_run_with_fixture_writes_only_the_estimate(tmp_path):
    result = cli(
        "--dry-run", "--run-id", "prueba", "--fecha", FECHA, "--fixture", str(FIXTURE), "--out-dir", str(tmp_path)
    )
    assert result.returncode == 0, result.stderr
    assert [p.name for p in tmp_path.iterdir()] == [f"{FECHA}-estimado.md"]


def test_cli_with_fixture_writes_only_the_report(tmp_path):
    result = cli("--run-id", "prueba", "--fecha", FECHA, "--fixture", str(FIXTURE), "--out-dir", str(tmp_path))
    assert result.returncode == 0, result.stderr
    assert [p.name for p in tmp_path.iterdir()] == [f"{FECHA}.md"]
    assert result.stdout.strip() == str(tmp_path / f"{FECHA}.md")


def test_cli_dry_run_without_fixture_exits_2(tmp_path):
    result = cli("--dry-run", "--run-id", "prueba", "--out-dir", str(tmp_path))
    assert result.returncode == 2
    assert not tmp_path.exists() or not any(tmp_path.iterdir())
