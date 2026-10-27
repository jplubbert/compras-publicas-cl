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
  # Only the repository, and within it only a push to main (deploy.yml) or a pull request (the plan of ci.yml, whose
  # ref is refs/pull/N/merge). A workflow on any other branch, or a manual dispatch, gets no token.
  attribute_condition = "attribute.repository == \"${local.github_repository}\" && (attribute.ref == \"refs/heads/main\" || attribute.event_name == \"pull_request\")"
  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.repository"       = "assertion.repository"
    "attribute.repository_owner" = "assertion.repository_owner"
    "attribute.ref"              = "assertion.ref"
    "attribute.event_name"       = "assertion.event_name"
  }
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  depends_on = [google_project_service.this]
}
