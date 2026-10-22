"""REQ-004 / DEC-006: bronze layout, immutability, cursor days and redaction."""

import json
import logging
from datetime import UTC, date, datetime

import pytest
from conftest import CURSOR_PATH, FakeStorageClient
from google.api_core.exceptions import PreconditionFailed

from compras_ingest.bronze import BronzeWriter, GcsStore, new_run_id, prefix
from compras_ingest.cursor import CursorPosterior, pending_days
from compras_ingest.redact import RedactingFilter, redact

SECRET = "TK-PRUEBA-9f3a71"


def _store():
    return GcsStore("bucket-prueba", client=FakeStorageClient())


def test_prefix_follows_dec_006():
    assert (
        prefix("licitaciones", date(2026, 10, 21), "20261022T030000Z-0123abcd")
        == "mercadopublico/licitaciones/fecha=2026-10-21/run=20261022T030000Z-0123abcd/"
    )


def test_prefix_by_source():
    assert prefix("uf", date(2026, 10, 21), "R", fuente="bcentral") == "bcentral/uf/fecha=2026-10-21/run=R/"


def test_writer_uses_its_source_prefix():
    store = _store()
    writer = BronzeWriter(store, "R", fuente="mindicador")
    writer.add("dolar", date(2026, 10, 21), {"x": 1})
    writer.flush()
    assert writer.paths == ["mindicador/dolar/fecha=2026-10-21/run=R/part-0000.jsonl"]


def test_run_id_format():
    run_id = new_run_id(datetime(2026, 10, 22, 3, 4, 5, tzinfo=UTC))
    assert run_id.startswith("20261022T030405Z-")
    assert len(run_id.split("-")[1]) == 8


def test_parts_are_numbered_per_entity_and_date():
    store = _store()
    flushes = []
    writer = BronzeWriter(store, "R", flush_every=2, on_flush=lambda: flushes.append(1))
    day = date(2026, 10, 21)
    for i in range(5):
        writer.add("licitaciones", day, {"i": i})
    writer.flush()
    base = prefix("licitaciones", day, "R")
    assert writer.paths == [base + "part-0000.jsonl", base + "part-0001.jsonl", base + "part-0002.jsonl"]
    assert [json.loads(x)["i"] for x in store.bucket.objects[base + "part-0001.jsonl"].decode().splitlines()] == [2, 3]
    assert len(flushes) == 3


def test_writer_refuses_a_line_with_a_secret():
    writer = BronzeWriter(_store(), "R", secrets=[SECRET])
    writer.add("licitaciones", date(2026, 10, 21), {"x": SECRET})
    with pytest.raises(RuntimeError, match="secreto"):
        writer.flush()


def test_rewriting_an_object_of_the_run_fails():
    store = _store()
    store.write("a/part-0000.jsonl", b"1", content_type="application/x-ndjson", if_absent=True)
    with pytest.raises(PreconditionFailed):
        store.write("a/part-0000.jsonl", b"2", content_type="application/x-ndjson", if_absent=True)


def test_read_missing_returns_none_and_delete_missing_is_ignored():
    store = _store()
    assert store.read(CURSOR_PATH) is None
    store.delete(CURSOR_PATH)
    assert store.uri(CURSOR_PATH) == "gs://bucket-prueba/mercadopublico/_cursor.json"


D = [date(2026, 10, d) for d in (20, 21, 22)]


def test_pending_days_without_cursor():
    assert pending_days(None, D) == D


def test_pending_days_cursor_before_targets():
    assert pending_days(date(2026, 10, 18), D) == [date(2026, 10, d) for d in (18, 19, 20, 21, 22)]
    assert pending_days(date(2026, 10, 20), D) == D


def test_pending_days_cursor_inside_targets():
    assert pending_days(date(2026, 10, 21), D) == D[1:]


def test_pending_days_cursor_after_targets():
    with pytest.raises(CursorPosterior):
        pending_days(date(2026, 10, 23), D)


def test_cursor_after_the_requested_range_exits_2(mp):
    mp.storage.objects[CURSOR_PATH] = json.dumps({"fecha": "2026-10-25"}).encode()
    outcome = mp.run(["mercadopublico", "--date", "2026-10-21"])
    assert outcome.code == 2
    assert "2026-10-25" in outcome.err
    assert mp.router.calls.call_count == 0


def test_redact_url_and_exception_text():
    url = f"https://x.test/a.json?codigo=1&ticket={SECRET}"
    assert redact(url, [SECRET]) == "https://x.test/a.json?codigo=1&ticket=***"
    assert redact(f"ValueError: bad ticket {SECRET}", [SECRET]) == "ValueError: bad ticket ***"
    assert redact("https://x.test/?ticket=otro-valor&a=1", []) == "https://x.test/?ticket=***&a=1"
    assert redact("a%2Bb", ["a+b"]) == "***"
    assert (
        redact("https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx?token=abc&function=GetSeries", [])
        == "https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx?token=***&function=GetSeries"
    )


def test_redacting_filter_cleans_message_args_and_exc_text():
    record = logging.LogRecord("x", logging.ERROR, __file__, 1, "fallo %s", (SECRET,), None)
    record.exc_text = f"Traceback ticket={SECRET}"
    assert RedactingFilter([SECRET]).filter(record) is True
    assert record.getMessage() == "fallo ***"
    assert SECRET not in record.exc_text
