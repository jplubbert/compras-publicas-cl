# Offline tests of the main root (REQ-001, DEC-001, DEC-004, DEC-005).
mock_provider "google" {
  # The provider validates service_account_id, so the mocked name must look real (emails stay random).
  mock_resource "google_service_account" {
    defaults = {
      name = "projects/demo-proj/serviceAccounts/compras-mock@demo-proj.iam.gserviceaccount.com"
    }
  }
  # Fixed ids: random 12-digit numbers would trip check:repo (literal-account).
  mock_data "google_monitoring_notification_channel" {
    defaults = {
      name = "projects/demo-proj/notificationChannels/1"
    }
  }
  mock_resource "google_data_catalog_taxonomy" {
    defaults = {
      id   = "projects/demo-proj/locations/us-central1/taxonomies/1"
      name = "projects/demo-proj/locations/us-central1/taxonomies/1"
    }
  }
  mock_resource "google_data_catalog_policy_tag" {
    defaults = {
      name = "projects/demo-proj/locations/us-central1/taxonomies/1/policyTags/2"
    }
  }
}

# The parent tag gets its own name, so the parent-child link is not trivially true.
override_resource {
  target = module.governance.google_data_catalog_policy_tag.dato_personal
  values = {
    name = "projects/demo-proj/locations/us-central1/taxonomies/1/policyTags/1"
  }
}
mock_provider "google-beta" {
  mock_resource "google_project_service_identity" {
    defaults = {
      email  = "service-0@gcp-sa-dataform.iam.gserviceaccount.com"
      member = "serviceAccount:service-0@gcp-sa-dataform.iam.gserviceaccount.com"
    }
  }
}

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

# REQ-007 E1: the Scheduler starts compras-diario at 23:30 America/Santiago, once, as its own account.
run "t11_e1_scheduler" {
  command = apply

  assert {
    condition = (output.orchestration.scheduler.schedule == "30 23 * * *" && output.orchestration.scheduler.time_zone == "America/Santiago"
    && output.orchestration.scheduler.region == "us-central1")
    error_message = "the Scheduler must run at 30 23 * * * America/Santiago in var.region"
  }
  assert {
    condition = (startswith(output.orchestration.scheduler.uri, "https://workflowexecutions.googleapis.com/v1/")
    && endswith(output.orchestration.scheduler.uri, "/executions"))
    error_message = "the Scheduler must create an execution of the Workflow"
  }
  assert {
    condition     = output.orchestration.scheduler.service_account == output.service_accounts["scheduler"] && output.orchestration.scheduler.retry_count == 0
    error_message = "the Scheduler starts the Workflow as compras-scheduler, without retries"
  }
}

# REQ-007 / DEC-002: the Workflow runs the daily.yaml file as is, as the Workflow account.
run "t11_workflow" {
  command = apply

  assert {
    condition = (output.orchestration.workflow.name == "compras-diario" && output.orchestration.workflow.region == "us-central1"
    && output.orchestration.workflow.service_account == output.service_accounts["workflow"])
    error_message = "the Workflow is compras-diario, in var.region, as the Workflow account"
  }
  assert {
    condition     = output.orchestration.workflow.source_contents == file("../../orchestration/daily.yaml")
    error_message = "the Workflow source must be orchestration/daily.yaml untouched"
  }
  assert {
    condition = alltrue([for e in ["JOB_MERCADOPUBLICO", "JOB_INDICADORES", "DATAFORM_REPOSITORY", "DATAFORM_SERVICE_ACCOUNT", "RAW_DATASET", "POLICY_TAG_RUT"] :
    contains(output.orchestration.workflow.env_names, e)])
    error_message = "the Workflow needs the job, repository, Dataform account, raw dataset and policy tag env vars"
  }
}

# DEC-002 / DEC-009: the Dataform repository pulls main from GitHub with the token of Secret Manager.
run "t11_repositorio_dataform" {
  command = apply

  assert {
    condition = (output.orchestration.repository.url == "https://github.com/demo-owner/compras-publicas-cl.git"
    && output.orchestration.repository.default_branch == "main")
    error_message = "the repository must track main of the GitHub repository"
  }
  assert {
    condition     = endswith(output.orchestration.repository.token_secret_version, "/secrets/dataform-github-token/versions/latest")
    error_message = "the repository must read the latest version of dataform-github-token"
  }
  assert {
    condition     = output.orchestration.repository.service_account == output.service_accounts["dataform"]
    error_message = "the repository runs as the Dataform account"
  }
  assert {
    condition = anytrue([for b in output.secret_bindings : b.secret_id == "dataform-github-token" && b.role == "roles/secretmanager.secretAccessor"
    && b.member == "serviceAccount:service-0@gcp-sa-dataform.iam.gserviceaccount.com"])
    error_message = "the Dataform service agent must read the GitHub token"
  }
}

# REQ-007 E4: a failed execution of compras-diario alerts the email channel.
run "t11_e4_alerta" {
  command = apply

  assert {
    condition = (strcontains(output.orchestration.alert.filter, "workflows.googleapis.com/finished_execution_count")
      && strcontains(output.orchestration.alert.filter, "metric.label.status = \"FAILED\"")
    && strcontains(output.orchestration.alert.filter, "compras-diario"))
    error_message = "the alert must count failed executions of compras-diario"
  }
  assert {
    condition     = tolist(output.orchestration.alert.notification_channels) == tolist(["projects/demo-proj/notificationChannels/1"])
    error_message = "the alert must notify the email channel"
  }
}

# REQ-007: grants of the Scheduler, the Workflow, the Dataform agent and CI.
run "t11_permisos" {
  command = apply

  assert {
    condition     = contains(output.project_bindings, { role = "roles/workflows.invoker", member = "serviceAccount:${output.service_accounts["scheduler"]}" })
    error_message = "the Scheduler account must invoke the Workflow"
  }
  assert {
    condition = alltrue([for r in ["roles/dataform.editor", "roles/run.viewer"] :
    contains(output.project_bindings, { role = r, member = "serviceAccount:${output.service_accounts["workflow"]}" })])
    error_message = "the Workflow account must drive Dataform and read the job executions"
  }
  assert {
    condition     = alltrue([for j in values(output.ingest_jobs) : contains(j.invokers, "serviceAccount:${output.service_accounts["workflow"]}")])
    error_message = "the Workflow account must run both ingest jobs"
  }
  assert {
    condition = (output.workflow_actas.role == "roles/iam.serviceAccountUser"
      && output.workflow_actas.member == "serviceAccount:${output.service_accounts["workflow"]}"
    && output.workflow_actas.service_account_email == output.service_accounts["dataform"])
    error_message = "the Workflow account must act as the Dataform account (strict act-as mode)"
  }
  assert {
    condition = (length(output.dataform_agent_actas) == 2 && alltrue([for r in ["roles/iam.serviceAccountUser", "roles/iam.serviceAccountTokenCreator"] :
      anytrue([for g in output.dataform_agent_actas : g.role == r && g.member == "serviceAccount:service-0@gcp-sa-dataform.iam.gserviceaccount.com"
    && g.service_account_email == output.service_accounts["dataform"]])]))
    error_message = "the Dataform service agent must use and mint tokens of the Dataform account"
  }
  assert {
    condition = alltrue([for k in ["dataform", "workflow", "scheduler"] :
      output.ci_actas_pipeline[k].role == "roles/iam.serviceAccountUser"
      && output.ci_actas_pipeline[k].member == "serviceAccount:compras-ci@demo-proj.iam.gserviceaccount.com"
    && output.ci_actas_pipeline[k].service_account_email == output.service_accounts[k]])
    error_message = "the CI account must act as the Dataform, Workflow and Scheduler accounts"
  }
  assert {
    condition     = output.ci_actas.member == "serviceAccount:compras-ci@demo-proj.iam.gserviceaccount.com"
    error_message = "the CI actAs on the ingest account must stay"
  }
}

# DEC-002: schedule and time zone are variables.
run "t11_horario_variable" {
  command = plan
  variables {
    schedule = "0 22 * * *"
  }

  assert {
    condition     = output.orchestration.scheduler.schedule == "0 22 * * *"
    error_message = "the Scheduler must take var.schedule"
  }
}

# REQ-014 E1: taxonomy compras_publicas with fine-grained access control and the tag dato_personal.rut.
run "t14_e1_taxonomia" {
  command = apply
  variables {
    pii_readers = ["group:analistas@example.com"]
  }

  assert {
    condition = (output.taxonomy.display_name == "compras_publicas"
      && tolist(output.taxonomy.activated_policy_types) == tolist(["FINE_GRAINED_ACCESS_CONTROL"])
    && output.taxonomy.region == "us-central1")
    error_message = "the taxonomy must be compras_publicas, with FINE_GRAINED_ACCESS_CONTROL, in var.region"
  }
  assert {
    condition     = output.policy_tags["rut"].parent_policy_tag == output.policy_tags["dato_personal"].name
    error_message = "the tag rut must be a child of dato_personal"
  }
  assert {
    condition     = output.policy_tags["dato_personal"].parent_policy_tag == null || output.policy_tags["dato_personal"].parent_policy_tag == ""
    error_message = "dato_personal must be a root tag"
  }
  assert {
    condition     = output.policy_tag_rut == output.policy_tags["rut"].name && endswith(output.policy_tag_rut, "/policyTags/2")
    error_message = "policy_tag_rut must be the full name of the rut tag"
  }
}

# REQ-014 E1: the fine-grained reader role on rut only for pii_readers, Dataform and CI.
run "t14_e1_bindings" {
  command = apply
  variables {
    pii_readers = ["group:analistas@example.com"]
  }

  assert {
    condition = toset([for b in output.policy_tag_bindings : b.member]) == toset([
      "group:analistas@example.com",
      "serviceAccount:${output.service_accounts["dataform"]}",
      "serviceAccount:compras-ci@demo-proj.iam.gserviceaccount.com",
    ])
    error_message = "only pii_readers and the Dataform and CI accounts may read the rut tag"
  }
  assert {
    condition = alltrue([for b in output.policy_tag_bindings :
    b.role == "roles/datacatalog.categoryFineGrainedReader" && b.policy_tag == output.policy_tag_rut])
    error_message = "every grant is categoryFineGrainedReader on the rut tag"
  }
}

run "t14_e1_bindings_sin_pii_readers" {
  command = apply

  assert {
    condition = toset([for b in output.policy_tag_bindings : b.member]) == toset([
      "serviceAccount:${output.service_accounts["dataform"]}",
      "serviceAccount:compras-ci@demo-proj.iam.gserviceaccount.com",
    ])
    error_message = "without pii_readers only the Dataform and CI accounts read the rut tag"
  }
}

run "t14_pii_readers_invalido" {
  command = plan
  variables {
    pii_readers = ["analistas@example.com"]
  }
  expect_failures = [var.pii_readers]
}

# Dataform needs bigquery.tables.setCategory on silver and gold and datacatalog.taxonomies.get to set the tag.
run "t14_dataform_asigna_tags" {
  command = apply

  assert {
    condition = alltrue([for k in ["silver", "gold"] :
    contains(output.dataset_access[k], { role = "roles/bigquery.dataOwner", member = "serviceAccount:${output.service_accounts["dataform"]}" })])
    error_message = "Dataform needs bigquery.tables.setCategory (dataOwner) on silver and gold"
  }
  assert {
    condition = alltrue([for k in ["silver", "gold"] :
    anytrue([for a in output.datasets[k].access : a.role == "OWNER" && a.user_by_email == output.service_accounts["dataform"]])])
    error_message = "silver and gold must grant OWNER to the Dataform account (bigquery.tables.setCategory)"
  }
  assert {
    condition = contains([for b in output.project_bindings : b.role if b.member == "serviceAccount:${output.service_accounts["dataform"]}"],
    "roles/datacatalog.viewer")
    error_message = "Dataform needs datacatalog.taxonomies.get (datacatalog.viewer) in the project"
  }
}

# DEC-008: empty salt table in pii; only the pipeline writes it (the e6 checks above keep pii closed).
run "t14_sal" {
  command = plan

  assert {
    condition = (output.sal_table.dataset_id == "pii" && output.sal_table.table_id == "sal"
    && output.sal_table.deletion_protection && output.sal_table.columns == ["sal"])
    error_message = "pii.sal must exist, be protected and have the single column sal"
  }
}

run "t14_pii_sin_owner_de_dataform" {
  command = apply

  assert {
    condition     = !anytrue([for a in output.datasets["pii"].access : a.role == "OWNER" && a.user_by_email == output.service_accounts["dataform"]])
    error_message = "Dataform must keep WRITER, not OWNER, on pii"
  }
  assert {
    condition     = anytrue([for a in output.datasets["pii"].access : a.role == "WRITER" && a.user_by_email == output.service_accounts["dataform"]])
    error_message = "Dataform must write pii (generar_sal)"
  }
}

# REQ-014: policy_tag_rut reaches the Dataform compilation of the release config.
run "t14_policy_tag_en_dataform" {
  command = apply

  assert {
    condition = (output.release_config.vars["policy_tag_rut"] == output.policy_tag_rut
    && output.release_config.vars["raw_dataset"] == "raw" && output.release_config.git_commitish == "main")
    error_message = "the release config compiles main with raw_dataset and policy_tag_rut"
  }
  assert {
    condition     = output.release_config.default_database == "demo-proj" && output.release_config.default_location == "us-central1"
    error_message = "the release config compiles into the project and var.region"
  }
}

# REQ-014 E4: compras-lector reads silver and gold, holds no fine-grained role and never sees pii.
run "t14_lector" {
  command = apply

  assert {
    condition     = [for b in output.project_bindings : b.role if b.member == "serviceAccount:${output.service_accounts["lector"]}"] == ["roles/bigquery.jobUser"]
    error_message = "compras-lector may only hold bigquery.jobUser at project level"
  }
  assert {
    condition = alltrue([for k in ["silver", "gold"] :
    contains(output.dataset_access[k], { role = "roles/bigquery.dataViewer", member = "serviceAccount:${output.service_accounts["lector"]}" })])
    error_message = "compras-lector must read silver and gold"
  }
  assert {
    condition = alltrue([for k in ["raw", "raw_ci", "quarantine", "quarantine_ci", "pii"] :
    !anytrue([for a in output.datasets[k].access : a.user_by_email == output.service_accounts["lector"]])])
    error_message = "compras-lector must not reach raw, quarantine or pii"
  }
  assert {
    condition     = !contains([for b in output.policy_tag_bindings : b.member], "serviceAccount:${output.service_accounts["lector"]}")
    error_message = "compras-lector must not read the rut tag"
  }
}
