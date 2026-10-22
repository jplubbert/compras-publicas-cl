output "repository" {
  description = "Docker repository of the ingest image."
  value = {
    location      = google_artifact_registry_repository.ingest.location
    format        = google_artifact_registry_repository.ingest.format
    repository_id = google_artifact_registry_repository.ingest.repository_id
    image         = "${var.region}-docker.pkg.dev/${var.project_id}/compras/ingest"
  }
}

output "ingest_jobs" {
  description = "Ingest jobs: key => {name, location, timeout, max_retries, service_account, args, env_names, secret_env, invokers}."
  value = {
    for k, j in google_cloud_run_v2_job.this : k => {
      name            = j.name
      location        = j.location
      timeout         = j.template[0].template[0].timeout
      max_retries     = j.template[0].template[0].max_retries
      service_account = j.template[0].template[0].service_account
      args            = j.template[0].template[0].containers[0].args
      env_names       = [for e in j.template[0].template[0].containers[0].env : e.name]
      secret_env      = [for e in j.template[0].template[0].containers[0].env : e.name if try(length(e.value_source), 0) > 0]
      invokers        = [for ik, b in google_cloud_run_v2_job_iam_member.invoker : b.member if split("/", ik)[0] == k]
    }
  }
}
