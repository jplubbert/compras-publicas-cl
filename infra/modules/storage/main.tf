# Bronze bucket (DEC-001): Nearline after 30 days, deleted after 365.
resource "google_storage_bucket" "bronze" {
  name                        = "${var.project_id}-bronze"
  project                     = var.project_id
  location                    = upper(var.region)
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  lifecycle_rule {
    condition {
      age = 30
    }
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }
  }

  lifecycle_rule {
    condition {
      age = 365
    }
    action {
      type = "Delete"
    }
  }
}

# Authoritative policy: drops the default projectViewer/projectEditor bindings so only the pipeline reads bronze.
# Built with jsonencode (not data.google_iam_policy) so offline tests can read it back.
resource "google_storage_bucket_iam_policy" "bronze" {
  bucket = google_storage_bucket.bronze.name
  policy_data = jsonencode({
    bindings = concat(
      [{ role = "roles/storage.legacyBucketOwner", members = ["projectOwner:${var.project_id}"] }],
      [for role, members in var.bucket_bindings : { role = role, members = members }],
    )
  })
}
