"""Offline tests of the billing kill switch (REQ-003 E1-E4, DEC-003, DEC-005)."""

import base64
import json
import subprocess
import sys
import tomllib
from pathlib import Path

import httpx
import main
import pytest
import respx
from cloudevents.http import CloudEvent

KILLSWITCH_DIR = Path(main.__file__).resolve().parent
BILLING_INFO_URL = "https://cloudbilling.googleapis.com/v1/projects/demo-proj/billingInfo"
TOKEN = "ya29.mock-token"


class FakeClient:
    def __init__(self, enabled: bool = True):
        self.enabled = enabled
        self.calls: list[tuple[str, str]] = []

    def billing_enabled(self, project_id: str) -> bool:
        self.calls.append(("billing_enabled", project_id))
        return self.enabled

    def unlink(self, project_id: str) -> None:
        self.calls.append(("unlink", project_id))


def log_lines(capsys) -> list[dict]:
    return [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.strip()]


def message(payload) -> bytes:
    return json.dumps(payload).encode()


@pytest.mark.parametrize("payload", [{"costAmount": 10.20, "budgetAmount": 10}, {"costAmount": 10, "budgetAmount": 10}])
def test_e1_unlinks_once_when_cost_reaches_budget(payload, capsys):
    client = FakeClient()
    assert main.handle(message(payload), client, "demo-proj") == "unlinked"
    assert [c for c in client.calls if c[0] == "unlink"] == [("unlink", "demo-proj")]
    assert log_lines(capsys)[-1]["decision"] == "unlinked"


def test_e2_does_nothing_under_budget(capsys):
    client = FakeClient()
    assert main.handle(message({"costAmount": 9.99, "budgetAmount": 10}), client, "demo-proj") == "under_budget"
    assert client.calls == []
    (line,) = log_lines(capsys)
    assert line["severity"] == "INFO"
    assert line["decision"] == "under_budget"


@pytest.mark.parametrize(
    "data",
    [
        message({"budgetAmount": 10}),
        b"{not json",
        message([10.2, 10]),
        message({"costAmount": "10", "budgetAmount": 10}),
        message({"costAmount": True, "budgetAmount": 10}),
    ],
    ids=["no-cost", "invalid-json", "json-list", "string-cost", "bool-cost"],
)
def test_e3_malformed_logs_error_and_calls_nothing(data, capsys):
    client = FakeClient()
    assert main.handle(data, client, "demo-proj") == "malformed"
    assert client.calls == []
    (line,) = log_lines(capsys)
    assert line["severity"] == "ERROR"
    assert line["decision"] == "malformed"


def test_e4_already_unlinked_is_a_no_op(capsys):
    client = FakeClient(enabled=False)
    assert main.handle(message({"costAmount": 10.20, "budgetAmount": 10}), client, "demo-proj") == "already_unlinked"
    assert ("unlink", "demo-proj") not in client.calls
    assert all(line["severity"] != "ERROR" for line in log_lines(capsys))


def mock_metadata(router: respx.MockRouter) -> respx.Route:
    return router.get(main.METADATA_TOKEN_URL).mock(
        return_value=httpx.Response(200, json={"access_token": TOKEN, "expires_in": 3599, "token_type": "Bearer"})
    )


def http_client() -> main.BillingClient:
    return main.BillingClient(main.MetadataCredentials(), httpx.Client())


@respx.mock(assert_all_called=False)
def test_http_unlink_puts_empty_billing_account(respx_mock):
    token = mock_metadata(respx_mock)
    respx_mock.get(BILLING_INFO_URL).mock(return_value=httpx.Response(200, json={"billingEnabled": True}))
    put = respx_mock.put(BILLING_INFO_URL).mock(return_value=httpx.Response(200, json={"billingEnabled": False}))

    result = main.handle(message({"costAmount": 10.20, "budgetAmount": 10}), http_client(), "demo-proj")

    assert result == "unlinked"
    assert put.call_count == 1
    request = put.calls.last.request
    assert json.loads(request.content) == {"billingAccountName": ""}
    assert request.headers["Authorization"] == f"Bearer {TOKEN}"
    assert token.calls.last.request.headers["Metadata-Flavor"] == "Google"


@respx.mock(assert_all_called=False)
def test_http_already_unlinked_does_not_put(respx_mock):
    mock_metadata(respx_mock)
    respx_mock.get(BILLING_INFO_URL).mock(return_value=httpx.Response(200, json={"billingEnabled": False}))
    put = respx_mock.put(BILLING_INFO_URL).mock(return_value=httpx.Response(200, json={}))

    result = main.handle(message({"costAmount": 10.20, "budgetAmount": 10}), http_client(), "demo-proj")

    assert result == "already_unlinked"
    assert put.call_count == 0


@respx.mock
def test_http_forbidden_unlink_raises(respx_mock):
    mock_metadata(respx_mock)
    respx_mock.get(BILLING_INFO_URL).mock(return_value=httpx.Response(200, json={"billingEnabled": True}))
    respx_mock.put(BILLING_INFO_URL).mock(return_value=httpx.Response(403, json={"error": {"code": 403}}))

    with pytest.raises(httpx.HTTPStatusError):
        main.handle(message({"costAmount": 10.20, "budgetAmount": 10}), http_client(), "demo-proj")


def cloud_event(data: dict) -> CloudEvent:
    attributes = {"type": "google.cloud.pubsub.topic.v1.messagePublished", "source": "//pubsub.googleapis.com/test"}
    return CloudEvent(attributes, data)


@pytest.fixture
def fake_client(monkeypatch) -> FakeClient:
    client = FakeClient()
    monkeypatch.setenv("KILLSWITCH_PROJECT_ID", "demo-proj")
    monkeypatch.setattr(main, "BillingClient", lambda credentials, http: client)
    return client


def test_entry_point_decodes_pubsub_message(fake_client):
    data = base64.b64encode(message({"costAmount": 10.20, "budgetAmount": 10})).decode()
    main.stop_billing(cloud_event({"message": {"data": data}}))
    assert ("unlink", "demo-proj") in fake_client.calls


@pytest.mark.parametrize(
    "data", [{"message": {"data": "%%not-base64%%"}}, {"subscription": "x"}], ids=["bad-b64", "no-msg"]
)
def test_entry_point_unreadable_message_logs_error(data, fake_client, capsys):
    main.stop_billing(cloud_event(data))
    assert fake_client.calls == []
    (line,) = log_lines(capsys)
    assert line["severity"] == "ERROR"


def test_entry_point_requires_project_id(monkeypatch, capsys):
    monkeypatch.delenv("KILLSWITCH_PROJECT_ID", raising=False)
    data = base64.b64encode(message({"costAmount": 10.20, "budgetAmount": 10})).decode()
    with pytest.raises(RuntimeError):
        main.stop_billing(cloud_event({"message": {"data": data}}))
    assert log_lines(capsys)[-1]["severity"] == "ERROR"


NO_REQUESTS_SCRIPT = """
import json, sys
sys.modules["requests"] = None
sys.path.insert(0, sys.argv[1])
import httpx, main

def respond(request):
    if request.url.host == "metadata.google.internal":
        return httpx.Response(200, json={"access_token": "t", "expires_in": 3599})
    if request.method == "GET":
        return httpx.Response(200, json={"billingEnabled": True})
    assert json.loads(request.content) == {"billingAccountName": ""}
    return httpx.Response(200, json={})

client = main.BillingClient(main.MetadataCredentials(), httpx.Client(transport=httpx.MockTransport(respond)))
assert main.handle(b'{"costAmount": 10.2, "budgetAmount": 10}', client, "demo-proj") == "unlinked"
"""


def test_runs_without_requests():
    result = subprocess.run(
        [sys.executable, "-I", "-c", NO_REQUESTS_SCRIPT, str(KILLSWITCH_DIR)],
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_requirements_match_pyproject():
    declared = tomllib.loads((KILLSWITCH_DIR / "pyproject.toml").read_text())["project"]["dependencies"]
    pinned = {
        line.split(";")[0].strip()
        for line in (KILLSWITCH_DIR / "requirements.txt").read_text().splitlines()
        if line and not line.startswith((" ", "#"))
    }
    assert set(declared) <= pinned
    assert not any(p.startswith("requests==") for p in pinned)
