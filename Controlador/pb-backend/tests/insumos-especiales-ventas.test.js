const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');
const { restarDiasHabiles } = require('../src/controllers/insumosEspecialesController');

/**
 * CU-122: revisión de ventas (Finanzas, solo lectura) que genera alertas de compra
 * de insumos especiales en alerta_faltante_pedido con origen 'insumo_especial'.
 *
 * Invariantes: ventas canceladas o de hace más de 60 días no alertan; una puerta
 * aporta sus insumos especiales por la receta (con merma); revisar dos veces no
 * duplica (Exc 3); una alerta cerrada no se reabre; los faltantes de OT y los
 * insumos especiales no se cruzan.
 *
 * Especiales en este test: PIN-TEST (sin proveedor), MAT-CRIT (proveedor 1; va en la
 * receta PB-TEST × 4, merma 0) y MAT-UNO (sin proveedor). MAT-FIFO sigue rotativo.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => {
  await db.resetear();
  await db.query(`UPDATE inventario.material SET material_es_rotativo = FALSE,
                    material_stock_minimo = NULL, material_stock_critico = NULL
                  WHERE material_sku IN ('PIN-TEST', 'MAT-CRIT', 'MAT-UNO')`);
  await db.query(`INSERT INTO finanzas.tipo_cliente (id_tipo_cliente, nombre_tipo_cliente) OVERRIDING SYSTEM VALUE VALUES (1, 'empresa')`);
  await db.query(`INSERT INTO finanzas.cliente_financiero (id_cliente_financiero, rut_cliente, id_tipo_cliente, nombre_razon_social)
                  OVERRIDING SYSTEM VALUE VALUES (1, '11111111-1', 1, 'Cliente de prueba')`);
  // 1 aprobada reciente · 2 cancelada · 3 de hace 90 días · 4 aprobada con el mismo insumo que la 1
  await db.query(`INSERT INTO finanzas.nota_venta (id_nota_venta, numero_nota_venta, id_cliente_financiero, fecha_emision,
                    fecha_max_entrega, estado_pedido)
                  OVERRIDING SYSTEM VALUE VALUES
                    (1, 'NV-T1', 1, CURRENT_DATE - 5,  DATE '2026-10-30', 'aprobada'),
                    (2, 'NV-T2', 1, CURRENT_DATE - 3,  NULL,              'cancelada'),
                    (3, 'NV-T3', 1, CURRENT_DATE - 90, NULL,              'pendiente'),
                    (4, 'NV-T4', 1, CURRENT_DATE - 1,  NULL,              'aprobada')`);
  await linea(1, { sku: 'PIN-TEST', cantidad: 3 });
  await linea(1, { puerta: 1, cantidad: 2 });          // PB-TEST: MAT-CRIT 4 × 2 = 8 (MAT-FIFO es rotativo)
  await linea(1, { sku: 'MAT-FIFO', cantidad: 5 });    // rotativo: no alerta
  await linea(1, { sku: 'MAT-UNO', cantidad: 1 });
  await linea(1, { cantidad: 2 });                     // servicio
  await linea(2, { sku: 'PIN-TEST', cantidad: 2 });
  await linea(3, { sku: 'PIN-TEST', cantidad: 4 });
  await linea(4, { sku: 'PIN-TEST', cantidad: 1 });
});
after(async () => { await bajar(); await db.cerrar(); });

async function linea(venta, { sku = null, puerta = null, cantidad }) {
  await db.query(
    `INSERT INTO finanzas.item_nota_venta (id_nota_venta, id_producto_terminado, sku_material, descripcion_item,
       cantidad, precio_unitario) VALUES ($1, $2, $3, 'línea de prueba', $4, 1000)`,
    [venta, puerta, sku, cantidad]);
}
const alertas = async () => (await db.query(
  `SELECT alerta_faltante_pedido_id_alerta_faltante::int AS id, nota_venta_id_nota_venta::int AS venta, material_sku AS sku,
          alerta_faltante_pedido_cantidad_requerida::float AS requerido, alerta_faltante_pedido_estado AS estado,
          proveedor_id_proveedor::int AS proveedor
   FROM inventario.alerta_faltante_pedido WHERE alerta_faltante_pedido_origen = 'insumo_especial'
   ORDER BY venta, sku`)).rows;
const revisar = () => api('POST', '/api/alertas-faltantes/insumos-especiales/revisar');

describe('Revisión de ventas (CU-122)', () => {
  test('alerta los especiales sueltos y los de la receta; ignora canceladas, antiguas y rotativos', async () => {
    const r = await revisar();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((await alertas()).map(({ venta, sku, requerido, estado, proveedor }) => ({ venta, sku, requerido, estado, proveedor })), [
      { venta: 1, sku: 'MAT-CRIT', requerido: 8, estado: 'activa', proveedor: 1 },
      { venta: 1, sku: 'MAT-UNO',  requerido: 1, estado: 'activa', proveedor: null },   // Exc 2
      { venta: 1, sku: 'PIN-TEST', requerido: 3, estado: 'activa', proveedor: null },
      { venta: 4, sku: 'PIN-TEST', requerido: 1, estado: 'activa', proveedor: null },
    ]);
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM inventario.notificacion
                                     WHERE notificacion_tipo_notificacion = 'insumo_especial' AND usuario_id_usuario = 1`);
    assert.equal(rows[0].n, 1, 'se notifica a gerencia');
  });

  test('Exc 3: revisar de nuevo no duplica; si cambia la cantidad, la actualiza', async () => {
    await revisar();
    const r = await revisar();
    assert.equal(r.body.nuevas, 0);
    await db.query(`UPDATE finanzas.item_nota_venta SET cantidad = 6 WHERE id_nota_venta = 1 AND sku_material = 'PIN-TEST'`);
    const r2 = await revisar();
    assert.equal(r2.body.actualizadas, 1);
    const a = await alertas();
    assert.equal(a.length, 4);
    assert.equal(a.find(x => x.venta === 1 && x.sku === 'PIN-TEST').requerido, 6);
  });

  test('una alerta cerrada por Gerencia no se reabre', async () => {
    await revisar();
    const pin = (await alertas()).find(x => x.venta === 1 && x.sku === 'PIN-TEST');
    const c = await api('PUT', `/api/alertas-faltantes/${pin.id}/resolver`, { body: { accion: 'descartada', motivo: 'Se compra fuera del sistema' } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    await revisar();
    const a = await alertas();
    assert.equal(a.length, 4);
    assert.equal(a.find(x => x.id === pin.id).estado, 'descartada');
  });

  test('si la venta se cancela después, sus alertas abiertas se descartan solas', async () => {
    await revisar();
    await db.query(`UPDATE finanzas.nota_venta SET estado_pedido = 'Cancelada' WHERE id_nota_venta = 1`);
    const r = await revisar();
    assert.equal(r.body.descartadas, 3);
    assert.ok((await alertas()).filter(x => x.venta === 1).every(x => x.estado === 'descartada'));
    assert.equal((await alertas()).find(x => x.venta === 4).estado, 'activa');
  });

  test('no escribe en finanzas', async () => {
    const antes = (await db.query(`SELECT md5(string_agg(t::text, ',' ORDER BY id_item_nota_venta)) AS h FROM finanzas.item_nota_venta t`)).rows[0].h;
    await revisar();
    const despues = (await db.query(`SELECT md5(string_agg(t::text, ',' ORDER BY id_item_nota_venta)) AS h FROM finanzas.item_nota_venta t`)).rows[0].h;
    assert.equal(despues, antes);
  });
});

describe('Faltantes de OT e insumos especiales no se cruzan (CU-122)', () => {
  test('el generador de faltantes no toca las de insumo especial, y su lista no las muestra', async () => {
    await revisar();
    const antes = await alertas();
    // MAT-CRIT en una OT abierta sin proyecto con más de lo que hay: faltante de OT
    await db.query(`UPDATE inventario.orden_trabajo SET proyecto_id_proyecto = NULL WHERE orden_trabajo_id_orden = 3`);
    await db.query(`INSERT INTO inventario.material_orden_trabajo (material_sku, orden_trabajo_id_orden,
                      material_orden_trabajo_consumo_estimado) VALUES ('MAT-CRIT', 3, 50)`);
    const g = await api('POST', '/api/alertas-faltantes/generar');
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.deepEqual(await alertas(), antes);
    const lista = await api('GET', '/api/alertas-faltantes');
    assert.ok(lista.body.length > 0);
    assert.ok(lista.body.every(a => a.proyecto_id !== undefined));
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM inventario.alerta_faltante_pedido WHERE alerta_faltante_pedido_origen = 'faltante'`);
    assert.equal(lista.body.length, rows[0].n, 'la lista de faltantes solo trae origen faltante');
  });

  test('dos ventas del mismo insumo pueden tener cada una su solicitud de compra', async () => {
    await revisar();
    const pins = (await alertas()).filter(x => x.sku === 'PIN-TEST');
    for (const p of pins) {
      const r = await api('PUT', `/api/alertas-faltantes/${p.id}/solicitud`, { body: {} });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
  });
});

describe('Panel y reemplazo (CU-122)', () => {
  test('el panel revisa al abrir y muestra lo necesario para comprar; jop lo ve (CU-124) pero no reemplaza', async () => {
    const r = await api('GET', '/api/alertas-faltantes/insumos-especiales');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.revision.nuevas, 4);
    const crit = r.body.alertas.find(a => a.sku === 'MAT-CRIT');
    assert.equal(crit.venta, 'NV-T1');
    assert.equal(crit.cliente, 'Cliente de prueba');
    assert.equal(crit.venta_estado, 'aprobada');
    assert.equal(crit.entrega_maxima, '2026-10-30');
    assert.equal(crit.proveedor, 'Proveedor Test');
    assert.equal(crit.cubierto_con_stock, true, 'hay 8 de MAT-CRIT y se piden 8');
    assert.equal(r.body.alertas.find(a => a.sku === 'MAT-UNO').sin_proveedor, true);
    assert.equal((await api('GET', '/api/alertas-faltantes/insumos-especiales', { rol: 'jop' })).status, 200);
    const reemplazoJop = await api('POST', `/api/alertas-faltantes/insumos-especiales/${crit.id}/reemplazar`,
      { rol: 'jop', body: { sku_reemplazo: 'MAT-FIFO', motivo: 'Prueba de permisos' } });
    assert.equal(reemplazoJop.status, 403);
  });

  test('Exc 1: reemplazo cierra la alerta y crea otra con la misma venta y cantidad', async () => {
    await revisar();
    await db.query(`UPDATE inventario.material SET material_descontinuado = TRUE WHERE material_sku = 'MAT-UNO'`);
    const uno = (await alertas()).find(x => x.sku === 'MAT-UNO');
    const mal = await api('POST', `/api/alertas-faltantes/insumos-especiales/${uno.id}/reemplazar`, { body: { sku_reemplazo: 'MAT-UNO', motivo: 'x' } });
    assert.equal(mal.status, 400);
    const r = await api('POST', `/api/alertas-faltantes/insumos-especiales/${uno.id}/reemplazar`,
      { body: { sku_reemplazo: 'mat-fifo', motivo: 'Descontinuado por el fabricante' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const a = await alertas();
    assert.equal(a.find(x => x.id === uno.id).estado, 'descartada');
    const nueva = a.find(x => x.id === Number(r.body.alerta_nueva));
    assert.deepEqual({ venta: nueva.venta, sku: nueva.sku, requerido: nueva.requerido, proveedor: nueva.proveedor },
                     { venta: 1, sku: 'MAT-FIFO', requerido: 1, proveedor: 1 });
    await revisar();
    assert.equal((await alertas()).length, 5, 'la revisión no recrea la del material reemplazado');
  });

  test('comprar a más tardar resta días hábiles', () => {
    assert.equal(restarDiasHabiles('2026-10-05', 1), '2026-10-02');   // lunes → viernes
    assert.equal(restarDiasHabiles('2026-10-30', 5), '2026-10-23');
    assert.equal(restarDiasHabiles(null, 5), null);
  });
});
