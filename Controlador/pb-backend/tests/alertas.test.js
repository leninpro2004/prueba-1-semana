const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * Alertas de inventario: generacion y filtros.
 *
 * Lo que protegen:
 *  - el generador elige el tipo por match EXACTO. Antes usaba `includes`, asi que
 *    "stock critico" coincidia con dos tipos del catalogo a la vez y se quedaba
 *    con el que Postgres devolviera primero — un orden que la consulta no fija.
 *  - los 4 filtros de OPUS-17 (prioridad, estado, tipo, solo_criticos) se combinan
 *    con AND, y el de tipo NO arrastra tipos de nombre parecido.
 *
 * La semilla trae MAT-FIFO (minimo 5, critico 2) y MAT-CRIT (minimo 5, critico 2,
 * marcado como material critico).
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

/** Deja el stock de un material en la cantidad pedida, sin pasar por la API. */
async function fijarStock(sku, cantidad) {
  await db.query(
    `UPDATE inventario.inventario_bodega SET inventario_bodega_cantidad_fisica = 0
     WHERE material_sku = $1`, [sku]
  );
  await db.query(
    `UPDATE inventario.inventario_bodega SET inventario_bodega_cantidad_fisica = $2
     WHERE material_sku = $1 AND lote_id_lote = (
       SELECT MIN(lote_id_lote) FROM inventario.inventario_bodega WHERE material_sku = $1)`,
    [sku, cantidad]
  );
}

/** Alertas activas de un material, con su tipo y prioridad. */
async function alertasDe(sku) {
  const { rows } = await db.query(
    `SELECT ta.alerta_inventario_tipo_alerta_nombre AS tipo,
            np.alerta_inventario_prioridad_nombre   AS prioridad,
            a.alerta_inventario_estado              AS estado
       FROM inventario.alerta_inventario a
       JOIN inventario.alerta_inventario_tipo_alerta ta
            ON ta.alerta_inventario_tipo_alerta_id_tipo_alerta = a.alerta_inventario_tipo_alerta_id_tipo_alerta
       JOIN inventario.alerta_inventario_nivel_prioridad np
            ON np.alerta_inventario_nivel_prioridad_id_nivel_prioridad = ta.alerta_inventario_nivel_prioridad_id
      WHERE a.material_sku = $1`,
    [sku]
  );
  return rows;
}

describe('Generación de alertas', () => {
  test('stock bajo el crítico genera una alerta del tipo crítico', async () => {
    await fijarStock('MAT-FIFO', 1);   // crítico = 2

    const r = await api('POST', '/api/alertas/generar');

    assert.equal(r.status, 200);
    const alertas = await alertasDe('MAT-FIFO');
    assert.equal(alertas.length, 1);
    assert.equal(alertas[0].tipo, 'stock_critico');
    assert.equal(alertas[0].prioridad, 'urgente');
  });

  test('stock entre el crítico y el mínimo genera la alerta de stock bajo mínimo', async () => {
    await fijarStock('MAT-FIFO', 4);   // crítico = 2, mínimo = 5

    await api('POST', '/api/alertas/generar');

    const alertas = await alertasDe('MAT-FIFO');
    assert.equal(alertas.length, 1);
    assert.equal(alertas[0].tipo, 'stock bajo minimo');
    assert.equal(alertas[0].prioridad, 'alta');
  });

  test('stock sobre el mínimo no genera alerta', async () => {
    await fijarStock('MAT-FIFO', 30);

    await api('POST', '/api/alertas/generar');

    assert.equal((await alertasDe('MAT-FIFO')).length, 0);
  });

  test('generar dos veces no duplica la alerta', async () => {
    await fijarStock('MAT-FIFO', 1);

    await api('POST', '/api/alertas/generar');
    await api('POST', '/api/alertas/generar');

    assert.equal((await alertasDe('MAT-FIFO')).length, 1);
  });

  test('si el stock se repone, la alerta activa se resuelve', async () => {
    await fijarStock('MAT-FIFO', 1);
    await api('POST', '/api/alertas/generar');

    await fijarStock('MAT-FIFO', 30);
    await api('POST', '/api/alertas/generar');

    const alertas = await alertasDe('MAT-FIFO');
    assert.equal(alertas.length, 1);
    assert.equal(alertas[0].estado, 'resuelta');
  });
});

describe('Filtros de alertas (OPUS-17)', () => {
  /** Deja una alerta crítica en MAT-CRIT (material crítico) y una en MAT-FIFO (no crítico). */
  async function sembrarAlertas() {
    await fijarStock('MAT-CRIT', 1);   // -> stock_critico
    await fijarStock('MAT-FIFO', 4);   // -> stock bajo minimo
    await api('POST', '/api/alertas/generar');
  }

  test('sin filtros trae las dos', async () => {
    await sembrarAlertas();

    const r = await api('GET', '/api/alertas');

    assert.equal(r.status, 200);
    assert.equal(r.body.length, 2);
  });

  test('solo_criticos deja únicamente las de materiales críticos', async () => {
    await sembrarAlertas();

    const r = await api('GET', '/api/alertas?solo_criticos=true');

    assert.equal(r.body.length, 1);
    assert.equal(r.body[0].sku, 'MAT-CRIT');
    assert.equal(r.body[0].es_critico, true);
  });

  test('solo_criticos=false NO filtra', async () => {
    await sembrarAlertas();

    const r = await api('GET', '/api/alertas?solo_criticos=false');

    assert.equal(r.body.length, 2);
  });

  test('el filtro por tipo es exacto: no arrastra tipos de nombre parecido', async () => {
    await sembrarAlertas();

    const critico = await api('GET', '/api/alertas?tipo=stock_critico');
    const bajo    = await api('GET', '/api/alertas?tipo=stock bajo minimo');

    assert.equal(critico.body.length, 1);
    assert.equal(critico.body[0].tipo, 'stock_critico');
    assert.equal(bajo.body.length, 1);
    assert.equal(bajo.body[0].tipo, 'stock bajo minimo');
  });

  test('los filtros se combinan con AND', async () => {
    await sembrarAlertas();

    // MAT-FIFO tiene la alerta de stock bajo mínimo, pero NO es material crítico
    const r = await api('GET', '/api/alertas?tipo=stock bajo minimo&solo_criticos=true');

    assert.equal(r.body.length, 0);
  });

  test('un tipo inexistente devuelve lista vacía', async () => {
    await sembrarAlertas();

    const r = await api('GET', '/api/alertas?tipo=no-existe');

    assert.equal(r.status, 200);
    assert.equal(r.body.length, 0);
  });

  test('el catálogo de tipos solo ofrece los que tienen alertas', async () => {
    await sembrarAlertas();

    const r = await api('GET', '/api/alertas/tipos');

    assert.equal(r.status, 200);
    // 'tiempo reposicion' está en el catálogo pero sin alertas: no debe aparecer
    assert.deepEqual(r.body.sort(), ['stock bajo minimo', 'stock_critico']);
  });
});
