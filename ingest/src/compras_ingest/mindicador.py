"""mindicador.cl client: UF and dollar of one day (endpoint from T-02); a secondary source without SLA."""

from collections.abc import Callable, Iterable
from datetime import date

import httpx

from .budget import RequestBudget
from .http import Fetched, fetch

BASE_URL = "https://mindicador.cl/api/"
INDICADORES = ("uf", "dolar")


class Mindicador:
    def __init__(
        self,
        client: httpx.Client,
        budget: RequestBudget,
        sleep: Callable[[float], None],
        secrets: Iterable[str] = (),
    ):
        self.client = client
        self.budget = budget
        self.sleep = sleep
        self.secrets = list(secrets)

    def indicador(self, nombre: str, fecha: date) -> Fetched:
        return fetch(
            self.client,
            BASE_URL + f"{nombre}/{fecha.strftime('%d-%m-%Y')}",
            {},
            budget=self.budget,
            sleep=self.sleep,
            secrets=self.secrets,
        )


def respondio(fetched: Fetched) -> bool:
    """True for a 2xx JSON object; a day without data (`serie: []`) counts as an answer."""
    return fetched.status is not None and 200 <= fetched.status < 300 and isinstance(fetched.payload, dict)
