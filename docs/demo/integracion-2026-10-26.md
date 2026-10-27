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
| 5.7 | `GOOGLE_CLOUD_PROJECT=… GCP_REGION=us-central1 scripts/env.sh scripts/it/run-workflow.sh` | ejecución `23575928` `SUCCEEDED` (2026-10-27 00:12–02:34 UTC), 37 acciones de Dataform en verde; la nocturna del Scheduler partió sola a las 02:30 UTC | ok (tercer intento: DEC-010 y los códigos 15 y 11) |
| 7.1 | `GCP_PROJECT_ID=… GCP_REGION=us-central1 scripts/env.sh scripts/it/benchmark.sh` | medición completa: `benchmarks/results/2026-10-26.md` (3 variantes, 2 reescrituras, «Excluidos: Ninguno»); el último paso (`run.py --dry-run`) abortó por la guarda de cuota (12,9 GB facturados hoy) y se corrió aparte tras corregirla: `benchmarks/results/2026-10-26-estimado.md`. `npm run test:benchmarks`: 35 passed | ok |

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
- **5.7, la API manda códigos de estado fuera de su catálogo publicado.** La primera corrida completa del Workflow
  (ejecución `0f6a46c8`, tras DEC-010) compiló e invocó Dataform: 28 acciones en verde y dos `rowConditions` de silver
  rojas (`estado IS NOT NULL`), gold omitido. El endpoint de detalle manda licitaciones con `CodigoEstado` 15 y
  `Estado` «Revocada» (7 filas; la documentación solo lista 18 Revocada) y órdenes de compra con 11 «No aceptada» (12
  filas; no documentado). Es el incidente de calidad real de 6.2: la assertion lo atrapó y el Workflow terminó
  `FAILED` como pide REQ-009. Arreglado agregando los dos códigos al catálogo (`dataform/includes/silver.js`, REQ-008).
- **7.1, la guarda de cuota frenaba el dry run.** `run.py` restaba lo facturado hoy también en modo `--dry-run`, que
  no factura nada, así que `benchmark.sh` fallaba justo después de medir. La guarda ahora solo protege los jobs medidos.

## Datos en gold tras la primera corrida completa (6.1 y 6.2)

Conteos con `bq query --maximum_bytes_billed` después de la ejecución `23575928` (2026-10-27 02:34 UTC):

| Tabla | Filas |
|---|---|
| gold.fct_licitaciones | 639 |
| gold.fct_ordenes_compra | 6.567 |
| gold.dim_comprador | 692 |
| gold.dim_proveedor | 3.105 |
| gold.mart_organismo_mes | 326 |
| quarantine.licitaciones | 932 (todas `fecha_fuera_de_rango`) |
| quarantine.ordenes_compra | 391 (388 `fecha_fuera_de_rango`, 3 `rut_dv_invalido`) |

Incidentes de calidad reales atrapados (6.2):

- **Códigos de estado fuera del catálogo publicado** (licitaciones 15 «Revocada», órdenes 11 «No aceptada»): la
  assertion `estado IS NOT NULL` detuvo la corrida anterior antes de gold; corregido en el catálogo (REQ-008).
- **Tres órdenes con RUT de proveedor vacío** (`RutSucursal` en blanco) quedaron en cuarentena con `rut_dv_invalido`.
  Un RUT nulo no es motivo (S-23); uno vacío sí lo es hoy. Queda como observación.
- **Falso positivo de la regla de fechas**: las 932 licitaciones y 388 órdenes con `fecha_fuera_de_rango` son
  legítimas. La regla compara con la fecha del listado (`fecha` = 2026-10-23) más un día, pero el detalle se bajó el
  26, y `FechaAdjudicacion` es una fecha planificada (hasta 2029-02-26), como `FechaCierre`, que la regla ya excluye.
  Las órdenes caen por `FechaAceptacion` entre el 24 y el 26. Cambio de regla propuesto en un PR aparte (REQ-010).

Tras el merge del PR #11 (regla de fechas, 2026-10-27) y un refresco completo de Dataform (37 de 37 acciones en verde),
la cuarentena quedó en cero en ambas tablas y gold se recalculó con las dos corridas nocturnas ya ingeridas
(ejecuciones `23575928` y `5ef20d3d`, ambas `SUCCEEDED`):

| Tabla | Filas |
|---|---|
| gold.fct_licitaciones | 1.597 |
| gold.fct_ordenes_compra | 10.452 |
| quarantine.licitaciones | 0 |
| quarantine.ordenes_compra | 0 |

## Cierre del 2026-10-27: policy tags (5.6), prueba de falla (E5 de 5.7) y gate en producción

- **5.6, policy tags** (sin `policy-tags.sh` completo, que relanza la corrida diaria de 2,5 h; sus chequeos se corrieron uno
  a uno): `rut_persona_natural` de `silver.proveedores` y `gold.dim_proveedor` lleva solo la etiqueta `dato_personal.rut`;
  `rut_empresa` y `proveedor_key` sin etiqueta; `pii.sal` con una fila y el dataset `pii` legible solo por
  `compras-dataform` y los dueños; `compras-lector` recibe `accessDenied` en `rut_persona_natural` y lee `rut_empresa`
  en ambas tablas (E4). Tras una invocación incremental de Dataform (`1793110140-727c0193`, 42 de 42 acciones,
  `silver.proveedores` con la misma `creationTime` y `lastModifiedTime` nueva) la etiqueta sigue (E7 incremental).
- **E5 de 5.7, prueba de falla**: con la versión 1 de `mercadopublico-ticket` deshabilitada,
  `scripts/it/run-workflow.sh --expect-failure` terminó en 0 en 77 s: ejecución `21f6d01e` `FAILED` en
  `ingesta_mercadopublico`, sin invocación de Dataform. El job no llegó a escribir en `raw.corridas` (falla al leer el
  secreto, antes de empezar la corrida), como corresponde. La versión se habilitó de nuevo a mano.
- **Gate y estado del día en producción** (DEC-011, DEC-012): la invocación `1793110140-727c0193` desde el
  `dataform-main` nuevo corrió `assert_cuarentena_proporcion`, `assert_silver_frescura` y `gold.dim_corrida` en verde
  (42 acciones). `raw.corridas` recibe su primera fila con la corrida nocturna del 27.
