variable "project_id" {
  description = "GCP project id."
  type        = string
}

variable "region" {
  description = "Replica location of every secret."
  type        = string
}

variable "secret_accessors" {
  description = "Secret accessors: secret => {component => member}."
  type        = map(map(string))
}
