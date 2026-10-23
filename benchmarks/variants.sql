-- The three benchmark variants (REQ-013, DEC-007). run.py replaces {dataset} and {generate} (the SELECT of
-- generate.sql) and runs each statement on its own, so the three tables hold identical rows.
-- variant: licitaciones_sin_particion
CREATE OR REPLACE TABLE {dataset}.licitaciones_sin_particion AS
{generate}
-- variant: licitaciones_particionada
CREATE OR REPLACE TABLE {dataset}.licitaciones_particionada
PARTITION BY DATE_TRUNC(fecha_publicacion, MONTH)
AS
{generate}
-- variant: licitaciones_particionada_cluster
CREATE OR REPLACE TABLE {dataset}.licitaciones_particionada_cluster
PARTITION BY DATE_TRUNC(fecha_publicacion, MONTH)
CLUSTER BY codigo_organismo, estado
OPTIONS (require_partition_filter = TRUE)
AS
{generate}
