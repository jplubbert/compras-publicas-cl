"""Resume cursor of the Mercado Público ingestion, kept outside the `fecha=` prefixes."""

import json
from dataclasses import asdict, dataclass, field
from datetime import date, timedelta

PATH = "mercadopublico/_cursor.json"


class CursorPosterior(Exception):
    pass


@dataclass
class Cursor:
    fecha: str
    fase: str = "listados"
    ultimo_codigo: str | None = None
    codigos: dict[str, list[str] | None] = field(default_factory=lambda: {"licitaciones": None, "ordenes_compra": None})
    run_id: str = ""
    actualizado: str = ""
    version: int = 1


def load(store) -> Cursor | None:
    data = store.read(PATH)
    if data is None:
        return None
    raw = json.loads(data)
    return Cursor(
        fecha=raw["fecha"],
        fase=raw.get("fase", "listados"),
        ultimo_codigo=raw.get("ultimo_codigo"),
        codigos={"licitaciones": None, "ordenes_compra": None, **(raw.get("codigos") or {})},
        run_id=raw.get("run_id", ""),
        actualizado=raw.get("actualizado", ""),
        version=raw.get("version", 1),
    )


def save(store, cursor: Cursor) -> None:
    data = json.dumps(asdict(cursor), ensure_ascii=False).encode("utf-8")
    store.write(PATH, data, content_type="application/json")


def clear(store) -> None:
    store.delete(PATH)


def pending_days(cursor_fecha: date | None, targets: list[date]) -> list[date]:
    if cursor_fecha is None:
        return list(targets)
    first, last = targets[0], targets[-1]
    if cursor_fecha > last:
        raise CursorPosterior(
            f"el cursor apunta a {cursor_fecha.isoformat()}, después del rango {first.isoformat()}..{last.isoformat()}"
        )
    if cursor_fecha <= first:
        backlog = [cursor_fecha + timedelta(days=i) for i in range((first - cursor_fecha).days)]
        return backlog + [d for d in targets if d not in backlog]
    return [d for d in targets if d >= cursor_fecha]
