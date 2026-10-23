variable "project_id" {
  description = "GCP project id."
  type        = string
}

variable "lector_impersonators" {
  description = "Members that may mint tokens of compras-lector (REQ-014 E4)."
  type        = list(string)
  default     = []
}
