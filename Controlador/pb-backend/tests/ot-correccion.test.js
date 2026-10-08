const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * D54: corrección del consumo de una OT cerrada (solo gerencia, con motivo).
 *
 * Lo que protegen:
 *  - El stock se mueve por la DIFERENCIA con lo registrado (subir = FIFO, bajar = devolución), con los movimientos
 *    ligados a la OT; la OT sigue cerrada y el estimado no cambia.
 *  - Se puede agregar un material no registrado; las pinturas no se corrigen aquí.
 *  - Un rechazo no mueve stock (falta de stock, inactivo, pintura, sin motivo, OT abierta, otro rol).
 *  - Si la OT tenía diferenciales procesados (CU-103), se recalculan.
 *
 * Semilla: OT 3 abierta (área 1). Bodega 1: MAT-FIFO 30 (5 reservadas), MAT-UNO 1, MAT-CRIT 8, PIN-TEST 20 kg.
 * Cada test registra el consumo de la OT 3 (MAT-FIFO 4, MAT-UNO 1), la finaliza y procesa sus diferenciales.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => {
  await db.resetear();
  const g = await api('PUT', '/api/ordenes-trabajo/3/consumo', {
    body: { lineas: [{ sku: 'MAT-FIFO', estimado: 4, real: 4 }, { sku: 'MAT-UNO', estimado: 1, real: 1 }] },
  });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal((await api('PUT', '/api/ordenes-trabajo/3/finalizar')).status, 200);
  assert.equal((await api('POST', '/api/ordenes-trabajo/3/diferenciales')).status, 200);
});
after(async () => { await bajar(); await db.cerrar(); });

const MOTIVO = 'Se registró mal la cantidad usada';
const corregir = (lineas, motivo = MOTIVO, rol, ot = 3) =>
  api('PUT', `/api/ordenes-trabajo/${ot}/correccion`, { body: { lineas, motivo }, rol });

async function consumos(ot = 3) {
  const { rows } = await db.query(
    `SELECT material_sku AS sku, material_orden_trabajo_consumo_estimado::float AS est, material_orden_trabajo_consumo_real::float AS real
     FROM inventario.material_orden_trabajo WHERE orden_trabajo_id_orden = $1 ORDER BY 1`, [ot]);
  return rows;
}
async function estadoOT(ot = 3) {
  return (await db.query(`SELECT orden_trabajo_estado AS e FROM inventario.orden_trabajo WHERE orden_trabajo_id_orden = $1`, [ot])).rows[0].e;
}

describe('Corregir una OT cerrada', () => {
  test('sube y baja el real moviendo el stock por la diferencia; la OT sigue cerrada y el estimado igual', async () => {
    const r = await corregir([{ sku: 'MAT-FIFO', real: 6 }, { sku: 'MAT-UNO', real: 0 }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.diferenciales_recalculados, true);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 24, reservada: 5 });   // 30 − 4 − 2
    assert.deepEqual(await db.stockDe('MAT-UNO'), { fisica: 1, reservada: 0 });     // vuelve la unidad
    assert.deepEqual(await consumos(), [{ sku: 'MAT-FIFO', est: 4, real: 6 }, { sku: 'MAT-UNO', est: 1, real: 0 }]);
    assert.equal(await estadoOT(), 'finalizada');

    const { rows: movs } = await db.query(
      `SELECT material_sku AS sku, movimiento_inventario_cantidad::float AS cant, movimiento_inventario_descripcion_motivo AS d
       FROM inventario.movimiento_inventario WHERE orden_trabajo_id_orden = 3 AND movimiento_inventario_descripcion_motivo LIKE 'Corrección%'
       ORDER BY 1`);
    assert.deepEqual(movs.map(m => [m.sku, m.cant]), [['MAT-FIFO', 2], ['MAT-UNO', 1]]);
    assert.ok(movs.every(m => m.d.includes(MOTIVO)));

    // CU-103: los diferenciales quedaron con el real corregido
    const { rows: dif } = await db.query(
      `SELECT material_sku AS sku, diferencial_consumo_real::float AS real, diferencial_consumo_tipo AS tipo
       FROM inventario.diferencial_consumo WHERE orden_trabajo_id_orden = 3 ORDER BY 1`);
    assert.deepEqual(dif, [{ sku: 'MAT-FIFO', real: 6, tipo: 'sobre_gasto' }, { sku: 'MAT-UNO', real: 0, tipo: 'ahorro' }]);
  });

  test('agrega un material que se usó y no se registró (sin estimado)', async () => {
    const r = await corregir([{ sku: 'MAT-CRIT', real: 2 }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await db.stockDe('MAT-CRIT'), { fisica: 6, reservada: 0 });
    assert.deepEqual((await consumos()).find(c => c.sku === 'MAT-CRIT'), { sku: 'MAT-CRIT', est: null, real: 2 });
  });
});

describe('Rechazos: no se mueve nada', () => {
  test('sin stock suficiente no se guarda ninguna línea', async () => {
    const antes = await db.contar('inventario.movimiento_inventario');
    const r = await corregir([{ sku: 'MAT-FIFO', real: 5 }, { sku: 'MAT-UNO', real: 5 }]);   // MAT-UNO no tiene 4 más
    assert.equal(r.status, 400);
    assert.equal(await db.contar('inventario.movimiento_inventario'), antes);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 26, reservada: 5 });
    assert.deepEqual(await consumos(), [{ sku: 'MAT-FIFO', est: 4, real: 4 }, { sku: 'MAT-UNO', est: 1, real: 1 }]);
  });

  test('sin motivo, OT abierta, otro rol, pintura, material inactivo o sin cambios', async () => {
    assert.equal((await corregir([{ sku: 'MAT-FIFO', real: 5 }], '')).status, 400);
    assert.match((await corregir([{ sku: 'MAT-FIFO', real: 5 }], MOTIVO, undefined, 1)).body.error, /está abierta/);
    assert.equal((await corregir([{ sku: 'MAT-FIFO', real: 5 }], MOTIVO, 'jop')).status, 403);
    assert.match((await corregir([{ sku: 'PIN-TEST', real: 1 }])).body.error, /Seguimiento de pinturas/);
    await db.query(`UPDATE inventario.material SET material_estado = 'inactivo' WHERE material_sku = 'MAT-UNO'`);
    assert.match((await corregir([{ sku: 'MAT-UNO', real: 0 }])).body.error, /inactivo/);
    assert.match((await corregir([{ sku: 'MAT-FIFO', real: 4 }])).body.error, /No hay cambios/);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 26, reservada: 5 });
  });
});
