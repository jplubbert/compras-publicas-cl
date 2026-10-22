# Monthly budget on actual spend (REQ-003, DEC-003): e-mail alerts at 50 and 90 %, and every update goes to the Pub/Sub
# topic that triggers the kill switch, which unlinks billing at 100 %.
locals {
  budget_thresholds = [0.5, 0.9, 1.0]
}

data "google_project" "this" {
  project_id = local.project_id
}

resource "google_pubsub_topic" "budget" {
  project = local.project_id
  name    = "billing-budget-alerts"

  depends_on = [google_project_service.this]
}

resource "google_monitoring_notification_channel" "budget_email" {
  project      = local.project_id
  display_name = "Budget alerts"
  type         = "email"
  labels = {
    email_address = local.alert_email
  }

  depends_on = [google_project_service.this]
}

resource "google_billing_budget" "cap" {
  billing_account = local.billing_account
  display_name    = "${local.project_id} cap"

  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(floor(var.budget_usd))
      nanos         = floor((var.budget_usd - floor(var.budget_usd)) * 1000000000 + 0.5)
    }
  }

  dynamic "threshold_rules" {
    for_each = local.budget_thresholds
    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "CURRENT_SPEND"
    }
  }

  all_updates_rule {
    pubsub_topic                     = google_pubsub_topic.budget.id
    schema_version                   = "1.0"
    monitoring_notification_channels = [google_monitoring_notification_channel.budget_email.id]
  }

  depends_on = [google_project_service.this]
}
