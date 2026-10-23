output "policy_tag_rut" {
  description = "Full name of the dato_personal.rut policy tag (Dataform compilation variable policy_tag_rut)."
  value       = google_data_catalog_policy_tag.rut.name
}

output "taxonomy" {
  description = "Taxonomy summary."
  value = {
    display_name           = google_data_catalog_taxonomy.compras.display_name
    activated_policy_types = google_data_catalog_taxonomy.compras.activated_policy_types
    region                 = google_data_catalog_taxonomy.compras.region
  }
}

output "policy_tags" {
  description = "Policy tags: name => {display_name, parent_policy_tag}."
  value = {
    for t in [google_data_catalog_policy_tag.dato_personal, google_data_catalog_policy_tag.rut] : t.display_name => {
      name              = t.name
      parent_policy_tag = t.parent_policy_tag
    }
  }
}

output "policy_tag_bindings" {
  description = "Grants on the policy tags."
  value = [for b in google_data_catalog_policy_tag_iam_member.lectores : {
    policy_tag = b.policy_tag
    role       = b.role
    member     = b.member
  }]
}

output "sal_table" {
  description = "Salt table of proveedor_key (schema only, never its value)."
  value = {
    dataset_id          = google_bigquery_table.sal.dataset_id
    table_id            = google_bigquery_table.sal.table_id
    deletion_protection = google_bigquery_table.sal.deletion_protection
    columns             = [for c in jsondecode(google_bigquery_table.sal.schema) : c.name]
  }
}

output "sal_table_ci" {
  description = "Salt table of the CI run (REQ-014 E8; schema only, never its value)."
  value = {
    dataset_id          = google_bigquery_table.sal_ci.dataset_id
    table_id            = google_bigquery_table.sal_ci.table_id
    deletion_protection = google_bigquery_table.sal_ci.deletion_protection
    columns             = [for c in jsondecode(google_bigquery_table.sal_ci.schema) : c.name]
  }
}
