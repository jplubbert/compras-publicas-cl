# Daily orchestration (REQ-007, DEC-002): Scheduler -> Workflow compras-diario -> ingest jobs -> Dataform from main.
resource "google_dataform_repository" "this" {
  project         = var.project_id
  region          = var.region
  name            = "compras-publicas-cl"
  service_account = var.dataform_service_account_email

  # The user loads the token version by hand (DEC-004, DEC-009); Terraform only names it.
  git_remote_settings {
    url                                 = "https://github.com/${var.github_repository}.git"
    default_branch                      = "main"
    authentication_token_secret_version = "${var.github_token_secret_id}/versions/latest"
  }
}

resource "google_workflows_workflow" "daily" {
  project             = var.project_id
  region              = var.region
  name                = "compras-diario"
  service_account     = var.workflow_service_account_email
  deletion_protection = false
  # file(), not templatefile(): the ${…} expressions belong to Workflows.
  source_contents = file("${path.module}/../../../orchestration/daily.yaml")

  user_env_vars = {
    JOB_MERCADOPUBLICO       = var.job_mercadopublico
    JOB_INDICADORES          = var.job_indicadores
    DATAFORM_REPOSITORY      = google_dataform_repository.this.name
    DATAFORM_SERVICE_ACCOUNT = var.dataform_service_account_email
    RAW_DATASET              = var.raw_dataset
  }
}

resource "google_cloud_scheduler_job" "daily" {
  project   = var.project_id
  region    = var.region
  name      = "compras-diario"
  schedule  = var.schedule
  time_zone = var.time_zone

  # No retries: a second execution would load the day twice.
  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "POST"
    uri         = "https://workflowexecutions.googleapis.com/v1/${google_workflows_workflow.daily.id}/executions"

    oauth_token {
      service_account_email = var.scheduler_service_account_email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }
}

resource "google_monitoring_alert_policy" "workflow_failed" {
  project               = var.project_id
  display_name          = "Workflow compras-diario falló"
  combiner              = "OR"
  notification_channels = var.alert_channel_ids

  conditions {
    display_name = "Ejecución fallida de compras-diario"

    condition_threshold {
      filter          = "resource.type = \"workflows.googleapis.com/Workflow\" AND metric.type = \"workflows.googleapis.com/finished_execution_count\" AND metric.label.status = \"FAILED\" AND resource.label.workflow_id = \"${google_workflows_workflow.daily.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "Falló una ejecución del Workflow compras-diario. Revisa la ejecución en la consola de Workflows (el paso que falló y su error) y, si llegó a Dataform, la invocación en el repositorio compras-publicas-cl de Dataform."
  }
}
