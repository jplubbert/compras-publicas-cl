# Bootstrap root (state bucket, WIF, CI service account; budget and kill switch arrive in T-05): applied by hand by
# the user, with local state.
provider "google" {
  project = var.project_id
  region  = var.region
}

# Null-safe copies of the required variables: a missing value only yields its validation error.
locals {
  project_id        = var.project_id == null ? "" : var.project_id
  region            = var.region == null ? "" : var.region
  github_repository = var.github_repository == null ? "" : var.github_repository
}
