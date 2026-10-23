"""Static checks of the GitHub Actions workflows (REQ-002, DEC-004): no network, no credentials (DEC-005)."""

import os
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[3]
WORKFLOWS = ROOT / ".github" / "workflows"
# Literals are built by concatenation so that this file does not match check-repo.mjs.
FORBIDDEN = ["credentials" + "_json", "service_account" + "_key"]
AUTH = "google-github-actions/auth@"
FORK_GUARD = "github.event.pull_request.head.repo.full_name == github.repository"
CHECKS = [
    "npm run lint",
    "npm test",
    "npm run check:repo",
    "npm run check:spec",
    "npm run check:descriptions",
    "dataform compile",
]
# Steps that only ci.yml runs for now: T-09 added them and deploy.yml was outside its touches.
CI_ONLY = ["scripts/env.sh npm run check:descriptions"]


def load(name):
    return yaml.safe_load((WORKFLOWS / name).read_text())


def triggers(doc):
    # PyYAML (YAML 1.1) reads the key `on` as the boolean True.
    return doc.get("on", doc.get(True))


def needs(job):
    n = job.get("needs", [])
    return [n] if isinstance(n, str) else n


def runs(job):
    return [s["run"] for s in job["steps"] if "run" in s]


def auth_steps(job):
    return [s for s in job.get("steps", []) if s.get("uses", "").startswith(AUTH)]


def id_token_violations(doc):
    problems = []
    if "id-token" in (doc.get("permissions") or {}):
        problems.append("id-token at workflow level")
    for name, job in (doc.get("jobs") or {}).items():
        has_token = (job.get("permissions") or {}).get("id-token") == "write"
        has_auth = bool(auth_steps(job))
        if has_token and not has_auth:
            problems.append(f"{name}: id-token: write without {AUTH}")
        if has_auth and not has_token:
            problems.append(f"{name}: {AUTH} without id-token: write")
    return problems


def all_workflows():
    return sorted(WORKFLOWS.glob("*.yml"))


def test_e1_ci_runs_on_pull_requests_to_main_with_checks_and_wif_plan():
    doc = load("ci.yml")
    assert triggers(doc)["pull_request"]["branches"] == ["main"]
    jobs = doc["jobs"]
    assert {"checks", "plan"} <= set(jobs)
    assert "checks" in needs(jobs["plan"])
    auth = auth_steps(jobs["plan"])
    assert auth and auth[0]["with"]["workload_identity_provider"]


def test_ci_checks_run_every_local_check_with_full_history():
    checks = load("ci.yml")["jobs"]["checks"]
    text = "\n".join(runs(checks))
    for command in CHECKS:
        assert command in text, command
    checkout = [s for s in checks["steps"] if s.get("uses", "").startswith("actions/checkout@")]
    assert checkout[0]["with"]["fetch-depth"] == 0


def test_ci_plan_runs_terraform_plan_and_comments_the_pr():
    plan = load("ci.yml")["jobs"]["plan"]
    text = "\n".join(runs(plan))
    assert "scripts/it/tf-plan.sh main" in text
    assert "scripts/ci/plan-comment.sh" in text
    assert "gh pr comment" in text
    assert plan["permissions"]["pull-requests"] == "write"


def test_e2_deploy_applies_on_push_to_main_in_production_with_wif():
    doc = load("deploy.yml")
    assert triggers(doc)["push"]["branches"] == ["main"]
    apply = doc["jobs"]["apply"]
    env = apply["environment"]
    assert (env if isinstance(env, str) else env["name"]) == "production"
    assert "checks" in needs(apply)
    auth = auth_steps(apply)
    assert auth and auth[0]["with"]["workload_identity_provider"]
    assert "scripts/it/tf-apply.sh" in "\n".join(runs(apply))


def test_e3_deploy_backs_up_state_after_apply():
    apply = load("deploy.yml")["jobs"]["apply"]
    steps = apply["steps"]

    def index(predicate):
        return next(i for i, s in enumerate(steps) if predicate(s))

    applied = index(lambda s: "scripts/it/tf-apply.sh" in s.get("run", ""))
    backup = index(lambda s: "state pull" in s.get("run", ""))
    assert applied < backup
    step = steps[backup]
    text = step["run"]
    for literal in ["upload/storage/v1", "uploadType=media", "ifGenerationMatch=0", "${{ github.sha }}"]:
        assert literal in text, literal
    assert "infra-main%2F" in text or "/infra-main/" in text
    assert "gcloud storage" not in text and "gsutil" not in text
    assert "if" not in step and "continue-on-error" not in step
    auth = index(lambda s: s.get("uses", "").startswith(AUTH))
    setup = index(lambda s: s.get("uses", "").startswith("google-github-actions/setup-gcloud@"))
    assert auth < setup < backup
    assert apply["env"]["STATE_BACKUP_BUCKET"] == "${{ vars.STATE_BACKUP_BUCKET }}"


def test_deploy_checks_match_ci_checks():
    ci = [r for r in runs(load("ci.yml")["jobs"]["checks"]) if r not in CI_ONLY]
    assert runs(load("deploy.yml")["jobs"]["checks"]) == ci


@pytest.mark.parametrize("path", all_workflows(), ids=lambda p: p.name)
def test_e3_no_keys_and_id_token_only_with_auth(path):
    text = path.read_text()
    for literal in FORBIDDEN:
        assert literal not in text, literal
    assert id_token_violations(yaml.safe_load(text)) == []


def test_e4_plan_skips_pull_requests_from_forks():
    assert FORK_GUARD in load("ci.yml")["jobs"]["plan"]["if"]


@pytest.mark.parametrize("path", all_workflows(), ids=lambda p: p.name)
def test_no_pull_request_target_nor_continue_on_error(path):
    doc = yaml.safe_load(path.read_text())
    assert "pull_request_target" not in triggers(doc)
    for job in doc["jobs"].values():
        for step in job.get("steps", []):
            assert step.get("continue-on-error") is not True


def test_id_token_violations_flags_workflow_level_token():
    doc = {"permissions": {"id-token": "write"}, "jobs": {}}
    assert len(id_token_violations(doc)) == 1


def test_id_token_violations_flags_job_token_without_auth():
    doc = {"jobs": {"x": {"permissions": {"id-token": "write"}, "steps": [{"run": "true"}]}}}
    assert len(id_token_violations(doc)) == 1


DATAFORM_CI = ROOT / "scripts" / "ci" / "dataform-ci.sh"


def test_e5_release_publishes_the_image_updates_the_jobs_and_runs_dataform_in_ci():
    release = load("deploy.yml")["jobs"]["release"]
    assert "apply" in needs(release)
    assert release["permissions"]["id-token"] == "write"
    auth = auth_steps(release)
    assert auth and auth[0]["with"]["workload_identity_provider"]
    assert release["env"]["IMAGE"].endswith("/compras/ingest:${{ github.sha }}")
    text = "\n".join(runs(release))
    for literal in [
        'docker build -f ingest/Dockerfile -t "$IMAGE"',
        'docker push "$IMAGE"',
        'gcloud run jobs update compras-mercadopublico --image="$IMAGE"',
        'gcloud run jobs update compras-indicadores --image="$IMAGE"',
        "scripts/ci/dataform-ci.sh",
    ]:
        assert literal in text, literal
    steps = release["steps"]
    order = [
        next(i for i, s in enumerate(steps) if literal in s.get("run", ""))
        for literal in ["docker push", "jobs update", "dataform-ci.sh"]
    ]
    assert order == sorted(order)
    [df] = [s for s in steps if "dataform-ci.sh" in s.get("run", "")]
    assert "--schema-suffix=ci" in df["name"] and "--vars=raw_dataset=raw_ci" in df["name"]


def test_e5_dataform_ci_runs_every_action_in_ci_reading_raw_ci():
    text = DATAFORM_CI.read_text()
    assert "dataform run" in text
    assert "--schema-suffix=ci" in text and "--vars=raw_dataset=raw_ci" in text
    assert "--tags" not in text and "--disable-assertions" not in text


POLICY_TAG_VARS = "--vars=policy_tag_rut=projects/p/locations/us-central1/taxonomies/1/policyTags/2"


@pytest.mark.parametrize("name", ["ci.yml", "deploy.yml"])
def test_req014_dataform_compile_passes_policy_tag_rut(name):
    [compile_run] = [r for r in runs(load(name)["jobs"]["checks"]) if "dataform compile" in r]
    assert POLICY_TAG_VARS in compile_run


def test_req014_dataform_ci_requires_and_passes_policy_tag_rut():
    text = DATAFORM_CI.read_text()
    assert "policy_tag_rut=$POLICY_TAG_RUT" in text
    [loop] = [line for line in text.splitlines() if line.startswith("for v in")]
    assert "POLICY_TAG_RUT" in loop
    env = {k: v for k, v in os.environ.items() if k != "POLICY_TAG_RUT"}
    env.update(GCP_PROJECT_ID="p", GCP_REGION="us-central1")
    result = subprocess.run(["bash", str(DATAFORM_CI)], env=env, capture_output=True, text=True, check=False)
    assert result.returncode == 1
    assert "POLICY_TAG_RUT" in result.stderr


def test_req014_e8_dataform_ci_uses_its_own_salt():
    text = DATAFORM_CI.read_text()
    [run] = [line for line in text.replace("\\\n", " ").splitlines() if "dataform run" in line]
    assert '"--vars=raw_dataset=raw_ci,sal_dataset=pii_ci,policy_tag_rut=$POLICY_TAG_RUT"' in run
    assert "sal_dataset=pii," not in text and 'sal_dataset=pii"' not in text


def test_req014_plan_gets_the_same_pii_lists_as_apply():
    plan = load("ci.yml")["jobs"]["plan"]["env"]
    apply = load("deploy.yml")["jobs"]["apply"]["env"]
    for var in ["TF_VAR_pii_readers", "TF_VAR_lector_impersonators"]:
        assert plan[var] == apply[var], var
