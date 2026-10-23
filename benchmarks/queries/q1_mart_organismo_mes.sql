-- kind: variant
-- What gold.mart_organismo_mes computes, per organismo and month of 2025.
WITH por_mes AS (
  SELECT
    codigo_organismo,
    DATE_TRUNC(fecha_publicacion, MONTH) AS mes,
    COUNT(DISTINCT codigo_licitacion) AS n_licitaciones,
    COUNT(DISTINCT IF(estado = 'Desierta', codigo_licitacion, NULL)) AS n_desiertas,
    COUNT(DISTINCT IF(estado = 'Revocada', codigo_licitacion, NULL)) AS n_revocadas
  FROM {tabla}
  WHERE fecha_publicacion BETWEEN DATE '2025-01-01' AND DATE '2025-12-31'
  GROUP BY codigo_organismo, mes
)
SELECT
  codigo_organismo,
  mes,
  n_licitaciones,
  n_desiertas,
  n_revocadas,
  SAFE_DIVIDE(n_desiertas, n_licitaciones) AS tasa_desiertas,
  SAFE_DIVIDE(n_revocadas, n_licitaciones) AS tasa_revocadas
FROM por_mes
