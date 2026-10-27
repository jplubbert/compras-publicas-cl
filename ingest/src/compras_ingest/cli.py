"""Command line.

python -m compras_ingest mercadopublico [--date D | --from D1 --to D2]
python -m compras_ingest indicadores [--date D]
python -m compras_ingest load --fuente F --run-id RUN_ID

Every ingest run loads the files it wrote into BigQuery raw (REQ-006); `load` reloads a run already in bronze.
"""

import argparse
import json
import logging
import os
import re
import sys
import time
from dataclasses import asdict
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

from . import corridas
from .bcentral import BancoCentral
from .bronze import GcsStore
from .budget import RequestBudget
from .cursor import CursorPosterior
from .http import new_client
from .indicadores import run_indicadores
from .load import LoadError, load_run
from .mercadopublico import MercadoPublico
from .mindicador import Mindicador
from .redact import configure_logging, redact
from .run import run_mercadopublico
from .secrets import ConfigError, bcentral_token_secret_name, read_secret, ticket_secret_name

log = logging.getLogger("compras_ingest")

DEFAULT_BUDGET = 9000
# 5 URLs x 4 attempts = 20 requests at most; the cap only guards against a loop.
INDICADORES_BUDGET = 50
SANTIAGO = ZoneInfo("America/Santiago")
FUENTES = ("mercadopublico", "bcentral", "mindicador")
RUN_ID = re.compile(r"^\d{8}T\d{6}Z-[0-9a-f]{8}$")


def _iso_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"fecha inválida: {value!r} (se espera AAAA-MM-DD)") from None


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m compras_ingest")
    sub = parser.add_subparsers(dest="command", required=True)
    mp = sub.add_parser("mercadopublico", help="ingest Mercado Público tenders and purchase orders into bronze")
    mp.add_argument("--date", type=_iso_date)
    mp.add_argument("--from", dest="date_from", type=_iso_date)
    mp.add_argument("--to", dest="date_to", type=_iso_date)
    ind = sub.add_parser("indicadores", help="ingest Banco Central series and mindicador.cl indicators into bronze")
    ind.add_argument("--date", type=_iso_date)
    load = sub.add_parser(
        "load",
        help="reload the bronze files of a run into BigQuery raw, without calling the APIs "
        "(runs written since T-08, whose lines carry _ingest_date)",
    )
    load.add_argument("--fuente", required=True, choices=FUENTES)
    load.add_argument("--run-id", required=True)
    return parser


def _load(env, bucket: str, objetos: list[str], run_id: str, secrets: list[str], bq_client) -> tuple[list[dict], bool]:
    """Load the run's files into raw; returns (cargas, failed)."""
    project = env.get("GOOGLE_CLOUD_PROJECT")
    if not project:
        raise ConfigError("falta GOOGLE_CLOUD_PROJECT para cargar a BigQuery")
    if bq_client is None:
        from google.cloud import bigquery

        bq_client = bigquery.Client(project=project)
    dataset = env.get("RAW_DATASET") or "raw"
    try:
        return load_run(
            bq_client, project=project, dataset=dataset, bucket=bucket, objetos=objetos, run_id=run_id, secrets=secrets
        ), False
    except LoadError as exc:
        log.error("%s", redact(str(exc), secrets))
        return exc.cargas, True


def _targets(parser: argparse.ArgumentParser, args, now: datetime) -> list[date]:
    if args.date is not None and (args.date_from is not None or args.date_to is not None):
        parser.error("--date no se puede combinar con --from/--to")
    if (args.date_from is None) != (args.date_to is None):
        parser.error("--from y --to van juntos")
    if args.date_from is not None:
        if args.date_from > args.date_to:
            parser.error("--from es posterior a --to")
        return [args.date_from + timedelta(days=i) for i in range((args.date_to - args.date_from).days + 1)]
    if args.date is not None:
        return [args.date]
    return [now.astimezone(SANTIAGO).date() - timedelta(days=1)]


def _budget(env) -> int:
    raw = env.get("MP_DAILY_REQUEST_BUDGET")
    if raw is None or raw == "":
        return DEFAULT_BUDGET
    try:
        value = int(raw)
    except ValueError:
        value = 0
    if value <= 0:
        raise ConfigError(f"MP_DAILY_REQUEST_BUDGET debe ser un entero mayor que 0 (vale {raw!r})")
    return value


def main(
    argv=None,
    *,
    env=None,
    http=None,
    store=None,
    ticket_reader=read_secret,
    sleep=time.sleep,
    now=None,
    storage_client=None,
    bq_client=None,
) -> int:
    env = os.environ if env is None else env
    now = now or (lambda: datetime.now(UTC))
    parser = _parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0)
    secrets: list[str] = []
    configure_logging(secrets)
    try:
        bucket = env.get("BRONZE_BUCKET")
        if not bucket:
            raise ConfigError("falta BRONZE_BUCKET")
        if args.command == "load":
            if not RUN_ID.match(args.run_id):
                raise ConfigError(f"run_id mal formado: {args.run_id!r} (se espera AAAAMMDDThhmmssZ-<8 hex>)")
            store = store or GcsStore(bucket, client=storage_client)
            objetos = sorted(store.list(f"{args.fuente}/*/fecha=*/run={args.run_id}/*.jsonl"))
            if not objetos:
                raise ConfigError(f"no hay archivos de {args.fuente} con run_id {args.run_id} en gs://{bucket}")
            cargas, failed = _load(env, bucket, objetos, args.run_id, secrets, bq_client)
            out = {"run_id": args.run_id, "fuente": args.fuente, "objetos": objetos, "cargas": cargas}
            print(json.dumps(out, ensure_ascii=False), file=sys.stdout)
            return 1 if failed else 0
        if args.command == "mercadopublico":
            targets = _targets(parser, args, now())
            budget = RequestBudget(_budget(env))
            ticket = ticket_reader(ticket_secret_name(env))
            secrets.append(ticket)
            configure_logging(secrets)
            store = store or GcsStore(bucket, client=storage_client)
            client = http or new_client()
            api = MercadoPublico(client, ticket, budget, sleep)
            result = run_mercadopublico(targets, api=api, store=store, budget=budget, now=now, secrets=secrets)
        else:
            fecha = args.date or (now().astimezone(SANTIAGO).date() - timedelta(days=1))
            token = ticket_reader(bcentral_token_secret_name(env))
            secrets.append(token)
            configure_logging(secrets)
            store = store or GcsStore(bucket, client=storage_client)
            budget = RequestBudget(INDICADORES_BUDGET)
            client = http or new_client()
            result = run_indicadores(
                fecha,
                bde=BancoCentral(client, token, budget, sleep),
                mind=Mindicador(client, budget, sleep, secrets),
                store=store,
                budget=budget,
                now=now,
                secrets=secrets,
            )
        # Load what the run wrote even when it ended with 1 or the budget ran out, so raw has what bronze has.
        cargas, failed = [], False
        if result.objetos:
            cargas, failed = _load(env, bucket, result.objetos, result.run_id, secrets, bq_client)
        # The run row of raw.corridas (DEC-012): OK, PARCIAL or ERROR. Not writing it is an error: the Workflow and
        # gold.dim_corrida would take the previous run for today's.
        registrada = _registrar_corrida(env, args.command, result, cargas, failed, secrets, bq_client, now)
    except SystemExit as exc:
        return int(exc.code or 0)
    except (ConfigError, CursorPosterior) as exc:
        log.error("%s", redact(str(exc), secrets))
        return 2
    except Exception as exc:  # noqa: BLE001 - last resort: log redacted, no traceback (DEC-004)
        log.error("%s", redact(f"{type(exc).__name__}: {exc}", secrets))
        return 1
    print(redact(json.dumps({**asdict(result), "cargas": cargas}, ensure_ascii=False), secrets), file=sys.stdout)
    if result.exit_code != 0:
        return result.exit_code
    return 1 if failed or not registrada else 0


def _registrar_corrida(env, fuente: str, result, cargas: list[dict], failed: bool, secrets, bq_client, now) -> bool:
    project = env.get("GOOGLE_CLOUD_PROJECT")
    if not project:
        raise ConfigError("falta GOOGLE_CLOUD_PROJECT para registrar la corrida")
    if bq_client is None:
        from google.cloud import bigquery

        bq_client = bigquery.Client(project=project)
    cargas_fallidas = sum(1 for c in cargas if c.get("error") is not None) or (1 if failed else 0)
    row = corridas.fila(
        run_id=result.run_id,
        fuente=fuente,
        fechas=result.dias if hasattr(result, "dias") else [result.fecha],
        exit_code=result.exit_code,
        requests=result.requests,
        presupuesto_agotado=getattr(result, "presupuesto_agotado", False),
        cursor=getattr(result, "cursor", None),
        objetos=len(result.objetos),
        cargas_fallidas=cargas_fallidas,
        finished_at=now(),
    )
    return corridas.registrar(
        bq_client, project=project, dataset=env.get("RAW_DATASET") or "raw", row=row, secrets=list(secrets)
    )
