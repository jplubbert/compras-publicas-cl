"""Secret Manager access at run time (DEC-004)."""

from collections.abc import Mapping

TICKET_SECRET_ID = "mercadopublico-ticket"


class ConfigError(Exception):
    pass


def ticket_secret_name(env: Mapping[str, str]) -> str:
    if env.get("MP_TICKET_SECRET"):
        return env["MP_TICKET_SECRET"]
    project = env.get("GOOGLE_CLOUD_PROJECT")
    if not project:
        raise ConfigError("falta GOOGLE_CLOUD_PROJECT (o MP_TICKET_SECRET)")
    return f"projects/{project}/secrets/{TICKET_SECRET_ID}/versions/latest"


def read_secret(name: str, client=None) -> str:
    if client is None:
        from google.cloud import secretmanager

        client = secretmanager.SecretManagerServiceClient()
    value = client.access_secret_version(request={"name": name}).payload.data.decode("utf-8").strip()
    if not value:
        raise ConfigError(f"el secreto {name} está vacío")
    return value
