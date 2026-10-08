const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * CU-30: codigos de barras internos y registro por escaneo.
 *
 * Invariantes que protegen:
 *  - todo material nuevo (creado o duplicado) nace con UN codigo interno, solo
 *    digitos y con prefijo 2 (D3). Un codigo lleva a un solo SKU;
 *  - un SKU nunca tiene dos codigos: generar sobre uno que ya tiene es 409;
 *  - un producto inactivo no admite entradas ni salidas, y el rechazo llega
 *    ANTES de tocar el stock (Exc 3).
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const FORMATO = /^2\d{11}$/;
const NUEVO = { nombre: 'Material CU-30', unidad_medida_id: 1 };

/** Codigos guardados en BD para un SKU. */
async function codigosDe(sku) {
  const { rows } = await db.query(
    `SELECT material_codigo_barras AS codigo FROM inventario.material_codigo_barras WHERE material_sku = $1`,
    [sku]
  );
  return rows.map(r => r.codigo);
}

async function desactivar(sku) {
  await db.query(`UPDATE inventario.material SET material_estado = 'inactivo' WHERE material_sku = $1`, [sku]);
}

describe('Generar el codigo interno (CU-30)', () => {
  test('crear un material le asigna un codigo con prefijo 2 y 12 digitos', async () => {
    const r = await api('POST', '/api/materiales', { body: { ...NUEVO, sku: 'CB-UNO' } });

    assert.equal(r.status, 201);
    const codigos = await codigosDe('CB-UNO');
    assert.equal(codigos.length, 1);
    assert.match(codigos[0], FORMATO);
    assert.equal(r.body.codigo_barras, codigos[0]);
  });

  test('dos materiales reciben codigos distintos', async () => {
    await api('POST', '/api/materiales', { body: { ...NUEVO, sku: 'CB-A' } });
    await api('POST', '/api/materiales', { body: { ...NUEVO, sku: 'CB-B' } });

    const [a] = await codigosDe('CB-A');
    const [b] = await codigosDe('CB-B');
    assert.ok(a && b);
    assert.notEqual(a, b);
  });

  test('duplicar un material le da a la copia su propio codigo', async () => {
    await api('POST', '/api/materiales', { body: { ...NUEVO, sku: 'CB-BASE' } });
    const r = await api('POST', '/api/materiales/duplicar', { body: { sku_base: 'CB-BASE', sku_nuevo: 'CB-COPIA' } });

    assert.equal(r.status, 201);
    const [base] = await codigosDe('CB-BASE');
    const copia = await codigosDe('CB-COPIA');
    assert.equal(copia.length, 1);
    assert.match(copia[0], FORMATO);
    assert.notEqual(copia[0], base);
  });

  test('un SKU duplicado no deja un codigo huerfano', async () => {
    const antes = await db.contar('inventario.material_codigo_barras');
    const r = await api('POST', '/api/materiales', { body: { ...NUEVO, sku: 'MAT-FIFO' } });

    assert.equal(r.status, 409);
    assert.equal(await db.contar('inventario.material_codigo_barras'), antes);
  });

  test('generar para un producto sin codigo lo crea; la segunda vez es 409', async () => {
    // Los materiales de la semilla son anteriores a CU-30: no tienen codigo
    assert.deepEqual(await codigosDe('MAT-FIFO'), []);

    const primero = await api('POST', '/api/codigos/MAT-FIFO/generar');
    assert.equal(primero.status, 201);
    assert.match(primero.body.codigo_barras, FORMATO);

    const segundo = await api('POST', '/api/codigos/MAT-FIFO/generar');
    assert.equal(segundo.status, 409);
    assert.deepEqual(await codigosDe('MAT-FIFO'), [primero.body.codigo_barras]);
  });

  test('generar es solo para gerencia', async () => {
    const r = await api('POST', '/api/codigos/MAT-FIFO/generar', { rol: 'jop' });
    assert.equal(r.status, 403);
    assert.deepEqual(await codigosDe('MAT-FIFO'), []);
  });

  test('eliminar un material sin movimientos borra tambien su codigo', async () => {
    await api('POST', '/api/materiales', { body: { ...NUEVO, sku: 'CB-BORRAR' } });
    const r = await api('DELETE', '/api/materiales/CB-BORRAR');

    assert.equal(r.status, 200);
    assert.equal(r.body.eliminado, true);
    assert.deepEqual(await codigosDe('CB-BORRAR'), []);
  });
});

describe('Resolver un codigo escaneado (CU-30)', () => {
  test('por codigo de barras devuelve el producto y sus bodegas con stock', async () => {
    const { body: { codigo_barras } } = await api('POST', '/api/codigos/MAT-FIFO/generar');

    const r = await api('GET', `/api/codigos/${codigo_barras}`, { rol: 'jop' });

    assert.equal(r.status, 200);
    assert.equal(r.body.sku, 'MAT-FIFO');
    assert.equal(r.body.estado, 'activo');
    assert.equal(r.body.encontrado_por, 'codigo');
    assert.ok(r.body.bodegas.length >= 1);
  });

  test('por SKU, sin distinguir mayusculas', async () => {
    const r = await api('GET', '/api/codigos/mat-fifo');
    assert.equal(r.status, 200);
    assert.equal(r.body.sku, 'MAT-FIFO');
    assert.equal(r.body.encontrado_por, 'sku');
  });

  test('un codigo que no existe es 404 (Exc 1)', async () => {
    const r = await api('GET', '/api/codigos/299999999999');
    assert.equal(r.status, 404);
  });

  test('un producto inactivo se resuelve con su estado (la pantalla lo bloquea)', async () => {
    await desactivar('MAT-UNO');
    const r = await api('GET', '/api/codigos/MAT-UNO');
    assert.equal(r.status, 200);
    assert.equal(r.body.estado, 'inactivo');
  });
});

describe('Producto inactivo no admite movimientos (CU-30 Exc 3)', () => {
  test('una entrada se rechaza y no toca el stock', async () => {
    await desactivar('MAT-FIFO');
    const antes = await db.stockDe('MAT-FIFO');
    const movs = await db.contar('inventario.movimiento_inventario');

    const r = await api('POST', '/api/movimientos/entrada', {
      body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 5, tipo_movimiento_id: 1 },
    });

    assert.equal(r.status, 400);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), antes);
    assert.equal(await db.contar('inventario.movimiento_inventario'), movs);
  });

  test('una salida se rechaza y no toca el stock', async () => {
    await desactivar('MAT-FIFO');
    const antes = await db.stockDe('MAT-FIFO');
    const movs = await db.contar('inventario.movimiento_inventario');

    const r = await api('POST', '/api/movimientos/salida', {
      body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 1, tipo_movimiento_id: 2, motivo_id: 2 },
    });

    assert.equal(r.status, 400);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), antes);
    assert.equal(await db.contar('inventario.movimiento_inventario'), movs);
  });
});
