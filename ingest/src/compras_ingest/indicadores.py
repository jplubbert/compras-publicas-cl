"""Daily indicators run: BDE series for D-10..D and mindicador.cl UF and dollar of D into bronze (REQ-005)."""

import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from .bcentral import SERIES, VENTANA_DIAS, BancoCentral, TokenRechazado, fallo, rechazo
from .bronze import BronzeWriter, GcsStore, new_run_id, record
from .budget import BudgetExhausted, RequestBudget
from .mindicador import INDICADORES, Mindicador, respondio

log = logging.getLogger("compras_ingest.indicadores")


@dataclass
class IndicadoresResult:
    run_id: str
    fecha: str
    series: list[str] = field(default_factory=list)
    fallidas: list[str] = field(default_factory=list)
    mindicador: list[str] = field(default_factory=list)
    ausentes: list[str] = field(default_factory=list)
    requests: int = 0
    objetos: list[str] = field(default_factory=list)
    exit_code: int = 0


def run_indicadores(
    fecha: date,
    *,
    bde: BancoCentral,
    mind: Mindicador,
    store: GcsStore,
    budget: RequestBudget,
    now: Callable[[], datetime],
    secrets: Iterable[str],
) -> IndicadoresResult:
    secrets = list(secrets)
    run_id = new_run_id(now())
    result = IndicadoresResult(run_id=run_id, fecha=fecha.isoformat())
    bde_writer = BronzeWriter(store, run_id, fuente="bcentral", secrets=secrets)
    mind_writer = BronzeWriter(store, run_id, fuente="mindicador", secrets=secrets)

    def finish(exit_code: int, *writers: BronzeWriter) -> IndicadoresResult:
        for writer in writers:
            writer.flush()
        result.requests = budget.used
        result.objetos = bde_writer.paths + mind_writer.paths
        result.exit_code = exit_code
        return result

    try:
        desde = fecha - timedelta(days=VENTANA_DIAS)
        for nombre, codigo in SERIES.items():
            fetched = bde.get_series(codigo, desde, fecha)
            rec = record(
                fetched, run_id=run_id, fecha=fecha, entidad=nombre, tipo="GetSeries", codigo=codigo, now=now()
            )
            bde_writer.add(nombre, fecha, rec)
            motivo = rechazo(fetched)
            if motivo is not None:
                raise TokenRechazado(f"la BDE rechazó el pedido de {nombre} ({codigo}): {motivo}")
            motivo = fallo(fetched)
            if motivo is not None:
                log.error("la serie %s (%s) falló: %s", nombre, codigo, motivo)
                result.fallidas.append(nombre)
            else:
                result.series.append(nombre)

        for nombre in INDICADORES:
            fetched = mind.indicador(nombre, fecha)
            if respondio(fetched):
                rec = record(
                    fetched, run_id=run_id, fecha=fecha, entidad=nombre, tipo="indicador", codigo=None, now=now()
                )
                mind_writer.add(nombre, fecha, rec)
                result.mindicador.append(nombre)
            else:
                log.warning(
                    "mindicador no respondió para %s del %s (%s); se omite",
                    nombre,
                    fecha.isoformat(),
                    fetched.error or f"HTTP {fetched.status}",
                )
                result.ausentes.append(nombre)
    except TokenRechazado as exc:
        log.error("token de la BDE rechazado: %s", exc)
        return finish(1, bde_writer)
    except BudgetExhausted:
        log.error("presupuesto de %d requests alcanzado", budget.limit)
        return finish(1, bde_writer, mind_writer)

    return finish(1 if result.fallidas else 0, bde_writer, mind_writer)
