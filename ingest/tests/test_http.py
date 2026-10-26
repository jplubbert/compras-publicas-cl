"""REQ-004: retries with exponential backoff, Retry-After and the request budget."""

from datetime import UTC, datetime, timedelta
from email.utils import format_datetime

import httpx
import pytest
import respx

from compras_ingest.budget import BudgetExhausted, RequestBudget
from compras_ingest.http import fetch

URL = "https://api.example.test/x.json"
SECRET = "TK-PRUEBA-9f3a71"


def _fetch(budget=None, sleeps=None):
    sleeps = [] if sleeps is None else sleeps
    with httpx.Client() as client:
        return fetch(
            client,
            URL,
            {"codigo": "C1", "ticket": SECRET},
            budget=budget or RequestBudget(100),
            sleep=sleeps.append,
            secrets=[SECRET],
        )


@respx.mock
def test_backoff_is_1_2_4_seconds_without_retry_after():
    route = respx.get(URL).mock(return_value=httpx.Response(502))
    sleeps = []
    fetched = _fetch(sleeps=sleeps)
    assert route.call_count == 4
    assert sleeps == [1.0, 2.0, 4.0]
    assert fetched.status == 502
    assert fetched.attempts == 4
    assert fetched.error == "HTTP 502 tras 4 intentos"
    assert "ticket=***" in fetched.url
    assert SECRET not in fetched.url


@respx.mock
def test_permanent_timeout_gives_4_attempts_and_no_status():
    route = respx.get(URL).mock(side_effect=httpx.ReadTimeout)
    budget = RequestBudget(100)
    fetched = _fetch(budget=budget)
    assert route.call_count == 4
    assert budget.used == 4
    assert fetched.status is None
    assert fetched.error == "timeout"
    assert SECRET not in fetched.url


@respx.mock
def test_dropped_connection_retries_like_a_timeout_and_names_the_cause():
    route = respx.get(URL).mock(side_effect=httpx.RemoteProtocolError)
    sleeps = []
    fetched = _fetch(sleeps=sleeps)
    assert route.call_count == 4
    assert sleeps == [1.0, 2.0, 4.0]
    assert fetched.status is None
    assert fetched.error == "sin respuesta: RemoteProtocolError"
    assert SECRET not in fetched.url


@respx.mock
def test_retry_after_as_http_date():
    when = datetime.now(UTC) + timedelta(seconds=30)
    respx.get(URL).mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": format_datetime(when, usegmt=True)}),
            httpx.Response(200, json={"Listado": []}),
        ]
    )
    sleeps = []
    fetched = _fetch(sleeps=sleeps)
    assert fetched.status == 200
    assert len(sleeps) == 1
    assert 25 <= sleeps[0] <= 30


@respx.mock
def test_retry_after_in_the_past_waits_zero():
    when = datetime.now(UTC) - timedelta(seconds=30)
    respx.get(URL).mock(
        side_effect=[
            httpx.Response(503, headers={"Retry-After": format_datetime(when, usegmt=True)}),
            httpx.Response(200, json={}),
        ]
    )
    sleeps = []
    _fetch(sleeps=sleeps)
    assert sleeps == [0.0]


@respx.mock
def test_unparseable_retry_after_falls_back_to_backoff():
    respx.get(URL).mock(
        side_effect=[httpx.Response(429, headers={"Retry-After": "pronto"}), httpx.Response(200, json={})]
    )
    sleeps = []
    _fetch(sleeps=sleeps)
    assert sleeps == [1.0]


@respx.mock
def test_budget_exhausted_before_the_first_attempt():
    route = respx.get(URL).mock(return_value=httpx.Response(200, json={}))
    with pytest.raises(BudgetExhausted):
        _fetch(budget=RequestBudget(0))
    assert route.call_count == 0


@respx.mock
def test_budget_exhausted_between_retries():
    route = respx.get(URL).mock(return_value=httpx.Response(500))
    budget = RequestBudget(2)
    with pytest.raises(BudgetExhausted):
        _fetch(budget=budget)
    assert route.call_count == 2
    assert budget.remaining == 0


@respx.mock
def test_non_json_body_is_kept_redacted():
    respx.get(URL).mock(return_value=httpx.Response(200, text=f"<html>ticket={SECRET}</html>"))
    fetched = _fetch()
    assert fetched.payload is None
    assert fetched.error == "respuesta no JSON"
    assert SECRET not in fetched.body
    assert "ticket=***" in fetched.body


@respx.mock
def test_non_json_error_body_keeps_the_http_error():
    respx.get(URL).mock(return_value=httpx.Response(404, text="not found"))
    fetched = _fetch()
    assert fetched.status == 404
    assert fetched.error == "HTTP 404"
    assert fetched.body == "not found"
