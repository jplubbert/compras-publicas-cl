# Proposal

## Why

El repo tiene 17 tareas revisadas y la suite local verde, pero nada existe fuera de esta máquina: no hay remoto en
GitHub, no hay proyecto GCP, no hay README y `benchmarks/results/` está vacío. Las tres evidencias que el objetivo
promete a un evaluador (tabla de bytes antes y después, calidad como código, policy tags) solo se pueden mostrar con el
sistema desplegado y una corrida real. El demo para el trabajo es exactamente eso: el criterio de éxito de
`spec/SPEC.md` cumplido en vivo.

## What Changes

- Repositorio público en GitHub con rama `main` (lo que hoy es `autopilot/lote`, 54 commits sobre `master`),
  environment `production` y las variables que leen `ci.yml` y `deploy.yml`.
- Proyecto GCP nuevo con facturación: `infra/bootstrap` aplicado a mano por el usuario, `infra/main` aplicado por
  `deploy.yml` al hacer merge a `main`.
- Carga a mano de los tres secretos (`mercadopublico-ticket`, `bcentral-token`, `dataform-github-token`).
- Despliegue de T-14 (policy tags, hoy `in_progress` con «Pendiente deploy») junto con T-19 y T-20, y la migración de
  `proveedor_key`.
- Ejecución de todas las verificaciones de integración pendientes (`scripts/it/*`) con su salida registrada en
  `docs/demo/`.
- Primera corrida diaria completa con datos en `gold`; benchmark real en `benchmarks/results/<fecha>.md`.
- README de portafolio (REQ-015, tarea T-15) con `npm run check:readme`, números reales y «Qué se rompió».
- Flujo de trabajo: este cambio se ejecuta con OpenSpec en sesiones interactivas (DEC-056 de sdd-base), no con el
  autopilot. `spec/SPEC.md` sigue siendo la fuente de los requisitos; `spec/TASKS.json` y `spec/LOG.md` se actualizan
  al cerrar para dejar el historial coherente.

## Capabilities

### New Capabilities

Ninguna. El comportamiento del sistema ya está especificado en `spec/SPEC.md` (REQ-001 a REQ-016) con pruebas de
aceptación locales; este cambio despliega, verifica en la nube y documenta. Por eso `.openspec.yaml` lleva
`skip_specs: true`.

### Modified Capabilities

Ninguna.

## Impact

- Costo: USD 0 a 1 al mes en uso normal (R-03); el benchmark factura algunos GiB una vez; tope duro USD 10 con
  desvinculación automática del billing (DEC-003).
- Cuentas externas del usuario: ticket de la API de Mercado Público (Clave Única), token de la BDE del Banco Central,
  token fine-grained de GitHub para Dataform, proyecto GCP con cuenta de facturación.
- Lo único que cambia en el código: README, `scripts/ci/check-readme.mjs`, `benchmarks/results/`, `docs/demo/`,
  la carpeta `openspec/` y las skills de `.claude/` y `.agents/`.
- Fuera de alcance: la cola 3a de sdd-base, los cortes futuros de SPEC.md (histórico masivo, Gemini, Looker Studio) y
  T-16 (cobertura desde aceptación).
