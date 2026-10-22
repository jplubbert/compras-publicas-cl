variable "project_id" {
  description = "GCP project id."
  type        = string
}

variable "region" {
  description = "Bucket region."
  type        = string
}

variable "bucket_bindings" {
  description = "Bronze bucket bindings: role => members. The policy is authoritative."
  type        = map(list(string))
}
