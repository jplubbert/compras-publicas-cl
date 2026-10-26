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
  description = "GitHub repository that runs CI, as owner/name (DEC-004)."
  type        = string
  default     = null

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "github_repository es obligatoria, con la forma owner/nombre."
  }
}

variable "schedule" {
  description = "Cron schedule of the daily Workflow run (REQ-007, DEC-002)."
  type        = string
  default     = "30 23 * * *"
}

variable "time_zone" {
  description = "Time zone of the daily schedule."
  type        = string
  default     = "America/Santiago"
}

# REQ-014: members outside the pipeline that may read the natural-person RUT (deploy.yml: variable PII_READERS).
variable "pii_readers" {
  description = "Members that may read the columns tagged dato_personal.rut (user:, group:, serviceAccount: or domain:)."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for m in var.pii_readers : can(regex("^(user|group|serviceAccount|domain):.+", m))])
    error_message = "pii_readers: cada miembro debe empezar por user:, group:, serviceAccount: o domain:."
  }
}

# Members outside the pipeline that may read bronze objects: the operator who runs scripts/it/run-jobs.sh, which
# compares bronze lines with raw rows (deploy.yml: variable BRONZE_READERS). Project owners only list the bucket.
variable "bronze_readers" {
  description = "Members that may read the bronze bucket objects (user:, group:, serviceAccount: or domain:)."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for m in var.bronze_readers : can(regex("^(user|group|serviceAccount|domain):.+", m))])
    error_message = "bronze_readers: cada miembro debe empezar por user:, group:, serviceAccount: o domain:."
  }
}

# Members that may mint tokens of compras-lector to check REQ-014 E4 (deploy.yml: variable LECTOR_IMPERSONATORS).
variable "lector_impersonators" {
  description = "Members that may impersonate compras-lector (user:, group:, serviceAccount: or domain:)."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for m in var.lector_impersonators : can(regex("^(user|group|serviceAccount|domain):.+", m))])
    error_message = "lector_impersonators: cada miembro debe empezar por user:, group:, serviceAccount: o domain:."
  }
}
