output "datasets" {
  description = "Dataset summary: id => {location, description, labels, default_table_expiration_ms, access}."
  value = {
    for k, d in google_bigquery_dataset.this : k => {
      location                    = d.location
      description                 = d.description
      labels                      = d.labels
      default_table_expiration_ms = d.default_table_expiration_ms
      access = [for a in d.access : {
        role          = a.role
        user_by_email = a.user_by_email
        special_group = a.special_group
      }]
    }
  }
}
