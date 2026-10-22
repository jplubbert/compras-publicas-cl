terraform {
  required_version = "~> 1.16"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "= 8.8.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "= 8.8.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "= 2.8.1"
    }
    random = {
      source  = "hashicorp/random"
      version = "= 3.9.1"
    }
  }
}
