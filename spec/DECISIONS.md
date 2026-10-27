# Registro de decisiones

<!--
DEC-035 (sdd-base): las decisiones caras de revertir (las que cambian el contrato de spec/, un límite de autoridad o
seguridad, el stack o la arquitectura) son ADR en spec/adr/NNNN-<titulo>.md, con el formato de spec/adr/README.md:
nacen `proposed` (node scripts/adr.mjs new "<título>") y las acepta Jev (node scripts/adr.mjs accept NNNN, DEC-036).
Un ADR aceptado no se edita: se supersede con uno nuevo, y el viejo pasa a "superseded by NNNN".
Las reversibles (se apagan con una opción o tocan un solo componente) van como `## DEC-NNN` debajo del índice:

## DEC-NNN <título como frase nominal>
- Estado: accepted | accepted | rejected | superseded by DEC-NNN
- Alcance: global | local
- Fecha: <AAAA-MM-DD> · Aprobador: <persona o rol> · Confianza: alta | media | baja
- Problema: <contexto y fuerzas, neutral>
- Alternativas consideradas:
  1. <A> — a favor: … ; en contra: …
- Decisión: Usaremos <X> y no <Y>, para lograr <beneficio>, aceptando <costo>.
- Consecuencias: buenas: … ; malas: … ; neutrales: …
- Confirmación: <prueba o chequeo que la verifica>
- Revisar si: <condición concreta que reabre la decisión>

El índice lo genera `node scripts/adr.mjs index`; check-adr falla si no está al día.
-->

<!-- adr-index:start -->
<!-- generado por `node scripts/adr.mjs index`; no se edita a mano (DEC-035) -->

| ID | Título | Estado | Dónde |
|---|---|---|---|
| DEC-001 | Arquitectura lakehouse medallion en GCP us-central1 sin Composer | accepted | [ADR](adr/0001-arquitectura-lakehouse-medallion-en-gcp-us-central1-sin.md) |
| DEC-002 | Orquestación con Cloud Scheduler, Workflows y Dataform conectado a GitHub | accepted | [ADR](adr/0002-orquestacion-con-cloud-scheduler-workflows-y-dataform.md) |
| DEC-003 | Tope de gasto duro con presupuesto, desvinculación de billing y cuotas | accepted | [ADR](adr/0003-tope-de-gasto-duro-con-presupuesto-desvinculacion-de.md) |
| DEC-004 | Secretos en Secret Manager cargados a mano y CI sin llaves | accepted | [ADR](adr/0004-secretos-en-secret-manager-cargados-a-mano-y-ci-sin-llaves.md) |
| DEC-005 | Verificación local sin nube y verificación de integración aparte | accepted | [ADR](adr/0005-verificacion-local-sin-nube-y-verificacion-de-integracion.md) |
| DEC-006 | Bronze en JSONL crudo por fecha y corrida, deduplicado en silver | accepted | [más abajo](#dec-006-bronze-en-jsonl-crudo-por-fecha-y-corrida-deduplicado-en-silver) |
| DEC-007 | Benchmark sobre datos sintéticos a escala GB generados en BigQuery | accepted | [más abajo](#dec-007-benchmark-sobre-datos-sintéticos-a-escala-gb-generados-en-bigquery) |
| DEC-008 | RUT de persona natural en columna propia con policy tag | accepted | [más abajo](#dec-008-rut-de-persona-natural-en-columna-propia-con-policy-tag) |
| DEC-009 | Ajustes del spike T-02 a DEC-002, DEC-003 y DEC-004 | accepted | [ADR](adr/0009-ajustes-del-spike-t-02-a-dec-002-dec-003-y-dec-004.md) |
| DEC-010 | Dataform compila desde la rama derivada `dataform-main` | accepted | [más abajo](#dec-010-dataform-compila-desde-la-rama-derivada-dataform-main) |
| DEC-011 | Gate de calidad: cuarentena sobre umbral o silver sin frescura bloquean gold | accepted | [ADR](adr/0011-gate-de-calidad-cuarentena-sobre-umbral-o-silver-sin.md) |
| DEC-012 | Registro de corridas en `raw.corridas`: el día es OK solo si la última corrida fue OK | accepted | [más abajo](#dec-012-registro-de-corridas-en-rawcorridas-el-día-es-ok-solo-si-la-última-corrida-fue-ok) |

<!-- adr-index:end -->

## Decisiones reversibles (no migradas a ADR, DEC-035)

## DEC-006 Bronze en JSONL crudo por fecha y corrida, deduplicado en silver
- Estado: accepted
- Alcance: global
- Fecha: 2026-10-21 · Aprobador: José Pedro Lübbert (aprobación nominal del corte 1) · Confianza: alta
- Problema: la ingesta se reintenta y se reprocesa (backfill, revisiones del Banco Central). Hace falta que repetir una
  fecha no duplique datos y que lo crudo quede tal como llegó.
- Alternativas consideradas:
  1. JSONL crudo en `gs://<bucket>/<fuente>/<entidad>/fecha=AAAA-MM-DD/run=<run_id>/part-NNNN.jsonl`, carga `WRITE_APPEND`
     a `raw.<fuente>_<entidad>` (particionada por `_ingest_date`, con `run_id`), y dedup en silver por clave y versión —
     a favor: es inmutable y auditable, permite reprocesar sin volver a llamar a la API, y repetir no duplica en silver;
     en contra: raw crece con cada repetición (el lifecycle lo acota).
  2. Sobrescribir la partición de la fecha en raw (`WRITE_TRUNCATE` por partición) — a favor: raw queda sin repetidos;
     en contra: se pierde la historia de versiones de una licitación que cambia de estado.
- Decisión: Usaremos la opción 1, y no la 2, para conservar cada versión y poder reprocesar, aceptando que raw tenga
  repetidos acotados por el lifecycle (bronze en GCS: Nearline a los 30 días y borrado a los 365; raw: expiración de
  partición de 400 días).
- Consecuencias: buenas: la idempotencia es una propiedad de silver; malas: raw no sirve para consultas directas;
  neutrales: `run_id` = `AAAAMMDDThhmmssZ-<8 hex>`.
- Confirmación: el ejemplo E3 de REQ-006 y el E2 de REQ-008.
- Revisar si: el volumen de raw supera el free tier de almacenamiento.

## DEC-007 Benchmark sobre datos sintéticos a escala GB generados en BigQuery
- Estado: accepted
- Alcance: local
- Fecha: 2026-10-21 · Aprobador: José Pedro Lübbert (elegido y aprobado en sesión) · Confianza: alta
- Problema: a escala de MB, los mínimos de facturación de BigQuery hacen que el antes y después del benchmark no
  signifique nada.
- Alternativas consideradas:
  1. Licitaciones sintéticas (S-12) generadas con SQL determinista (`GENERATE_ARRAY` y `FARM_FINGERPRINT` con semilla
     fija) y con el esquema de silver — a favor: es reproducible, la generación no escanea bytes y cabe en el free tier;
     en contra: no son datos reales.
  2. Una copia acotada de un dataset de `bigquery-public-data` — a favor: datos reales; en contra: dominio ajeno y la
     copia consume cuota.
  3. Datos reales de ChileCompra — a favor: el dominio propio; en contra: tardaría semanas en tener volumen.
- Decisión: Usaremos la opción 1, y no la 2 ni la 3, para que el benchmark use las mismas queries de la capa final a un
  volumen donde la diferencia se nota, aceptando que los datos son sintéticos (el README lo dice).
- Consecuencias: buenas: cualquiera puede reproducir la tabla; malas: unos GB de almacenamiento mientras el dataset
  exista; neutrales: el dataset `bench` tiene expiración de tabla de 30 días.
- Confirmación: el ejemplo E1 de REQ-013.
- Revisar si: los datos reales superan los 5 GB.

## DEC-008 RUT de persona natural en columna propia con policy tag
- Estado: accepted
- Alcance: local
- Fecha: 2026-10-21 · Aprobador: José Pedro Lübbert (aprobación nominal del corte 1) · Confianza: media
- Problema: las policy tags de BigQuery se aplican por columna, no por fila. El RUT de un proveedor persona natural es
  dato personal; el de una empresa no lo es.
- Alternativas consideradas:
  1. Separar en `rut_persona_natural` (con policy tag `dato_personal.rut`) y `rut_empresa` (sin tag), y unir por
     `proveedor_key` = `TO_HEX(SHA256(CONCAT(sal, rut)))`, con la sal en `pii.sal` (sin sal, el hash se revierte
     calculándolo para los 50 millones de RUT posibles; crítica del plan, 2026-10-21) — a favor: el RUT de empresa sigue visible para el análisis; en contra:
     dos columnas en vez de una.
  2. Una sola columna `rut_proveedor` con tag — a favor: es más simple; en contra: se oculta también el RUT de las
     empresas, que es público y útil.
  3. Data masking dinámico (regla de enmascaramiento sobre el tag) — a favor: muestra el patrón completo; en contra:
     agrega complejidad sin mejorar el portafolio en este corte.
- Decisión: Usaremos la opción 1, y no la 2, para ocultar solo el dato personal, aceptando la regla de S-04 para separar
  personas de empresas.
- Consecuencias: buenas: los joins no necesitan el RUT; malas: la regla de S-04 es una heurística; neutrales: el
  enmascaramiento queda para un corte futuro.
- Confirmación: los ejemplos de REQ-014.
- Revisar si: aparece en los datos un campo explícito de tipo de persona.

## DEC-010 Dataform compila desde la rama derivada `dataform-main`
- Estado: accepted
- Alcance: local
- Fecha: 2026-10-26 · Aprobador: Claude (decisión reversible dentro de DEC-002; la acepta en lote José Pedro Lübbert) · Confianza: alta
- Problema: el repositorio de Dataform (DEC-002) clona la raíz del remoto de GitHub y no admite subcarpetas (la API
  `GitRemoteSettings` solo tiene `url`, `defaultBranch` y el secreto del token). El proyecto Dataform vive en
  `dataform/`, así que compilar desde `main` falla antes de llegar al código: Dataform corre `npm ci` con el
  `package.json` de la raíz, que no tiene lockfile, y aunque lo tuviera no encontraría `workflow_settings.yaml`. Se vio
  en la primera corrida real del Workflow (2026-10-26), después de arreglar el token (DEC-004).
- Alternativas consideradas:
  1. Una rama `dataform-main` generada con `git subtree split --prefix dataform` y publicada por el job `release` de
     `deploy.yml` tras cada corrida verde en `ci`; el Workflow y el release config compilan desde ella — a favor:
     mantiene DEC-002 y la estructura del repo, un paso de CI y una línea en Terraform; en contra: una rama derivada
     más en GitHub, publicada con `--force`, y `release` necesita `contents: write`.
  2. Mover el proyecto Dataform a la raíz del repo — a favor: sin rama derivada; en contra: rompe la estructura
     documentada en AGENTS.md y README, el CI y las rutas de todas las tareas.
  3. Un Cloud Run Job con la CLI de Dataform (opción 2 de DEC-002) — a favor: no necesita GitHub; en contra: supersede
     DEC-002 y se pierde el historial de invocaciones en la consola.
- Decisión: Usaremos la opción 1 y no la 2, para que el Workflow compile el proyecto real sin reordenar el repo,
  aceptando una rama derivada que solo escribe el CI.
- Consecuencias: buenas: la compilación desde `dataform-main` ya se probó a mano con las variables del Workflow
  (compilación `052a86d6`, commit `3cbfbc4d`, sin errores); malas: `dataform-main` va un deploy por detrás de `main`
  si `release` falla antes de publicarla; neutrales: el token sigue siendo de solo lectura para Dataform, el push lo hace
  `GITHUB_TOKEN`.
- Confirmación: `test_compilacion_desde_dataform_main_con_vars` en `orchestration/tests/test_daily.py`, los runs
  `t11_repositorio_dataform` y el del release config en `infra/main/tests/main.tftest.hcl`, y la primera corrida
  `SUCCEEDED` de `scripts/it/run-workflow.sh` (5.7 de la demo).
- Revisar si: Dataform admite un subdirectorio del remoto, o el repo pasa a tener el proyecto Dataform en la raíz.

## DEC-012 Registro de corridas en `raw.corridas`: el día es OK solo si la última corrida fue OK
- Estado: accepted
- Alcance: local
- Fecha: 2026-10-27 · Aprobador: José Pedro Lübbert (sesión 2026-10-27: «Sí a 4b. Regla: dim_corrida toma la última
  corrida por run_id; el día es OK solo si la última fue OK») · Confianza: alta
- Problema: cuando el job de Mercado Público agota el presupuesto de requests termina con código 0 y un aviso en el
  registro (REQ-004); el Workflow seguía como si el día estuviera completo y gold se reconstruía sin marca. Ni el
  operador ni quien consulta gold sabían que el día quedó parcial.
- Alternativas consideradas:
  1. Una fila por corrida en `raw.corridas`, cargada por el propio job al terminar (carga por lote, gratis) con `estado`
     OK, PARCIAL o ERROR; el Workflow la consulta justo después del job (última fila por `run_id`), registra `WARNING`
     y devuelve `estado_dia`, y `gold.dim_corrida` la resume por fuente y fecha de ingesta con la misma regla — a favor:
     un solo mecanismo para el operador y para gold, sin reloj ni GCS; en contra: el job gana una escritura más, y si no
     puede escribirla termina con código 1 (fail-closed: el Workflow no toma la corrida anterior por la de hoy).
  2. Leer el cursor de GCS desde el Workflow (existe solo si el día quedó a medias) — a favor: sin tabla nueva; en
     contra: gold no lo ve, y serían dos mecanismos para el mismo hecho.
  3. Código de salida distinto de 0 en el job — a favor: nada que leer; en contra: el Workflow falla y Dataform no corre
     con los datos parciales, que son válidos.
- Decisión: la opción 1. `dim_corrida` toma la última corrida del día por `run_id` (su prefijo es la hora UTC de
  inicio): un reintento completo después de una corrida parcial deja el día OK; una parcial después de una completa lo
  deja PARCIAL. `raw.corridas` no es una entidad de bronze: es el registro del job (REQ-006 no cambia).
- Consecuencias: buenas: el correo de «Ingesta parcial» sale esa noche y `mart_organismo_mes.n_licitaciones_dias_parciales`
  dice cuántas licitaciones del mes vienen de días incompletos; malas: una fila más por corrida y dos permisos más para la
  cuenta del Workflow (`bigquery.jobUser` y lectura de raw); neutrales: sin fila (primera corrida) el Workflow devuelve
  `SIN_REGISTRO`.
- Confirmación: `ingest/tests/test_corridas.py` (OK, PARCIAL, ERROR y la escritura fallida), `orchestration/tests/test_daily.py`
  (pasos nuevos), `dataform/tests/corridas.test.mjs` y `scripts/it/corridas-sql.sh` (la regla contra BigQuery: 4 casos, 0
  diferencias el 2026-10-27), `t08_raw_tables`, `t11_e4_alerta` y `t11_permisos` de `infra/main/tests/main.tftest.hcl`.
- Revisar si: aparece otra fuente de ingesta (sumarla a `dim_corrida`), o el job deja de ser quien escribe el registro.
