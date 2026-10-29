"""Purchase orders whose detail is already in raw (T-22, S-29): the run skips their detail and silver takes their
state from the daily listing, which is in bronze anyway."""

import logging

from .redact import redact

log = logging.getLogger("compras_ingest.conocidas")

TABLE = "mercadopublico_ordenes_compra"


def oc_conocidas(client, *, project: str, dataset: str, secrets: list[str]) -> set[str]:
    """Codes with a 200 detail in raw. A failed query gives an empty set: the run then asks every detail, as before
    T-22, which costs budget but loses nothing."""
    from google.api_core.exceptions import GoogleAPIError

    sql = (
        f"SELECT DISTINCT codigo FROM `{project}.{dataset}.{TABLE}` "
        "WHERE tipo = 'detalle' AND http_status = 200 AND codigo IS NOT NULL"
    )
    try:
        return {row["codigo"] for row in client.query(sql).result()}
    except (GoogleAPIError, OSError) as exc:
        log.warning("no se pudieron leer las OC conocidas; se piden todos los detalles: %s", redact(str(exc), secrets))
        return set()
