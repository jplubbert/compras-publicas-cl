variable "project_id" {
  description = "GCP project id."
  type        = string
}

variable "region" {
  description = "Dataset location."
  type        = string
}

variable "dataset_access" {
  description = "Extra dataset grants with predefined roles: dataset => [{role, member}]."
  type = map(list(object({
    role   = string
    member = string
  })))
}

variable "raw_tables" {
  description = "Raw tables created in raw and raw_ci; each one reads its schema from ingest/schemas/<table>.json."
  type        = list(string)
  default     = []
}
