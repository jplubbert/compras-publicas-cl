output "bronze_bucket" {
  description = "Bronze bucket summary."
  value = {
    name                 = google_storage_bucket.bronze.name
    location             = google_storage_bucket.bronze.location
    storage_class        = google_storage_bucket.bronze.storage_class
    lifecycle_rule_count = length(google_storage_bucket.bronze.lifecycle_rule)
    lifecycle_actions    = [for r in google_storage_bucket.bronze.lifecycle_rule : one(r.action).type]
  }
}

output "bronze_bindings" {
  description = "Bindings of the bronze bucket policy."
  value       = jsondecode(google_storage_bucket_iam_policy.bronze.policy_data).bindings
}
