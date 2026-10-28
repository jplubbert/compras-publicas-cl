# Offline tests of the bootstrap root (REQ-001, DEC-004, DEC-005).
mock_provider "google" {
  # The provider validates service_account_id, so the mocked name must look real (emails stay random).
  mock_resource "google_service_account" {
    defaults = {
      name = "projects/demo-proj/serviceAccounts/compras-mock@demo-proj.iam.gserviceaccount.com"
    }
  }
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
    }
  }
}
mock_provider "google" {
  alias = "backup"
}
mock_provider "google-beta" {}

variables {
  project_id        = "demo-proj"
  backup_project_id = "demo-backup"
  region            = "us-central1"
  github_repository = "demo-owner/compras-publicas-cl"
  billing_account   = "000000-000000-000000"
  alert_email       = "alertas@example.com"
}

run "state_bucket_and_wif" {
  command = plan

  assert {
    condition     = google_storage_bucket.state.versioning[0].enabled == true
    error_message = "the state bucket must be versioned"
  }
  assert {
    condition     = google_storage_bucket.state.location == "US-CENTRAL1"
    error_message = "the state bucket must live in var.region"
  }
  assert {
    condition     = google_iam_workload_identity_pool_provider.github.attribute_condition == "attribute.repository == \"demo-owner/compras-publicas-cl\" && (attribute.ref == \"refs/heads/main\" || attribute.event_name == \"pull_request\")"
    error_message = "the WIF provider must be restricted to the repository, and to main or a pull request"
  }
  assert {
    condition     = google_iam_workload_identity_pool_provider.github.attribute_mapping["attribute.ref"] == "assertion.ref" && google_iam_workload_identity_pool_provider.github.attribute_mapping["attribute.event_name"] == "assertion.event_name"
    error_message = "the WIF provider must map the ref and the event name, which the condition reads"
  }
  assert {
    condition     = google_iam_workload_identity_pool.github.workload_identity_pool_id == "github"
    error_message = "the pool id must be github"
  }
  assert {
    condition     = google_iam_workload_identity_pool_provider.github.workload_identity_pool_provider_id == "github"
    error_message = "the provider id must be github"
  }
}

run "ci_account_without_billing" {
  command = apply

  assert {
    condition     = endswith(google_service_account_iam_member.ci_wif.member, "/attribute.repository/demo-owner/compras-publicas-cl")
    error_message = "only the repository may impersonate the CI account"
  }
  assert {
    condition     = alltrue([for r in output.ci_project_roles : !startswith(r, "roles/billing") && !startswith(r, "roles/pubsub") && !contains(["roles/owner", "roles/editor"], r)])
    error_message = "the CI account must not hold billing, Pub/Sub, owner or editor roles"
  }
  assert {
    condition = alltrue([for m in concat(google_project_iam_member.killswitch_billing, google_billing_account_iam_member.killswitch_billing) :
    m.member != "serviceAccount:${output.ci_service_account}"])
    error_message = "the kill switch billing grant must not go to the CI account"
  }
  assert {
    condition     = strcontains(output.ci_iam_admin_condition, "hasOnly") && !strcontains(output.ci_iam_admin_condition, "billing")
    error_message = "the CI IAM admin role must be limited to the pipeline roles"
  }
  assert {
    condition     = strcontains(output.ci_iam_admin_condition, "'roles/logging.logWriter'")
    error_message = "the CI account must be allowed to grant logging.logWriter to compras-workflow (DEC-012, sys.log of the PARCIAL day)"
  }
}

# REQ-006: CI creates the ingest Cloud Run Jobs and the image repository in infra/main.
run "t08_ci_run_y_artifact_registry" {
  command = plan

  assert {
    condition     = contains(output.ci_project_roles, "roles/run.admin") && contains(output.ci_project_roles, "roles/artifactregistry.admin")
    error_message = "the CI account needs run.admin and artifactregistry.admin"
  }
  assert {
    condition = alltrue([for r in ["roles/workflows.admin", "roles/cloudscheduler.admin", "roles/dataform.admin", "roles/monitoring.editor", "roles/logging.configWriter"] :
    contains(output.ci_project_roles, r)])
    error_message = "the CI account needs the T-11 roles for Workflows, Scheduler, Dataform and the alert policy"
  }
}

# REQ-014: CI creates the taxonomy and its grants, and may give compras-dataform datacatalog.viewer.
run "t14_ci_policy_tags" {
  command = plan

  assert {
    condition     = contains(output.ci_project_roles, "roles/datacatalog.categoryAdmin")
    error_message = "the CI account needs datacatalog.categoryAdmin to create the taxonomy and its policy tags"
  }
  assert {
    condition     = strcontains(output.ci_iam_admin_condition, "'roles/datacatalog.viewer'")
    error_message = "the CI account must be allowed to grant datacatalog.viewer to compras-dataform"
  }
}

run "e2_without_project_id" {
  command = plan
  variables {
    project_id = null
  }
  expect_failures = [var.project_id]
}

run "e2_without_region" {
  command = plan
  variables {
    region = null
  }
  expect_failures = [var.region]
}

run "e2_without_github_repository" {
  command = plan
  variables {
    github_repository = null
  }
  expect_failures = [var.github_repository]
}

run "e3_region_outside_us" {
  command = plan
  variables {
    region = "southamerica-west1"
  }
  expect_failures = [var.region]
}

# REQ-003 E5: budget on actual spend, topic wired to the kill switch, billing role only on the kill switch account.
run "e5_presupuesto_y_desvinculadora" {
  command = apply

  assert {
    condition     = [for r in google_billing_budget.cap.threshold_rules : r.threshold_percent] == [0.5, 0.9, 1.0]
    error_message = "the budget thresholds must be 0.5, 0.9 and 1.0"
  }
  assert {
    condition     = alltrue([for r in google_billing_budget.cap.threshold_rules : r.spend_basis == "CURRENT_SPEND"])
    error_message = "every threshold must use actual spend"
  }
  assert {
    condition     = google_billing_budget.cap.all_updates_rule[0].pubsub_topic == google_pubsub_topic.budget.id
    error_message = "the budget must publish to the kill switch topic"
  }
  assert {
    condition     = google_cloudfunctions2_function.killswitch.event_trigger[0].pubsub_topic == google_pubsub_topic.budget.id
    error_message = "the kill switch must be triggered by the budget topic"
  }
  assert {
    condition     = google_monitoring_notification_channel.budget_email.labels["email_address"] == "alertas@example.com"
    error_message = "the alerts must go to alert_email"
  }
  assert {
    condition     = google_billing_budget.cap.amount[0].specified_amount[0].units == "10" && google_billing_budget.cap.amount[0].specified_amount[0].currency_code == "USD"
    error_message = "the default budget must be USD 10"
  }
  assert {
    condition     = google_billing_budget.cap.budget_filter[0].projects == toset(["projects/123456789012"])
    error_message = "the budget must watch this project only"
  }
  assert {
    condition = length(google_project_iam_member.killswitch_billing) == 1 && google_project_iam_member.killswitch_billing[0].role == "roles/billing.projectManager" && (
    google_project_iam_member.killswitch_billing[0].member == "serviceAccount:${output.killswitch_service_account}")
    error_message = "the kill switch account must hold billing.projectManager on the project by default"
  }
  assert {
    condition     = length(google_billing_account_iam_member.killswitch_billing) == 0
    error_message = "no billing account grant by default"
  }
}

run "rol_billing_admin" {
  command = apply
  variables {
    killswitch_billing_role = "roles/billing.admin"
  }

  assert {
    condition = length(google_billing_account_iam_member.killswitch_billing) == 1 && google_billing_account_iam_member.killswitch_billing[0].role == "roles/billing.admin" && (
    google_billing_account_iam_member.killswitch_billing[0].billing_account_id == "000000-000000-000000")
    error_message = "with billing.admin the grant must be on the billing account"
  }
  assert {
    condition     = length(google_project_iam_member.killswitch_billing) == 0
    error_message = "with billing.admin there must be no project grant"
  }
  assert {
    condition     = output.killswitch_billing_grant.scope == "billing_account"
    error_message = "the grant output must report the billing account scope"
  }
}

run "presupuesto_de_simulacro" {
  command = plan
  variables {
    budget_usd = 0.01
  }

  assert {
    condition     = google_billing_budget.cap.amount[0].specified_amount[0].units == "0" && google_billing_budget.cap.amount[0].specified_amount[0].nanos == 10000000
    error_message = "USD 0.01 must be 0 units and 10000000 nanos"
  }
}

run "presupuesto_en_moneda_de_la_cuenta" {
  command = plan
  variables {
    budget_currency = "CLP"
    budget_usd      = 9500
  }

  assert {
    condition     = google_billing_budget.cap.amount[0].specified_amount[0].currency_code == "CLP" && google_billing_budget.cap.amount[0].specified_amount[0].units == "9500"
    error_message = "budget_currency must reach the budget: CLP 9500"
  }
}

run "moneda_invalida" {
  command = plan
  variables {
    budget_currency = "usd"
  }
  expect_failures = [var.budget_currency]
}

run "sin_billing_account" {
  command = plan
  variables {
    billing_account = null
  }
  expect_failures = [var.billing_account]
}

run "billing_account_mal_formado" {
  command = plan
  variables {
    billing_account = "billing-123"
  }
  expect_failures = [var.billing_account]
}

run "sin_alert_email" {
  command = plan
  variables {
    alert_email = null
  }
  expect_failures = [var.alert_email]
}

run "presupuesto_cero" {
  command = plan
  variables {
    budget_usd = 0
  }
  expect_failures = [var.budget_usd]
}

run "rol_billing_no_permitido" {
  command = plan
  variables {
    killswitch_billing_role = "roles/owner"
  }
  expect_failures = [var.killswitch_billing_role]
}

# REQ-016 E1: versioned backup bucket in the separate project, in var.region, with a single 365-day lifecycle rule.
run "e1_bucket_de_respaldo" {
  command = plan

  assert {
    condition     = google_storage_bucket.state_backup.project == "demo-backup"
    error_message = "the backup bucket must live in backup_project_id"
  }
  assert {
    condition     = google_storage_bucket.state_backup.location == "US-CENTRAL1"
    error_message = "the backup bucket must live in var.region"
  }
  assert {
    condition     = google_storage_bucket.state_backup.versioning[0].enabled == true
    error_message = "the backup bucket must be versioned"
  }
  assert {
    condition     = length(google_storage_bucket.state_backup.lifecycle_rule) == 1
    error_message = "the backup bucket must have a single lifecycle rule"
  }
  assert {
    condition     = one(google_storage_bucket.state_backup.lifecycle_rule[0].condition).age == 365
    error_message = "the lifecycle rule must match objects older than 365 days"
  }
  assert {
    condition     = one(google_storage_bucket.state_backup.lifecycle_rule[0].action).type == "Delete"
    error_message = "the lifecycle rule must delete"
  }
}

# REQ-016 E2: CI can only create objects in the backup bucket and holds nothing on the backup project.
run "e2_ci_solo_crea_objetos" {
  command = apply

  assert {
    condition     = google_storage_bucket_iam_member.ci_state_backup.role == "roles/storage.objectCreator"
    error_message = "the CI role on the backup bucket must be storage.objectCreator"
  }
  assert {
    condition     = google_storage_bucket_iam_member.ci_state_backup.member == "serviceAccount:${output.ci_service_account}"
    error_message = "the backup bucket grant must go to the CI account"
  }
  assert {
    condition     = google_storage_bucket_iam_member.ci_state_backup.bucket == google_storage_bucket.state_backup.name
    error_message = "the grant must be on the backup bucket"
  }
  assert {
    condition     = alltrue([for w in ["admin", "viewer", "objectUser", "legacy", "objectViewer"] : !strcontains(output.ci_state_backup_role, w)])
    error_message = "the CI account must not read or delete in the backup bucket"
  }
  assert {
    condition     = alltrue([for m in values(google_project_iam_member.ci) : m.project == "demo-proj"])
    error_message = "the CI account must hold no role on the backup project"
  }
}

run "sin_backup_project_id" {
  command = plan
  variables {
    backup_project_id = null
  }
  expect_failures = [var.backup_project_id]
}

run "backup_igual_al_proyecto" {
  command = plan
  variables {
    backup_project_id = "demo-proj"
  }
  expect_failures = [var.backup_project_id]
}
