# Offline tests of the bootstrap root (REQ-001, DEC-004, DEC-005).
mock_provider "google" {
  # The provider validates service_account_id, so the mocked name must look real (emails stay random).
  mock_resource "google_service_account" {
    defaults = {
      name = "projects/demo-proj/serviceAccounts/compras-mock@demo-proj.iam.gserviceaccount.com"
    }
  }
}
mock_provider "google-beta" {}

variables {
  project_id        = "demo-proj"
  region            = "us-central1"
  github_repository = "demo-owner/compras-publicas-cl"
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
    condition     = google_iam_workload_identity_pool_provider.github.attribute_condition == "attribute.repository == \"demo-owner/compras-publicas-cl\""
    error_message = "the WIF provider must be restricted to the repository"
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
    condition     = alltrue([for r in output.ci_project_roles : !startswith(r, "roles/billing") && !contains(["roles/owner", "roles/editor"], r)])
    error_message = "the CI account must not hold billing, owner or editor roles"
  }
  assert {
    condition     = strcontains(output.ci_iam_admin_condition, "hasOnly") && !strcontains(output.ci_iam_admin_condition, "billing")
    error_message = "the CI IAM admin role must be limited to the pipeline roles"
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
