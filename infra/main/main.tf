# Main root, applied by CI (deploy.yml).
provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
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
  raw_tables = [
    "mercadopublico_licitaciones",
    "mercadopublico_ordenes_compra",
    "bcentral_uf",
    "bcentral_dolar",
    "bcentral_ipc",
    "mindicador_uf",
    "mindicador_dolar",
  ]
  depends_on = [module.apis]
}

# The jobs wait for every IAM grant (the CI actAs on compras-ingest included) and the Run and Artifact Registry APIs;
# scripts/it/tf-apply.sh retries while that actAs grant propagates.
module "ingest_job" {
  source                = "../modules/ingest_job"
  project_id            = local.project_id
  region                = local.region
  service_account_email = module.iam.emails["ingest"]
  bronze_bucket         = module.storage.bronze_bucket.name
  job_invokers          = module.iam.job_invokers
  depends_on            = [module.apis, module.iam]
}

module "secrets" {
  source           = "../modules/secrets"
  project_id       = local.project_id
  region           = local.region
  secret_accessors = module.iam.secret_accessors
  depends_on       = [module.apis]
}

# Email channel created by infra/bootstrap (budget.tf) with alert_email; the Workflow failure alert reuses it.
data "google_monitoring_notification_channel" "alert_email" {
  project      = local.project_id
  display_name = "Budget alerts"
  type         = "email"
}

# The Dataform agent must already read the token and act as compras-dataform when the repository is created.
module "orchestration" {
  source                          = "../modules/orchestration"
  project_id                      = local.project_id
  region                          = local.region
  github_repository               = local.github_repository
  github_token_secret_id          = module.secrets.secret_names["dataform-github-token"]
  dataform_service_account_email  = module.iam.emails["dataform"]
  workflow_service_account_email  = module.iam.emails["workflow"]
  scheduler_service_account_email = module.iam.emails["scheduler"]
  job_mercadopublico              = module.ingest_job.ingest_jobs["mercadopublico"].name
  job_indicadores                 = module.ingest_job.ingest_jobs["indicadores"].name
  alert_channel_ids               = [data.google_monitoring_notification_channel.alert_email.name]
  schedule                        = var.schedule
  time_zone                       = var.time_zone
  depends_on                      = [module.apis, module.iam, module.secrets]
}

module "quotas" {
  source     = "../modules/quotas"
  project_id = local.project_id
  depends_on = [module.apis]
}
