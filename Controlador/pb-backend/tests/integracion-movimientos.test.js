const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');
const { consumoNeto } = require('../src/db/historico');

/**
 * CU-107: movimientos de inventario registrados desde Terreno o Finanzas.
 *
 * Lo que protegen:
 *  - La regla de CU-108 decide quién puede (Exc 1), por el rol del token.
 *  - Ningún rechazo mueve stock (Exc 1 a 4 se deciden antes de tocarlo).
 *  - La salida descuenta FIFO respetando las reservas; la entrada es una
 *    devolución de consumo (motivo devolucion_consumo) que resta del consumo.
 *  - Idempotencia: la misma clave de envío no registra dos movimientos.
 *
 * Semilla: MAT-FIFO en la bodega 1 con 10 libres (lote viejo) + 20 físicas y 5
 * reservadas (lote nuevo) = 25 disponibles. Perfiles 1 gerencia, 2 jop.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const RUTA = '/api/integracion/movimientos';
const JOP = 2;
let clave = 0;

/** Regla de CU-108 creada por la API, como lo haría Gerencia. */
async function regla(modulo, perfil_id, tipos) {
  const r = await api('POST', '/api/integracion/reglas', { body: { modulo, perfil_id, tipos } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

/** Un envío válido de Terreno; `extra` pisa campos. Cada llamada lleva una clave nueva. */
const envio = (extra = {}) => ({
  modulo: 'terreno', tipo: 'salida', sku: 'MAT-FIFO', cantidad: 12, bodega_id: 1,
  referencia: 'OBRA-123', clave_envio: `clave-${++clave}`, ...extra,
});

async function movimientosExternos() {
  const { rows } = await db.query(
    `SELECT mi.material_sku AS sku, mi.movimiento_inventario_cantidad::float AS cantidad, mi.usuario_id_usuario::int AS usuario,
            mi.movimiento_inventario_modulo_origen AS modulo, mi.movimiento_inventario_referencia_origen AS referencia,
            mi.lote_id_lote::int AS lote, mot.movimiento_inventario_motivo_movimiento_nombre AS motivo
     FROM inventario.movimiento_inventario mi
     LEFT JOIN inventario.movimiento_inventario_motivo_movimiento mot
       ON mot.movimiento_inventario_motivo_movimiento_id_motivo_movimiento = mi.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
     WHERE mi.movimiento_inventario_modulo_origen <> 'inventario'
     ORDER BY mi.movimiento_inventario_id_movimiento`
  );
  return rows;
}

describe('Exc 1: regla de CU-108', () => {
  test('sin reglas → 403 y el stock no se mueve', async () => {
    const r = await api('POST', RUTA, { rol: 'jop', body: envio() });
    assert.equal(r.status, 403);
    assert.equal(r.body.codigo, 'SIN_PERMISO');
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 5 });
    assert.deepEqual(await movimientosExternos(), []);
  });

  test('la regla es por rol: jop autorizado pasa, gerencia sin regla no', async () => {
    await regla('terreno', JOP, ['salida']);
    assert.equal((await api('POST', RUTA, { rol: 'jop', body: envio() })).status, 201);
    assert.equal((await api('POST', RUTA, { rol: 'gerencia', body: envio() })).status, 403);
  });

  test('la regla es por módulo y por tipo', async () => {
    await regla('terreno', JOP, ['salida']);
    assert.equal((await api('POST', RUTA, { rol: 'jop', body: envio({ modulo: 'finanzas' }) })).status, 403);
    assert.equal((await api('POST', RUTA, { rol: 'jop', body: envio({ tipo: 'entrada' }) })).status, 403);
  });

  test('una regla desactivada ya no autoriza', async () => {
    await regla('terreno', JOP, ['salida']);
    await api('PUT', '/api/integracion/reglas', { body: { modulo: 'terreno', perfil_id: JOP, tipos: [] } });
    assert.equal((await api('POST', RUTA, { rol: 'jop', body: envio() })).status, 403);
  });

  test('módulo o tipo inválidos → 400 (no se puede evaluar la regla)', async () => {
    for (const extra of [{ modulo: 'produccion' }, { tipo: 'ajuste' }, { modulo: undefined }]) {
      const r = await api('POST', RUTA, { rol: 'jop', body: envio(extra) });
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.equal(r.body.codigo, 'CAMPOS_INVALIDOS');
    }
  });
});

describe('Exc 2, 3 y 4: validaciones sin mover stock', () => {
  beforeEach(async () => { await regla('terreno', JOP, ['entrada', 'salida']); });

  test('Exc 3: informa TODOS los campos con error juntos', async () => {
    const r = await api('POST', RUTA, { rol: 'jop', body: { modulo: 'terreno', tipo: 'salida', cantidad: -3 } });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.campos.map(c => c.campo).sort(), ['bodega_id', 'cantidad', 'clave_envio', 'referencia', 'sku']);
  });

  test('Exc 3: cantidad con más de 4 decimales, bodega inexistente o inactiva', async () => {
    assert.equal((await api('POST', RUTA, { rol: 'jop', body: envio({ cantidad: 1.12345 }) })).status, 400);
    let r = await api('POST', RUTA, { rol: 'jop', body: envio({ bodega_id: 99 }) });
    assert.equal(r.status, 400);
    assert.equal(r.body.campos[0].campo, 'bodega_id');
    await db.query(`UPDATE inventario.bodega SET bodega_estado = 'inactivo' WHERE bodega_id_bodega = 1`);
    r = await api('POST', RUTA, { rol: 'jop', body: envio() });
    assert.equal(r.status, 400);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 5 });
  });

  test('Exc 2: SKU inexistente o inactivo → 404', async () => {
    let r = await api('POST', RUTA, { rol: 'jop', body: envio({ sku: 'NO-EXISTE' }) });
    assert.equal(r.status, 404);
    assert.equal(r.body.codigo, 'SKU_NO_RECONOCIDO');
    await db.query(`UPDATE inventario.material SET material_estado = 'inactivo' WHERE material_sku = 'MAT-FIFO'`);
    r = await api('POST', RUTA, { rol: 'jop', body: envio() });
    assert.equal(r.status, 404);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 5 });
  });

  test('Exc 4: stock insuficiente → 409 con el disponible (las reservas no cuentan), sin mover stock', async () => {
    const r = await api('POST', RUTA, { rol: 'jop', body: envio({ cantidad: 26 }) });
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'STOCK_INSUFICIENTE');
    assert.equal(r.body.stock_disponible, 25);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 5 });
    assert.deepEqual(await movimientosExternos(), []);
  });
});

describe('Registro', () => {
  beforeEach(async () => { await regla('terreno', JOP, ['entrada', 'salida']); });

  test('salida: descuenta FIFO respetando reservas y guarda módulo, referencia y usuario', async () => {
    const r = await api('POST', RUTA, { rol: 'jop', body: envio({ cantidad: 12 }) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.stock_disponible, 13);
    assert.equal(await db.stockDeLote('MAT-FIFO', 1), 0);    // lote viejo primero
    assert.equal(await db.stockDeLote('MAT-FIFO', 2), 18);   // 2 del nuevo; sus 5 reservadas intactas
    assert.deepEqual(await db.descuadresDeReservas(), []);
    assert.deepEqual(await movimientosExternos(), [
      { sku: 'MAT-FIFO', cantidad: 12, usuario: 2, modulo: 'terreno', referencia: 'OBRA-123', lote: 1, motivo: null },
    ]);
    assert.equal(await db.contar('finanzas.evento_auditoria', `accion_realizada = 'registrar_movimiento_externo'`), 1);
  });

  test('entrada = devolución de consumo: suma al lote más antiguo y resta del consumo', async () => {
    await api('POST', RUTA, { rol: 'jop', body: envio({ cantidad: 12 }) });
    const r = await api('POST', RUTA, { rol: 'jop', body: envio({ tipo: 'entrada', cantidad: 5 }) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await db.stockDeLote('MAT-FIFO', 1), 5);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 23, reservada: 5 });
    const devolucion = (await movimientosExternos())[1];
    assert.equal(devolucion.motivo, 'devolucion_consumo');
    assert.equal((await consumoNeto({ query: db.query })).get('MAT-FIFO'), 7);
  });

  test('historial: el documento es la referencia de origen, no la factura del lote al que vuelve la devolución', async () => {
    const { rows } = await db.query(
      `INSERT INTO inventario.factura_compra (factura_compra_numero_factura, factura_compra_fecha_emision, proveedor_id_proveedor)
       VALUES ('F-LOTE-VIEJO', '2026-01-01', 1) RETURNING factura_compra_id_factura AS id`
    );
    await db.query(`UPDATE inventario.lote SET factura_compra_id_factura = $1 WHERE lote_id_lote = 1`, [rows[0].id]);
    await api('POST', RUTA, { rol: 'jop', body: envio({ cantidad: 12 }) });
    await api('POST', RUTA, { rol: 'jop', body: envio({ tipo: 'entrada', cantidad: 5 }) });   // vuelve al lote 1

    const r = await api('GET', '/api/movimientos?paginado=1');
    const externos = r.body.movimientos.filter(m => m.documento_tipo === 'origen');
    assert.equal(externos.length, 2);
    assert.ok(externos.every(m => m.documento_ref === 'Terreno: OBRA-123'));
    assert.ok(!r.body.movimientos.some(m => m.documento_ref === 'F-LOTE-VIEJO'));
  });

  test('entrada en una bodega sin lotes de ese SKU: crea un lote', async () => {
    const r = await api('POST', RUTA, { rol: 'jop', body: envio({ tipo: 'entrada', cantidad: 4, bodega_id: 2 }) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.stock_disponible, 4);
    const { rows } = await db.query(
      `SELECT l.lote_numero_lote AS numero FROM inventario.inventario_bodega ib
       JOIN inventario.lote l USING (lote_id_lote) WHERE ib.material_sku = 'MAT-FIFO' AND ib.bodega_id_bodega = 2`
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].numero, /^LOTE-\d{8}-\d+$/);
  });
});

describe('Idempotencia (clave de envío)', () => {
  beforeEach(async () => { await regla('terreno', JOP, ['salida']); await regla('finanzas', JOP, ['salida']); });

  test('reenvío con la misma clave y datos: 200 repetido con el original, sin mover stock', async () => {
    const body = envio({ cantidad: 3 });
    const r1 = await api('POST', RUTA, { rol: 'jop', body });
    const r2 = await api('POST', RUTA, { rol: 'jop', body });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 200);
    assert.equal(r2.body.repetido, true);
    assert.equal(r2.body.movimiento_id, r1.body.movimiento_id);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 27, reservada: 5 });
    assert.equal((await movimientosExternos()).length, 1);
  });

  test('misma clave con datos distintos → 409 CLAVE_REUTILIZADA, sin mover stock', async () => {
    const body = envio({ cantidad: 3 });
    await api('POST', RUTA, { rol: 'jop', body });
    const r = await api('POST', RUTA, { rol: 'jop', body: { ...body, cantidad: 4 } });
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'CLAVE_REUTILIZADA');
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 27, reservada: 5 });
  });

  test('la misma clave en otro módulo es otro envío', async () => {
    const body = envio({ cantidad: 3 });
    await api('POST', RUTA, { rol: 'jop', body });
    const r = await api('POST', RUTA, { rol: 'jop', body: { ...body, modulo: 'finanzas' } });
    assert.equal(r.status, 201);
    assert.equal((await movimientosExternos()).length, 2);
  });

  test('dos envíos simultáneos con la misma clave registran un solo movimiento', async () => {
    const body = envio({ cantidad: 2 });
    const rs = await Promise.all([1, 2, 3].map(() => api('POST', RUTA, { rol: 'jop', body })));
    assert.equal(rs.filter(r => r.status === 201).length, 1, JSON.stringify(rs.map(r => r.status)));
    assert.ok(rs.every(r => r.status === 201 || (r.status === 200 && r.body.repetido)));
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 28, reservada: 5 });
  });
});
