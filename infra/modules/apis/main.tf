# APIs used by the pipeline (DEC-001, DEC-002).
locals {
  services = [for s in [
    "storage",
    "bigquery",
    "secretmanager",
    "iam",
    "iamcredentials",
    "cloudresourcemanager",
    "serviceusage",
    "run",
    "workflows",
    "cloudscheduler",
    "dataform",
    "artifactregistry",
    "cloudquotas",
    "datacatalog",
    "bigquerydatapolicy",
    "logging",
    "monitoring",
  ] : "${s}.googleapis.com"]
}

resource "google_project_service" "this" {
  for_each = toset(local.services)

  project                    = var.project_id
  service                    = each.key
  disable_on_destroy         = false
  disable_dependent_services = false
}
