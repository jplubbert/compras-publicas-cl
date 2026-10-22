// Raw tables loaded from bronze (REQ-006, S-21). The dataset comes from the raw_dataset variable so that the CI run
// reads raw_ci (--vars=raw_dataset=raw_ci); the schema suffix does not apply to declarations.
const rawDataset = dataform.projectConfig.vars.raw_dataset;
if (!rawDataset) {
  throw new Error("falta la variable de compilación raw_dataset");
}

const TABLES = {
  mercadopublico_licitaciones: "Respuestas de la API de licitaciones de Mercado Público cargadas desde bronze, sin transformar (DEC-006).",
  mercadopublico_ordenes_compra: "Respuestas de la API de órdenes de compra de Mercado Público cargadas desde bronze, sin transformar (DEC-006).",
  bcentral_uf: "Respuestas GetSeries de la UF de la BDE del Banco Central cargadas desde bronze, sin transformar.",
  bcentral_dolar: "Respuestas GetSeries del dólar observado de la BDE del Banco Central cargadas desde bronze, sin transformar.",
  bcentral_ipc: "Respuestas GetSeries del IPC de la BDE del Banco Central cargadas desde bronze, sin transformar.",
  mindicador_uf: "Respuestas de mindicador.cl para la UF cargadas desde bronze, sin transformar (fuente secundaria).",
  mindicador_dolar: "Respuestas de mindicador.cl para el dólar cargadas desde bronze, sin transformar (fuente secundaria).",
};

for (const [name, description] of Object.entries(TABLES)) {
  declare({ schema: rawDataset, name, description });
}
