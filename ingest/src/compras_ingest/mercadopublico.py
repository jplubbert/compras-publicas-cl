"""Mercado Público API client: daily listings and per-code details (endpoints confirmed by T-02)."""

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
    def __init__(self, client: httpx.Client, ticket: str, budget: RequestBudget, sleep: Callable[[float], None]):
        self.client = client
        self.ticket = ticket
        self.budget = budget
        self.sleep = sleep

    def _get(self, entidad: str, params: dict) -> Fetched:
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
