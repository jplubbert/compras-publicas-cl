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

  # Raw tables in raw and raw_ci, with the same schema file the load job uses (REQ-006).
  raw_tables = {
    for pair in setproduct(["raw", "raw_ci"], var.raw_tables) : "${pair[0]}.${pair[1]}" => {
      dataset = pair[0]
      table   = pair[1]
    }
  }
  # Raw partitions expire after 400 days (DEC-006).
  raw_partition_expiration_ms = 34560000000
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

resource "google_bigquery_table" "raw" {
  for_each = local.raw_tables

  project             = var.project_id
  dataset_id          = google_bigquery_dataset.this[each.value.dataset].dataset_id
  table_id            = each.value.table
  description         = "Tabla raw ${each.value.table}: líneas de bronze cargadas sin transformar, con su run_id."
  labels              = { layer = "raw" }
  schema              = file("${path.module}/../../../ingest/schemas/${each.value.table}.json")
  deletion_protection = each.value.dataset == "raw"

  time_partitioning {
    type          = "DAY"
    field         = "_ingest_date"
    expiration_ms = local.raw_partition_expiration_ms
  }
}
