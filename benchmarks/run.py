"""Before/after benchmark on synthetic data in the bench dataset (REQ-013, DEC-007).

Creates the three variants from generate.sql, dry-runs the 13 measured jobs and aborts before running any of them if
their estimate does not fit in what is left of the budget and of the daily per-user quota (DEC-003, DEC-009, S-07).
Then runs them without cache, labelled with bench_run, each one with its own maximum_bytes_billed, and writes the
report from INFORMATION_SCHEMA.JOBS. With --dry-run it only writes the estimates of the existing variants.
"""

import argparse
import datetime as dt
import math
import re
import sys
from pathlib import Path

import report

HERE = Path(__file__).resolve().parent
GIB = 1024**3
MIB = 1024**2
MAX_JOB_BYTES = 20 * GIB
MIN_JOB_BYTES = 100 * MIB
CAP_FACTOR = 1.2
REWRITE_VARIANT = "licitaciones_particionada_cluster"

USED_TODAY_SQL = """SELECT COALESCE(SUM(total_bytes_billed), 0) AS used
FROM `region-{location}`.INFORMATION_SCHEMA.JOBS_BY_USER
WHERE creation_time >= TIMESTAMP(CURRENT_DATE('America/Los_Angeles'), 'America/Los_Angeles')
  AND job_type = 'QUERY'
"""


def run_id(now: dt.datetime) -> str:
    return now.astimezone(dt.UTC).strftime("%Y%m%dt%H%M%S")


def load_queries(directory) -> list[tuple[str, str, str]]:
    """(name, kind, sql) of every query file, kind taken from its first line («-- kind: variant|rewrite»)."""
    queries = []
    for path in sorted(Path(directory).glob("*.sql")):
        sql = path.read_text(encoding="utf-8")
        match = re.fullmatch(r"--\s*kind:\s*(variant|rewrite)\s*", sql.splitlines()[0] if sql else "")
        if not match:
            raise ValueError(f"{path.name}: the first line must be «-- kind: variant» or «-- kind: rewrite»")
        queries.append((path.stem, match.group(1), sql))
    return queries


def plan_jobs(queries, dataset: str) -> list[tuple[str, str, str]]:
    """(query, variant, sql): every variant query over the 3 variants, then the rewrites over the clustered one."""
    jobs = []
    for name, kind, sql in queries:
        if kind == "variant":
            jobs += [(name, variant, sql.replace("{tabla}", f"`{dataset}.{variant}`")) for variant in report.VARIANTS]
    for name, kind, sql in queries:
        if kind == "rewrite":
            jobs.append((name, REWRITE_VARIANT, sql.replace("{tabla}", f"`{dataset}.{REWRITE_VARIANT}`")))
    return jobs


def _label(value: str) -> str:
    return re.sub(r"[^a-z0-9_-]", "_", value.lower())[:63]


def job_config(run_id: str, query: str, variante: str, max_bytes: int, dry_run: bool):
    from google.cloud import bigquery

    if dry_run:
        labels = {"bench_estimate": _label(run_id)}
    else:
        labels = {"bench_run": _label(run_id), "bench_query": _label(query), "bench_variant": _label(variante)}
    return bigquery.QueryJobConfig(
        use_query_cache=False, dry_run=dry_run, maximum_bytes_billed=max_bytes, labels=labels
    )


def meta_config(run_id: str):
    from google.cloud import bigquery

    return bigquery.QueryJobConfig(
        use_query_cache=False, maximum_bytes_billed=GIB, labels={"bench_meta": _label(run_id)}
    )


def cap_bytes(estimado) -> int:
    return min(MAX_JOB_BYTES, max(MIN_JOB_BYTES, math.ceil((estimado or 0) * CAP_FACTOR)))


def available_bytes(budget_gib: float, quota_gib: float, used_today: int) -> int:
    return max(0, int(min(budget_gib * GIB, quota_gib * GIB - used_today)))


def variant_statements(dataset: str, generate_sql: str) -> list[tuple[str, str]]:
    """(variant, statement) of variants.sql with {dataset} and {generate} replaced."""
    statements, name, body = [], None, []
    for line in (HERE / "variants.sql").read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"--\s*variant:\s*(\S+)\s*", line)
        if match:
            if name:
                statements.append((name, "\n".join(body)))
            name, body = match.group(1), []
        elif name:
            body.append(line)
    if name:
        statements.append((name, "\n".join(body)))
    return [(n, s.replace("{dataset}", dataset).replace("{generate}", generate_sql)) for n, s in statements]


def make_client(project: str, location: str):
    from google.cloud import bigquery

    return bigquery.Client(project=project, location=location)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the before/after BigQuery benchmark (DEC-007).")
    parser.add_argument("--project", required=True)
    parser.add_argument("--location", default="us-central1")
    parser.add_argument("--dataset", default="bench")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--budget-gib", type=float, default=18)
    parser.add_argument("--quota-gib", type=float, default=20)
    parser.add_argument("--results-dir", type=Path, default=HERE / "results")
    args = parser.parse_args(argv)

    from google.api_core.exceptions import GoogleAPIError, NotFound

    started = dt.datetime.now(dt.UTC)
    rid = run_id(started)
    fecha = started.date().isoformat()
    client = make_client(args.project, args.location)
    location = args.location.lower()

    used_rows = list(client.query(USED_TODAY_SQL.format(location=location), job_config=meta_config(rid)).result())
    used = int(used_rows[0][0]) if used_rows else 0
    print(f"run: billed today by this user: {used} bytes", file=sys.stderr)

    dataset = f"{args.project}.{args.dataset}"
    if args.dry_run:
        for variant in report.VARIANTS:
            try:
                client.get_table(f"{dataset}.{variant}")
            except NotFound:
                print(f"run: {dataset}.{variant} is missing; corre primero run.py sin --dry-run", file=sys.stderr)
                return 1
    else:
        generate_sql = (HERE / "generate.sql").read_text(encoding="utf-8")
        for variant, statement in variant_statements(dataset, generate_sql):
            job = client.query(statement, job_config=meta_config(rid))
            try:
                job.result()
            except GoogleAPIError as exc:
                print(f"run: creating {variant} failed in job {job.job_id}: {exc}", file=sys.stderr)
                return 1

    jobs = plan_jobs(load_queries(HERE / "queries"), dataset)
    estimates = []
    for query, variant, sql in jobs:
        job = client.query(sql, job_config=job_config(rid, query, variant, MAX_JOB_BYTES, dry_run=True))
        estimates.append(
            {
                "job_id": job.job_id,
                "cache_hit": False,
                "error_result": None,
                "total_bytes_billed": None,
                "total_bytes_processed": job.total_bytes_processed,
                "total_slot_ms": None,
                "bench_query": query,
                "bench_variant": variant,
            }
        )
    total = sum(row["total_bytes_processed"] or 0 for row in estimates)
    available = available_bytes(args.budget_gib, args.quota_gib, used)
    # Dry runs bill nothing: the guard only protects the measured jobs.
    if not args.dry_run and total > available:
        print(
            f"run: the dry runs estimate {total} bytes, {used} bytes were billed today and only {available} bytes"
            " are available; nothing was measured",
            file=sys.stderr,
        )
        return 1

    if args.dry_run:
        markdown = report.render(estimates, fecha, rid, dry_run=True)
        path = report.write_report(markdown, args.results_dir, fecha, True)
        print(path)
        print(rid)
        return 0

    code = 0
    for (query, variant, sql), estimate in zip(jobs, estimates, strict=True):
        config = job_config(rid, query, variant, cap_bytes(estimate["total_bytes_processed"]), dry_run=False)
        job = client.query(sql, job_config=config)
        try:
            job.result()
        except GoogleAPIError as exc:
            print(f"run: {query} on {variant} failed in job {job.job_id}: {exc}", file=sys.stderr)
            code = 1

    rows, missing = report.fetch_jobs(client, rid, len(jobs))
    notes = [f"faltan {missing} jobs en INFORMATION_SCHEMA.JOBS"] if missing else []
    if missing:
        code = 1
    path = report.write_report(report.render(rows, fecha, rid, notes=notes), args.results_dir, fecha, False)
    print(path)
    print(rid)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
