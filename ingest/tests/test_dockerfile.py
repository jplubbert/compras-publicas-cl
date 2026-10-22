"""REQ-006 / DEC-001 / DEC-004: static reading of the ingest jobs image."""

import re
from pathlib import Path

INGEST = Path(__file__).resolve().parents[1]
DOCKERFILE = (INGEST / "Dockerfile").read_text(encoding="utf-8")
LINES = [line.strip() for line in DOCKERFILE.splitlines() if line.strip() and not line.strip().startswith("#")]


def test_python_312_base_with_uv_sync_of_the_ingest_package():
    assert LINES[0].startswith("FROM python:3.12")
    assert any(line.startswith("RUN uv sync --frozen --no-dev --package compras-ingest") for line in LINES)


def test_copies_the_schemas_and_runs_as_non_root():
    assert "COPY ingest/schemas ingest/schemas" in LINES
    [user] = [line for line in LINES if line.startswith("USER ")]
    assert user.split()[1].split(":")[0] not in ("0", "root")
    assert LINES[-1].startswith("ENTRYPOINT") and '"-m", "compras_ingest"' in LINES[-1]


def test_no_secret_in_env_or_arg():
    for line in LINES:
        if re.match(r"^(ENV|ARG)\b", line):
            assert not re.search(r"TICKET|TOKEN|SECRET", line, re.IGNORECASE), line


def test_dockerignore_keeps_the_context_small():
    ignore = (INGEST / "Dockerfile.dockerignore").read_text(encoding="utf-8").splitlines()
    assert "*" in ignore
    assert "!ingest/schemas" in ignore and "!ingest/src" in ignore
