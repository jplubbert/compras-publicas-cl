# Empty secrets (DEC-004, DEC-009): the user loads their versions by hand; Terraform never holds a value.
locals {
  secrets = {
    "mercadopublico-ticket" = "ingest"
    "bcentral-token"        = "ingest"
    "dataform-github-token" = "dataform"
  }
  accessors = merge([
    for secret, members in var.secret_accessors : {
      for component, member in members : "${secret}/${component}" => { secret = secret, member = member }
    }
  ]...)
}

resource "google_secret_manager_secret" "this" {
  for_each = local.secrets

  project   = var.project_id
  secret_id = each.key
  labels    = { component = each.value }

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
}

resource "google_secret_manager_secret_iam_member" "this" {
  for_each = local.accessors

  project   = var.project_id
  secret_id = google_secret_manager_secret.this[each.value.secret].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value.member
}
