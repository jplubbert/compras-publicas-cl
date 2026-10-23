variable "project_id" {
  description = "GCP project id."
  type        = string
}

variable "region" {
  description = "Location of the taxonomy; it must match the datasets whose columns carry its tags."
  type        = string
}

variable "pii_dataset_id" {
  description = "Dataset that holds the salt table (pii)."
  type        = string
}

variable "pii_ci_dataset_id" {
  description = "Dataset that holds the salt table of the CI run (pii_ci)."
  type        = string
}

variable "pii_readers" {
  description = "Members (user:, group:, serviceAccount:, domain:) that may read the columns tagged dato_personal.rut (REQ-014)."
  type        = list(string)
  default     = []
}

variable "dataform_member" {
  description = "IAM member of the Dataform account (serviceAccount:…), which reads the tagged columns when it materializes them."
  type        = string
}

variable "ci_member" {
  description = "IAM member of the CI account (serviceAccount:…), which runs Dataform in the isolated CI run."
  type        = string
}
