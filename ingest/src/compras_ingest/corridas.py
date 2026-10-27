"""One row per run in raw.corridas (DEC-012): the record the Workflow and gold.dim_corrida read to know whether a
day ended OK, PARCIAL (request budget exhausted, cursor kept) or ERROR."""

import logging
from datetime import datetime

from .bronze import ingest_date, utc_iso
from .load import SCHEMAS_DIR
from .redact import redact

log = logging.getLogger("compras_ingest.corridas")

TABLE = "corridas"


def estado(exit_code: int, presupuesto_agotado: bool, cargas_fallidas: int) -> str:
    """A day is OK only when the job ended with 0, every load landed and the budget was not exhausted."""
    if exit_code != 0 or cargas_fallidas > 0:
        return "ERROR"
    return "PARCIAL" if presupuesto_agotado else "OK"


def fila(
    *,
    run_id: str,
    fuente: str,
    fechas: list[str],
    exit_code: int,
    requests: int,
    presupuesto_agotado: bool,
    cursor: str | None,
    objetos: int,
    cargas_fallidas: int,
    finished_at: datetime,
) -> dict:
    return {
        "run_id": run_id,
        "_ingest_date": ingest_date(run_id),
        "fuente": fuente,
        "estado": estado(exit_code, presupuesto_agotado, cargas_fallidas),
        "exit_code": exit_code,
        "requests": requests,
        "fechas": list(fechas),
        "presupuesto_agotado": presupuesto_agotado,
        "cursor": cursor,
        "objetos": objetos,
        "cargas_fallidas": cargas_fallidas,
        "finished_at": utc_iso(finished_at),
    }


def registrar(client, *, project: str, dataset: str, row: dict, secrets: list[str]) -> bool:
    """Append the row with a free load job; False (logged, redacted) when it could not be written."""
    from google.api_core.exceptions import GoogleAPIError
    from google.cloud import bigquery

    table = f"{project}.{dataset}.{TABLE}"
    try:
        cfg = bigquery.LoadJobConfig(
            source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
            write_disposition=bigquery.WriteDisposition.WRITE_APPEND,
            create_disposition=bigquery.CreateDisposition.CREATE_NEVER,
            autodetect=False,
            schema=client.schema_from_json(SCHEMAS_DIR / f"{TABLE}.json"),
            labels={"fuente": row["fuente"], "run_id": row["run_id"].lower()},
        )
        job = client.load_table_from_json([row], table, job_config=cfg, job_id_prefix=f"corrida_{row['fuente']}_")
        job.result()
        if job.errors:
            raise GoogleAPIError(str(job.errors))
    except (GoogleAPIError, OSError) as exc:
        log.error("no se pudo registrar la corrida en %s: %s", table, redact(f"{type(exc).__name__}: {exc}", secrets))
        return False
    return True
