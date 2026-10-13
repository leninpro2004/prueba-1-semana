const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { api, bajar, levantar } = require('./helpers/api');
const db = require('./helpers/db');
const { compra } = require('./helpers/compra');   // D66: una compra lleva proveedor, precio, pedido y factura
const { stockAFecha } = require('../src/db/historico');

/**
 * Stock reconstruido hacia atrás (D21) e índice de rotación (CU-71).
 *
 * Lo que protegen:
 *  - TEST OBLIGATORIO de la ficha: la reconstrucción cuadra con el stock real en
 *    TODOS los materiales, a hoy y en cada instante intermedio, después de pasar
 *    por la API todos los flujos que mueven stock. Si falla, hay cambios de stock
 *    sin movimiento (o movimientos sin cambio de stock): se reporta, no se tapa.
 *  - índice = consumo ÷ ((stock inicio + stock final) ÷ 2), niveles sobre el
 *    índice mensualizado, orden de menor a mayor, y las tres excepciones.
 *
 * Semilla: MAT-FIFO 30, MAT-CRIT 8, MAT-UNO 1, PIN-TEST 20 kg, MAT-HERR 3 (herramienta).
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

/** Stock físico real de todos los materiales. */
async function stockReal() {
  const { rows } = await db.query(
    `SELECT m.material_sku AS sku, COALESCE(SUM(ib.inventario_bodega_cantidad_fisica), 0) AS fisica
     FROM inventario.material m
     LEFT JOIN inventario.inventario_bodega ib ON ib.material_sku = m.material_sku
     GROUP BY m.material_sku`
  );
  return new Map(rows.map(r => [r.sku, parseFloat(r.fisica)]));
}

/**
 * Instante de la BD y stock real en ese instante. El instante va como TEXTO: un
 * Date de JS corta a milisegundos y podría caer antes de un movimiento del mismo ms.
 */
async function foto(paso) {
  const { rows } = await db.query('SELECT now()::text AS t');
  return { paso, t: rows[0].t, stock: await stockReal() };
}

/** Diferencias entre dos mapas sku -> cantidad. */
function diferencias(esperado, obtenido) {
  const out = [];
  for (const [sku, v] of esperado) {
    const o = obtenido.get(sku) ?? 0;
    if (Math.abs(o - v) > 1e-6) out.push(`${sku}: real ${v}, reconstruido ${o}`);
  }
  return out;
}

/** Movimiento directo en BD con la antigüedad pedida (no mueve stock). */
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

/** Movimiento directo en BD en una fecha local concreta (no mueve stock). */
async function movimientoEn(fecha, { sku, tipo = 2, cantidad }) {
  await db.query(
    `INSERT INTO inventario.movimiento_inventario (
       movimiento_inventario_cantidad, movimiento_inventario_estado, material_sku, bodega_id_bodega,
       usuario_id_usuario, movimiento_inventario_tipo_movimiento_id_tipo_movimiento, movimiento_inventario_fecha_hora)
     VALUES ($1, 'completado', $2, 1, 1, $3, ($4::date + TIME '12:00')::timestamptz)`,
    [cantidad, sku, tipo, fecha]
  );
}

/** Precio en el historial, vigente desde `desde`. */
async function precio(sku, proveedor, valor, desde) {
  await db.query(
    `INSERT INTO inventario.historial_precio_material (material_sku, proveedor_id_proveedor, precio_unitario, fecha_vigencia_desde)
     VALUES ($1, $2, $3, $4)`,
    [sku, proveedor, valor, desde]
  );
}

/** 'YYYY-MM-DD' local de hoy + n días. */
function hoyMas(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Últimos 30 días, hoy incluido. */
const rotacion = (desde = hoyMas(-29), hasta = hoyMas(0), rol = 'gerencia') =>
  api('GET', `/api/reportes/rotacion?desde=${desde}&hasta=${hasta}`, { rol });

describe('stockAFecha (D21) — test obligatorio', () => {
  /*
   * Los movimientos ANULADOS (revertidos con CU-44, mermas rechazadas, consumos de
   * un material eliminado de la OT) se reconstruyen como si nunca hubieran
   * ocurrido, también entre su registro y su anulación (D23): la historia es la
   * CORREGIDA. Por eso cada foto se toma cuando ya no queda ninguna anulación
   * pendiente sobre lo anterior: ahí la reconstrucción debe ser exacta.
   */
  test('cuadra con el stock real en todos los materiales, a hoy y tras cada flujo que mueve stock', async () => {
    const fotos = [await foto('semilla')];
    const ok = (r, paso) => { assert.ok(r.status < 300, `${paso}: ${r.status} ${JSON.stringify(r.body)}`); return r; };
    const revertir = (id) => api('POST', `/api/movimientos/${id}/revertir`);

    // Entrada y salida manuales que quedan vigentes
    ok(await api('POST', '/api/movimientos/entrada', {
      body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 7, tipo_movimiento_id: 1, numero_lote: 'LOTE-HIST', ...compra() },
    }), 'entrada');
    fotos.push(await foto('entrada'));
    ok(await api('POST', '/api/movimientos/salida', {
      body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 3, tipo_movimiento_id: 2, motivo_id: 2 },
    }), 'salida');
    fotos.push(await foto('salida'));

    // Reversión con autorización (CU-44): de una entrada y de una salida
    const e2 = ok(await api('POST', '/api/movimientos/entrada', {
      body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 4, tipo_movimiento_id: 1, numero_lote: 'LOTE-REV', ...compra() },
    }), 'entrada a revertir');
    ok(await revertir(e2.body.movimiento_id), 'revertir entrada');
    fotos.push(await foto('entrada revertida'));
    const s2 = ok(await api('POST', '/api/movimientos/salida', {
      body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 2, tipo_movimiento_id: 2, motivo_id: 2 },
    }), 'salida a revertir');
    ok(await revertir(s2.body.movimiento_id), 'revertir salida');
    fotos.push(await foto('salida revertida'));

    // Mermas de producto crítico: la pendiente ya descontó; una se aprueba y otra se rechaza
    const merma = (cantidad) => api('POST', '/api/movimientos/salida', {
      rol: 'jop',
      body: { sku: 'MAT-CRIT', bodega_id: 1, cantidad, tipo_movimiento_id: 2, motivo_id: 3,
              evidencia_url: 'https://evidencia.test/foto.jpg' },
    });
    const m1 = ok(await merma(1), 'merma pendiente');
    fotos.push(await foto('merma pendiente (luego aprobada)'));
    ok(await api('PUT', `/api/movimientos/${m1.body.movimiento_id}/aprobar-merma`), 'aprobar merma');
    fotos.push(await foto('merma aprobada'));
    const m2 = ok(await merma(2), 'merma pendiente 2');
    ok(await api('PUT', `/api/movimientos/${m2.body.movimiento_id}/rechazar-merma`), 'rechazar merma');
    fotos.push(await foto('merma rechazada'));

    // Consumos de OT: registrar y corregir arriba y abajo (quedan vigentes)
    ok(await api('POST', '/api/ordenes-trabajo/1/consumos', { body: { sku: 'MAT-FIFO', cantidad: 6, bodega_id: 1 } }), 'consumo OT');
    fotos.push(await foto('consumo OT'));
    ok(await api('PUT', '/api/ordenes-trabajo/1/consumos/MAT-FIFO', { body: { cantidad: 9 } }), 'corregir OT arriba');
    fotos.push(await foto('OT corregida arriba'));
    ok(await api('PUT', '/api/ordenes-trabajo/1/consumos/MAT-FIFO', { body: { cantidad: 4 } }), 'corregir OT abajo');
    fotos.push(await foto('OT corregida abajo'));

    // Eliminar un material consumido de la OT
    ok(await api('POST', '/api/ordenes-trabajo/1/consumos', { body: { sku: 'MAT-CRIT', cantidad: 2, bodega_id: 1 } }), 'consumo OT 2');
    ok(await api('PUT', '/api/ordenes-trabajo/1/consumos/MAT-CRIT', { body: { cantidad: 3 } }), 'corregir OT 2');
    ok(await api('DELETE', '/api/ordenes-trabajo/1/materiales/MAT-CRIT'), 'eliminar material OT');
    fotos.push(await foto('material eliminado de la OT'));

    // Pinturas: consumo, corrección y anulación (quedan vigentes y suman cero)
    const pin = ok(await api('POST', '/api/seguimiento-pinturas', {
      body: { sku: 'PIN-TEST', peso_entrada_gr: 2400, peso_salida_gr: 900, bodega_id: 1, area_trabajo_id: 2 },
    }), 'consumo pintura');
    fotos.push(await foto('consumo pintura'));
    ok(await api('PUT', `/api/seguimiento-pinturas/${pin.body.id}`, { body: { peso_salida_gr: 1400 } }), 'corregir pintura');
    fotos.push(await foto('pintura corregida'));
    ok(await api('PUT', `/api/seguimiento-pinturas/${pin.body.id}/anular`, { body: {} }), 'anular pintura');
    fotos.push(await foto('pintura anulada'));

    ok(await api('POST', '/api/movimientos/salida', {
      body: { sku: 'MAT-UNO', bodega_id: 1, cantidad: 1, tipo_movimiento_id: 2, motivo_id: 2 },
    }), 'salida MAT-UNO');

    // A hoy: sin movimientos posteriores, la reconstrucción es el stock real
    const hoy = diferencias(await stockReal(), await stockAFecha(db, new Date(Date.now() + 60000)));
    assert.deepEqual(hoy, [], 'a hoy');

    // En cada instante intermedio: deshacer lo posterior devuelve exactamente ese stock
    const fallas = [];
    for (const f of fotos) {
      for (const d of diferencias(f.stock, await stockAFecha(db, f.t))) fallas.push(`tras "${f.paso}": ${d}`);
    }
    assert.deepEqual(fallas, [], 'hay cambios de stock que la historia de movimientos no explica');
  });
});

describe('Índice de rotación (CU-71)', () => {
  test('índice = consumo ÷ stock promedio; niveles mensualizados; orden de menor a mayor', async () => {
    await movimiento({ cantidad: 20, dias: 10 });                   // MAT-FIFO: inicio 50, final 30 → 0,5 media
    await movimiento({ sku: 'MAT-CRIT', cantidad: 16, dias: 5 });   // inicio 24, final 8 → 1 alta
    await movimiento({ sku: 'PIN-TEST', cantidad: 1, dias: 3 });    // inicio 21, final 20 → 0,0488 baja
    await movimiento({ cantidad: 900, dias: 60 });                  // fuera del período: no cuenta

    const r = await rotacion();
    assert.equal(r.status, 200);
    assert.equal(r.body.periodo.dias, 30);

    const p = Object.fromEntries(r.body.productos.map(x => [x.sku, x]));
    assert.equal(p['MAT-FIFO'].stock_inicio, 50);
    assert.equal(p['MAT-FIFO'].stock_final, 30);
    assert.equal(p['MAT-FIFO'].stock_promedio, 40);
    assert.equal(p['MAT-FIFO'].consumo, 20);
    assert.equal(p['MAT-FIFO'].indice, 0.5);
    assert.equal(p['MAT-FIFO'].nivel, 'media');
    assert.equal(p['MAT-CRIT'].indice, 1);
    assert.equal(p['MAT-CRIT'].nivel, 'alta');
    assert.equal(p['PIN-TEST'].nivel, 'baja');
    assert.equal(p['MAT-UNO'].indice, 0);
    assert.equal(p['MAT-UNO'].nivel, 'sin_rotacion');
    assert.ok(!('MAT-HERR' in p), 'las herramientas no entran');

    assert.deepEqual(r.body.productos.map(x => x.sku), ['MAT-UNO', 'PIN-TEST', 'MAT-FIFO', 'MAT-CRIT']);
    assert.deepEqual(
      { alta: r.body.resumen.alta, media: r.body.resumen.media, baja: r.body.resumen.baja, sin: r.body.resumen.sin_rotacion },
      { alta: 1, media: 1, baja: 1, sin: 1 }
    );
  });

  test('el nivel no depende del largo del período: mismo ritmo en 30 y en 90 días, mismo nivel', async () => {
    // 1 unidad por día sostenida: índice 0,65 en 30 días y 1,19 en 90, ambos "media" al mensualizar
    for (let d = 1; d <= 89; d += 1) await movimiento({ cantidad: 1, dias: d });

    const corto = (await rotacion(hoyMas(-29))).body.productos.find(x => x.sku === 'MAT-FIFO');
    const largo = (await rotacion(hoyMas(-89))).body.productos.find(x => x.sku === 'MAT-FIFO');
    assert.ok(largo.indice > corto.indice, 'el índice crudo crece con el período');
    assert.equal(corto.nivel, 'media');
    assert.equal(largo.nivel, 'media');
  });

  test('revertidos, inversos y traslados no son consumo; las devoluciones de consumo restan', async () => {
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
    await movimiento({ cantidad: 20, dias: 10 });
    const original = await movimiento({ cantidad: 50, estado: 'revertido', dias: 8 });
    await movimiento({ tipo: 1, cantidad: 50, revierte: original, dias: 7 });   // su inverso
    await movimiento({ cantidad: 500, motivo: 9, dias: 6 });                    // traslado
    await movimiento({ tipo: 1, cantidad: 5, motivo: 6, dias: 5 });             // devolución sin OT

    const p = (await rotacion()).body.productos.find(x => x.sku === 'MAT-FIFO');
    assert.equal(p.consumo, 15, '20 − 5 devueltos');
  });

  test('Exc 2: stock promedio cero → N/A, fuera del orden; stock pasado negativo → historial incompleto', async () => {
    await movimiento({ cantidad: 20, dias: 10 });                              // hay consumo en el período
    await db.query(`UPDATE inventario.inventario_bodega SET inventario_bodega_cantidad_fisica = 0
                    WHERE material_sku = 'MAT-UNO'`);
    await movimiento({ sku: 'PIN-TEST', tipo: 1, cantidad: 50, dias: 5 });    // entrada que el stock no refleja

    const r = await rotacion();
    const na = Object.fromEntries(r.body.no_calculables.map(x => [x.sku, x]));
    assert.equal(na['MAT-UNO'].indice, null);
    assert.equal(na['MAT-UNO'].nivel, 'na');
    assert.equal(na['MAT-UNO'].historial_incompleto, false);
    assert.equal(na['PIN-TEST'].stock_inicio, -30, '20 actuales − 50 de una entrada posterior');
    assert.equal(na['PIN-TEST'].historial_incompleto, true);
    assert.ok(!r.body.productos.some(x => ['MAT-UNO', 'PIN-TEST'].includes(x.sku)));
    assert.equal(r.body.resumen.na, 2);
    assert.equal(r.body.resumen.historial_incompleto, 1);
  });

  test('Exc 1: formato inválido, inicio posterior al fin o fin futuro → 400', async () => {
    for (const [desde, hasta] of [
      ['27/09/2026', hoyMas(0)],
      ['2026-02-30', hoyMas(0)],
      ['', hoyMas(0)],
      [hoyMas(-1), hoyMas(-5)],
      [hoyMas(-5), hoyMas(1)],
    ]) {
      const r = await rotacion(desde, hasta);
      assert.equal(r.status, 400, `${desde} → ${hasta}`);
      assert.ok(r.body.error);
    }
  });

  test('Exc 3: sin movimientos de consumo en el período → aviso y listas vacías', async () => {
    await movimiento({ cantidad: 20, dias: 60 });            // fuera del período
    await movimiento({ tipo: 1, cantidad: 5, dias: 3 });     // una entrada no es consumo

    const r = await rotacion();
    assert.equal(r.status, 200);
    assert.match(r.body.mensaje, /no hay datos de consumo/i);
    assert.deepEqual(r.body.productos, []);
    assert.deepEqual(r.body.no_calculables, []);
  });

  test('calcular la rotación no mueve stock', async () => {
    await movimiento({ cantidad: 20, dias: 10 });
    const antes = await stockReal();
    await rotacion();
    assert.deepEqual(diferencias(antes, await stockReal()), []);
  });

  test('gerencia y jop pueden consultar; otros roles no', async () => {
    await movimiento({ cantidad: 20, dias: 10 });
    assert.equal((await rotacion(undefined, undefined, 'gerencia')).status, 200);
    assert.equal((await rotacion(undefined, undefined, 'jop')).status, 200);

    const url = await levantar();
    const tecnico = jwt.sign({ id: 3, username: 'tecnico.test', rol: 'tecnico' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const res = await fetch(`${url}/api/reportes/rotacion?desde=${hoyMas(-29)}&hasta=${hoyMas(0)}`, {
      headers: { Authorization: `Bearer ${tecnico}` },
    });
    assert.equal(res.status, 403);
  });
});

describe('Reporte histórico consolidado (CU-75)', () => {
  const ACTUAL = new Date().getFullYear();
  const Y = ACTUAL - 1;   // año completo, sin el borde del mes en curso
  const historico = (anio, rol = 'gerencia') => api('GET', `/api/reportes/historico?anio=${anio}`, { rol });

  /*
   * Stock actual de la semilla: MAT-FIFO 30 (MateriaPrima, principal proveedor 1,
   * referencial 1000), MAT-CRIT 8 (MaterialCrítico, referencial 5000), PIN-TEST 20
   * (MateriaPrima), MAT-UNO 1 y MAT-HERR 3 (MateriaPrima, sin ningún precio).
   */
  async function escenario() {
    await movimientoEn(`${Y}-03-10`, { sku: 'MAT-CRIT', tipo: 1, cantidad: 4 });   // antes: 4
    await movimientoEn(`${Y}-06-15`, { sku: 'MAT-FIFO', cantidad: 10 });           // antes: 40
    await precio('MAT-FIFO', 1, 800,  `${Y}-01-01`);    // proveedor principal
    await precio('MAT-FIFO', 1, 1200, `${Y}-07-01`);
    await precio('PIN-TEST', 2, 10000, `${Y}-01-01`);   // solo otro proveedor
  }

  test('saldos por categoría en CLP con el precio vigente al cierre de cada mes', async () => {
    await escenario();
    const r = await historico(Y);
    assert.equal(r.status, 200);
    assert.equal(r.body.meses.length, 12);
    const mes = Object.fromEntries(r.body.meses.map(m => [m.mes.slice(5), m]));

    // Exc 2: antes del primer movimiento (10 de marzo) no hay información
    assert.deepEqual(r.body.meses_sin_informacion, [`${Y}-01`, `${Y}-02`]);
    assert.equal(mes['02'].con_informacion, false);
    assert.equal(mes['02'].total, undefined);

    // Marzo: MAT-FIFO 40 × 800 + PIN-TEST 20 × 10000 (otro proveedor); MAT-CRIT 8 × 5000 (referencial)
    assert.deepEqual(mes['03'].por_categoria, { MateriaPrima: 232000, 'MaterialCrítico': 40000 });
    // Junio: la salida del 15 ya pasó → MAT-FIFO 30 × 800
    assert.equal(mes['06'].por_categoria.MateriaPrima, 224000);
    // Julio: sube el precio de MAT-FIFO → 30 × 1200
    assert.equal(mes['07'].por_categoria.MateriaPrima, 236000);
    assert.equal(mes['07'].total, 276000);
    assert.equal(mes['07'].sin_precio, 2, 'MAT-UNO y MAT-HERR no tienen precio');
    assert.equal(mes['12'].a_la_fecha, false);
    assert.deepEqual(r.body.categorias, ['MaterialCrítico', 'MateriaPrima']);
  });

  test('el cierre del mes en curso es el stock real valorizado a hoy', async () => {
    await escenario();
    const r = await historico(ACTUAL);
    const ultimo = r.body.meses.at(-1);
    assert.equal(r.body.meses.length, new Date().getMonth() + 1);
    assert.equal(ultimo.a_la_fecha, true);
    assert.equal(ultimo.total, 30 * 1200 + 8 * 5000 + 20 * 10000);
  });

  test('anual: cierres de diciembre del año y de los anteriores con información', async () => {
    await escenario();
    const r = await historico(ACTUAL);
    assert.deepEqual(r.body.anual.map(a => a.anio), [Y, ACTUAL]);
    assert.equal(r.body.anual[0].cierre, `${Y}-12-31`);
    assert.equal(r.body.anual[0].total, 276000);
    assert.equal(r.body.anual[1].a_la_fecha, true);
  });

  test('stock reconstruido negativo: se valoriza en 0 y se marca historial incompleto', async () => {
    await escenario();
    await movimientoEn(`${Y}-08-10`, { sku: 'PIN-TEST', tipo: 1, cantidad: 50 });   // el stock no la refleja
    const mes = Object.fromEntries((await historico(Y)).body.meses.map(m => [m.mes.slice(5), m]));
    assert.equal(mes['07'].historial_incompleto, 1);
    assert.equal(mes['07'].por_categoria.MateriaPrima, 36000, 'PIN-TEST (−30) vale 0');
    assert.equal(mes['08'].historial_incompleto, 0);
  });

  test('Exc 1: año sin ningún registro → mensaje, sin datos', async () => {
    await escenario();
    const r = await historico(Y - 1);
    assert.equal(r.status, 200);
    assert.match(r.body.mensaje, /no existen registros/i);
    assert.deepEqual(r.body.meses, []);
  });

  test('Exc 3: año futuro o inválido → 400', async () => {
    assert.equal((await historico(ACTUAL + 1)).status, 400);
    assert.equal((await historico('abc')).status, 400);
    assert.equal((await historico('')).status, 400);
  });

  test('solo gerencia: los montos no llegan al rol jop', async () => {
    await escenario();
    assert.equal((await historico(Y, 'jop')).status, 403);
  });
});
