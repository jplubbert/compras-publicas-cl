# Daily BigQuery query quotas (REQ-003, S-07, DEC-009): the project cap and the per-user cap, which also binds the
# Dataform service account (Dataform has no maximumBytesBilled).
locals {
  # Unit of the quota value in the Cloud Quotas API; scripts/it/killswitch-drill.sh checks it against metricUnit.
  quota_unit  = "MiBy"
  mib_per_gib = 1024
}

resource "google_cloud_quotas_quota_preference" "bq_query_per_day" {
  parent   = "projects/${var.project_id}"
  name     = "bigquery-query-usage-per-day"
  service  = "bigquery.googleapis.com"
  quota_id = "QueryUsagePerDay"

  quota_config {
    preferred_value = tostring(var.query_usage_per_day_gib * local.mib_per_gib)
  }
  # The default is 200 TiB, so lowering it trips the decrease safety check.
  ignore_safety_checks = "QUOTA_DECREASE_PERCENTAGE_TOO_HIGH"
}

resource "google_cloud_quotas_quota_preference" "bq_query_per_user_per_day" {
  parent   = "projects/${var.project_id}"
  name     = "bigquery-query-usage-per-user-per-day"
  service  = "bigquery.googleapis.com"
  quota_id = "QueryUsagePerUserPerDay"

  quota_config {
    preferred_value = tostring(var.query_usage_per_user_per_day_gib * local.mib_per_gib)
  }
  ignore_safety_checks = "QUOTA_DECREASE_PERCENTAGE_TOO_HIGH"
}
