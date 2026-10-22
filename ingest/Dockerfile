# Image of the ingest Cloud Run Jobs (REQ-006, DEC-001). Build from the repo root:
#   docker build -f ingest/Dockerfile .
# No secrets here: the jobs read Secret Manager at run time with the compras-ingest service account (DEC-004).
FROM python:3.12-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.13.4 /uv /bin/uv

WORKDIR /app
ENV UV_PYTHON_DOWNLOADS=never UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1

# The workspace lock needs every member's pyproject.toml.
COPY pyproject.toml uv.lock ./
COPY ingest/pyproject.toml ingest/pyproject.toml
COPY finops/killswitch/pyproject.toml finops/killswitch/pyproject.toml
COPY benchmarks/pyproject.toml benchmarks/pyproject.toml
COPY ingest/src ingest/src
COPY ingest/schemas ingest/schemas

RUN uv sync --frozen --no-dev --package compras-ingest

USER 65532:65532
ENTRYPOINT ["/app/.venv/bin/python", "-m", "compras_ingest"]
