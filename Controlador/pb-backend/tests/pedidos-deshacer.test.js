const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * D51: deshacer un pedido de instalación y cancelar el de una venta cancelada.
 *
 * Lo que protegen:
 *  - "Devolver a bodega" deja el retiro de un insumo en 0 sin mover stock ni reservas.
 *  - "Volver a vinculado" (solo gerencia, con motivo) exige que no quede nada retirado; desde ahí la
 *    vinculación se puede modificar y el pedido se vuelve a preparar, retirar y cargar desde cero
 *    (responsables y trazabilidad empiezan de nuevo, el historial se conserva).
 *  - Un pedido en tránsito no se deshace (D63).
 *  - "Cancelar" (solo gerencia) exige la venta cancelada y el pedido vinculado; libera TODAS las reservas
 *    activas de la venta (pedido y CU-131) con usuario y motivo, cierra las alertas de su retiro y deja el
 *    pedido "cancelado". El invariante de reservas se mantiene en cada paso.
 *
 * Semilla: MAT-FIFO en la bodega 1 (lote 1: 10 libres, lote 2: 20 con 5 reservadas por la OT 1),
 * PIN-TEST 20 kg, MAT-CRIT 8. Empleado activo 22222222-2.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => {
  await db.resetear();
  await db.query(`INSERT INTO finanzas.tipo_cliente (id_tipo_cliente, nombre_tipo_cliente) OVERRIDING SYSTEM VALUE VALUES (1, 'empresa')`);
  await db.query(`INSERT INTO finanzas.cliente_financiero (id_cliente_financiero, rut_cliente, id_tipo_cliente, nombre_razon_social)
                  OVERRIDING SYSTEM VALUE VALUES (1, '11111111-1', 1, 'Cliente de prueba')`);
  await db.query(`INSERT INTO finanzas.nota_venta (id_nota_venta, numero_nota_venta, id_cliente_financiero, fecha_emision, estado_pedido)
                  OVERRIDING SYSTEM VALUE VALUES (1, 'NV-A', 1, CURRENT_DATE, 'aprobada')`);
  // Una línea de material suelto, para las reservas de CU-131
  await db.query(`INSERT INTO finanzas.item_nota_venta (id_nota_venta, sku_material, descripcion_item, cantidad, precio_unitario)
                  VALUES (1, 'MAT-CRIT', 'material suelto', 2, 1000)`);
});
after(async () => { await bajar(); await db.cerrar(); });

const EMPLEADO = '22222222-2';
const completa = { lineas: [{ sku: 'MAT-FIFO', cantidad: 4, bodega_id: 1 }, { sku: 'PIN-TEST', cantidad: 1, bodega_id: 1 }] };
const vincular = (body = completa) => api('PUT', '/api/pedidos-venta/1/vinculacion', { body });
const preparar = () => api('PUT', '/api/pedidos-venta/1/preparado');
const retirar = (sku, cantidad) => api('PUT', `/api/pedidos-venta/1/retiro/${sku}`, { body: { cantidad } });
const cargar = (body = { empleado_rut: EMPLEADO }) => api('POST', '/api/pedidos-venta/1/carga', { body });
const devolver = (sku, rol) => api('PUT', `/api/pedidos-venta/1/devolucion/${sku}`, { rol });
const deshacer = (motivo = 'El cliente cambió la fecha de instalación', rol) =>
  api('PUT', '/api/pedidos-venta/1/deshacer-preparado', { body: { motivo }, rol });
const cancelar = (motivo, rol) => api('PUT', '/api/pedidos-venta/1/cancelar', { body: { motivo }, rol });
const ventaCancelada = () => db.query(`UPDATE finanzas.nota_venta SET estado_pedido = 'cancelada' WHERE id_nota_venta = 1`);

async function estados() {
  const { rows } = await db.query(
    `SELECT e.preparacion_pedido_estado_nombre_estado AS estado
     FROM inventario.preparacion_pedido_estado e JOIN inventario.preparacion_pedido p USING (preparacion_pedido_id_preparacion)
     WHERE p.nota_venta_id_nota_venta = 1 ORDER BY e.preparacion_pedido_estado_id_estado_preparacion`);
  return rows.map(r => r.estado);
}
async function retiradas() {
  const { rows } = await db.query(
    `SELECT material_sku AS sku, preparacion_pedido_detalle_cantidad_retirada::float AS retirada
     FROM inventario.preparacion_pedido_detalle ORDER BY 1`);
  return Object.fromEntries(rows.map(r => [r.sku, r.retirada]));
}

describe('Devolver a bodega y volver a vinculado', () => {
  test('con material retirado no se deshace; devuelto, vuelve a vinculado sin tocar stock ni reservas', async () => {
    await vincular(); await preparar();
    await retirar('MAT-FIFO', 4);
    const stock = await db.stockDe('MAT-FIFO');

    const r1 = await deshacer();
    assert.equal(r1.status, 400);
    assert.equal(r1.body.codigo, 'RETIRO_SIN_DEVOLVER');

    const r2 = await devolver('MAT-FIFO', 'jop');
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.deepEqual(await retiradas(), { 'MAT-FIFO': null, 'PIN-TEST': null });

    const r3 = await deshacer();
    assert.equal(r3.status, 200, JSON.stringify(r3.body));
    assert.deepEqual(await estados(), ['vinculado', 'preparado', 'vinculado']);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), stock);
    assert.deepEqual(await db.descuadresDeReservas(), []);

    // De nuevo vinculado: se modifica la vinculación y se vuelve a preparar
    const d = (await api('GET', '/api/pedidos-venta/1')).body;
    assert.equal(d.editable, true);
    assert.equal((await vincular({ lineas: [{ sku: 'MAT-FIFO', cantidad: 2, bodega_id: 1 }] })).status, 200);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 7 });
    assert.equal((await preparar()).status, 200);
    assert.deepEqual(await db.descuadresDeReservas(), []);
  });

  test('desde "en carga": la carga y la trazabilidad empiezan de nuevo; el mismo responsable se puede volver a registrar', async () => {
    await vincular(); await preparar();
    await retirar('MAT-FIFO', 4); await retirar('PIN-TEST', 1);
    assert.equal((await cargar()).status, 201);

    await devolver('MAT-FIFO'); await devolver('PIN-TEST');
    assert.equal((await deshacer()).status, 200);

    const d = (await api('GET', '/api/pedidos-venta/1')).body;
    assert.equal(d.venta.estado_despacho, 'vinculado');
    assert.deepEqual(d.responsables_carga, []);
    const traza = (await api('GET', '/api/pedidos-venta/trazabilidad?q=NV-A')).body;
    const etapas = Object.fromEntries(traza.pedidos[0].insumos[0].etapas.map(e => [e.clave, e.estado]));
    assert.equal(etapas.preparacion, 'pendiente');
    assert.equal(etapas.retiro, 'pendiente');
    assert.equal(etapas.carga, 'pendiente');

    await preparar(); await retirar('MAT-FIFO', 4); await retirar('PIN-TEST', 1);
    const r = await cargar();
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await api('GET', '/api/pedidos-venta/1')).body.responsables_carga.length, 1);
  });

  test('rechazos de la devolución: pedido sin retiro posible, insumo sin retiro o ajeno', async () => {
    await vincular();
    assert.equal((await devolver('MAT-FIFO')).status, 400);          // vinculado
    await preparar();
    assert.equal((await devolver('MAT-FIFO')).status, 400);          // nada retirado
    assert.equal((await devolver('MAT-CRIT')).status, 404);          // no es del pedido
  });

  test('rechazos de volver a vinculado: sin motivo, ya vinculado, despachado y rol jop', async () => {
    await vincular();
    assert.equal((await deshacer('')).status, 400);
    assert.equal((await deshacer()).status, 409);                    // ya está vinculado
    await preparar();
    assert.equal((await deshacer(undefined, 'jop')).status, 403);
    await retirar('MAT-FIFO', 4); await retirar('PIN-TEST', 1);
    await cargar();
    assert.equal((await api('PUT', '/api/pedidos-venta/1/salida', { body: {} })).status, 200);
    const r = await deshacer();
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'PEDIDO_DESPACHADO');
    assert.deepEqual(await estados(), ['vinculado', 'preparado', 'en_carga', 'en_transito']);
  });
});

describe('Cancelar el pedido de una venta cancelada', () => {
  test('libera todas las reservas de la venta (pedido y CU-131) con usuario y motivo, y queda "cancelado"', async () => {
    await vincular();
    assert.equal((await api('POST', '/api/reservas/ventas/1', { body: {} })).status, 201);   // MAT-CRIT 2
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 9 });
    assert.deepEqual(await db.stockDe('MAT-CRIT'), { fisica: 8, reservada: 2 });

    assert.equal((await cancelar()).body.codigo, 'VENTA_NO_CANCELADA');   // todavía aprobada
    await ventaCancelada();
    assert.equal((await cancelar(undefined, 'jop')).status, 403);
    const r = await cancelar('El cliente desistió');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.liberadas, 3);

    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 5 });   // queda la de la OT
    assert.deepEqual(await db.stockDe('MAT-CRIT'), { fisica: 8, reservada: 0 });
    assert.deepEqual(await db.descuadresDeReservas(), []);
    const { rows } = await db.query(
      `SELECT DISTINCT reserva_inventario_estado_reserva AS estado, usuario_id_liberacion::int AS usuario,
              reserva_inventario_motivo_liberacion AS motivo
       FROM inventario.reserva_inventario WHERE nota_venta_id_nota_venta = 1`);
    assert.deepEqual(rows, [{ estado: 'liberada', usuario: 1, motivo: 'El cliente desistió' }]);
    assert.deepEqual(await estados(), ['vinculado', 'cancelado']);
    assert.equal((await cancelar()).status, 409);                     // ya cancelado
    assert.equal((await vincular()).status, 400);                     // venta cancelada: no se vincula
  });

  test('un pedido preparado primero se devuelve y se deshace; las alertas de su retiro se cierran', async () => {
    await vincular(); await preparar();
    await retirar('MAT-FIFO', 2);                                     // parcial: alerta "faltante en retiro"
    await ventaCancelada();
    const r1 = await cancelar();
    assert.equal(r1.status, 409);
    assert.equal(r1.body.codigo, 'PEDIDO_AVANZADO');

    await devolver('MAT-FIFO');
    assert.equal((await deshacer('Venta cancelada')).status, 200);
    assert.equal((await cancelar()).status, 200);
    const { rows } = await db.query(
      `SELECT a.alerta_inventario_estado AS estado FROM inventario.alerta_inventario a
       JOIN inventario.alerta_inventario_tipo_alerta t USING (alerta_inventario_tipo_alerta_id_tipo_alerta)
       WHERE t.alerta_inventario_tipo_alerta_nombre = 'faltante en retiro'`);
    assert.deepEqual(rows, [{ estado: 'resuelta' }]);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 5 });
    assert.deepEqual(await db.descuadresDeReservas(), []);
  });
});
