-- kind: rewrite
-- After: one read with a window function; RANK keeps the ties of the last day, like the join.
SELECT codigo_organismo, codigo_licitacion, fecha_publicacion, monto_estimado
FROM {tabla}
WHERE fecha_publicacion BETWEEN DATE '2025-01-01' AND DATE '2025-12-31'
QUALIFY RANK() OVER (PARTITION BY codigo_organismo ORDER BY fecha_publicacion DESC) = 1
