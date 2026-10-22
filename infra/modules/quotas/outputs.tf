output "bq_quotas" {
  description = "BigQuery quota preferences by quota id."
  value = {
    for q in [google_cloud_quotas_quota_preference.bq_query_per_day, google_cloud_quotas_quota_preference.bq_query_per_user_per_day] :
    q.quota_id => {
      service         = q.service
      preferred_value = q.quota_config[0].preferred_value
      parent          = q.parent
    }
  }
}

output "quota_unit" {
  description = "Unit of preferred_value."
  value       = local.quota_unit
}
