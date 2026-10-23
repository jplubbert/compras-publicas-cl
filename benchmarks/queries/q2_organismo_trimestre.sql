-- kind: variant
-- One organismo over the first quarter of 2025.
SELECT codigo_licitacion, estado, tipo, moneda, monto_estimado
FROM {tabla}
WHERE fecha_publicacion BETWEEN DATE '2025-01-01' AND DATE '2025-03-31'
  AND codigo_organismo = '1500'
