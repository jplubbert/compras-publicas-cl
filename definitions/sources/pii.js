// Salt of proveedor_key (REQ-014, DEC-008). Terraform creates pii.sal empty and generar_sal fills it once; the schema
// suffix does not apply to declarations, so the CI run reads the same table.
// Checked here so that the compilation fails naming policy_tag_rut even before a model reads it (REQ-014 E5).
gobierno.policyTagRut(dataform.projectConfig.vars);

declare({
  schema: "pii",
  name: "sal",
  description: "Sal de proveedor_key (DEC-008), creada por Terraform y llenada una vez por generar_sal.",
});
