# Tasks

Los pasos marcados **(usuario)** tocan GCP o GitHub: los corre José Pedro con sus credenciales (ADC o `gh`), nunca un
agente. Las variables de entorno van siempre con `scripts/env.sh` delante del comando cuando el script no lo hace solo.

## 1. Preparación local

- [x] 1.1 Confirmar la base verde en `autopilot/lote`: `scripts/env.sh bash -c 'npm test && npm run lint && npm run check:repo && npm run check:spec'` termina en 0.
- [x] 1.2 Commit de OpenSpec (`openspec/`, `.claude/`, `.agents/`) con trailers `Task: none` y `Req: none`; el hook `commit-msg` acepta el commit.
- [x] 1.3 Crear `main`: `git branch -f master autopilot/lote && git branch -m master main`; `git log --oneline -1 main` muestra el commit de 1.2.

## 2. Cuentas externas (usuario)

- [x] 2.1 Proyecto GCP nuevo con cuenta de facturación y las APIs que habilita `infra/bootstrap/apis.tf`; `gcloud config get-value project` devuelve el ID elegido.
- [x] 2.2 Ticket de la API de Mercado Público (Clave Única) y token de la BDE del Banco Central obtenidos y guardados fuera del repo (gestor de contraseñas); ninguno aparece en `git grep`.
- [x] 2.3 Repo `jplubbert/compras-publicas-cl` creado vacío en GitHub (`gh repo create`), y token fine-grained con permiso de lectura de contenidos para Dataform.

## 3. Bootstrap y variables de GitHub (usuario)

- [x] 3.1 Exportar `TF_VAR_project_id`, `TF_VAR_region=us-central1`, `TF_VAR_github_repository=jplubbert/compras-publicas-cl`, `TF_VAR_billing_account`, `TF_VAR_alert_email`; `scripts/it/tf-plan.sh bootstrap` termina en 0.
- [x] 3.2 Aplicar `infra/bootstrap` a mano (`scripts/env.sh terraform -chdir=infra/bootstrap apply`); `terraform output` muestra `state_bucket`, `workload_identity_provider` y `ci_service_account`.
- [ ] 3.3 Crear el environment `production` (con aprobación) y las variables de repositorio `GCP_PROJECT_ID`, `GCP_REGION`, `WIF_PROVIDER`, `CI_SERVICE_ACCOUNT`, `PII_READERS`, `LECTOR_IMPERSONATORS` (listas HCL, p. ej. `["user:…"]`); `gh variable list` las muestra.
- [x] 3.4 Respaldo del estado (T-17): crear el proyecto de respaldo, reaplicar bootstrap con `backup_project_id`, correr `scripts/backup-state.sh bootstrap` y cargar `STATE_BACKUP_BUCKET` en `production`.

## 4. Primer despliegue (usuario)

- [x] 4.1 `git push -u origin main`; abrir un PR de prueba desde una rama del repo; los jobs `checks` y `plan` pasan y el PR recibe el comentario con `Plan:`; `scripts/it/last-ci-run.sh` imprime `last-ci-run: success`.
- [x] 4.2 Merge del PR a `main`; `deploy.yml` termina en verde en `apply` y `release` (imagen etiquetada con el commit, Dataform en `ci`, paso «Back up Terraform state» en verde).
- [ ] 4.3 `scripts/it/tf-plan.sh main` después del apply sale sin cambios (T-03).
- [ ] 4.4 Cargar una versión de cada secreto (`mercadopublico-ticket`, `bcentral-token`, `dataform-github-token`) con `gcloud secrets versions add`; `gcloud secrets versions list` muestra una versión habilitada en cada uno y `npm run check:repo` sigue en 0.

## 5. Verificaciones de integración (usuario; salidas a `docs/demo/integracion-<fecha>.md`)

- [ ] 5.1 Ingesta MP (T-06): `GOOGLE_CLOUD_PROJECT=… IT_BUCKET=<bucket de pruebas> scripts/it/ingest-mp.sh <fecha hábil>` imprime `ingest-mp: ok run_id=… lineas=… requests=…` y el ticket no aparece en la salida ni en los objetos.
- [ ] 5.2 Ingesta BCentral (T-07): `scripts/it/ingest-indicadores.sh <fecha>` imprime tres líneas `S-08 …: encontrada` y `ingest-indicadores: ok … series=3`.
- [ ] 5.3 Carga a raw (T-08): `GOOGLE_CLOUD_PROJECT=… GCP_REGION=us-central1 scripts/it/run-jobs.sh <fecha>` imprime `run-jobs: ok …`.
- [ ] 5.4 Migración de `proveedor_key` (T-14): `scripts/it/migrar-proveedor-key.sh` termina en 0; relanzar el job `release` si había fallado en Dataform.
- [ ] 5.5 Dataform en `ci` (T-09, T-10, T-12, T-20): `GCP_PROJECT_ID=… GCP_REGION=us-central1 POLICY_TAG_RUT=$(scripts/env.sh terraform -chdir=infra/main output -raw policy_tag_rut) scripts/env.sh scripts/it/dataform-ci.sh` termina con la línea `dataform-ci: ok …` incluyendo `req012-*`, `cuarentena` y `mart`; `pii_ci.sal` tiene una fila y `pii.sal` no cambió.
- [ ] 5.6 Policy tags (T-14): `POLICY_TAG_RUT=… scripts/it/policy-tags.sh` imprime `policy-tags: ok e2-bq e2-bq-incremental e4 e7 sal` (si falla `revisar_tags`, `scripts/it/reaplicar-policy-tags.sh <dataset.tabla>` y repetir con `SKIP_RUN=1`).
- [ ] 5.7 Workflow diario (T-11): `scripts/it/run-workflow.sh` imprime `run-workflow: ok execution=…` sin `PERMISSION_DENIED`; E5: con la versión del ticket deshabilitada, `--expect-failure` sale 0, llega el correo «Workflow compras-diario falló» y `finished_execution_count` muestra `status=FAILED`; volver a habilitar el ticket.
- [ ] 5.8 Respaldo del estado (T-17): `STATE_BACKUP_BUCKET=… scripts/it/state-backup.sh` imprime `state-backup: ok gs://…/infra-main/<marca>-<sha>.tfstate`.
- [ ] 5.9 Opcional, drill del killswitch (T-05): `DRILL_PROJECT_ID=… DRILL_BILLING_ACCOUNT=… TF_VAR_alert_email=… scripts/it/killswitch-drill.sh` en un proyecto desechable imprime `killswitch-drill: ok role=… unit=MiBy`; si se omite, el README lo declara.

## 6. Datos en gold

- [ ] 6.1 Primera corrida diaria completa vía Scheduler (o `scripts/it/run-workflow.sh`) **(usuario)**; `bq query --maximum_bytes_billed` cuenta filas en `gold.*` y `quarantine.*` y las cifras quedan en `docs/demo/integracion-<fecha>.md`.
- [ ] 6.2 Registrar en el mismo documento un incidente de calidad real atrapado (fila en cuarentena con su motivo) o declarar que la primera corrida no dejó ninguno.

## 7. Benchmark real

- [ ] 7.1 `GCP_PROJECT_ID=… GCP_REGION=us-central1 scripts/env.sh scripts/it/benchmark.sh` **(usuario)** imprime `benchmark: ok` y deja `benchmarks/results/<fecha>.md` con tres variantes, dos reescrituras y «Excluidos»; `npm run test:benchmarks` sigue en 0.
- [ ] 7.2 Commit de `benchmarks/results/<fecha>.md` y `docs/demo/` con `Task: none` y `Req: none`.

## 8. README de portafolio (REQ-015, T-15)

- [ ] 8.1 `scripts/ci/check-readme.mjs` con pruebas `node:test` en `scripts/ci/tests/` (secciones en orden, rutas y comandos citados existentes, nomenclatura R-07) y script `check:readme` en `package.json`; los ejemplos E2, E3 y E4 de REQ-015 fallan como se espera.
- [ ] 8.2 `README.md` con las secciones de REQ-015 en orden, diagrama Mermaid de la arquitectura, la tabla de `benchmarks/results/<fecha>.md`, costo mensual medido, revinculación del billing, carga de secretos, restauración del estado (REQ-016), nota GitLab CI, «Cómo se construyó» y «Qué se rompió» desde `spec/LOG.md`, cita a ChileCompra y Banco Central; `npm run check:readme` sale en 0.
- [ ] 8.3 `check:readme` agregado al job `checks` de `ci.yml`; `npm run test:workflows` sigue en 0; commits con `Task: T-15` y `Req: REQ-015`.
- [ ] 8.4 PR a `main` con el README; `checks` verde y merge **(usuario)**.

## 9. Cierre

- [ ] 9.1 `spec/TASKS.json`: T-14 y T-15 con la evidencia de integración citada en `notes` y estado acordado por el usuario; `spec/LOG.md` con una entrada que enlaza `docs/demo/integracion-<fecha>.md`; `npm run check:spec` en 0.
- [ ] 9.2 Gasto del mes leído en la consola de facturación y anotado en el README (criterio de éxito 3: bajo USD 1).

## Workflow follow-up

- Archivar el cambio con `openspec archive demo-en-vivo --skip-specs` cuando el README esté en `main` y los números sean reales.
- Lo que falle por un defecto del pipeline se abre como cambio nuevo de OpenSpec; no se parcha dentro de este.
