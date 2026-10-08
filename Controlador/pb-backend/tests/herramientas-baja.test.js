const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * D52: cerrar una asignación de herramienta como "perdida" o "dada de baja" la saca del
 * inventario: salida por merma (motivo propio), con evidencia, en una transacción.
 * "Devuelta" no mueve stock. Un rechazo no toca nada.
 *
 * Semilla: MAT-HERR (herramienta), 3 unidades en la bodega 1 (lote 4). Los motivos se
 * agregan aquí (la semilla no los trae), colgados de la clasificación 2 (perdida/merma).
 */

before(async () => { await db.resetear(); });
beforeEach(async () => {
  await db.resetear();
  await db.query(
    `INSERT INTO inventario.movimiento_inventario_motivo_movimiento
       (movimiento_inventario_motivo_movimiento_id_motivo_movimiento, movimiento_inventario_motivo_movimiento_nombre,
        movimiento_inventario_clasificacion_salida_id_clasificacion_sal)
     OVERRIDING SYSTEM VALUE VALUES (10, 'perdida_herramienta', 2), (11, 'baja_herramienta', 2)`);
});
after(async () => { await bajar(); await db.cerrar(); });

const EVIDENCIA = 'https://drive.test/foto-perdida.jpg';

async function asignar(cantidad = 1) {
  const r = await api('POST', '/api/herramientas/MAT-HERR/asignar', { body: { empleado_rut: '22222222-2', cantidad } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.asignacion.id;
}
const cerrar = (id, body) => api('PUT', `/api/herramientas/asignaciones/${id}/devolver`, { body });

async function salidas() {
  const { rows } = await db.query(
    `SELECT mi.movimiento_inventario_cantidad::float AS cant, mot.movimiento_inventario_motivo_movimiento_nombre AS motivo,
            mi.movimiento_inventario_evidencia_url AS evidencia, mi.movimiento_inventario_referencia_origen AS ref
     FROM inventario.movimiento_inventario mi
     JOIN inventario.movimiento_inventario_motivo_movimiento mot USING (movimiento_inventario_motivo_movimiento_id_motivo_movimiento)
     ORDER BY mi.movimiento_inventario_id_movimiento`);
  return rows;
}

test('perdida: descuenta el stock con una salida por merma, con evidencia y la referencia de la asignación', async () => {
  const id = await asignar(2);
  const r = await cerrar(id, { estado: 'perdida', evidencia_url: EVIDENCIA, observacion: 'se perdió en obra' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await db.stockDe('MAT-HERR')).fisica, 1);
  assert.deepEqual(await salidas(), [{ cant: 2, motivo: 'perdida_herramienta', evidencia: EVIDENCIA, ref: `ASIG-${id}` }]);
  const { rows } = await db.query(`SELECT estado FROM inventario.asignacion_herramienta WHERE asignacion_id = $1`, [id]);
  assert.equal(rows[0].estado, 'perdida');
});

test('dada de baja: igual, con su propio motivo', async () => {
  const id = await asignar(1);
  assert.equal((await cerrar(id, { estado: 'dada_de_baja', evidencia_url: EVIDENCIA })).status, 200);
  assert.equal((await db.stockDe('MAT-HERR')).fisica, 2);
  assert.equal((await salidas())[0].motivo, 'baja_herramienta');
});

test('devuelta no mueve stock', async () => {
  const id = await asignar(1);
  assert.equal((await cerrar(id, { estado: 'devuelta' })).status, 200);
  assert.equal((await db.stockDe('MAT-HERR')).fisica, 3);
  assert.deepEqual(await salidas(), []);
});

test('rechazos sin tocar nada: sin evidencia, evidencia inválida, o cerrar dos veces', async () => {
  const id = await asignar(1);
  assert.equal((await cerrar(id, { estado: 'perdida' })).status, 400);
  assert.equal((await cerrar(id, { estado: 'perdida', evidencia_url: 'no-es-url' })).status, 400);
  assert.equal((await db.stockDe('MAT-HERR')).fisica, 3);
  const { rows } = await db.query(`SELECT estado FROM inventario.asignacion_herramienta WHERE asignacion_id = $1`, [id]);
  assert.equal(rows[0].estado, 'asignada', 'la asignación sigue abierta');

  assert.equal((await cerrar(id, { estado: 'perdida', evidencia_url: EVIDENCIA })).status, 200);
  assert.equal((await cerrar(id, { estado: 'perdida', evidencia_url: EVIDENCIA })).status, 400, 'ya cerrada');
  assert.equal((await salidas()).length, 1);
});

test('con stock en varias bodegas pide elegir (con nombre) y luego descuenta de la elegida', async () => {
  await db.query(`INSERT INTO inventario.inventario_bodega (material_sku, lote_id_lote, bodega_id_bodega,
                    inventario_bodega_cantidad_fisica, inventario_bodega_cantidad_reservada) VALUES ('MAT-HERR', 4, 2, 2, 0)`);
  const id = await asignar(1);
  const r = await cerrar(id, { estado: 'perdida', evidencia_url: EVIDENCIA });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.bodegas.map(b => [b.bodega_id * 1, b.nombre]).sort(), [[1, 'Bodega Test'], [2, 'Bodega Secundaria']]);
  assert.equal((await cerrar(id, { estado: 'perdida', evidencia_url: EVIDENCIA, bodega_id: 2 })).status, 200);
  const { rows } = await db.query(
    `SELECT bodega_id_bodega::int AS b, inventario_bodega_cantidad_fisica::float AS f FROM inventario.inventario_bodega
     WHERE material_sku = 'MAT-HERR' ORDER BY 1`);
  assert.deepEqual(rows, [{ b: 1, f: 3 }, { b: 2, f: 1 }]);
});
