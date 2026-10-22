variable "project_id" {
  description = "GCP project id."
  type        = string
}

variable "region" {
  description = "Region of the Dataform repository, the Workflow and the Scheduler job."
  type        = string
}

variable "github_repository" {
  description = "GitHub repository the Dataform repository pulls from, as owner/name (DEC-002)."
  type        = string
}

variable "github_token_secret_id" {
  description = "Full id of the secret holding the GitHub token (projects/…/secrets/dataform-github-token, DEC-004)."
  type        = string
}

variable "dataform_service_account_email" {
  description = "Account Dataform runs invocations as (compras-dataform)."
  type        = string
}

variable "workflow_service_account_email" {
  description = "Account the Workflow runs as (compras-workflow)."
  type        = string
}

variable "scheduler_service_account_email" {
  description = "Account the Scheduler job starts the Workflow with (compras-scheduler)."
  type        = string
}

variable "job_mercadopublico" {
  description = "Name of the Mercado Público ingest job."
  type        = string
}

variable "job_indicadores" {
  description = "Name of the indicators ingest job."
  type        = string
}

variable "raw_dataset" {
  description = "Raw dataset passed to the Dataform compilation."
  type        = string
  default     = "raw"
}

variable "schedule" {
  description = "Cron schedule of the daily run (REQ-007, DEC-002)."
  type        = string
  default     = "30 23 * * *"
}

variable "time_zone" {
  description = "Time zone of the schedule."
  type        = string
  default     = "America/Santiago"
}

variable "alert_channel_ids" {
  description = "Notification channels of the failed execution alert."
  type        = list(string)
}
