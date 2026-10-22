# Plan de corte-1

## Objetivo
Lakehouse medallion en GCP (`compras-publicas-cl`) que ingiere a diario Mercado Público (licitaciones y órdenes de
compra) y Banco Central (UF, dólar observado, IPC), con mindicador.cl como segunda fuente para reconciliar. Todo se
despliega con Terraform y GitHub Actions (WIF). Cuesta USD 0 a 1 al mes, con corte duro a los USD 10, y entrega tres
evidencias de portafolio: el benchmark con `INFORMATION_SCHEMA.JOBS`, calidad como código y policy tags.
Criterio de cierre del corte: los REQ-001 a REQ-015 tienen ejemplos positivos y negativos o de borde, no quedan
preguntas bloqueantes que el corte consuma, las DEC-001 a DEC-008 se aceptan con la aprobación del usuario, la revisión
independiente no deja bloqueos y check:spec pasa.

## Pasos
1. T-01 Entorno fijado y esqueleto andante (tooling) — DEC-001, DEC-004, DEC-005 — sin dependencias.
2. T-02 Spike: recursos de Terraform (Dataform, policy tags tras el apagado de Data Catalog, cuota de BigQuery,
   presupuesto, Cloud Run function, WIF) y APIs de las fuentes — DEC-001, DEC-002, DEC-003 — sin dependencias.
3. T-03 Infraestructura base — REQ-001 — DEC-001, DEC-004, DEC-005 — depende de T-01 y T-02.
4. T-04 CI/CD en GitHub Actions con WIF — REQ-002 — DEC-004, DEC-005 — depende de T-03.
5. T-05 Tope de gasto duro (presupuesto de USD 10 → Pub/Sub → función que desvincula el billing; cuota diaria de
   BigQuery; maximumBytesBilled) — REQ-003 — DEC-003, DEC-005 — depende de T-03.
6. T-06 Ingesta de Mercado Público a bronze — REQ-004 — DEC-004, DEC-006 — depende de T-01 y T-02.
7. T-07 Ingesta del Banco Central y mindicador a bronze — REQ-005 — DEC-004, DEC-006 — depende de T-06.
8. T-08 Carga a BigQuery raw, Cloud Run Jobs y despliegue de imágenes — REQ-006 — DEC-001, DEC-004, DEC-006 — depende de T-03, T-04 y T-07.
9. T-09 Silver incremental en Dataform y descripciones obligatorias — REQ-008, REQ-011 — DEC-001, DEC-005, DEC-006 —
   depende de T-08.
10. T-10 Assertions, promoción y cuarentena — REQ-009, REQ-010 — DEC-001, DEC-005 — depende de T-09.
11. T-11 Orquestación diaria (Scheduler → Workflows → Cloud Run Jobs → Dataform) — REQ-007 — DEC-002, DEC-004, DEC-005 —
    depende de T-05 y T-10.
12. T-12 Capa final gold y promoción por assertions — REQ-012 — DEC-001, DEC-008 — depende de T-10.
13. T-13 Benchmark antes y después sobre datos sintéticos a escala GB — REQ-013 — DEC-003, DEC-007 — depende de T-05 y
    T-12.
14. T-14 Policy tags sobre el RUT de personas naturales — REQ-014 — DEC-004, DEC-008 — depende de T-03, T-11 y T-12.
15. T-15 README de portafolio — REQ-015 — DEC-001 — depende de T-04, T-11, T-13 y T-14.

## Archivos
Repo `~/Projects/compras-publicas-cl` (nuevo, creado con bootstrap de sdd-base):
- `spec/SPEC.md`: objetivo, alcance, R-01 a R-07, glosario, REQ-001 a REQ-015, S-01 a S-13, Q-01 a Q-03, plan.
- `spec/adr/0001` a `0005` (DEC-001 a DEC-005, proposed) y `spec/DECISIONS.md` (DEC-006 a DEC-008, proposed, e índice).
- `spec/TASKS.json`: T-01 a T-15 en specified.
- `spec/LOG.md`: entrada del corte.
- `AGENTS.md` y `scripts/autopilot.config.sh`: marcadores reemplazados; test-author, puerta de planes e investigador
  activados; patrón de integración (`scripts/it/`, terraform plan/apply, gcloud, bq, gsutil).

## Supuestos
- S-01 El usuario crea el proyecto GCP y le vincula el billing; `project_id` es una variable.
- S-02 El ticket de Mercado Público y las credenciales de la BDE los obtiene el usuario; la ingesta se prueba con HTTP
  simulado.
- S-03 El repo de GitHub es público y lo crea el usuario.
- S-04 Un RUT menor que 50.000.000 es de una persona natural.
- S-05 Scheduler a las 23:30 America/Santiago; D = ayer.
- S-06 Presupuesto de 9.000 requests diarios a Mercado Público; alcanza para el día a día (~8.500 por día hábil).
- S-14 La API de Mercado Público trae una fecha de última modificación por documento (la confirma T-02).
- S-07 Cuota de 50 GiB de query al día; 10 GiB por consulta.
- S-08 Series de la BDE: F073.UFF.PRE.Z.D, F073.TCO.PRE.Z.D, F074.IPC.VAR.Z.Z.C.M.
- S-09 Tolerancia de reconciliación ≤ 0,01 CLP.
- S-10 `terraform test` con `mock_provider` funciona sin credenciales y lee pruebas fuera del módulo.
- S-11 Sin spec/COVERAGE.json en este corte.
- S-12 40 millones de filas sintéticas (~3–5 GB).
- S-13 Los nombres de recursos del proveedor google siguen vigentes tras el apagado de Data Catalog (los confirma T-02).

## Riesgos
- Recursos de Terraform renombrados tras el apagado de Data Catalog (policy tags, Dataform): mitiga T-02.
- La semántica SQL solo se prueba en BigQuery (corrida aislada de CI con schemaSuffix `ci` y `raw_ci`, y en
  verify_integration); localmente se prueba el
  grafo compilado.
- La desvinculación del billing detiene el proyecto; el dato de costo llega con retraso y se puede pasar algo del tope.
- El límite de 10.000 requests diarios de Mercado Público queda justo en días pico (~8.500 requests por día hábil):
  cursor y presupuesto de requests; sin backfill histórico en este corte (decisión del usuario, 2026-10-21).
- La cuenta de servicio de CI con roles/run.admin podría tocar la función desvinculadora (riesgo residual aceptado en
  DEC-003).
- El repositorio Dataform conectado a GitHub necesita un token de solo lectura que caduca.
- Percepción de un repo hecho por agentes: spec/ versionado y secciones «Cómo se construyó» y «Qué se rompió».

## Verificación
- Cada tarea: su `verify` local, sin red ni credenciales (npm run test:infra / test:ingest / test:dataform /
  test:finops / test:workflows / test:orchestration / test:benchmarks, check:repo, check:descriptions, check:readme y
  check:spec), con la evidencia de record_evidence.py.
- Pruebas de aceptación por tarea en tests/acceptance/T-NN* (test-author), corridas con scripts/acceptance.sh.
- Integración (solo con aprobación del usuario): el `verify_integration` de cada tarea (scripts/it/*.sh, terraform plan)
  y la corrida aislada de Dataform (schemaSuffix `ci`) desde deploy.yml.
