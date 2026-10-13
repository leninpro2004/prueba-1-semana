const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { api, bajar, levantar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * CU-106: consulta de stock desde Terreno o Finanzas (GET /api/integracion/stock).
 *
 * Lo que protegen:
 *  - Basta el token del login común (Exc 1): sin token o con la cuenta desactivada, 401.
 *  - Los rechazos traen el mismo código que CU-107 (CAMPOS_INVALIDOS, SKU_NO_RECONOCIDO).
 *  - El stock informado es el de inventario_bodega (físico, reservado y disponible) y
 *    la consulta no lo cambia.
 *
 * Semilla: MAT-FIFO en la bodega 1 con 30 físicas y 5 reservadas (25 disponibles);
 * sin stock en la bodega 2. Las dos bodegas están activas.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const RUTA = '/api/integracion/stock';
const consultar = (params, opciones = {}) => api('GET', `${RUTA}?${new URLSearchParams(params)}`, { rol: 'jop', ...opciones });

describe('Exc 1: token', () => {
  test('sin token → 401', async () => {
    const r = await consultar({ sku: 'MAT-FIFO' }, { sinToken: true });
    assert.equal(r.status, 401);
  });

  test('cuenta desactivada → 401', async () => {
    await db.query(`UPDATE inventario.usuario SET usuario_estado_cuenta = 'inactivo' WHERE usuario_id_usuario = 2`);
    const r = await consultar({ sku: 'MAT-FIFO' });
    assert.equal(r.status, 401);
    assert.equal(r.body.codigo, 'CUENTA_DESACTIVADA');
  });
});

describe('Exc 3: campos', () => {
  test('sin SKU y con bodega mal formada → 400 con los dos errores', async () => {
    const r = await consultar({ bodega_id: 'x' });
    assert.equal(r.status, 400);
    assert.equal(r.body.codigo, 'CAMPOS_INVALIDOS');
    assert.deepEqual(r.body.campos.map(c => c.campo).sort(), ['bodega_id', 'sku']);
  });

  test('bodega inexistente → 400', async () => {
    const r = await consultar({ sku: 'MAT-FIFO', bodega_id: 999 });
    assert.equal(r.status, 400);
    assert.equal(r.body.codigo, 'CAMPOS_INVALIDOS');
    assert.equal(r.body.campos[0].campo, 'bodega_id');
  });

  test('bodega inactiva → 400', async () => {
    await db.query(`UPDATE inventario.bodega SET bodega_estado = 'inactivo' WHERE bodega_id_bodega = 2`);
    const r = await consultar({ sku: 'MAT-FIFO', bodega_id: 2 });
    assert.equal(r.status, 400);
    assert.match(r.body.campos[0].error, /no está activa/);
  });
});

describe('Exc 2: SKU', () => {
  test('SKU inexistente → 404', async () => {
    const r = await consultar({ sku: 'NO-EXISTE' });
    assert.equal(r.status, 404);
    assert.equal(r.body.codigo, 'SKU_NO_RECONOCIDO');
  });

  test('SKU inactivo → 404', async () => {
    await db.query(`UPDATE inventario.material SET material_estado = 'inactivo' WHERE material_sku = 'MAT-CRIT'`);
    const r = await consultar({ sku: 'MAT-CRIT' });
    assert.equal(r.status, 404);
    assert.equal(r.body.codigo, 'SKU_NO_RECONOCIDO');
  });
});

describe('Caso exitoso', () => {
  test('por bodega: físico, reservado y disponible', async () => {
    const r = await consultar({ sku: 'MAT-FIFO', bodega_id: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.unidad, 'unidad');
    assert.deepEqual(r.body.bodegas, [{ bodega_id: 1, bodega: 'Bodega Test', fisico: 30, reservado: 5, disponible: 25 }]);
  });

  test('sin bodega: el total es el stock real y la consulta no lo cambia', async () => {
    const antes = await db.stockDe('MAT-FIFO');
    const r = await consultar({ sku: 'MAT-FIFO' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.total, { fisico: antes.fisica, reservado: antes.reservada, disponible: antes.fisica - antes.reservada });
    assert.deepEqual(r.body.bodegas.map(b => b.bodega_id), [1]);   // la bodega 2 no tiene stock de MAT-FIFO
    assert.deepEqual(await db.stockDe('MAT-FIFO'), antes);
  });

  test('bodega sin stock del producto → esa bodega en 0', async () => {
    const r = await consultar({ sku: 'MAT-FIFO', bodega_id: 2 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.bodegas, [{ bodega_id: 2, bodega: 'Bodega Secundaria', fisico: 0, reservado: 0, disponible: 0 }]);
  });

  test('gerencia, jop y técnico pueden consultar', async () => {
    assert.equal((await consultar({ sku: 'MAT-FIFO' }, { rol: 'gerencia' })).status, 200);
    assert.equal((await consultar({ sku: 'MAT-FIFO' })).status, 200);
    const url = await levantar();
    const token = jwt.sign({ id: 3, username: 'tecnico.test', rol: 'tecnico' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const r = await fetch(`${url}${RUTA}?sku=MAT-FIFO`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200);
  });
});
