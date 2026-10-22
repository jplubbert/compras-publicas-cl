"""Banco Central BDE client (SieteRestWS GetSeries; endpoint and response shape from T-02, series codes from S-08)."""

import json
from collections.abc import Callable
from datetime import date

import httpx

from .budget import RequestBudget
from .http import Fetched, fetch
from .redact import redact

BASE_URL = "https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx"
# Short name (bronze entity) -> BDE series code (S-08). The dict order is the request order.
SERIES = {"uf": "F073.UFF.PRE.Z.D", "dolar": "F073.TCO.PRE.Z.D", "ipc": "F074.IPC.VAR.Z.Z.C.M"}
VENTANA_DIAS = 10


class TokenRechazado(Exception):
    pass


class BancoCentral:
    def __init__(self, client: httpx.Client, token: str, budget: RequestBudget, sleep: Callable[[float], None]):
        self.client = client
        self.token = token
        self.budget = budget
        self.sleep = sleep

    def get_series(self, codigo: str, desde: date, hasta: date) -> Fetched:
        fetched = fetch(
            self.client,
            BASE_URL,
            {
                "token": self.token,
                "function": "GetSeries",
                "timeseries": codigo,
                "firstdate": desde.isoformat(),
                "lastdate": hasta.isoformat(),
            },
            budget=self.budget,
            sleep=self.sleep,
            secrets=[self.token],
        )
        # An error description may echo the token; the decoded payload goes to bronze as is otherwise.
        if fetched.payload is not None:
            text = json.dumps(fetched.payload, ensure_ascii=False)
            if self.token in text:
                fetched.payload = json.loads(redact(text, [self.token]))
        return fetched


def rechazo(fetched: Fetched) -> str | None:
    """Reason why the BDE rejected the request (token), or None."""
    if fetched.status in (401, 403):
        return f"HTTP {fetched.status}"
    if fetched.status == 200 and isinstance(fetched.payload, dict):
        codigo = fetched.payload.get("Codigo")
        if codigo is not None and codigo != 0:
            return f"Codigo {codigo}: {fetched.payload.get('Descripcion')}"
    return None


def fallo(fetched: Fetched) -> str | None:
    """Reason why a series response is unusable, or None."""
    if fetched.error is not None:
        return fetched.error
    if not isinstance(fetched.payload, dict) or "Series" not in fetched.payload:
        return "respuesta sin 'Series'"
    return None
