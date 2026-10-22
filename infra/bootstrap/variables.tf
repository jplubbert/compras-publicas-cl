# Required inputs (REQ-001): plan fails with a message naming the variable when one is missing or invalid.
variable "project_id" {
  description = "GCP project id."
  type        = string
  default     = null

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id es obligatoria: el ID del proyecto GCP (6 a 30 caracteres: minúsculas, dígitos y guiones)."
  }
}

variable "region" {
  description = "Region for every regional resource (GCS free tier regions only, DEC-001)."
  type        = string
  default     = null

  validation {
    condition     = contains(["us-central1", "us-east1", "us-west1"], var.region == null ? "" : var.region)
    error_message = "region es obligatoria y debe ser us-central1, us-east1 o us-west1 (free tier de GCS)."
  }
}

variable "github_repository" {
  description = "GitHub repository allowed to impersonate the CI service account, as owner/name (DEC-004)."
  type        = string
  default     = null

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "github_repository es obligatoria, con la forma owner/nombre."
  }
}
