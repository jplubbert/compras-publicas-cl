"""Offline checks of scripts/it/run-workflow.sh (REQ-007, DEC-005): gcloud and curl replaced by fakes."""

import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "it" / "run-workflow.sh"
BASH = shutil.which("bash")
PYTHON_DIR = Path(shutil.which("python3")).parent
EXECUTION = "projects/demo-proj/locations/us-central1/workflows/compras-diario/executions/abc"

FAKE_GCLOUD = """#!/bin/bash
echo "$@" >> "$FAKE_LOG"
case "$*" in
  "workflows execute"*) echo "$FAKE_EXECUTION" ;;
  *"value(state)"*)
    n=$(cat "$FAKE_COUNTER" 2>/dev/null || echo 0)
    read -r -a states <<< "$FAKE_STATES"
    i=$(( n < ${#states[@]} ? n : ${#states[@]} - 1 ))
    echo "${states[$i]}"
    echo $((n + 1)) > "$FAKE_COUNTER" ;;
  *"value(error.context)"*) echo "$FAKE_CONTEXT" ;;
  "auth print-access-token"*) echo fake-token ;;
esac
"""
FAKE_CURL = '#!/bin/bash\necho "$@" >> "$FAKE_LOG"\nprintf "%s" "$FAKE_INVOCATIONS"\n'


def run(tmp_path, args=(), states="SUCCEEDED", context="", invocations="{}", project="demo-proj"):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in [("gcloud", FAKE_GCLOUD), ("curl", FAKE_CURL)]:
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(0o755)
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{PYTHON_DIR}:/usr/bin:/bin",
        "GCP_REGION": "us-central1",
        "IT_POLL": "0",
        "FAKE_LOG": str(tmp_path / "calls.log"),
        "FAKE_COUNTER": str(tmp_path / "counter"),
        "FAKE_EXECUTION": EXECUTION,
        "FAKE_STATES": states,
        "FAKE_CONTEXT": context,
        "FAKE_INVOCATIONS": invocations,
    }
    env.pop("GOOGLE_CLOUD_PROJECT", None)
    if project:
        env["GOOGLE_CLOUD_PROJECT"] = project
    r = subprocess.run([BASH, str(SCRIPT), *args], check=False, capture_output=True, text=True, env=env)
    return r.returncode, r.stdout + r.stderr


def test_argumento_desconocido_sale_con_2(tmp_path):
    code, _ = run(tmp_path, ["--otro"])
    assert code == 2


def test_sin_proyecto_sale_con_1(tmp_path):
    code, out = run(tmp_path, project="")
    assert code == 1
    assert "GOOGLE_CLOUD_PROJECT" in out


def test_espera_hasta_succeeded(tmp_path):
    code, out = run(tmp_path, states="ACTIVE ACTIVE SUCCEEDED")
    assert code == 0, out
    assert f"run-workflow: ok execution={EXECUTION}" in out
    assert "fake-token" not in out


def test_failed_sin_expect_failure_sale_con_1(tmp_path):
    code, out = run(tmp_path, states="ACTIVE FAILED")
    assert code == 1
    assert "FAILED" in out


def test_expect_failure_en_ingesta_sin_invocaciones(tmp_path):
    code, out = run(
        tmp_path,
        ["--expect-failure"],
        states="FAILED",
        context="in step ingesta_mercadopublico: job failed",
        invocations='{"workflowInvocations": [{"createTime": "2000-01-01T00:00:00Z"}]}',
    )
    assert code == 0, out
    assert "fake-token" not in out


def test_expect_failure_con_invocacion_posterior_sale_con_1(tmp_path):
    code, out = run(
        tmp_path,
        ["--expect-failure"],
        states="FAILED",
        context="in step ingesta_mercadopublico: job failed",
        invocations='{"workflowInvocations": [{"createTime": "2999-01-01T00:00:00.5Z"}]}',
    )
    assert code == 1
    assert "Dataform invocation" in out
