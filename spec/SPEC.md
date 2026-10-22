# SPEC — compras-publicas-cl
Versión: 1  ·  Corte 1: aprobado por José Pedro Lübbert (2026-10-21)  ·  Nivel de riesgo (sdd.md §10.4): funcionalidad mediana

<!--
Variante "desarrollador único" de PCR: el Plan vive en este archivo (sección Plan) en vez de spec/PLAN.md.
Solo anexar cambios con contexto: un requisito cambiado conserva "(Previamente: …, cambiado en LOG <fecha>)".
Estados de un requisito: proposed → approved_for_impl (lo marca el usuario) → … (sdd.md §8.2).
-->

## Objetivo (≤1 página)
Para un evaluador técnico de un rol de data engineer GCP (consultoras como Imagemaker: BigQuery, Dataform, Cloud Run,
Terraform, CI/CD, gobierno, calidad y FinOps), que necesita comprobar en minutos que el autor construye plataformas de
datos de producción, el repo `compras-publicas-cl` es un lakehouse medallion en GCP. Ingiere a diario las licitaciones y
órdenes de compra de Mercado Público, las cruza con la UF, el dólar y el IPC del Banco Central y lo despliega todo con
Terraform y GitHub Actions, con un costo de USD 0 a 1 al mes y un tope duro de USD 10.

¿Y qué?: los capstones típicos (taxis de NYC + dbt + Looker) no traen tres evidencias que un entrevistador puede
verificar en vivo, y este repo sí: una tabla de bytes facturados antes y después sacada de `INFORMATION_SCHEMA.JOBS`,
calidad de datos como código (assertions y cuarentena con motivo) y policy tags declaradas en Terraform. Además usa un
dominio chileno real.

Criterio de éxito: (1) desde un clon limpio, siguiendo el README, `terraform apply` y la primera corrida diaria dejan
datos en `gold` sin pasos fuera del README; (2) un PR muestra `terraform plan` y las pruebas en GitHub Actions sin llaves
de cuenta de servicio; (3) el README trae la tabla del benchmark con números reales y el gasto del mes queda bajo USD 1.

## Alcance
- Incluido (corte 1):
  1. Plataforma: Terraform (bootstrap con estado y WIF; stack principal con GCS, BigQuery, cuentas de servicio y
     secretos), CI/CD en GitHub Actions con WIF (plan en el PR, apply en `main`) y tope de gasto (presupuesto con corte
     duro de USD 10, cuota diaria de BigQuery y `maximum_bytes_billed`). Sin Composer.
  2. Datos: ingesta de Mercado Público (licitaciones y órdenes de compra, listado diario y detalle) y del Banco Central
     (UF, dólar observado e IPC), más mindicador.cl como segunda fuente para reconciliar, a GCS (bronze) y BigQuery
     (raw); silver en Dataform con MERGE incremental y dedup; assertions como criterio de promoción; cuarentena con
     motivo; descripciones obligatorias; orquestación diaria con Scheduler y Workflows.
  3. Valor: capa final (gold) con montos deflactados a UF, benchmark antes y después sobre datos sintéticos a escala GB,
     policy tags sobre el RUT de las personas naturales y un README de portafolio (arquitectura, cómo reproducir,
     costos, calidad, «Cómo se construyó» y «Qué se rompió»).
- Excluido explícitamente: Cloud Composer y Airflow; Dataflow y Pub/Sub para datos (Pub/Sub solo lleva el aviso del
  presupuesto); el paso con Gemini (GenAI); los data quality scans de Knowledge Catalog (cobran desde el primer minuto);
  el módulo antifraude sintético como dominio aparte; el backfill histórico de Mercado Público; dashboards (Looker Studio); GitLab CI (solo una nota en el README);
  data masking dinámico; despliegue a más de un entorno (hay un solo proyecto).
- Cortes futuros: histórico de Mercado Público desde las descargas masivas de datos abiertos de ChileCompra
  (decisión del usuario del 2026-10-21: este corte ingiere día a día desde la primera corrida); data quality scan semanal de Knowledge Catalog en YAML + Terraform; clasificación de rubros con Gemini
  y aprobación humana; dashboard en Looker Studio; Airflow local en Docker como comparación; captura del lineage en
  Knowledge Catalog.

## Restricciones
- R-01 Stack: GCP (Cloud Storage, BigQuery, Dataform, Cloud Run Jobs y functions, Cloud Scheduler, Workflows, Secret
  Manager, Artifact Registry, Pub/Sub para el presupuesto, Cloud Monitoring, IAM, policy tags de BigQuery); Terraform ≥
  1.7 con el proveedor `google`; Python 3.12 con uv (dependencias: `google-cloud-storage`, `google-cloud-bigquery`,
  `google-cloud-secret-manager`, `google-auth`, `httpx`, `functions-framework` (solo la desvinculadora); desarrollo: `pytest`, `respx`, `ruff`, `pyyaml`); Node.js ≥ 22 para Dataform
  (`@dataform/core` y `@dataform/cli`) y las guardas del protocolo; GitHub Actions. Herramientas instaladas con mise dentro de `.tools/` (mise
  incluido, sin sudo); ningún `verify` depende de herramientas globales (se corre con `scripts/env.sh`). Otra dependencia
  necesita una DEC — fuente: usuario, DEC-001. (Previamente: sin la oración de mise, cambiado en LOG 2026-10-21.)
- R-02 Región `us-central1` para todo recurso regional y para los datasets — fuente: DEC-001.
- R-03 Costo: USD 0 a 1 al mes en uso normal y corte duro a los USD 10; nada que cobre por hora encendido (Composer,
  instancias de Cloud SQL o de GKE) — fuente: usuario, DEC-003.
- R-04 API de Mercado Público: máximo 10.000 requests diarios por ticket, cargas masivas entre 22:00 y 07:00 (hora de
  Chile) y obligación de citar a ChileCompra al publicar los datos — fuente: chilecompra.cl/api.
- R-05 Sin secretos en git ni en el estado de Terraform; CI sin llaves de cuenta de servicio — fuente: DEC-004.
- R-06 El `verify` de cada tarea corre localmente sin red ni credenciales; lo que toca GCP va en `verify_integration` —
  fuente: DEC-005, DEC-019 de sdd-base.
- R-07 Nomenclatura vigente de 2026: «Knowledge Catalog (ex Dataplex Universal Catalog)» y «Managed Service for Apache
  Airflow». Data Catalog se apagó el 2026-06-01 y no se nombra como herramienta actual — fuente: informe.

## Glosario
- Bronze: archivos JSONL crudos en GCS, tal como los devolvió la fuente, por fecha y corrida (DEC-006).
- Raw: tablas de BigQuery cargadas desde bronze con load jobs, sin transformar, con `run_id` y `_ingest_date`.
- Silver: modelos de Dataform limpios, tipados y deduplicados, uno por entidad (`definitions/intermediate`).
- Gold (capa final): hechos, dimensiones y métricas listos para el análisis (`definitions/outputs`).
- Cuarentena: dataset `quarantine` con las filas que fallaron una regla de fila, con su motivo; no pasan a silver.
- Promoción: un modelo se materializa en la capa siguiente solo si pasan las assertions de sus dependencias.
- Fecha D: el día de datos que procesa una corrida; por defecto, ayer en America/Santiago.
- Ticket: credencial de la API de Mercado Público, una por persona, obtenida con Clave Única.
- BDE: Base de Datos Estadísticos del Banco Central (API REST SieteRestWS, autenticada con un token).
- ND: valor «no disponible» que la BDE devuelve en un día sin dato.
- Persona natural: proveedor cuyo RUT es menor que 50.000.000 (S-04).
- Corrida diaria: la ejecución del Workflow que lanza Cloud Scheduler.
- Hueco de observaciones: tramo de más de 4 días corridos sin ninguna observación (valor o ND) de una serie diaria de
  la BDE; cubre fines de semana largos con feriado sin necesitar un calendario de feriados.
- Run id: identificador de una ejecución de ingesta, `AAAAMMDDThhmmssZ-<8 hex>`.
- En `ci`: un ejemplo marcado así se comprueba en BigQuery, en la corrida aislada de CI: Dataform compila con
  `schemaSuffix: "ci"` (escribe en `silver_ci`, `gold_ci` y `quarantine_ci`) y la variable `raw_dataset=raw_ci` (lee
  fixtures cargados en `raw_ci`); corre en `deploy.yml` o en el
  `verify_integration` de la tarea; no en el `verify` local (DEC-005).

## Requisitos

### REQ-001 Infraestructura reproducible con Terraform · estado: approved_for_impl · prioridad: must
Cuando el usuario aplica `infra/bootstrap` y luego `infra/main` con `project_id`, `region` y `github_repository` como
únicas variables obligatorias, el sistema deberá crear: el bucket de estado (versionado); el pool y el proveedor de
Workload Identity Federation restringidos al repo; el bucket bronze en `us-central1` con lifecycle (Nearline a los 30
días, borrado a los 365); los datasets `raw`, `silver`, `gold`, `quarantine`, `pii`, `bench` y sus gemelos de CI `raw_ci`,
`silver_ci`, `gold_ci` y `quarantine_ci` en `us-central1`, con descripción y etiquetas `layer`; una cuenta de servicio por componente (ingesta, Dataform, Workflow,
CI) con roles a nivel de recurso; lectura de bronze, `raw`, `quarantine` y `pii` solo para las cuentas de servicio del
pipeline y el dueño del proyecto; los secretos vacíos de DEC-004 y las APIs necesarias.
Si falta una variable obligatoria, o `region` no es una región de EE. UU. con free tier de GCS (`us-central1`,
`us-east1`, `us-west1`), entonces `terraform validate` o `terraform plan` deberá fallar con un mensaje que la nombre. Si
un archivo de `infra/` contiene un ID de proyecto o un número de cuenta literal, o declara `google_composer_environment`,
entonces `npm run check:repo` deberá fallar.
Ejemplos (aceptación):
| caso | entrada / contexto | resultado esperado |
|---|---|---|
| E1 positivo | `terraform test` con proveedor simulado y `project_id = "demo-proj"` | el plan tiene el bucket bronze en `US-CENTRAL1` con 2 reglas de lifecycle y 10 datasets con etiqueta `layer` |
| E2 negativo | plan sin `project_id` | falla nombrando `project_id` |
| E3 negativo | `region = "southamerica-west1"` | la validación de la variable falla |
| E4 negativo | un `.tf` con `project = "mi-proyecto-123"` literal o un `google_composer_environment` | `npm run check:repo` sale distinto de 0 y nombra el archivo |
| E5 borde | la cuenta de servicio de ingesta | tiene `roles/storage.objectUser` sobre el bucket bronze (escribe, lee y reescribe el cursor; el load job lee los archivos), `roles/bigquery.dataEditor` sobre `raw` y `raw_ci`, `roles/secretmanager.secretAccessor` sobre cada uno de sus secretos y, a nivel de proyecto, solo `roles/bigquery.jobUser` |
| E6 negativo | `terraform test` | ningún binding de lectura sobre bronze, `raw`, `quarantine` ni `pii` para miembros fuera de las cuentas de servicio del pipeline |
Trazas: objetivo §Criterio de éxito (1) · decisiones: DEC-001, DEC-004, DEC-005 · prueba: tests/acceptance/T-03*

### REQ-002 CI/CD en GitHub Actions con WIF · estado: approved_for_impl · prioridad: must
Cuando se abre o actualiza un pull request hacia `main`, el sistema deberá correr en GitHub Actions las comprobaciones
locales (`npm run lint`, `npm test`, `npm run check:repo`, `npm run check:spec`, `dataform compile`) y `terraform plan`
de `infra/main` autenticado con WIF, y publicar el resumen del plan como comentario del PR. Cuando se hace merge a
`main`, deberá correr `terraform apply` en el entorno protegido `production` (las imágenes y la corrida de Dataform en
`ci` las agrega REQ-006).
Si una comprobación falla, entonces el job deberá terminar en error y el apply no deberá correr. Si el PR viene de un
fork, entonces no deberá obtener el token OIDC ni correr el plan.
Ejemplos (aceptación):
| caso | entrada / contexto | resultado esperado |
|---|---|---|
| E1 positivo | `.github/workflows/ci.yml`, evento `pull_request` | tiene los jobs `checks` y `plan`; `plan` depende de `checks` y usa `google-github-actions/auth` con `workload_identity_provider` |
| E2 positivo | `.github/workflows/deploy.yml`, evento `push` a `main` | el job `apply` corre con `environment: production` y se autentica con WIF |
| E3 negativo | cualquier workflow | no contiene `credentials_json` ni `service_account_key`, y `id-token: write` aparece solo en los jobs que se autentican |
| E4 borde | PR desde un fork | el job `plan` tiene la condición `github.event.pull_request.head.repo.full_name == github.repository` |
Trazas: objetivo §Criterio de éxito (2) · decisiones: DEC-004, DEC-005 · prueba: tests/acceptance/T-04*

### REQ-003 Tope de gasto · estado: approved_for_impl · prioridad: must
Cuando el gasto real del mes llega al 50 % o al 90 % del presupuesto (USD 10 por defecto), el sistema deberá avisar por
correo. Cuando llega al 100 %, la función desvinculadora deberá quitar la cuenta de facturación del proyecto. Toda
consulta de BigQuery deberá correr bajo la cuota diaria del proyecto (S-07); las de Dataform, además, bajo la cuota
diaria por usuario, que alcanza a su cuenta de servicio (Dataform no tiene `maximumBytesBilled`, T-02); y las de los
scripts del repo, con `maximum_bytes_billed` (S-07; los load jobs no facturan bytes). (Previamente: «las consultas de Dataform y de los scripts del repo, con `maximum_bytes_billed`», cambiado en LOG 2026-10-22 por el spike T-02.)
Si el mensaje del presupuesto trae un `costAmount` menor que `budgetAmount`, entonces la función no deberá hacer nada.
Si el mensaje está malformado, entonces deberá registrar el error sin desvincular. Si el billing ya está desvinculado,
entonces no deberá fallar (idempotente). La cuenta de servicio de CI no deberá tener roles de billing.
Ejemplos (aceptación):
| caso | entrada / contexto | resultado esperado |
|---|---|---|
| E1 positivo | mensaje `{"costAmount": 10.20, "budgetAmount": 10}` | llama a `updateBillingInfo` con `billingAccountName: ""` una vez |
| E2 negativo | `{"costAmount": 9.99, "budgetAmount": 10}` | no llama a la API |
| E3 negativo | mensaje sin `costAmount` o con JSON inválido | registra el error y no llama a la API |
| E4 borde | `costAmount` ≥ `budgetAmount` y el proyecto ya sin billing | no llama a `updateBillingInfo` y termina sin error |
| E5 positivo | `terraform test` del bootstrap | presupuesto con umbrales 0.5, 0.9 y 1.0 sobre el gasto real y tema Pub/Sub conectado a la función; la cuenta de servicio de CI no tiene roles `roles/billing.*` |
| E6 positivo | `terraform test` de `infra/main` | existen las cuotas `QueryUsagePerDay` (proyecto) y `QueryUsagePerUserPerDay` (usuario) de `bigquery.googleapis.com` con los valores de S-07 (antes: «y `workflow_settings.yaml` fija `maximumBytesBilled`», cambiado en LOG 2026-10-22) |
Trazas: objetivo §Criterio de éxito (3) · decisiones: DEC-003 · prueba: tests/acceptance/T-05*

### REQ-004 Ingesta de Mercado Público a bronze · estado: approved_for_impl · prioridad: must
Cuando el job de ingesta corre para la fecha D (por defecto ayer en America/Santiago, o `--date`), el sistema deberá
pedir el listado diario de licitaciones y de órdenes de compra de D, después el detalle de cada código (primero las
licitaciones, después las OC), y escribir
cada respuesta como una línea JSONL en bronze (DEC-006), con los metadatos `run_id`, `ingested_at`, `source_url` (con
el ticket redactado como `***`), `http_status` y `fecha`. Con `--from` y `--to` (backfill), deberá procesar los días en
orden (para rangos cortos; el histórico masivo está fuera de este corte). Antes de D, la corrida termina los días
pendientes del cursor, en orden. Cálculo de capacidad (S-06): unas 8.100 OC y 400 licitaciones por día hábil más 4
listados son ~8.500 requests, bajo el presupuesto de 9.000; el atraso de un día pico se recupera en los días con menos
documentos y el fin de semana (63.000 requests por semana contra ~43.000 necesarios).
Si una respuesta es 5xx, 429 o hay timeout, entonces deberá reintentar con backoff exponencial (respetando
`Retry-After` si viene) hasta 3 veces, y cada intento cuenta en el presupuesto. Si un detalle
devuelve 404 o sigue fallando, entonces deberá registrarlo como línea de error en bronze y continuar. Si se alcanza el
presupuesto diario de requests (S-06), entonces deberá detenerse, guardar el cursor (fecha y último código) en GCS y
terminar con código 0 y un aviso; la siguiente corrida retoma desde el cursor. El ticket no deberá aparecer en la salida,
en los registros ni en GCS.
Ejemplos (aceptación):
| caso | entrada / contexto | resultado esperado |
|---|---|---|
| E1 positivo | listado de D con 3 licitaciones simulado y 3 detalles 200 | 4 líneas de licitaciones en `mercadopublico/licitaciones/fecha=D/run=<id>/` y `source_url` con `ticket=***` |
| E2 borde | 1 detalle responde 500, 500 y luego 200 | 3 requests a ese detalle y su línea con `http_status: 200` |
| E3 negativo | 1 detalle responde 404 | una línea con `http_status: 404` y `error`; el job termina en 0 |
| E4 borde | presupuesto de 5 requests y 10 códigos | 5 requests y el cursor guardado; la siguiente corrida empieza en el código siguiente al último pedido |
| E5 negativo | cualquier caso | el valor del ticket no aparece en stdout, stderr ni en los objetos escritos |
| E6 positivo | `--from 2026-10-01 --to 2026-10-03` | procesa los 3 días en orden ascendente |
| E7 borde | 1 detalle responde 429 con `Retry-After: 2` y luego 200 | espera ≥ 2 s (reloj simulado), 2 requests contados en el presupuesto y la línea con `http_status: 200` |
| E8 positivo | cursor con D−2 a medio procesar y fecha D | termina D−2, procesa D−1 y luego D, en ese orden, hasta agotar el presupuesto |
Trazas: objetivo §Alcance 2 · decisiones: DEC-004, DEC-006 · prueba: tests/acceptance/T-06*

### REQ-005 Ingesta del Banco Central y de mindicador a bronze · estado: approved_for_impl · prioridad: must
Cuando el job de indicadores corre para la fecha D, el sistema deberá pedir a la BDE las series de UF, dólar observado e
IPC (S-08) desde D−10 hasta D (para captar revisiones; `updatedAt` solo existe en `SearchSeries`, T-02) y a mindicador.cl la UF y el dólar de D, y
escribir las respuestas crudas en bronze (`bcentral/<serie>/…` y `mindicador/<indicador>/…`) con los metadatos de
REQ-004. Los valores `ND` se guardan tal cual.
Si la BDE rechaza el token (la API REST se autentica con un token, no con usuario y clave; T-02), entonces el job
deberá terminar distinto de 0 con un mensaje que no incluya el token. (Previamente: «rechaza las credenciales … no incluya la clave», cambiado en LOG 2026-10-22 por el spike T-02.) Si mindicador no responde, entonces deberá registrar la ausencia y terminar en 0 (es una fuente secundaria sin
SLA).
Ejemplos (aceptación):
| caso | entrada / contexto | resultado esperado |
|---|---|---|
| E1 positivo | BDE simulada con 11 observaciones de UF | una línea JSONL por serie y corrida con las 11 observaciones |
| E2 borde | el dólar trae `ND` en un sábado | la observación queda con `value: "ND"` en bronze |
| E3 negativo | BDE responde con un token inválido | sale distinto de 0 y stderr no contiene el token |
| E4 negativo | mindicador da timeout | aviso en el registro, sin archivo de mindicador y sale en 0 |
Trazas: objetivo §Alcance 2 · decisiones: DEC-004, DEC-006 · prueba: tests/acceptance/T-07*

### REQ-006 Carga de bronze a BigQuery raw · estado: approved_for_impl · prioridad: must
Cuando una corrida de ingesta termina de escribir bronze, el sistema deberá lanzar un load job de BigQuery (gratis, no
streaming) por entidad desde los archivos de esa corrida a `raw.<fuente>_<entidad>`, particionada por `_ingest_date`,
con `WRITE_APPEND`, esquema declarado en el repo (sin autodetect) y las columnas `run_id` y `_ingest_date`. Cuando se
hace merge a `main`, después del apply, `deploy.yml` deberá construir y publicar la imagen de los jobs en Artifact
Registry con la etiqueta del commit, actualizar los Cloud Run Jobs y correr Dataform en la corrida aislada de CI (ver
«En `ci`» en el Glosario), con las assertions.
Si el load job falla, entonces el job deberá terminar distinto de 0 nombrando la tabla y los archivos. Si la corrida no
escribió archivos de una entidad, entonces no deberá lanzar su load job.
Ejemplos (aceptación):
| caso | entrada / contexto | resultado esperado |
|---|---|---|
| E1 positivo | corrida con archivos de licitaciones y OC | 2 load jobs con `sourceFormat: NEWLINE_DELIMITED_JSON`, `writeDisposition: WRITE_APPEND` y el esquema del repo |
| E2 negativo | el cliente simulado devuelve un error del load job | sale distinto de 0 y el mensaje nombra la tabla |
| E3 borde | en `ci`: la misma corrida se carga dos veces | raw tiene las filas dos veces con el mismo `run_id`; silver no duplica (REQ-008 E2) |
| E4 borde | corrida sin órdenes de compra | 1 solo load job |
| E5 positivo | `.github/workflows/deploy.yml` | tras el job `apply`, un job que depende de él publica la imagen con `${{ github.sha }}`, actualiza los 2 jobs y corre Dataform con `schemaSuffix: "ci"` y `raw_dataset=raw_ci` |
Trazas: objetivo §Alcance 2 · decisiones: DEC-006 · prueba: tests/acceptance/T-08*

### REQ-007 Orquestación diaria · estado: approved_for_impl · prioridad: must
Cuando llega la hora programada (23:30 America/Santiago por defecto, dentro de la ventana de R-04), Cloud Scheduler
deberá lanzar el Workflow, que ejecuta en orden el job de Mercado Público, el de indicadores y la invocación de Dataform
(compilación desde `main` con `codeCompilationConfig.vars` que trae `policy_tag_rut` y `raw_dataset`, y ejecución de las
etiquetas `silver` y `gold`), y espera a que cada paso termine. Los pasos de los jobs fijan `connector_params.timeout`
en 7 h y los Cloud Run Jobs, un timeout de tarea de 7 h (la ventana de R-04).
Si un paso falla, entonces el Workflow no deberá ejecutar los siguientes y deberá terminar en error, y una política de
alertas de Cloud Monitoring deberá avisar por correo.
Ejemplos (aceptación):
| caso | entrada / contexto | resultado esperado |
|---|---|---|
| E1 positivo | `terraform test` de `infra/main` | Scheduler con `time_zone = "America/Santiago"`, cron `30 23 * * *` y destino el Workflow |
| E2 positivo | `orchestration/daily.yaml` | pasos en el orden ingesta MP → indicadores → compilación Dataform → invocación; los jobs se lanzan con el conector que espera a que terminen, con `connector_params.timeout: 25200`; la compilación pasa `vars.policy_tag_rut` y `vars.raw_dataset` |
| E3 negativo | `orchestration/daily.yaml` | ningún paso de ingesta está dentro de un `try` que capture su error, y si la invocación de Dataform termina `FAILED` o `CANCELLED` el Workflow levanta una excepción |
| E4 positivo | `terraform test` | política de alertas sobre ejecuciones fallidas del Workflow con canal de correo |
| E5 negativo | integración: el job de Mercado Público falla (ticket inválido) | la ejecución del Workflow queda `FAILED`, no hay invocación de Dataform y llega el correo |
Trazas: objetivo §Criterio de éxito (1) · decisiones: DEC-002 · prueba: tests/acceptance/T-11*

### REQ-008 Silver incremental en Dataform · estado: approved_for_impl · prioridad: must
Cuando Dataform corre, el sistema deberá materializar `silver.licitaciones`, `silver.ordenes_compra`,
`silver.licitacion_items`, `silver.compradores`, `silver.proveedores` e `silver.indicadores_diarios` como tablas
incrementales con MERGE por clave natural (código de licitación, código de OC, código + correlativo de ítem, código de
organismo, proveedor —el RUT, que T-14 reemplaza por `proveedor_key` (REQ-014)—, serie + fecha), deduplicadas con `QUALIFY ROW_NUMBER() OVER (PARTITION BY clave ORDER BY
fecha_cambio DESC, ingested_at DESC) = 1`. En modo incremental, el SQL une las filas nuevas con las filas actuales del
destino (`${self()}`) para las mismas claves antes del `QUALIFY`, así el MERGE escribe siempre la versión ganadora y no
la última en llegar (el MERGE de `uniqueKey` actualiza toda fila con clave igual). Además, los modelos van con tipos
convertidos (fechas, montos NUMERIC, moneda) y el código de estado traducido: licitaciones 5 Publicada, 6 Cerrada, 7 Desierta, 8 Adjudicada, 18 Revocada, 19 Suspendida; órdenes de
compra 4 Enviada a proveedor, 5 En proceso, 6 Aceptada, 9 Cancelada, 12 Recepción conforme, 13 Pendiente de
recepcionar, 14 Recepcionada parcialmente, 15 Recepción conforme incompleta (T-02). En `indicadores_diarios`,
`ND` pasa a `NULL` con `es_nd = TRUE`.
Si llega una versión más antigua de una clave que ya está en silver, entonces no deberá sobrescribir la más reciente.
Ejemplos (aceptación):
| caso | entrada / contexto | resultado esperado |
|---|---|---|
| E1 positivo | grafo compilado (`dataform compile --json`) | los 6 modelos son `incremental`, tienen `uniqueKey`, y su SQL incremental lee la propia tabla destino y contiene `QUALIFY ROW_NUMBER()` después de unirla con las filas nuevas |
| E2 borde | en `ci`: misma licitación en estado 5 y luego 8, y la corrida de E3 de REQ-006 | una sola fila, estado `Adjudicada` |
| E3 borde | en `ci`: llega la versión en estado 5 después de la 8 | la fila sigue en `Adjudicada` |
| E4 positivo | en `ci`: UF con `ND` en un día | fila con `valor NULL` y `es_nd TRUE` |
Trazas: objetivo §Alcance 2 · decisiones: DEC-001, DEC-006 · prueba: tests/acceptance/T-09*

### REQ-009 Assertions y criterio de promoción · estado: approved_for_impl · prioridad: must
Cuando Dataform corre, cada modelo de silver y de gold deberá ejecutar sus assertions: `uniqueKey` sobre su clave,
`nonNull` sobre la clave y las fechas, y `rowConditions` de dominio (monto ≥ 0, fecha de cierre ≥ fecha de publicación,
estado dentro del catálogo). Además deberá haber assertions de continuidad (UF con un valor por día calendario y dólar
sin huecos de observaciones, ambas sobre la ventana de los últimos 30 días o desde la primera observación cargada, la
que sea más corta) y de reconciliación (UF y dólar de la BDE contra mindicador, con la tolerancia de S-09).
Si una assertion falla, entonces la invocación de Dataform deberá terminar en error y el Workflow también (REQ-007); la
promoción a gold la define REQ-012.
Ejemplos (aceptación):
| caso | entrada / contexto | resultado esperado |
|---|---|---|
| E1 positivo | grafo compilado | cada modelo de silver y gold tiene assertions `uniqueKey` y `nonNull`; existen `assert_uf_continuidad`, `assert_dolar_continuidad` y `assert_reconciliacion_uf_dolar` |
| E2 borde | en `ci`: la primera carga trae solo 11 días de UF completos | `assert_uf_continuidad` pasa (la ventana es de 11 días) |
| E3 negativo | en `ci`: se inyecta una licitación duplicada en silver | la assertion `uniqueKey` de `silver.licitaciones` falla y la invocación termina en error |
| E4 negativo | en `ci`: la UF de la BDE difiere de mindicador en 1,00 CLP | `assert_reconciliacion_uf_dolar` falla con la fecha |
| E5 borde | en `ci`: el dólar no tiene observaciones de viernes a lunes (feriado y fin de semana, 4 días) | `assert_dolar_continuidad` pasa; con 5 días falla |
Trazas: objetivo §Objetivo («calidad como código») · decisiones: DEC-001 · prueba: tests/acceptance/T-10*

### REQ-010 Cuarentena con motivo · estado: approved_for_impl · prioridad: must
Cuando una fila de raw no cumple una regla de fila (RUT con dígito verificador inválido, monto negativo, moneda fuera de
CLP/CLF/USD/UTM/EUR (la UF viene como `CLF`, T-02; antes decía UF, cambiado en LOG 2026-10-22), fecha fuera de 2000-01-01 … D+1 o clave nula), el sistema deberá escribirla en
`quarantine.<entidad>` con `motivos` (ARRAY de códigos de regla), `run_id` y `quarantined_at`, y no deberá pasarla a
silver.
Si una fila incumple varias reglas, entonces `motivos` deberá traerlas todas. Si una fila cumple todas, entonces no
deberá aparecer en cuarentena.
Ejemplos (aceptación):
| caso | entrada / contexto | resultado esperado |
|---|---|---|
| E1 positivo | grafo compilado | existen `quarantine.licitaciones` y `quarantine.ordenes_compra`, y silver filtra con el mismo predicado (las reglas viven en un solo archivo, `includes/reglas.js`) |
| E2 negativo | prueba unitaria de `includes/reglas.js` con RUT `12.345.678-0` (el DV correcto es 5) | devuelve `rut_dv_invalido` |
| E3 borde | fila con monto −1 y moneda `XYZ` | `motivos = ["monto_negativo", "moneda_desconocida"]` |
| E4 positivo | RUT `12.345.678-5`, monto 0, moneda `CLP` | sin motivos |
Trazas: objetivo §Objetivo («calidad como código») · decisiones: DEC-001 · prueba: tests/acceptance/T-10*

### REQ-011 Descripciones obligatorias persistidas · estado: approved_for_impl · prioridad: must
Cuando se compila Dataform, cada modelo y cada columna de silver, gold y quarantine deberá tener una descripción en
español (`description` y `columns` del `config`), que Dataform persiste en BigQuery.
Si un modelo o una columna no tiene descripción, entonces `npm run check:descriptions` (que corre en CI) deberá fallar
nombrando el modelo y la columna.
Ejemplos (aceptación):
| caso | entrada / contexto | resultado esperado |
|---|---|---|
| E1 positivo | el repo tal como queda tras T-09 | `npm run check:descriptions` sale en 0 |
| E2 negativo | un modelo de prueba sin descripción en la columna `monto` | sale distinto de 0 y nombra `monto` |
| E3 borde | una declaración de `sources` sin descripciones de columnas | no se exige (las fuentes raw son externas al grafo) |
| E4 positivo | en `ci`: `INFORMATION_SCHEMA.COLUMN_FIELD_PATHS` de `silver.licitaciones` | cada columna tiene `description` no vacía |
Trazas: objetivo §Alcance 2 (gobierno) · decisiones: DEC-001 · prueba: tests/acceptance/T-09*

### REQ-012 Capa final (gold) · estado: approved_for_impl · prioridad: must
Cuando Dataform corre, el sistema deberá materializar `gold.fct_licitaciones` y `gold.fct_ordenes_compra` (montos en CLP,
en UF de la fecha del documento y en USD al dólar observado), `gold.dim_comprador`, `gold.dim_proveedor` y
`gold.mart_organismo_mes` (monto adjudicado en UF, número de licitaciones, tasa de desiertas y de revocadas por
organismo y mes). Los hechos deberán estar particionados por fecha del documento, clusterizados por organismo y
proveedor y con `require_partition_filter = true`. Cada modelo de gold deberá declarar
`dependOnDependencyAssertions: true`: solo se promueve si pasan las assertions de los modelos de los que depende.
Si una assertion de un modelo de silver falla, entonces los modelos de gold que dependen de él no deberán actualizarse
en esa corrida. Si no hay valor del dólar para la fecha (fin de semana o feriado), entonces se deberá usar el último valor publicado
anterior y marcar `fx_imputado = TRUE`. Si no hay UF para la fecha, entonces el monto en UF deberá quedar `NULL` y la fila
no deberá descartarse.
Ejemplos (aceptación):
| caso | entrada / contexto | resultado esperado |
|---|---|---|
| E1 positivo | grafo compilado | los 2 hechos tienen `partitionBy`, `clusterBy` y `requirePartitionFilter: true` |
| E2 positivo | en `ci`: OC de 1.000.000 CLP con UF del día 40.000 | `monto_uf = 25` |
| E3 borde | en `ci`: OC de un domingo | `monto_usd` usa el dólar del viernes y `fx_imputado = TRUE` |
| E4 negativo | en `ci`: OC de una fecha sin UF | `monto_uf NULL` y la fila está en el hecho |
| E5 positivo | grafo compilado | cada modelo de gold tiene `dependOnDependencyAssertions: true` |
| E6 negativo | en `ci`: se inyecta una licitación duplicada en silver | `gold.fct_licitaciones` conserva su `last_modified_time` |
Trazas: objetivo §Alcance 3, «calidad como código» · decisiones: DEC-001 · prueba: tests/acceptance/T-12*

### REQ-013 Benchmark antes y después · estado: approved_for_impl · prioridad: must
Cuando el usuario corre `benchmarks/run.py`, el sistema deberá generar en `bench` las licitaciones sintéticas de S-12
con SQL determinista (DEC-007), crear tres variantes (sin partición; particionada por fecha; particionada y
clusterizada con `require_partition_filter`), correr cada query de `benchmarks/queries/` sobre cada variante con
`use_query_cache = false`, una etiqueta `bench_run` y `maximum_bytes_billed`, correr además dos reescrituras (`SELECT *`
contra columnas; self-join contra window function), leer `total_bytes_billed`, `total_bytes_processed` y
`total_slot_ms` de `INFORMATION_SCHEMA.JOBS` filtrando por la etiqueta, y escribir `benchmarks/results/<fecha>.md` con
la tabla y el porcentaje de ahorro de cada variante frente a la base.
Si un job aparece con `cache_hit = TRUE`, entonces el informe deberá excluirlo y marcarlo. Si se reportan números de un
dry run, entonces deberán ir rotulados como cota superior.
Ejemplos (aceptación):
| caso | entrada / contexto | resultado esperado |
|---|---|---|
| E1 positivo | `benchmarks/generate.sql` generado dos veces con la misma semilla (prueba local) | el mismo texto, con un conteo objetivo ≥ 30.000.000 filas |
| E2 positivo | filas de JOBS de ejemplo (fixture) para 3 variantes | tabla Markdown con bytes facturados, slot ms y % de ahorro, con la base en 0 % |
| E3 negativo | una fila del fixture con `cache_hit = TRUE` | queda fuera de la tabla y aparece en «Excluidos» |
| E4 borde | `--dry-run` | la columna se titula «bytes estimados (cota superior)» |
Trazas: objetivo §Criterio de éxito (3) · decisiones: DEC-003, DEC-007 · prueba: tests/acceptance/T-13*

### REQ-014 Policy tags sobre el RUT de personas naturales · estado: approved_for_impl · prioridad: must
Cuando se aplica Terraform, el sistema deberá crear una taxonomía `compras_publicas` con control de acceso fino activado
y la policy tag `dato_personal.rut`, conceder `roles/datacatalog.categoryFineGrainedReader` sobre ella solo a los
miembros de la variable `pii_readers` y a las cuentas de servicio de Dataform y de CI (que la leen al materializar), y
Dataform deberá asignar esa tag a `gold.dim_proveedor.rut_persona_natural` y a
`silver.proveedores.rut_persona_natural` (DEC-008). El nombre completo de la tag sale de Terraform (output
`policy_tag_rut`) y llega a Dataform como la variable de compilación `policy_tag_rut`, en el release config (T-11) y en la
corrida de `ci` de `deploy.yml`. `rut_empresa` y `proveedor_key` no llevan tag. `proveedor_key` = `TO_HEX(SHA256(CONCAT(sal, rut)))`, con la sal en
`pii.sal` (una fila, generada una vez, legible solo por la cuenta de servicio de Dataform), para que no se pueda revertir
calculando el hash de todos los RUT posibles; los MERGE y los joins usan `proveedor_key`, nunca la columna con tag. El
RUT de personas en bronze, `raw` y `quarantine` queda protegido por IAM (REQ-001 E6).
Si un usuario sin el rol consulta `rut_persona_natural`, entonces BigQuery deberá negar el acceso; si consulta las demás
columnas, deberá poder hacerlo.
Ejemplos (aceptación):
| caso | entrada / contexto | resultado esperado |
|---|---|---|
| E1 positivo | `terraform test` | taxonomía con `activated_policy_types = ["FINE_GRAINED_ACCESS_CONTROL"]`, la tag y bindings solo para `pii_readers` y las cuentas de servicio de Dataform y de CI |
| E2 positivo | grafo compilado con `--vars=policy_tag_rut=projects/p/locations/us-central1/taxonomies/1/policyTags/2` | las 2 columnas `rut_persona_natural` tienen esa tag y `rut_empresa` no tiene ninguna |
| E5 negativo | grafo compilado sin la variable `policy_tag_rut` | la compilación falla nombrando la variable |
| E6 positivo | grafo compilado | el `uniqueKey` de `silver.proveedores` y los joins de `gold.dim_proveedor` usan `proveedor_key`, y su SQL lee la sal de `pii.sal` |
| E7 positivo | integración: corrida diaria con la tag aplicada | la invocación de Dataform termina `SUCCEEDED` |
| E3 borde | prueba de la regla con RUT 49.999.999-2 y 50.000.000-7 | el primero va a `rut_persona_natural`, el segundo a `rut_empresa` |
| E4 negativo | integración: una cuenta de servicio de lectura sin el rol hace `SELECT rut_persona_natural` | error de acceso; `SELECT rut_empresa` funciona |
Trazas: objetivo §Objetivo («policy tags») · decisiones: DEC-008 · prueba: tests/acceptance/T-14*

### REQ-015 README de portafolio · estado: approved_for_impl · prioridad: must
Cuando un evaluador abre el repo, el README deberá tener, en este orden: resumen de una línea y diagrama de arquitectura;
qué demuestra (tabla requisito del rol → pieza del repo); cómo reproducir (prerrequisitos, bootstrap, carga de
secretos, apply, primera corrida); costos y FinOps (tope, cuotas, costo mensual medido); benchmark (la tabla de
`benchmarks/results/` más reciente y por qué los dry runs son cota superior); calidad (assertions, cuarentena y un
incidente real atrapado); gobierno (descripciones, policy tags); nota sobre el equivalente en GitLab CI; «Cómo se
construyó» (especificación y revisión del autor, implementación por agentes contra `spec/`); «Qué se rompió»; y la cita
a ChileCompra y al Banco Central como fuentes.
Si el README nombra «Data Catalog» como herramienta actual, cita un archivo o un comando que no existe, o le falta una
sección, entonces `npm run check:readme` deberá fallar.
Ejemplos (aceptación):
| caso | entrada / contexto | resultado esperado |
|---|---|---|
| E1 positivo | el README final | `npm run check:readme` sale en 0 |
| E2 negativo | se borra la sección «Qué se rompió» | sale distinto de 0 y la nombra |
| E3 negativo | el README enlaza `benchmarks/results/no-existe.md` | sale distinto de 0 y nombra la ruta |
| E4 negativo | el README dice «catalogado en Data Catalog» sin «ex» ni «se apagó» | sale distinto de 0 |
Trazas: objetivo §Criterio de éxito (1)(3) · decisiones: DEC-001 · prueba: tests/acceptance/T-15*

### REQ-016 Respaldo del estado de Terraform fuera del proyecto · estado: approved_for_impl · prioridad: must
Cuando `deploy.yml` termina un `terraform apply` de `infra/main` sin error, el sistema deberá copiar el estado
(`terraform state pull`) a `gs://<bucket de respaldo>/infra-main/<AAAAMMDDThhmmssZ>-<sha del commit>.tfstate`, en un
bucket de un proyecto GCP aparte (`var.backup_project_id`, S-15), fuera del filtro del presupuesto y de la
desvinculadora (DEC-003), versionado y en `us-central1`, con lifecycle que borra los objetos de más de 365 días. Cuando el
usuario aplica `infra/bootstrap`, `scripts/backup-state.sh bootstrap` deberá subir su estado local a
`bootstrap/<AAAAMMDDThhmmssZ>.tfstate` en el mismo bucket. La cuenta de servicio de CI solo puede crear objetos en ese
bucket (`roles/storage.objectCreator`), no leerlos ni borrarlos. El README (T-15) documenta cómo restaurar.
Si la copia falla, entonces el job deberá terminar en error (el apply ya ocurrió, pero el fallo se ve). Si
`scripts/backup-state.sh` no encuentra el estado local, entonces deberá salir distinto de 0 y nombrar la ruta.
Ejemplos (aceptación):
| caso | entrada / contexto | resultado esperado |
|---|---|---|
| E1 positivo | `terraform test` del bootstrap con `backup_project_id = "demo-backup"` | bucket de respaldo en ese proyecto, `US-CENTRAL1`, versionado, con una regla de lifecycle de 365 días |
| E2 negativo | `terraform test` del bootstrap | la cuenta de servicio de CI tiene sobre el bucket de respaldo solo `roles/storage.objectCreator`; ningún rol de lectura ni de borrado |
| E3 positivo | `.github/workflows/deploy.yml` | después del paso de apply, un paso corre `terraform state pull` y sube el archivo a `infra-main/` con `${{ github.sha }}` en el nombre |
| E4 positivo | `scripts/backup-state.sh bootstrap` con un `gcloud` simulado y `infra/bootstrap/terraform.tfstate` presente | una sola llamada de copia hacia `gs://<bucket>/bootstrap/<marca de tiempo>.tfstate` |
| E5 negativo | `scripts/backup-state.sh bootstrap` sin `infra/bootstrap/terraform.tfstate` | sale distinto de 0 y nombra `infra/bootstrap/terraform.tfstate` |
| E6 positivo | integración: tras un deploy, `gcloud storage ls` del bucket de respaldo | aparece el objeto del commit; restaurarlo con `terraform state push` en una copia de prueba funciona |
Trazas: objetivo §Criterio de éxito (1) · decisiones: DEC-003, DEC-004, DEC-009 · prueba: tests/acceptance/T-17*

## Supuestos (no bloqueantes, con valor por defecto)
| ID | creemos que… | valor por defecto | clase | disparador de revisión |
|---|---|---|---|---|
| S-01 | el usuario crea el proyecto GCP y le vincula el billing a mano | `project_id` es una variable; Terraform no crea el proyecto | reversible | el usuario quiere que Terraform cree el proyecto |
| S-02 | el ticket de Mercado Público y las credenciales de la BDE los obtiene el usuario | secretos vacíos; ingesta probada con HTTP simulado | no bloqueante | T-06/T-07 en integración sin credenciales |
| S-03 | el repo de GitHub `compras-publicas-cl` es público y lo crea el usuario | `github_repository` es una variable `owner/nombre` | reversible | se quiere privado |
| S-04 | un RUT menor que 50.000.000 es de una persona natural | umbral 50.000.000 en `includes/reglas.js` | reversible | aparece un campo explícito de tipo de persona |
| S-05 | la corrida diaria cabe en la ventana 22:00–07:00 | Scheduler 23:30 America/Santiago, D = ayer | reversible | la corrida tarda más de 7 h |
| S-06 | 9.000 requests diarios dejan margen sobre el límite de 10.000 y alcanzan para el día a día (~8.500 por día hábil; ~2,03 M OC en 2024, chilecompra.cl) | `MP_DAILY_REQUEST_BUDGET=9000` | reversible | ChileCompra cambia el límite, o el cursor acumula más de 3 días de atraso |
| S-07 | 50 GiB de query diarios y 20 GiB por usuario bastan | cuota de proyecto `QueryUsagePerDay` 50 GiB/día; cuota por usuario `QueryUsagePerUserPerDay` 20 GiB/día (alcanza a la cuenta de servicio de Dataform); los scripts fijan `maximum_bytes_billed` (≤ 20 GiB). La unidad del valor en la API la confirma T-05 (antes: «`maximumBytesBilled` 10 GiB», que Dataform no tiene; LOG 2026-10-22) | reversible | el benchmark o una corrida chocan con la cuota |
| S-15 | el usuario crea un segundo proyecto GCP para el respaldo del estado, ligado a la misma cuenta de facturación y fuera del filtro del presupuesto | `backup_project_id` es una variable obligatoria del bootstrap; costo cercano a 0 (un bucket con archivos de KB) | reversible | el respaldo se quiere fuera de GCP |
| S-14 | la API de Mercado Público trae un campo de fecha de última modificación por documento | T-02: la OC trae `Fechas.FechaUltimaModificacion` (`fecha_cambio` = ese campo); la licitación no trae ninguno (`fecha_cambio` = `ingested_at` para licitaciones e ítems) | resuelto | — |
| S-08 | las series de la BDE son UF `F073.UFF.PRE.Z.D`, dólar observado `F073.TCO.PRE.Z.D` e IPC `F074.IPC.VAR.Z.Z.C.M` | esas tres; T-02 no pudo confirmarlas sin token: las confirma `SearchSeries` en el `verify_integration` de T-07 | reversible | `SearchSeries` no las trae |
| S-09 | BDE y mindicador coinciden hasta el centavo | tolerancia ≤ 0,01 CLP en UF y dólar | reversible | la reconciliación falla sin error real |
| S-10 | `terraform test` con `mock_provider` prueba `infra/` sin credenciales y lee pruebas fuera del módulo con `-test-directory` (2026-10-22, T-01: lo primero se cumple; lo segundo no, y `scripts/acceptance.sh` copia el archivo a la raíz) | pruebas de infra en `tests/acceptance/T-NN*.tftest.hcl`; si no se puede, `scripts/acceptance.sh` copia el archivo al módulo antes de correrlo | reversible | T-01 lo descarta |
| S-11 | no hace falta `spec/COVERAGE.json` en este corte | sin regla de cobertura desde aceptación | diferible | un corte futuro la pide |
| S-12 | 30 a 50 millones de filas sintéticas (~3–5 GB) bastan para que se note la diferencia | 40.000.000 filas, 5 años de fechas, 2.000 organismos | reversible | el ahorro medido es menor que 50 % |
| S-13 | los nombres de recursos del proveedor `google` (Dataform, taxonomía de policy tags, cuota de BigQuery, presupuesto) siguen vigentes tras el apagado de Data Catalog | los que confirme T-02 | requiere spike | T-02 |
| S-16 | una variable con `default = null` y un bloque `validation` cumple «variable obligatoria» de REQ-001: `terraform plan` sin ella falla con un mensaje que la nombra, sin pedirla interactivamente | `project_id`, `region` y `github_repository` con `default = null` y validación en las dos raíces | reversible | se quiere que Terraform pida la variable de forma interactiva o que falte sin default |
| S-17 | las «cuentas de servicio del pipeline» de REQ-001 son las de ingesta, Dataform, Workflow y CI; la de CI lee bronze y los datasets por sus roles de proyecto, no por bindings en esos recursos | bronze y los datasets restringidos (raw, raw_ci, quarantine, quarantine_ci, pii) solo dan acceso a esas cuentas y a projectOwners | reversible | otro principal (analista, BI) necesita leer bronze o una capa restringida |

## Preguntas abiertas
| ID | pregunta | clase (bloqueante/costosa/spike/diferible) | bloquea a | responsable | vence |
|---|---|---|---|---|---|
| Q-01 | ¿El proyecto GCP va en una cuenta nueva (crédito de USD 300 por 90 días) o en una existente? | resuelta 2026-10-21: cuenta nueva (respuesta del usuario) | — | usuario | — |
| Q-02 | ¿Ya tienes el ticket de Mercado Público (Clave Única) y el usuario de la BDE? | diferible; 2026-10-21: todavía no, los obtiene el usuario | `verify_integration` de T-06, T-07 | usuario | antes de la primera corrida real |
| Q-03 | ¿Cuál es el correo de las alertas (presupuesto y Workflow)? | resuelta 2026-10-21: el Gmail del usuario; va en la variable `alert_email` de un `terraform.tfvars` fuera de git (repo público, R-05) | — | usuario | — |
| Q-04 | ¿Cómo sigue T-01? El orquestador la escaló por la causa de su fallo según el decisor (DEC-015): el decisor (jev) no resolvió la causa del fallo (confidence 0.76 < 0.8 (threshold)) (sin informe). | resuelta 2026-10-22: T-01 y T-02 se implementan en sesión interactiva, que tiene red y web (el implementador del autopilot no tiene ninguna de las dos); decisión reversible según los criterios del usuario | — | Claude (sesión) | — |
| Q-05 | ¿Cómo sigue T-03? El orquestador la escaló con sus pruebas de aceptación (DEC-006): el test-author no entregó pruebas válidas: autopilot: the test-author left no result in /home/pepe/Projects/compras-publicas-cl/.autopilot/2026-10-22_003936/T-03-tests-result.json (sin informe). | resuelta 2026-10-22: el perfil del test-author de sdd-base no le deja escribir su archivo de resultado (falla de sdd-base, también en T-06); se apaga AUTOPILOT_TEST_AUTHOR en este repo y T-03 sigue con el implementador | — | Claude (sesión) | — |
| Q-06 | Respondida 2026-10-22 por José Pedro Lübbert, en sesión: el fallo de T-06 fue un rechazo de formato del resultado (líneas «Verificado» en el log), no de la implementación; con sdd-base 5e44412 (T-117) el orquestador descarta esas líneas en vez de rechazar, y T-06 vuelve a ready para reintentar. | bloqueante | nada | usuario | — |

## Plan (corte 1)
### Diseño
- `infra/bootstrap/`: estado, WIF, cuenta de servicio de CI, presupuesto y desvinculadora (lo aplica el usuario).
  `infra/main/` con módulos en `infra/modules/` (storage, bigquery, iam, secrets, ingest_job, orchestration, finops,
  governance); el estado vive en el bucket del bootstrap (DEC-001, DEC-003, DEC-004).
- `ingest/`: paquete Python `compras_ingest` (clientes `mercadopublico`, `bcentral` y `mindicador`; `bronze` para GCS;
  `load` para BigQuery; `cli`), con su `Dockerfile`. Las pruebas unitarias van en `ingest/tests/`.
- `finops/killswitch/`: la función desvinculadora (DEC-003).
- `dataform/`: `workflow_settings.yaml`, `definitions/sources` (declaraciones de raw), `definitions/intermediate`
  (silver y cuarentena), `definitions/outputs` (gold), `definitions/assertions`, `includes/reglas.js` (reglas de fila
  y de RUT).
- `orchestration/daily.yaml`: el Workflow (DEC-002).
- `benchmarks/`: `generate.sql`, `queries/`, `run.py`, `report.py`, `results/` (DEC-007).
- `scripts/`: `setup.sh` (herramientas fijadas, la única con red), `acceptance.sh` (runner por extensión, DEC-005),
  `ci/` (check:repo, check:descriptions, check:readme). `package.json` agrega los comandos.
- `.github/workflows/ci.yml` y `deploy.yml` (DEC-004).

### Orden y dependencias
Fase 1, plataforma:
1. T-01 Entorno y esqueleto andante (tooling) — sin dependencias
2. T-02 Spike: recursos de Terraform y APIs de las fuentes — sin dependencias
3. T-03 Infraestructura base (REQ-001) — T-01, T-02
4. T-04 CI/CD en GitHub Actions (REQ-002) — T-03
5. T-05 Tope de gasto (REQ-003) — T-03

Fase 2, datos:
6. T-06 Ingesta de Mercado Público (REQ-004) — T-01, T-02
7. T-07 Ingesta del Banco Central y mindicador (REQ-005) — T-06
8. T-08 Carga a raw, Cloud Run Jobs y despliegue de imágenes (REQ-006) — T-03, T-04, T-07
9. T-09 Silver en Dataform y descripciones (REQ-008, REQ-011) — T-08
10. T-10 Assertions y cuarentena (REQ-009, REQ-010) — T-09
11. T-11 Orquestación diaria (REQ-007) — T-05, T-10

Fase 3, valor:
12. T-12 Capa final gold y promoción (REQ-012) — T-10
13. T-13 Benchmark antes y después (REQ-013) — T-05, T-12
14. T-14 Policy tags (REQ-014) — T-03, T-11, T-12
15. T-15 README de portafolio (REQ-015) — T-04, T-11, T-13, T-14, T-17
16. T-17 Respaldo del estado de Terraform fuera del proyecto (REQ-016) — T-04, T-05 (pedido del usuario, 2026-10-22)

### Riesgos y spikes
| riesgo | mitigación |
|---|---|
| Los recursos de Terraform para Dataform, policy tags o la cuota de BigQuery cambiaron de nombre (Data Catalog se apagó) | spike T-02 antes de T-03; S-13 |
| La semántica SQL solo se prueba en BigQuery | los ejemplos marcados «en `ci`» corren en la corrida aislada de CI (deploy.yml) y en `verify_integration`; localmente se prueba el grafo compilado y `includes/reglas.js` (DEC-005) |
| La desvinculación del billing detiene el proyecto | umbral configurable; procedimiento de revinculación en el README; prueba con presupuesto de USD 0,01 en un proyecto desechable |
| El límite de 10.000 requests diarios queda justo en días pico | cursor y presupuesto de requests (REQ-004 E4, E8); el atraso se recupera el fin de semana; sin backfill histórico en este corte |
| La cuenta de servicio de CI necesita `roles/run.admin` para desplegar los jobs y con él podría tocar la función desvinculadora (que también es un servicio de Cloud Run) | riesgo residual aceptado en DEC-003: CI no tiene roles de billing ni de Pub/Sub; el README lo declara; un proyecto aparte para la desvinculadora queda para un corte futuro |
| El conector de Workflows corta a los 1800 s por defecto | `connector_params.timeout` explícito (REQ-007) |
| El token de GitHub de Dataform caduca | token fine-grained de solo lectura con caducidad anotada en el README; la corrida falla y se ve (REQ-007) |
| El repo se ve hecho por agentes | `spec/` versionado, secciones «Cómo se construyó» y «Qué se rompió»; el usuario lo clona y lo corre en limpio antes de postular |

## Criterio de cierre del corte (declarado antes del análisis)
- [x] Objetivo y exclusiones confirmados por el responsable (pedido del usuario del 2026-10-21 y respuestas sobre el
  tope y el benchmark)
- [x] Cada REQ con ID, ≥1 ejemplo positivo y ≥1 negativo/borde
- [x] Sin preguntas bloqueantes/costosas abiertas que el corte consuma (Q-01 a Q-03 son diferibles y solo afectan la
  integración)
- [x] Decisiones globales consumidas en `accepted` o con spike en curso (DEC-001 a DEC-008 aceptadas por José Pedro
  Lübbert el 2026-10-21; S-13 y S-14 con el spike T-02)
- [x] Conjunto coherente: objetivo→REQ→ejemplo, sin conflictos, glosario
- [x] Revisión independiente sin bloqueos nuevos (10 hallazgos corregidos; crítica ESCALAR resuelta por el usuario)
- Presupuesto del bloque: 1 sesión; al agotarse: cortar (la fase 3 pasa a «Cortes futuros»)
