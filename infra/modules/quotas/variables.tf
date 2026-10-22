variable "project_id" {
  description = "GCP project id."
  type        = string
}

variable "query_usage_per_day_gib" {
  description = "Project-wide BigQuery query bytes per day, in GiB (S-07)."
  type        = number
  default     = 50

  validation {
    condition     = var.query_usage_per_day_gib > 0
    error_message = "query_usage_per_day_gib debe ser mayor que 0."
  }
}

variable "query_usage_per_user_per_day_gib" {
  description = "BigQuery query bytes per user (service accounts included) per day, in GiB (S-07)."
  type        = number
  default     = 20

  validation {
    condition     = var.query_usage_per_user_per_day_gib > 0
    error_message = "query_usage_per_user_per_day_gib debe ser mayor que 0."
  }
}
