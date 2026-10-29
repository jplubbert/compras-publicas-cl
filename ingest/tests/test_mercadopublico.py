"""REQ-004: Mercado Público daily ingestion into bronze (examples E1 to E8)."""

import json
import logging
import re
from urllib.parse import quote

import httpx
import pytest
from conftest import CURSOR_PATH, TICKET, detalle_ok

D = "2026-10-21"
LIC_PREFIX = f"mercadopublico/licitaciones/fecha={D}/run="
RUN_ID = re.compile(r"^\d{8}T\d{6}Z-[0-9a-f]{8}$")


def scenario_e1(mp):
    mp.listado("licitaciones", "21102026", ["L1", "L2", "L3"])
    mp.listado("ordenes_compra", "21102026", [])
    for c in ("L1", "L2", "L3"):
        mp.detalle("licitaciones", c)
    return mp.run()


def scenario_e2(mp):
    mp.listado("licitaciones", "21102026", ["L1", "L2"])
    mp.listado("ordenes_compra", "21102026", [])
    mp.detalle("licitaciones", "L1")
    route = mp.detalle("licitaciones", "L2", [httpx.Response(500), httpx.Response(500), detalle_ok("L2")])
    return mp.run(), route


def scenario_e3(mp):
    mp.listado("licitaciones", "21102026", ["L1", "L2", "L3"])
    mp.listado("ordenes_compra", "21102026", ["O1"])
    mp.detalle("licitaciones", "L1")
    mp.detalle("licitaciones", "L2", [httpx.Response(404, json={"Mensaje": "no existe"})])
    mp.detalle("licitaciones", "L3")
    mp.detalle("ordenes_compra", "O1")
    return mp.run()


CODES = [f"L{i}" for i in range(1, 11)]


def scenario_e4(mp):
    mp.listado("licitaciones", "21102026", CODES)
    mp.listado("ordenes_compra", "21102026", [])
    for c in CODES:
        mp.detalle("licitaciones", c)
    return mp.run(env_extra={"MP_DAILY_REQUEST_BUDGET": "5"})


def scenario_e7(mp):
    mp.listado("licitaciones", "21102026", ["L1"])
    mp.listado("ordenes_compra", "21102026", ["O1"])
    mp.detalle("licitaciones", "L1", [httpx.Response(429, headers={"Retry-After": "2"}), detalle_ok("L1")])
    mp.detalle("ordenes_compra", "O1")
    return mp.run()


def scenario_timeout(mp):
    mp.listado("licitaciones", "21102026", ["L1"])
    mp.listado("ordenes_compra", "21102026", [])
    mp.detalle("licitaciones", "L1", httpx.ConnectTimeout)
    return mp.run()


def scenario_401(mp):
    mp.listado("licitaciones", "21102026", ["L1"], status=401)
    return mp.run()


def test_e1_writes_one_jsonl_line_per_response_with_metadata(mp):
    outcome = scenario_e1(mp)
    assert outcome.code == 0
    run_id = outcome.result["run_id"]
    assert RUN_ID.match(run_id)
    lines = mp.lines(f"{LIC_PREFIX}{run_id}/")
    assert len(lines) == 4
    for line in lines:
        assert {"run_id", "ingested_at", "source_url", "http_status", "fecha"} <= line.keys()
        assert line["run_id"] == run_id
        assert line["fecha"] == D
        assert line["http_status"] == 200
        assert "ticket=***" in line["source_url"]
        assert line["ingested_at"].endswith("Z")
    assert [line["tipo"] for line in lines] == ["listado", "detalle", "detalle", "detalle"]
    calls = mp.calls()
    assert calls[0] == ("licitaciones", "fecha", "21102026")
    assert calls[1] == ("ordenes_compra", "fecha", "21102026")
    assert [c[2] for c in calls[2:]] == ["L1", "L2", "L3"]
    assert mp.cursor() is None


def test_e1_details_of_tenders_come_before_purchase_orders(mp):
    mp.listado("licitaciones", "21102026", ["L1", "L2"])
    mp.listado("ordenes_compra", "21102026", ["O1", "O2"])
    for c in ("L1", "L2"):
        mp.detalle("licitaciones", c)
    for c in ("O1", "O2"):
        mp.detalle("ordenes_compra", c)
    outcome = mp.run()
    assert outcome.code == 0
    assert [c[2] for c in mp.calls()[2:]] == ["L1", "L2", "O1", "O2"]
    oc = mp.lines(f"mercadopublico/ordenes_compra/fecha={D}/run={outcome.result['run_id']}/")
    assert [line["codigo"] for line in oc] == [None, "O1", "O2"]


def test_e2_retries_a_5xx_detail_until_it_succeeds(mp):
    outcome, route = scenario_e2(mp)
    assert outcome.code == 0
    assert route.call_count == 3
    line = next(x for x in mp.lines(LIC_PREFIX) if x["codigo"] == "L2")
    assert line["http_status"] == 200
    assert line["error"] is None
    assert mp.sleeps == [1.0, 2.0]


def test_e3_a_404_detail_is_an_error_line_and_the_job_continues(mp):
    outcome = scenario_e3(mp)
    assert outcome.code == 0
    lines = {x["codigo"]: x for x in mp.lines(LIC_PREFIX)}
    assert lines["L2"]["http_status"] == 404
    assert lines["L2"]["error"]
    assert lines["L3"]["http_status"] == 200
    assert ("ordenes_compra", "codigo", "O1") in mp.calls()


def test_e3_a_detail_still_failing_after_retries_is_an_error_line(mp):
    mp.listado("licitaciones", "21102026", ["L1", "L2"])
    mp.listado("ordenes_compra", "21102026", [])
    route = mp.detalle("licitaciones", "L1", [httpx.Response(503)] * 4)
    mp.detalle("licitaciones", "L2")
    outcome = mp.run()
    assert outcome.code == 0
    assert route.call_count == 4
    lines = {x["codigo"]: x for x in mp.lines(LIC_PREFIX)}
    assert lines["L1"]["http_status"] == 503
    assert "503" in lines["L1"]["error"]
    assert lines["L2"]["http_status"] == 200


def test_e3_a_400_detail_does_not_stop_the_job(mp):
    mp.listado("licitaciones", "21102026", ["L1", "L2"])
    mp.listado("ordenes_compra", "21102026", [])
    mp.detalle("licitaciones", "L1", [httpx.Response(400, json={"Mensaje": "código inválido"})])
    mp.detalle("licitaciones", "L2")
    outcome = mp.run()
    assert outcome.code == 0
    lines = {x["codigo"]: x for x in mp.lines(LIC_PREFIX)}
    assert lines["L1"]["http_status"] == 400
    assert lines["L2"]["http_status"] == 200


def test_e4_budget_exhaustion_saves_the_cursor_and_exits_0(mp):
    outcome = scenario_e4(mp)
    assert outcome.code == 0
    assert len(mp.router.calls) == 5
    assert outcome.result["requests"] == 5
    assert outcome.result["presupuesto_agotado"] is True
    assert outcome.result["cursor"] == f"gs://bucket-prueba/{CURSOR_PATH}"
    assert "presupuesto de 5 requests alcanzado" in outcome.err
    cursor = mp.cursor()
    assert cursor["fecha"] == D
    assert cursor["fase"] == "licitaciones"
    assert cursor["ultimo_codigo"] == "L3"
    assert cursor["codigos"]["licitaciones"] == CODES
    assert [x["codigo"] for x in mp.lines(LIC_PREFIX)] == [None, "L1", "L2", "L3"]

    mp.router.reset()
    second = mp.run()
    assert second.code == 0
    calls = mp.calls()
    assert calls[0] == ("licitaciones", "codigo", "L4")
    assert all(kind == "codigo" for _, kind, _ in calls)
    assert [c[2] for c in calls] == CODES[3:]
    assert mp.cursor() is None


def test_e4_cursor_written_by_a_flush_never_points_past_a_written_line(mp):
    from compras_ingest import bronze

    mp.listado("licitaciones", "21102026", CODES)
    mp.listado("ordenes_compra", "21102026", [])
    for c in CODES:
        mp.detalle("licitaciones", c)
    original = bronze.BronzeWriter.__init__

    def small(self, *args, **kwargs):
        original(self, *args, **{**kwargs, "flush_every": 2})

    bronze.BronzeWriter.__init__ = small
    try:
        outcome = mp.run(env_extra={"MP_DAILY_REQUEST_BUDGET": "7"})
    finally:
        bronze.BronzeWriter.__init__ = original
    assert outcome.code == 0
    assert mp.cursor()["ultimo_codigo"] == "L5"
    assert len([p for p in mp.storage.objects if p.startswith(LIC_PREFIX)]) == 3


SCENARIOS = {
    "e1": scenario_e1,
    "e2": lambda mp: scenario_e2(mp)[0],
    "e3": scenario_e3,
    "e4": scenario_e4,
    "e7": scenario_e7,
    "timeout": scenario_timeout,
    "listado-401": scenario_401,
}


@pytest.mark.parametrize("name", list(SCENARIOS))
def test_e5_ticket_never_in_output_logs_or_objects(mp, caplog, name):
    caplog.set_level(logging.DEBUG)
    outcome = SCENARIOS[name](mp)
    forms = {TICKET, quote(TICKET, safe="")}
    for form in forms:
        assert form not in outcome.out
        assert form not in outcome.err
        assert form not in caplog.text
        for record in caplog.records:
            assert form not in record.getMessage()
        for path, data in mp.storage.objects.items():
            assert form.encode() not in data, path
    # The ticket was really sent, so the absence above is redaction and not a missing parameter.
    assert any(TICKET in str(call.request.url) for call in mp.router.calls)


def test_e5_timeout_line_has_null_status_and_redacted_url(mp):
    outcome = scenario_timeout(mp)
    assert outcome.code == 0
    line = next(x for x in mp.lines(LIC_PREFIX) if x["codigo"] == "L1")
    assert line["http_status"] is None
    assert line["error"] == "timeout"
    assert "ticket=***" in line["source_url"]


def test_e6_backfill_processes_days_in_ascending_order(mp):
    for day in ("01", "02", "03"):
        mp.listado("licitaciones", f"{day}102026", [f"L{day}"])
        mp.listado("ordenes_compra", f"{day}102026", [])
        mp.detalle("licitaciones", f"L{day}")
    outcome = mp.run(["mercadopublico", "--from", "2026-10-01", "--to", "2026-10-03"])
    assert outcome.code == 0
    listados = [c[2] for c in mp.calls() if c[1] == "fecha" and c[0] == "licitaciones"]
    assert listados == ["01102026", "02102026", "03102026"]
    assert outcome.result["dias"] == ["2026-10-01", "2026-10-02", "2026-10-03"]
    for day in ("2026-10-01", "2026-10-02", "2026-10-03"):
        assert mp.lines(f"mercadopublico/licitaciones/fecha={day}/")


def test_e7_retry_after_is_respected_and_both_attempts_count(mp):
    outcome = scenario_e7(mp)
    assert outcome.code == 0
    assert any(s >= 2 for s in mp.sleeps)
    assert outcome.result["requests"] == 2 + 2 + 1
    line = next(x for x in mp.lines(LIC_PREFIX) if x["codigo"] == "L1")
    assert line["http_status"] == 200


def _seed_cursor(mp):
    cursor = {
        "version": 1,
        "fecha": "2026-10-19",
        "fase": "licitaciones",
        "ultimo_codigo": "A1",
        "codigos": {"licitaciones": ["A1", "A2", "A3"], "ordenes_compra": ["AO1", "AO2"]},
        "run_id": "20261020T030000Z-0123abcd",
        "actualizado": "2026-10-20T03:10:00Z",
    }
    mp.storage.objects[CURSOR_PATH] = json.dumps(cursor).encode()
    for c in ("A2", "A3"):
        mp.detalle("licitaciones", c)
    for c in ("AO1", "AO2"):
        mp.detalle("ordenes_compra", c)
    mp.listado("licitaciones", "20102026", ["B1"])
    mp.listado("ordenes_compra", "20102026", ["BO1"])
    mp.detalle("licitaciones", "B1")
    mp.detalle("ordenes_compra", "BO1")
    mp.listado("licitaciones", "21102026", ["C1"])
    mp.listado("ordenes_compra", "21102026", [])
    mp.detalle("licitaciones", "C1")


def test_e8_finishes_the_cursor_day_then_the_gap_then_d(mp):
    _seed_cursor(mp)
    outcome = mp.run()
    assert outcome.code == 0
    assert [c[2] for c in mp.calls()] == [
        "A2",
        "A3",
        "AO1",
        "AO2",
        "20102026",
        "20102026",
        "B1",
        "BO1",
        "21102026",
        "21102026",
        "C1",
    ]
    assert outcome.result["dias"] == ["2026-10-19", "2026-10-20", "2026-10-21"]
    assert mp.cursor() is None
    assert [x["codigo"] for x in mp.lines("mercadopublico/licitaciones/fecha=2026-10-19/")] == ["A2", "A3"]


def test_e8_budget_running_out_in_d_minus_1_leaves_the_cursor_there(mp):
    _seed_cursor(mp)
    outcome = mp.run(env_extra={"MP_DAILY_REQUEST_BUDGET": "6"})
    assert outcome.code == 0
    assert outcome.result["presupuesto_agotado"] is True
    assert not any(c[2] in ("21102026", "C1") for c in mp.calls())
    cursor = mp.cursor()
    assert cursor["fecha"] == "2026-10-20"
    assert cursor["codigos"] == {"licitaciones": ["B1"], "ordenes_compra": ["BO1"]}
    assert cursor["ultimo_codigo"] is None


def test_s28_requests_are_spaced_by_the_interval_including_retries(mp):
    """S-28: the client waits until `interval` seconds passed since the previous request started; a retry's own
    backoff counts toward that spacing, and the first request never waits."""
    from compras_ingest.budget import RequestBudget
    from compras_ingest.mercadopublico import MercadoPublico

    clock = {"t": 100.0}
    sleeps: list[float] = []

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        clock["t"] += seconds

    def get(request):
        clock["t"] += 0.25  # every call takes a quarter of a second
        return detalle_ok("X")

    mp.router.get(url__startswith="https://api.mercadopublico.cl/").mock(side_effect=get)
    api = MercadoPublico(
        httpx.Client(), TICKET, RequestBudget(50), sleep, interval=2.5, clock=lambda: clock["t"], retry_delay=1.0
    )

    api.detalle("licitaciones", "L1")
    api.detalle("licitaciones", "L2")
    api.detalle("licitaciones", "L3")
    assert sleeps == [2.25, 2.25]

    # A retry (these canned responses take no clock time): L4 spends 1 s in the backoff, so L5 only waits the
    # remaining 1.5 s of the interval.
    mp.router.get(url__startswith="https://api.mercadopublico.cl/").mock(
        side_effect=[httpx.Response(500), detalle_ok("L4"), detalle_ok("L5")]
    )
    api.detalle("licitaciones", "L4")
    api.detalle("licitaciones", "L5")
    assert sleeps == [2.25, 2.25, 2.25, 1.0, 1.5]


def test_s28_retry_delay_is_the_base_of_the_backoff(mp):
    from compras_ingest.budget import RequestBudget
    from compras_ingest.mercadopublico import MercadoPublico

    sleeps: list[float] = []
    mp.router.get(url__startswith="https://api.mercadopublico.cl/").mock(
        side_effect=[httpx.Response(429), httpx.Response(429), detalle_ok("L1")]
    )
    api = MercadoPublico(httpx.Client(), TICKET, RequestBudget(50), sleeps.append, retry_delay=10.0)
    fetched = api.detalle("licitaciones", "L1")
    assert sleeps == [10.0, 20.0]
    assert fetched.attempts == 3
    assert fetched.estados_previos == [429, 429]


def test_s28_line_records_the_attempts_and_the_codes_of_the_failed_ones(mp):
    """S-28: every bronze line says how many attempts it cost and what the API answered on the failed ones."""
    outcome, _route = scenario_e2(mp)
    assert outcome.code == 0
    lines = {x["codigo"]: x for x in mp.lines(LIC_PREFIX) if x["tipo"] == "detalle"}
    assert lines["L1"]["intentos"] == 1 and lines["L1"]["estados_previos"] == []
    assert lines["L2"]["intentos"] == 3 and lines["L2"]["estados_previos"] == [500, 500]


def test_s28_interval_zero_never_sleeps(mp):
    from compras_ingest.budget import RequestBudget
    from compras_ingest.mercadopublico import MercadoPublico

    sleeps: list[float] = []
    mp.router.get(url__startswith="https://api.mercadopublico.cl/").mock(return_value=detalle_ok("X"))
    api = MercadoPublico(httpx.Client(), TICKET, RequestBudget(50), sleeps.append, interval=0.0)
    api.detalle("licitaciones", "L1")
    api.detalle("licitaciones", "L2")
    assert sleeps == []


def test_e9_a_purchase_order_with_a_detail_in_raw_is_not_asked_again(mp):
    mp.bq.conocidas = {"O1"}
    mp.listado("licitaciones", "21102026", ["L1"])
    mp.listado("ordenes_compra", "21102026", ["O1", "O2"])
    mp.detalle("licitaciones", "L1")
    mp.detalle("ordenes_compra", "O2")
    outcome = mp.run()
    assert outcome.code == 0
    assert [c[2] for c in mp.calls()[2:]] == ["L1", "O2"]
    assert outcome.result["oc_omitidas"] == 1
    assert outcome.result["requests"] == 4
    oc = mp.lines(f"mercadopublico/ordenes_compra/fecha={D}/run={outcome.result['run_id']}/")
    assert [(line["tipo"], line["codigo"]) for line in oc] == [("listado", None), ("detalle", "O2")]
    assert any("mercadopublico_ordenes_compra" in q and "'detalle'" in q for q in mp.bq.queries)


def test_e9_a_purchase_order_whose_detail_this_run_got_is_not_asked_on_a_later_day(mp):
    mp.listado("licitaciones", "20102026", [])
    mp.listado("ordenes_compra", "20102026", ["O1"])
    mp.listado("licitaciones", "21102026", [])
    mp.listado("ordenes_compra", "21102026", ["O1", "O2"])
    mp.detalle("ordenes_compra", "O1")
    mp.detalle("ordenes_compra", "O2")
    outcome = mp.run(argv=("mercadopublico", "--from", "2026-10-20", "--to", "2026-10-21"))
    assert outcome.code == 0
    assert [c[2] for c in mp.calls() if c[1] == "codigo"] == ["O1", "O2"]
    assert outcome.result["oc_omitidas"] == 1


def test_e9_a_failed_purchase_order_detail_is_asked_again_on_a_later_day(mp):
    mp.listado("licitaciones", "20102026", [])
    mp.listado("ordenes_compra", "20102026", ["O1"])
    mp.listado("licitaciones", "21102026", [])
    mp.listado("ordenes_compra", "21102026", ["O1"])
    mp.detalle("ordenes_compra", "O1", [httpx.Response(404, json={"Mensaje": "no existe"}), detalle_ok("O1")])
    outcome = mp.run(argv=("mercadopublico", "--from", "2026-10-20", "--to", "2026-10-21"))
    assert outcome.code == 0
    assert [c[2] for c in mp.calls() if c[1] == "codigo"] == ["O1", "O1"]
    assert outcome.result["oc_omitidas"] == 0


def test_e9_tenders_are_always_asked_even_if_their_code_is_a_known_order(mp):
    mp.bq.conocidas = {"L1"}
    mp.listado("licitaciones", "21102026", ["L1"])
    mp.listado("ordenes_compra", "21102026", [])
    mp.detalle("licitaciones", "L1")
    outcome = mp.run()
    assert [c[2] for c in mp.calls()[2:]] == ["L1"]
    assert outcome.result["oc_omitidas"] == 0


def test_e9_without_the_known_orders_every_detail_is_asked(mp, caplog):
    from google.api_core.exceptions import Forbidden

    mp.bq.conocidas = {"O1"}
    mp.bq.query_error = Forbidden(f"denied ticket={TICKET}")
    mp.listado("licitaciones", "21102026", [])
    mp.listado("ordenes_compra", "21102026", ["O1"])
    mp.detalle("ordenes_compra", "O1")
    with caplog.at_level(logging.WARNING):
        outcome = mp.run()
    assert outcome.code == 0
    assert [c[2] for c in mp.calls()[2:]] == ["O1"]
    assert "OC conocidas" in caplog.text
    assert TICKET not in caplog.text
