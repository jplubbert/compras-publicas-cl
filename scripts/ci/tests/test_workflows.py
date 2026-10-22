"""Static checks of the GitHub Actions workflows (REQ-002, DEC-004): no network, no credentials (DEC-005)."""

from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[3]
WORKFLOWS = ROOT / ".github" / "workflows"
# Literals are built by concatenation so that this file does not match check-repo.mjs.
FORBIDDEN = ["credentials" + "_json", "service_account" + "_key"]
AUTH = "google-github-actions/auth@"
FORK_GUARD = "github.event.pull_request.head.repo.full_name == github.repository"
CHECKS = ["npm run lint", "npm test", "npm run check:repo", "npm run check:spec", "dataform compile"]


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


def test_deploy_checks_match_ci_checks():
    assert runs(load("deploy.yml")["jobs"]["checks"]) == runs(load("ci.yml")["jobs"]["checks"])


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
