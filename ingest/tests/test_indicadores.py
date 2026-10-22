"""REQ-005: Banco Central and mindicador.cl ingestion into bronze (examples E1 to E4)."""

import logging
import re
from datetime import date
from urllib.parse import parse_qs, quote, urlsplit

import httpx
import pytest
from conftest import TOKEN, obs

from compras_ingest.bcentral import SERIES

D = "2026-10-21"
D_MIND = "21-10-2026"
RUN_ID = re.compile(r"^\d{8}T\d{6}Z-[0-9a-f]{8}$")
REQ_004_KEYS = {"run_id", "ingested_at", "source_url", "http_status", "fecha"}
UF, DOLAR, IPC = SERIES["uf"], SERIES["dolar"], SERIES["ipc"]


def all_sources(mp, uf=None, dolar=None, ipc=None, mind_uf=None, mind_dolar=None):
    """Simulate the three BDE series and the two mindicador indicators; return the routes by name."""
    window = date(2026, 10, 11)
    return {
        "uf": uf if uf is not None else mp.serie(UF, obs(window, 11)),
        "dolar": dolar if dolar is not None else mp.serie(DOLAR, obs(window, 11)),
        "ipc": ipc if ipc is not None else mp.serie(IPC, []),
        "mind_uf": mind_uf if mind_uf is not None else mp.mindicador("uf", D_MIND),
        "mind_dolar": mind_dolar if mind_dolar is not None else mp.mindicador("dolar", D_MIND),
    }


def query(route) -> dict:
    return {k: v[0] for k, v in parse_qs(urlsplit(str(route.calls.last.request.url)).query).items()}


def scenario_e1(mp):
    routes = all_sources(mp)
    return mp.run(["indicadores"]), routes


def scenario_e2(mp):
    dolar_obs = [
        {"indexDateString": "16-10-2026", "value": "950.10", "statusCode": "OK"},
        {"indexDateString": "17-10-2026", "value": "ND", "statusCode": "ND"},
        {"indexDateString": "18-10-2026", "value": "NaN", "statusCode": "ND"},
    ]
    all_sources(mp, dolar=mp.serie(DOLAR, dolar_obs))
    return mp.run(["indicadores"]), dolar_obs


def scenario_e3_codigo(mp):
    routes = all_sources(mp, uf=mp.serie(UF, [], codigo_bde=-5, descripcion=f"Invalid token {TOKEN}"))
    return mp.run(["indicadores"]), routes


def scenario_e3_401(mp):
    response = httpx.Response(401, json={"Descripcion": f"token {TOKEN} rechazado"})
    routes = all_sources(mp, uf=mp.serie(UF, [], side_effect=[response]))
    return mp.run(["indicadores"]), routes


def scenario_e4(mp):
    routes = all_sources(mp, mind_uf=mp.mindicador("uf", D_MIND, side_effect=httpx.ConnectTimeout))
    return mp.run(["indicadores"]), routes


def scenario_500(mp):
    routes = all_sources(mp, dolar=mp.serie(DOLAR, [], side_effect=httpx.Response(500)))
    return mp.run(["indicadores"]), routes


def test_e1_one_line_per_series_with_the_11_observations(mp):
    outcome, routes = scenario_e1(mp)
    assert outcome.code == 0
    run_id = outcome.result["run_id"]
    assert RUN_ID.match(run_id)
    [line] = mp.lines(f"bcentral/uf/fecha={D}/run={run_id}/")
    assert len(line["payload"]["Series"]["Obs"]) == 11
    assert REQ_004_KEYS <= line.keys()
    assert line["run_id"] == run_id and line["fecha"] == D
    assert line["http_status"] == 200
    assert line["codigo"] == UF
    assert "token=***" in line["source_url"]
    q = query(routes["uf"])
    assert q["function"] == "GetSeries"
    assert q["firstdate"] == "2026-10-11" and q["lastdate"] == D
    for nombre, codigo in SERIES.items():
        [serie] = mp.lines(f"bcentral/{nombre}/fecha={D}/run={run_id}/")
        assert serie["codigo"] == codigo
    for nombre in ("uf", "dolar"):
        [ind] = mp.lines(f"mindicador/{nombre}/fecha={D}/run={run_id}/")
        assert REQ_004_KEYS <= ind.keys()
        assert ind["http_status"] == 200
    assert outcome.result["series"] == ["uf", "dolar", "ipc"]
    assert outcome.result["mindicador"] == ["uf", "dolar"]
    assert outcome.result["ausentes"] == [] and outcome.result["fallidas"] == []
    assert outcome.result["requests"] == 5
    assert len(outcome.result["objetos"]) == 5


def test_e2_nd_observations_are_kept_as_received(mp):
    outcome, dolar_obs = scenario_e2(mp)
    assert outcome.code == 0
    [line] = mp.lines(f"bcentral/dolar/fecha={D}/run={outcome.result['run_id']}/")
    assert line["payload"]["Series"]["Obs"] == dolar_obs
    assert line["payload"]["Series"]["Obs"][1]["value"] == "ND"
    assert line["payload"]["Series"]["Obs"][2]["value"] == "NaN"


@pytest.mark.parametrize("scenario", [scenario_e3_codigo, scenario_e3_401], ids=["codigo", "http401"])
def test_e3_rejected_token_exits_non_zero_without_the_token(mp, caplog, scenario):
    outcome, routes = scenario(mp)
    assert outcome.code != 0
    assert "token de la BDE rechazado" in outcome.err
    assert routes["uf"].call_count == 1
    for name in ("dolar", "ipc", "mind_uf", "mind_dolar"):
        assert routes[name].call_count == 0
    assert_token_absent(mp, outcome, caplog)
    [line] = mp.lines(f"bcentral/uf/fecha={D}/run={outcome.result['run_id']}/")
    assert "token=***" in line["source_url"]


def test_e4_mindicador_timeout_is_a_warning_and_exits_0(mp):
    outcome, routes = scenario_e4(mp)
    assert outcome.code == 0
    assert "mindicador" in outcome.err and "uf" in outcome.err
    assert "WARNING" in outcome.err
    run_id = outcome.result["run_id"]
    assert not [p for p in mp.storage.objects if p.startswith("mindicador/uf/")]
    assert mp.lines(f"mindicador/dolar/fecha={D}/run={run_id}/")
    assert routes["mind_uf"].call_count == 4
    assert mp.sleeps == [1.0, 2.0, 4.0]
    assert outcome.result["ausentes"] == ["uf"]
    assert outcome.result["mindicador"] == ["dolar"]


@pytest.mark.parametrize(
    "response",
    [httpx.Response(503), httpx.Response(404, json={"error": "no"}), httpx.Response(200, text="<html>")],
    ids=["503", "404", "no-json"],
)
def test_mindicador_without_a_json_answer_is_absent(mp, response):
    all_sources(mp, mind_dolar=mp.mindicador("dolar", D_MIND, side_effect=[response] * 4))
    outcome = mp.run(["indicadores"])
    assert outcome.code == 0
    assert outcome.result["ausentes"] == ["dolar"]
    assert not [p for p in mp.storage.objects if p.startswith("mindicador/dolar/")]


def test_mindicador_day_without_data_is_kept(mp):
    all_sources(mp, mind_dolar=mp.mindicador("dolar", D_MIND, serie=[]))
    outcome = mp.run(["indicadores"])
    assert outcome.code == 0
    [line] = mp.lines(f"mindicador/dolar/fecha={D}/run={outcome.result['run_id']}/")
    assert line["payload"]["serie"] == []
    assert outcome.result["ausentes"] == []


def test_series_failing_with_500_is_kept_and_the_others_are_requested(mp):
    outcome, routes = scenario_500(mp)
    assert outcome.code == 1
    assert routes["dolar"].call_count == 4
    assert routes["ipc"].call_count == 1
    assert routes["mind_uf"].call_count == 1
    [line] = mp.lines(f"bcentral/dolar/fecha={D}/run={outcome.result['run_id']}/")
    assert line["http_status"] == 500 and line["error"]
    assert "dolar" in outcome.err and DOLAR in outcome.err
    assert outcome.result["fallidas"] == ["dolar"]
    assert outcome.result["series"] == ["uf", "ipc"]


def test_series_without_series_key_fails(mp):
    dolar = mp.router.get(
        "https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx", params__contains={"timeseries": DOLAR}
    )
    dolar.mock(return_value=httpx.Response(200, json={"Codigo": 0, "Descripcion": "Success"}))
    all_sources(mp, dolar=dolar)
    outcome = mp.run(["indicadores"])
    assert outcome.code == 1
    assert "Series" in outcome.err
    assert outcome.result["fallidas"] == ["dolar"]


def test_explicit_date_sets_the_window(mp):
    uf = mp.serie(UF, [])
    mp.serie(DOLAR, [])
    mp.serie(IPC, [])
    mp.mindicador("uf", "05-10-2026")
    mp.mindicador("dolar", "05-10-2026")
    outcome = mp.run(["indicadores", "--date", "2026-10-05"])
    assert outcome.code == 0
    q = query(uf)
    assert q["firstdate"] == "2026-09-25" and q["lastdate"] == "2026-10-05"
    assert outcome.result["fecha"] == "2026-10-05"
    assert mp.lines(f"bcentral/uf/fecha=2026-10-05/run={outcome.result['run_id']}/")


def test_invalid_date_exits_2(mp):
    assert mp.run(["indicadores", "--date", "2026-13-01"]).code == 2
    assert mp.router.calls.call_count == 0


def test_missing_bucket_exits_2(mp):
    outcome = mp.run(["indicadores"], env_extra={"BRONZE_BUCKET": ""})
    assert outcome.code == 2
    assert "BRONZE_BUCKET" in outcome.err
    assert mp.router.calls.call_count == 0


def test_budget_exhausted_exits_1(mp, monkeypatch):
    monkeypatch.setattr("compras_ingest.cli.INDICADORES_BUDGET", 2)
    routes = all_sources(mp)
    outcome = mp.run(["indicadores"])
    assert outcome.code == 1
    assert "presupuesto de 2 requests" in outcome.err
    assert routes["ipc"].call_count == 0
    assert outcome.result["requests"] == 2
    assert len(mp.lines("bcentral/")) == 2


def assert_token_absent(mp, outcome, caplog):
    texts = [outcome.out, outcome.err, caplog.text]
    texts += [data.decode("utf-8") for data in mp.storage.objects.values()]
    for text in texts:
        assert TOKEN not in text
        assert quote(TOKEN, safe="") not in text


@pytest.mark.parametrize(
    "scenario",
    [scenario_e1, scenario_e2, scenario_e3_codigo, scenario_e3_401, scenario_e4, scenario_500],
    ids=["e1", "e2", "e3-codigo", "e3-401", "e4", "500"],
)
def test_token_never_leaks(mp, caplog, scenario):
    caplog.set_level(logging.DEBUG)
    outcome, _ = scenario(mp)
    assert_token_absent(mp, outcome, caplog)
