-- kind: rewrite
-- After: only the columns the consumer needs.
SELECT codigo_licitacion, estado, monto_estimado
FROM {tabla}
WHERE fecha_publicacion BETWEEN DATE '2025-01-01' AND DATE '2025-03-31'
  AND codigo_organismo = '1500'
