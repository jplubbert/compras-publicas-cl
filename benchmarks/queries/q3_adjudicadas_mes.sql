-- kind: variant
-- Awarded tenders of 2024: total estimated amount and count per month and tipo.
SELECT
  DATE_TRUNC(fecha_publicacion, MONTH) AS mes,
  tipo,
  COUNT(*) AS n_licitaciones,
  SUM(monto_estimado) AS monto_estimado_total
FROM {tabla}
WHERE fecha_publicacion BETWEEN DATE '2024-01-01' AND DATE '2024-12-31'
  AND estado = 'Adjudicada'
GROUP BY mes, tipo
