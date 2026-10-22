# One service account per component, with resource-level roles (REQ-001). The CI account lives in infra/bootstrap.
# Every grant on bronze, datasets and secrets is declared here and applied by the owning module; all keys are static.
resource "google_service_account" "this" {
  for_each = {
    ingest   = "compras-ingest"
    dataform = "compras-dataform"
    workflow = "compras-workflow"
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
  }

  ingest_raw = [
    { role = "roles/bigquery.dataEditor", member = local.members["ingest"] },
    { role = "roles/bigquery.dataViewer", member = local.members["dataform"] },
  ]
  dataform_writes = [{ role = "roles/bigquery.dataEditor", member = local.members["dataform"] }]
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
