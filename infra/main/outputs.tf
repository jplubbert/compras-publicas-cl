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

output "orchestration" {
  description = "Scheduler job, Workflow, Dataform repository and failure alert of the daily run (REQ-007)."
  value       = module.orchestration.orchestration
}

output "workflow_actas" {
  description = "actAs grant of the Workflow account on the Dataform account."
  value       = module.iam.workflow_actas
}

output "ci_actas_pipeline" {
  description = "actAs grants of the CI account on the Dataform, Workflow and Scheduler accounts."
  value       = module.iam.ci_actas_pipeline
}

output "dataform_agent_actas" {
  description = "Grants of the Dataform service agent on the Dataform account."
  value       = module.iam.dataform_agent_actas
}

output "job_invokers" {
  description = "Members that may run the ingest jobs."
  value       = module.iam.job_invokers
}

output "policy_tag_rut" {
  description = "Full name of the dato_personal.rut policy tag; deploy.yml passes it to Dataform (REQ-014)."
  value       = module.governance.policy_tag_rut
}

output "taxonomy" {
  description = "Taxonomy of the personal data (REQ-014)."
  value       = module.governance.taxonomy
}

output "policy_tags" {
  description = "Policy tags of the taxonomy."
  value       = module.governance.policy_tags
}

output "policy_tag_bindings" {
  description = "Fine-grained reader grants on the rut policy tag."
  value       = module.governance.policy_tag_bindings
}

output "sal_table" {
  description = "Salt table of proveedor_key (DEC-008)."
  value       = module.governance.sal_table
}

output "sal_table_ci" {
  description = "Salt table of the CI run (REQ-014 E8)."
  value       = module.governance.sal_table_ci
}

output "release_config" {
  description = "Dataform release configuration of main (T-11, REQ-014)."
  value       = module.orchestration.release_config
}

output "enabled_apis" {
  description = "APIs enabled by this root."
  value       = module.apis.services
}
