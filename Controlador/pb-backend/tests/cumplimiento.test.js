const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');
const { compra } = require('./helpers/compra');   // D66: una compra lleva proveedor, precio, pedido y factura

/**
 * Tiempos reales de entrega y cumplimiento de proveedores (CU-62).
 *
 * Lo que protegen:
 *  - días hábiles = lunes a viernes, sin feriados: viernes → lunes = 1
 *  - la fecha de pedido es la PRIMERA que no sea posterior a la recepción
 *  - las pendientes de recepción no entran a los indicadores (Exc 2)
 *  - la entrada guarda la fecha de pedido y la de recepción (antes se descartaban),
 *    y rechaza fechas incoherentes sin mover stock
 *
 * Semilla: lote 1 y 2 son de MAT-FIFO (proveedor 1), lote 3 de MAT-CRIT (proveedor 1).
 * Fechas: 2026-09-04 es viernes, 2026-09-07 lunes, 2026-09-18 viernes.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const cumplimiento = (id, rol = 'gerencia') => api('GET', `/api/proveedores/${id}/cumplimiento`, { rol });

async function entrega(loteId, pedido, recepcion) {
  await db.query(`UPDATE inventario.lote SET lote_fecha_recepcion = $2 WHERE lote_id_lote = $1`, [loteId, recepcion]);
  await db.query(
    `INSERT INTO inventario.lote_fecha_pedido (lote_fecha_pedido_fecha_pedido, lote_fecha_pedido_precio_unitario, lote_id_lote)
     VALUES ($1, NULL, $2)`,
    [pedido, loteId]
  );
}

async function plazo(sku, dias) {
  await db.query(
    `UPDATE inventario.material_proveedor SET material_proveedor_tiempo_reposicion = $2
     WHERE material_sku = $1 AND proveedor_id_proveedor = 1`,
    [sku, dias]
  );
}

describe('Cumplimiento de entregas (CU-62)', () => {
  test('días hábiles, promedio, mediana, mínimo, máximo y % de cumplimiento', async () => {
    await plazo('MAT-FIFO', 5);
    await entrega(1, '2026-09-04', '2026-09-07');   // viernes → lunes: 1 día hábil
    await entrega(2, '2026-09-07', '2026-09-18');   // lunes → viernes siguiente: 9

    const r = await cumplimiento(1);
    assert.equal(r.status, 200);
    const s = r.body.resumen;
    assert.equal(s.disponible, true);
    assert.equal(s.entregas, 2);
    assert.equal(s.promedio_dias, 5);
    assert.equal(s.mediana_dias, 5);
    assert.equal(s.minimo_dias, 1);
    assert.equal(s.maximo_dias, 9);
    assert.equal(s.plazo_prometido_promedio, 5);
    assert.equal(s.cumplimiento_pct, 50, 'una de dos a tiempo (1 <= 5; 9 > 5)');
    assert.equal(s.desviacion_promedio_dias, 0, '(1−5 + 9−5) / 2');

    const porLote = Object.fromEntries(r.body.entregas.map(e => [String(e.lote_id), e]));
    assert.equal(porLote['1'].dias_habiles, 1);
    assert.equal(porLote['1'].a_tiempo, true);
    assert.equal(porLote['2'].a_tiempo, false);
  });

  test('se usa la primera fecha de pedido que no sea posterior a la recepción', async () => {
    await entrega(1, '2026-09-04', '2026-09-07');
    await db.query(`INSERT INTO inventario.lote_fecha_pedido (lote_fecha_pedido_fecha_pedido, lote_fecha_pedido_precio_unitario, lote_id_lote)
                    VALUES ('2026-09-01', 900, 1), ('2026-09-20', 950, 1)`);   // una antes (vale) y una después (se ignora)
    const e = (await cumplimiento(1)).body.entregas.find(x => String(x.lote_id) === '1');
    assert.equal(e.fecha_pedido, '2026-09-01');
    assert.equal(e.dias_habiles, 4, 'martes 01 → lunes 07: mié, jue, vie, lun');
  });

  test('Exc 2: los pedidos sin recepción se cuentan aparte y no entran a los indicadores', async () => {
    await entrega(1, '2026-09-04', '2026-09-07');
    await db.query(`UPDATE inventario.lote SET lote_fecha_recepcion = NULL WHERE lote_id_lote = 3`);
    await db.query(`INSERT INTO inventario.lote_fecha_pedido (lote_fecha_pedido_fecha_pedido, lote_fecha_pedido_precio_unitario, lote_id_lote)
                    VALUES ('2026-09-10', NULL, 3)`);

    const s = (await cumplimiento(1)).body.resumen;
    assert.equal(s.entregas, 1);
    assert.equal(s.pendientes, 1);
    assert.equal(s.promedio_dias, 1);
  });

  test('sin plazo prometido: la entrega cuenta en los días, pero no en el % de cumplimiento', async () => {
    await entrega(1, '2026-09-04', '2026-09-07');   // MAT-FIFO sin plazo en la semilla
    const s = (await cumplimiento(1)).body.resumen;
    assert.equal(s.entregas, 1);
    assert.equal(s.con_plazo, 0);
    assert.equal(s.cumplimiento_pct, null);
  });

  test('Exc 1: proveedor sin entregas registradas → dato no disponible', async () => {
    const r = await cumplimiento(2, 'jop');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.resumen, { disponible: false, entregas: 0, pendientes: 0 });
    assert.equal((await cumplimiento(99999)).status, 404);
  });

  test('no viaja ningún monto', async () => {
    await db.query(`INSERT INTO inventario.lote_fecha_pedido (lote_fecha_pedido_fecha_pedido, lote_fecha_pedido_precio_unitario, lote_id_lote)
                    VALUES ('2026-09-04', 12345, 1)`);
    await db.query(`UPDATE inventario.lote SET lote_fecha_recepcion = '2026-09-07' WHERE lote_id_lote = 1`);
    const r = await cumplimiento(1, 'jop');
    assert.doesNotMatch(JSON.stringify(r.body), /precio|12345/i);
  });
});

describe('Entrada con fecha de pedido y de recepción (CU-62)', () => {
  const entrada = (extra) => api('POST', '/api/movimientos/entrada', {
    body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 3, tipo_movimiento_id: 1, ...compra(), ...extra },
  });

  test('guarda la fecha de pedido (con su precio, obligatorio desde D66) y la recepción informada; el ingreso sigue siendo hoy', async () => {
    const r = await entrada({ fecha_pedido: '2026-09-04', fecha_recepcion: '2026-09-07' });
    assert.equal(r.status, 201);

    const { rows } = await db.query(
      `SELECT to_char(l.lote_fecha_recepcion, 'YYYY-MM-DD') AS rec, l.lote_fecha_ingreso = CURRENT_DATE AS ingreso_hoy,
              to_char(fp.lote_fecha_pedido_fecha_pedido, 'YYYY-MM-DD') AS ped, fp.lote_fecha_pedido_precio_unitario::float AS precio
       FROM inventario.movimiento_inventario mi
       JOIN inventario.lote l ON l.lote_id_lote = mi.lote_id_lote
       JOIN inventario.lote_fecha_pedido fp ON fp.lote_id_lote = l.lote_id_lote
       WHERE mi.movimiento_inventario_id_movimiento = $1`,
      [r.body.movimiento_id]
    );
    assert.deepEqual(rows[0], { rec: '2026-09-07', ingreso_hoy: true, ped: '2026-09-04', precio: 1000 });

    const e = (await cumplimiento(1)).body.entregas;
    assert.equal(e.length, 1);
    assert.equal(e[0].dias_habiles, 1);
  });

  test('con precio informado, lo guarda junto a la fecha de pedido', async () => {
    const r = await entrada({ fecha_pedido: '2026-09-04', precio_unitario: 1100 });
    assert.equal(r.status, 201);
    const { rows } = await db.query(`SELECT lote_fecha_pedido_precio_unitario::float AS precio FROM inventario.lote_fecha_pedido`);
    assert.equal(rows[0].precio, 1100);
  });

  test('rechaza recepción futura o pedido posterior a la recepción, sin mover stock ni crear lote', async () => {
    const stock = await db.stockDe('MAT-FIFO');
    const lotes = await db.contar('inventario.lote');
    const manana = new Date(Date.now() + 86400000);
    const futura = `${manana.getFullYear()}-${String(manana.getMonth() + 1).padStart(2, '0')}-${String(manana.getDate()).padStart(2, '0')}`;

    assert.equal((await entrada({ fecha_recepcion: futura })).status, 400);
    assert.equal((await entrada({ fecha_pedido: '2026-09-10', fecha_recepcion: '2026-09-07' })).status, 400);
    assert.equal((await entrada({ fecha_pedido: futura })).status, 400, 'sin recepción, el pedido no puede ser posterior a hoy');
    assert.equal((await entrada({ fecha_pedido: '04-09-2026' })).status, 400);

    assert.deepEqual(await db.stockDe('MAT-FIFO'), stock);
    assert.equal(await db.contar('inventario.lote'), lotes);
    assert.equal(await db.contar('inventario.lote_fecha_pedido'), 0);
  });
});

describe('Métricas comparativas de proveedores (CU-63)', () => {
  const metricas = (qs = '', rol = 'gerencia') => api('GET', '/api/proveedores/metricas' + qs, { rol });

  /** Proveedor 1: lotes 1 (1 día) y 2 (9 días), plazo 5. Proveedor 2: lote 5 de PIN-TEST (2 días), plazo 3. */
  async function escenario() {
    await plazo('MAT-FIFO', 5);
    await entrega(1, '2026-09-04', '2026-09-07');
    await entrega(2, '2026-09-07', '2026-09-18');
    await db.query(`UPDATE inventario.lote SET proveedor_id_proveedor = 2 WHERE lote_id_lote = 5`);
    await db.query(`INSERT INTO inventario.material_proveedor (material_sku, proveedor_id_proveedor, material_proveedor_tiempo_reposicion,
                      material_proveedor_proveedor_principal) VALUES ('PIN-TEST', 2, 3, FALSE)`);
    await entrega(5, '2026-09-14', '2026-09-16');   // lunes → miércoles: 2
  }

  test('indicadores por proveedor y globales; ordenados por cumplimiento', async () => {
    await escenario();
    const r = await metricas();
    assert.equal(r.status, 200);

    assert.deepEqual(r.body.proveedores.map(p => [String(p.proveedor_id), p.cumplimiento_pct]), [['2', 100], ['1', 50]]);
    const p1 = r.body.proveedores.find(p => String(p.proveedor_id) === '1');
    assert.equal(p1.entregas, 2);
    assert.equal(p1.promedio_dias, 5);
    assert.equal(p1.retraso_pct, 50);
    assert.equal(p1.desviacion_promedio_dias, 0);

    const g = r.body.global;
    assert.equal(g.entregas, 3);
    assert.equal(g.promedio_dias, 4);
    assert.equal(g.cumplimiento_pct, 66.7);
    assert.equal(g.desviacion_promedio_dias, -0.3, '((1−5) + (9−5) + (2−3)) / 3');
    assert.equal(r.body.sin_datos, 0);
    assert.equal(r.body.total_sistema, 3);
  });

  test('filtra por proveedor y por fecha de recepción; las pendientes no cuentan', async () => {
    await escenario();
    await db.query(`UPDATE inventario.lote SET lote_fecha_recepcion = NULL WHERE lote_id_lote = 3`);
    await db.query(`INSERT INTO inventario.lote_fecha_pedido (lote_fecha_pedido_fecha_pedido, lote_fecha_pedido_precio_unitario, lote_id_lote)
                    VALUES ('2026-09-15', NULL, 3)`);

    let r = await metricas('?proveedor_id=1');
    assert.equal(r.body.proveedores.length, 1);
    assert.equal(r.body.global.entregas, 2, 'la pendiente del lote 3 no entra');

    r = await metricas('?desde=2026-09-10&hasta=2026-09-30');
    assert.equal(r.body.global.entregas, 2, 'lote 2 (18-09) y lote 5 (16-09); el lote 1 (07-09) queda fuera');
    assert.equal(r.body.sin_datos, 0);
  });

  test('Exc 1 y Exc 2 se distinguen por total_sistema', async () => {
    let r = await metricas('', 'jop');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.proveedores, []);
    assert.equal(r.body.total_sistema, 0, 'Exc 1: no hay pedidos completados en el sistema');

    await escenario();
    r = await metricas('?desde=2025-01-01&hasta=2025-12-31');
    assert.deepEqual(r.body.proveedores, []);
    assert.equal(r.body.global.disponible, false);
    assert.equal(r.body.total_sistema, 3, 'Exc 2: hay datos, pero no en el período');
    assert.equal(r.body.sin_datos, 2);
  });

  test('rango incoherente o proveedor inválido → 400; sin montos', async () => {
    assert.equal((await metricas('?desde=2026-09-20&hasta=2026-09-01')).status, 400);
    assert.equal((await metricas('?desde=20-09-2026')).status, 400);
    assert.equal((await metricas('?proveedor_id=abc')).status, 400);

    await escenario();
    const r = await metricas();
    assert.doesNotMatch(JSON.stringify(r.body), /precio|monto|referencial/i);
  });
});

describe('Comparación de proveedores de un producto (CU-65)', () => {
  const comparar = (sku = 'MAT-FIFO', rol = 'gerencia') => api('GET', `/api/materiales/${sku}/comparar-proveedores`, { rol });

  /** MAT-FIFO: proveedor 1 (principal, $1000, plazo 5, entregas de 1 y 9 días) y proveedor 2 ($800, plazo 3, una de 2 días). */
  async function escenario({ precio2 = 800, conEntregas2 = true } = {}) {
    await plazo('MAT-FIFO', 5);
    await entrega(1, '2026-09-04', '2026-09-07');
    await entrega(2, '2026-09-07', '2026-09-18');
    await db.query(`INSERT INTO inventario.material_proveedor (material_sku, proveedor_id_proveedor, material_proveedor_tiempo_reposicion,
                      material_proveedor_precio_referencial, material_proveedor_proveedor_principal, material_proveedor_cantidad_minima)
                    VALUES ('MAT-FIFO', 2, 3, $1, FALSE, 10)`, [precio2]);
    if (conEntregas2) {
      await db.query(`INSERT INTO inventario.lote (lote_id_lote, lote_numero_lote, lote_fecha_ingreso, lote_estado, proveedor_id_proveedor)
                      OVERRIDING SYSTEM VALUE VALUES (60, 'LOTE-P2', '2026-09-16', 'activo', 2)`);
      await db.query(`INSERT INTO inventario.inventario_bodega (material_sku, lote_id_lote, bodega_id_bodega, inventario_bodega_cantidad_fisica)
                      VALUES ('MAT-FIFO', 60, 1, 0)`);
      await entrega(60, '2026-09-14', '2026-09-16');   // lunes → miércoles: 2
    }
  }
  const fila = (body, id) => body.proveedores.find(p => String(p.proveedor_id) === String(id));

  test('datos por proveedor del producto y destaques de menor costo y menor plazo', async () => {
    await escenario();
    const r = await comparar();
    assert.equal(r.status, 200);
    assert.equal(r.body.alternativas, true);

    const p1 = fila(r.body, 1), p2 = fila(r.body, 2);
    assert.deepEqual(
      [p1.es_principal, p1.precio, p1.plazo_prometido, p1.plazo_real_promedio, p1.cumplimiento_pct, p1.entregas],
      [true, 1000, 5, 5, 50, 2]);
    assert.deepEqual(
      [p2.precio, p2.plazo_prometido, p2.plazo_real_promedio, p2.cumplimiento_pct, p2.cantidad_minima],
      [800, 3, 2, 100, 10]);
    assert.deepEqual(r.body.destaques.menor_costo.map(String), ['2']);
    assert.deepEqual(r.body.destaques.menor_plazo.map(String), ['2']);
  });

  test('Exc 3: sin precio o sin historial → "sin datos" y fuera del destaque de ese criterio', async () => {
    await escenario({ precio2: null, conEntregas2: false });
    const r = await comparar();
    const p2 = fila(r.body, 2);
    assert.equal(p2.precio, null);
    assert.equal(p2.plazo_real_promedio, null);
    assert.deepEqual(p2.faltantes, ['precio vigente', 'historial de entregas']);
    assert.deepEqual(r.body.destaques.menor_costo.map(String), ['1']);
    assert.deepEqual(r.body.destaques.menor_plazo.map(String), ['1']);
  });

  test('un empate destaca a todos los empatados', async () => {
    await escenario({ precio2: 1000 });
    const r = await comparar();
    assert.deepEqual(r.body.destaques.menor_costo.map(String).sort(), ['1', '2']);
  });

  test('Exc 1: un solo proveedor → sin alternativas ni destaques; Exc 2: sin proveedores', async () => {
    let r = await comparar('MAT-CRIT');
    assert.equal(r.body.proveedores.length, 1);
    assert.equal(r.body.alternativas, false);
    assert.deepEqual(r.body.destaques, { menor_plazo: [], menor_costo: [] });

    r = await comparar('MAT-UNO');
    assert.deepEqual(r.body.proveedores, []);
    assert.equal(r.body.alternativas, false);

    assert.equal((await comparar('NO-EXISTE')).status, 404);
  });

  test('jop: sin precios ni destaque de costo', async () => {
    await escenario();
    const r = await comparar('MAT-FIFO', 'jop');
    assert.equal(r.status, 200);
    assert.ok(r.body.proveedores.every(p => !('precio' in p)));
    assert.ok(!('menor_costo' in r.body.destaques));
    assert.deepEqual(r.body.destaques.menor_plazo.map(String), ['2']);
    assert.doesNotMatch(JSON.stringify(r.body), /800|1000|precio vigente/);
  });
});
