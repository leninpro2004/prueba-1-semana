const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * Anular (y no eliminar) una OT (F-28).
 *
 * Lo que se protege: anular nunca borra (la OT queda 'cancelada'); una OT con consumo
 * vigente no se anula (el stock quedaría descuadrado) y un rechazo no cambia nada; sus
 * reservas se liberan en la misma transacción y el invariante de reservas cuadra.
 *
 * Semilla: OT 1 abierta con la reserva 1 (MAT-FIFO 5, lote 2); OT 2 finalizada; OT 3 abierta.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const anular = (id, motivo = 'Creada por error', rol) =>
  api('PUT', `/api/ordenes-trabajo/${id}/anular`, { body: motivo == null ? {} : { motivo }, rol });
const estadoOT = async (id) => (await db.query(
  `SELECT orden_trabajo_estado AS e FROM inventario.orden_trabajo WHERE orden_trabajo_id_orden = $1`, [id])).rows[0]?.e;
const consumo = (ot, lineas, extra = {}) => api('PUT', `/api/ordenes-trabajo/${ot}/consumo`, { body: { lineas, ...extra } });

describe('anular', () => {
  test('una OT sin consumo queda cancelada (no se borra) y libera sus reservas', async () => {
    const ots = await db.contar('inventario.orden_trabajo');

    const r = await anular(1);

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reservas_liberadas, 1);
    assert.equal(await estadoOT(1), 'cancelada');
    assert.equal(await db.contar('inventario.orden_trabajo'), ots);
    const { rows: [res] } = await db.query(
      `SELECT reserva_inventario_estado_reserva AS estado, reserva_inventario_motivo_liberacion AS motivo,
              usuario_id_liberacion::int AS usuario
       FROM inventario.reserva_inventario WHERE reserva_inventario_id_reserva = 1`);
    assert.deepEqual(res, { estado: 'liberada', motivo: 'OT #1 anulada: Creada por error', usuario: 1 });
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 0 });
    assert.deepEqual(await db.descuadresDeReservas(), []);
    assert.equal(await db.contar('finanzas.evento_auditoria', `accion_realizada = 'anular_ot'`), 1);
  });

  test('con consumo vigente → 409 con el detalle y nada cambia', async () => {
    assert.equal((await consumo(3, [{ sku: 'MAT-CRIT', estimado: null, real: 2 }])).status, 200);

    const r = await anular(3);

    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'OT_CON_CONSUMO');
    assert.deepEqual(r.body.consumos.map(c => [c.sku, c.real]), [['MAT-CRIT', 2]]);
    assert.equal(await estadoOT(3), 'en_curso');
    assert.deepEqual(await db.stockDe('MAT-CRIT'), { fisica: 6, reservada: 0 });
  });

  test('tras devolver el consumo (real 0, con motivo) sí se anula, y el historial queda', async () => {
    await consumo(3, [{ sku: 'MAT-CRIT', estimado: null, real: 2 }]);
    const d = await consumo(3, [{ sku: 'MAT-CRIT', estimado: null, real: 0, motivo: 'OT creada por error' }]);
    assert.equal(d.status, 200, JSON.stringify(d.body));

    const r = await anular(3);

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await estadoOT(3), 'cancelada');
    assert.deepEqual(await db.stockDe('MAT-CRIT'), { fisica: 8, reservada: 0 });
    assert.equal(await db.contar('inventario.movimiento_inventario', 'orden_trabajo_id_orden = 3'), 2);
  });

  test('con pinturas en el Seguimiento → 409', async () => {
    await db.query(
      `INSERT INTO inventario.seguimiento_pintura (material_sku, orden_trabajo_id_orden, peso_entrada_gr, estado)
       VALUES ('PIN-TEST', 3, 2000, 'abierto')`);
    const r = await anular(3);
    assert.equal(r.status, 409);
    assert.equal(r.body.pinturas, 1);
    assert.equal(await estadoOT(3), 'en_curso');
  });
});

describe('rechazos', () => {
  test('sin motivo → 400', async () => {
    assert.equal((await anular(1, null)).status, 400);
    assert.equal((await anular(1, '   ')).status, 400);
    assert.equal(await estadoOT(1), 'en_curso');
  });

  test('una OT finalizada o ya cancelada no se anula', async () => {
    assert.equal((await anular(2)).status, 400);                  // finalizada
    assert.equal((await anular(1)).status, 200);
    assert.equal((await anular(1)).status, 400);                  // ya cancelada
    assert.equal((await anular(99)).status, 404);
  });

  test('gerencia y jop anulan; técnico no', async () => {
    assert.equal((await anular(1, 'x', 'tecnico')).status, 403);
    assert.equal(await estadoOT(1), 'en_curso');
    assert.equal((await anular(1, 'x', 'jop')).status, 200);
  });
});

test('una OT cancelada no admite consumo', async () => {
  await anular(3);
  assert.equal((await consumo(3, [{ sku: 'MAT-CRIT', estimado: null, real: 1 }])).status, 400);
});
