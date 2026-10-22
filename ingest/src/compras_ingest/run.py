"""Daily Mercado Público run: listings, then details, with cursor and request budget (REQ-004)."""

import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import date, datetime

from . import cursor as cursor_mod
from .bronze import BronzeWriter, GcsStore, new_run_id, record, utc_iso
from .budget import BudgetExhausted, RequestBudget
from .cursor import Cursor, pending_days
from .mercadopublico import ENTIDADES, AuthError, ListadoInvalido, MercadoPublico, codigos

log = logging.getLogger("compras_ingest.mercadopublico")

# A rejected ticket would fail every detail and burn the budget; a 400 on one detail is that code's problem.
AUTH_STATUSES = (401, 403)


@dataclass
class RunResult:
    run_id: str
    dias: list[str] = field(default_factory=list)
    requests: int = 0
    presupuesto_agotado: bool = False
    cursor: str | None = None
    objetos: list[str] = field(default_factory=list)
    exit_code: int = 0


def run_mercadopublico(
    targets: list[date],
    *,
    api: MercadoPublico,
    store: GcsStore,
    budget: RequestBudget,
    now: Callable[[], datetime],
    secrets: Iterable[str],
) -> RunResult:
    run_id = new_run_id(now())
    saved = cursor_mod.load(store)
    days = pending_days(date.fromisoformat(saved.fecha) if saved else None, targets)
    result = RunResult(run_id=run_id)
    state = Cursor(fecha=days[0].isoformat())

    def persist() -> None:
        state.run_id = run_id
        state.actualizado = utc_iso(now())
        cursor_mod.save(store, state)

    writer = BronzeWriter(store, run_id, secrets=secrets, on_flush=persist)

    def finish(exit_code: int, keep_cursor: bool) -> RunResult:
        writer.flush()
        result.requests = budget.used
        result.objetos = list(writer.paths)
        result.exit_code = exit_code
        result.cursor = store.uri(cursor_mod.PATH) if keep_cursor else None
        return result

    try:
        for day in days:
            state = saved if saved is not None and saved.fecha == day.isoformat() else Cursor(fecha=day.isoformat())
            persist()
            log.info("procesando %s (fase %s)", day.isoformat(), state.fase)

            for entidad in ENTIDADES:
                if state.codigos[entidad] is not None:
                    continue
                fetched = api.listado(entidad, day)
                rec = record(fetched, run_id=run_id, fecha=day, entidad=entidad, tipo="listado", codigo=None, now=now())
                lista = None
                if fetched.status == 200:
                    try:
                        lista = codigos(entidad, fetched.payload)
                    except ListadoInvalido as exc:
                        rec["error"] = str(exc)
                if lista is None:
                    writer.add(entidad, day, rec)
                    log.error("el listado de %s del %s falló: %s", entidad, day.isoformat(), rec["error"])
                    return finish(1, keep_cursor=True)
                state.codigos[entidad] = lista
                writer.add(entidad, day, rec)

            resume_fase, resume_codigo = state.fase, state.ultimo_codigo
            for entidad in ENTIDADES:
                if resume_fase == "ordenes_compra" and entidad == "licitaciones":
                    continue
                lista = state.codigos[entidad]
                start = 0
                if entidad == resume_fase and resume_codigo in lista:
                    start = lista.index(resume_codigo) + 1
                for codigo in lista[start:]:
                    fetched = api.detalle(entidad, codigo)
                    rec = record(
                        fetched, run_id=run_id, fecha=day, entidad=entidad, tipo="detalle", codigo=codigo, now=now()
                    )
                    state.fase, state.ultimo_codigo = entidad, codigo
                    writer.add(entidad, day, rec)
                    if fetched.status in AUTH_STATUSES:
                        raise AuthError(f"el detalle {codigo} de {entidad} respondió {fetched.status}")

            writer.flush()
            result.dias.append(day.isoformat())
    except BudgetExhausted:
        finish(0, keep_cursor=True)
        persist()
        result.presupuesto_agotado = True
        log.warning(
            "presupuesto de %d requests alcanzado; cursor guardado en %s (fecha %s, último código %s)",
            budget.limit,
            result.cursor,
            state.fecha,
            state.ultimo_codigo,
        )
        return result
    except AuthError as exc:
        log.error("ticket rechazado: %s", exc)
        return finish(1, keep_cursor=True)

    result = finish(0, keep_cursor=False)
    cursor_mod.clear(store)
    return result
