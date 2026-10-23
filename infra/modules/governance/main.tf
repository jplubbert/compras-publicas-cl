# Column-level security of the natural-person RUT (REQ-014, DEC-008): taxonomy compras_publicas with the tag
# dato_personal.rut, its fine-grained readers and the empty salt table of proveedor_key (Dataform fills it once, so the
# value never reaches Terraform or git, DEC-004).
resource "google_data_catalog_taxonomy" "compras" {
  project                = var.project_id
  region                 = var.region
  display_name           = "compras_publicas"
  description            = "Datos personales de Compras Públicas: el RUT de personas naturales (DEC-008)."
  activated_policy_types = ["FINE_GRAINED_ACCESS_CONTROL"]
}

resource "google_data_catalog_policy_tag" "dato_personal" {
  taxonomy     = google_data_catalog_taxonomy.compras.id
  display_name = "dato_personal"
  description  = "Datos personales protegidos por control de acceso fino."
}

resource "google_data_catalog_policy_tag" "rut" {
  taxonomy          = google_data_catalog_taxonomy.compras.id
  display_name      = "rut"
  description       = "RUT de persona natural (DEC-008)."
  parent_policy_tag = google_data_catalog_policy_tag.dato_personal.name
}

locals {
  # Static keys: the members of the pipeline accounts are only known after apply.
  lectores = merge(
    { for m in var.pii_readers : "pii:${m}" => m },
    { dataform = var.dataform_member, ci = var.ci_member },
  )
}

# Only on the child tag rut: no grant on the parent tag or the taxonomy.
resource "google_data_catalog_policy_tag_iam_member" "lectores" {
  for_each = local.lectores

  policy_tag = google_data_catalog_policy_tag.rut.name
  role       = "roles/datacatalog.categoryFineGrainedReader"
  member     = each.value
}

# No rows: generar_sal (Dataform) inserts the only one.
resource "google_bigquery_table" "sal" {
  project             = var.project_id
  dataset_id          = var.pii_dataset_id
  table_id            = "sal"
  description         = "Sal de proveedor_key (DEC-008): una fila, la genera Dataform una sola vez."
  labels              = { layer = "pii" }
  deletion_protection = true
  schema = jsonencode([{
    name        = "sal"
    type        = "STRING"
    mode        = "REQUIRED"
    description = "Sal secreta de 64 caracteres hexadecimales que se concatena con el RUT antes del SHA-256 de proveedor_key"
  }])
}
