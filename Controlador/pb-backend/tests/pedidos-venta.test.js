const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar, autorizacion } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * CU-120: vincular insumos de instalación a una venta (D44).
 *
 * Lo que protegen:
 *  - Se sugieren solo los insumos del área Instalación de las recetas de las puertas que
 *    requieren instalación, multiplicados por la cantidad vendida.
 *  - Vincular reserva por FIFO en la bodega elegida, una reserva por lote, y el invariante
 *    de reservas se mantiene (descuadresDeReservas vacío). D58: si esa bodega (la principal)
 *    no alcanza, el resto se reserva en las demás bodegas activas.
 *  - Exc 2: sin stock suficiente se reserva lo que hay y queda el faltante.
 *  - Exc 3: modificar ajusta por la DIFERENCIA (liberando primero el lote más nuevo).
 *  - Un rechazo no reserva nada.
 *
 * Semilla: MAT-FIFO en la bodega 1: lote 1 (viejo) 10 libres, lote 2 (nuevo) 20 con 5
 * reservadas. MAT-UNO 1. PIN-TEST 20 kg. Área 3 = Instalación. Bodega 2 vacía.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => {
  await db.resetear();
  // Insumos de instalación de PB-TEST (receta 1): MAT-UNO 1 y PIN-TEST 0,5 por puerta
  await db.query(`INSERT INTO inventario.material_producto_terminado (material_sku, producto_terminado_id_producto,
                    material_producto_terminado_cantidad_estimada, material_producto_terminado_merma_estimada, area_trabajo_id_area)
                  VALUES ('MAT-UNO', 1, 1, 0, 3), ('PIN-TEST', 1, 0.5, 0, 3)`);
  await db.query(`INSERT INTO finanzas.tipo_cliente (id_tipo_cliente, nombre_tipo_cliente) OVERRIDING SYSTEM VALUE VALUES (1, 'empresa')`);
  await db.query(`INSERT INTO finanzas.cliente_financiero (id_cliente_financiero, rut_cliente, id_tipo_cliente, nombre_razon_social)
                  OVERRIDING SYSTEM VALUE VALUES (1, '11111111-1', 1, 'Cliente de prueba')`);
  await db.query(`INSERT INTO finanzas.nota_venta (id_nota_venta, numero_nota_venta, id_cliente_financiero, fecha_emision, estado_pedido)
                  OVERRIDING SYSTEM VALUE VALUES
                    (1, 'NV-A', 1, CURRENT_DATE, 'aprobada'),
                    (2, 'NV-P', 1, CURRENT_DATE, 'pendiente'),
                    (3, 'NV-E', 1, CURRENT_DATE, 'en_proceso'),
                    (4, 'NV-C', 1, CURRENT_DATE, 'cancelada')`);
  await linea(1, { puerta: 1, cantidad: 2, instalacion: true });   // 2 puertas PB-TEST con instalación
  await linea(1, { puerta: 1, cantidad: 3, instalacion: false });  // sin instalación: no suma
  await linea(1, { cantidad: 2 });                                  // servicio
  await linea(2, { puerta: 1, cantidad: 1, instalacion: true });
  await linea(3, { sku: 'MAT-UNO', cantidad: 1 });                  // sin puertas: Exc 1
  await linea(4, { puerta: 1, cantidad: 1, instalacion: true });
});
after(async () => { await bajar(); await db.cerrar(); });

async function linea(venta, { sku = null, puerta = null, cantidad, instalacion = false }) {
  await db.query(
    `INSERT INTO finanzas.item_nota_venta (id_nota_venta, id_producto_terminado, sku_material, descripcion_item,
       cantidad, precio_unitario, requiere_instalacion) VALUES ($1, $2, $3, 'línea de prueba', $4, 1000, $5)`,
    [venta, puerta, sku, cantidad, instalacion]);
}

const vincular = (venta, body, rol) => api('PUT', `/api/pedidos-venta/${venta}/vinculacion`, { body, rol });
/** Los insumos de la receta en la bodega 1, más `extra` (bodega 1 si no se indica). D45: bodega por insumo. */
const receta = (extra = []) => ({
  lineas: [{ sku: 'MAT-UNO', cantidad: 2, origen: 'receta' }, { sku: 'PIN-TEST', cantidad: 1, origen: 'receta' }, ...extra]
    .map(l => ({ bodega_id: 1, ...l })),
});

/** Reservas activas de la venta, por SKU y lote. */
async function reservas(venta = 1) {
  const { rows } = await db.query(
    `SELECT material_sku AS sku, lote_id_lote::int AS lote, reserva_inventario_cantidad_reservada::float AS cant
     FROM inventario.reserva_inventario
     WHERE nota_venta_id_nota_venta = $1 AND reserva_inventario_estado_reserva = 'activa' ORDER BY 1, 2`, [venta]);
  return rows;
}

describe('Listado y sugerencia', () => {
  test('lista las ventas aprobadas y en proceso, con sus puertas que requieren instalación', async () => {
    const r = await api('GET', '/api/pedidos-venta', { rol: 'jop' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map(v => [v.numero, v.estado_despacho]), [['NV-A', 'sin_vincular'], ['NV-E', 'sin_vincular']]);
    assert.equal(r.body.find(v => v.numero === 'NV-A').puertas_instalacion, 2);
  });

  test('sugiere solo los insumos del área Instalación × las puertas con instalación', async () => {
    const r = await api('GET', '/api/pedidos-venta/1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.sugerencia.map(s => [s.sku, s.cantidad]), [['MAT-UNO', 2], ['PIN-TEST', 1]]);
    assert.equal(r.body.motivo_sin_plantilla, null);
    assert.equal(r.body.editable, true);
  });

  test('Exc 1: una venta sin insumos de instalación pide cargarlos; sin líneas no se vincula', async () => {
    const r = await api('GET', '/api/pedidos-venta/3');
    assert.deepEqual(r.body.sugerencia, []);
    assert.match(r.body.motivo_sin_plantilla, /cárguelos a mano/);
    assert.equal((await vincular(3, { lineas: [] })).status, 400);
  });

  test('otros roles no acceden', async () => {
    const jwt = require('jsonwebtoken');
    const { levantar } = require('./helpers/api');
    const url = await levantar();
    const tecnico = jwt.sign({ id: 2, username: 'jop.test', rol: 'tecnico' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const r = await fetch(url + '/api/pedidos-venta', { headers: { Authorization: `Bearer ${tecnico}` } });
    assert.equal(r.status, 403);
  });
});

describe('Vincular', () => {
  test('reserva por FIFO en la bodega, una reserva por lote, y registra estado, fecha y usuario', async () => {
    const r = await vincular(1, receta([{ sku: 'MAT-FIFO', cantidad: 12, origen: 'manual' }]), 'jop');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await reservas(), [
      { sku: 'MAT-FIFO', lote: 1, cant: 10 }, { sku: 'MAT-FIFO', lote: 2, cant: 2 },   // lote viejo primero
      { sku: 'MAT-UNO', lote: 4, cant: 1 }, { sku: 'PIN-TEST', lote: 5, cant: 1 },
    ]);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 17 });
    assert.deepEqual(await db.descuadresDeReservas(), []);
    const { rows } = await db.query(
      `SELECT e.preparacion_pedido_estado_nombre_estado AS estado, e.usuario_id_usuario::int AS usuario
       FROM inventario.preparacion_pedido_estado e JOIN inventario.preparacion_pedido p USING (preparacion_pedido_id_preparacion)
       WHERE p.nota_venta_id_nota_venta = 1`);
    assert.deepEqual(rows, [{ estado: 'vinculado', usuario: 2 }]);
  });

  test('Exc 2: sin stock suficiente reserva lo que hay y deja el faltante (vinculación parcial)', async () => {
    const r = await vincular(1, receta());
    assert.equal(r.body.parcial, true);
    assert.deepEqual(r.body.lineas.find(l => l.sku === 'MAT-UNO'), { sku: 'MAT-UNO', bodega_id: 1, requerida: 2, reservado: 1, faltante: 1 });
    const d = (await api('GET', '/api/pedidos-venta/1')).body;
    assert.equal(d.venta.estado_despacho, 'vinculado');
    assert.equal(d.detalle.find(x => x.sku === 'MAT-UNO').reservado, 1);
    assert.equal((await api('GET', '/api/pedidos-venta')).body.find(v => v.numero === 'NV-A').faltantes, 1);
  });

  test('Exc 3: modificar ajusta por la diferencia; al bajar libera primero el lote más nuevo', async () => {
    await vincular(1, receta([{ sku: 'MAT-FIFO', cantidad: 12 }]));
    const r = await vincular(1, receta([{ sku: 'MAT-FIFO', cantidad: 5 }]));
    assert.equal(r.status, 200);
    assert.deepEqual((await reservas()).filter(x => x.sku === 'MAT-FIFO'), [{ sku: 'MAT-FIFO', lote: 1, cant: 5 }]);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 10 });
    assert.deepEqual(await db.descuadresDeReservas(), []);

    await vincular(1, receta([{ sku: 'MAT-FIFO', cantidad: 8 }]));       // subir: solo reserva 3 más
    assert.deepEqual((await reservas()).filter(x => x.sku === 'MAT-FIFO'), [{ sku: 'MAT-FIFO', lote: 1, cant: 8 }]);
  });

  test('un insumo que sale del pedido se libera y se quita', async () => {
    await vincular(1, receta([{ sku: 'MAT-FIFO', cantidad: 4 }]));
    const r = await vincular(1, receta());
    assert.deepEqual(r.body.quitados, ['MAT-FIFO']);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 5 });
    assert.equal(await db.contar('inventario.preparacion_pedido_detalle', `material_sku = 'MAT-FIFO'`), 0);
    assert.deepEqual(await db.descuadresDeReservas(), []);
  });

  test('D45: cada insumo se reserva de su propia bodega', async () => {
    await db.query(`INSERT INTO inventario.inventario_bodega (material_sku, lote_id_lote, bodega_id_bodega,
                      inventario_bodega_cantidad_fisica, inventario_bodega_cantidad_reservada) VALUES ('MAT-UNO', 4, 2, 5, 0)`);
    const r = await vincular(1, { lineas: [
      { sku: 'MAT-UNO', cantidad: 2, bodega_id: 2 }, { sku: 'PIN-TEST', cantidad: 1, bodega_id: 1 }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.parcial, false);
    const { rows } = await db.query(
      `SELECT material_sku AS sku, bodega_id_bodega::int AS bodega FROM inventario.reserva_inventario
       WHERE nota_venta_id_nota_venta = 1 AND reserva_inventario_estado_reserva = 'activa' ORDER BY 1`);
    assert.deepEqual(rows, [{ sku: 'MAT-UNO', bodega: 2 }, { sku: 'PIN-TEST', bodega: 1 }]);
    const d = (await api('GET', '/api/pedidos-venta/1')).body;
    assert.equal(d.detalle.find(x => x.sku === 'MAT-UNO').bodega_id, 2);
    assert.deepEqual(await db.descuadresDeReservas(), []);
  });

  test('cambiar la bodega principal de un insumo libera lo suyo y lo vuelve a reservar empezando por la nueva; los demás no se tocan', async () => {
    await db.query(`INSERT INTO inventario.inventario_bodega (material_sku, lote_id_lote, bodega_id_bodega,
                      inventario_bodega_cantidad_fisica, inventario_bodega_cantidad_reservada) VALUES ('PIN-TEST', 5, 2, 3, 0)`);
    await vincular(1, receta());
    const lineas = receta().lineas.map(l => (l.sku === 'PIN-TEST' ? { ...l, bodega_id: 2 } : l));
    const r = await vincular(1, { lineas });
    assert.equal(r.status, 200);
    assert.deepEqual(await reservasPorBodega(), [
      { sku: 'MAT-UNO', bodega: 1, cant: 1 }, { sku: 'PIN-TEST', bodega: 2, cant: 1 }]);
    assert.deepEqual(r.body.lineas.find(l => l.sku === 'PIN-TEST'), { sku: 'PIN-TEST', bodega_id: 2, requerida: 1, reservado: 1, faltante: 0 });
    assert.deepEqual(await db.descuadresDeReservas(), []);
  });
});

describe('Rechazos: no se reserva nada', () => {
  test('venta pendiente o cancelada → 400; inexistente → 404', async () => {
    assert.equal((await vincular(2, receta())).status, 400);
    assert.equal((await vincular(4, receta())).status, 400);
    assert.equal((await vincular(99, receta())).status, 404);
    assert.equal(await db.contar('inventario.reserva_inventario', 'nota_venta_id_nota_venta IS NOT NULL'), 0);
  });

  test('herramienta, inactivo, repetido, cantidad inválida, sin bodega o bodega inexistente → 400 con todos los errores', async () => {
    await db.query(`UPDATE inventario.material SET material_estado = 'inactivo' WHERE material_sku = 'MAT-CRIT'`);
    const r = await vincular(1, { lineas: [
      { sku: 'MAT-HERR', cantidad: 1, bodega_id: 1 }, { sku: 'MAT-CRIT', cantidad: 1, bodega_id: 1 },
      { sku: 'MAT-UNO', cantidad: 0, bodega_id: 1 }, { sku: 'PIN-TEST', cantidad: 1 }, { sku: 'PIN-TEST', cantidad: 2, bodega_id: 1 },
      { sku: 'MAT-FIFO', cantidad: 1, bodega_id: 99 }] });
    assert.equal(r.status, 400);
    assert.equal(r.body.errores.length, 6);
    assert.equal(await db.contar('inventario.preparacion_pedido'), 0);
  });

  test('un pedido ya preparado no se modifica (409)', async () => {
    await vincular(1, receta());
    await db.query(`INSERT INTO inventario.preparacion_pedido_estado (preparacion_pedido_estado_nombre_estado, preparacion_pedido_id_preparacion)
                    SELECT 'preparado', preparacion_pedido_id_preparacion FROM inventario.preparacion_pedido WHERE nota_venta_id_nota_venta = 1`);
    const r = await vincular(1, receta([{ sku: 'MAT-FIFO', cantidad: 1 }]));
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'PEDIDO_AVANZADO');
  });

  test('una venta vinculada que se cancela sigue en la lista, pero ya no se modifica', async () => {
    await vincular(1, receta());
    await db.query(`UPDATE finanzas.nota_venta SET estado_pedido = 'cancelada' WHERE id_nota_venta = 1`);
    assert.ok((await api('GET', '/api/pedidos-venta')).body.some(v => v.numero === 'NV-A'));
    const d = (await api('GET', '/api/pedidos-venta/1')).body;
    assert.equal(d.editable, false);
    assert.match(d.aviso, /cancelada/);
    assert.equal((await vincular(1, receta())).status, 400);
  });
});

/* ══════════════════════════════════════════════════════════════════════
   CU-119: marcar el pedido preparado para despacho
   ══════════════════════════════════════════════════════════════════════ */

const preparar = (venta, rol) => api('PUT', `/api/pedidos-venta/${venta}/preparado`, { rol });
/** Vinculación completa (sin faltantes): MAT-FIFO y PIN-TEST de la bodega 1. */
const completa = { lineas: [{ sku: 'MAT-FIFO', cantidad: 4, bodega_id: 1 }, { sku: 'PIN-TEST', cantidad: 1, bodega_id: 1 }] };
async function estados(venta = 1) {
  const { rows } = await db.query(
    `SELECT e.preparacion_pedido_estado_nombre_estado AS estado, e.usuario_id_usuario::int AS usuario
     FROM inventario.preparacion_pedido_estado e JOIN inventario.preparacion_pedido p USING (preparacion_pedido_id_preparacion)
     WHERE p.nota_venta_id_nota_venta = $1 ORDER BY e.preparacion_pedido_estado_id_estado_preparacion`, [venta]);
  return rows;
}

describe('Marcar preparado (CU-119)', () => {
  test('con todo reservado: escribe "preparado" con el usuario y la lista lo muestra', async () => {
    await vincular(1, completa);
    const r = await preparar(1, 'jop');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await estados(), [{ estado: 'vinculado', usuario: 1 }, { estado: 'preparado', usuario: 2 }]);
    assert.equal((await api('GET', '/api/pedidos-venta')).body.find(v => v.numero === 'NV-A').estado_despacho, 'preparado');
    assert.deepEqual(await db.descuadresDeReservas(), []);
  });

  test('Exc 1: sin insumos vinculados → 400', async () => {
    const r = await preparar(1);
    assert.equal(r.status, 400);
    assert.equal(r.body.codigo, 'SIN_VINCULAR');
  });

  test('Exc 2: con faltante → 400 con el faltante por insumo, sin escribir el estado', async () => {
    await vincular(1, receta());                                     // MAT-UNO: 1 de 2
    const r = await preparar(1);
    assert.equal(r.status, 400);
    assert.equal(r.body.codigo, 'FALTANTES');
    assert.deepEqual(r.body.faltantes.map(f => [f.sku, f.faltante]), [['MAT-UNO', 1]]);
    assert.deepEqual((await estados()).map(e => e.estado), ['vinculado']);
  });

  test('Exc 2: un lote reservado con menos físico que lo reservado también bloquea', async () => {
    await vincular(1, completa);
    await db.query(`UPDATE inventario.inventario_bodega SET inventario_bodega_cantidad_fisica = 0.5
                    WHERE material_sku = 'PIN-TEST' AND lote_id_lote = 5`);
    const r = await preparar(1);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /PIN-TEST/);
  });

  test('Exc 3: ya preparado → 409 con la fecha y quién; no se duplica el estado', async () => {
    await vincular(1, completa);
    await preparar(1);
    const r = await preparar(1);
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'YA_PREPARADO');
    assert.ok(r.body.fecha_preparado);
    assert.equal(r.body.preparado_por, 'gerente.test');
    assert.equal((await estados()).length, 2);
  });

  test('una venta que ya no está aprobada ni en proceso no se prepara', async () => {
    await vincular(1, completa);
    await db.query(`UPDATE finanzas.nota_venta SET estado_pedido = 'cancelada' WHERE id_nota_venta = 1`);
    assert.equal((await preparar(1)).status, 400);
  });

  test('bloqueo: preparado, CU-120 ya no modifica y Reservas no libera ni anula sus reservas', async () => {
    await vincular(1, completa);
    await preparar(1);
    assert.equal((await vincular(1, completa)).status, 409);
    const { rows } = await db.query(
      `SELECT reserva_inventario_id_reserva AS id FROM inventario.reserva_inventario
       WHERE nota_venta_id_nota_venta = 1 AND reserva_inventario_estado_reserva = 'activa' LIMIT 1`);
    const lib = await api('PUT', `/api/reservas/${rows[0].id}/liberar`);
    assert.equal(lib.status, 400);
    assert.match(lib.body.error, /NV-A/);
    assert.equal((await api('PUT', `/api/reservas/${rows[0].id}/anular`)).status, 400);
    assert.deepEqual(await db.stockDe('PIN-TEST'), { fisica: 20, reservada: 1 });
  });

  test('antes de preparar, una reserva del pedido sí se puede liberar desde Reservas', async () => {
    await vincular(1, completa);
    const { rows } = await db.query(
      `SELECT reserva_inventario_id_reserva AS id FROM inventario.reserva_inventario
       WHERE nota_venta_id_nota_venta = 1 AND material_sku = 'PIN-TEST'`);
    assert.equal((await api('PUT', `/api/reservas/${rows[0].id}/liberar`)).status, 200);
    assert.deepEqual(await db.descuadresDeReservas(), []);
  });
});

/* ══════════════════════════════════════════════════════════════════════
   CU-126: retiro de insumos (picking), por insumo (D46)
   ══════════════════════════════════════════════════════════════════════ */

const retirar = (venta, sku, cantidad, rol) => api('PUT', `/api/pedidos-venta/${venta}/retiro/${sku}`, { body: { cantidad }, rol });
const reportar = (venta, sku, observacion, rol) =>
  api('POST', `/api/pedidos-venta/${venta}/retiro/${sku}/ubicacion`, { body: { observacion }, rol });

/** Alertas del retiro, por tipo. */
async function alertasRetiro() {
  const { rows } = await db.query(
    `SELECT ta.alerta_inventario_tipo_alerta_nombre AS tipo, a.material_sku AS sku, a.bodega_id_bodega::int AS bodega,
            a.alerta_inventario_estado AS estado, a.alerta_inventario_diferencia::float AS diferencia, a.alerta_inventario_mensaje AS mensaje
     FROM inventario.alerta_inventario a
     JOIN inventario.alerta_inventario_tipo_alerta ta USING (alerta_inventario_tipo_alerta_id_tipo_alerta)
     WHERE ta.alerta_inventario_tipo_alerta_nombre IN ('ubicacion incorrecta', 'faltante en retiro')
     ORDER BY a.alerta_inventario_id_alerta`);
  return rows;
}

describe('Retiro de insumos (CU-126)', () => {
  beforeEach(async () => {
    await vincular(1, completa);       // MAT-FIFO 4 (lote 1) y PIN-TEST 1 (lote 5), bodega 1
    await preparar(1);
  });

  test('retiro completo: registra cantidad, hora y usuario; NO mueve stock ni libera la reserva', async () => {
    await db.query(`UPDATE inventario.inventario_bodega SET anaquel_id_anaquel = 1 WHERE material_sku = 'MAT-FIFO' AND lote_id_lote = 1`);
    const r = await retirar(1, 'MAT-FIFO', 4, 'jop');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.parcial, false);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 9 });
    assert.deepEqual(await db.descuadresDeReservas(), []);

    const item = (await api('GET', '/api/pedidos-venta/1')).body.detalle.find(x => x.sku === 'MAT-FIFO');
    assert.equal(item.retirada, 4);
    assert.equal(item.retirado_por, 'jop.test');
    assert.ok(item.fecha_retiro);
    assert.deepEqual(item.lotes, [{ lote: 'LOTE-VIEJO', cantidad: 4, anaquel: 'Estante A', bodega_id: 1, bodega: 'Bodega Test' }]);
    assert.deepEqual(await alertasRetiro(), []);
  });

  test('Exc 3: retiro parcial → alerta "faltante en retiro" con la diferencia; completarlo después acumula', async () => {
    const r = await retirar(1, 'MAT-FIFO', '2.5');
    assert.equal(r.status, 200);
    assert.equal(r.body.parcial, true);
    assert.equal(r.body.faltante, 1.5);
    const [a] = await alertasRetiro();
    assert.deepEqual([a.tipo, a.sku, a.bodega, a.estado, a.diferencia], ['faltante en retiro', 'MAT-FIFO', 1, 'activa', -1.5]);
    assert.match(a.mensaje, /NV-A/);
    const { rows: notif } = await db.query(
      `SELECT usuario_id_usuario::int AS u FROM inventario.notificacion WHERE notificacion_tipo_notificacion = 'faltante_retiro'`);
    assert.deepEqual(notif, [{ u: 1 }], 'se avisa a gerencia');

    const r2 = await retirar(1, 'MAT-FIFO', 1.5, 'jop');
    assert.equal(r2.body.parcial, false);
    const item = (await api('GET', '/api/pedidos-venta/1')).body.detalle.find(x => x.sku === 'MAT-FIFO');
    assert.deepEqual([item.retirada, item.retirado_por], [4, 'jop.test']);
  });

  test('Exc 2: un insumo ya retirado → 409 con quién y cuándo, sin cambiar nada', async () => {
    await retirar(1, 'PIN-TEST', 1, 'jop');
    const r = await retirar(1, 'PIN-TEST', 1);
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'YA_RETIRADO');
    assert.equal(r.body.retirado_por, 'jop.test');
    assert.ok(r.body.fecha_retiro);
    assert.equal((await reportar(1, 'PIN-TEST')).status, 409);
    assert.deepEqual(await alertasRetiro(), []);
  });

  test('más que lo pendiente, cantidad inválida o insumo ajeno al pedido → rechazo sin tocar nada', async () => {
    assert.equal((await retirar(1, 'MAT-FIFO', 5)).status, 400);
    assert.equal((await retirar(1, 'MAT-FIFO', 0)).status, 400);
    assert.equal((await retirar(1, 'MAT-FIFO', 'abc')).status, 400);
    assert.equal((await retirar(1, 'MAT-UNO', 1)).status, 404);
    assert.equal(await db.contar('inventario.preparacion_pedido_detalle', 'preparacion_pedido_detalle_cantidad_retirada IS NOT NULL'), 0);
  });

  test('solo se retira en un pedido preparado: vinculado → 400; en carga → 409', async () => {
    await vincular(3, { lineas: [{ sku: 'MAT-UNO', cantidad: 1, bodega_id: 1 }] });
    const r = await retirar(3, 'MAT-UNO', 1);
    assert.equal(r.status, 400);
    assert.equal(r.body.codigo, 'NO_PREPARADO');

    await db.query(`INSERT INTO inventario.preparacion_pedido_estado (preparacion_pedido_estado_nombre_estado, preparacion_pedido_id_preparacion)
                    SELECT 'en_carga', preparacion_pedido_id_preparacion FROM inventario.preparacion_pedido WHERE nota_venta_id_nota_venta = 1`);
    const r2 = await retirar(1, 'MAT-FIFO', 1);
    assert.equal(r2.status, 409);
    assert.equal(r2.body.codigo, 'PEDIDO_AVANZADO');
  });

  test('Exc 1: ubicación incorrecta → alerta con la bodega y el anaquel, aviso a gerencia; el insumo sigue pendiente', async () => {
    await db.query(`UPDATE inventario.inventario_bodega SET anaquel_id_anaquel = 1 WHERE material_sku = 'MAT-FIFO' AND lote_id_lote = 1`);
    const r = await reportar(1, 'MAT-FIFO', 'El estante está vacío', 'jop');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const [a] = await alertasRetiro();
    assert.deepEqual([a.tipo, a.sku, a.bodega, a.estado], ['ubicacion incorrecta', 'MAT-FIFO', 1, 'activa']);
    assert.match(a.mensaje, /Estante A/);
    assert.match(a.mensaje, /El estante está vacío/);
    assert.equal(await db.contar('inventario.notificacion', `notificacion_tipo_notificacion = 'ubicacion_incorrecta'`), 1);
    const item = (await api('GET', '/api/pedidos-venta/1')).body.detalle.find(x => x.sku === 'MAT-FIFO');
    assert.equal(item.retirada, 0);
  });

  test('sesión 15: completar el retiro resuelve sus alertas (faltante y ubicación), con fecha de resolución', async () => {
    await reportar(1, 'MAT-FIFO', 'no estaba');
    await retirar(1, 'MAT-FIFO', 1);                                   // parcial: otra alerta
    assert.deepEqual((await alertasRetiro()).map(a => a.estado), ['activa', 'activa']);
    const r = await retirar(1, 'MAT-FIFO', 3);                          // completa
    assert.match(r.body.message, /Se resolvieron 2 alerta/);
    assert.deepEqual((await alertasRetiro()).map(a => a.estado), ['resuelta', 'resuelta']);
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM inventario.historial_alerta ha
       JOIN inventario.alerta_inventario a USING (historial_alerta_id_historial)
       WHERE a.alerta_inventario_estado = 'resuelta' AND ha.historial_alerta_fecha_hora_resolucion IS NOT NULL`);
    assert.equal(rows[0].n, 2);
  });

  test('sesión 15: no se cierran las alertas de otra venta ni las de otro insumo', async () => {
    await reportar(1, 'MAT-FIFO');
    await reportar(1, 'PIN-TEST');
    // Una alerta de otra venta, mismo SKU (el mensaje empieza con su propio número)
    await db.query(
      `INSERT INTO inventario.alerta_inventario (alerta_inventario_mensaje, alerta_inventario_estado, material_sku,
         alerta_inventario_tipo_alerta_id_tipo_alerta)
       SELECT 'Venta NV-A2: MAT-FIFO no está en la ubicación indicada', 'activa', 'MAT-FIFO', alerta_inventario_tipo_alerta_id_tipo_alerta
       FROM inventario.alerta_inventario WHERE material_sku = 'MAT-FIFO' LIMIT 1`);
    await retirar(1, 'MAT-FIFO', 4);
    const estados = Object.fromEntries((await alertasRetiro()).map(a => [a.mensaje.slice(0, 20), a.estado]));
    assert.equal(Object.values(estados).filter(e => e === 'resuelta').length, 1, JSON.stringify(estados));
    assert.equal((await alertasRetiro()).find(a => a.sku === 'PIN-TEST').estado, 'activa');
    assert.equal((await alertasRetiro()).find(a => a.mensaje.startsWith('Venta NV-A2:')).estado, 'activa');
  });

  test('el evaluador de stock no cierra las alertas del retiro', async () => {
    await reportar(1, 'MAT-FIFO');                       // MAT-FIFO tiene stock sobre el mínimo
    await retirar(1, 'PIN-TEST', 0.5);
    assert.equal((await api('POST', '/api/alertas/generar')).status, 200);
    assert.deepEqual((await alertasRetiro()).map(a => a.estado), ['activa', 'activa']);
  });

  test('otros roles no retiran', async () => {
    const jwt = require('jsonwebtoken');
    const { levantar } = require('./helpers/api');
    const url = await levantar();
    const tecnico = jwt.sign({ id: 2, username: 'jop.test', rol: 'tecnico' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const r = await fetch(url + '/api/pedidos-venta/1/retiro/MAT-FIFO', {
      method: 'PUT', headers: { Authorization: `Bearer ${tecnico}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ cantidad: 1 }) });
    assert.equal(r.status, 403);
  });
});

/* ══════════════════════════════════════════════════════════════════════
   CU-125: carga en transporte (D47: responsable = empleado por RUT, sin mostrarlo)
   ══════════════════════════════════════════════════════════════════════ */

const cargar = (venta, body, rol) => api('POST', `/api/pedidos-venta/${venta}/carga`, { body, rol });
const EMPLEADO = '22222222-2';   // semilla: 'Empleado Test', activo

describe('Carga en transporte (CU-125)', () => {
  beforeEach(async () => {
    await vincular(1, completa);
    await preparar(1);
    await db.query(`INSERT INTO finanzas.empleado (empleado_rut_empleado, empleado_nombre_empleado_primer_nombre_empleado,
                      empleado_nombre_empleado_primer_apellido_empleado, empleado_estado, empleado_cargo_id_cargo,
                      empleado_tipo_vinculo_laboral_id_tipo_vinculo)
                    VALUES ('33333333-3', 'Segundo', 'Cargador', 'activo', 1, 1), ('44444444-4', 'Ex', 'Empleado', 'inactivo', 1, 1)`);
  });
  const retirarTodo = async () => { await retirar(1, 'MAT-FIFO', 4); await retirar(1, 'PIN-TEST', 1); };

  test('inicia la carga: fila en_carga con el trabajador y quién la registró; no mueve stock', async () => {
    await retirarTodo();
    const r = await cargar(1, { empleado_rut: EMPLEADO }, 'jop');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const { rows } = await db.query(
      `SELECT e.preparacion_pedido_estado_nombre_estado AS estado, e.empleado_rut AS rut, e.usuario_id_usuario::int AS usuario
       FROM inventario.preparacion_pedido_estado e JOIN inventario.preparacion_pedido p USING (preparacion_pedido_id_preparacion)
       WHERE p.nota_venta_id_nota_venta = 1 AND e.preparacion_pedido_estado_nombre_estado = 'en_carga'`);
    assert.deepEqual(rows, [{ estado: 'en_carga', rut: EMPLEADO, usuario: 2 }]);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 9 });
    assert.deepEqual(await db.descuadresDeReservas(), []);

    const d = (await api('GET', '/api/pedidos-venta/1')).body;
    assert.equal(d.venta.estado_despacho, 'en_carga');
    assert.deepEqual(d.responsables_carga.map(x => [x.nombre, x.cargo, x.registrado_por]), [['Empleado Test', 'Operario', 'jop.test']]);
    assert.ok(!JSON.stringify(d.responsables_carga).includes(EMPLEADO), 'el RUT no viaja en el detalle');
  });

  test('Exc 3: con insumos sin retirar (o parciales) → 400 con la lista, sin escribir', async () => {
    await retirar(1, 'MAT-FIFO', 2);                   // parcial; PIN-TEST pendiente
    const r = await cargar(1, { empleado_rut: EMPLEADO });
    assert.equal(r.status, 400);
    assert.equal(r.body.codigo, 'RETIRO_PENDIENTE');
    assert.deepEqual(r.body.pendientes.map(p => [p.sku, p.pendiente]), [['MAT-FIFO', 2], ['PIN-TEST', 1]]);
    assert.deepEqual((await estados()).map(e => e.estado), ['vinculado', 'preparado']);
  });

  test('Exc 1: empleado inexistente, inactivo o sin indicar → 400', async () => {
    await retirarTodo();
    assert.equal((await cargar(1, { empleado_rut: '99999999-9' })).body.codigo, 'EMPLEADO_INVALIDO');
    assert.equal((await cargar(1, { empleado_rut: '44444444-4' })).body.codigo, 'EMPLEADO_INVALIDO');
    assert.equal((await cargar(1, {})).status, 400);
    assert.deepEqual((await estados()).map(e => e.estado), ['vinculado', 'preparado']);
  });

  test('Exc 2: carga ya iniciada → 409 con los responsables (sin RUT); con sumar se agrega otro; el mismo no se repite', async () => {
    await retirarTodo();
    await cargar(1, { empleado_rut: EMPLEADO });
    const r = await cargar(1, { empleado_rut: '33333333-3' });
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'CARGA_INICIADA');
    assert.deepEqual(r.body.responsables.map(x => x.nombre), ['Empleado Test']);
    assert.ok(!JSON.stringify(r.body).includes(EMPLEADO), 'el RUT no viaja en el conflicto');

    assert.equal((await cargar(1, { empleado_rut: '33333333-3', sumar: true })).status, 201);
    const d = (await api('GET', '/api/pedidos-venta/1')).body;
    assert.deepEqual(d.responsables_carga.map(x => x.nombre), ['Empleado Test', 'Segundo Cargador']);

    const rep = await cargar(1, { empleado_rut: EMPLEADO, sumar: true });
    assert.equal(rep.status, 409);
    assert.equal(rep.body.codigo, 'YA_RESPONSABLE');
    assert.equal((await estados()).filter(e => e.estado === 'en_carga').length, 2);
  });

  test('un pedido vinculado → 400; en tránsito → 409', async () => {
    await vincular(3, { lineas: [{ sku: 'MAT-UNO', cantidad: 1, bodega_id: 1 }] });
    assert.equal((await cargar(3, { empleado_rut: EMPLEADO })).body.codigo, 'NO_PREPARADO');
    await retirarTodo();
    await db.query(`INSERT INTO inventario.preparacion_pedido_estado (preparacion_pedido_estado_nombre_estado, preparacion_pedido_id_preparacion)
                    SELECT 'en_transito', preparacion_pedido_id_preparacion FROM inventario.preparacion_pedido WHERE nota_venta_id_nota_venta = 1`);
    const r = await cargar(1, { empleado_rut: EMPLEADO, sumar: true });
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'PEDIDO_AVANZADO');
  });

  test('/empleados lista solo los activos, con nombre y cargo', async () => {
    const r = await api('GET', '/api/pedidos-venta/empleados', { rol: 'jop' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map(e => [e.nombre, e.cargo]), [['Empleado Test', 'Operario'], ['Segundo Cargador', 'Operario']]);
  });

  test('otros roles no inician la carga', async () => {
    const jwt = require('jsonwebtoken');
    const { levantar } = require('./helpers/api');
    const url = await levantar();
    const tecnico = jwt.sign({ id: 2, username: 'jop.test', rol: 'tecnico' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const r = await fetch(url + '/api/pedidos-venta/1/carga', {
      method: 'POST', headers: { Authorization: `Bearer ${tecnico}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ empleado_rut: EMPLEADO }) });
    assert.equal(r.status, 403);
  });
});

/* ══════════════════════════════════════════════════════════════════════
   CU-127: confirmación de carga y salida del transporte (D20: libera la reserva)
   ══════════════════════════════════════════════════════════════════════ */

const despachar = (venta, body, rol) => api('PUT', `/api/pedidos-venta/${venta}/salida`, { body, rol });
const { stockAFecha, consumoNeto } = require('../src/db/historico');

/** Salidas por despacho de la venta. */
async function salidas(numero = 'NV-A') {
  const { rows } = await db.query(
    `SELECT mi.material_sku AS sku, mi.lote_id_lote::int AS lote, mi.bodega_id_bodega::int AS bodega,
            mi.movimiento_inventario_cantidad::float AS cant, mi.movimiento_inventario_estado AS estado
     FROM inventario.movimiento_inventario mi
     JOIN inventario.movimiento_inventario_motivo_movimiento mot USING (movimiento_inventario_motivo_movimiento_id_motivo_movimiento)
     WHERE mot.movimiento_inventario_motivo_movimiento_nombre = 'despacho_venta' AND mi.movimiento_inventario_referencia_origen = $1
     ORDER BY 1, 2`, [numero]);
  return rows;
}

describe('Salida del transporte (CU-127)', () => {
  beforeEach(async () => {
    await vincular(1, completa);           // MAT-FIFO 4 (lote 1) y PIN-TEST 1 (lote 5), bodega 1
    await preparar(1);
  });
  const hastaCarga = async () => {
    await retirar(1, 'MAT-FIFO', 4); await retirar(1, 'PIN-TEST', 1);
    assert.equal((await cargar(1, { empleado_rut: EMPLEADO })).status, 201);
  };

  test('despacha: descuenta físico y reservado por lote, una salida por reserva, reservas liberadas, en_transito', async () => {
    await hastaCarga();
    const r = await despachar(1, { observacion: 'Camión patente AB-12-34' }, 'jop');
    assert.equal(r.status, 200, JSON.stringify(r.body));

    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 26, reservada: 5 });   // la reserva previa (5) sigue
    assert.equal(await db.stockDeLote('MAT-FIFO', 1), 6);
    assert.deepEqual(await db.stockDe('PIN-TEST'), { fisica: 19, reservada: 0 });
    assert.deepEqual(await db.descuadresDeReservas(), []);
    assert.deepEqual(await salidas(), [
      { sku: 'MAT-FIFO', lote: 1, bodega: 1, cant: 4, estado: 'completado' },
      { sku: 'PIN-TEST', lote: 5, bodega: 1, cant: 1, estado: 'completado' },
    ]);
    assert.equal(await db.contar('inventario.reserva_inventario',
      `nota_venta_id_nota_venta = 1 AND reserva_inventario_estado_reserva = 'activa'`), 0);
    assert.equal(await db.contar('inventario.reserva_inventario',
      `nota_venta_id_nota_venta = 1 AND reserva_inventario_estado_reserva = 'liberada' AND reserva_inventario_fecha_liberacion IS NOT NULL`), 2);

    const d = (await api('GET', '/api/pedidos-venta/1')).body;
    assert.equal(d.venta.estado_despacho, 'en_transito');
    assert.equal(d.despacho.observacion, 'Camión patente AB-12-34');
    assert.equal(d.despacho.usuario, 'jop.test');
    assert.equal(d.despacho.movimientos.length, 2);
  });

  test('la salida cuenta como consumo y stockAFecha reconstruye antes y después', async () => {
    await hastaCarga();
    const antes = new Date(Date.now() - 1000);
    const stockAntes = await stockAFecha(db, antes);
    await despachar(1);
    assert.equal((await consumoNeto(db)).get('PIN-TEST'), 1);
    assert.equal((await stockAFecha(db, antes)).get('MAT-FIFO'), stockAntes.get('MAT-FIFO'), 'el pasado no cambia');
    assert.equal((await stockAFecha(db, new Date(Date.now() + 60000))).get('MAT-FIFO'), 26, 'hoy = stock real');
  });

  test('D63: CU-44 no revierte una salida del despacho: el pedido sigue coherente y el stock no se mueve', async () => {
    await hastaCarga();
    await despachar(1);
    const { rows } = await db.query(
      `SELECT movimiento_inventario_id_movimiento::int AS id FROM inventario.movimiento_inventario
       WHERE movimiento_inventario_referencia_origen = 'NV-A'`);
    const antes = await db.stockDe('MAT-FIFO');
    for (const { id } of rows) {
      const r = await api('POST', `/api/movimientos/${id}/revertir`, { body: { autorizacion: autorizacion(id) } });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, /despacho de la venta NV-A/);
      // CU-42: se rechaza antes de pedir la contraseña
      const pre = await api('POST', '/api/auth/reautenticar', { body: { password: 'x', movimiento_id: id } });
      assert.equal(pre.status, 400, JSON.stringify(pre.body));
    }
    assert.deepEqual(await db.stockDe('MAT-FIFO'), antes);
    assert.equal((await api('GET', '/api/pedidos-venta/1')).body.venta.estado_despacho, 'en_transito');
  });

  test('sesión 15: el Historial muestra la venta como documento de las salidas del despacho', async () => {
    await hastaCarga();
    await despachar(1);
    const movs = (await api('GET', '/api/movimientos')).body.filter(m => m.documento_tipo === 'venta');
    assert.equal(movs.length, 2);
    assert.ok(movs.every(m => m.documento_ref === 'NV-A'));
  });

  test('Exc 1: sin carga iniciada → 400 y no se mueve nada', async () => {
    await retirar(1, 'MAT-FIFO', 4); await retirar(1, 'PIN-TEST', 1);   // preparado y retirado, sin carga
    const r = await despachar(1);
    assert.equal(r.status, 400);
    assert.equal(r.body.codigo, 'SIN_CARGA');
    assert.deepEqual(await db.stockDe('PIN-TEST'), { fisica: 20, reservada: 1 });
    assert.deepEqual(await salidas(), []);
  });

  test('Exc 2: ya despachado → 409 con la fecha; no hay una segunda salida', async () => {
    await hastaCarga();
    await despachar(1);
    const r = await despachar(1);
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'YA_DESPACHADO');
    assert.ok(r.body.fecha_despacho);
    assert.equal(r.body.despachado_por, 'gerente.test');
    assert.equal((await salidas()).length, 2);
    assert.deepEqual(await db.stockDe('PIN-TEST'), { fisica: 19, reservada: 0 });
  });

  test('un lote con menos físico que lo reservado → 400 con el detalle, sin mover nada', async () => {
    await hastaCarga();
    await db.query(`UPDATE inventario.inventario_bodega SET inventario_bodega_cantidad_fisica = 0.5
                    WHERE material_sku = 'PIN-TEST' AND lote_id_lote = 5`);
    const r = await despachar(1);
    assert.equal(r.status, 400);
    assert.equal(r.body.codigo, 'INCONSISTENTE');
    assert.match(r.body.error, /LOTE-PIN/);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 9 });
    assert.deepEqual(await salidas(), []);
    assert.deepEqual((await estados()).map(e => e.estado), ['vinculado', 'preparado', 'en_carga']);
  });

  test('otros roles no despachan', async () => {
    const jwt = require('jsonwebtoken');
    const { levantar } = require('./helpers/api');
    const url = await levantar();
    const tecnico = jwt.sign({ id: 2, username: 'jop.test', rol: 'tecnico' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const r = await fetch(url + '/api/pedidos-venta/1/salida', {
      method: 'PUT', headers: { Authorization: `Bearer ${tecnico}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403);
  });
});

test('CU-127: un pedido despachado no aparece con faltantes en la lista', async () => {
  await vincular(1, completa);
  await preparar(1);
  await retirar(1, 'MAT-FIFO', 4); await retirar(1, 'PIN-TEST', 1);
  await cargar(1, { empleado_rut: EMPLEADO });
  await despachar(1);
  const v = (await api('GET', '/api/pedidos-venta')).body.find(x => x.numero === 'NV-A');
  assert.deepEqual([v.estado_despacho, v.faltantes], ['en_transito', 0]);
});

/* ══════════════════════════════════════════════════════════════════════
   CU-121: trazabilidad de los insumos del pedido (solo lectura)
   ══════════════════════════════════════════════════════════════════════ */

const traza = (q, rol) => api('GET', `/api/pedidos-venta/trazabilidad?q=${encodeURIComponent(q)}`, { rol });
const estadosDe = (insumo) => Object.fromEntries(insumo.etapas.map(e => [e.clave, e.estado]));

describe('Trazabilidad (CU-121)', () => {
  test('pedido recién vinculado: ingreso, bodega y vinculación con fecha; el resto pendiente', async () => {
    await vincular(1, completa);
    const r = await traza('nv-a', 'jop');                // sin distinguir mayúsculas
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.tipo, 'venta');
    const [p] = r.body.pedidos;
    assert.equal(p.venta.numero, 'NV-A');
    const fifo = p.insumos.find(i => i.sku === 'MAT-FIFO');
    assert.deepEqual(estadosDe(fifo), {
      ingreso: 'completada', bodega: 'completada', vinculacion: 'completada',
      preparacion: 'pendiente', retiro: 'pendiente', carga: 'pendiente', despacho: 'pendiente',
    });
    const ingreso = fifo.etapas.find(e => e.clave === 'ingreso');
    assert.equal(ingreso.fecha, '2026-01-01');           // LOTE-VIEJO, como texto (sin pasar por UTC)
    assert.match(ingreso.detalle, /LOTE-VIEJO/);
    assert.ok(fifo.etapas.find(e => e.clave === 'vinculacion').fecha);
  });

  test('pedido despachado: las 7 etapas completas, con el lote de la salida y los responsables sin RUT', async () => {
    await vincular(1, completa);
    await preparar(1);
    await retirar(1, 'MAT-FIFO', 2);
    let fifo = (await traza('NV-A')).body.pedidos[0].insumos.find(i => i.sku === 'MAT-FIFO');
    assert.equal(estadosDe(fifo).retiro, 'parcial');

    await retirar(1, 'MAT-FIFO', 2); await retirar(1, 'PIN-TEST', 1);
    await cargar(1, { empleado_rut: EMPLEADO });
    await despachar(1);
    const r = await traza('NV-A');
    for (const i of r.body.pedidos[0].insumos) {
      assert.ok(i.etapas.every(e => e.estado === 'completada'), `${i.sku}: ${JSON.stringify(estadosDe(i))}`);
      assert.ok(i.etapas.filter(e => e.clave !== 'bodega').every(e => e.fecha), `${i.sku}: todas con fecha`);
    }
    fifo = r.body.pedidos[0].insumos.find(i => i.sku === 'MAT-FIFO');
    assert.match(fifo.etapas.find(e => e.clave === 'ingreso').detalle, /LOTE-VIEJO \(4\)/);   // de la salida, no de la reserva
    assert.match(fifo.etapas.find(e => e.clave === 'carga').detalle, /Empleado Test/);
    assert.ok(!JSON.stringify(r.body).includes(EMPLEADO), 'el RUT no viaja');
  });

  test('por SKU: un bloque por pedido de instalación que lo incluye, solo con ese insumo', async () => {
    await vincular(1, completa);
    await vincular(3, { lineas: [{ sku: 'MAT-FIFO', cantidad: 1, bodega_id: 1 }] });
    const r = await traza('mat-fifo');
    assert.equal(r.status, 200);
    assert.equal(r.body.tipo, 'sku');
    assert.deepEqual(r.body.pedidos.map(p => p.venta.numero).sort(), ['NV-A', 'NV-E']);
    assert.ok(r.body.pedidos.every(p => p.insumos.length === 1 && p.insumos[0].sku === 'MAT-FIFO'));
  });

  test('Exc 1: venta sin vincular o SKU sin pedidos → sin datos; Exc 2: dato inexistente → 404', async () => {
    const venta = await traza('NV-P');
    assert.equal(venta.status, 200);
    assert.equal(venta.body.sin_datos, true);
    assert.match(venta.body.mensaje, /no registra movimientos/);

    const sku = await traza('MAT-UNO');
    assert.equal(sku.body.sin_datos, true);

    const no = await traza('NO-EXISTE-123');
    assert.equal(no.status, 404);
    assert.equal((await traza(' ')).status, 400);
  });

  test('otros roles no consultan', async () => {
    const jwt = require('jsonwebtoken');
    const { levantar } = require('./helpers/api');
    const url = await levantar();
    const tecnico = jwt.sign({ id: 2, username: 'jop.test', rol: 'tecnico' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const r = await fetch(url + '/api/pedidos-venta/trazabilidad?q=NV-A', { headers: { Authorization: `Bearer ${tecnico}` } });
    assert.equal(r.status, 403);
  });
});

/* ══════════════════════════════════════════════════════════════════════
   D58: si la bodega principal no alcanza, el resto se reserva en las demás
   ══════════════════════════════════════════════════════════════════════ */

/** Reservas activas de la venta, por SKU y bodega. */
async function reservasPorBodega(venta = 1) {
  const { rows } = await db.query(
    `SELECT material_sku AS sku, bodega_id_bodega::int AS bodega, SUM(reserva_inventario_cantidad_reservada)::float AS cant
     FROM inventario.reserva_inventario
     WHERE nota_venta_id_nota_venta = $1 AND reserva_inventario_estado_reserva = 'activa'
     GROUP BY 1, 2 ORDER BY 1, 2`, [venta]);
  return rows;
}

describe('Reparto entre bodegas (D58)', () => {
  // MAT-UNO: 1 en la bodega 1 (semilla) + 3 en la bodega 2
  beforeEach(async () => {
    await db.query(`INSERT INTO inventario.inventario_bodega (material_sku, lote_id_lote, bodega_id_bodega,
                      inventario_bodega_cantidad_fisica, inventario_bodega_cantidad_reservada) VALUES ('MAT-UNO', 4, 2, 3, 0)`);
  });
  const conUno = (cantidad, bodega_id = 1) => ({ lineas: [{ sku: 'MAT-UNO', cantidad, bodega_id }] });

  test('lo que la principal no cubre se completa desde otra bodega: vinculación completa', async () => {
    const r = await vincular(1, conUno(4));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.parcial, false);
    assert.deepEqual(await reservasPorBodega(), [{ sku: 'MAT-UNO', bodega: 1, cant: 1 }, { sku: 'MAT-UNO', bodega: 2, cant: 3 }]);
    assert.deepEqual(await db.stockDe('MAT-UNO'), { fisica: 4, reservada: 4 });
    assert.deepEqual(await db.descuadresDeReservas(), []);
    const item = (await api('GET', '/api/pedidos-venta/1')).body.detalle.find(x => x.sku === 'MAT-UNO');
    assert.equal(item.bodega_id, 1, 'la principal no cambia');
    assert.deepEqual(item.lotes.map(l => [l.bodega_id, l.cantidad]), [[1, 1], [2, 3]]);
  });

  test('si ni sumando todas alcanza, reserva todo lo que hay y deja el faltante', async () => {
    const r = await vincular(1, conUno(6));
    assert.equal(r.body.parcial, true);
    assert.deepEqual(r.body.lineas[0], { sku: 'MAT-UNO', bodega_id: 1, requerida: 6, reservado: 4, faltante: 2 });
    assert.deepEqual(await db.descuadresDeReservas(), []);
  });

  test('al bajar libera primero lo de las otras bodegas; al subir vuelve a completar', async () => {
    await vincular(1, conUno(4));
    await vincular(1, conUno(2));
    assert.deepEqual(await reservasPorBodega(), [{ sku: 'MAT-UNO', bodega: 1, cant: 1 }, { sku: 'MAT-UNO', bodega: 2, cant: 1 }]);
    await vincular(1, conUno(1));
    assert.deepEqual(await reservasPorBodega(), [{ sku: 'MAT-UNO', bodega: 1, cant: 1 }]);
    await vincular(1, conUno(3));
    assert.deepEqual(await reservasPorBodega(), [{ sku: 'MAT-UNO', bodega: 1, cant: 1 }, { sku: 'MAT-UNO', bodega: 2, cant: 2 }]);
    assert.deepEqual(await db.descuadresDeReservas(), []);
  });

  test('una bodega inactiva no se usa para completar', async () => {
    await db.query(`UPDATE inventario.bodega SET bodega_estado = 'inactivo' WHERE bodega_id_bodega = 2`);
    const r = await vincular(1, conUno(4));
    assert.deepEqual(r.body.lineas[0], { sku: 'MAT-UNO', bodega_id: 1, requerida: 4, reservado: 1, faltante: 3 });
  });

  test('retiro, salida y trazabilidad con dos bodegas: se descuenta de cada una', async () => {
    await vincular(1, conUno(4));
    assert.equal((await preparar(1)).status, 200);
    const parcial = await retirar(1, 'MAT-UNO', 3);
    assert.equal(parcial.status, 200);
    const [a] = await alertasRetiro();
    assert.match(a.mensaje, /Bodega Test y Bodega Secundaria/);
    await retirar(1, 'MAT-UNO', 1);
    assert.equal((await cargar(1, { empleado_rut: EMPLEADO })).status, 201);
    assert.equal((await despachar(1)).status, 200);

    assert.deepEqual((await salidas()).map(s => [s.bodega, s.cant]).sort(), [[1, 1], [2, 3]]);
    assert.deepEqual(await db.stockDe('MAT-UNO'), { fisica: 0, reservada: 0 });
    assert.deepEqual(await db.descuadresDeReservas(), []);

    const [insumo] = (await traza('NV-A')).body.pedidos[0].insumos;
    assert.equal(insumo.etapas.find(e => e.clave === 'bodega').detalle, 'Bodega Test y Bodega Secundaria');
  });
});
