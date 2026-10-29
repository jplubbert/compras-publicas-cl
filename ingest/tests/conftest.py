import json
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from fnmatch import fnmatch
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import respx
from google.api_core.exceptions import NotFound, PreconditionFailed
from google.cloud import bigquery

from compras_ingest import bcentral, cli, mindicador
from compras_ingest.mercadopublico import BASE_URL, ENDPOINT

TICKET = "TK-PRUEBA-9f3a71"
TOKEN = "BDE-TOKEN-PRUEBA-7c21e4"
BUCKET = "bucket-prueba"
NOW = datetime(2026, 10, 22, 3, 0, 0, tzinfo=UTC)  # yesterday in Santiago: 2026-10-21
CURSOR_PATH = "mercadopublico/_cursor.json"


class FakeBlob:
    def __init__(self, objects: dict, path: str):
        self.objects = objects
        self.path = path

    def upload_from_string(self, data, content_type=None, if_generation_match=None):
        if if_generation_match == 0 and self.path in self.objects:
            raise PreconditionFailed(f"{self.path} exists")
        self.objects[self.path] = data if isinstance(data, bytes) else data.encode("utf-8")

    def download_as_bytes(self):
        if self.path not in self.objects:
            raise NotFound(self.path)
        return self.objects[self.path]

    def delete(self):
        if self.path not in self.objects:
            raise NotFound(self.path)
        del self.objects[self.path]


class FakeBucket:
    def __init__(self, objects: dict):
        self.objects = objects

    def blob(self, path):
        return FakeBlob(self.objects, path)


class FakeStorageClient:
    def __init__(self):
        self.objects: dict[str, bytes] = {}

    def bucket(self, name):
        assert name == BUCKET
        return FakeBucket(self.objects)

    def list_blobs(self, bucket, match_glob=None):
        assert bucket == BUCKET
        return [SimpleNamespace(name=p) for p in sorted(self.objects) if match_glob is None or fnmatch(p, match_glob)]


class FakeLoadJob:
    def __init__(self, job_id: str, rows: int, error: Exception | None):
        self.job_id = job_id
        self.output_rows = rows
        self.errors = None
        self._error = error

    def result(self):
        if self._error is not None:
            raise self._error
        return self


class FakeQueryJob:
    def __init__(self, rows: list[dict]):
        self.rows = rows

    def result(self):
        return self.rows


@dataclass
class LoadCall:
    uris: list[str]
    destination: str
    job_config: object
    job_id_prefix: str


class FakeBigQueryClient:
    """Records every load_table_from_uri; `fail` maps a destination table to the error its job raises."""

    def __init__(self, storage: FakeStorageClient | None = None):
        self.storage = storage
        self.loads: list[LoadCall] = []
        self.json_loads: list[LoadCall] = []
        self.fail: dict[str, Exception] = {}
        # T-22: codes of raw.mercadopublico_ordenes_compra with a 200 detail, and the error the query raises if set.
        self.conocidas: set[str] = set()
        self.query_error: Exception | None = None
        self.queries: list[str] = []

    def query(self, sql):
        self.queries.append(sql)
        if self.query_error is not None:
            raise self.query_error
        return FakeQueryJob([{"codigo": c} for c in sorted(self.conocidas)])

    def schema_from_json(self, path):
        with open(path, encoding="utf-8") as fh:
            return [bigquery.SchemaField.from_api_repr(f) for f in json.load(fh)]

    def load_table_from_json(self, rows, destination, job_config=None, job_id_prefix=None):
        """Records the run rows of raw.corridas (DEC-012)."""
        self.json_loads.append(LoadCall([dict(r) for r in rows], destination, job_config, job_id_prefix))
        return FakeLoadJob(f"{job_id_prefix}{len(self.json_loads)}", len(rows), self.fail.get(destination))

    def load_table_from_uri(self, uris, destination, job_config=None, job_id_prefix=None):
        self.loads.append(LoadCall(list(uris), destination, job_config, job_id_prefix))
        rows = 0
        if self.storage is not None:
            for uri in uris:
                path = uri.removeprefix(f"gs://{BUCKET}/")
                rows += len(self.storage.objects.get(path, b"").decode().splitlines())
        return FakeLoadJob(f"{job_id_prefix}{len(self.loads)}", rows, self.fail.get(destination))


@dataclass
class Outcome:
    code: int
    out: str
    err: str
    result: dict | None


@dataclass
class Env:
    router: respx.MockRouter
    storage: FakeStorageClient
    capsys: pytest.CaptureFixture
    bq: FakeBigQueryClient
    sleeps: list = field(default_factory=list)

    def run(self, argv=("mercadopublico",), env_extra=None) -> Outcome:
        # The pacing is off and the retry delay is 1 s by default (S-28) so the backoff assertions on `sleeps` stay
        # exact; test_cli covers the production defaults.
        env = {
            "BRONZE_BUCKET": BUCKET,
            "GOOGLE_CLOUD_PROJECT": "proyecto-prueba",
            "MP_REQUEST_INTERVAL": "0",
            "MP_RETRY_DELAY": "1",
            **(env_extra or {}),
        }
        env = {k: v for k, v in env.items() if v is not None}  # a None in env_extra drops the default
        code = cli.main(
            list(argv),
            env=env,
            http=httpx.Client(),
            ticket_reader=lambda name: TOKEN if "bcentral-token" in name else TICKET,
            sleep=self.sleeps.append,
            now=lambda: NOW,
            storage_client=self.storage,
            bq_client=self.bq,
        )
        out, err = self.capsys.readouterr()
        lines = [line for line in out.splitlines() if line.strip()]
        return Outcome(code, out, err, json.loads(lines[-1]) if lines else None)

    # --- simulated API -------------------------------------------------------------------------------------------
    def listado(self, entidad, fecha, codes=(), status=200):
        key = "CodigoExterno" if entidad == "licitaciones" else "Codigo"
        body = {"Cantidad": len(codes), "Listado": [{key: c, "Nombre": f"n-{c}"} for c in codes]}
        return self.router.get(BASE_URL + ENDPOINT[entidad], params__contains={"fecha": fecha}).mock(
            return_value=httpx.Response(status, json=body if status == 200 else {"Mensaje": "error"})
        )

    def detalle(self, entidad, codigo, side_effect=None):
        route = self.router.get(BASE_URL + ENDPOINT[entidad], params__contains={"codigo": codigo})
        if side_effect is not None:
            return route.mock(side_effect=side_effect)
        return route.mock(return_value=detalle_ok(codigo))

    def serie(self, codigo, obs, codigo_bde=0, status=200, descripcion="Success", side_effect=None):
        route = self.router.get(bcentral.BASE_URL, params__contains={"timeseries": codigo})
        if side_effect is not None:
            return route.mock(side_effect=side_effect)
        body = {
            "Codigo": codigo_bde,
            "Descripcion": descripcion,
            "Series": {"seriesId": codigo, "Obs": obs},
            "SeriesInfos": [],
        }
        return route.mock(return_value=httpx.Response(status, json=body))

    def mindicador(self, nombre, fecha_ddmmaaaa, serie=None, side_effect=None):
        route = self.router.get(mindicador.BASE_URL + f"{nombre}/{fecha_ddmmaaaa}")
        if side_effect is not None:
            return route.mock(side_effect=side_effect)
        if serie is None:
            serie = [{"fecha": "2026-10-21T03:00:00.000Z", "valor": 41194.55}]
        body = {"version": "1.7.0", "autor": "mindicador.cl", "codigo": nombre, "serie": serie}
        return route.mock(return_value=httpx.Response(200, json=body))

    def calls(self) -> list[tuple[str, str, str]]:
        """(entity, 'fecha' | 'codigo', value) of every request, in order."""
        seen = []
        for call in self.router.calls:
            url = urlsplit(str(call.request.url))
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            entidad = "licitaciones" if url.path.endswith("licitaciones.json") else "ordenes_compra"
            kind = "fecha" if "fecha" in q else "codigo"
            seen.append((entidad, kind, q[kind]))
        return seen

    def lines(self, prefix: str) -> list[dict]:
        out = []
        for path in sorted(self.storage.objects):
            if path.startswith(prefix) and path.endswith(".jsonl"):
                out += [json.loads(line) for line in self.storage.objects[path].decode().splitlines()]
        return out

    def cursor(self) -> dict | None:
        data = self.storage.objects.get(CURSOR_PATH)
        return None if data is None else json.loads(data)


def obs(desde: date, n: int) -> list[dict]:
    """`n` daily BDE observations from `desde`, in the GetSeries shape (T-02)."""
    return [
        {
            "indexDateString": (desde + timedelta(days=i)).strftime("%d-%m-%Y"),
            "value": f"{41000 + i}.55",
            "statusCode": "OK",
        }
        for i in range(n)
    ]


def detalle_ok(codigo):
    return httpx.Response(200, json={"Cantidad": 1, "Listado": [{"Codigo": codigo}]})


@pytest.fixture
def mp(capsys):
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as router:
        storage = FakeStorageClient()
        yield Env(router=router, storage=storage, capsys=capsys, bq=FakeBigQueryClient(storage))


def pytest_terminal_summary(terminalreporter):
    """Jest-style count line ("Tests: F failed, P passed, T total") that scripts/record_evidence.py can parse."""
    stats = terminalreporter.stats
    passed = len(stats.get("passed", []))
    failed = len(stats.get("failed", [])) + len(stats.get("error", []))
    total = passed + failed + len(stats.get("skipped", []))
    terminalreporter.write_line(f"Tests: {failed} failed, {passed} passed, {total} total")
