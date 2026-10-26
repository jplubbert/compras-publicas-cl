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
| 5.5 | `GCP_PROJECT_ID=… GCP_REGION=us-central1 POLICY_TAG_RUT=… scripts/env.sh scripts/it/dataform-ci.sh` | `dataform-ci: ok e2 e3 e4 descriptions req009-e2 req009-e3 req009-e4 req009-e5 cuarentena req012-e1 req012-e2 req012-e3 req012-e4 req012-e6 gold-descripciones mart licitaciones=1 ordenes_compra=4 licitacion_items=2 compradores=1 proveedores=1 indicadores_diarios=35` | ok (tercera corrida) |

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
- **5.5, `bq` invisible bajo `scripts/env.sh`.** `env.sh` fija `PATH=/usr/bin:/bin` y `mise exec` descarta las rutas de
  otras instalaciones de mise, así que el `gcloud` del usuario no se veía y `dataform-ci.sh` salía con «bq is required».
  Ahora `env.sh` enlaza `gcloud`, `bq` y `gsutil` en `.tools/cloud/` y los agrega al final del PATH.
- **5.5, `bq --format=csv` entrecomilla un valor con coma.** La comparación literal de REQ-010
  («monto_negativo,moneda_desconocida») fallaba aunque la fila en cuarentena era correcta. El helper `q()` quita las
  comillas.
- **5.7, Dataform no compila desde la raíz del monorepo.** Con el token ya válido (la versión 1 tenía un salto de línea
  final: «The access token for remote repository … was rejected»; versión 2 limpia, la 1 deshabilitada), el paso
  `compilar_dataform` del Workflow sigue en 400: Dataform clona la raíz del remoto y no admite subcarpetas, corre
  `npm ci` con el `package.json` de la raíz (sin lockfile) y nunca llega a `dataform/workflow_settings.yaml`. Arreglado
  con la rama derivada `dataform-main` (DEC-010): `deploy.yml` la publica con `git subtree split` tras la corrida en
  `ci`, y el Workflow y el release config compilan desde ella. Probado a mano: compilación sin errores desde esa rama con
  las variables del Workflow. La corrida completa (5.7) queda para después del merge.
