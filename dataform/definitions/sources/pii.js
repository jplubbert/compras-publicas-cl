// Salt of proveedor_key (REQ-014, DEC-008) in <sal_dataset>.sal: pii by default, the CI run passes pii_ci (REQ-014
// E8). Terraform creates the table empty and generar_sal fills it once; the schema suffix does not apply to
// declarations, so the dataset comes from the sal_dataset variable.
// Checked here so that the compilation fails naming policy_tag_rut even before a model reads it (REQ-014 E5).
gobierno.policyTagRut(dataform.projectConfig.vars);

const salDataset = dataform.projectConfig.vars.sal_dataset;
if (!salDataset) {
  throw new Error("falta la variable de compilación sal_dataset");
}

declare({
  schema: salDataset,
  name: "sal",
  description: "Sal de proveedor_key (DEC-008) en el dataset sal_dataset, creada vacía por Terraform y llenada una vez por generar_sal.",
});
