"""DEC-012: one row per run in raw.corridas, read by the Workflow and gold.dim_corrida (REQ-007 E6)."""

from datetime import UTC, datetime

from conftest import BUCKET, TICKET
from google.api_core.exceptions import BadRequest
from test_load import PROJECT, indicadores_sources, mp_run
from test_mercadopublico import scenario_e4

from compras_ingest.corridas import estado, fila


def test_estado_is_ok_only_with_exit_0_no_failed_load_and_budget_left():
    assert estado(0, False, 0) == "OK"
    assert estado(0, True, 0) == "PARCIAL"
    assert estado(1, False, 0) == "ERROR"
    assert estado(0, False, 1) == "ERROR"
    assert estado(1, True, 0) == "ERROR"


def test_fila_carries_the_ingest_date_of_the_run_id_and_the_schema_fields():
    row = fila(
        run_id="20261027T023000Z-0a1b2c3d",
        fuente="mercadopublico",
        fechas=["2026-10-26"],
        exit_code=0,
        requests=9000,
        presupuesto_agotado=True,
        cursor=f"gs://{BUCKET}/mercadopublico/_cursor.json",
        objetos=4,
        cargas_fallidas=0,
        finished_at=datetime(2026, 10, 27, 4, 50, tzinfo=UTC),
    )
    assert row["_ingest_date"] == "2026-10-27"
    assert row["estado"] == "PARCIAL"
    assert row["finished_at"] == "2026-10-27T04:50:00.000000Z"
    assert set(row) == {
        "run_id",
        "_ingest_date",
        "fuente",
        "estado",
        "exit_code",
        "requests",
        "fechas",
        "presupuesto_agotado",
        "cursor",
        "objetos",
        "cargas_fallidas",
        "finished_at",
    }


def corrida(mp):
    [call] = mp.bq.json_loads
    [row] = call.uris
    return call, row


def test_a_complete_run_records_ok_in_raw_corridas(mp):
    outcome = mp_run(mp)
    assert outcome.code == 0
    call, row = corrida(mp)
    assert call.destination == f"{PROJECT}.raw.corridas"
    assert call.job_config.write_disposition == "WRITE_APPEND"
    assert row["fuente"] == "mercadopublico" and row["estado"] == "OK"
    assert row["run_id"] == outcome.result["run_id"] and row["fechas"] == outcome.result["dias"]
    assert row["cursor"] is None and row["cargas_fallidas"] == 0 and row["objetos"] == len(outcome.result["objetos"])


def test_a_run_stopped_by_the_budget_records_parcial_with_its_cursor(mp):
    outcome = scenario_e4(mp)
    assert outcome.code == 0
    _, row = corrida(mp)
    assert row["estado"] == "PARCIAL" and row["presupuesto_agotado"] is True
    assert row["cursor"] == outcome.result["cursor"] and row["requests"] == 5


def test_a_failed_load_records_error(mp):
    mp.bq.fail[f"{PROJECT}.raw.mercadopublico_ordenes_compra"] = BadRequest("boom")
    outcome = mp_run(mp)
    assert outcome.code != 0
    _, row = corrida(mp)
    assert row["estado"] == "ERROR" and row["cargas_fallidas"] == 1


def test_the_indicators_run_records_its_date_as_the_processed_day(mp):
    indicadores_sources(mp)
    outcome = mp.run(["indicadores"])
    assert outcome.code == 0
    _, row = corrida(mp)
    assert row["fuente"] == "indicadores" and row["estado"] == "OK" and row["fechas"] == [outcome.result["fecha"]]


def test_not_recording_the_run_is_an_error_logged_without_the_ticket(mp):
    mp.bq.fail[f"{PROJECT}.raw.corridas"] = BadRequest(f"denied ticket={TICKET}")
    outcome = mp_run(mp)
    assert outcome.code == 1
    assert "no se pudo registrar la corrida" in outcome.err
    assert TICKET not in outcome.err


def test_raw_dataset_changes_the_corridas_destination(mp):
    outcome = mp_run(mp, env_extra={"RAW_DATASET": "raw_ci"})
    assert outcome.code == 0
    call, _ = corrida(mp)
    assert call.destination == f"{PROJECT}.raw_ci.corridas"
