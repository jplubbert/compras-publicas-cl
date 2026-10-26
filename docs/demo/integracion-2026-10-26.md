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
| 5.3 | `GOOGLE_CLOUD_PROJECT=… GCP_REGION=us-central1 scripts/it/run-jobs.sh 2026-10-23` | `run-jobs: no mindicador files on 2026-10-23; skipped` · `run-jobs: ok fecha=2026-10-23 mercadopublico_licitaciones=12 bcentral_dolar=1 bcentral_ipc=1 bcentral_uf=1 e3=24/12` | ok (segunda corrida, tras PR #5) |
| 5.4 | `GOOGLE_CLOUD_PROJECT=… GCP_REGION=us-central1 scripts/it/migrar-proveedor-key.sh` | `migrar-proveedor-key: ok dropped: none` (silver aún no existía) | ok |
| 5.8 | `STATE_BACKUP_BUCKET=compras-publicas-cl-jpl-bk-tfstate-backup scripts/it/state-backup.sh` | `state-backup: ok gs://…/infra-main/20261026T135459Z-fe28778….tfstate` | ok (tras corregir el script) |

## Defectos encontrados por las corridas reales

- **5.2, Banco Central responde en ISO-8859-1.** `response.json()` de httpx decodifica los bytes como UTF-8 y falla con
  la primera tilde («Dólar observado»): las series `dolar` e `ipc` salían como «respuesta no JSON». Arreglado en
  `ingest/src/compras_ingest/http.py` (`json.loads(response.text)`, que respeta el charset) y en el chequeo S-08 de
  `scripts/it/ingest-indicadores.sh`.
- **5.2, mindicador.cl corta el handshake TLS** (también con curl; por IPv4 responde 502 tras dos minutos). El
  `RemoteProtocolError` escapaba de `fetch()` y tumbaba el job. Ahora todo `httpx.TransportError` se reintenta como un
  timeout y termina en un aviso: `mindicador=0`, salida 0 (REQ-005 E4).
- **5.3, el operador no podía leer bronze.** La política del bucket es autoritativa y solo la cuenta de ingesta lee
  objetos; el dueño del proyecto solo lista. `run-jobs.sh` compara líneas de bronze con filas de raw, así que fallaba
  con `HTTPError 403` después de que los dos Cloud Run Jobs terminaran bien. Arreglado con la variable `bronze_readers`
  de Terraform (PR #5, variable de repositorio `BRONZE_READERS`).
- **5.8, la comparación del estado restaurado era demasiado estricta.** `terraform state push` a un backend local vacío
  sube el `serial` en uno y reordena `check_results`; el script exigía el mismo serial y fallaba siempre. Ahora compara
  linaje, recursos y outputs, e ignora esos dos campos.
