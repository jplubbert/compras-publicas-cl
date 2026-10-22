# Bootstrap root (state bucket, WIF, CI service account, budget and billing kill switch, and the state backup bucket
# in a separate project): applied by hand by the user, with local state.
provider "google" {
  project = var.project_id
  region  = var.region
  # The Billing Budgets API needs a quota project with the user's ADC.
  user_project_override = true
  billing_project       = var.project_id
}

# Separate project for the state backup bucket, outside the budget filter and the kill switch (REQ-016, S-15).
provider "google" {
  alias   = "backup"
  project = var.backup_project_id
  region  = var.region
}

# Null-safe copies of the required variables: a missing value only yields its validation error.
locals {
  project_id        = var.project_id == null ? "" : var.project_id
  backup_project_id = var.backup_project_id == null ? "" : var.backup_project_id
  region            = var.region == null ? "" : var.region
  github_repository = var.github_repository == null ? "" : var.github_repository
  billing_account   = var.billing_account == null ? "" : var.billing_account
  alert_email       = var.alert_email == null ? "" : var.alert_email
}
