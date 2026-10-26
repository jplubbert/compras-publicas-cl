"""Local checks of the CI scripts (REQ-002): no network, no credentials, gh replaced by a fake (DEC-005)."""

import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PLAN_COMMENT = ROOT / "scripts" / "ci" / "plan-comment.sh"
LAST_CI_RUN = ROOT / "scripts" / "it" / "last-ci-run.sh"
TF_APPLY = ROOT / "scripts" / "it" / "tf-apply.sh"
BASH = shutil.which("bash")
MARKER = "<!-- tf-plan:infra/main -->"
URL = "https://github.com/owner/repo/actions/runs/1"


def run(script, args=(), env=None):
    r = subprocess.run([BASH, str(script), *args], check=False, capture_output=True, text=True, env=env)
    return r.returncode, r.stdout, r.stderr


def plan_comment(tmp_path, text):
    plan = tmp_path / "plan.txt"
    plan.write_text(text)
    return run(PLAN_COMMENT, [str(plan)])


def test_plan_comment_with_changes(tmp_path):
    line = "Plan: 3 to add, 0 to change, 0 to destroy."
    code, out, err = plan_comment(tmp_path, f"Terraform will perform the following actions:\n\n{line}\n")
    assert code == 0, err
    assert out.startswith(MARKER)
    assert line in out


def test_plan_comment_without_changes(tmp_path):
    code, out, err = plan_comment(tmp_path, "No changes. Your infrastructure matches the configuration.\n")
    assert code == 0, err
    assert "No changes." in out


def test_plan_comment_with_output_changes_only(tmp_path):
    text = (
        "Changes to Outputs:\n  + orchestration = {\n      + retry_count = 0\n    }\n\n"
        "You can apply this plan to save these new output values to the Terraform\nstate, "
        "without changing any real infrastructure.\n"
    )
    code, out, err = plan_comment(tmp_path, text)
    assert code == 0, err
    assert "Sin cambios de recursos; solo cambian outputs." in out
    assert "Changes to Outputs:" in out


def test_plan_comment_without_summary_exits_1(tmp_path):
    code, _, err = plan_comment(tmp_path, "Error: something failed\n")
    assert code == 1
    assert "no plan summary found" in err


def test_plan_comment_without_argument_exits_2():
    code, _, _ = run(PLAN_COMMENT)
    assert code == 2


def test_plan_comment_truncates_long_output(tmp_path):
    text = ("x" * 99 + "\n") * 2000 + "Plan: 1 to add, 0 to change, 0 to destroy.\n"
    code, out, err = plan_comment(tmp_path, text)
    assert code == 0, err
    assert len(out) < 65536
    assert "(salida recortada)" in out


def fake_gh(tmp_path, output):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    gh = bin_dir / "gh"
    gh.write_text('#!/bin/bash\necho "$@" >> "$FAKE_GH_LOG"\nprintf "%s" "$FAKE_GH_OUT"\n')
    gh.chmod(0o755)
    log = tmp_path / "gh.log"
    env = {**os.environ, "PATH": f"{bin_dir}:/usr/bin:/bin", "FAKE_GH_OUT": output, "FAKE_GH_LOG": str(log)}
    code, out, err = run(LAST_CI_RUN, env=env)
    return code, out + err, log.read_text()


def test_last_ci_run_success(tmp_path):
    code, out, args = fake_gh(tmp_path, f"completed\tsuccess\t{URL}\tfeat")
    assert code == 0, out
    assert "last-ci-run: success feat" in out
    assert URL in out
    assert "run list" in args
    assert "--workflow ci.yml" in args
    assert "--event pull_request" in args


def test_last_ci_run_failure(tmp_path):
    code, out, _ = fake_gh(tmp_path, f"completed\tfailure\t{URL}\tfeat")
    assert code == 1
    assert "completed/failure" in out


def test_last_ci_run_in_progress(tmp_path):
    code, out, _ = fake_gh(tmp_path, f"in_progress\t\t{URL}\tfeat")
    assert code == 1
    assert f"in_progress/ {URL}" in out


def test_last_ci_run_without_runs(tmp_path):
    code, out, _ = fake_gh(tmp_path, "")
    assert code == 1
    assert "no ci.yml run" in out


def test_last_ci_run_without_gh_exits_2(tmp_path):
    bin_dir = tmp_path / "nogh"
    bin_dir.mkdir()
    (bin_dir / "bash").symlink_to(BASH)
    code, _, err = run(LAST_CI_RUN, env={"PATH": str(bin_dir)})
    assert code == 2
    assert "gh is required" in err


def clean_env(**extra):
    return {**{k: v for k, v in os.environ.items() if not k.startswith("TF_VAR_")}, **extra}


def test_tf_apply_names_missing_project_id():
    code, _, err = run(TF_APPLY, env=clean_env(TF_VAR_region="us-central1", TF_VAR_github_repository="owner/repo"))
    assert code == 1
    assert "TF_VAR_project_id" in err


def test_tf_apply_with_argument_exits_2():
    code, _, err = run(TF_APPLY, ["main"], env=clean_env())
    assert code == 2
    assert "usage" in err


ACTAS_ERROR = "Error: Error creating Job: googleapi: Error 403: Permission 'iam.serviceaccounts.actAs' denied"
FAKE_TERRAFORM = """#!/bin/bash
[ "$2" = init ] && exit 0
n=$(( $(cat "$FAKE_TF_COUNT" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$FAKE_TF_COUNT"
case "$FAKE_TF_MODE" in
  once) [ "$n" -ge 2 ] && { echo "Apply complete!"; exit 0; }; echo "$ACTAS_ERROR" >&2; exit 1 ;;
  always) echo "$ACTAS_ERROR" >&2; exit 1 ;;
  *) echo "Error: Error creating Bucket: googleapi: Error 409: already exists" >&2; exit 1 ;;
esac
"""


def tf_apply_with_fake(tmp_path, mode, **extra):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    tf = bin_dir / "terraform"
    tf.write_text(FAKE_TERRAFORM)
    tf.chmod(0o755)
    count = tmp_path / "count"
    env = clean_env(
        PATH=f"{bin_dir}:/usr/bin:/bin",
        COMPRAS_ENV="1",
        TF_PLUGIN_DIR=str(tmp_path),
        TF_APPLY_RETRY_WAIT="0",
        TF_VAR_project_id="demo-proj",
        TF_VAR_region="us-central1",
        TF_VAR_github_repository="owner/repo",
        FAKE_TF_MODE=mode,
        FAKE_TF_COUNT=str(count),
        ACTAS_ERROR=ACTAS_ERROR,
        **extra,
    )
    code, out, err = run(TF_APPLY, env=env)
    return code, int(count.read_text()), out + err


def test_tf_apply_retries_while_actas_propagates(tmp_path):
    code, applies, out = tf_apply_with_fake(tmp_path, "once")
    assert code == 0, out
    assert applies == 2
    assert "actAs not propagated yet, retry 2/5" in out


def test_tf_apply_does_not_retry_other_errors(tmp_path):
    code, applies, _ = tf_apply_with_fake(tmp_path, "other")
    assert code == 1
    assert applies == 1


def test_tf_apply_gives_up_after_the_attempts(tmp_path):
    code, applies, _ = tf_apply_with_fake(tmp_path, "always", TF_APPLY_ATTEMPTS="3")
    assert code == 1
    assert applies == 3


DATAFORM_CI = ROOT / "scripts" / "ci" / "dataform-ci.sh"
RUN_JOBS = ROOT / "scripts" / "it" / "run-jobs.sh"


def test_dataform_ci_names_the_missing_variable():
    env = {k: v for k, v in os.environ.items() if k not in ("GCP_PROJECT_ID", "GCP_REGION")}
    code, _, err = run(DATAFORM_CI, env={**env, "GCP_REGION": "us-central1"})
    assert code == 1
    assert "GCP_PROJECT_ID" in err
    code, _, err = run(DATAFORM_CI, env={**env, "GCP_PROJECT_ID": "demo-proj"})
    assert code == 1
    assert "GCP_REGION" in err


def test_dataform_ci_with_argument_exits_2():
    code, _, err = run(DATAFORM_CI, ["x"])
    assert code == 2
    assert "usage" in err


def test_run_jobs_without_a_valid_date_exits_2():
    for args in ([], ["2026-1-02"], ["ayer"]):
        code, _, err = run(RUN_JOBS, args)
        assert code == 2, args
        assert "usage" in err
