variable "project_id" {
  description = "GCP project id."
  type        = string
}

variable "region" {
  description = "Region of the repository and the jobs."
  type        = string
}

variable "service_account_email" {
  description = "Service account the jobs run as (compras-ingest)."
  type        = string
}

variable "bronze_bucket" {
  description = "Bronze bucket name."
  type        = string
}

variable "raw_dataset" {
  description = "Dataset the load jobs write to."
  type        = string
  default     = "raw"
}

variable "job_invokers" {
  description = "Members granted roles/run.invoker on every job (the Workflow account, REQ-007)."
  type        = list(string)
  default     = []
}

variable "mp_daily_request_budget" {
  description = "Daily request budget of the Mercado Público job (S-06)."
  type        = number
  default     = 9000
}

variable "mp_request_interval" {
  description = "Seconds between the starts of two requests of the Mercado Público job (S-28); 0 disables the pacing."
  type        = number
  default     = 1
}
