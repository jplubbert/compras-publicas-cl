"""Bronze to BigQuery raw: one free load job per entity of a run (REQ-006, DEC-006)."""

import logging
from collections.abc import Iterable
from pathlib import Path

from .redact import redact

log = logging.getLogger("compras_ingest.load")

# ingest/schemas, both in the checkout and in the image (editable install under /app/ingest).
SCHEMAS_DIR = Path(__file__).resolve().parents[2] / "schemas"


class LoadError(Exception):
    def __init__(self, message: str, cargas: Iterable[dict] = ()):
        super().__init__(message)
        self.cargas = list(cargas)


def group(objetos: Iterable[str]) -> dict[tuple[str, str], list[str]]:
    """Group `fuente/entidad/fecha=…/run=…/part-NNNN.jsonl` paths by (fuente, entidad); skip non-JSONL (the cursor)."""
    groups: dict[tuple[str, str], list[str]] = {}
    for path in objetos:
        parts = path.split("/")
        if not path.endswith(".jsonl") or len(parts) < 3:
            continue
        groups.setdefault((parts[0], parts[1]), []).append(path)
    return groups


def load_run(
    client, *, project: str, dataset: str, bucket: str, objetos: Iterable[str], run_id: str, secrets: Iterable[str] = ()
) -> list[dict]:
    from google.api_core.exceptions import GoogleAPIError
    from google.cloud import bigquery

    secrets = list(secrets)
    cargas: list[dict] = []
    for (fuente, entidad), paths in sorted(group(objetos).items()):
        table = f"{project}.{dataset}.{fuente}_{entidad}"
        uris = [f"gs://{bucket}/{p}" for p in paths]
        carga = {"tabla": table, "archivos": uris, "job_id": None, "filas": None, "error": None}
        try:
            cfg = bigquery.LoadJobConfig(
                source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
                write_disposition=bigquery.WriteDisposition.WRITE_APPEND,
                create_disposition=bigquery.CreateDisposition.CREATE_NEVER,
                autodetect=False,
                schema=client.schema_from_json(SCHEMAS_DIR / f"{fuente}_{entidad}.json"),
                labels={"fuente": fuente, "run_id": run_id.lower()},
            )
            job = client.load_table_from_uri(uris, table, job_config=cfg, job_id_prefix=f"load_{fuente}_{entidad}_")
            carga["job_id"] = job.job_id
            job.result()
            if job.errors:
                raise LoadError(str(job.errors))
            carga["filas"] = job.output_rows
        except (GoogleAPIError, LoadError, OSError) as exc:
            msg = redact(f"{type(exc).__name__}: {exc}", secrets)
            carga["error"] = msg
            log.error("falló la carga a %s desde %s: %s", table, uris, msg)
        cargas.append(carga)
    fallidas = [c for c in cargas if c["error"] is not None]
    if fallidas:
        detalle = "; ".join(f"{c['tabla']} desde {', '.join(c['archivos'])}" for c in fallidas)
        raise LoadError(f"fallaron {len(fallidas)} carga(s): {detalle}", cargas)
    return cargas
