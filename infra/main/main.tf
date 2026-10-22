# Main root, applied by CI (deploy.yml).
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

module "apis" {
  source     = "../modules/apis"
  project_id = local.project_id
}

module "iam" {
  source     = "../modules/iam"
  project_id = local.project_id
  depends_on = [module.apis]
}

module "storage" {
  source          = "../modules/storage"
  project_id      = local.project_id
  region          = local.region
  bucket_bindings = module.iam.bucket_bindings
  depends_on      = [module.apis]
}

module "bigquery" {
  source         = "../modules/bigquery"
  project_id     = local.project_id
  region         = local.region
  dataset_access = module.iam.dataset_access
  depends_on     = [module.apis]
}

module "secrets" {
  source           = "../modules/secrets"
  project_id       = local.project_id
  region           = local.region
  secret_accessors = module.iam.secret_accessors
  depends_on       = [module.apis]
}
