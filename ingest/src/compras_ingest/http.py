"""HTTP GET with exponential backoff, Retry-After and a request budget (REQ-004)."""

import json
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any

import httpx

from .budget import RequestBudget
from .redact import redact


@dataclass
class Fetched:
    status: int | None
    url: str
    payload: Any = None
    body: str | None = None
    error: str | None = None
    attempts: int = 0


def _retry_after(response: httpx.Response) -> float | None:
    value = response.headers.get("Retry-After")
    if value is None:
        return None
    value = value.strip()
    if value.isdigit():
        return float(value)
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return max(0.0, (when - datetime.now(UTC)).total_seconds())


def _retryable(status: int) -> bool:
    return status == 429 or status >= 500


def fetch(
    client: httpx.Client,
    url: str,
    params: dict,
    *,
    budget: RequestBudget,
    sleep: Callable[[float], None],
    secrets: Iterable[str],
    max_retries: int = 3,
    base_delay: float = 1.0,
) -> Fetched:
    secrets = list(secrets)
    max_attempts = 1 + max_retries
    attempt = 0
    while True:
        attempt += 1
        budget.take()
        try:
            response = client.get(url, params=params)
        except httpx.TransportError as exc:
            # Timeouts, refused or dropped connections (mindicador.cl closes the TLS handshake at times): retry with
            # the same backoff; after the last attempt the caller sees no status and the reason.
            if attempt < max_attempts:
                sleep(base_delay * 2 ** (attempt - 1))
                continue
            reason = "timeout" if isinstance(exc, httpx.TimeoutException) else f"sin respuesta: {type(exc).__name__}"
            return Fetched(status=None, url=redact(str(exc.request.url), secrets), error=reason, attempts=attempt)

        status = response.status_code
        if _retryable(status) and attempt < max_attempts:
            delay = _retry_after(response)
            sleep(base_delay * 2 ** (attempt - 1) if delay is None else delay)
            continue

        fetched = Fetched(status=status, url=redact(str(response.request.url), secrets), attempts=attempt)
        try:
            # response.text honors the charset of Content-Type (the BDE answers ISO-8859-1); response.json() would
            # decode the raw bytes as UTF-8 and fail on any accented character.
            fetched.payload = json.loads(response.text)
        except ValueError:
            fetched.body = redact(response.text, secrets)
            if 200 <= status < 300:
                fetched.error = "respuesta no JSON"
        if _retryable(status):
            fetched.error = f"HTTP {status} tras {attempt} intentos"
        elif not 200 <= status < 300:
            fetched.error = f"HTTP {status}"
        return fetched


def new_client() -> httpx.Client:
    return httpx.Client(timeout=httpx.Timeout(30.0), headers={"Accept": "application/json"})
