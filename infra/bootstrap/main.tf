# Bootstrap root (state bucket, WIF, CI service account, budget and billing kill switch): applied by hand by the user,
# with local state.
provider "google" {
  project = var.project_id
  region  = var.region
  # The Billing Budgets API needs a quota project with the user's ADC.
  user_project_override = true
  billing_project       = var.project_id
}

# Null-safe copies of the required variables: a missing value only yields its validation error.
locals {
  project_id        = var.project_id == null ? "" : var.project_id
  region            = var.region == null ? "" : var.region
  github_repository = var.github_repository == null ? "" : var.github_repository
  billing_account   = var.billing_account == null ? "" : var.billing_account
  alert_email       = var.alert_email == null ? "" : var.alert_email
}
