# T-02: recursos de Terraform y APIs de las fuentes

Consulta: 2026-10-22. Proveedor `hashicorp/google` 8.8.0 y `hashicorp/google-beta` 8.8.0 (las últimas estables en
registry.terraform.io; fijadas en `infra/*/versions.tf` por T-01). Fuente de los recursos: los archivos
`website/docs/r/<recurso>.html.markdown` del repositorio del proveedor en el tag `v8.8.0`. Ningún ejemplo trae secretos,
IDs de proyecto ni números de cuenta reales.

## (a) Dataform: repositorio, release config e invocación

**Nombre exacto**
- `google_dataform_repository`: GA (proveedor `google`).
- `google_dataform_repository_release_config`: **solo beta** («This resource is in beta, and should be used with the
  terraform-provider-google-beta provider»): `provider = google-beta`.
- `google_dataform_repository_workflow_config`: **solo beta**. No hace falta: la invocación la lanza el Workflow
  (DEC-002).
- Invocación: no hay recurso de Terraform; se hace con la API REST **v1** de Dataform desde Workflows:
  `POST https://dataform.googleapis.com/v1/{repository}/compilationResults` y
  `POST https://dataform.googleapis.com/v1/{repository}/workflowInvocations`.

**Proveedor y versión**: google 8.8.0 (repositorio) y google-beta 8.8.0 (release config); API de Dataform v1.

**Ejemplo mínimo**
```hcl
resource "google_dataform_repository" "main" {
  name            = "compras-publicas-cl"
  region          = var.region
  service_account = google_service_account.dataform.email

  git_remote_settings {
    url                                 = "https://github.com/${var.github_repository}.git"
    default_branch                      = "main"
    authentication_token_secret_version = "${google_secret_manager_secret.github_token.id}/versions/latest"
  }

  workspace_compilation_overrides {
    schema_suffix = "_dev"
  }
}

resource "google_dataform_repository_release_config" "main" {
  provider      = google-beta
  region        = var.region
  repository    = google_dataform_repository.main.name
  name          = "main"
  git_commitish = "main"

  code_compilation_config {
    default_database = var.project_id
    default_location = var.region
    vars = {
      raw_dataset    = "raw"
      policy_tag_rut = google_data_catalog_policy_tag.rut.name
    }
  }
}
```
```yaml
# Workflows: compile from main and invoke silver + gold (API v1)
- init:
    assign:
      - repository: ${"projects/" + sys.get_env("GOOGLE_CLOUD_PROJECT_ID") + "/locations/us-central1/repositories/compras-publicas-cl"}
- compile:
    call: http.post
    args:
      url: ${"https://dataform.googleapis.com/v1/" + repository + "/compilationResults"}
      auth: {type: OAuth2}
      body:
        gitCommitish: main
        codeCompilationConfig:
          vars: {raw_dataset: raw, policy_tag_rut: "<desde una variable del Workflow>"}
    result: compilation
- invoke:
    call: http.post
    args:
      url: ${"https://dataform.googleapis.com/v1/" + repository + "/workflowInvocations"}
      auth: {type: OAuth2}
      body:
        compilationResult: ${compilation.body.name}
        invocationConfig:
          includedTags: ["silver", "gold"]
          transitiveDependenciesIncluded: true
          serviceAccount: "<cuenta de servicio de Dataform>"
    result: invocation
```

**Notas para T-03 y T-11**
- La guía oficial de Workflows + Dataform usa `http.post` con OAuth2 contra v1. La invocación es asíncrona: hay que
  consultar `workflowInvocations.get` hasta que `state` sea `SUCCEEDED`, `FAILED` o `CANCELLED` (REQ-007 E3).
- Los conectores de Workflows esperan 30 minutos por defecto; `connector_params.timeout` admite hasta un año. Los 25.200 s
  de REQ-007 están dentro del límite.
- Roles: la cuenta de servicio del Workflow necesita `roles/dataform.editor` y `roles/iam.serviceAccountUser` sobre la
  cuenta de servicio de Dataform. El agente de servicio de Dataform
  (`service-<número>@gcp-sa-dataform.iam.gserviceaccount.com`) necesita `iam.serviceAccounts.actAs` sobre esa cuenta
  (`roles/iam.serviceAccountUser`) y `roles/secretmanager.secretAccessor` sobre el secreto del token.
- **Token de GitHub**: la guía oficial pide un token fine-grained limitado al repo con **Contents: read and write**, no
  de solo lectura (ver `## Supuestos`, DEC-002).

**Fuentes**
- https://github.com/hashicorp/terraform-provider-google/blob/v8.8.0/website/docs/r/dataform_repository.html.markdown
- https://github.com/hashicorp/terraform-provider-google/blob/v8.8.0/website/docs/r/dataform_repository_release_config.html.markdown
- https://github.com/hashicorp/terraform-provider-google/blob/v8.8.0/website/docs/r/dataform_repository_workflow_config.html.markdown
- https://cloud.google.com/dataform/docs/schedule-executions-workflows
- https://cloud.google.com/dataform/docs/connect-repository
- https://cloud.google.com/workflows/docs/connectors

## (b) Taxonomía y policy tags de BigQuery

**Nombre exacto**: `google_data_catalog_taxonomy`, `google_data_catalog_policy_tag`, `google_data_catalog_policy_tag_iam_member`
(GA, sin avisos de deprecación en 8.8.0); enmascaramiento: `google_bigquery_datapolicy_data_policy`.

**Proveedor y versión**: google 8.8.0. API `datacatalog.googleapis.com`: la referencia oficial dice que las APIs de
búsqueda y metadatos de Data Catalog se descontinuaron el 2026-06-01, pero que «methods that are related to policy tags
and policy tag taxonomies are not deprecated».

**Ejemplo mínimo**
```hcl
resource "google_data_catalog_taxonomy" "compras" {
  region                 = var.region
  display_name           = "compras_publicas"
  activated_policy_types = ["FINE_GRAINED_ACCESS_CONTROL"]
}

resource "google_data_catalog_policy_tag" "rut" {
  taxonomy     = google_data_catalog_taxonomy.compras.id
  display_name = "rut_persona"
}

resource "google_data_catalog_policy_tag_iam_member" "pii_readers" {
  for_each   = toset(var.pii_readers)
  policy_tag = google_data_catalog_policy_tag.rut.name
  role       = "roles/datacatalog.categoryFineGrainedReader"
  member     = each.value
}
```

**Notas para T-03 y T-14**
- El rol de lectura sigue siendo `roles/datacatalog.categoryFineGrainedReader` (permiso
  `datacatalog.categories.fineGrainedGet`), según la página de seguridad de columnas de BigQuery.
- Una columna se marca en el esquema con `policyTags.names`; en Dataform, con `bigqueryPolicyTags` dentro de `columns`
  (campo `bigquery_policy_tags` de `configs.proto`). Para asignar la tag hace falta `bigquery.tables.setCategory` sobre la
  tabla (la cuenta de servicio de Dataform, como dueña de sus tablas).
- `display_name` admite el nombre corto; el nombre jerárquico «dato_personal.rut» de REQ-014 se arma con un tag padre
  `dato_personal` y un hijo `rut` (`parent_policy_tag`).

**Fuentes**
- https://cloud.google.com/data-catalog/docs/reference/rest/v1beta1/projects.locations.taxonomies.policyTags/get
- https://cloud.google.com/bigquery/docs/column-level-security-intro
- https://github.com/hashicorp/terraform-provider-google/blob/v8.8.0/website/docs/r/data_catalog_taxonomy.html.markdown
- https://github.com/hashicorp/terraform-provider-google/blob/v8.8.0/website/docs/r/data_catalog_policy_tag_iam.html.markdown
- https://github.com/dataform-co/dataform/blob/main/protos/configs.proto

## (c) Cuota diaria de bytes de query de BigQuery

**Nombre exacto**: dos caminos.
1. `google_cloud_quotas_quota_preference` (GA en `google`): `service = "bigquery.googleapis.com"`,
   `quota_id = "QueryUsagePerDay"` (proyecto) o `"QueryUsagePerUserPerDay"` (cada usuario y cuenta de servicio).
2. `google_service_usage_consumer_quota_override`: **solo beta**; `metric = urlencode("bigquery.googleapis.com/quota/query/usage")`,
   `limit = urlencode("/d/project")` o `urlencode("/d/user")`, `force = true` para bajar la cuota.

**Recomendación**: la 1 (GA y API vigente de Cloud Quotas).

**Proveedor y versión**: google 8.8.0.

**Ejemplo mínimo**
```hcl
resource "google_cloud_quotas_quota_preference" "bq_daily" {
  parent        = "projects/${var.project_id}"
  name          = "bigquery-query-usage-per-day"
  service       = "bigquery.googleapis.com"
  quota_id      = "QueryUsagePerDay"
  contact_email = var.alert_email
  quota_config {
    # 50 GiB/day (S-07). The unit of the API value is not documented on the BigQuery page (the console takes TiB):
    # T-05 reads quotaInfos.unit in its verify_integration and fixes this number (51200 if MiB).
    preferred_value = 51200
  }
}
```

**Notas para T-05**
- La documentación de BigQuery da los nombres `QueryUsagePerDay` y `QueryUsagePerUserPerDay` y la métrica
  `bigquery.googleapis.com/quota/query/usage`; en la consola el valor va en TiB (por defecto, 200 TiB por proyecto y
  día). La unidad del valor en la API **no está confirmada**.
- La cuota de usuario se aplica por separado a cada usuario y cuenta de servicio; no se puede asignar a uno solo.
- **Dataform no tiene campo de `maximumBytesBilled`**: no está en `WorkflowSettings`
  (`workflow_settings.yaml`), ni en las configuraciones por acción de `configs.proto`, ni en `invocationConfig` ni en
  `codeCompilationConfig` de la API v1. Alternativas: (i) la cuota diaria de proyecto; (ii) la cuota diaria por usuario,
  que alcanza a la cuenta de servicio de Dataform (por ejemplo 20 GiB/día); (iii) `maximum_bytes_billed` en el
  `QueryJobConfig` de `google-cloud-bigquery` para las consultas de los scripts (benchmark y pruebas de integración).

**Fuentes**
- https://cloud.google.com/bigquery/docs/custom-quotas
- https://github.com/hashicorp/terraform-provider-google/blob/v8.8.0/website/docs/r/cloud_quotas_quota_preference.html.markdown
- https://github.com/hashicorp/terraform-provider-google/blob/v8.8.0/website/docs/r/service_usage_consumer_quota_override.html.markdown
- https://github.com/dataform-co/dataform/blob/main/protos/configs.proto
- https://cloud.google.com/python/docs/reference/bigquery/latest/google.cloud.bigquery.job.QueryJobConfig

## (d) Presupuesto con notificaciones Pub/Sub

**Nombre exacto**: `google_billing_budget` (GA).

**Proveedor y versión**: google 8.8.0; API `billingbudgets.googleapis.com`.

**Ejemplo mínimo**
```hcl
resource "google_billing_budget" "cap" {
  billing_account = var.billing_account
  display_name    = "compras-publicas-cl cap"

  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }
  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_amount) # default 10
    }
  }
  threshold_rules {
    threshold_percent = 0.5
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 0.9
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "CURRENT_SPEND"
  }
  all_updates_rule {
    pubsub_topic   = google_pubsub_topic.budget.id
    schema_version = "1.0"
    monitoring_notification_channels = [google_monitoring_notification_channel.email.id]
  }
}
```

**Notas para T-05**
- El mensaje del presupuesto trae `costAmount` y `budgetAmount` (los dos campos que lee el ejemplo oficial), además de
  `budgetDisplayName`, `alertThresholdExceeded`, `costIntervalStart`, `budgetAmountType` y `currencyCode`.
- Quien aplica el bootstrap necesita un rol de billing sobre la cuenta (crear presupuestos) y la API
  `billingbudgets.googleapis.com` habilitada.
- La guía oficial advierte que entre el gasto y el aviso hay retraso, y que al quitar el billing «resources might be
  irretrievably deleted» y se detienen todos los servicios, incluido el free tier (ver `## Supuestos`, DEC-003).

**Fuentes**
- https://cloud.google.com/billing/docs/how-to/disable-billing-with-notifications
- https://github.com/hashicorp/terraform-provider-google/blob/v8.8.0/website/docs/r/billing_budget.html.markdown

## (e) Cloud Run function de 2.ª generación con disparador Pub/Sub

**Nombre exacto**: `google_cloudfunctions2_function` (GA; la guía oficial de desvinculación usa una Cloud Run function
de 2.ª generación con disparador Pub/Sub).

**Proveedor y versión**: google 8.8.0.

**Ejemplo mínimo**
```hcl
resource "google_cloudfunctions2_function" "killswitch" {
  name     = "billing-killswitch"
  location = var.region

  build_config {
    runtime     = "python312"
    entry_point = "stop_billing"
    source {
      storage_source {
        bucket = google_storage_bucket.functions.name
        object = google_storage_bucket_object.killswitch.name
      }
    }
  }
  service_config {
    service_account_email = google_service_account.killswitch.email
    max_instance_count    = 1
  }
  event_trigger {
    trigger_region        = var.region
    event_type            = "google.cloud.pubsub.topic.v1.messagePublished"
    pubsub_topic          = google_pubsub_topic.budget.id
    retry_policy          = "RETRY_POLICY_RETRY"
    service_account_email = google_service_account.killswitch_trigger.email
  }
}
```

**Notas para T-05**
- La guía oficial da a la cuenta de servicio de la función `roles/billing.admin` sobre **la cuenta de facturación**, no
  `roles/billing.projectManager` sobre el proyecto como dice T-05. Ver `## Supuestos`.
- La cuenta del disparador necesita `roles/run.invoker` sobre el servicio de la función.
- El zip de la fuente sale de `archive_file` (proveedor `archive`, ya fijado en T-01).

**Fuentes**
- https://cloud.google.com/billing/docs/how-to/disable-billing-with-notifications
- https://github.com/hashicorp/terraform-provider-google/blob/v8.8.0/website/docs/r/cloudfunctions2_function.html.markdown

## (f) Workload Identity Federation para GitHub Actions

**Nombre exacto**: `google_iam_workload_identity_pool`, `google_iam_workload_identity_pool_provider`,
`google_service_account_iam_member` (GA).

**Proveedor y versión**: google 8.8.0.

**Ejemplo mínimo**
```hcl
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_condition                = "attribute.repository == \"${var.github_repository}\""
  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.repository"       = "assertion.repository"
    "attribute.repository_owner" = "assertion.repository_owner"
  }
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "ci_wif" {
  service_account_id = google_service_account.ci.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}
```
```yaml
permissions:
  contents: read
  id-token: write
steps:
  - uses: google-github-actions/auth@v2
    with:
      workload_identity_provider: ${{ vars.WIF_PROVIDER }}
      service_account: ${{ vars.CI_SERVICE_ACCOUNT }}
```

**Notas para T-04**
- El ejemplo oficial del proveedor usa `attribute_condition` con el repositorio (Google lo exige para proveedores de
  GitHub). No conviene limitarlo a `refs/heads/main`: el plan corre en los PR.
- La versión mayor de `google-github-actions/auth` se confirma al escribir el workflow (v2 a la fecha de esta consulta).

**Fuentes**
- https://github.com/hashicorp/terraform-provider-google/blob/v8.8.0/website/docs/r/iam_workload_identity_pool_provider.html.markdown
- https://github.com/google-github-actions/auth
- https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect
- https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines

## Mercado Público

**Nombre exacto**: base `https://api.mercadopublico.cl/servicios/v1/publico/`; `licitaciones.json` y
`ordenesdecompra.json`.

**Versión de la API**: v1 (el campo `Version` de cada respuesta).

**Ejemplo mínimo**
```http
GET https://api.mercadopublico.cl/servicios/v1/publico/licitaciones.json?fecha=20102026&ticket=<TICKET>
GET https://api.mercadopublico.cl/servicios/v1/publico/licitaciones.json?codigo=1509-5-L114&ticket=<TICKET>
GET https://api.mercadopublico.cl/servicios/v1/publico/ordenesdecompra.json?fecha=20102026&ticket=<TICKET>
GET https://api.mercadopublico.cl/servicios/v1/publico/ordenesdecompra.json?codigo=2097-241-SE14&ticket=<TICKET>
```
```json
{"Cantidad": 1, "FechaCreacion": "2026-10-21T23:30:00", "Version": "v1",
 "Listado": [{"Codigo": "2097-241-SE14", "Nombre": "…", "CodigoEstado": 6, "CodigoLicitacion": "1509-5-L114",
              "TipoMoneda": "CLP", "TotalNeto": 840336.0, "Total": 1000000.0,
              "Fechas": {"FechaCreacion": "…", "FechaEnvio": "…", "FechaAceptacion": "…", "FechaUltimaModificacion": "…"},
              "Proveedor": {"RutSucursal": "…"}}]}
```

**Notas para T-06**
- Parámetros: `ticket` (obligatorio), `fecha` (`ddmmaaaa`; sin fecha, el día actual), `codigo` (detalle; ignora la
  fecha), `estado`, `CodigoProveedor`, `CodigoOrganismo`.
- Límite: «Cada ticket de acceso cuenta con un límite diario de 10.000 solicitudes». Cargas masivas «entre las 22:00 y
  las 07:00 horas». Si se publican los datos sin modificarlos, hay que citar a la Dirección ChileCompra.
- Estados de **licitación**: 5 Publicada, 6 Cerrada, 7 Desierta, 8 Adjudicada, 18 Revocada, 19 Suspendida. Estados de
  **orden de compra**, distintos: 4 Enviada a proveedor, 5 En proceso, 6 Aceptada, 9 Cancelada, 12 Recepción conforme,
  13 Pendiente de recepcionar, 14 Recepcionada parcialmente, 15 Recepción conforme incompleta.
- Monedas documentadas: `CLP`, `CLF` (UF), `USD`, `UTM`, `EUR`. La UF viene como **`CLF`**, no `UF`.
- Fechas: la OC trae `Fechas.FechaUltimaModificacion` («Fecha de Ultima Modificación de la Orden de compra»). La
  licitación **no** trae un campo de última modificación; sus `Fechas` son de creación, cierre, publicación,
  adjudicación y otras etapas.
- El listado diario trae pocos campos (código, nombre, estado, fecha de cierre); el detalle por `codigo` trae el resto
  (montos, comprador, proveedor, ítems).
- **No confirmado** en la documentación oficial: códigos de error, si hay 429 y si viene `Retry-After`. La página solo
  dice que el acceso se monitorea y puede restringirse según las solicitudes por IP.

**Fuentes**
- https://www.chilecompra.cl/api/
- https://www.chilecompra.cl/wp-content/uploads/2026/03/Documentacion-API-Mercado-Publico-Licitaciones.pdf
- https://www.chilecompra.cl/wp-content/uploads/2026/03/Documentacion-API-Mercado-Publico-oc.pdf

## Banco Central (BDE, SieteRestWS)

**Nombre exacto**: `https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx`, funciones `GetSeries` y `SearchSeries`.

**Versión de la API**: la vigente de la documentación oficial a la fecha de consulta.

**Ejemplo mínimo**
```http
GET https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx?token=<TOKEN>&function=GetSeries&timeseries=F073.UFF.PRE.Z.D&firstdate=2026-10-11&lastdate=2026-10-21
GET https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx?token=<TOKEN>&function=SearchSeries&frequency=DAILY
```
```json
{"Codigo": 0, "Descripcion": "Success",
 "Series": {"descripEsp": "…", "descripIng": "…", "seriesId": "F073.TCO.PRE.Z.D",
            "Obs": [{"indexDateString": "04-10-2024", "value": "950.10", "statusCode": "OK"},
                    {"indexDateString": "05-10-2024", "value": "NaN", "statusCode": "ND"}]},
 "SeriesInfos": []}
```

**Notas para T-07**
- **La API REST se autentica con un `token`** (API key), no con `user` y `pass`: usuario y clave son del servicio SOAP.
  Ver `## Supuestos` (DEC-004, REQ-005).
- Fechas: entrada `AAAA-MM-DD`; en la respuesta, `indexDateString` es `DD-MM-AAAA`.
- ND: `value = "NaN"` con `statusCode = "ND"`.
- `updatedAt` existe solo en `SeriesInfos` de `SearchSeries` (por serie, formato `DD-MM-AAAA`); `GetSeries` devuelve
  `SeriesInfos` vacío.
- `Codigo` 0 es éxito; la documentación no da el código de un token inválido.
- Los códigos de S-08 no se pudieron confirmar sin token (el catálogo exige autenticación).

**Fuentes**
- https://si3.bcentral.cl/estadisticas/Principal1/Web_Services/documentacion_en.html

## mindicador.cl

**Nombre exacto**: `https://mindicador.cl/api`, `/api/{indicador}`, `/api/{indicador}/{dd-mm-yyyy}`,
`/api/{indicador}/{yyyy}`, con `uf` y `dolar`.

**Versión de la API**: `1.7.0` (campo `version` de la respuesta).

**Ejemplo mínimo**
```http
GET https://mindicador.cl/api/uf/21-10-2026
```
```json
{"version": "1.7.0", "autor": "mindicador.cl", "codigo": "uf", "nombre": "Unidad de fomento (UF)",
 "unidad_medida": "Pesos", "serie": [{"fecha": "2026-10-21T03:00:00.000Z", "valor": 41194.55}]}
```

**Notas para T-07**
- Un día sin dato (por ejemplo el dólar de un domingo, `GET /api/dolar/18-10-2026`) responde 200 con `serie: []`.
- `fecha` viene en UTC (03:00Z = medianoche de Chile en horario de verano): hay que convertirla a fecha local.
- No hay límite de uso ni SLA publicados.

**Fuentes**
- https://mindicador.cl/

## Supuestos

- S-13: **confirmado**. Los recursos de (a), (b), (c) y (d) existen en google 8.8.0 con esos nombres. Matices: la
  release config de Dataform y `google_service_usage_consumer_quota_override` son solo beta, y para la cuota se recomienda
  `google_cloud_quotas_quota_preference` (GA). Las taxonomías y policy tags quedaron fuera del apagado de Data Catalog.
- S-14: **corregir**. La OC tiene `Fechas.FechaUltimaModificacion`, pero la licitación no tiene campo de última
  modificación: `fecha_cambio` = `ingested_at` para licitaciones e ítems.
- S-08: **no confirmado** (la búsqueda de series exige token). Confirmarlo con `SearchSeries` en el
  `verify_integration` de T-07.
- S-06: confirmado (10.000 solicitudes diarias por ticket, cita textual en `## Mercado Público`).
- S-07 y REQ-003 E6 / DEC-003: **corregir**. Dataform no tiene `maximumBytesBilled`. Propuesta: E6 comprueba la cuota
  diaria de proyecto (`QueryUsagePerDay`) y la de usuario (`QueryUsagePerUserPerDay`, que alcanza a la cuenta de
  servicio de Dataform) en vez de `workflow_settings.yaml`. DEC-003 deja `maximum_bytes_billed` solo en las consultas de
  los scripts. La columna de S-07 que nombra `maximumBytesBilled` cambia igual. La unidad del valor de la cuota en la API
  queda por confirmar en T-05.
- REQ-005 / DEC-004 (credenciales de la BDE): **corregir**. La API REST usa un `token`, no usuario y clave: el secreto
  es el token de la BDE. `updatedAt` existe solo en `SearchSeries`; la ventana D−10 a D basta para captar revisiones.
- REQ-008 / REQ-010: **corregir**. Los estados de la OC son otros (ver `## Mercado Público`) y la moneda UF viene como
  `CLF`: el catálogo de REQ-008 aplica solo a licitaciones, y REQ-010 acepta `CLF` en vez de `UF`.
- DEC-002 (token de GitHub de solo lectura): **corregir**. La guía de Dataform pide un token fine-grained limitado al
  repo con Contents: read and write.
- DEC-003 / T-05 (rol de la desvinculadora): **corregir**. La guía oficial da a la función `roles/billing.admin` sobre la
  cuenta de facturación. Propuesta: probar primero `roles/billing.projectManager` sobre el proyecto en el simulacro de
  T-05, y usar `billing.admin` si falla. Agregar a las consecuencias de DEC-003 que, al quitar el billing, la guía avisa
  que se pueden borrar recursos.
- REQ-014 (rol de lectura fina): confirmado, `roles/datacatalog.categoryFineGrainedReader`.

El cambio en spec/SPEC.md y spec/DECISIONS.md lo registra el usuario; T-02 no edita spec/.
