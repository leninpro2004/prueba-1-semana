const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');
const { stockAFecha, consumoNeto } = require('../src/db/historico');

/**
 * D60: traslado entre bodegas (POST /api/movimientos/traslado).
 *
 * Lo que protegen:
 *  - Es UNA transacción: el stock total no cambia; sale del origen por FIFO y entra en el
 *    destino con EL MISMO LOTE (conserva su fecha de ingreso).
 *  - Lo reservado no se traslada, y un rechazo no mueve nada.
 *  - No cuenta como consumo (motivo 'traslado_bodega', clasificación Traslado) y
 *    stockAFecha sigue cuadrando con el stock real.
 *  - CU-44 no revierte una mitad del traslado.
 *
 * Semilla: MAT-FIFO en la bodega 1: lote 1 (viejo) 10 libres, lote 2 (nuevo) 20 con 5
 * reservadas. La bodega 2 está vacía. El catálogo de traslado se agrega aquí (como en
 * historico.test.js), porque la semilla no lo trae.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => {
  await db.resetear();
  await db.query(
    `INSERT INTO inventario.movimiento_inventario_clasificacion_salida
       (movimiento_inventario_clasificacion_salida_id_clasificacion_sal, movimiento_inventario_clasificacion_salida_nombre)
     OVERRIDING SYSTEM VALUE VALUES (9, 'Traslado')`);
  await db.query(
    `INSERT INTO inventario.movimiento_inventario_motivo_movimiento
       (movimiento_inventario_motivo_movimiento_id_motivo_movimiento, movimiento_inventario_motivo_movimiento_nombre,
        movimiento_inventario_clasificacion_salida_id_clasificacion_sal)
     OVERRIDING SYSTEM VALUE VALUES (9, 'traslado_bodega', 9)`);
});
after(async () => { await bajar(); await db.cerrar(); });

const trasladar = (body, rol) => api('POST', '/api/movimientos/traslado', { body, rol });
const base = (extra = {}) => ({ sku: 'MAT-FIFO', bodega_origen_id: 1, bodega_destino_id: 2, cantidad: 12, ...extra });

/** Stock físico por bodega y lote de un SKU. */
async function porBodegaYLote(sku = 'MAT-FIFO') {
  const { rows } = await db.query(
    `SELECT bodega_id_bodega::int AS bodega, lote_id_lote::int AS lote, inventario_bodega_cantidad_fisica::float AS fisica,
            inventario_bodega_cantidad_reservada::float AS reservada
     FROM inventario.inventario_bodega WHERE material_sku = $1 ORDER BY 1, 2`, [sku]);
  return rows;
}

async function movimientosTraslado() {
  const { rows } = await db.query(
    `SELECT mi.movimiento_inventario_id_movimiento::int AS id, tm.movimiento_inventario_tipo_movimiento_nombre AS tipo,
            mi.bodega_id_bodega::int AS bodega, mi.lote_id_lote::int AS lote, mi.movimiento_inventario_cantidad::float AS cant,
            mi.movimiento_inventario_motivo_movimiento_id_motivo_movimiento::int AS motivo,
            mi.movimiento_inventario_referencia_origen AS ref
     FROM inventario.movimiento_inventario mi
     JOIN inventario.movimiento_inventario_tipo_movimiento tm USING (movimiento_inventario_tipo_movimiento_id_tipo_movimiento)
     ORDER BY mi.movimiento_inventario_id_movimiento`);
  return rows;
}

describe('Traslado', () => {
  test('mueve por FIFO y el mismo lote entra en el destino; el total no cambia', async () => {
    const r = await trasladar(base(), 'jop');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.lotes, 2);

    assert.deepEqual(await porBodegaYLote(), [
      { bodega: 1, lote: 1, fisica: 0, reservada: 0 },
      { bodega: 1, lote: 2, fisica: 18, reservada: 5 },
      { bodega: 2, lote: 1, fisica: 10, reservada: 0 },    // el lote viejo conserva su identidad (y su fecha)
      { bodega: 2, lote: 2, fisica: 2, reservada: 0 },
    ]);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 5 });
    assert.deepEqual(await db.descuadresDeReservas(), []);

    const movs = await movimientosTraslado();
    assert.deepEqual(movs.map(m => [m.tipo, m.bodega, m.lote, m.cant, m.motivo]), [
      ['salida', 1, 1, 10, 9], ['entrada', 2, 1, 10, 9],
      ['salida', 1, 2, 2, 9], ['entrada', 2, 2, 2, 9],
    ]);
    assert.ok(movs.every(m => m.ref === `TRASLADO-${movs[0].id}`), 'una referencia une todo el traslado');
    assert.equal(r.body.referencia, `TRASLADO-${movs[0].id}`);
  });

  test('sumar a un lote que ya estaba en el destino no crea otra fila', async () => {
    await trasladar(base({ cantidad: 4 }));
    await trasladar(base({ cantidad: 3 }));
    const destino = (await porBodegaYLote()).filter(x => x.bodega === 2);
    assert.deepEqual(destino, [{ bodega: 2, lote: 1, fisica: 7, reservada: 0 }]);
  });

  test('lo reservado no se traslada: se puede mover hasta lo disponible y no más', async () => {
    assert.equal((await trasladar(base({ cantidad: 26 }))).status, 400);   // 30 − 5 reservadas = 25
    assert.equal(await db.contar('inventario.movimiento_inventario'), 0);
    assert.equal((await trasladar(base({ cantidad: 25 }))).status, 201);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 5 });
    assert.deepEqual(await db.descuadresDeReservas(), []);
  });

  test('rechazos antes de tocar stock: misma bodega, cantidad, bodega inactiva, producto inactivo o inexistente', async () => {
    const antes = await porBodegaYLote();
    assert.equal((await trasladar(base({ bodega_destino_id: 1 }))).status, 400);
    assert.equal((await trasladar(base({ cantidad: 0 }))).status, 400);
    assert.equal((await trasladar(base({ bodega_destino_id: 99 }))).status, 404);
    await db.query(`UPDATE inventario.bodega SET bodega_estado = 'inactivo' WHERE bodega_id_bodega = 2`);
    assert.equal((await trasladar(base())).status, 400);
    await db.query(`UPDATE inventario.bodega SET bodega_estado = 'activo' WHERE bodega_id_bodega = 2`);
    await db.query(`UPDATE inventario.material SET material_estado = 'inactivo' WHERE material_sku = 'MAT-FIFO'`);
    assert.equal((await trasladar(base())).status, 400);
    assert.equal((await trasladar(base({ sku: 'NO-EXISTE' }))).status, 404);
    assert.deepEqual(await porBodegaYLote(), antes);
    assert.equal(await db.contar('inventario.movimiento_inventario'), 0);
  });

  test('sin el motivo en el catálogo falla con un mensaje claro y no mueve nada', async () => {
    await db.query(`DELETE FROM inventario.movimiento_inventario_motivo_movimiento WHERE movimiento_inventario_motivo_movimiento_id_motivo_movimiento = 9`);
    const r = await trasladar(base());
    assert.equal(r.status, 500);
    assert.match(r.body.error, /traslado_bodega/);
    assert.equal(await db.contar('inventario.movimiento_inventario'), 0);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 5 });
  });
});

describe('Traslado: historial y reversión', () => {
  test('no cuenta como consumo y stockAFecha sigue cuadrando', async () => {
    const antes = new Date(Date.now() - 1000);
    const stockAntes = await stockAFecha(db, antes);
    await trasladar(base());
    assert.equal((await consumoNeto(db)).get('MAT-FIFO') || 0, 0);
    assert.equal((await stockAFecha(db, antes)).get('MAT-FIFO'), stockAntes.get('MAT-FIFO'), 'el pasado no cambia');
    assert.equal((await stockAFecha(db, new Date(Date.now() + 60000))).get('MAT-FIFO'), 30, 'hoy = stock real');
  });

  test('sesión 15: el Historial muestra el traslado como documento de sus dos mitades', async () => {
    const r = await trasladar(base({ cantidad: 4 }));
    const id = r.body.referencia.replace('TRASLADO-', '');
    const movs = (await api('GET', '/api/movimientos')).body;
    assert.equal(movs.length, 2);
    assert.ok(movs.every(m => m.documento_tipo === 'traslado' && m.documento_ref === id), JSON.stringify(movs.map(m => [m.documento_tipo, m.documento_ref])));
  });

  test('CU-44 no revierte ninguna mitad de un traslado', async () => {
    await trasladar(base({ cantidad: 4 }));
    const antes = await porBodegaYLote();
    for (const m of await movimientosTraslado()) {
      const r = await api('POST', `/api/movimientos/${m.id}/revertir`);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, /traslado en sentido contrario/);
    }
    assert.deepEqual(await porBodegaYLote(), antes);
  });
});
