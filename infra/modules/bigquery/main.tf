# Medallion datasets and their CI twins (DEC-001). Access is authoritative: restricted layers keep no project readers.
locals {
  datasets = {
    raw           = { layer = "raw", ci = false, description = "Capa raw: datos de las fuentes cargados desde bronze sin transformar." }
    silver        = { layer = "silver", ci = false, description = "Capa silver: datos limpios, tipados y deduplicados." }
    gold          = { layer = "gold", ci = false, description = "Capa gold: modelos de negocio listos para consumo." }
    quarantine    = { layer = "quarantine", ci = false, description = "Cuarentena: filas que no pasan las reglas de calidad." }
    pii           = { layer = "pii", ci = false, description = "Datos personales separados del resto de las capas." }
    bench         = { layer = "bench", ci = false, description = "Tablas temporales del benchmark (expiran a los 30 días)." }
    raw_ci        = { layer = "raw", ci = true, description = "Gemelo de CI de la capa raw." }
    silver_ci     = { layer = "silver", ci = true, description = "Gemelo de CI de la capa silver." }
    gold_ci       = { layer = "gold", ci = true, description = "Gemelo de CI de la capa gold." }
    quarantine_ci = { layer = "quarantine", ci = true, description = "Gemelo de CI de la cuarentena." }
  }
  # Datasets that keep the default project writer and reader access.
  open_datasets = ["silver", "gold", "silver_ci", "gold_ci", "bench"]

  # BigQuery stores predefined dataset roles as their basic equivalents; using these avoids a perpetual diff.
  basic_role = {
    "roles/bigquery.dataOwner"  = "OWNER"
    "roles/bigquery.dataEditor" = "WRITER"
    "roles/bigquery.dataViewer" = "READER"
  }
}

resource "google_bigquery_dataset" "this" {
  for_each = local.datasets

  project                     = var.project_id
  dataset_id                  = each.key
  location                    = var.region
  description                 = each.value.description
  labels                      = merge({ layer = each.value.layer }, each.value.ci ? { env = "ci" } : {})
  delete_contents_on_destroy  = false
  default_table_expiration_ms = each.key == "bench" ? 2592000000 : null

  access {
    role          = "OWNER"
    special_group = "projectOwners"
  }

  dynamic "access" {
    for_each = contains(local.open_datasets, each.key) ? [{ role = "WRITER", group = "projectWriters" }, { role = "READER", group = "projectReaders" }] : []
    content {
      role          = access.value.role
      special_group = access.value.group
    }
  }

  dynamic "access" {
    for_each = lookup(var.dataset_access, each.key, [])
    content {
      role          = local.basic_role[access.value.role]
      user_by_email = trimprefix(access.value.member, "serviceAccount:")
    }
  }
}
