// Row rules of the quarantine (REQ-010) and the natural-person rule of S-04: one source for the JS version (local
// tests) and the SQL version (silver, quarantine and gold use the same predicate). Self-contained: no require of other
// includes.

// Fixed order of the reasons, in JS and in SQL.
const CODIGOS = ["clave_nula", "rut_dv_invalido", "monto_negativo", "moneda_desconocida", "fecha_fuera_de_rango"];

const MONEDAS = ["CLP", "CLF", "USD", "UTM", "EUR"];

const FECHA_MINIMA = "2000-01-01";

// Tolerance of the UF and dollar reconciliation in CLP (S-09); used as NUMERIC '0.01'.
const TOLERANCIA_RECONCILIACION = "0.01";

// A RUT whose body is below this number belongs to a natural person (S-04, DEC-008).
const UMBRAL_PERSONA_NATURAL = 50000000;

// JSON fields of the document that each rule reads. FechaCierre and FechaAdjudicacion are left out of the range rule:
// both are planned, future dates in a published tender (the first real run held 932 tenders by FechaAdjudicacion, up
// to 2029; S-23).
const ENTIDADES = {
  licitaciones: {
    claves: ["$.CodigoExterno"],
    rut: null,
    montos: ["$.MontoEstimado"],
    moneda: "$.Moneda",
    fechasObligatorias: ["$.Fechas.FechaPublicacion"],
    fechas: ["$.Fechas.FechaCreacion"],
  },
  ordenes_compra: {
    claves: ["$.Codigo"],
    rut: "$.Proveedor.RutSucursal",
    montos: ["$.TotalNeto", "$.Total"],
    moneda: "$.TipoMoneda",
    fechasObligatorias: ["$.Fechas.FechaCreacion"],
    fechas: ["$.Fechas.FechaEnvio", "$.Fechas.FechaAceptacion"],
  },
};

/** RUT without dots or spaces and upper-case DV, like silver.rutSql. */
function normalizarRut(rut) {
  return String(rut).replace(/[^0-9kK-]/g, "").toUpperCase();
}

/** Check digit of a RUT body (modulo 11, weights 2..7 from the right); 10 is "K". */
function dvRut(cuerpo) {
  const digitos = String(cuerpo).split("").reverse();
  const suma = digitos.reduce((s, d, pos) => s + Number(d) * (2 + (pos % 6)), 0);
  const r = (11 - (suma % 11)) % 11;
  return r === 10 ? "K" : String(r);
}

function rutValido(rut) {
  const n = normalizarRut(rut);
  if (!/^[0-9]{1,9}-[0-9K]$/.test(n)) return false;
  const [cuerpo, dv] = n.split("-");
  return dv === dvRut(cuerpo);
}

/** S-04: the RUT body is below UMBRAL_PERSONA_NATURAL; a non-numeric body counts as a person (the protected side). */
function esPersonaNatural(rut) {
  const cuerpo = normalizarRut(rut).split("-")[0];
  if (!/^[0-9]+$/.test(cuerpo)) return true;
  return Number(cuerpo) < UMBRAL_PERSONA_NATURAL;
}

function sumarDia(fecha) {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const nulo = (v) => v === null || v === undefined;

/**
 * Codes of CODIGOS that the row breaks, in that order; fila carries the values already read (dates as YYYY-MM-DD).
 * fechaD is the day the document was fetched (the raw partition _ingest_date, UTC): a date may run until D+1, which
 * covers the Chilean clock. An empty RUT counts as absent (S-23).
 */
function motivos(fila, { fechaD }) {
  const { claves = [], rut = null, montos = [], moneda = null, fechasObligatorias = [], fechas = [] } = fila;
  const maxima = sumarDia(fechaD);
  const fuera = (f) => f < FECHA_MINIMA || f > maxima;
  const falla = {
    clave_nula: claves.some((c) => nulo(c) || c === ""),
    rut_dv_invalido: !nulo(rut) && String(rut).trim() !== "" && !rutValido(rut),
    monto_negativo: montos.some((m) => !nulo(m) && m < 0),
    moneda_desconocida: !nulo(moneda) && !MONEDAS.includes(String(moneda).trim().toUpperCase()),
    fecha_fuera_de_rango:
      fechasObligatorias.some((f) => nulo(f) || fuera(f)) || fechas.some((f) => !nulo(f) && fuera(f)),
  };
  return CODIGOS.filter((c) => falla[c]);
}

/** Scalar subquery: the normalized RUT has the right shape and its DV matches modulo 11. */
function rutValidoSql(rutNormalizado) {
  const r = "MOD(11 - MOD(SUM(SAFE_CAST(d AS INT64) * (2 + MOD(pos, 6))), 11), 11)";
  return `(SELECT REGEXP_CONTAINS(rut, r'^[0-9]{1,9}-[0-9K]$') AND RIGHT(rut, 1) = (SELECT CASE ${r} WHEN 10 THEN 'K' ELSE CAST(${r} AS STRING) END FROM UNNEST(SPLIT(REVERSE(SPLIT(rut, '-')[SAFE_OFFSET(0)]), '')) AS d WITH OFFSET pos) FROM (SELECT ${rutNormalizado} AS rut))`;
}

/**
 * ARRAY<STRING> with every code the document breaks, in the order of CODIGOS (empty when it passes). fechaD defaults
 * to _ingest_date, the day the detail was fetched: the listing date (`fecha`) can be days earlier and a legitimate
 * acceptance or creation in between would fall "in the future" (388 orders in the first real run).
 */
function motivosSql(entidad, { doc = "doc", fechaD = "_ingest_date" } = {}) {
  const e = ENTIDADES[entidad];
  if (!e) throw new Error(`unknown entity ${entidad}`);
  const valor = (p) => `JSON_VALUE(${doc}, '${p}')`;
  const fecha = (p) => `DATE(SAFE_CAST(${valor(p)} AS DATETIME))`;
  const rango = `BETWEEN DATE '${FECHA_MINIMA}' AND DATE_ADD(${fechaD}, INTERVAL 1 DAY)`;
  const condiciones = {
    clave_nula: e.claves.map((p) => `${valor(p)} IS NULL OR ${valor(p)} = ''`).join(" OR "),
    rut_dv_invalido:
      e.rut && `NULLIF(TRIM(${valor(e.rut)}), '') IS NOT NULL AND NOT ${rutValidoSql(`UPPER(REGEXP_REPLACE(${valor(e.rut)}, r'[^0-9kK-]', ''))`)}`,
    monto_negativo: e.montos.map((p) => `SAFE_CAST(${valor(p)} AS NUMERIC) < 0`).join(" OR "),
    moneda_desconocida:
      e.moneda && `UPPER(TRIM(${valor(e.moneda)})) NOT IN (${MONEDAS.map((m) => `'${m}'`).join(", ")})`,
    fecha_fuera_de_rango: [
      ...e.fechasObligatorias.map((p) => `IFNULL(${fecha(p)} NOT ${rango}, TRUE)`),
      ...e.fechas.map((p) => `${fecha(p)} NOT ${rango}`),
    ].join(" OR "),
  };
  const ifs = CODIGOS.filter((c) => condiciones[c]).map((c) => `IF(${condiciones[c]}, '${c}', NULL)`);
  return `ARRAY(SELECT m FROM UNNEST([${ifs.join(", ")}]) AS m WITH OFFSET o WHERE m IS NOT NULL ORDER BY o)`;
}

/** SQL version of esPersonaNatural over an already normalized RUT. */
function esPersonaNaturalSql(rutNormalizado) {
  return `IFNULL(SAFE_CAST(SPLIT(${rutNormalizado}, '-')[SAFE_OFFSET(0)] AS INT64) < ${UMBRAL_PERSONA_NATURAL}, TRUE)`;
}

/** The single predicate of a valid document: silver keeps it, the quarantine keeps its negation. */
function pasaSql(entidad, opts) {
  return `ARRAY_LENGTH(${motivosSql(entidad, opts)}) = 0`;
}

module.exports = {
  CODIGOS,
  MONEDAS,
  FECHA_MINIMA,
  TOLERANCIA_RECONCILIACION,
  UMBRAL_PERSONA_NATURAL,
  ENTIDADES,
  normalizarRut,
  dvRut,
  rutValido,
  esPersonaNatural,
  motivos,
  rutValidoSql,
  motivosSql,
  esPersonaNaturalSql,
  pasaSql,
};
