const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * F-08 (D74): medidas de la puerta en la OT y receta por fórmula.
 *
 * Lo que protegen:
 *  - las medidas se validan antes de guardar: un rechazo no cambia la OT;
 *  - una OT cerrada no cambia sus medidas;
 *  - la línea por fórmula se calcula con las medidas de la OT (× merma × puertas);
 *  - sin medidas, la línea por fórmula NO lleva un número inventado (ni en la precarga ni al
 *    cargar la receta en la OT); las líneas de cantidad fija siguen igual.
 *
 * Semilla: receta 1 (PB-TEST) = MAT-FIFO 2 (merma 0,25) + MAT-CRIT 4, área 1; OT 3 abierta del
 * área 1 vinculada a la receta 1; OT 2 cerrada.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const PUERTA = { vano_ancho_mm: 1000, vano_alto_mm: 2100, hojas: 1, mdf: false, perfil_marco_mm: 20 };
// marco 995 × 2095 → (2 × 2095 + 995) / 1000 = 5.185 por puerta
const FORMULA_MARCO = '(2 * marco_alto + marco_ancho) / 1000';

const medidasDe = async (otId) => (await db.query(
  `SELECT orden_trabajo_medidas AS m FROM inventario.orden_trabajo WHERE orden_trabajo_id_orden = $1`, [otId])).rows[0].m;

const ponerFormula = (sku, formula) => db.query(
  `UPDATE inventario.material_producto_terminado SET material_producto_terminado_formula = $2
   WHERE producto_terminado_id_producto = 1 AND material_sku = $1`, [sku, formula]);

describe('Guardar las medidas de la OT', () => {
  test('guarda las medidas normalizadas (coma decimal, texto) con origen manual', async () => {
    const r = await api('PUT', '/api/ordenes-trabajo/3/medidas', {
      rol: 'jop', body: { medidas: { vano_ancho_mm: '948,5', vano_alto_mm: 2045, hojas: '1', mdf: true, perfil_marco_mm: 20 } },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await medidasDe(3),
      { vano_ancho_mm: 948.5, vano_alto_mm: 2045, hojas: 1, mdf: true, perfil_marco_mm: 20, origen: 'manual' });
  });

  test('medidas inválidas → 400 con cada campo y la OT no cambia', async () => {
    await api('PUT', '/api/ordenes-trabajo/3/medidas', { body: { medidas: PUERTA } });
    const r = await api('PUT', '/api/ordenes-trabajo/3/medidas', {
      body: { medidas: { vano_ancho_mm: 'abc', vano_alto_mm: 0, hojas: 1.5, perfil_marco_mm: 20 } },
    });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.errores.map(e => e.campo).sort(), ['hojas', 'vano_alto_mm', 'vano_ancho_mm']);
    assert.equal((await medidasDe(3)).vano_ancho_mm, 1000);
  });

  test('un perfil que deja el bastidor sin tamaño se rechaza', async () => {
    const r = await api('PUT', '/api/ordenes-trabajo/3/medidas', {
      body: { medidas: { ...PUERTA, vano_ancho_mm: 200, perfil_marco_mm: 100 } },
    });
    assert.equal(r.status, 400);
    assert.equal(await medidasDe(3), null);
  });

  test('solo 1 o 2 hojas', async () => {
    const r = await api('PUT', '/api/ordenes-trabajo/3/medidas', { body: { medidas: { ...PUERTA, hojas: 3 } } });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.errores.map(e => e.campo), ['hojas']);
    assert.equal(await medidasDe(3), null);
  });

  test('sin el campo medidas → 400; con null se quitan', async () => {
    assert.equal((await api('PUT', '/api/ordenes-trabajo/3/medidas', { body: {} })).status, 400);
    await api('PUT', '/api/ordenes-trabajo/3/medidas', { body: { medidas: PUERTA } });
    const r = await api('PUT', '/api/ordenes-trabajo/3/medidas', { body: { medidas: null } });
    assert.equal(r.status, 200);
    assert.equal(await medidasDe(3), null);
  });

  test('una OT cerrada no cambia sus medidas; una inexistente da 404', async () => {
    const r = await api('PUT', '/api/ordenes-trabajo/2/medidas', { body: { medidas: PUERTA } });
    assert.equal(r.status, 400);
    assert.equal(await medidasDe(2), null);
    assert.equal((await api('PUT', '/api/ordenes-trabajo/999/medidas', { body: { medidas: PUERTA } })).status, 404);
  });
});

describe('Receta por fórmula en la OT', () => {
  test('con medidas: la fórmula × merma × puertas; la línea fija sigue igual', async () => {
    await ponerFormula('MAT-CRIT', FORMULA_MARCO);
    await ponerFormula('MAT-FIFO', 'vano_ancho / 1000');   // 1 por puerta, merma 0,25
    await api('PUT', '/api/ordenes-trabajo/3/medidas', { body: { medidas: PUERTA } });

    const r = await api('GET', '/api/recetas/por-orden/3?puertas=2');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.orden.medidas, { ...PUERTA, origen: 'manual' });
    assert.equal(r.body.orden.derivadas.alojamiento_alto, 2075);   // marco de 3 lados: 2095 − 20
    const crit = r.body.materiales.find(m => m.sku === 'MAT-CRIT');
    const fifo = r.body.materiales.find(m => m.sku === 'MAT-FIFO');
    assert.equal(crit.cantidad_total, 10.37);
    assert.equal(crit.falta_medida, null);
    assert.equal(fifo.cantidad_total, 2.5);
  });

  test('sin medidas: la línea por fórmula va sin cantidad y con el motivo', async () => {
    await ponerFormula('MAT-CRIT', FORMULA_MARCO);

    const r = await api('GET', '/api/recetas/por-orden/3');
    const crit = r.body.materiales.find(m => m.sku === 'MAT-CRIT');
    assert.equal(crit.cantidad_total, null);
    assert.match(crit.falta_medida, /medidas/);
    assert.equal(r.body.materiales.find(m => m.sku === 'MAT-FIFO').cantidad_total, 2.5);
  });

  test('cargar la receta en la OT sin medidas omite la línea por fórmula', async () => {
    await ponerFormula('MAT-CRIT', FORMULA_MARCO);

    const r = await api('POST', '/api/recetas/1/cargar-en-ot/3');
    assert.equal(r.status, 200);
    assert.equal(r.body.agregados, 1);
    assert.equal(r.body.omitidos, 1);
    const { rows } = await db.query(
      `SELECT 1 FROM inventario.material_orden_trabajo WHERE orden_trabajo_id_orden = 3 AND material_sku = 'MAT-CRIT'`);
    assert.equal(rows.length, 0);
  });

  test('cargar la receta en la OT con medidas usa la fórmula', async () => {
    await ponerFormula('MAT-CRIT', FORMULA_MARCO);
    await api('PUT', '/api/ordenes-trabajo/3/medidas', { body: { medidas: PUERTA } });

    const r = await api('POST', '/api/recetas/1/cargar-en-ot/3');
    assert.equal(r.body.agregados, 2);
    const { rows } = await db.query(
      `SELECT material_orden_trabajo_consumo_estimado::float AS e FROM inventario.material_orden_trabajo
       WHERE orden_trabajo_id_orden = 3 AND material_sku = 'MAT-CRIT'`);
    assert.equal(rows[0].e, 5.185);
  });
});
