"""Secret redaction for URLs, log records and error messages (DEC-004)."""

import logging
import re
import sys
from collections.abc import Iterable
from urllib.parse import quote

MASK = "***"
_TICKET_PARAM = re.compile(r"(?i)((?:ticket|token)=)[^&\s\"']*")


def redact(text: str, secrets: Iterable[str]) -> str:
    """Replace every secret (raw and URL-encoded) and any `ticket=` or `token=` query value with `***`."""
    for value in secrets:
        if not value:
            continue
        text = text.replace(value, MASK)
        encoded = quote(value, safe="")
        if encoded != value:
            text = text.replace(encoded, MASK)
    return _TICKET_PARAM.sub(r"\1" + MASK, text)


class RedactingFilter(logging.Filter):
    """Redacts the formatted message and the exception text of every record."""

    def __init__(self, secrets: list[str]):
        super().__init__()
        self.secrets = secrets

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact(record.getMessage(), self.secrets)
        record.args = ()
        if record.exc_text:
            record.exc_text = redact(record.exc_text, self.secrets)
        return True


class _StderrHandler(logging.StreamHandler):
    """Writes to the current sys.stderr, resolved on every record."""

    @property
    def stream(self):
        return sys.stderr

    @stream.setter
    def stream(self, _value):
        pass


def configure_logging(secrets: Iterable[str]) -> None:
    """Install a single redacting stderr handler on the root logger (idempotent)."""
    root = logging.getLogger()
    for handler in list(root.handlers):
        if isinstance(handler, _StderrHandler):
            root.removeHandler(handler)
    handler = _StderrHandler()
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    handler.addFilter(RedactingFilter(list(secrets)))
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    # httpx logs the full request URL, ticket included, at INFO.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
