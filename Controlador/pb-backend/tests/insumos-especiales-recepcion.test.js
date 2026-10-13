const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');
const { compra } = require('./helpers/compra');   // D66: una compra lleva proveedor, precio, pedido y factura

/**
 * CU-124: vincular la recepción de un insumo especial a la venta que lo espera.
 *
 * Invariantes: reservas activas == stock reservado (descuadresDeReservas); la
 * reserva cae en el LOTE recibido y al liberarla vuelve ese mismo lote; un
 * rechazo (exceso) no mueve stock; recibir un insumo especial no "resuelve" sus
 * alertas por stock (solo se cierran al vincularlas).
 *
 * PIN-TEST (especial) tiene 20 kg en el lote 5, bodega 1. Venta 1 (entrega 30/10)
 * pide 3 kg; venta 2 (entrega 15/10) pide 4 kg. MAT-UNO es especial sin ventas.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => {
  await db.resetear();
  await db.query(`UPDATE inventario.material SET material_es_rotativo = FALSE, material_stock_minimo = NULL, material_stock_critico = NULL
                  WHERE material_sku IN ('PIN-TEST', 'MAT-UNO')`);
  await db.query(`INSERT INTO finanzas.tipo_cliente (id_tipo_cliente, nombre_tipo_cliente) OVERRIDING SYSTEM VALUE VALUES (1, 'empresa')`);
  await db.query(`INSERT INTO finanzas.cliente_financiero (id_cliente_financiero, rut_cliente, id_tipo_cliente, nombre_razon_social)
                  OVERRIDING SYSTEM VALUE VALUES (1, '11111111-1', 1, 'Cliente de prueba')`);
  await db.query(`INSERT INTO finanzas.nota_venta (id_nota_venta, numero_nota_venta, id_cliente_financiero, fecha_emision,
                    fecha_max_entrega, estado_pedido)
                  OVERRIDING SYSTEM VALUE VALUES (1, 'NV-T1', 1, CURRENT_DATE - 2, DATE '2026-10-30', 'aprobada'),
                                                (2, 'NV-T2', 1, CURRENT_DATE - 1, DATE '2026-10-15', 'aprobada')`);
  await db.query(`INSERT INTO finanzas.item_nota_venta (id_nota_venta, sku_material, descripcion_item, cantidad, precio_unitario)
                  VALUES (1, 'PIN-TEST', 'pintura', 3, 1000), (2, 'PIN-TEST', 'pintura', 4, 1000)`);
  const r = await api('POST', '/api/alertas-faltantes/insumos-especiales/revisar');
  assert.equal(r.body.nuevas, 2, JSON.stringify(r.body));
});
after(async () => { await bajar(); await db.cerrar(); });

const alerta = async (venta) => (await db.query(
  `SELECT alerta_faltante_pedido_id_alerta_faltante::int AS id, alerta_faltante_pedido_estado AS estado
   FROM inventario.alerta_faltante_pedido WHERE nota_venta_id_nota_venta = $1`, [venta])).rows[0];
const reservadoEn = async (lote) => parseFloat((await db.query(
  `SELECT COALESCE(SUM(inventario_bodega_cantidad_reservada), 0) AS r FROM inventario.inventario_bodega
   WHERE material_sku = 'PIN-TEST' AND lote_id_lote = $1`, [lote])).rows[0].r);
const entrada = (sku, cantidad) => api('POST', '/api/movimientos/entrada',
  { body: { sku, bodega_id: 1, cantidad, tipo_movimiento_id: 1, ...compra() } });
const vincular = (body, rol) => api('POST', '/api/alertas-faltantes/insumos-especiales/vincular', { body, rol });

describe('Recepción de un insumo especial (CU-124)', () => {
  test('la entrada muestra las ventas que lo esperan, por fecha límite, y no resuelve sus alertas', async () => {
    const r = await entrada('PIN-TEST', 5);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.insumo_especial.pendientes.map(p => [p.venta, p.pendiente]), [['NV-T2', 4], ['NV-T1', 3]]);
    assert.equal((await alerta(1)).estado, 'activa', 'hay 25 kg, pero la alerta no se cierra sola');
    assert.equal((await alerta(2)).estado, 'activa');
  });

  test('vincular reserva en el lote recibido: total → disponible, parcial → sigue abierta (Exc 2, Exc 3)', async () => {
    const e = await entrada('PIN-TEST', 5);
    const [a1, a2] = [await alerta(1), await alerta(2)];
    const r = await vincular({ movimiento_id: e.body.movimiento_id,
      asignaciones: [{ alerta_id: a2.id, cantidad: 4 }, { alerta_id: a1.id, cantidad: 1 }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await reservadoEn(e.body.lote_id), 5);
    assert.equal(await reservadoEn(5), 0, 'el lote antiguo no se toca');
    assert.deepEqual(await db.descuadresDeReservas(), []);
    const { rows } = await db.query(`SELECT lote_id_lote::int AS lote, bodega_id_bodega::int AS bodega, nota_venta_id_nota_venta::int AS venta,
                                            usuario_id_usuario::int AS usuario
                                     FROM inventario.reserva_inventario WHERE material_sku = 'PIN-TEST' ORDER BY venta`);
    assert.deepEqual(rows, [{ lote: Number(e.body.lote_id), bodega: 1, venta: 1, usuario: 1 },
                            { lote: Number(e.body.lote_id), bodega: 1, venta: 2, usuario: 1 }]);
    assert.equal((await alerta(2)).estado, 'disponible');
    assert.equal((await alerta(1)).estado, 'activa');
    const lista = await api('GET', '/api/alertas-faltantes/insumos-especiales');
    const v1 = lista.body.alertas.find(a => a.venta === 'NV-T1');
    assert.deepEqual([v1.vinculado, v1.pendiente, v1.en_espera_recepcion], [1, 2, true]);
    assert.equal((await api('POST', '/api/alertas-faltantes/insumos-especiales/revisar')).body.nuevas, 0, 'no se recrea');
  });

  test('asignar más de lo recibido o más de lo pendiente se rechaza sin mover stock', async () => {
    const e = await entrada('PIN-TEST', 5);
    const [a1, a2] = [await alerta(1), await alerta(2)];
    const exceso = await vincular({ movimiento_id: e.body.movimiento_id,
      asignaciones: [{ alerta_id: a2.id, cantidad: 4 }, { alerta_id: a1.id, cantidad: 3 }] });
    assert.equal(exceso.status, 409);
    const demasiado = await vincular({ movimiento_id: e.body.movimiento_id, asignaciones: [{ alerta_id: a1.id, cantidad: 4 }] });
    assert.equal(demasiado.status, 400);
    assert.equal(await reservadoEn(e.body.lote_id), 0);
    assert.equal(await db.contar('inventario.reserva_inventario', "material_sku = 'PIN-TEST'"), 0);
    assert.equal((await alerta(1)).estado, 'activa');
  });

  test('vincular después desde un lote con stock libre; liberar devuelve ese mismo lote', async () => {
    const e = await entrada('PIN-TEST', 5);          // lote nuevo, más reciente que el 5
    const [a1, a2] = [await alerta(1), await alerta(2)];
    const lotes = await api('GET', `/api/alertas-faltantes/insumos-especiales/${a1.id}/lotes`);
    assert.equal(lotes.status, 200);
    assert.ok(lotes.body.lotes.some(l => Number(l.lote_id) === 5 && l.libre === 20));
    assert.equal(lotes.body.venta.pendiente, 3);
    assert.equal((await vincular({ lote_id: 5, bodega_id: 1, asignaciones: [{ alerta_id: a1.id, cantidad: 3 }] }, 'jop')).status, 200);
    assert.equal((await vincular({ movimiento_id: e.body.movimiento_id, asignaciones: [{ alerta_id: a2.id, cantidad: 4 }] })).status, 200);

    const { rows } = await db.query(`SELECT reserva_inventario_id_reserva AS id FROM inventario.reserva_inventario WHERE nota_venta_id_nota_venta = 1`);
    const lib = await api('PUT', `/api/reservas/${rows[0].id}/liberar`);
    assert.equal(lib.status, 200, JSON.stringify(lib.body));
    assert.equal(await reservadoEn(5), 0, 'se libera el lote de la reserva');
    assert.equal(await reservadoEn(e.body.lote_id), 4, 'y no el más nuevo');
    assert.deepEqual(await db.descuadresDeReservas(), []);
  });

  test('Exc 1: sin ventas que lo esperen queda en stock transitorio y se avisa a gerencia', async () => {
    const r = await entrada('MAT-UNO', 2);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.insumo_especial.pendientes, []);
    assert.match(r.body.insumo_especial.mensaje, /stock transitorio/);
    assert.equal(await db.contar('inventario.notificacion',
      // B-06: el origen ahora guarda la ruta, la misma del aviso de ventas: se distingue por el mensaje
      "notificacion_mensaje ILIKE '%stock transitorio%' AND notificacion_tipo_notificacion = 'insumo_especial' AND usuario_id_usuario = 1"), 1);
  });

  test('la entrada de un material rotativo no trae nada de insumos especiales', async () => {
    const r = await entrada('MAT-FIFO', 1);
    assert.equal(r.status, 201);
    assert.equal(r.body.insumo_especial, undefined);
  });
});
