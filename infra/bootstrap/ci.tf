# CI service account that applies infra/main. It gets no billing, owner, editor or Pub/Sub role (DEC-003, REQ-003).
locals {
  ci_project_roles = [
    "roles/storage.admin",
    "roles/bigquery.admin",
    "roles/secretmanager.admin",
    "roles/iam.serviceAccountAdmin",
    "roles/serviceusage.serviceUsageAdmin",
    # infra/main sets the BigQuery query quotas (S-07).
    "roles/cloudquotas.admin",
    # infra/main creates the ingest Cloud Run Jobs and their image repository; deploy.yml updates them (REQ-006).
    "roles/run.admin",
    "roles/artifactregistry.admin",
    # T-11: infra/main creates the Workflow, the Scheduler job, the Dataform repository and the failure alert policy.
    "roles/workflows.admin",
    "roles/cloudscheduler.admin",
    "roles/dataform.admin",
    "roles/monitoring.editor",
    # DEC-012: the partial-day alert is a log-match policy, which needs logging.notificationRules.* (configWriter: log
    # metrics, sinks and notification rules; no access to log data).
    "roles/logging.configWriter",
    # T-14: infra/main creates the taxonomy, the policy tags and their IAM bindings.
    "roles/datacatalog.categoryAdmin",
  ]
  # Project-level roles CI may grant to the pipeline accounts; anything else (billing included) is denied.
  ci_grantable_project_roles = [
    "roles/bigquery.jobUser",
    "roles/workflows.invoker",
    "roles/dataform.editor",
    "roles/run.viewer",
    # T-14: compras-dataform reads the taxonomy to set the policy tag on a column.
    "roles/datacatalog.viewer",
  ]
  ci_iam_admin_condition = "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly([${join(", ", formatlist("'%s'", local.ci_grantable_project_roles))}])"
}

resource "google_service_account" "ci" {
  project      = local.project_id
  account_id   = "compras-ci"
  display_name = "CI (GitHub Actions)"

  depends_on = [google_project_service.this]
}

resource "google_service_account_iam_member" "ci_wif" {
  service_account_id = google_service_account.ci.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${local.github_repository}"
}

resource "google_project_iam_member" "ci" {
  for_each = toset(local.ci_project_roles)

  project = local.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.ci.email}"
}

resource "google_project_iam_member" "ci_iam_admin" {
  project = local.project_id
  role    = "roles/resourcemanager.projectIamAdmin"
  member  = "serviceAccount:${google_service_account.ci.email}"

  condition {
    title      = "solo-roles-del-pipeline"
    expression = local.ci_iam_admin_condition
  }
}
