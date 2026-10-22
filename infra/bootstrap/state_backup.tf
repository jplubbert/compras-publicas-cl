# Terraform state backup (REQ-016). Removing billing can delete resources of the project, the state bucket included
# (DEC-003, DEC-009), so the backup lives in a separate project the budget and the kill switch do not watch.
resource "google_storage_bucket" "state_backup" {
  provider = google.backup

  name                        = "${local.backup_project_id}-tfstate-backup"
  project                     = local.backup_project_id
  location                    = upper(local.region)
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  # ANY: deletes both the live and the archived versions older than 365 days.
  lifecycle_rule {
    condition {
      age        = 365
      with_state = "ANY"
    }
    action {
      type = "Delete"
    }
  }
}

# CI can only create objects in the backup bucket: no read, no delete, no billing role (DEC-003, DEC-004).
resource "google_storage_bucket_iam_member" "ci_state_backup" {
  provider = google.backup

  bucket = google_storage_bucket.state_backup.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.ci.email}"
}
