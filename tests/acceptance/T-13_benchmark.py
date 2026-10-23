"""Acceptance of REQ-013 (before/after benchmark, DEC-007), examples E1-E4, offline (DEC-005).

The interfaces come from plans/T-13.md: benchmarks/generate.py exposes SEED, ROWS and render(seed, rows) -> str, whose
text starts with a "-- target rows: <rows>" header; benchmarks/report.py exposes render(rows, fecha, run_id,
dry_run=False) -> str, with rows as dicts holding the columns read from INFORMATION_SCHEMA.JOBS. The benchmarks/ modules
are imported inside each test so that this file is collected before T-13 exists.
"""

import importlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BENCHMARKS = ROOT / "benchmarks"
FECHA = "2026-10-22"
RUN_ID = "20261022t120000"

BASE = "licitaciones_sin_particion"
PARTICIONADA = "licitaciones_particionada"
CLUSTER = "licitaciones_particionada_cluster"


def load(name: str):
    if str(BENCHMARKS) not in sys.path:
        sys.path.insert(0, str(BENCHMARKS))
    return importlib.import_module(name)


def job(job_id, query, variant, billed, processed, slot_ms, cache_hit=False):
    return {
        "job_id": job_id,
        "cache_hit": cache_hit,
        "error_result": None,
        "total_bytes_billed": billed,
        "total_bytes_processed": processed,
        "total_slot_ms": slot_ms,
        "bench_query": query,
        "bench_variant": variant,
    }


def jobs_three_variants():
    """q1 over the 3 variants: the base bills 1,000,000,000 bytes, then 250,000,000 and 125,000,000."""
    return [
        job("bench_q1_base", "q1_mart_organismo_mes", BASE, 1_000_000_000, 1_000_000_000, 40_000),
        job("bench_q1_part", "q1_mart_organismo_mes", PARTICIONADA, 250_000_000, 250_000_000, 12_000),
        job("bench_q1_cluster", "q1_mart_organismo_mes", CLUSTER, 125_000_000, 125_000_000, 7_000),
    ]


def tables(markdown: str) -> list[list[dict[str, str]]]:
    """Every Markdown table of the report, as a list of rows keyed by header."""
    found, header, rows = [], None, []
    for line in markdown.splitlines() + [""]:
        stripped = line.strip()
        if stripped.startswith("|"):
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            if header is None:
                header = cells
            elif not all(re.fullmatch(r":?-+:?", c) for c in cells):
                rows.append(dict(zip(header, cells, strict=False)))
        elif header is not None:
            found.append(rows)
            header, rows = None, []
    return found


def headers(markdown: str) -> list[str]:
    return [h for table in tables(markdown) for row in table[:1] for h in row]


def table_rows(markdown: str) -> list[dict[str, str]]:
    return [row for table in tables(markdown) for row in table]


def savings(cell: str) -> float:
    match = re.fullmatch(r"(-?\d+(?:,\d+)?)\s*%", cell)
    assert match, f"not a percentage: {cell!r}"
    return float(match.group(1).replace(",", "."))


def digits(cell: str) -> int:
    return int(re.sub(r"\D", "", cell))


def section(markdown: str, title: str) -> str:
    match = re.search(rf"^##\s+{title}\s*$(.*?)(?=^##\s|\Z)", markdown, re.MULTILINE | re.DOTALL)
    assert match, f"section {title!r} is missing"
    return match.group(1)


def test_req013_e1_generate_sql_is_deterministic_with_at_least_30m_rows():
    """REQ-013 E1: benchmarks/generate.sql rendered twice with the same seed gives the same text, target >= 30 M."""
    generate = load("generate")
    first = generate.render(generate.SEED, generate.ROWS)
    second = generate.render(generate.SEED, generate.ROWS)
    assert first == second
    assert (BENCHMARKS / "generate.sql").read_text(encoding="utf-8") == first
    target = re.search(r"^--\s*target rows:\s*(\d+)\s*$", first, re.MULTILINE)
    assert target, "generate.sql does not state its target row count"
    assert int(target.group(1)) == generate.ROWS
    assert generate.ROWS >= 30_000_000


def test_req013_e2_table_with_billed_bytes_slot_ms_and_savings_base_at_zero():
    """REQ-013 E2: JOBS rows of 3 variants give a Markdown table with billed bytes, slot ms and % saved, base at 0 %."""
    report = load("report")
    markdown = report.render(jobs_three_variants(), fecha=FECHA, run_id=RUN_ID)
    columns = headers(markdown)
    for column in ("bytes facturados", "slot ms", "% ahorro"):
        assert column in columns
    rows = {row.get("variante"): row for row in table_rows(markdown) if row.get("variante")}
    assert set(rows) >= {BASE, PARTICIONADA, CLUSTER}
    assert rows[BASE]["% ahorro"] == "0 %"
    assert savings(rows[PARTICIONADA]["% ahorro"]) == 75
    assert savings(rows[CLUSTER]["% ahorro"]) == 87.5
    assert digits(rows[BASE]["bytes facturados"]) == 1_000_000_000
    assert digits(rows[CLUSTER]["bytes facturados"]) == 125_000_000
    assert digits(rows[CLUSTER]["slot ms"]) == 7_000


def test_req013_e3_cache_hit_job_is_left_out_and_listed_under_excluidos():
    """REQ-013 E3: a fixture row with cache_hit = TRUE stays out of the table and appears under «Excluidos»."""
    report = load("report")
    cached = job("bench_cache_hit", "q1_mart_organismo_mes", CLUSTER, 0, 0, 0, cache_hit=True)
    markdown = report.render([*jobs_three_variants(), cached], fecha=FECHA, run_id=RUN_ID)
    for line in markdown.splitlines():
        if line.strip().startswith("|"):
            assert "bench_cache_hit" not in line
    rows = [row for row in table_rows(markdown) if row.get("variante") == CLUSTER]
    assert len(rows) == 1
    assert digits(rows[0]["bytes facturados"]) == 125_000_000
    assert savings(rows[0]["% ahorro"]) == 87.5
    assert "bench_cache_hit" in section(markdown, "Excluidos")


def test_req013_e4_dry_run_column_is_labelled_as_upper_bound():
    """REQ-013 E4: with --dry-run the bytes column is titled «bytes estimados (cota superior)»."""
    report = load("report")
    estimates = [
        job("bench_q1_base", "q1_mart_organismo_mes", BASE, None, 1_000_000_000, None),
        job("bench_q1_part", "q1_mart_organismo_mes", PARTICIONADA, None, 250_000_000, None),
        job("bench_q1_cluster", "q1_mart_organismo_mes", CLUSTER, None, 125_000_000, None),
    ]
    markdown = report.render(estimates, fecha=FECHA, run_id=RUN_ID, dry_run=True)
    columns = headers(markdown)
    assert "bytes estimados (cota superior)" in columns
    assert "bytes facturados" not in columns
    rows = {row.get("variante"): row for row in table_rows(markdown) if row.get("variante")}
    assert digits(rows[BASE]["bytes estimados (cota superior)"]) == 1_000_000_000
    assert rows[BASE]["% ahorro"] == "0 %"
