"""Billing kill switch (DEC-003, REQ-003): unlinks the project's billing account once the budget is reached.

Triggered by the budget's Pub/Sub topic. Uses the Cloud Billing REST API through httpx; the token comes straight from
the metadata server, because google.auth.default() and google.auth.compute_engine import requests (not a dependency).
"""

import base64
import binascii
import json
import os
import sys
from datetime import timedelta

import functions_framework
import google.auth.credentials
import google.auth.exceptions
import google.auth.transport
import httpx
from google.auth import _helpers

BILLING_API = "https://cloudbilling.googleapis.com/v1"
METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
HTTP_TIMEOUT_S = 10.0


def log(severity: str, message: str, **fields) -> None:
    """Writes one JSON line to stdout: Cloud Logging stores it as a structured entry."""
    print(json.dumps({"severity": severity, "message": message, **fields}), file=sys.stdout, flush=True)


class HttpxResponse(google.auth.transport.Response):
    def __init__(self, response: httpx.Response):
        self._response = response

    @property
    def status(self):
        return self._response.status_code

    @property
    def headers(self):
        return dict(self._response.headers)

    @property
    def data(self):
        return self._response.content


class HttpxRequest(google.auth.transport.Request):
    """google-auth transport over an httpx.Client."""

    def __init__(self, http: httpx.Client):
        self._http = http

    def __call__(self, url, method="GET", body=None, headers=None, timeout=None, **kwargs):
        try:
            response = self._http.request(method, url, content=body, headers=headers, timeout=timeout or HTTP_TIMEOUT_S)
        except httpx.HTTPError as exc:
            raise google.auth.exceptions.TransportError(exc) from exc
        return HttpxResponse(response)


class MetadataCredentials(google.auth.credentials.Credentials):
    """Access token of the function's service account, read from the metadata server."""

    def refresh(self, request):
        response = request(url=METADATA_TOKEN_URL, method="GET", headers={"Metadata-Flavor": "Google"})
        if response.status != 200:
            raise google.auth.exceptions.RefreshError(f"metadata server returned {response.status}")
        payload = json.loads(response.data)
        self.token = payload["access_token"]
        self.expiry = _helpers.utcnow() + timedelta(seconds=payload["expires_in"])


class BillingClient:
    def __init__(self, credentials: google.auth.credentials.Credentials, http: httpx.Client):
        self._credentials = credentials
        self._http = http

    def _headers(self) -> dict:
        if not self._credentials.valid:
            self._credentials.refresh(HttpxRequest(self._http))
        headers: dict = {}
        self._credentials.apply(headers)
        return headers

    def billing_enabled(self, project_id: str) -> bool:
        response = self._http.get(f"{BILLING_API}/projects/{project_id}/billingInfo", headers=self._headers())
        response.raise_for_status()
        return bool(response.json().get("billingEnabled", False))

    def unlink(self, project_id: str) -> None:
        response = self._http.put(
            f"{BILLING_API}/projects/{project_id}/billingInfo",
            json={"billingAccountName": ""},
            headers=self._headers(),
        )
        response.raise_for_status()


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def parse_budget(data: bytes) -> tuple[float, float] | None:
    """(costAmount, budgetAmount) of a budget notification, or None when it is malformed."""
    try:
        message = json.loads(data)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(message, dict):
        return None
    cost, budget = message.get("costAmount"), message.get("budgetAmount")
    if not _is_number(cost) or not _is_number(budget):
        return None
    return float(cost), float(budget)


def handle(data: bytes, client, project_id: str) -> str:
    """Decides on one budget notification; every exit logs its `decision`, which it returns."""
    parsed = parse_budget(data)
    if parsed is None:
        log("ERROR", "malformed budget notification, billing left untouched", decision="malformed")
        return "malformed"
    cost, budget = parsed
    if cost < budget:
        log("INFO", "cost under budget", decision="under_budget", cost=cost, budget=budget)
        return "under_budget"
    if not client.billing_enabled(project_id):
        log("INFO", "billing already unlinked", decision="already_unlinked", cost=cost, budget=budget)
        return "already_unlinked"
    client.unlink(project_id)
    log("WARNING", "budget reached, billing unlinked", decision="unlinked", cost=cost, budget=budget)
    return "unlinked"


@functions_framework.cloud_event
def stop_billing(cloud_event):
    try:
        data = base64.b64decode(cloud_event.data["message"]["data"], validate=True)
    except (KeyError, TypeError, binascii.Error) as exc:
        log("ERROR", f"unreadable Pub/Sub message: {exc!r}", decision="malformed")
        return
    project_id = os.environ.get("KILLSWITCH_PROJECT_ID")
    if not project_id:
        log("ERROR", "KILLSWITCH_PROJECT_ID is not set")
        raise RuntimeError("KILLSWITCH_PROJECT_ID is not set")
    with httpx.Client(timeout=HTTP_TIMEOUT_S) as http:
        handle(data, BillingClient(MetadataCredentials(), http), project_id)
