output "state_bucket" {
  description = "Bucket holding the infra/main state (backend-config bucket=…)."
  value       = google_storage_bucket.state.name
}

output "workload_identity_provider" {
  description = "Full WIF provider name for google-github-actions/auth."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "ci_service_account" {
  description = "Email of the CI service account."
  value       = google_service_account.ci.email
}

output "ci_project_roles" {
  description = "Project-level roles of the CI service account."
  value       = concat([for m in google_project_iam_member.ci : m.role], [google_project_iam_member.ci_iam_admin.role])
}

output "budget_topic" {
  description = "Pub/Sub topic that receives the budget updates."
  value       = google_pubsub_topic.budget.id
}

output "killswitch_service_account" {
  description = "Email of the kill switch service account."
  value       = google_service_account.killswitch.email
}

output "killswitch_billing_grant" {
  description = "Billing role of the kill switch and where it is granted (DEC-009)."
  value = {
    role  = var.killswitch_billing_role
    scope = var.killswitch_billing_role == "roles/billing.projectManager" ? "project" : "billing_account"
  }
}

output "ci_iam_admin_condition" {
  description = "IAM condition limiting which roles CI can grant."
  value       = google_project_iam_member.ci_iam_admin.condition[0].expression
}
