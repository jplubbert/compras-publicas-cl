-- kind: rewrite
-- Before: SELECT * reads every column of the filtered partitions.
SELECT *
FROM {tabla}
WHERE fecha_publicacion BETWEEN DATE '2025-01-01' AND DATE '2025-03-31'
  AND codigo_organismo = '1500'
