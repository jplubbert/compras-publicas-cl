# DEC-005 Verificación local sin nube y verificación de integración aparte

- Estado: proposed
- Fecha: 2026-10-22
- Aprobador: pendiente: lo acepta Jev (node scripts/adr.mjs accept 0005, DEC-036)
- Módulos: scripts/, tests/acceptance/, infra/, ingest/, dataform/, .github/workflows/
- Enforced-by: cmd: npm run check:spec

## Contexto

El autopilot corre el `verify` de cada tarea en la laptop, sin red ni costo (DEC-019 de sdd-base). Este proyecto vive
en GCP. Hace falta decidir qué se prueba localmente y qué solo contra la nube.

## Impulsores

REQ-001 a REQ-015, DEC-019 de sdd-base.

## Opciones consideradas

### 1. Local: pytest con HTTP simulado, `terraform test` con `mock_provider`, `dataform compile` y pruebas Node sobre el grafo compilado; nube: `verify_integration` y CI
- A favor: el autopilot puede verificar cada tarea sin credenciales; la semántica SQL se prueba en BigQuery en un
  dataset `ci_` en CI.
- En contra: el SQL no se ejecuta localmente; un error de dialecto solo aparece en CI o en la integración.

### 2. Todo contra un proyecto GCP de pruebas
- A favor: es más fiel.
- En contra: necesita credenciales en el autopilot y cuesta en cada corrida.

## Decisión

Usaremos la opción 1. `scripts/setup.sh` instala las herramientas fijadas (Terraform en `.tools/`, `uv sync`, `npm ci` de
Dataform) y precarga los proveedores. Es el único paso con red. El `verify` de cada tarea usa solo comandos locales. Lo
que toca GCP (`terraform plan/apply`, `bq`, `gcloud`, la corrida en `ci_`) va en `verify_integration` y en los workflows
de GitHub Actions, y coincide con `AUTOPILOT_INTEGRATION_PATTERN`. Las pruebas de aceptación viven en `tests/acceptance/`
y las corre `scripts/acceptance.sh <archivo>`, que elige el runner según la extensión (`.py` → pytest, `.tftest.hcl` →
`terraform test`, `.test.mjs` → `node --test`).

## Consecuencias

Buenas: el autopilot avanza sin nube. Malas: la semántica SQL depende de CI. Neutrales: la integración la aprueba el
usuario.

## Confirmación

`npm run check:spec` rechaza un `verify` que coincide con el patrón de integración.

## Más información

- Revisar si: aparece un emulador fiel de BigQuery que corra localmente.
