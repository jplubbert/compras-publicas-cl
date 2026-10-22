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

variable "billing_account" {
  description = "Billing account the budget watches and the kill switch unlinks, as XXXXXX-XXXXXX-XXXXXX (DEC-003)."
  type        = string
  default     = null

  validation {
    condition     = can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", var.billing_account))
    error_message = "billing_account es obligatoria, con la forma XXXXXX-XXXXXX-XXXXXX (dígitos y mayúsculas)."
  }
}

variable "alert_email" {
  description = "Address that receives the budget alerts (Q-03)."
  type        = string
  default     = null

  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.alert_email))
    error_message = "alert_email es obligatoria (Q-03): el correo de los avisos del presupuesto; ponla en terraform.tfvars, fuera de git."
  }
}

variable "budget_usd" {
  description = "Monthly budget in USD; at 100 % the kill switch unlinks billing (REQ-003)."
  type        = number
  default     = 10

  validation {
    condition     = var.budget_usd > 0
    error_message = "budget_usd debe ser mayor que 0."
  }
}

variable "killswitch_billing_role" {
  description = "Role that lets the kill switch unlink billing: projectManager on the project or admin on the billing account (DEC-009)."
  type        = string
  default     = "roles/billing.projectManager"

  validation {
    condition     = contains(["roles/billing.projectManager", "roles/billing.admin"], var.killswitch_billing_role)
    error_message = "killswitch_billing_role debe ser roles/billing.projectManager o roles/billing.admin."
  }
}
