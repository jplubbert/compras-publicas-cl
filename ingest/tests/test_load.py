"""REQ-006: bronze to BigQuery raw load jobs (examples E1, E2 and E4) and the raw schemas."""

import json
from datetime import date

import httpx
import pytest
from conftest import BUCKET, TICKET, TOKEN, FakeBigQueryClient, FakeStorageClient, obs
from google.api_core.exceptions import BadRequest
from google.cloud import bigquery

from compras_ingest.bcentral import SERIES
from compras_ingest.bronze import ingest_date
from compras_ingest.load import SCHEMAS_DIR, LoadError, group, load_run
from compras_ingest.mercadopublico import ENTIDADES
from compras_ingest.mindicador import INDICADORES

D = "21102026"
D_MIND = "21-10-2026"
PROJECT = "proyecto-prueba"
RUN = "20261022T030000Z-0a1b2c3d"
RAW_TABLES = [
    "mercadopublico_licitaciones",
    "mercadopublico_ordenes_compra",
    "bcentral_uf",
    "bcentral_dolar",
    "bcentral_ipc",
    "mindicador_uf",
    "mindicador_dolar",
    "corridas",
]


def schema_of(table: str) -> list[dict]:
    return json.loads((SCHEMAS_DIR / f"{table}.json").read_text(encoding="utf-8"))


def mp_run(mp, licitaciones=("L1", "L2"), ordenes=("OC1",), **kw):
    mp.listado("licitaciones", D, list(licitaciones))
    mp.listado("ordenes_compra", D, list(ordenes))
    for codigo in licitaciones:
        mp.detalle("licitaciones", codigo)
    for codigo in ordenes:
        mp.detalle("ordenes_compra", codigo)
    return mp.run(["mercadopublico"], **kw)


def indicadores_sources(mp, mind_timeout=False):
    window = date(2026, 10, 11)
    for codigo in SERIES.values():
        mp.serie(codigo, obs(window, 11))
    for nombre in INDICADORES:
        if mind_timeout:
            mp.mindicador(nombre, D_MIND, side_effect=httpx.ConnectTimeout)
        else:
            mp.mindicador(nombre, D_MIND)


def test_e1_two_load_jobs_with_ndjson_append_and_the_repo_schema(mp):
    outcome = mp_run(mp)
    assert outcome.code == 0
    assert [c.destination for c in mp.bq.loads] == [
        f"{PROJECT}.raw.mercadopublico_licitaciones",
        f"{PROJECT}.raw.mercadopublico_ordenes_compra",
    ]
    objetos = outcome.result["objetos"]
    assert sorted(u for c in mp.bq.loads for u in c.uris) == sorted(f"gs://{BUCKET}/{p}" for p in objetos)
    for call in mp.bq.loads:
        cfg = call.job_config
        assert cfg.source_format == "NEWLINE_DELIMITED_JSON"
        assert cfg.write_disposition == "WRITE_APPEND"
        assert cfg.create_disposition == "CREATE_NEVER"
        assert not cfg.autodetect
        table = call.destination.split(".")[-1]
        assert [f.to_api_repr() for f in cfg.schema] == [_api(f) for f in schema_of(table)]
        assert cfg.labels["run_id"] == outcome.result["run_id"].lower()
    assert [c["filas"] for c in outcome.result["cargas"]] == [3, 2]
    assert all(c["error"] is None for c in outcome.result["cargas"])


def _api(field: dict) -> dict:
    return bigquery.SchemaField.from_api_repr(field).to_api_repr()


def test_e2_failed_load_job_exits_non_zero_naming_table_and_files(mp):
    table = f"{PROJECT}.raw.mercadopublico_ordenes_compra"
    mp.bq.fail[table] = BadRequest(f"Error while reading data, url ticket={TICKET}")
    outcome = mp_run(mp)
    assert outcome.code != 0
    assert table in outcome.err
    [oc] = [p for p in outcome.result["objetos"] if p.startswith("mercadopublico/ordenes_compra/")]
    assert f"gs://{BUCKET}/{oc}" in outcome.err
    assert TICKET not in outcome.err and TICKET not in outcome.out
    # The other entity still loaded.
    cargas = {c["tabla"]: c for c in outcome.result["cargas"]}
    assert cargas[f"{PROJECT}.raw.mercadopublico_licitaciones"]["error"] is None
    assert cargas[table]["error"]


def test_e4_failed_listing_loads_only_the_entity_with_files(mp):
    mp.listado("licitaciones", D, [], status=500)
    outcome = mp.run(["mercadopublico"])
    assert outcome.code == 1
    assert [c.destination for c in mp.bq.loads] == [f"{PROJECT}.raw.mercadopublico_licitaciones"]


def test_e4_load_run_without_an_entity_has_no_job_for_it():
    bq = FakeBigQueryClient()
    objetos = [
        f"mercadopublico/licitaciones/fecha=2026-10-21/run={RUN}/part-0000.jsonl",
        f"mercadopublico/licitaciones/fecha=2026-10-21/run={RUN}/part-0001.jsonl",
        "mercadopublico/_cursor.json",
    ]
    cargas = load_run(bq, project=PROJECT, dataset="raw", bucket=BUCKET, objetos=objetos, run_id=RUN)
    assert [c.destination for c in bq.loads] == [f"{PROJECT}.raw.mercadopublico_licitaciones"]
    assert bq.loads[0].uris == [f"gs://{BUCKET}/{p}" for p in objetos[:2]]
    assert len(cargas) == 1
    assert load_run(bq, project=PROJECT, dataset="raw", bucket=BUCKET, objetos=[], run_id=RUN) == []


def test_load_run_without_schema_fails_that_entity():
    bq = FakeBigQueryClient()
    objetos = [f"mercadopublico/sin_esquema/fecha=2026-10-21/run={RUN}/part-0000.jsonl"]
    with pytest.raises(LoadError, match="mercadopublico_sin_esquema") as info:
        load_run(bq, project=PROJECT, dataset="raw", bucket=BUCKET, objetos=objetos, run_id=RUN)
    assert info.value.cargas[0]["error"]
    assert bq.loads == []


def test_indicadores_loads_one_job_per_series_and_indicator(mp):
    indicadores_sources(mp)
    outcome = mp.run(["indicadores"])
    assert outcome.code == 0
    assert sorted(c.destination.split(".")[-1] for c in mp.bq.loads) == sorted(
        ["bcentral_uf", "bcentral_dolar", "bcentral_ipc", "mindicador_uf", "mindicador_dolar"]
    )
    assert TOKEN not in outcome.out and TOKEN not in outcome.err


def test_indicadores_without_mindicador_loads_three_jobs(mp):
    indicadores_sources(mp, mind_timeout=True)
    outcome = mp.run(["indicadores"])
    assert outcome.code == 0
    assert sorted(c.destination.split(".")[-1] for c in mp.bq.loads) == [
        "bcentral_dolar",
        "bcentral_ipc",
        "bcentral_uf",
    ]


def test_raw_dataset_changes_the_destination(mp):
    mp_run(mp, env_extra={"RAW_DATASET": "raw_ci"})
    assert {c.destination.split(".")[1] for c in mp.bq.loads} == {"raw_ci"}


def test_missing_project_with_files_is_a_config_error(mp):
    outcome = mp_run(mp, env_extra={"GOOGLE_CLOUD_PROJECT": "", "MP_TICKET_SECRET": "projects/p/secrets/s/versions/1"})
    assert outcome.code == 2
    assert "GOOGLE_CLOUD_PROJECT" in outcome.err
    assert mp.bq.loads == []


def test_every_bronze_line_carries_the_run_ingest_date(mp):
    outcome = mp_run(mp)
    run_id = outcome.result["run_id"]
    assert ingest_date(run_id) == "2026-10-22"
    lines = mp.lines("mercadopublico/")
    assert lines and all(line["_ingest_date"] == "2026-10-22" for line in lines)


def test_ingest_date_is_the_run_id_prefix():
    assert ingest_date("20261231T235959Z-ffffffff") == "2026-12-31"


def test_every_raw_table_has_a_schema_with_run_id_and_ingest_date():
    files = sorted(p.stem for p in SCHEMAS_DIR.glob("*.json"))
    assert files == sorted(RAW_TABLES)
    for table in RAW_TABLES:
        fields = {f["name"]: f for f in schema_of(table)}
        assert fields["run_id"]["type"] == "STRING" and fields["run_id"]["mode"] == "REQUIRED"
        assert fields["_ingest_date"]["type"] == "DATE" and fields["_ingest_date"]["mode"] == "REQUIRED"
        assert all(f.get("description") for f in fields.values())


def test_every_bronze_entity_has_a_schema():
    entities = (
        [f"mercadopublico_{e}" for e in ENTIDADES]
        + [f"bcentral_{s}" for s in SERIES]
        + [f"mindicador_{i}" for i in INDICADORES]
    )
    # corridas is the run record (DEC-012), not a bronze entity.
    assert sorted(entities) == sorted(t for t in RAW_TABLES if t != "corridas")


def test_schema_covers_every_record_key(mp):
    mp_run(mp)
    keys = set().union(*(line.keys() for line in mp.lines("mercadopublico/")))
    assert keys == {f["name"] for f in schema_of("mercadopublico_licitaciones")}


def test_load_subcommand_loads_only_the_requested_run(mp):
    first = mp_run(mp)
    run_id = first.result["run_id"]
    other = "mercadopublico/licitaciones/fecha=2026-10-21/run=20261001T000000Z-00000000/part-0000.jsonl"
    mp.storage.objects[other] = b"{}\n"
    mp.bq.loads.clear()
    api_calls = mp.router.calls.call_count
    outcome = mp.run(["load", "--fuente", "mercadopublico", "--run-id", run_id])
    assert outcome.code == 0
    uris = sorted(u for c in mp.bq.loads for u in c.uris)
    assert uris == sorted(f"gs://{BUCKET}/{p}" for p in first.result["objetos"])
    assert outcome.result["run_id"] == run_id
    assert len(outcome.result["cargas"]) == 2
    assert mp.router.calls.call_count == api_calls


@pytest.mark.parametrize("run_id", ["no-es-un-run", "20261022T030000Z-0a1b2c3d"], ids=["malformed", "no-files"])
def test_load_subcommand_exits_2_without_files_or_with_a_bad_run_id(mp, run_id):
    outcome = mp.run(["load", "--fuente", "bcentral", "--run-id", run_id])
    assert outcome.code == 2
    assert mp.bq.loads == []


def test_load_subcommand_failure_exits_1(mp):
    first = mp_run(mp)
    mp.bq.fail[f"{PROJECT}.raw.mercadopublico_licitaciones"] = BadRequest("bad row")
    outcome = mp.run(["load", "--fuente", "mercadopublico", "--run-id", first.result["run_id"]])
    assert outcome.code == 1
    assert "mercadopublico_licitaciones" in outcome.err


def test_group_skips_non_jsonl():
    assert group(["a/b/fecha=x/run=y/part-0000.jsonl", "a/_cursor.json"]) == {
        ("a", "b"): ["a/b/fecha=x/run=y/part-0000.jsonl"]
    }


def test_gcs_store_lists_by_glob():
    from compras_ingest.bronze import GcsStore

    storage = FakeStorageClient()
    storage.objects = {"m/a/fecha=1/run=R/part-0000.jsonl": b"", "m/a/fecha=1/run=S/part-0000.jsonl": b""}
    assert GcsStore(BUCKET, client=storage).list("m/*/fecha=*/run=R/*.jsonl") == ["m/a/fecha=1/run=R/part-0000.jsonl"]
