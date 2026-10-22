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
  ]
  # Project-level roles CI may grant to the pipeline accounts; anything else (billing included) is denied.
  ci_grantable_project_roles = ["roles/bigquery.jobUser"]
  ci_iam_admin_condition     = "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly([${join(", ", formatlist("'%s'", local.ci_grantable_project_roles))}])"
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
