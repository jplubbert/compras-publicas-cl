"""Markdown report of the benchmark from INFORMATION_SCHEMA.JOBS rows (REQ-013, DEC-007).

render() builds the report only from the rows it receives: one table per variant query, one per rewrite pair, and the
excluded jobs (cache hits and errors) as a list. google.cloud.bigquery is imported only where the cloud is read, so the
CLI with --fixture runs without a client.
"""

import argparse
import datetime as dt
import json
import sys
import time
from pathlib import Path

BASE = "licitaciones_sin_particion"
VARIANTS = (BASE, "licitaciones_particionada", "licitaciones_particionada_cluster")
REWRITE_SUFFIXES = ("_antes", "_despues")
GIB = 1024**3
POLL_S = 15
DEFAULT_OUT_DIR = Path(__file__).resolve().parent / "results"

JOBS_SQL = """SELECT
  job_id,
  cache_hit,
  error_result.reason AS error_result,
  total_bytes_billed,
  total_bytes_processed,
  total_slot_ms,
  (SELECT value FROM UNNEST(labels) WHERE key = 'bench_query') AS bench_query,
  (SELECT value FROM UNNEST(labels) WHERE key = 'bench_variant') AS bench_variant
FROM `region-{location}`.INFORMATION_SCHEMA.JOBS
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)
  AND job_type = 'QUERY'
  AND statement_type = 'SELECT'
  AND state = 'DONE'
  AND EXISTS (SELECT 1 FROM UNNEST(labels) l WHERE l.key = 'bench_run' AND l.value = @run_id)
ORDER BY bench_query, bench_variant, job_id
"""


def fetch_jobs(client, run_id: str, expected: int | None = None, timeout_s: int = 300) -> tuple[list[dict], int]:
    """The benchmark jobs of run_id and how many of the expected ones are still missing from JOBS."""
    from google.cloud import bigquery

    config = bigquery.QueryJobConfig(
        use_query_cache=False,
        maximum_bytes_billed=GIB,
        labels={"bench_meta": run_id},
        query_parameters=[bigquery.ScalarQueryParameter("run_id", "STRING", run_id)],
    )
    sql = JOBS_SQL.format(location=(client.location or "us-central1").lower())
    deadline = time.monotonic() + timeout_s
    while True:
        rows = [dict(row.items()) for row in client.query(sql, job_config=config).result()]
        if expected is None:
            return rows, 0
        if len(rows) >= expected or time.monotonic() >= deadline:
            return rows, max(0, expected - len(rows))
        time.sleep(POLL_S)


def _is_rewrite(query: str) -> bool:
    return query.endswith(REWRITE_SUFFIXES)


def _pair(query: str) -> tuple[str, str]:
    for suffix in REWRITE_SUFFIXES:
        if query.endswith(suffix):
            return query[: -len(suffix)], suffix[1:]
    raise ValueError(query)


def _number(value) -> str:
    return "—" if value is None else str(int(value))


def _savings(base, value) -> str:
    if base is None or base == 0 or value is None:
        return "—"
    pct = round((base - value) / base * 100, 1)
    text = str(int(pct)) if pct == int(pct) else f"{pct}".replace(".", ",")
    return f"{text} %"


def _byte_columns(dry_run: bool) -> list[tuple[str, str]]:
    if dry_run:
        return [("bytes estimados (cota superior)", "total_bytes_processed")]
    return [
        ("bytes facturados", "total_bytes_billed"),
        ("bytes procesados", "total_bytes_processed"),
        ("slot ms", "total_slot_ms"),
    ]


def _table(first: str, rows: list[tuple[str, dict]], base: dict | None, dry_run: bool) -> list[str]:
    columns = _byte_columns(dry_run)
    measure = columns[0][1]
    header = [first[0], first[1], *(title for title, _ in columns), "% ahorro"]
    lines = ["| " + " | ".join(header) + " |", "|" + "|".join(" --- " for _ in header) + "|"]
    base_value = None if base is None else base.get(measure)
    for label, row in rows:
        cells = [first[2], label, *(_number(row.get(key)) for _, key in columns)]
        cells.append(_savings(base_value, row.get(measure)))
        lines.append("| " + " | ".join(cells) + " |")
    return lines


def _variant_order(variant: str) -> tuple[int, str]:
    return (VARIANTS.index(variant), "") if variant in VARIANTS else (len(VARIANTS), variant or "")


def render(rows: list[dict], fecha: str, run_id: str, dry_run: bool = False, notes=()) -> str:
    excluded = [row for row in rows if row.get("cache_hit") or row.get("error_result") is not None]
    measured = [row for row in rows if not (row.get("cache_hit") or row.get("error_result") is not None)]

    lines = [
        f"# Benchmark {fecha}",
        "",
        f"Corrida `{run_id}`. Datos sintéticos generados por `benchmarks/generate.sql` (DEC-007, S-12).",
        "Caché de consultas desactivada (`use_query_cache = false`) en cada job medido.",
    ]
    if dry_run:
        lines.append(
            "Dry run: los bytes son estimados (cota superior); el dry run informa los bytes antes de la poda por"
            " clustering."
        )
    lines.extend(str(note) for note in notes)

    lines += ["", "## Variantes", ""]
    variant_rows = [row for row in measured if not _is_rewrite(row.get("bench_query") or "")]
    if not variant_rows:
        lines += ["Ninguno", ""]
    for query in sorted({row.get("bench_query") or "" for row in variant_rows}):
        group = sorted(
            (row for row in variant_rows if (row.get("bench_query") or "") == query),
            key=lambda row: _variant_order(row.get("bench_variant")),
        )
        base = next((row for row in group if row.get("bench_variant") == BASE), None)
        labelled = [(row.get("bench_variant") or "—", row) for row in group]
        lines += [f"### {query}", "", *_table(("query", "variante", query), labelled, base, dry_run), ""]

    lines += ["## Reescrituras", ""]
    rewrite_rows = [row for row in measured if _is_rewrite(row.get("bench_query") or "")]
    if not rewrite_rows:
        lines += ["Ninguno", ""]
    for pair in sorted({_pair(row["bench_query"])[0] for row in rewrite_rows}):
        group = sorted(
            (row for row in rewrite_rows if _pair(row["bench_query"])[0] == pair),
            key=lambda row: REWRITE_SUFFIXES.index("_" + _pair(row["bench_query"])[1]),
        )
        base = next((row for row in group if _pair(row["bench_query"])[1] == "antes"), None)
        labelled = [(_pair(row["bench_query"])[1], row) for row in group]
        lines += [f"### {pair}", "", *_table(("par", "versión", pair), labelled, base, dry_run), ""]

    lines += ["## Excluidos", ""]
    if not excluded:
        lines.append("Ninguno")
    for row in excluded:
        reason = "cache_hit = TRUE" if row.get("cache_hit") else f"error: {row.get('error_result')}"
        lines.append(f"- `{row.get('job_id')}`: {row.get('bench_query')} / {row.get('bench_variant')} ({reason})")
    return "\n".join(lines) + "\n"


def write_report(markdown: str, out_dir, fecha: str, dry_run: bool) -> Path:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    path = out / (f"{fecha}-estimado.md" if dry_run else f"{fecha}.md")
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(markdown)
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write the benchmark report from INFORMATION_SCHEMA.JOBS.")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--fecha", default=dt.datetime.now(dt.UTC).date().isoformat())
    parser.add_argument("--fixture", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--project")
    parser.add_argument("--location", default="us-central1")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    args = parser.parse_args(argv)

    if args.fixture is not None:
        rows = json.loads(args.fixture.read_text(encoding="utf-8"))
    elif args.dry_run:
        print("report: the estimates are written by run.py --dry-run", file=sys.stderr)
        return 2
    elif not args.project:
        print("report: --project is required without --fixture", file=sys.stderr)
        return 2
    else:
        from google.cloud import bigquery

        rows, _ = fetch_jobs(bigquery.Client(project=args.project, location=args.location), args.run_id)
    markdown = render(rows, args.fecha, args.run_id, dry_run=args.dry_run)
    print(write_report(markdown, args.out_dir, args.fecha, args.dry_run))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
