# Verificaciones de integración · 2026-10-26

Proyecto `compras-publicas-cl-jpl`, región `us-central1`, bucket de pruebas `gs://compras-publicas-cl-jpl-it`
(creado a mano para estas corridas; distinto de `-bronze`). Credenciales ADC del usuario con proyecto de cuota fijado.
Fecha hábil usada: viernes 2026-10-23.

| Paso | Comando | Salida | Resultado |
|---|---|---|---|
| 4.3 | `scripts/it/tf-plan.sh main` | `No changes. Your infrastructure matches the configuration.` · `tf-plan: main ok` | ok |
| 4.4 | `gcloud secrets versions list` × 3 | `mercadopublico-ticket` 1 enabled (36 car.) · `bcentral-token` 1 enabled (60) · `dataform-github-token` 1 enabled (93) | ok |
| 5.1 | `GOOGLE_CLOUD_PROJECT=… IT_BUCKET=compras-publicas-cl-jpl-it scripts/it/ingest-mp.sh 2026-10-23` | `ingest-mp: ok run_id=20261026T132343Z-94dc513d lineas=14 requests=25` | ok |
| 5.2 | `GOOGLE_CLOUD_PROJECT=… IT_BUCKET=compras-publicas-cl-jpl-it scripts/it/ingest-indicadores.sh 2026-10-23` | `S-08 …: encontrada` × 3 · `warning: mindicador uf absent` · `warning: mindicador dolar absent` · `ingest-indicadores: ok run_id=20261026T133018Z-d91ec0da series=3 mindicador=0 requests=11` | ok |

## Defectos encontrados por las corridas reales

- **5.2, Banco Central responde en ISO-8859-1.** `response.json()` de httpx decodifica los bytes como UTF-8 y falla con
  la primera tilde («Dólar observado»): las series `dolar` e `ipc` salían como «respuesta no JSON». Arreglado en
  `ingest/src/compras_ingest/http.py` (`json.loads(response.text)`, que respeta el charset) y en el chequeo S-08 de
  `scripts/it/ingest-indicadores.sh`.
- **5.2, mindicador.cl corta el handshake TLS** (también con curl; por IPv4 responde 502 tras dos minutos). El
  `RemoteProtocolError` escapaba de `fetch()` y tumbaba el job. Ahora todo `httpx.TransportError` se reintenta como un
  timeout y termina en un aviso: `mindicador=0`, salida 0 (REQ-005 E4).
