"""Structural checks of the daily Workflow (REQ-007, DEC-002): offline, no Workflows validator exists (DEC-005)."""

import copy
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
DAILY = ROOT / "orchestration" / "daily.yaml"
MODULE = ROOT / "infra" / "modules" / "orchestration" / "main.tf"
RUN_JOB = "googleapis.run.v2.projects.locations.jobs.run"


def load():
    return yaml.safe_load(DAILY.read_text())


def steps(doc):
    return doc["main"]["steps"]


def names(doc):
    return [next(iter(s)) for s in steps(doc)]


def step(doc, name):
    return next(s[name] for s in steps(doc) if name in s)


def ordered(doc):
    """E2: both ingest jobs, then the Dataform compilation and invocation, in that order."""
    order = ["ingesta_mercadopublico", "ingesta_indicadores", "compilar_dataform", "invocar_dataform"]
    found = names(doc)
    if not all(n in found for n in order):
        return False
    idx = [found.index(n) for n in order]
    return idx == sorted(idx)


def jobs_in_try(node, in_try=False):
    """E3: job connector calls nested anywhere inside a try block (steps, switch, for, parallel included)."""
    hits = []
    if isinstance(node, dict):
        if node.get("call") == RUN_JOB and in_try:
            hits.append(node["args"]["name"])
        for key, value in node.items():
            hits += jobs_in_try(value, in_try or key == "try")
    elif isinstance(node, list):
        for item in node:
            hits += jobs_in_try(item, in_try)
    return hits


def has_key(node, wanted):
    if isinstance(node, dict):
        return wanted in node or any(has_key(v, wanted) for v in node.values())
    if isinstance(node, list):
        return any(has_key(v, wanted) for v in node)
    return False


def raises_on_dataform_failure(doc):
    """E3: a switch raises on FAILED and CANCELLED and otherwise loops back to an earlier step."""
    found = names(doc)
    for i, s in enumerate(steps(doc)):
        body = next(iter(s.values()))
        if "switch" not in body:
            continue
        raising = [c for c in body["switch"] if "FAILED" in c["condition"] and "CANCELLED" in c["condition"]]
        if raising and all("raise" in c for c in raising):
            target = body.get("next")
            return target in found and found.index(target) < i
    return False


def test_orden_de_pasos():
    assert ordered(load())


def test_jobs_con_conector_que_espera():
    doc = load()
    for name, env in [("ingesta_mercadopublico", "JOB_MERCADOPUBLICO"), ("ingesta_indicadores", "JOB_INDICADORES")]:
        s = step(doc, name)
        assert s["call"] == RUN_JOB
        assert s["args"]["connector_params"]["timeout"] == 32400
        assert s["args"]["connector_params"].get("skip_polling") is not True
        assert env in s["args"]["name"]


def test_compilacion_desde_dataform_main_con_vars():
    s = step(load(), "compilar_dataform")
    assert s["call"] == "http.post"
    assert s["args"]["url"].endswith('/compilationResults"}')
    assert s["args"]["auth"]["type"] == "OAuth2"
    assert s["args"]["body"]["gitCommitish"] == "dataform-main"
    config = s["args"]["body"]["codeCompilationConfig"]
    assert "defaultDatabase" in config
    assert "raw_dataset" in config["vars"]
    assert config["vars"]["policy_tag_rut"] == "${policy_tag_rut}"


def test_invocacion_silver_y_gold():
    s = step(load(), "invocar_dataform")
    assert s["call"] == "http.post"
    assert s["args"]["url"].endswith('/workflowInvocations"}')
    assert s["args"]["body"]["invocationConfig"]["includedTags"] == ["silver", "gold"]


def test_ingesta_sin_try():
    doc = load()
    assert jobs_in_try(doc) == []
    assert not has_key(doc, "except")


def test_fallo_de_dataform_levanta_excepcion():
    assert raises_on_dataform_failure(load())


def test_chequeo_de_try_detecta_ingesta_envuelta():
    doc = load()
    s = steps(doc)
    i = names(doc).index("ingesta_mercadopublico")
    s[i] = {"envoltura": {"try": {"steps": [copy.deepcopy(s[i])]}, "except": {"as": "e", "steps": []}}}
    assert jobs_in_try(doc) != []
    assert has_key(doc, "except")


def test_chequeo_de_orden_detecta_inversion():
    doc = load()
    s = steps(doc)
    a, b = names(doc).index("ingesta_mercadopublico"), names(doc).index("compilar_dataform")
    s[a], s[b] = s[b], s[a]
    assert not ordered(doc)


def test_chequeo_de_excepcion_detecta_cancelled_ausente():
    doc = load()
    for c in step(doc, "evaluar_dataform")["switch"]:
        c["condition"] = c["condition"].replace(' or estado.body.state == "CANCELLED"', "")
    assert not raises_on_dataform_failure(doc)


def test_variables_de_entorno():
    used = set(re.findall(r'sys\.get_env\("([A-Z_]+)"\)', DAILY.read_text()))
    user = {v for v in used if not v.startswith("GOOGLE_")}
    block = re.search(r"user_env_vars\s*=\s*\{(.*?)\}", MODULE.read_text(), re.DOTALL).group(1)
    declared = set(re.findall(r"^\s*([A-Z_]+)\s*=", block, re.MULTILINE))
    assert user == {
        "JOB_MERCADOPUBLICO",
        "JOB_INDICADORES",
        "DATAFORM_REPOSITORY",
        "DATAFORM_SERVICE_ACCOUNT",
        "RAW_DATASET",
        "POLICY_TAG_RUT",
    }
    assert user == declared


def test_estado_del_dia_desde_raw_corridas():
    """REQ-007 E6 / DEC-012: right after the Mercado Público job, the Workflow reads the last run row by run_id."""
    doc = load()
    found = names(doc)
    assert found.index("ingesta_mercadopublico") < found.index("estado_ingesta_mp") < found.index("ingesta_indicadores")
    s = step(doc, "estado_ingesta_mp")
    assert s["call"] == "googleapis.bigquery.v2.jobs.query"
    query = s["args"]["body"]["query"]
    assert ".corridas`" in query and "raw_dataset" in query
    assert "fuente = 'mercadopublico'" in query and "ORDER BY run_id DESC LIMIT 1" in query
    assert s["args"]["body"]["useLegacySql"] is False


def test_dia_parcial_se_registra_como_warning_y_se_devuelve():
    """E6: a PARCIAL day logs a WARNING with 'ingesta parcial' (the alert filter) and the execution returns estado_dia."""
    doc = load()
    aviso = step(doc, "avisar_parcial")["switch"]
    [parcial] = [c for c in aviso if 'estado_dia == "PARCIAL"' in c["condition"]]
    [log_step] = parcial["steps"]
    body = next(iter(log_step.values()))
    assert body["call"] == "sys.log"
    assert body["args"]["severity"] == "WARNING"
    assert "ingesta parcial" in body["args"]["text"]
    assert step(doc, "fin")["return"]["estado_dia"] == "${estado_dia}"
    # Reading the state never swallows a job failure: the lookup is a plain step, outside any try.
    assert not has_key(doc, "try")


def test_sin_fila_en_corridas_no_es_parcial():
    """A missing row (first run ever, or the record not written) is SIN_REGISTRO, not PARCIAL and not OK."""
    doc = load()
    lectura = step(doc, "leer_estado_mp")["switch"]
    [vacio] = [c for c in lectura if "== 0" in str(c["condition"])]
    assert "SIN_REGISTRO" in str(vacio["steps"])
    [resto] = [c for c in lectura if c["condition"] == "${true}"]
    assert "rows[0].f[0].v" in str(resto["steps"])
