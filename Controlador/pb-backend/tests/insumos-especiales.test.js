const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * CU-123: insumo especial / no rotativo (material_es_rotativo = FALSE).
 *
 * Invariantes: un especial no tiene umbrales de reposición (se guardan en NULL
 * aunque vengan en el cuerpo), no genera alertas de stock, y al pasar a especial
 * se resuelven sus alertas de stock activas, pero NO las de diferencia de conteo
 * (CU-57), que no dependen de los umbrales. La descripción es obligatoria en los
 * especiales (decisión del usuario, sesión 11).
 *
 * Semilla: MAT-UNO tiene 1 unidad en la bodega 1 y no tiene umbrales; MAT-FIFO
 * tiene mínimo 5 y crítico 2.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const material = async (sku) => (await db.query(
  `SELECT material_es_rotativo AS rotativo, material_stock_minimo AS min, material_stock_maximo AS max,
          material_stock_critico AS crit
   FROM inventario.material WHERE material_sku = $1`, [sku])).rows[0];
const alertasActivas = async (sku) => (await db.query(
  `SELECT alerta_inventario_id_alerta AS id, conteo_ciclico_id_conteo AS conteo
   FROM inventario.alerta_inventario WHERE material_sku = $1 AND alerta_inventario_estado = 'activa' ORDER BY 1`,
  [sku])).rows;

const ESPECIAL = {
  sku: 'ESP-001', nombre: 'Pintura especial de prueba', descripcion: 'Color a pedido', unidad_medida_id: 3,
  es_rotativo: false, stock_minimo: 5, stock_maximo: 20, stock_critico: 2,
};

describe('Crear insumo especial (CU-123)', () => {
  test('queda no rotativo, sin umbrales aunque vengan, y sin stock', async () => {
    const r = await api('POST', '/api/materiales', { body: ESPECIAL });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(await material('ESP-001'), { rotativo: false, min: null, max: null, crit: null });
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM inventario.inventario_bodega WHERE material_sku = 'ESP-001'`);
    assert.equal(rows[0].n, 0);
  });

  test('Exc 1: nombra todos los campos que faltan; en un especial, también la descripción', async () => {
    const r = await api('POST', '/api/materiales', { body: { sku: 'ESP-002', es_rotativo: false } });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.campos_faltantes, ['nombre', 'unidad de medida', 'descripción']);
    const estandar = await api('POST', '/api/materiales', { body: { sku: 'EST-001', nombre: 'Estándar', unidad_medida_id: 1 } });
    assert.equal(estandar.status, 201, 'un producto estándar sigue sin exigir descripción');
  });

  test('Exc 2: SKU repetido (sin importar mayúsculas) → 409 con el producto existente', async () => {
    const r = await api('POST', '/api/materiales', { body: { ...ESPECIAL, sku: 'mat-fifo' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.existente.sku, 'MAT-FIFO');
    assert.equal(r.body.existente.es_rotativo, true);
    assert.match(r.body.error, /producto estándar/);
  });
});

describe('Editar a insumo especial (CU-123)', () => {
  test('limpia los umbrales y resuelve las alertas de stock, no las de conteo', async () => {
    // Alerta de stock bajo mínimo (con historial) y alerta por diferencia de conteo
    const { rows: h } = await db.query(`INSERT INTO inventario.historial_alerta DEFAULT VALUES RETURNING historial_alerta_id_historial AS id`);
    await db.query(
      `INSERT INTO inventario.alerta_inventario (alerta_inventario_mensaje, alerta_inventario_estado, material_sku,
         alerta_inventario_tipo_alerta_id_tipo_alerta, historial_alerta_id_historial)
       VALUES ('Stock bajo', 'activa', 'MAT-FIFO', 6, $1)`, [h[0].id]);
    const { rows: c } = await db.query(
      `INSERT INTO inventario.conteo_ciclico (bodega_id_bodega, usuario_id_usuario) VALUES (1, 1)
       RETURNING conteo_ciclico_id_conteo AS id`);
    await db.query(
      `INSERT INTO inventario.alerta_inventario (alerta_inventario_mensaje, alerta_inventario_estado, material_sku,
         alerta_inventario_tipo_alerta_id_tipo_alerta, conteo_ciclico_id_conteo)
       VALUES ('Diferencia de conteo', 'activa', 'MAT-FIFO', 7, $1)`, [c[0].id]);

    const r = await api('PUT', '/api/materiales/MAT-FIFO', {
      body: { es_rotativo: false, descripcion: 'Ahora a pedido', stock_minimo: 8, stock_critico: 3 },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.alertas_resueltas, 1);
    assert.deepEqual(await material('MAT-FIFO'), { rotativo: false, min: null, max: null, crit: null });
    const activas = await alertasActivas('MAT-FIFO');
    assert.equal(activas.length, 1);
    assert.equal(String(activas[0].conteo), String(c[0].id), 'la de conteo sigue activa');
    const { rows: hist } = await db.query(
      `SELECT historial_alerta_fecha_hora_resolucion AS f FROM inventario.historial_alerta WHERE historial_alerta_id_historial = $1`,
      [h[0].id]);
    assert.ok(hist[0].f, 'el historial queda fechado');
  });

  test('sin descripción no se puede pasar a especial, y no cambia nada', async () => {
    const r = await api('PUT', '/api/materiales/MAT-FIFO', { body: { es_rotativo: false } });
    assert.equal(r.status, 400);
    assert.equal((await material('MAT-FIFO')).rotativo, true);
    assert.equal(parseFloat((await material('MAT-FIFO')).min), 5);
  });

  test('un especial ya guardado ignora los umbrales que le envíen', async () => {
    await api('PUT', '/api/materiales/MAT-UNO', { body: { es_rotativo: false, descripcion: 'A pedido' } });
    const r = await api('PUT', '/api/materiales/MAT-UNO', { body: { nombre: 'Renombrado', stock_minimo: 4 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await material('MAT-UNO')).min, null);
  });
});

describe('Alertas de stock (CU-123)', () => {
  test('el generador no crea alertas de stock para un especial', async () => {
    // Umbrales puestos a la fuerza en la BD (datos antiguos): 1 unidad bajo un mínimo de 5
    await db.query(`UPDATE inventario.material SET material_stock_minimo = 5, material_es_rotativo = FALSE
                    WHERE material_sku = 'MAT-UNO'`);
    assert.equal((await api('POST', '/api/alertas/generar')).status < 300, true);
    assert.deepEqual(await alertasActivas('MAT-UNO'), []);

    // Control: el mismo material, rotativo, sí la genera
    await db.query(`UPDATE inventario.material SET material_es_rotativo = TRUE WHERE material_sku = 'MAT-UNO'`);
    await api('POST', '/api/alertas/generar');
    assert.equal((await alertasActivas('MAT-UNO')).length, 1);
  });
});
