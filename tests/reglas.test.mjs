import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const project = join(dirname(fileURLToPath(import.meta.url)), '..');
const reglas = createRequire(import.meta.url)(join(project, 'includes/reglas.js'));

const D = { fechaD: '2026-10-21' };

test('REQ-010 E2: a RUT with a wrong check digit gives rut_dv_invalido', () => {
  assert.equal(reglas.dvRut('12345678'), '5');
  assert.ok(reglas.motivos({ claves: ['X'], rut: '12.345.678-0' }, D).includes('rut_dv_invalido'));
});

test('REQ-010 E3: a negative amount and an unknown currency give both reasons in order', () => {
  assert.deepEqual(reglas.motivos({ claves: ['X'], montos: [-1], moneda: 'XYZ' }, D), [
    'monto_negativo',
    'moneda_desconocida',
  ]);
});

test('REQ-010 E4: a valid row gives no reasons', () => {
  assert.deepEqual(reglas.motivos({ claves: ['X'], rut: '12.345.678-5', montos: [0], moneda: 'CLP' }, D), []);
});

test('the check digit follows modulo 11 with K for 10', () => {
  assert.ok(reglas.rutValido('6-K'));
  assert.ok(reglas.rutValido('76.123.456-0'));
  assert.equal(reglas.rutValido('76.123.456-7'), false);
  assert.equal(reglas.rutValido('abc'), false);
});

test('S-04: a RUT body below 50,000,000 or non-numeric is a natural person, in JS and in SQL', () => {
  assert.equal(reglas.esPersonaNatural('49.999.999-2'), true);
  assert.equal(reglas.esPersonaNatural('50.000.000-7'), false);
  assert.equal(reglas.esPersonaNatural('abc'), true);
  const sql = reglas.esPersonaNaturalSql('r');
  assert.ok(sql.includes('< 50000000') && sql.startsWith('IFNULL('), sql);
});

test('clave_nula for a null or empty key; currency is case-insensitive and a null one is no reason', () => {
  assert.deepEqual(reglas.motivos({ claves: [null] }, D), ['clave_nula']);
  assert.deepEqual(reglas.motivos({ claves: [''] }, D), ['clave_nula']);
  assert.deepEqual(reglas.motivos({ claves: ['X'], moneda: 'clf' }, D), []);
  assert.deepEqual(reglas.motivos({ claves: ['X'], moneda: null }, D), []);
});

test('dates must fall between 2000-01-01 and D+1; a null required date is a reason, a null optional one is not', () => {
  const fecha = (fechas, fechasObligatorias = []) => reglas.motivos({ claves: ['X'], fechas, fechasObligatorias }, D);
  assert.deepEqual(fecha(['1999-12-31']), ['fecha_fuera_de_rango']);
  assert.deepEqual(fecha(['2026-10-23']), ['fecha_fuera_de_rango']);
  assert.deepEqual(fecha(['2000-01-01']), []);
  assert.deepEqual(fecha(['2026-10-22']), []);
  assert.deepEqual(fecha([], [null]), ['fecha_fuera_de_rango']);
  assert.deepEqual(fecha([null]), []);
});

test('a row that breaks the 5 rules carries the 5 codes in the order of CODIGOS', () => {
  const fila = { claves: [null], rut: '12.345.678-0', montos: [-5], moneda: 'XYZ', fechas: ['1990-01-01'] };
  assert.deepEqual(reglas.motivos(fila, D), reglas.CODIGOS);
  assert.deepEqual(reglas.CODIGOS, [
    'clave_nula', 'rut_dv_invalido', 'monto_negativo', 'moneda_desconocida', 'fecha_fuera_de_rango',
  ]);
});

test('motivosSql keeps the codes of each entity in order with the same currencies and date limits', () => {
  for (const entidad of ['licitaciones', 'ordenes_compra']) {
    const sql = reglas.motivosSql(entidad);
    const codigos = reglas.CODIGOS.filter((c) => entidad === 'ordenes_compra' || c !== 'rut_dv_invalido');
    const posiciones = codigos.map((c) => sql.indexOf(`'${c}'`));
    assert.ok(posiciones.every((p) => p > 0), sql);
    assert.deepEqual(posiciones, [...posiciones].sort((a, b) => a - b));
    assert.ok(sql.includes("IN ('CLP', 'CLF', 'USD', 'UTM', 'EUR')"), sql);
    assert.ok(sql.includes("DATE '2000-01-01'"), sql);
    assert.ok(sql.includes('DATE_ADD(fecha, INTERVAL 1 DAY)'), sql);
    assert.equal(reglas.pasaSql(entidad), `ARRAY_LENGTH(${sql}) = 0`);
  }
  assert.ok(!reglas.motivosSql('licitaciones').includes('rut_dv_invalido'));
});
