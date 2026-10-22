# Image repository and the two ingest Cloud Run Jobs (REQ-006, REQ-007). deploy.yml publishes the image and points the
# jobs at it; the jobs read their secrets from Secret Manager at run time, never from env vars (DEC-004).
locals {
  jobs = {
    mercadopublico = "compras-mercadopublico"
    indicadores    = "compras-indicadores"
  }
  common_env = {
    BRONZE_BUCKET        = var.bronze_bucket
    GOOGLE_CLOUD_PROJECT = var.project_id
    RAW_DATASET          = var.raw_dataset
  }
  job_env = {
    mercadopublico = merge(local.common_env, { MP_DAILY_REQUEST_BUDGET = tostring(var.mp_daily_request_budget) })
    indicadores    = local.common_env
  }
  # Placeholder until deploy.yml publishes the first image; Terraform ignores later image changes.
  placeholder_image = "us-docker.pkg.dev/cloudrun/container/job:latest"
}

resource "google_artifact_registry_repository" "ingest" {
  project                = var.project_id
  location               = var.region
  repository_id          = "compras"
  format                 = "DOCKER"
  description            = "Imágenes de los jobs de ingesta."
  cleanup_policy_dry_run = false

  # One image per commit: keep the last 10 and drop older than 30 days (fits the free 0.5 GB).
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "2592000s"
    }
  }
}

resource "google_cloud_run_v2_job" "this" {
  for_each = local.jobs

  project             = var.project_id
  name                = each.value
  location            = var.region
  deletion_protection = false

  template {
    task_count  = 1
    parallelism = 1

    template {
      # 7 h, the window of R-04 (REQ-007). No retries: a second attempt would load the run twice.
      timeout         = "25200s"
      max_retries     = 0
      service_account = var.service_account_email

      containers {
        image = local.placeholder_image
        args  = [each.key]

        dynamic "env" {
          for_each = local.job_env[each.key]
          content {
            name  = env.key
            value = env.value
          }
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image, client, client_version]
  }
}
