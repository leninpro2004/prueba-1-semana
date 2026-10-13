const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * B-08b: indicadores del mes en el índice de reportes (GET /api/reportes/resumen).
 *
 * Lo que protegen:
 *  - cada número es el MISMO que da su reporte para el mismo mes (movimientos vigentes, mermas
 *    confirmadas, ítems con pérdida de desviaciones y el total de valorización);
 *  - los montos siguen la regla de cada reporte: valor de mermas e inventario solo a gerencia,
 *    impacto de desviaciones solo a quien ve montos; desviaciones solo a gerencia y jop.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

/** Movimiento directo en BD con fecha de ahora (dentro del mes en curso; no mueve stock). */
async function movimiento({ sku = 'MAT-FIFO', tipo = 2, cantidad = 1, estado = 'completado', motivo = null, revierte = null }) {
  const { rows } = await db.query(
    `INSERT INTO inventario.movimiento_inventario (
       movimiento_inventario_cantidad, movimiento_inventario_estado, material_sku, bodega_id_bodega,
       usuario_id_usuario, movimiento_inventario_tipo_movimiento_id_tipo_movimiento,
       movimiento_inventario_motivo_movimiento_id_motivo_movimiento, movimiento_inventario_id_revertido,
       movimiento_inventario_fecha_hora)
     VALUES ($1, $2, $3, 1, 1, $4, $5, $6, now())
     RETURNING movimiento_inventario_id_movimiento AS id`,
    [cantidad, estado, sku, tipo, motivo, revierte]
  );
  return rows[0].id;
}

/** Clasificación y motivo extra (id 9, fuera de la semilla). */
async function motivoCon(id, clasificacion, motivo) {
  await db.query(
    `INSERT INTO inventario.movimiento_inventario_clasificacion_salida
       (movimiento_inventario_clasificacion_salida_id_clasificacion_sal, movimiento_inventario_clasificacion_salida_nombre)
     OVERRIDING SYSTEM VALUE VALUES ($1, $2)`, [id, clasificacion]);
  await db.query(
    `INSERT INTO inventario.movimiento_inventario_motivo_movimiento
       (movimiento_inventario_motivo_movimiento_id_motivo_movimiento, movimiento_inventario_motivo_movimiento_nombre,
        movimiento_inventario_clasificacion_salida_id_clasificacion_sal)
     OVERRIDING SYSTEM VALUE VALUES ($1, $2, $1)`, [id, motivo]);
}

/** Diferencial procesado de la OT 1, que se mueve al mes en curso. */
async function diferencial(sku, tipo, impacto) {
  await db.query(
    `INSERT INTO inventario.diferencial_consumo (orden_trabajo_id_orden, material_sku, diferencial_consumo_estimado,
       diferencial_consumo_real, diferencial_consumo_desviacion_abs, diferencial_consumo_desviacion_pct,
       diferencial_consumo_tipo, diferencial_consumo_impacto_clp, usuario_id_usuario)
     VALUES (1, $1, 10, 12, 2, 20, $2, $3, 2)`, [sku, tipo, impacto]);
}

/** Datos del mes: vigentes, anulados, traslado, mermas y desviaciones. */
async function cargarMes() {
  await motivoCon(9, 'Traslado', 'traslado_bodega');
  await movimiento({ tipo: 1, cantidad: 10 });                              // entrada
  await movimiento({ cantidad: 2, motivo: 2 });                             // salida (consumo)
  await movimiento({ cantidad: 3, motivo: 9 });                             // traslado
  const original = await movimiento({ cantidad: 4, estado: 'revertido' });
  await movimiento({ tipo: 1, cantidad: 4, revierte: original });           // su inverso: no cuenta
  await movimiento({ cantidad: 2, motivo: 3 });                             // merma confirmada ("perdida")
  await movimiento({ sku: 'MAT-CRIT', cantidad: 1, motivo: 3, estado: 'pendiente_aprobacion' });
  await db.query(`UPDATE inventario.orden_trabajo SET orden_trabajo_fecha_hora = now() WHERE orden_trabajo_id_orden = 1`);
  await diferencial('MAT-FIFO', 'sobre_gasto', 500);
  await diferencial('MAT-CRIT', 'ahorro', -200);
}

const resumen = (rol) => api('GET', '/api/reportes/resumen', { rol });

describe('Resumen del mes (B-08b)', () => {
  test('cada indicador coincide con su reporte para el mismo mes', async () => {
    await cargarMes();
    const r = await resumen('gerencia');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const qs = `desde=${r.body.periodo.desde}&hasta=${r.body.periodo.hasta}`;

    const mov = (await api('GET', `/api/reportes/movimientos?${qs}`)).body.resumen;
    assert.deepEqual(r.body.movimientos,
      { total: mov.total_movimientos, entradas: mov.total_entradas, salidas: mov.total_salidas, traslados: mov.total_traslados });
    assert.equal(r.body.movimientos.total, 4, 'entrada, consumo, traslado y merma; sin anulados ni pendientes');

    const mer = (await api('GET', `/api/reportes/mermas?${qs}`)).body.resumen;
    assert.equal(r.body.mermas.eventos, mer.total_eventos);
    assert.equal(r.body.mermas.valor_clp, Math.round(mer.valor_total_merma));
    assert.equal(r.body.mermas.eventos, 1, 'la pendiente no cuenta');

    const des = (await api('GET', `/api/reportes/desviaciones?${qs}`)).body.resumen;
    assert.equal(r.body.desviaciones.items, des.items);
    assert.equal(r.body.desviaciones.impacto_clp, des.impacto_total_clp);
    assert.deepEqual(r.body.desviaciones, { items: 1, ots: 1, impacto_clp: 500 });

    const val = (await api('GET', '/api/reportes/valorizacion')).body.resumen;
    assert.equal(r.body.valor_inventario.valor_clp, Math.round(val.valor_total));
    assert.equal(r.body.valor_inventario.sin_precio, val.sin_precio);
  });

  test('el período va del día 1 del mes a hoy', async () => {
    const { periodo } = (await resumen('gerencia')).body;
    assert.match(periodo.desde, /^\d{4}-\d{2}-01$/);
    assert.equal(periodo.desde.slice(0, 7), periodo.hasta.slice(0, 7));
  });

  test('jop: desviaciones sin impacto; sin valor de mermas ni del inventario', async () => {
    await cargarMes();
    const r = (await resumen('jop')).body;
    assert.deepEqual(r.desviaciones, { items: 1, ots: 1 });
    assert.deepEqual(r.mermas, { eventos: 1 });
    assert.equal('valor_inventario' in r, false);
  });

  test('técnico: solo movimientos y mermas, sin montos', async () => {
    await cargarMes();
    const r = (await resumen('tecnico')).body;
    assert.deepEqual(Object.keys(r).sort(), ['mermas', 'movimientos', 'periodo']);
    assert.deepEqual(r.mermas, { eventos: 1 });
  });
});
