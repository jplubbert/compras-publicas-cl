# Versioned bucket for the infra/main remote state.
resource "google_storage_bucket" "state" {
  name                        = "${local.project_id}-tfstate"
  project                     = local.project_id
  location                    = upper(local.region)
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      num_newer_versions = 10
      with_state         = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.this]
}
