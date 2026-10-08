const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * CU-131: reservar stock para ventas aprobadas (D16, D48, D49).
 *
 * Lo que protegen:
 *  - Solo se reservan las líneas con sku_material, lo PENDIENTE (lo pedido menos lo ya
 *    reservado para esa venta y SKU fuera de CU-120), por FIFO y una reserva por lote.
 *  - El invariante de reservas se mantiene (descuadresDeReservas vacío).
 *  - Exc 2: sin stock no se mueve nada hasta confirmar la reserva parcial.
 *  - Un rechazo no reserva nada.
 *
 * Semilla: MAT-FIFO en la bodega 1: lote 1 (viejo) 10 libres, lote 2 (nuevo) 20 con 5
 * reservadas → 25 libres. MAT-UNO 1. MAT-HERR es herramienta.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => {
  await db.resetear();
  await db.query(`INSERT INTO finanzas.tipo_cliente (id_tipo_cliente, nombre_tipo_cliente) OVERRIDING SYSTEM VALUE VALUES (1, 'empresa')`);
  await db.query(`INSERT INTO finanzas.cliente_financiero (id_cliente_financiero, rut_cliente, id_tipo_cliente, nombre_razon_social)
                  OVERRIDING SYSTEM VALUE VALUES (1, '11111111-1', 1, 'Cliente de prueba')`);
  await db.query(`INSERT INTO finanzas.nota_venta (id_nota_venta, numero_nota_venta, id_cliente_financiero, fecha_emision, estado_pedido)
                  OVERRIDING SYSTEM VALUE VALUES
                    (1, 'NV-A', 1, CURRENT_DATE, 'aprobada'),
                    (2, 'NV-P', 1, CURRENT_DATE, 'pendiente'),
                    (3, 'NV-C', 1, CURRENT_DATE, 'cancelada'),
                    (4, 'NV-X', 1, CURRENT_DATE, 'aprobada')`);
  await linea(1, 'MAT-FIFO', 12);     // alcanza: lote 1 (10) + lote 2 (2)
  await linea(1, 'MAT-UNO', 3);       // hay 1: faltante 2
  await linea(1, null, 1);            // puerta o servicio: no se reserva aquí (D16)
  await linea(2, 'MAT-FIFO', 1);
  await linea(3, 'MAT-FIFO', 1);
  await linea(4, 'MAT-FIFO', 2);
  await linea(4, 'MAT-HERR', 1);      // Exc 1: herramienta
});
after(async () => { await bajar(); await db.cerrar(); });

async function linea(venta, sku, cantidad) {
  await db.query(
    `INSERT INTO finanzas.item_nota_venta (id_nota_venta, sku_material, descripcion_item, cantidad, precio_unitario, requiere_instalacion)
     VALUES ($1, $2, 'línea de prueba', $3, 1000, FALSE)`, [venta, sku, cantidad]);
}

const reservar = (venta, body = {}, rol) => api('POST', `/api/reservas/ventas/${venta}`, { body, rol });

async function reservas(venta = 1) {
  const { rows } = await db.query(
    `SELECT material_sku AS sku, lote_id_lote::int AS lote, reserva_inventario_cantidad_reservada::float AS cant,
            usuario_id_usuario::int AS usuario
     FROM inventario.reserva_inventario
     WHERE nota_venta_id_nota_venta = $1 AND reserva_inventario_estado_reserva = 'activa' ORDER BY 1, 2`, [venta]);
  return rows;
}

describe('Reservar para venta (CU-131)', () => {
  test('lista solo las ventas aprobadas con material suelto, y la vista previa calcula pendiente y disponible', async () => {
    const l = await api('GET', '/api/reservas/ventas', { rol: 'jop' });
    assert.equal(l.status, 200);
    assert.deepEqual(l.body.map(v => v.numero), ['NV-A', 'NV-X']);

    const v = (await api('GET', '/api/reservas/ventas/1')).body;
    assert.equal(v.aprobada, true);
    assert.deepEqual(v.lineas.map(x => [x.sku, x.pedida, x.pendiente, x.disponible, x.faltante]),
      [['MAT-UNO', 3, 3, 1, 2], ['MAT-FIFO', 12, 12, 25, 0]]);
  });

  test('Exc 2: sin stock suficiente → 409 sin mover nada; con parcial reserva lo disponible, FIFO y una reserva por lote', async () => {
    const r = await reservar(1);
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'STOCK_INSUFICIENTE');
    assert.deepEqual(r.body.insuficientes.map(x => [x.sku, x.pendiente, x.disponible]), [['MAT-UNO', 3, 1]]);
    assert.deepEqual(await reservas(), []);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 5 });

    const p = await reservar(1, { parcial: true }, 'jop');
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.equal(p.body.parcial, true);
    assert.deepEqual(await reservas(), [
      { sku: 'MAT-FIFO', lote: 1, cant: 10, usuario: 2 }, { sku: 'MAT-FIFO', lote: 2, cant: 2, usuario: 2 },   // lote viejo primero
      { sku: 'MAT-UNO', lote: 4, cant: 1, usuario: 2 },
    ]);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 17 });
    assert.deepEqual(await db.descuadresDeReservas(), []);
  });

  test('D49: después de una parcial se reserva solo lo pendiente; completa → Exc 3 "ya reservada"', async () => {
    await reservar(1, { parcial: true });
    await db.query(`UPDATE inventario.inventario_bodega SET inventario_bodega_cantidad_fisica = 5
                    WHERE material_sku = 'MAT-UNO' AND lote_id_lote = 4`);   // llegó stock
    const r = await reservar(1);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.lineas, [{ sku: 'MAT-UNO', reservada: 2, faltante: 0, lotes: 1 }]);
    assert.equal((await reservas()).filter(x => x.sku === 'MAT-UNO').reduce((s, x) => s + x.cant, 0), 3);

    const otra = await reservar(1);
    assert.equal(otra.status, 409);
    assert.equal(otra.body.codigo, 'YA_RESERVADA');
    assert.deepEqual(await db.descuadresDeReservas(), []);
  });

  test('D49: lo reservado por CU-124 para esa venta y SKU se descuenta de lo pendiente', async () => {
    await db.query(`UPDATE inventario.inventario_bodega SET inventario_bodega_cantidad_reservada = inventario_bodega_cantidad_reservada + 4
                    WHERE material_sku = 'MAT-FIFO' AND lote_id_lote = 1`);
    await db.query(`INSERT INTO inventario.reserva_inventario (reserva_inventario_cantidad_reservada, reserva_inventario_estado_reserva,
                      material_sku, nota_venta_id_nota_venta, lote_id_lote, bodega_id_bodega) VALUES (4, 'activa', 'MAT-FIFO', 1, 1, 1)`);
    const v = (await api('GET', '/api/reservas/ventas/1')).body;
    assert.equal(v.lineas.find(x => x.sku === 'MAT-FIFO').pendiente, 8);
    await reservar(1, { parcial: true });
    assert.equal((await reservas()).filter(x => x.sku === 'MAT-FIFO').reduce((s, x) => s + x.cant, 0), 12);
    assert.deepEqual(await db.descuadresDeReservas(), []);
  });

  test('Exc 1: una herramienta (o un material inactivo) se salta y se informa; las demás líneas se reservan', async () => {
    const r = await reservar(4);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.omitidas.map(o => o.sku), ['MAT-HERR']);
    assert.deepEqual((await reservas(4)).map(x => x.sku), ['MAT-FIFO']);

    await db.query(`UPDATE inventario.material SET material_estado = 'inactivo' WHERE material_sku = 'MAT-UNO'`);
    const v = (await api('GET', '/api/reservas/ventas/1')).body;
    assert.match(v.lineas.find(x => x.sku === 'MAT-UNO').problema, /inactivo/);
  });

  test('Exc 3: venta pendiente o cancelada → 400; inexistente → 404; nada reservado', async () => {
    assert.equal((await reservar(2)).body.codigo, 'NO_APROBADA');
    assert.equal((await reservar(3)).status, 400);
    assert.equal((await reservar(99)).status, 404);
    assert.equal(await db.contar('inventario.reserva_inventario', 'nota_venta_id_nota_venta IS NOT NULL'), 0);
  });

  test('otros roles no reservan para ventas', async () => {
    const jwt = require('jsonwebtoken');
    const { levantar } = require('./helpers/api');
    const url = await levantar();
    const tecnico = jwt.sign({ id: 2, username: 'jop.test', rol: 'tecnico' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const r = await fetch(url + '/api/reservas/ventas/1', {
      method: 'POST', headers: { Authorization: `Bearer ${tecnico}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403);
  });
});

/* ══════════════════════════════════════════════════════════════════════
   CU-132: gestionar reservas (venta asociada, filtros, motivo, Exc 1 y 3)
   ══════════════════════════════════════════════════════════════════════ */

const liberar = (id, motivo, rol) => api('PUT', `/api/reservas/${id}/liberar`, { body: motivo === undefined ? {} : { motivo }, rol });

describe('Gestionar reservas (CU-132)', () => {
  test('la lista trae la venta, su estado y quién creó la reserva; filtra por venta', async () => {
    await reservar(4);                                         // NV-X: MAT-FIFO 2
    const todas = (await api('GET', '/api/reservas?estado=activa', { rol: 'jop' })).body;
    const r = todas.find(x => x.venta === 'NV-X');
    assert.deepEqual([r.sku, r.venta_estado, r.venta_cancelada, r.creada_por, r.comprometida], ['MAT-FIFO', 'aprobada', false, 'gerente.test', false]);

    const filtradas = (await api('GET', '/api/reservas?venta=nv-x')).body;
    assert.ok(filtradas.length > 0 && filtradas.every(x => x.venta === 'NV-X'));
    assert.deepEqual((await api('GET', '/api/reservas?venta=NO-EXISTE')).body, []);   // Exc 2: sin resultados
  });

  test('liberar con motivo: guarda quién y por qué y devuelve el stock; Exc 1: una segunda vez → 400', async () => {
    await reservar(4);
    const { rows } = await db.query(`SELECT reserva_inventario_id_reserva AS id FROM inventario.reserva_inventario
                                     WHERE nota_venta_id_nota_venta = 4 AND reserva_inventario_estado_reserva = 'activa'`);
    const r = await liberar(rows[0].id, 'El cliente retiró el pedido de la cotización', 'jop');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const { rows: [x] } = await db.query(
      `SELECT reserva_inventario_estado_reserva AS estado, usuario_id_liberacion::int AS usuario, reserva_inventario_motivo_liberacion AS motivo
       FROM inventario.reserva_inventario WHERE reserva_inventario_id_reserva = $1`, [rows[0].id]);
    assert.deepEqual(x, { estado: 'liberada', usuario: 2, motivo: 'El cliente retiró el pedido de la cotización' });
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 5 });
    assert.deepEqual(await db.descuadresDeReservas(), []);

    const otra = await liberar(rows[0].id);
    assert.equal(otra.status, 400);
    const lista = (await api('GET', '/api/reservas?estado=liberada')).body.find(y => y.id === rows[0].id);
    assert.deepEqual([lista.cerrada_por, lista.motivo], ['jop.test', 'El cliente retiró el pedido de la cotización']);
  });

  test('un motivo de más de 500 caracteres → 400 sin cerrar la reserva', async () => {
    await reservar(4);
    const { rows } = await db.query(`SELECT reserva_inventario_id_reserva AS id FROM inventario.reserva_inventario WHERE nota_venta_id_nota_venta = 4`);
    assert.equal((await liberar(rows[0].id, 'x'.repeat(501))).status, 400);
    assert.equal(await db.contar('inventario.reserva_inventario', `nota_venta_id_nota_venta = 4 AND reserva_inventario_estado_reserva = 'activa'`), 1);
  });

  test('una venta cancelada queda marcada para liberar sus reservas', async () => {
    await reservar(4);
    await db.query(`UPDATE finanzas.nota_venta SET estado_pedido = 'cancelada' WHERE id_nota_venta = 4`);
    const r = (await api('GET', '/api/reservas?venta=NV-X')).body[0];
    assert.equal(r.venta_cancelada, true);
  });

  test('Exc 3: una reserva de un pedido de instalación preparado se marca comprometida y no se libera', async () => {
    // Pedido de instalación mínimo en preparado, con una reserva ligada a su ítem
    await db.query(`INSERT INTO inventario.preparacion_pedido (preparacion_pedido_id_preparacion, nota_venta_id_nota_venta)
                    OVERRIDING SYSTEM VALUE VALUES (50, 1)`);
    await db.query(`INSERT INTO inventario.preparacion_pedido_estado (preparacion_pedido_estado_nombre_estado, preparacion_pedido_id_preparacion)
                    VALUES ('vinculado', 50), ('preparado', 50)`);
    await db.query(`INSERT INTO inventario.preparacion_pedido_detalle (preparacion_pedido_detalle_id, preparacion_pedido_id_preparacion,
                      material_sku, preparacion_pedido_detalle_cantidad_requerida, preparacion_pedido_detalle_origen, bodega_id_bodega)
                    OVERRIDING SYSTEM VALUE VALUES (60, 50, 'MAT-FIFO', 1, 'manual', 1)`);
    await db.query(`UPDATE inventario.inventario_bodega SET inventario_bodega_cantidad_reservada = inventario_bodega_cantidad_reservada + 1
                    WHERE material_sku = 'MAT-FIFO' AND lote_id_lote = 1`);
    const { rows } = await db.query(
      `INSERT INTO inventario.reserva_inventario (reserva_inventario_cantidad_reservada, reserva_inventario_estado_reserva, material_sku,
         nota_venta_id_nota_venta, lote_id_lote, bodega_id_bodega, preparacion_pedido_detalle_id)
       VALUES (1, 'activa', 'MAT-FIFO', 1, 1, 1, 60) RETURNING reserva_inventario_id_reserva AS id`);
    const fila = (await api('GET', '/api/reservas?venta=NV-A')).body.find(x => x.id === rows[0].id);
    assert.deepEqual([fila.comprometida, fila.estado_despacho], [true, 'preparado']);
    const r = await liberar(rows[0].id);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /despacho/);
    assert.deepEqual(await db.descuadresDeReservas(), []);
  });

  test('solo gerencia y jop gestionan reservas', async () => {
    const jwt = require('jsonwebtoken');
    const { levantar } = require('./helpers/api');
    const url = await levantar();
    const tecnico = jwt.sign({ id: 2, username: 'jop.test', rol: 'tecnico' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    for (const accion of ['liberar', 'anular']) {
      const r = await fetch(`${url}/api/reservas/1/${accion}`, { method: 'PUT', headers: { Authorization: `Bearer ${tecnico}` } });
      assert.equal(r.status, 403);
    }
  });
});
