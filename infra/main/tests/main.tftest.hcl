# Offline tests of the main root (REQ-001, DEC-001, DEC-004, DEC-005).
mock_provider "google" {
  # The provider validates service_account_id, so the mocked name must look real (emails stay random).
  mock_resource "google_service_account" {
    defaults = {
      name = "projects/demo-proj/serviceAccounts/compras-mock@demo-proj.iam.gserviceaccount.com"
    }
  }
}
mock_provider "google-beta" {}

variables {
  project_id        = "demo-proj"
  region            = "us-central1"
  github_repository = "demo-owner/compras-publicas-cl"
}

run "e1_bronze_y_datasets" {
  command = plan

  assert {
    condition     = output.bronze_bucket.location == "US-CENTRAL1"
    error_message = "bronze must live in var.region"
  }
  assert {
    condition     = output.bronze_bucket.lifecycle_rule_count == 2
    error_message = "bronze must have two lifecycle rules"
  }
  assert {
    condition     = contains(output.bronze_bucket.lifecycle_actions, "SetStorageClass") && contains(output.bronze_bucket.lifecycle_actions, "Delete")
    error_message = "bronze must move to Nearline and then be deleted"
  }
  assert {
    condition     = length(output.datasets) == 10
    error_message = "there must be exactly 10 datasets"
  }
  assert {
    condition = alltrue([for id in ["raw", "silver", "gold", "quarantine", "pii", "bench", "raw_ci", "silver_ci", "gold_ci", "quarantine_ci"] :
    contains(keys(output.datasets), id)])
    error_message = "a medallion dataset is missing"
  }
  assert {
    condition     = alltrue([for d in values(output.datasets) : lookup(d.labels, "layer", "") != "" && d.description != "" && d.location == "us-central1"])
    error_message = "every dataset needs a layer label, a description and var.region"
  }
  assert {
    condition     = output.datasets["bench"].default_table_expiration_ms == 2592000000
    error_message = "bench tables must expire after 30 days"
  }
}

run "e2_sin_project_id" {
  command = plan
  variables {
    project_id = null
  }
  expect_failures = [var.project_id]
}

run "e2_sin_region" {
  command = plan
  variables {
    region = null
  }
  expect_failures = [var.region]
}

run "e2_sin_github_repository" {
  command = plan
  variables {
    github_repository = null
  }
  expect_failures = [var.github_repository]
}

run "e3_region_fuera_de_eeuu" {
  command = plan
  variables {
    region = "southamerica-west1"
  }
  expect_failures = [var.region]
}

run "e5_ingesta" {
  command = apply

  assert {
    condition     = [for b in output.project_bindings : b.role if b.member == "serviceAccount:${output.service_accounts["ingest"]}"] == ["roles/bigquery.jobUser"]
    error_message = "the ingest account may only hold bigquery.jobUser at project level"
  }
  assert {
    condition     = anytrue([for b in output.bronze_bindings : b.role == "roles/storage.objectUser" && contains(b.members, "serviceAccount:${output.service_accounts["ingest"]}")])
    error_message = "the ingest account must write bronze"
  }
  assert {
    condition     = alltrue([for k in ["raw", "raw_ci"] : contains(output.dataset_access[k], { role = "roles/bigquery.dataEditor", member = "serviceAccount:${output.service_accounts["ingest"]}" })])
    error_message = "the ingest account must write raw and raw_ci"
  }
  assert {
    condition     = anytrue([for a in output.datasets["raw"].access : a.role == "WRITER" && a.user_by_email == output.service_accounts["ingest"]])
    error_message = "raw must grant WRITER to the ingest account"
  }
  assert {
    condition = alltrue([for s in ["mercadopublico-ticket", "bcentral-token"] : anytrue([for b in output.secret_bindings :
    b.secret_id == s && b.role == "roles/secretmanager.secretAccessor" && b.member == "serviceAccount:${output.service_accounts["ingest"]}"])])
    error_message = "the ingest account must read the source secrets"
  }
}

run "e6_lectura_restringida" {
  command = apply

  assert {
    condition = alltrue(flatten([for b in output.bronze_bindings : [for m in b.members :
    contains(output.pipeline_members, m) || m == "projectOwner:demo-proj"]]))
    error_message = "only the pipeline and project owners may access bronze"
  }
  assert {
    condition = alltrue(flatten([for k in ["raw", "raw_ci", "quarantine", "quarantine_ci", "pii"] : [for a in output.datasets[k].access :
    a.special_group == "projectOwners" || (a.user_by_email != null && contains(output.pipeline_members, "serviceAccount:${coalesce(a.user_by_email, "-")}"))]]))
    error_message = "restricted datasets may only grant the pipeline and project owners"
  }
  assert {
    condition = alltrue(flatten([for k in ["raw", "raw_ci", "quarantine", "quarantine_ci", "pii"] : [for a in output.datasets[k].access :
    !contains(["projectReaders", "projectWriters", "allUsers", "allAuthenticatedUsers"], coalesce(a.special_group, "-"))]]))
    error_message = "restricted datasets must not be readable by project readers or the public"
  }
}

# REQ-003 E6: daily query quotas of S-07 (50 GiB per project, 20 GiB per user, in MiB).
run "e6_cuotas_bigquery" {
  command = plan

  assert {
    condition     = contains(keys(output.bq_quotas), "QueryUsagePerDay") && contains(keys(output.bq_quotas), "QueryUsagePerUserPerDay")
    error_message = "both BigQuery query quotas must exist"
  }
  assert {
    condition     = alltrue([for q in values(output.bq_quotas) : q.service == "bigquery.googleapis.com" && q.parent == "projects/demo-proj"])
    error_message = "the quotas must apply to bigquery.googleapis.com in this project"
  }
  assert {
    condition     = output.bq_quotas["QueryUsagePerDay"].preferred_value == "51200"
    error_message = "the project quota must be 50 GiB per day"
  }
  assert {
    condition     = output.bq_quotas["QueryUsagePerUserPerDay"].preferred_value == "20480"
    error_message = "the per-user quota must be 20 GiB per day"
  }
}

run "e6_cuota_no_positiva" {
  command = plan
  module {
    source = "../modules/quotas"
  }
  variables {
    query_usage_per_day_gib = 0
  }
  expect_failures = [var.query_usage_per_day_gib]
}

run "secretos_sin_versiones" {
  command = plan

  assert {
    condition     = toset(output.secret_ids) == toset(["mercadopublico-ticket", "bcentral-token", "dataform-github-token"])
    error_message = "the three secrets of DEC-004/DEC-009 must exist"
  }
}
