"""Bronze writer: raw JSONL by source, entity, date and run in GCS (DEC-006)."""

import json
import secrets as _secrets
from collections.abc import Callable, Iterable
from datetime import UTC, date, datetime

from .http import Fetched


class GcsStore:
    def __init__(self, bucket: str, client=None):
        if client is None:
            from google.cloud import storage

            client = storage.Client()
        self.bucket_name = bucket
        self.bucket = client.bucket(bucket)

    def write(self, path: str, data: bytes, *, content_type: str, if_absent: bool = False) -> None:
        self.bucket.blob(path).upload_from_string(
            data, content_type=content_type, if_generation_match=0 if if_absent else None
        )

    def read(self, path: str) -> bytes | None:
        from google.api_core.exceptions import NotFound

        try:
            return self.bucket.blob(path).download_as_bytes()
        except NotFound:
            return None

    def delete(self, path: str) -> None:
        from google.api_core.exceptions import NotFound

        try:
            self.bucket.blob(path).delete()
        except NotFound:
            pass

    def uri(self, path: str) -> str:
        return f"gs://{self.bucket_name}/{path}"


def utc_iso(now: datetime) -> str:
    return now.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def new_run_id(now: datetime) -> str:
    return now.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + _secrets.token_hex(4)


def prefix(entidad: str, fecha: date, run_id: str) -> str:
    return f"mercadopublico/{entidad}/fecha={fecha.isoformat()}/run={run_id}/"


def record(
    fetched: Fetched, *, run_id: str, fecha: date, entidad: str, tipo: str, codigo: str | None, now: datetime
) -> dict:
    return {
        "run_id": run_id,
        "ingested_at": utc_iso(now),
        "source_url": fetched.url,
        "http_status": fetched.status,
        "fecha": fecha.isoformat(),
        "entidad": entidad,
        "tipo": tipo,
        "codigo": codigo,
        "payload": fetched.payload,
        "body": fetched.body,
        "error": fetched.error,
    }


class BronzeWriter:
    def __init__(
        self,
        store: GcsStore,
        run_id: str,
        *,
        secrets: Iterable[str] = (),
        flush_every: int = 500,
        on_flush: Callable[[], None] | None = None,
    ):
        self.store = store
        self.run_id = run_id
        self.secrets = [s for s in secrets if s]
        self.flush_every = flush_every
        self.on_flush = on_flush
        self.paths: list[str] = []
        self._buffers: dict[tuple[str, date], list[str]] = {}
        self._parts: dict[tuple[str, date], int] = {}

    def add(self, entidad: str, fecha: date, rec: dict) -> None:
        key = (entidad, fecha)
        self._buffers.setdefault(key, []).append(json.dumps(rec, ensure_ascii=False, separators=(",", ":")))
        # Flush every buffer, so the cursor saved by on_flush never points past an unwritten line.
        if len(self._buffers[key]) >= self.flush_every:
            self.flush()

    def flush(self) -> None:
        for key, lines in self._buffers.items():
            if not lines:
                continue
            text = "\n".join(lines) + "\n"
            if any(s in text for s in self.secrets):
                raise RuntimeError("secreto en la línea")
            n = self._parts.get(key, 0)
            path = prefix(key[0], key[1], self.run_id) + f"part-{n:04d}.jsonl"
            self.store.write(path, text.encode("utf-8"), content_type="application/x-ndjson", if_absent=True)
            self._parts[key] = n + 1
            self.paths.append(path)
            lines.clear()
        if self.on_flush is not None:
            self.on_flush()
