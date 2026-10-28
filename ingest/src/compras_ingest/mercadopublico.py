"""Mercado Público API client: daily listings and per-code details (endpoints confirmed by T-02)."""

import time
from collections.abc import Callable
from datetime import date
from typing import Any

import httpx

from .budget import RequestBudget
from .http import Fetched, fetch

BASE_URL = "https://api.mercadopublico.cl/servicios/v1/publico/"
ENTIDADES = ("licitaciones", "ordenes_compra")
ENDPOINT = {"licitaciones": "licitaciones.json", "ordenes_compra": "ordenesdecompra.json"}


class ListadoInvalido(Exception):
    pass


class AuthError(Exception):
    pass


class MercadoPublico:
    """Client of the API. `interval` is the minimum spacing, in seconds, between the starts of two requests (S-28):
    the API fails fast on back-to-back calls (the run of 2026-10-28 spent ~4.300 of 9.000 requests on retries that
    succeeded after a 1-3 s pause), so the client paces itself instead of paying the retries from the budget."""

    def __init__(
        self,
        client: httpx.Client,
        ticket: str,
        budget: RequestBudget,
        sleep: Callable[[float], None],
        interval: float = 0.0,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.client = client
        self.ticket = ticket
        self.budget = budget
        self.sleep = sleep
        self.interval = interval
        self.clock = clock
        self._last_start: float | None = None

    def _pace(self) -> None:
        if self.interval > 0 and self._last_start is not None:
            wait = self.interval - (self.clock() - self._last_start)
            if wait > 0:
                self.sleep(wait)
        self._last_start = self.clock()

    def _get(self, entidad: str, params: dict) -> Fetched:
        self._pace()
        return fetch(
            self.client,
            BASE_URL + ENDPOINT[entidad],
            {**params, "ticket": self.ticket},
            budget=self.budget,
            sleep=self.sleep,
            secrets=[self.ticket],
        )

    def listado(self, entidad: str, fecha: date) -> Fetched:
        return self._get(entidad, {"fecha": fecha.strftime("%d%m%Y")})

    def detalle(self, entidad: str, codigo: str) -> Fetched:
        return self._get(entidad, {"codigo": codigo})


def codigos(entidad: str, payload: Any) -> list[str]:
    if not isinstance(payload, dict) or not isinstance(payload.get("Listado"), list):
        raise ListadoInvalido(f"listado de {entidad} sin lista 'Listado'")
    keys = ("CodigoExterno", "Codigo") if entidad == "licitaciones" else ("Codigo",)
    seen: dict[str, None] = {}
    for item in payload["Listado"]:
        if not isinstance(item, dict):
            raise ListadoInvalido(f"elemento del listado de {entidad} no es un objeto")
        codigo = next((item[k] for k in keys if item.get(k)), None)
        if codigo is None:
            raise ListadoInvalido(f"elemento del listado de {entidad} sin código")
        seen.setdefault(str(codigo), None)
    return list(seen)
