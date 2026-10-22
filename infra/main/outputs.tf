# Everything the offline tests check is exported here (terraform test only sees root objects).
output "bronze_bucket" {
  description = "Bronze bucket summary."
  value       = module.storage.bronze_bucket
}

output "bronze_bindings" {
  description = "Bindings of the bronze bucket policy."
  value       = module.storage.bronze_bindings
}

output "datasets" {
  description = "Dataset summary."
  value       = module.bigquery.datasets
}

output "pipeline_members" {
  description = "IAM members of the pipeline service accounts."
  value       = module.iam.pipeline_members
}

output "service_accounts" {
  description = "Service account email per component."
  value       = module.iam.emails
}

output "project_bindings" {
  description = "Project-level grants of the pipeline accounts."
  value       = module.iam.project_bindings
}

output "dataset_access" {
  description = "Dataset grants with predefined roles."
  value       = module.iam.dataset_access
}

output "secret_ids" {
  description = "Ids of the secrets."
  value       = module.secrets.secret_ids
}

output "bq_quotas" {
  description = "BigQuery daily query quotas (S-07)."
  value       = module.quotas.bq_quotas
}

output "secret_bindings" {
  description = "Secret grants."
  value       = module.secrets.secret_bindings
}

output "raw_tables" {
  description = "Raw tables of raw and raw_ci (REQ-006)."
  value       = module.bigquery.raw_tables
}

output "ingest_jobs" {
  description = "Ingest Cloud Run Jobs."
  value       = module.ingest_job.ingest_jobs
}

output "ingest_repository" {
  description = "Artifact Registry repository of the ingest image."
  value       = module.ingest_job.repository
}

output "ci_actas" {
  description = "actAs grant of the CI account on the ingest account."
  value       = module.iam.ci_actas
}

output "enabled_apis" {
  description = "APIs enabled by this root."
  value       = module.apis.services
}
