-- kind: rewrite
-- Before: the last publication day of each organismo in 2025 with a self-join (two reads of the table).
SELECT t.codigo_organismo, t.codigo_licitacion, t.fecha_publicacion, t.monto_estimado
FROM {tabla} t
JOIN (
  SELECT codigo_organismo, MAX(fecha_publicacion) AS ultima
  FROM {tabla}
  WHERE fecha_publicacion BETWEEN DATE '2025-01-01' AND DATE '2025-12-31'
  GROUP BY codigo_organismo
) m
  ON t.codigo_organismo = m.codigo_organismo AND t.fecha_publicacion = m.ultima
WHERE t.fecha_publicacion BETWEEN DATE '2025-01-01' AND DATE '2025-12-31'
