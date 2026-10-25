# Design

## Context

Ver proposal.md. Estado concreto: rama `autopilot/lote` en `fa474a1` con árbol limpio; `master` 54 commits atrás y
0 adelante; `.github/workflows/*.yml` disparan solo sobre `main`. El toolchain vive en `.tools/` y todo comando va
por `scripts/env.sh`. Los scripts de `scripts/it/` tocan GCP y solo los corre el usuario. Cada tarea revisada dejó en
`spec/LOG.md` su «Pendiente manual» con el comando exacto y la línea de salida esperada; este diseño los ordena.

## Goals / Non-Goals

**Goals:**
- Un orden de despliegue que no requiera volver atrás (bootstrap → GitHub → merge → secretos → verificaciones → datos →
  benchmark → README).
- Evidencia reproducible de cada verificación en `docs/demo/`, para citarla desde el README.
- Gasto acotado: el benchmark corre una sola vez y al final; el drill del killswitch es opcional.

**Non-Goals:**
- Cambiar requisitos o código del pipeline. Si una verificación de integración falla por un defecto real, se abre
  otro cambio de OpenSpec con su propio ciclo.
- Reemplazar `spec/SPEC.md` por `openspec/specs/`.

## Decisions

1. **OpenSpec en sesión interactiva, no autopilot.** DEC-056 de sdd-base: una persona revisa los diffs; el revisor
   automático no aporta aquí. Alternativa descartada: relanzar el autopilot para T-14 y T-15 (gasta tokens en cada
   corrida mientras T-14 espera un deploy; ver T-21).
2. **`main` nace de `autopilot/lote`.** `master` es ancestro directo; se fast-forwardea y se renombra a `main` para
   que los workflows disparen sin editar `ci.yml` ni `deploy.yml`. Alternativa descartada: cambiar los workflows a
   `master` (más cambios y el README hablaría de una rama que nadie espera).
3. **`skip_specs: true`.** Los requisitos ya están en SPEC.md con sus ejemplos de aceptación; duplicarlos en
   `openspec/specs/` crearía dos fuentes. Los proyectos nuevos sí usarán `openspec/specs/` desde el inicio.
4. **Trailers de commit.** El hook `commit-msg` exige `Task:` y `Req:`. Los commits de README citan `Task: T-15` y
   `Req: REQ-015`; los de OpenSpec, evidencia y resultados del benchmark llevan `Task: none` y `Req: none`. Ningún
   commit de este cambio toca `tests/acceptance/`.
5. **Orden de las verificaciones por dependencia y costo.** Primero lo que no factura (plan, PR, apply), después
   ingesta y carga (API con cuota diaria: una fecha hábil, sin backfill), después Dataform en `ci`, el Workflow,
   T-14 (migración y policy tags), respaldo del estado, y por último el benchmark.
6. **Evidencia manual en `docs/demo/integracion-<fecha>.md`.** Una línea por script con el comando y la línea final.
   `evidence/*.json` se deja al orquestador (DEC-014): el usuario no lo edita a mano.

## Risks / Trade-offs

- [Propagación de IAM al primer apply de `infra/main`] → `scripts/it/tf-apply.sh` ya reintenta hasta 5 veces solo ese
  error; `deploy.yml` lo usa.
- [Cuota de Mercado Público: 10.000 requests por ticket y día, cargas masivas 22:00–07:00] → ingestar una sola fecha
  hábil para la primera corrida y dejar que el Scheduler siga día a día.
- [El job `release` falla en Dataform por `pii_ci.sal` o `POLICY_TAG_RUT`] → es el escenario previsto en T-14/T-20:
  relanzar `release` después de `migrar-proveedor-key.sh`; no editar código.
- [Costo del benchmark] → una sola corrida, al final, con `maximum_bytes_billed`; los dry runs son cota superior y
  el README lo dice.
- [Repo público expone configuración] → `npm run check:repo` ya falla con IDs de proyecto, números de cuenta o llaves;
  correrlo antes del primer push.
- [El drill del killswitch necesita un segundo proyecto desechable] → opcional para el demo; el README documenta la
  revinculación del billing aunque el drill no se haya corrido.

## Migration Plan

Despliegue: ver tasks.md. Reversión: `terraform destroy` de `infra/main` desde la máquina del usuario con ADC; el
bootstrap se destruye a mano al final (estado y WIF). Si el killswitch desvinculó el billing, el procedimiento de
revinculación queda en el README (REQ-015).

## Open Questions

- Nombre del proyecto GCP y correo para las alertas del presupuesto (`TF_VAR_alert_email`).
- Valores de `PII_READERS` y `LECTOR_IMPERSONATORS` (el usuario, como `user:…`).
- Si el repo nace público desde el primer push o se hace público al terminar el README.
