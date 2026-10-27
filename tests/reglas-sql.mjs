// Prints the BigQuery query that runs the shared cases of casos-reglas.json through motivosSql (REQ-010 E6): one row
// per case whose SQL reasons differ from the expected ones (an empty result means JS and SQL agree). No table is read.
// Run by scripts/it/reglas-sql.sh; `node dataform/tests/reglas-sql.mjs` just prints the query.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = join(dirname(fileURLToPath(import.meta.url)), '..');
const reglas = createRequire(import.meta.url)(join(project, 'includes/reglas.js'));
const casos = JSON.parse(readFileSync(join(project, 'tests/casos-reglas.json'), 'utf8'));

/** Sets a `$.A.B` path of a document to a value (a null value leaves the field out: JSON_VALUE gives NULL). */
function poner(doc, ruta, valor) {
  if (valor === null || valor === undefined) return;
  const partes = ruta.replace(/^\$\./, '').split('.');
  let nodo = doc;
  for (const parte of partes.slice(0, -1)) nodo = nodo[parte] ??= {};
  nodo[partes.at(-1)] = valor;
}

/** The JSON document of a case, with the values of the row on the paths of its entity. */
export function documento(caso) {
  const e = reglas.ENTIDADES[caso.entidad];
  const { claves = [], rut = null, montos = [], moneda = null, fechasObligatorias = [], fechas = [] } = caso.fila;
  const doc = {};
  claves.forEach((v, i) => poner(doc, e.claves[i], v));
  if (e.rut) poner(doc, e.rut, rut);
  montos.forEach((v, i) => poner(doc, e.montos[i], v));
  if (e.moneda) poner(doc, e.moneda, moneda);
  fechasObligatorias.forEach((v, i) => poner(doc, e.fechasObligatorias[i], v));
  fechas.forEach((v, i) => poner(doc, e.fechas[i], v));
  return doc;
}

const literal = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const lista = (xs) => (xs.length ? `[${xs.map(literal).join(', ')}]` : 'ARRAY<STRING>[]');

export function consulta() {
  const filas = casos.map(
    (c) =>
      `STRUCT(${literal(c.nombre)} AS nombre, ${literal(c.entidad)} AS entidad, DATE ${literal(c.fechaD)} AS fecha_d, ` +
      `JSON ${literal(JSON.stringify(documento(c)))} AS doc, ${lista(c.motivos)} AS esperado)`,
  );
  const motivos = Object.keys(reglas.ENTIDADES)
    .map((e) => `WHEN ${literal(e)} THEN ${reglas.motivosSql(e, { doc: 'doc', fechaD: 'fecha_d' })}`)
    .join(' ');
  return `WITH casos AS (SELECT * FROM UNNEST([\n  ${filas.join(',\n  ')}\n]))
SELECT nombre, entidad, esperado, motivos
FROM (SELECT nombre, entidad, esperado, CASE entidad ${motivos} END AS motivos FROM casos)
WHERE TO_JSON_STRING(esperado) != TO_JSON_STRING(motivos)
ORDER BY nombre`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(`${consulta()}\n`);
