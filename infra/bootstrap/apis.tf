# APIs the bootstrap resources need.
resource "google_project_service" "this" {
  for_each = toset([
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "serviceusage.googleapis.com",
    "storage.googleapis.com",
  ])

  project            = local.project_id
  service            = each.key
  disable_on_destroy = false
}
