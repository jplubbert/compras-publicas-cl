# Workload Identity Federation for GitHub Actions, restricted to one repository (DEC-004; T-02 §(f)).
resource "google_iam_workload_identity_pool" "github" {
  project                   = local.project_id
  workload_identity_pool_id = "github"

  depends_on = [google_project_service.this]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = local.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_condition                = "attribute.repository == \"${local.github_repository}\""
  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.repository"       = "assertion.repository"
    "attribute.repository_owner" = "assertion.repository_owner"
  }
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  depends_on = [google_project_service.this]
}
