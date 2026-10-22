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

output "raw_tables" {
  description = "Raw tables: dataset.table => {partition_field, expiration_ms, deletion_protection, labels, schema}."
  value = {
    for k, t in google_bigquery_table.raw : k => {
      partition_field     = t.time_partitioning[0].field
      partition_type      = t.time_partitioning[0].type
      expiration_ms       = t.time_partitioning[0].expiration_ms
      deletion_protection = t.deletion_protection
      labels              = t.labels
      description         = t.description
      schema              = jsondecode(t.schema)
    }
  }
}
