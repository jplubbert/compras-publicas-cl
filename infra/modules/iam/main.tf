# One service account per component, with resource-level roles (REQ-001). The CI account lives in infra/bootstrap.
# Every grant on bronze, datasets and secrets is declared here and applied by the owning module; all keys are static.
resource "google_service_account" "this" {
  for_each = {
    ingest    = "compras-ingest"
    dataform  = "compras-dataform"
    workflow  = "compras-workflow"
    scheduler = "compras-scheduler"
    # T-14: reads silver and gold without the fine-grained reader role, to check REQ-014 E4.
    lector = "compras-lector"
  }

  project      = var.project_id
  account_id   = each.value
  display_name = "Pipeline: ${each.key}"
}

locals {
  members = { for k, sa in google_service_account.this : k => "serviceAccount:${sa.email}" }

  # The only project-level grants; they must stay within ci_grantable_project_roles of infra/bootstrap.
  project_roles = {
    ingest-jobuser   = { role = "roles/bigquery.jobUser", component = "ingest" }
    dataform-jobuser = { role = "roles/bigquery.jobUser", component = "dataform" }
    # T-11: the Scheduler starts the Workflow; the Workflow drives Dataform and waits on the job executions.
    scheduler-workflowsinvoker = { role = "roles/workflows.invoker", component = "scheduler" }
    workflow-dataformeditor    = { role = "roles/dataform.editor", component = "workflow" }
    workflow-runviewer         = { role = "roles/run.viewer", component = "workflow" }
    # T-14: datacatalog.taxonomies.get, needed to set a policy tag on a column.
    dataform-datacatalogviewer = { role = "roles/datacatalog.viewer", component = "dataform" }
    lector-jobuser             = { role = "roles/bigquery.jobUser", component = "lector" }
  }

  # CI creates resources that run as these accounts (repository, Workflow, Scheduler job).
  ci_actas_pipeline = toset(["dataform", "workflow", "scheduler"])
  dataform_agent_roles = {
    user         = "roles/iam.serviceAccountUser"
    tokencreator = "roles/iam.serviceAccountTokenCreator"
  }

  ingest_raw = [
    { role = "roles/bigquery.dataEditor", member = local.members["ingest"] },
    { role = "roles/bigquery.dataViewer", member = local.members["dataform"] },
  ]
  dataform_writes = [{ role = "roles/bigquery.dataEditor", member = local.members["dataform"] }]
  # T-14: dataOwner carries bigquery.tables.setCategory, needed to set bigqueryPolicyTags.
  dataform_owns = [{ role = "roles/bigquery.dataOwner", member = local.members["dataform"] }]
  lector_reads  = [{ role = "roles/bigquery.dataViewer", member = local.members["lector"] }]

  # The CI run reads and writes its own salt in pii_ci (REQ-014 E8); compras-dataform gets nothing there.
  ci_member = "serviceAccount:compras-ci@${var.project_id}.iam.gserviceaccount.com"
  ci_writes = [{ role = "roles/bigquery.dataEditor", member = local.ci_member }]
}

resource "google_project_iam_member" "this" {
  for_each = local.project_roles

  project = var.project_id
  role    = each.value.role
  member  = local.members[each.value.component]
}

# The Workflow invokes Dataform as the Dataform account (T-02 §(a)).
resource "google_service_account_iam_member" "workflow_actas_dataform" {
  service_account_id = google_service_account.this["dataform"].name
  role               = "roles/iam.serviceAccountUser"
  member             = local.members["workflow"]
}

# CI creates and updates the Cloud Run Jobs that run as the ingest account, which needs actAs on it (REQ-006). It
# lives here, not in infra/bootstrap, because this root creates compras-ingest.
resource "google_service_account_iam_member" "ci_actas_ingest" {
  service_account_id = google_service_account.this["ingest"].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:compras-ci@${var.project_id}.iam.gserviceaccount.com"
}

resource "google_service_account_iam_member" "ci_actas_pipeline" {
  for_each = local.ci_actas_pipeline

  service_account_id = google_service_account.this[each.key].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:compras-ci@${var.project_id}.iam.gserviceaccount.com"
}

# Who may act as compras-lector for REQ-014 E4 (the user, with lector_impersonators).
resource "google_service_account_iam_member" "lector_token" {
  for_each = toset(var.lector_impersonators)

  service_account_id = google_service_account.this["lector"].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = each.value
}

# Dataform service agent: reads the GitHub token and runs invocations as compras-dataform (T-02 §(a), DEC-009).
resource "google_project_service_identity" "dataform" {
  provider = google-beta
  project  = var.project_id
  service  = "dataform.googleapis.com"
}

resource "google_service_account_iam_member" "dataform_agent" {
  for_each = local.dataform_agent_roles

  service_account_id = google_service_account.this["dataform"].name
  role               = each.value
  member             = google_project_service_identity.dataform.member
}
