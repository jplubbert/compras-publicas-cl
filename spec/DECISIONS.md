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
