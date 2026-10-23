output "emails" {
  description = "Service account email per component."
  value       = { for k, sa in google_service_account.this : k => sa.email }
}

output "pipeline_members" {
  description = "IAM members of the pipeline service accounts."
  value       = values(local.members)
}

output "project_bindings" {
  description = "Project-level grants of the pipeline accounts."
  value       = [for b in google_project_iam_member.this : { role = b.role, member = b.member }]
}

output "bucket_bindings" {
  description = "Bronze bucket bindings: role => members."
  value       = { "roles/storage.objectUser" = [local.members["ingest"]] }
}

output "dataset_access" {
  description = "Dataset grants with predefined roles: dataset => [{role, member}]."
  value = {
    raw           = local.ingest_raw
    raw_ci        = local.ingest_raw
    quarantine    = local.dataform_writes
    quarantine_ci = local.dataform_writes
    pii           = local.dataform_writes
    silver        = concat(local.dataform_owns, local.lector_reads)
    gold          = concat(local.dataform_owns, local.lector_reads)
    silver_ci     = local.dataform_writes
    gold_ci       = local.dataform_writes
    bench         = []
  }
}

output "secret_accessors" {
  description = "Secret accessors: secret => {component => member}. The Dataform service agent reads the GitHub token."
  value = {
    "mercadopublico-ticket" = { ingest = local.members["ingest"] }
    "bcentral-token"        = { ingest = local.members["ingest"] }
    "dataform-github-token" = { dataform_agent = google_project_service_identity.dataform.member }
  }
}

output "ci_actas" {
  description = "actAs grant of the CI account on the ingest account."
  value = {
    role            = google_service_account_iam_member.ci_actas_ingest.role
    member          = google_service_account_iam_member.ci_actas_ingest.member
    service_account = google_service_account_iam_member.ci_actas_ingest.service_account_id
  }
}

output "workflow_actas" {
  description = "actAs grant of the Workflow account on the Dataform account (Dataform strict act-as mode)."
  value = {
    role                  = google_service_account_iam_member.workflow_actas_dataform.role
    member                = google_service_account_iam_member.workflow_actas_dataform.member
    service_account       = google_service_account_iam_member.workflow_actas_dataform.service_account_id
    service_account_email = google_service_account.this["dataform"].email
  }
}

output "ci_actas_pipeline" {
  description = "actAs grants of the CI account on the Dataform, Workflow and Scheduler accounts: component => grant."
  value = {
    for k, g in google_service_account_iam_member.ci_actas_pipeline : k => {
      role                  = g.role
      member                = g.member
      service_account       = g.service_account_id
      service_account_email = google_service_account.this[k].email
    }
  }
}

output "dataform_agent_actas" {
  description = "Grants of the Dataform service agent on the Dataform account."
  value = [for g in google_service_account_iam_member.dataform_agent : {
    role                  = g.role
    member                = g.member
    service_account_email = google_service_account.this["dataform"].email
  }]
}

output "job_invokers" {
  description = "Members that may run the ingest jobs."
  value       = [local.members["workflow"]]
}
