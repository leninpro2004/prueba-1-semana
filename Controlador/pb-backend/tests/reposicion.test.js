const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * Evaluación de cobertura contra el plazo del proveedor (CU-47).
 *
 * Lo que protegen:
 *  - el consumo diario sale de los últimos 90 días, SIN revertidos, inversos ni
 *    traslados, y restando las devoluciones de consumo de OT
 *  - días restantes = disponible ÷ consumo, comparado con el plazo en días
 *    CORRIDOS (hábiles × 7/5)
 *  - las tres excepciones y el proveedor recomendado (el principal, con aviso si
 *    otro es más rápido o más barato)
 *  - reevaluar no duplica, y el generador automático no apaga las preventivas
 *  - evaluar no mueve stock
 *
 * Semilla: MAT-FIFO tiene 30 físicas y 5 reservadas → 25 disponibles, proveedor 1
 * principal (precio 1000). Con 90 de consumo en 90 días (1/día) le quedan 25 días.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const evaluar = (rol = 'gerencia') => api('POST', '/api/alertas/reposicion/evaluar', { rol });

/** Movimiento directo en BD, con la antigüedad pedida (no mueve stock). */
async function movimiento({ sku = 'MAT-FIFO', tipo = 2, cantidad, estado = 'completado', dias = 1,
                            motivo = null, ot = null, revierte = null }) {
  const { rows } = await db.query(
    `INSERT INTO inventario.movimiento_inventario (
       movimiento_inventario_cantidad, movimiento_inventario_estado, material_sku, bodega_id_bodega,
       usuario_id_usuario, movimiento_inventario_tipo_movimiento_id_tipo_movimiento,
       movimiento_inventario_motivo_movimiento_id_motivo_movimiento, orden_trabajo_id_orden,
       movimiento_inventario_id_revertido, movimiento_inventario_fecha_hora)
     VALUES ($1, $2, $3, 1, 1, $4, $5, $6, $7, now() - make_interval(days => $8))
     RETURNING movimiento_inventario_id_movimiento AS id`,
    [cantidad, estado, sku, tipo, motivo, ot, revierte, dias]
  );
  return rows[0].id;
}

/** Plazo (días hábiles) y datos del proveedor de un material. */
async function proveedor(sku, proveedorId, { plazo = null, precio = null, principal = false, minimo = null } = {}) {
  await db.query(
    `INSERT INTO inventario.material_proveedor (material_sku, proveedor_id_proveedor,
       material_proveedor_tiempo_reposicion, material_proveedor_precio_referencial,
       material_proveedor_proveedor_principal, material_proveedor_cantidad_minima)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (material_sku, proveedor_id_proveedor) DO UPDATE SET
       material_proveedor_tiempo_reposicion   = EXCLUDED.material_proveedor_tiempo_reposicion,
       material_proveedor_precio_referencial  = EXCLUDED.material_proveedor_precio_referencial,
       material_proveedor_proveedor_principal = EXCLUDED.material_proveedor_proveedor_principal,
       material_proveedor_cantidad_minima     = EXCLUDED.material_proveedor_cantidad_minima`,
    [sku, proveedorId, plazo, precio, principal, minimo]
  );
}

/** Alertas de un material por tipo, con lo que registra CU-47. */
async function alertas(sku, estado = 'activa') {
  const { rows } = await db.query(
    `SELECT ta.alerta_inventario_tipo_alerta_nombre AS tipo, a.alerta_inventario_estado AS estado,
            a.proveedor_id_proveedor::int AS proveedor, a.alerta_inventario_cantidad_sugerida::float AS sugerida,
            to_char(a.alerta_inventario_fecha_est_agotamiento, 'YYYY-MM-DD') AS agotamiento,
            a.alerta_inventario_mensaje AS mensaje, ha.historial_alerta_fecha_hora_resolucion AS resuelta_en
     FROM inventario.alerta_inventario a
     JOIN inventario.alerta_inventario_tipo_alerta ta
       ON ta.alerta_inventario_tipo_alerta_id_tipo_alerta = a.alerta_inventario_tipo_alerta_id_tipo_alerta
     LEFT JOIN inventario.historial_alerta ha ON ha.historial_alerta_id_historial = a.historial_alerta_id_historial
     WHERE a.material_sku = $1 AND ($2::text IS NULL OR a.alerta_inventario_estado = $2)
     ORDER BY a.alerta_inventario_id_alerta`,
    [sku, estado]
  );
  return rows;
}

function hoyMas(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('Evaluación de cobertura (CU-47)', () => {
  test('días restantes <= plazo en días corridos: alerta preventiva completa', async () => {
    await proveedor('MAT-FIFO', 1, { plazo: 20, precio: 1000, principal: true, minimo: 10 });   // 20 hábiles = 28 corridos
    await movimiento({ cantidad: 90, dias: 10 });            // 1 por día
    await movimiento({ cantidad: 900, dias: 100 });          // fuera de la ventana: no cuenta

    const r = await evaluar();
    assert.equal(r.status, 200);
    assert.equal(r.body.preventivas.length, 1);
    const p = r.body.preventivas[0];
    assert.equal(p.sku, 'MAT-FIFO');
    assert.equal(p.dias_restantes, 25);
    assert.equal(p.plazo_dias_corridos, 28);

    const [a] = await alertas('MAT-FIFO');
    assert.equal(a.tipo, 'tiempo reposicion');
    assert.equal(a.proveedor, 1);
    assert.equal(a.agotamiento, hoyMas(25));
    assert.equal(a.sugerida, 28, 'max(sin stock máximo, 1/día × 28 días, mínimo 10)');
  });

  test('días restantes > plazo: sin alerta', async () => {
    await proveedor('MAT-FIFO', 1, { plazo: 10, principal: true });   // 14 corridos < 25 días
    await movimiento({ cantidad: 90 });

    const r = await evaluar();
    assert.equal(r.body.preventivas.length, 0);
    assert.equal((await alertas('MAT-FIFO')).length, 0);
  });

  test('cantidad sugerida: completa hasta el stock máximo si es mayor', async () => {
    await db.query(`UPDATE inventario.material SET material_stock_maximo = 100 WHERE material_sku = 'MAT-FIFO'`);
    await proveedor('MAT-FIFO', 1, { plazo: 20, principal: true });
    await movimiento({ cantidad: 90 });

    await evaluar();
    assert.equal((await alertas('MAT-FIFO'))[0].sugerida, 75, '100 − 25 disponibles');
  });

  test('revertidos, inversos y traslados no son consumo; las devoluciones de OT restan', async () => {
    await proveedor('MAT-FIFO', 1, { plazo: 20, principal: true });
    await db.query(
      `INSERT INTO inventario.movimiento_inventario_clasificacion_salida
         (movimiento_inventario_clasificacion_salida_id_clasificacion_sal, movimiento_inventario_clasificacion_salida_nombre)
       OVERRIDING SYSTEM VALUE VALUES (9, 'Traslado')`
    );
    await db.query(
      `INSERT INTO inventario.movimiento_inventario_motivo_movimiento
         (movimiento_inventario_motivo_movimiento_id_motivo_movimiento, movimiento_inventario_motivo_movimiento_nombre,
          movimiento_inventario_clasificacion_salida_id_clasificacion_sal)
       OVERRIDING SYSTEM VALUE VALUES (9, 'traslado_bodega', 9)`
    );
    const original = await movimiento({ cantidad: 90, estado: 'revertido' });
    await movimiento({ tipo: 1, cantidad: 90, revierte: original });    // su inverso (entrada)
    await movimiento({ cantidad: 500, motivo: 9 });                      // traslado

    let r = await evaluar();
    assert.deepEqual(r.body.sin_rotacion.map(s => s.sku).filter(s => s === 'MAT-FIFO'), ['MAT-FIFO']);

    // 90 de consumo menos 45 devueltos desde la OT: 0,5/día → 50 días > 28
    await movimiento({ cantidad: 90, ot: 1 });
    await movimiento({ tipo: 1, cantidad: 45, ot: 1 });
    r = await evaluar();
    assert.equal(r.body.preventivas.length, 0);
    assert.ok(!r.body.sin_rotacion.some(s => s.sku === 'MAT-FIFO'));
  });

  test('una devolución sin OT resta si su motivo es devolucion_consumo; un ajuste_inventario no', async () => {
    await proveedor('MAT-FIFO', 1, { plazo: 20, principal: true });   // 28 corridos
    await movimiento({ cantidad: 90 });                               // 1/día → 25 días: preventiva

    // Una entrada con ajuste_inventario (p. ej. un futuro ajuste por conteo) no es devolución de consumo
    await movimiento({ tipo: 1, cantidad: 45, motivo: 4 });
    let r = await evaluar();
    assert.equal(r.body.preventivas.length, 1);

    // Devolución de una pintura sin OT: 90 − 45 = 0,5/día → 50 días > 28
    await movimiento({ tipo: 1, cantidad: 45, motivo: 6 });
    r = await evaluar();
    assert.equal(r.body.preventivas.length, 0);
    assert.ok(!r.body.sin_rotacion.some(s => s.sku === 'MAT-FIFO'));
  });

  test('Exc 1: sin proveedor con plazo → pendiente de configuración, sin alerta', async () => {
    await movimiento({ sku: 'MAT-CRIT', cantidad: 90 });   // proveedor 1 sin plazo
    await movimiento({ sku: 'MAT-UNO', cantidad: 9 });     // sin proveedor

    const r = await evaluar();
    const pend = Object.fromEntries(r.body.pendientes_configuracion.map(p => [p.sku, p.motivo]));
    assert.match(pend['MAT-CRIT'], /plazo/);
    assert.match(pend['MAT-UNO'], /Sin proveedor/);
    assert.equal((await alertas('MAT-CRIT')).length, 0);
    assert.equal((await alertas('MAT-UNO')).length, 0);
  });

  test('Exc 2: consumo cero → sin rotación, sin alerta', async () => {
    await proveedor('MAT-FIFO', 1, { plazo: 20, principal: true });
    const r = await evaluar();
    assert.ok(r.body.sin_rotacion.some(s => s.sku === 'MAT-FIFO'));
    assert.equal((await alertas('MAT-FIFO')).length, 0);
  });

  test('Exc 3: sin stock disponible → alerta crítica, no preventiva', async () => {
    await proveedor('MAT-FIFO', 1, { plazo: 20, principal: true });
    await movimiento({ cantidad: 90 });
    await db.query(`UPDATE inventario.inventario_bodega SET inventario_bodega_cantidad_fisica = 0,
                    inventario_bodega_cantidad_reservada = 0 WHERE material_sku = 'MAT-FIFO'`);

    const r = await evaluar();
    assert.equal(r.body.criticas.length, 1);
    assert.equal(r.body.preventivas.length, 0);
    const act = await alertas('MAT-FIFO');
    assert.equal(act.length, 1);
    assert.equal(act[0].tipo, 'stock_critico');
    assert.equal(act[0].proveedor, 1);
    assert.equal(act[0].agotamiento, hoyMas(0));
  });

  test('proveedor: se recomienda el principal y se avisa si otro es más rápido o más barato, sin montos', async () => {
    await proveedor('MAT-FIFO', 1, { plazo: 20, precio: 1000, principal: true });
    await proveedor('MAT-FIFO', 2, { plazo: 5, precio: 800 });
    await movimiento({ cantidad: 90 });

    const r = await evaluar();
    const p = r.body.preventivas[0];
    assert.equal(p.proveedor, 'Proveedor Test');
    assert.equal(p.notas.length, 2);
    const [a] = await alertas('MAT-FIFO');
    assert.equal(a.proveedor, 1);
    assert.match(a.mensaje, /Proveedor Sin Uso entrega en 5/);
    assert.match(a.mensaje, /precio referencial menor/);
    assert.doesNotMatch(a.mensaje, /800|1000|1\.000/, 'el mensaje no lleva montos (jop lo ve)');
  });

  test('proveedor: sin plazo en el principal se usa el de menor plazo, con aviso', async () => {
    await proveedor('MAT-FIFO', 1, { plazo: null, principal: true });
    await proveedor('MAT-FIFO', 2, { plazo: 20 });
    await movimiento({ cantidad: 90 });

    const r = await evaluar();
    assert.equal(r.body.preventivas[0].proveedor, 'Proveedor Sin Uso');
    assert.match(r.body.preventivas[0].notas[0], /principal .* no tiene plazo/);
    assert.equal((await alertas('MAT-FIFO'))[0].proveedor, 2);
  });

  test('reevaluar actualiza sin duplicar y resuelve lo que ya no está en riesgo', async () => {
    await proveedor('MAT-FIFO', 1, { plazo: 20, principal: true });
    await movimiento({ cantidad: 90 });
    const primera = await evaluar();
    assert.equal(primera.body.nuevas, 1);

    await movimiento({ cantidad: 90 });                // ahora 2/día → 12,5 días
    assert.equal(primera.body.preventivas[0].alerta, 'nueva');
    const segunda = await evaluar();
    assert.equal(segunda.body.nuevas, 0);
    assert.equal(segunda.body.actualizadas, 1);
    assert.equal(segunda.body.preventivas[0].alerta, 'actualizada');
    const act = await alertas('MAT-FIFO');
    assert.equal(act.length, 1);
    assert.equal(act[0].agotamiento, hoyMas(12));

    await proveedor('MAT-FIFO', 1, { plazo: 5, principal: true });   // 7 corridos < 12,5
    const tercera = await evaluar();
    assert.equal(tercera.body.resueltas, 1);
    assert.equal((await alertas('MAT-FIFO')).length, 0);
    const [res] = await alertas('MAT-FIFO', 'resuelta');
    assert.ok(res.resuelta_en, 'el historial registra la fecha de resolución');
  });

  test('no rotativos y herramientas quedan fuera de la evaluación', async () => {
    await db.query(`UPDATE inventario.material SET material_es_rotativo = FALSE WHERE material_sku = 'MAT-FIFO'`);
    await proveedor('MAT-FIFO', 1, { plazo: 20, principal: true });
    await movimiento({ cantidad: 90 });
    await movimiento({ sku: 'MAT-HERR', cantidad: 90 });

    const r = await evaluar();
    const todos = [...r.body.criticas, ...r.body.preventivas, ...r.body.sin_rotacion, ...r.body.pendientes_configuracion]
      .map(x => x.sku);
    assert.ok(!todos.includes('MAT-FIFO'));
    assert.ok(!todos.includes('MAT-HERR'));
    assert.equal((await alertas('MAT-FIFO')).length, 0);
  });

  test('el generador automático no apaga la preventiva ni crea "tiempo reposicion" por su cuenta', async () => {
    await proveedor('MAT-FIFO', 1, { plazo: 20, principal: true });
    await movimiento({ cantidad: 90 });
    await evaluar();

    await api('POST', '/api/alertas/generar');   // MAT-FIFO (25) está sobre el mínimo (5)
    const act = await alertas('MAT-FIFO');
    assert.equal(act.length, 1);
    assert.equal(act[0].tipo, 'tiempo reposicion');

    // MAT-CRIT: 8 de stock, mínimo 5 → la heurística vieja (<= mínimo × 1,2 = 6) tampoco aplicaría,
    // así que se baja a 6 para comprobar que ya no crea la alerta.
    await db.query(`UPDATE inventario.inventario_bodega SET inventario_bodega_cantidad_fisica = 6 WHERE material_sku = 'MAT-CRIT'`);
    await proveedor('MAT-CRIT', 1, { plazo: 5, principal: true });
    await api('POST', '/api/alertas/generar');
    assert.equal((await alertas('MAT-CRIT')).length, 0);
  });

  test('evaluar no mueve stock', async () => {
    await proveedor('MAT-FIFO', 1, { plazo: 20, principal: true });
    await movimiento({ cantidad: 90 });
    const antes = await db.stockDe('MAT-FIFO');
    await evaluar();
    assert.deepEqual(await db.stockDe('MAT-FIFO'), antes);
    assert.deepEqual(await db.descuadresDeReservas(), []);
  });

  test('gerencia y jop pueden evaluar; otros roles no', async () => {
    assert.equal((await evaluar('jop')).status, 200);

    const tecnico = jwt.sign({ id: 2, username: 'jop.test', nombre: 'X', rol: 'tecnico' },
      process.env.JWT_SECRET, { expiresIn: '1h' });
    const { levantar } = require('./helpers/api');
    const res = await fetch(await levantar() + '/api/alertas/reposicion/evaluar', {
      method: 'POST', headers: { Authorization: `Bearer ${tecnico}` },
    });
    assert.equal(res.status, 403);
  });
});

describe('Panel de reposición (CU-48)', () => {
  const panel = (rol = 'gerencia') => api('GET', '/api/alertas/reposicion', { rol });

  /** Alerta directa en BD (para los tipos que el panel debe ignorar). */
  async function alertaDirecta(sku, tipoId, { estado = 'activa', conteo = null } = {}) {
    const { rows: h } = await db.query(`INSERT INTO inventario.historial_alerta DEFAULT VALUES RETURNING historial_alerta_id_historial AS id`);
    await db.query(
      `INSERT INTO inventario.alerta_inventario (alerta_inventario_mensaje, alerta_inventario_estado, material_sku,
         alerta_inventario_tipo_alerta_id_tipo_alerta, historial_alerta_id_historial, conteo_ciclico_id_conteo)
       VALUES ('directa', $1, $2, $3, $4, $5)`,
      [estado, sku, tipoId, h[0].id, conteo]
    );
  }

  test('muestra críticas y preventivas activas, críticas primero, con los datos de la evaluación', async () => {
    await proveedor('MAT-FIFO', 1, { plazo: 20, principal: true });
    await movimiento({ cantidad: 90 });
    await evaluar();                                              // MAT-FIFO: preventiva, 25 días
    await db.query(`UPDATE inventario.inventario_bodega SET inventario_bodega_cantidad_fisica = 1 WHERE material_sku = 'MAT-CRIT'`);
    await api('POST', '/api/alertas/generar');                    // MAT-CRIT: stock_critico sin evaluar
    await alertaDirecta('MAT-UNO', 6);                            // stock bajo minimo: no va
    await alertaDirecta('MAT-UNO', 5, { estado: 'resuelta' });    // resuelta: no va

    const r = await panel();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map(a => [a.sku, a.urgencia]), [['MAT-CRIT', 'critica'], ['MAT-FIFO', 'preventiva']]);

    const [crit, prev] = r.body;
    assert.equal(crit.fecha_agotamiento, null, 'crítica sin evaluar: sin fecha');
    assert.equal(crit.proveedor, null);
    assert.equal(crit.cantidad_sugerida, null);

    assert.equal(prev.stock_disponible, 25);
    assert.equal(prev.dias_restantes, 25);
    assert.equal(prev.fecha_agotamiento, hoyMas(25));
    assert.equal(prev.proveedor, 'Proveedor Test');
    assert.equal(prev.plazo_dias_habiles, 20);
    assert.equal(prev.plazo_dias_corridos, 28);
    assert.equal(prev.cantidad_sugerida, 28);
    assert.match(prev.observaciones, /Cobertura/);
    assert.ok('categoria' in prev);
  });

  test('preventivas ordenadas por días restantes; stock disponible al momento', async () => {
    await proveedor('MAT-FIFO', 1, { plazo: 20, principal: true });
    await proveedor('MAT-UNO', 1, { plazo: 20, principal: true });
    await movimiento({ cantidad: 90 });                      // MAT-FIFO: 25 días
    await movimiento({ sku: 'MAT-UNO', cantidad: 45 });      // MAT-UNO: 1 ÷ 0,5 = 2 días
    await evaluar();

    let r = await panel();
    assert.deepEqual(r.body.map(a => a.sku), ['MAT-UNO', 'MAT-FIFO']);

    await db.query(`UPDATE inventario.inventario_bodega SET inventario_bodega_cantidad_fisica = inventario_bodega_cantidad_fisica - 3
                    WHERE material_sku = 'MAT-FIFO' AND lote_id_lote = 1`);
    r = await panel();
    assert.equal(r.body.find(a => a.sku === 'MAT-FIFO').stock_disponible, 22, 'el stock se lee al momento');
  });

  test('no incluye alertas de conteo ni viaja ningún precio', async () => {
    await proveedor('MAT-FIFO', 1, { plazo: 20, precio: 1000, principal: true });
    await proveedor('MAT-FIFO', 2, { plazo: 5, precio: 800 });
    await movimiento({ cantidad: 90 });
    await evaluar();

    const r = await panel('jop');
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);
    // Ni campos de precio ni montos (la nota dice "precio referencial menor", sin cifras)
    assert.ok(r.body.every(a => !Object.keys(a).some(k => /precio|monto|valor/i.test(k))));
    assert.doesNotMatch(JSON.stringify(r.body), /800|1\.?000/);
  });

  test('el plazo y el proveedor son los de la alerta, no los del principal (también en /api/alertas)', async () => {
    await proveedor('MAT-FIFO', 1, { plazo: null, principal: true });
    await proveedor('MAT-FIFO', 2, { plazo: 20 });
    await movimiento({ cantidad: 90 });
    await evaluar();

    const [a] = (await panel()).body;
    assert.equal(a.proveedor, 'Proveedor Sin Uso');
    assert.equal(a.plazo_dias_habiles, 20);

    const general = (await api('GET', '/api/alertas?estado=activa')).body.find(x => x.sku === 'MAT-FIFO');
    assert.equal(general.proveedor, 'Proveedor Sin Uso');
    assert.equal(general.tiempo_reposicion, 20);
    assert.equal(parseFloat(general.cantidad_sugerida), 28);
  });

  test('sin alertas de reposición devuelve una lista vacía; otros roles no acceden', async () => {
    const r = await panel();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);

    const tecnico = jwt.sign({ id: 2, username: 'jop.test', nombre: 'X', rol: 'tecnico' },
      process.env.JWT_SECRET, { expiresIn: '1h' });
    const { levantar } = require('./helpers/api');
    const res = await fetch(await levantar() + '/api/alertas/reposicion', { headers: { Authorization: `Bearer ${tecnico}` } });
    assert.equal(res.status, 403);
  });
});
