# Billing kill switch (finops/killswitch, DEC-003): a Cloud Run function triggered by the budget topic. Its only
# billing role is killswitch_billing_role (DEC-009); the CI account gets none.
data "archive_file" "killswitch" {
  type        = "zip"
  output_path = "${path.module}/.terraform/killswitch.zip"

  source {
    content  = file("${path.module}/../../finops/killswitch/main.py")
    filename = "main.py"
  }
  source {
    content  = file("${path.module}/../../finops/killswitch/requirements.txt")
    filename = "requirements.txt"
  }
}

resource "google_storage_bucket" "functions_source" {
  project                     = local.project_id
  name                        = "${local.project_id}-functions-src"
  location                    = upper(local.region)
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true

  depends_on = [google_project_service.this]
}

# The md5 in the name makes a code change redeploy the function.
resource "google_storage_bucket_object" "killswitch" {
  bucket = google_storage_bucket.functions_source.name
  name   = "killswitch-${data.archive_file.killswitch.output_md5}.zip"
  source = data.archive_file.killswitch.output_path
}

resource "google_service_account" "killswitch" {
  project      = local.project_id
  account_id   = "compras-killswitch"
  display_name = "Billing kill switch"

  depends_on = [google_project_service.this]
}

resource "google_service_account" "killswitch_trigger" {
  project      = local.project_id
  account_id   = "compras-killswitch-trg"
  display_name = "Billing kill switch trigger"

  depends_on = [google_project_service.this]
}

resource "google_service_account" "killswitch_build" {
  project      = local.project_id
  account_id   = "compras-killswitch-bld"
  display_name = "Billing kill switch build"

  depends_on = [google_project_service.this]
}

resource "google_project_iam_member" "killswitch_build" {
  project = local.project_id
  role    = "roles/cloudbuild.builds.builder"
  member  = "serviceAccount:${google_service_account.killswitch_build.email}"
}

resource "google_project_iam_member" "killswitch_billing" {
  count = var.killswitch_billing_role == "roles/billing.projectManager" ? 1 : 0

  project = local.project_id
  role    = "roles/billing.projectManager"
  member  = "serviceAccount:${google_service_account.killswitch.email}"
}

resource "google_billing_account_iam_member" "killswitch_billing" {
  count = var.killswitch_billing_role == "roles/billing.projectManager" ? 0 : 1

  billing_account_id = local.billing_account
  role               = "roles/billing.admin"
  member             = "serviceAccount:${google_service_account.killswitch.email}"
}

resource "google_cloudfunctions2_function" "killswitch" {
  project  = local.project_id
  name     = "billing-killswitch"
  location = local.region

  build_config {
    runtime         = "python312"
    entry_point     = "stop_billing"
    service_account = google_service_account.killswitch_build.id
    source {
      storage_source {
        bucket = google_storage_bucket.functions_source.name
        object = google_storage_bucket_object.killswitch.name
      }
    }
  }

  service_config {
    max_instance_count    = 1
    available_memory      = "256M"
    timeout_seconds       = 60
    ingress_settings      = "ALLOW_INTERNAL_ONLY"
    service_account_email = google_service_account.killswitch.email
    environment_variables = {
      KILLSWITCH_PROJECT_ID = local.project_id
    }
  }

  event_trigger {
    trigger_region        = local.region
    event_type            = "google.cloud.pubsub.topic.v1.messagePublished"
    pubsub_topic          = google_pubsub_topic.budget.id
    retry_policy          = "RETRY_POLICY_RETRY"
    service_account_email = google_service_account.killswitch_trigger.email
  }

  depends_on = [google_project_iam_member.killswitch_build]
}

resource "google_cloud_run_service_iam_member" "killswitch_invoker" {
  project  = local.project_id
  location = local.region
  service  = google_cloudfunctions2_function.killswitch.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.killswitch_trigger.email}"
}
