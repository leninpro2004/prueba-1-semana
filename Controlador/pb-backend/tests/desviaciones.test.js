const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');
const { calcularDiferencial } = require('../src/db/desviaciones');

/**
 * CU-103: finalizar la OT y procesar sus diferenciales de consumo.
 * Semilla: OT 1 en curso con reserva activa; OT 2 finalizada sin materiales; OT 3 en curso.
 * MAT-FIFO referencial 1000, MAT-CRIT 5000 (proveedor principal 1).
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const item = (ot, sku, est, real) => db.query(
  `INSERT INTO inventario.material_orden_trabajo (material_sku, orden_trabajo_id_orden,
     material_orden_trabajo_consumo_estimado, material_orden_trabajo_consumo_real) VALUES ($1, $2, $3, $4)`,
  [sku, ot, est, real]);
const filas = async (ot) => (await db.query(
  `SELECT material_sku AS sku, diferencial_consumo_tipo AS tipo, diferencial_consumo_real::float AS real
   FROM inventario.diferencial_consumo WHERE orden_trabajo_id_orden = $1 ORDER BY 1`, [ot])).rows;

describe('Fórmula (db/desviaciones.js)', () => {
  test('tipos, porcentaje y sin base', () => {
    assert.deepEqual(calcularDiferencial(10, 12), { estimado: 10, real: 12, abs: 2, pct: 20, tipo: 'sobre_gasto' });
    assert.equal(calcularDiferencial(10, 8).tipo, 'ahorro');
    assert.equal(calcularDiferencial(10, 10).tipo, 'sin_desviacion');
    assert.deepEqual(calcularDiferencial(0, 5), { estimado: 0, real: 5, abs: 5, pct: null, tipo: 'sin_base' });
    assert.equal(calcularDiferencial(null, 5).tipo, 'sin_base');
    assert.equal(calcularDiferencial(10, null), null);
  });
});

describe('Procesar diferenciales (CU-103)', () => {
  test('calcula por ítem con el precio vigente a la fecha de la OT; omite los sin consumo', async () => {
    await item(2, 'MAT-FIFO', 10, 12);
    await item(2, 'MAT-CRIT', 4, 3);
    await item(2, 'MAT-UNO', null, 1);   // Exc 2
    await item(2, 'PIN-TEST', 5, null);  // planificado sin consumo
    await db.query(`INSERT INTO inventario.historial_precio_material (material_sku, proveedor_id_proveedor, precio_unitario, fecha_vigencia_desde)
                    VALUES ('MAT-FIFO', 1, 800, '2026-01-01'), ('MAT-FIFO', 1, 1200, '2026-07-01')`);

    const r = await api('POST', '/api/ordenes-trabajo/2/diferenciales');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = Object.fromEntries(r.body.items.map(i => [i.sku, i]));
    assert.equal(p['MAT-FIFO'].tipo, 'sobre_gasto');
    assert.equal(p['MAT-FIFO'].desviacion_pct, 20);
    assert.equal(p['MAT-FIFO'].impacto_clp, 1600, '2 × 800 (vigente el 2026-06-02)');
    assert.equal(p['MAT-CRIT'].tipo, 'ahorro');
    assert.equal(p['MAT-CRIT'].impacto_clp, -5000);
    assert.equal(p['MAT-UNO'].tipo, 'sin_base');
    assert.equal(p['MAT-UNO'].desviacion_pct, null);
    assert.deepEqual(r.body.sin_consumo_registrado.map(s => s.sku), ['PIN-TEST']);
    assert.ok(!('PIN-TEST' in p));
  });

  test('Exc 1: sin real o sin estimado → N/A y no escribe nada', async () => {
    await item(2, 'MAT-FIFO', 10, null);
    const r = await api('POST', '/api/ordenes-trabajo/2/diferenciales');
    assert.equal(r.status, 400);
    assert.equal(r.body.codigo, 'SIN_DATOS');
    assert.deepEqual(await filas(2), []);
  });

  test('solo OTs finalizadas', async () => {
    assert.equal((await api('POST', '/api/ordenes-trabajo/1/diferenciales')).status, 400);
  });

  test('reprocesar actualiza y borra lo que ya no tiene consumo, sin duplicar', async () => {
    await item(2, 'MAT-FIFO', 10, 12);
    await item(2, 'MAT-CRIT', 4, 3);
    await api('POST', '/api/ordenes-trabajo/2/diferenciales');
    await db.query(`UPDATE inventario.material_orden_trabajo SET material_orden_trabajo_consumo_real = 4
                    WHERE orden_trabajo_id_orden = 2 AND material_sku = 'MAT-CRIT'`);
    await db.query(`UPDATE inventario.material_orden_trabajo SET material_orden_trabajo_consumo_real = NULL
                    WHERE orden_trabajo_id_orden = 2 AND material_sku = 'MAT-FIFO'`);
    await api('POST', '/api/ordenes-trabajo/2/diferenciales');
    assert.deepEqual(await filas(2), [{ sku: 'MAT-CRIT', tipo: 'sin_desviacion', real: 4 }]);
  });

  test('jop procesa pero no recibe montos', async () => {
    await item(2, 'MAT-FIFO', 10, 12);
    const r = await api('POST', '/api/ordenes-trabajo/2/diferenciales', { rol: 'jop' });
    assert.equal(r.status, 200);
    assert.ok(!('impacto_clp' in r.body.items[0]));
    assert.ok(!('impacto_neto_clp' in r.body.resumen));
  });
});

describe('Ranking de desviaciones (CU-104)', () => {
  /** Diferencial ya procesado, con los valores que interesan al orden. */
  const dif = (ot, sku, tipo, abs, pct, impacto) => db.query(
    `INSERT INTO inventario.diferencial_consumo (orden_trabajo_id_orden, material_sku, diferencial_consumo_estimado,
       diferencial_consumo_real, diferencial_consumo_desviacion_abs, diferencial_consumo_desviacion_pct,
       diferencial_consumo_tipo, diferencial_consumo_impacto_clp, usuario_id_usuario)
     VALUES ($1, $2, 10, 10 + $3::numeric, $3, $4, $5, $6, 2)`,
    [ot, sku, abs, pct, tipo, impacto]);
  const ranking = (qs, rol) => api('GET', '/api/reportes/desviaciones?' + qs, { rol });
  const TODO = 'desde=2026-06-01&hasta=2026-07-31';

  beforeEach(async () => {
    // OT 4: finalizada en otra área (Pintura) y otro mes
    await db.query(`INSERT INTO inventario.orden_trabajo (orden_trabajo_id_orden, orden_trabajo_fecha_hora,
                      orden_trabajo_estado, area_trabajo_id_area, usuario_id_usuario, proyecto_id_proyecto)
                    OVERRIDING SYSTEM VALUE VALUES (4, '2026-07-10', 'finalizada', 2, 2, 1)`);
    await dif(2, 'MAT-FIFO', 'sobre_gasto', 2, 20, 2000);
    await dif(2, 'MAT-CRIT', 'ahorro', -1, -25, -5000);
    await dif(2, 'MAT-UNO', 'sin_base', 3, null, null);        // sin precio
    await dif(4, 'MAT-CRIT', 'sobre_gasto', 1, 25, 5000);
    await dif(4, 'MAT-FIFO', 'sin_desviacion', 0, 0, 0);
    await dif(4, 'PIN-TEST', 'sobre_gasto', 1, 50, null);       // sin precio, mayor %
  });

  test('solo pérdidas, de mayor a menor impacto; sin precio al final (no planificado primero, luego por %)', async () => {
    const r = await ranking(TODO);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.ranking.map(i => `${i.ot_id}:${i.sku}`),
      ['4:MAT-CRIT', '2:MAT-FIFO', '2:MAT-UNO', '4:PIN-TEST']);
    assert.deepEqual(r.body.ranking.map(i => i.posicion), [1, 2, 3, 4]);
    assert.equal(r.body.ranking[0].area, 'Pintura');
    assert.equal(r.body.ranking[2].sin_precio, true);
    assert.equal(r.body.resumen.impacto_total_clp, 7000);
    assert.equal(r.body.resumen.ahorro, 1);
    assert.equal(r.body.resumen.sin_desviacion, 1);
    assert.equal(r.body.resumen.ots, 2);
  });

  test('filtra por la fecha de la OT y por su área', async () => {
    const junio = await ranking('desde=2026-06-01&hasta=2026-06-30');
    assert.deepEqual(junio.body.ranking.map(i => i.ot_id), [2, 2]);
    const pintura = await ranking(TODO + '&area_id=2');
    assert.deepEqual(pintura.body.ranking.map(i => i.sku), ['MAT-CRIT', 'PIN-TEST']);
    assert.equal(pintura.body.area.nombre, 'Pintura');
  });

  test('Exc 1: rango invertido o fecha inválida → 400', async () => {
    assert.equal((await ranking('desde=2026-07-01&hasta=2026-06-01')).status, 400);
    assert.equal((await ranking('desde=2026-02-30&hasta=2026-06-01')).status, 400);
    assert.equal((await ranking(TODO + '&area_id=abc')).status, 400);
  });

  test('Exc 2: sin diferenciales en el período → mensaje y ranking vacío', async () => {
    const r = await ranking('desde=2025-01-01&hasta=2025-12-31');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.ranking, []);
    assert.match(r.body.mensaje, /Sin resultados/);
  });

  test('jop ve el mismo orden sin montos', async () => {
    const g = await ranking(TODO);
    const j = await ranking(TODO, 'jop');
    assert.equal(j.status, 200);
    assert.deepEqual(j.body.ranking.map(i => `${i.ot_id}:${i.sku}`), g.body.ranking.map(i => `${i.ot_id}:${i.sku}`));
    assert.ok(j.body.ranking.every(i => !('impacto_clp' in i)));
    assert.ok(!('impacto_total_clp' in j.body.resumen));
  });
});

describe('Finalizar OT (CU-103)', () => {
  test('con reserva activa se bloquea y no cambia el estado', async () => {
    const r = await api('PUT', '/api/ordenes-trabajo/1/finalizar', { rol: 'jop' });
    assert.equal(r.status, 400);
    assert.equal(r.body.reservas_activas, 1);
    const { rows } = await db.query(`SELECT orden_trabajo_estado AS e FROM inventario.orden_trabajo WHERE orden_trabajo_id_orden = 1`);
    assert.equal(rows[0].e, 'en_curso');
  });

  test('sin pendientes finaliza; después no admite consumos ni se finaliza de nuevo', async () => {
    assert.equal((await api('PUT', '/api/ordenes-trabajo/3/finalizar')).status, 200);
    const c = await api('POST', '/api/ordenes-trabajo/3/consumos', { body: { sku: 'MAT-FIFO', cantidad: 1, bodega_id: 1 } });
    assert.equal(c.status, 400);
    assert.equal((await api('PUT', '/api/ordenes-trabajo/3/finalizar')).status, 400);
  });
});
