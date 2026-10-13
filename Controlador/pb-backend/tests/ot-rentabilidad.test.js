const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * F-10 (D75): costos y precio sugerido de una OT con la fórmula del cliente.
 *
 * Lo que protegen:
 *  - precio = costo de producción / (1 − margen), y después / (1 − reserva de negociación)
 *    (carta de cotización 250380: puertas metálicas / 0,6, antibalas / 0,5, y todo / 0,85).
 *  - El costo de un material es su último precio de compra; sin compras, el referencial.
 *    Costos (CU-93) y rentabilidad (CU-94) valorizan igual.
 *  - El costo adicional por puerta (mano de obra, consumibles) se multiplica por las puertas de la OT.
 *  - Parámetros fuera de rango → 400. Solo gerencia.
 *
 * Semilla: OT 1 con MAT-FIFO y MAT-CRIT sin consumo real. Precio referencial del proveedor 1:
 * MAT-FIFO 1.000 y MAT-CRIT 5.000. MAT-UNO no tiene proveedor ni precio.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => {
  await db.resetear();
  // Consumo real: 10 de MAT-FIFO y 2 de MAT-CRIT. Última compra de MAT-FIFO a 1.200 (gana al referencial 1.000).
  await db.query(`UPDATE inventario.material_orden_trabajo SET material_orden_trabajo_consumo_real = 10
                  WHERE orden_trabajo_id_orden = 1 AND material_sku = 'MAT-FIFO'`);
  await db.query(`UPDATE inventario.material_orden_trabajo SET material_orden_trabajo_consumo_real = 2
                  WHERE orden_trabajo_id_orden = 1 AND material_sku = 'MAT-CRIT'`);
  await db.query(`INSERT INTO inventario.historial_precio_material
                    (material_sku, proveedor_id_proveedor, precio_unitario, fecha_vigencia_desde, fuente)
                  VALUES ('MAT-FIFO', 1, 900, CURRENT_DATE - 30, 'factura'), ('MAT-FIFO', 1, 1200, CURRENT_DATE - 1, 'factura')`);
});
after(async () => { await bajar(); await db.cerrar(); });

const COSTO = 10 * 1200 + 2 * 5000;   // 22.000
const rent = (qs, rol) => api('GET', `/api/ordenes-trabajo/1/rentabilidad?${qs}`, { rol });

describe('Costo de materiales', () => {
  test('último precio de compra; sin compras, el referencial; costos y rentabilidad valorizan igual', async () => {
    const c = await api('GET', '/api/ordenes-trabajo/1/costos');
    assert.equal(c.status, 200);
    const porSku = Object.fromEntries(c.body.detalle.map(d => [d.sku, d]));
    assert.equal(porSku['MAT-FIFO'].precio_unitario, 1200);
    assert.equal(porSku['MAT-FIFO'].fuente_precio, 'historial');
    assert.equal(porSku['MAT-CRIT'].precio_unitario, 5000);
    assert.equal(porSku['MAT-CRIT'].fuente_precio, 'referencial');
    assert.equal(c.body.resumen.costo_total_materiales, COSTO);
    assert.equal(c.body.resumen.con_precio_referencial, 1);

    const r = await rent('margen=40');
    assert.equal(r.body.costo_materiales, COSTO);
    assert.ok(r.body.advertencias.some(a => a.includes('referencial')));
  });

  test('un material sin precio no suma y avisa que el cálculo está incompleto', async () => {
    await db.query(`INSERT INTO inventario.material_orden_trabajo (material_sku, orden_trabajo_id_orden,
                      material_orden_trabajo_consumo_estimado, material_orden_trabajo_consumo_real)
                    VALUES ('MAT-UNO', 1, 1, 1)`);
    const c = await api('GET', '/api/ordenes-trabajo/1/costos');
    assert.equal(c.body.resumen.estado_calculo, 'Estimado/Incompleto');
    assert.equal(c.body.resumen.costo_total_materiales, COSTO);
    const r = await rent('margen=40');
    assert.match(r.body.advertencia, /no tienen precio/);
  });
});

describe('Precio sugerido (D75)', () => {
  test('margen 40 %: precio = costo / 0,6 y la ganancia es la diferencia', async () => {
    const r = await rent('margen=40');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.precio_sugerido, Math.round(COSTO / 0.6));
    assert.equal(r.body.margen_monto, r.body.precio_sugerido - COSTO);
  });

  test('reserva de negociación 15 %: el precio por margen se divide por 0,85', async () => {
    const r = await rent('margen=40&reserva=15');
    assert.equal(r.body.precio_margen, Math.round(COSTO / 0.6));
    assert.equal(r.body.precio_sugerido, Math.round(COSTO / 0.6 / 0.85));
  });

  test('el costo adicional por puerta se multiplica por las puertas de la OT', async () => {
    await db.query(`UPDATE inventario.orden_trabajo SET orden_trabajo_cantidad_puertas = 2 WHERE orden_trabajo_id_orden = 1`);
    const r = await rent('margen=50&adicional=5000');
    assert.equal(r.body.puertas, 2);
    assert.equal(r.body.costo_produccion, COSTO + 10000);
    assert.equal(r.body.precio_sugerido, Math.round((COSTO + 10000) / 0.5));
    assert.equal(r.body.advertencias.some(a => a.includes('cantidad de puertas')), false);
  });

  test('sin puertas registradas, el adicional cuenta 1 puerta y lo avisa', async () => {
    const r = await rent('margen=50&adicional=5000');
    assert.equal(r.body.puertas, 1);
    assert.equal(r.body.costo_produccion, COSTO + 5000);
    assert.ok(r.body.advertencias.some(a => a.includes('cantidad de puertas')));
  });

  test('parámetros fuera de rango → 400', async () => {
    for (const qs of ['margen=0', 'margen=100', 'margen=abc', '', 'margen=40&reserva=100', 'margen=40&reserva=-1', 'margen=40&adicional=-1']) {
      assert.equal((await rent(qs)).status, 400, qs);
    }
  });

  test('una OT sin consumo real → 400; inexistente → 404', async () => {
    await db.query(`UPDATE inventario.material_orden_trabajo SET material_orden_trabajo_consumo_real = NULL WHERE orden_trabajo_id_orden = 1`);
    assert.equal((await rent('margen=40')).status, 400);
    assert.equal((await api('GET', '/api/ordenes-trabajo/999/rentabilidad?margen=40')).status, 404);
  });

  test('solo gerencia', async () => {
    assert.equal((await rent('margen=40', 'jop')).status, 403);
    assert.equal((await api('GET', '/api/ordenes-trabajo/1/costos', { rol: 'jop' })).status, 403);
  });
});
