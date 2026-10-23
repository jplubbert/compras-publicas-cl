output "orchestration" {
  description = "Scheduler job, Workflow, Dataform repository and failure alert of the daily run."
  value = {
    scheduler = {
      schedule        = google_cloud_scheduler_job.daily.schedule
      time_zone       = google_cloud_scheduler_job.daily.time_zone
      region          = google_cloud_scheduler_job.daily.region
      uri             = google_cloud_scheduler_job.daily.http_target[0].uri
      service_account = google_cloud_scheduler_job.daily.http_target[0].oauth_token[0].service_account_email
      retry_count     = google_cloud_scheduler_job.daily.retry_config[0].retry_count
    }
    workflow = {
      name            = google_workflows_workflow.daily.name
      region          = google_workflows_workflow.daily.region
      service_account = google_workflows_workflow.daily.service_account
      source_contents = google_workflows_workflow.daily.source_contents
      env_names       = keys(google_workflows_workflow.daily.user_env_vars)
    }
    repository = {
      name                 = google_dataform_repository.this.name
      region               = google_dataform_repository.this.region
      url                  = google_dataform_repository.this.git_remote_settings[0].url
      default_branch       = google_dataform_repository.this.git_remote_settings[0].default_branch
      token_secret_version = google_dataform_repository.this.git_remote_settings[0].authentication_token_secret_version
      service_account      = google_dataform_repository.this.service_account
    }
    alert = {
      filter                = google_monitoring_alert_policy.workflow_failed.conditions[0].condition_threshold[0].filter
      notification_channels = google_monitoring_alert_policy.workflow_failed.notification_channels
    }
  }
}

output "release_config" {
  description = "Dataform release configuration of main."
  value = {
    git_commitish    = google_dataform_repository_release_config.main.git_commitish
    default_database = google_dataform_repository_release_config.main.code_compilation_config[0].default_database
    default_location = google_dataform_repository_release_config.main.code_compilation_config[0].default_location
    vars             = google_dataform_repository_release_config.main.code_compilation_config[0].vars
  }
}
