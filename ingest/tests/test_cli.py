"""REQ-004: command line arguments, configuration, default date, secret access and failing listings."""

from types import SimpleNamespace

import httpx
import pytest
from conftest import TICKET, detalle_ok

from compras_ingest.secrets import ConfigError, bcentral_token_secret_name, read_secret, ticket_secret_name


@pytest.mark.parametrize(
    "argv",
    [
        ["mercadopublico", "--from", "2026-10-01"],
        ["mercadopublico", "--to", "2026-10-01"],
        ["mercadopublico", "--from", "2026-10-03", "--to", "2026-10-01"],
        ["mercadopublico", "--date", "2026-10-01", "--from", "2026-10-01", "--to", "2026-10-02"],
        ["mercadopublico", "--date", "2026-13-01"],
        [],
    ],
)
def test_bad_arguments_exit_2(mp, argv):
    assert mp.run(argv).code == 2
    assert mp.router.calls.call_count == 0


@pytest.mark.parametrize("budget", ["0", "-3", "muchos"])
def test_invalid_budget_exits_2(mp, budget):
    outcome = mp.run(env_extra={"MP_DAILY_REQUEST_BUDGET": budget})
    assert outcome.code == 2
    assert "MP_DAILY_REQUEST_BUDGET" in outcome.err


@pytest.mark.parametrize("name", ["MP_REQUEST_INTERVAL", "MP_RETRY_DELAY"])
@pytest.mark.parametrize("value", ["-1", "nan", "rapido"])
def test_invalid_seconds_exit_2(mp, name, value):
    outcome = mp.run(env_extra={name: value})
    assert outcome.code == 2
    assert name in outcome.err
    assert mp.router.calls.call_count == 0


def test_default_interval_paces_the_requests_2_5_seconds_apart(mp):
    """S-28: without MP_REQUEST_INTERVAL the job waits up to 2.5 s between requests (the fake sleep takes no time, so
    every request after the first waits the full interval); the pause is not a retry and does not use the budget."""
    mp.listado("licitaciones", "21102026", ["L1", "L2"])
    mp.listado("ordenes_compra", "21102026", [])
    mp.detalle("licitaciones", "L1")
    mp.detalle("licitaciones", "L2")
    outcome = mp.run(env_extra={"MP_REQUEST_INTERVAL": None})
    assert outcome.code == 0
    assert mp.router.calls.call_count == 4
    assert all(0 < s <= 2.5 for s in mp.sleeps) and len(mp.sleeps) == 3
    assert outcome.result["requests"] == 4


def test_default_retry_delay_waits_10_then_20_seconds(mp):
    """S-28: without MP_RETRY_DELAY a failed attempt waits 10 s, then 20 s, before the retries."""
    mp.listado("licitaciones", "21102026", ["L1"])
    mp.listado("ordenes_compra", "21102026", [])
    route = mp.detalle("licitaciones", "L1", [httpx.Response(429), httpx.Response(429), detalle_ok("L1")])
    outcome = mp.run(env_extra={"MP_RETRY_DELAY": None})
    assert outcome.code == 0
    assert route.call_count == 3
    assert mp.sleeps == [10.0, 20.0]
    assert outcome.result["requests"] == 5


def test_missing_bucket_exits_2(mp):
    outcome = mp.run(env_extra={"BRONZE_BUCKET": ""})
    assert outcome.code == 2
    assert "BRONZE_BUCKET" in outcome.err


def test_permanent_listing_failure_exits_1_with_cursor(mp):
    route = mp.listado("licitaciones", "21102026", [], status=500)
    outcome = mp.run()
    assert outcome.code == 1
    assert route.call_count == 4
    assert "licitaciones" in outcome.err and "2026-10-21" in outcome.err
    cursor = mp.cursor()
    assert cursor["fecha"] == "2026-10-21"
    assert cursor["codigos"] == {"licitaciones": None, "ordenes_compra": None}
    [line] = mp.lines("mercadopublico/licitaciones/fecha=2026-10-21/")
    assert line["http_status"] == 500 and line["error"]


def test_listing_without_listado_list_exits_1(mp):
    mp.router.get(
        "https://api.mercadopublico.cl/servicios/v1/publico/licitaciones.json", params__contains={"fecha": "21102026"}
    ).mock(return_value=httpx.Response(200, json={"Mensaje": "sin datos"}))
    outcome = mp.run()
    assert outcome.code == 1
    [line] = mp.lines("mercadopublico/licitaciones/fecha=2026-10-21/")
    assert "Listado" in line["error"]


def test_rejected_ticket_on_a_detail_stops_the_run_with_1(mp):
    mp.listado("licitaciones", "21102026", ["L1", "L2"])
    mp.listado("ordenes_compra", "21102026", [])
    mp.detalle("licitaciones", "L1", [httpx.Response(401, json={"Mensaje": "ticket inválido"})])
    l2 = mp.detalle("licitaciones", "L2")
    outcome = mp.run()
    assert outcome.code == 1
    assert l2.call_count == 0
    assert mp.cursor()["ultimo_codigo"] == "L1"
    assert TICKET not in outcome.err


def test_default_date_is_yesterday_in_santiago(mp):
    route = mp.listado("licitaciones", "21102026", [])
    mp.listado("ordenes_compra", "21102026", [])
    outcome = mp.run()
    assert outcome.code == 0
    assert route.call_count == 1
    assert outcome.result["dias"] == ["2026-10-21"]


def test_unexpected_error_is_logged_redacted_and_exits_1(mp):
    mp.router.get(url__startswith="https://api.mercadopublico.cl/").mock(
        side_effect=RuntimeError(f"boom ticket={TICKET}")
    )
    outcome = mp.run()
    assert outcome.code == 1
    assert "RuntimeError" in outcome.err
    assert TICKET not in outcome.err


def test_ticket_secret_name():
    assert ticket_secret_name({"MP_TICKET_SECRET": "projects/p/secrets/s/versions/3"}) == (
        "projects/p/secrets/s/versions/3"
    )
    assert ticket_secret_name({"GOOGLE_CLOUD_PROJECT": "p"}) == (
        "projects/p/secrets/mercadopublico-ticket/versions/latest"
    )
    with pytest.raises(ConfigError, match="GOOGLE_CLOUD_PROJECT"):
        ticket_secret_name({})


def test_bcentral_token_secret_name():
    assert bcentral_token_secret_name({"BCENTRAL_TOKEN_SECRET": "projects/p/secrets/t/versions/2"}) == (
        "projects/p/secrets/t/versions/2"
    )
    assert bcentral_token_secret_name({"GOOGLE_CLOUD_PROJECT": "p"}) == (
        "projects/p/secrets/bcentral-token/versions/latest"
    )
    with pytest.raises(ConfigError, match="GOOGLE_CLOUD_PROJECT"):
        bcentral_token_secret_name({})


class FakeSecretClient:
    def __init__(self, data: bytes):
        self.data = data
        self.requests = []

    def access_secret_version(self, request):
        self.requests.append(request)
        return SimpleNamespace(payload=SimpleNamespace(data=self.data))


def test_read_secret_strips_the_value():
    client = FakeSecretClient(b" valor\n")
    assert read_secret("projects/p/secrets/s/versions/latest", client=client) == "valor"
    assert client.requests == [{"name": "projects/p/secrets/s/versions/latest"}]


def test_empty_secret_is_a_config_error():
    with pytest.raises(ConfigError, match="vacío"):
        read_secret("n", client=FakeSecretClient(b"  \n"))
