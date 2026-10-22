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
    silver        = local.dataform_writes
    gold          = local.dataform_writes
    silver_ci     = local.dataform_writes
    gold_ci       = local.dataform_writes
    bench         = []
  }
}

output "secret_accessors" {
  description = "Secret accessors: secret => {component => member}. The Dataform token accessor arrives in T-11."
  value = {
    "mercadopublico-ticket" = { ingest = local.members["ingest"] }
    "bcentral-token"        = { ingest = local.members["ingest"] }
    "dataform-github-token" = {}
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
