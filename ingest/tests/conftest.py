import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import respx
from google.api_core.exceptions import NotFound, PreconditionFailed

from compras_ingest import cli
from compras_ingest.mercadopublico import BASE_URL, ENDPOINT

TICKET = "TK-PRUEBA-9f3a71"
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
    sleeps: list = field(default_factory=list)

    def run(self, argv=("mercadopublico",), env_extra=None) -> Outcome:
        env = {"BRONZE_BUCKET": BUCKET, "GOOGLE_CLOUD_PROJECT": "proyecto-prueba", **(env_extra or {})}
        code = cli.main(
            list(argv),
            env=env,
            http=httpx.Client(),
            ticket_reader=lambda name: TICKET,
            sleep=self.sleeps.append,
            now=lambda: NOW,
            storage_client=self.storage,
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


def detalle_ok(codigo):
    return httpx.Response(200, json={"Cantidad": 1, "Listado": [{"Codigo": codigo}]})


@pytest.fixture
def mp(capsys):
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as router:
        yield Env(router=router, storage=FakeStorageClient(), capsys=capsys)
