variable "project_id" {
  description = "GCP project id."
  type        = string
}

variable "bronze_readers" {
  description = "Members outside the pipeline that may read bronze objects (the operator running scripts/it/run-jobs.sh)."
  type        = list(string)
  default     = []
}

variable "lector_impersonators" {
  description = "Members that may mint tokens of compras-lector (REQ-014 E4)."
  type        = list(string)
  default     = []
}
