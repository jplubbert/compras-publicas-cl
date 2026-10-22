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

# REQ-006 / REQ-007: the two ingest jobs, 7 h timeout, no retries, the ingest account and no secret env vars.
run "t08_ingest_jobs" {
  command = apply

  assert {
    condition     = output.ingest_jobs["mercadopublico"].name == "compras-mercadopublico" && output.ingest_jobs["indicadores"].name == "compras-indicadores"
    error_message = "the jobs must be compras-mercadopublico and compras-indicadores"
  }
  assert {
    condition = alltrue([for j in values(output.ingest_jobs) :
    j.location == "us-central1" && j.timeout == "25200s" && j.max_retries == 0 && j.service_account == output.service_accounts["ingest"]])
    error_message = "every job runs in var.region for up to 7 h, without retries, as the ingest account"
  }
  assert {
    condition     = output.ingest_jobs["mercadopublico"].args == tolist(["mercadopublico"]) && output.ingest_jobs["indicadores"].args == tolist(["indicadores"])
    error_message = "each job runs its own subcommand"
  }
  assert {
    condition = alltrue([for j in values(output.ingest_jobs) :
    alltrue([for e in ["BRONZE_BUCKET", "GOOGLE_CLOUD_PROJECT", "RAW_DATASET"] : contains(j.env_names, e)]) && length(j.secret_env) == 0])
    error_message = "the jobs need the bucket, project and raw dataset, and no secret env var (DEC-004)"
  }
  assert {
    condition     = contains(output.ingest_jobs["mercadopublico"].env_names, "MP_DAILY_REQUEST_BUDGET")
    error_message = "the Mercado Público job sets its request budget"
  }
  assert {
    condition     = output.ingest_repository.format == "DOCKER" && output.ingest_repository.location == "us-central1" && output.ingest_repository.repository_id == "compras"
    error_message = "the image repository is Docker in var.region"
  }
}

# REQ-006 / DEC-006: 7 raw tables in raw and raw_ci, partitioned by _ingest_date, with the load job schema.
run "t08_raw_tables" {
  command = plan

  assert {
    condition     = length(output.raw_tables) == 14
    error_message = "there must be 7 raw tables in raw and in raw_ci"
  }
  assert {
    condition     = alltrue([for t in values(output.raw_tables) : t.partition_field == "_ingest_date" && t.partition_type == "DAY" && t.expiration_ms == 34560000000])
    error_message = "raw tables are partitioned by day on _ingest_date and expire after 400 days"
  }
  assert {
    condition     = alltrue([for k, t in output.raw_tables : t.schema == jsondecode(file("../../ingest/schemas/${split(".", k)[1]}.json"))])
    error_message = "each raw table uses its ingest/schemas file"
  }
  assert {
    condition     = alltrue([for k, t in output.raw_tables : t.deletion_protection == (split(".", k)[0] == "raw") && t.labels["layer"] == "raw" && t.description != ""])
    error_message = "raw tables are protected (raw_ci is not), labelled layer=raw and described"
  }
}

# REQ-006: CI may act as the ingest account to create and update its jobs.
run "t08_ci_actas" {
  command = apply

  assert {
    condition     = output.ci_actas.role == "roles/iam.serviceAccountUser" && output.ci_actas.member == "serviceAccount:compras-ci@demo-proj.iam.gserviceaccount.com"
    error_message = "the CI account must hold serviceAccountUser"
  }
  assert {
    condition     = endswith(output.ci_actas.service_account, "/serviceAccounts/compras-mock@demo-proj.iam.gserviceaccount.com")
    error_message = "the actAs grant must be on the ingest service account"
  }
}

run "t08_apis" {
  command = plan

  assert {
    condition     = contains(output.enabled_apis, "run.googleapis.com") && contains(output.enabled_apis, "artifactregistry.googleapis.com")
    error_message = "the Run and Artifact Registry APIs must be enabled"
  }
}
