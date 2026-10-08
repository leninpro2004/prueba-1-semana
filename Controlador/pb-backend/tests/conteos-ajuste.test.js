const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar, autorizacion } = require('./helpers/api');
const db = require('./helpers/db');
const { stockAFecha, consumoNeto } = require('../src/db/historico');

/**
 * D53: ajuste del stock desde las diferencias de un conteo procesado (solo gerencia).
 *
 * Lo que protegen:
 *  - El stock se mueve por la DIFERENCIA registrada (contado − teórico): faltante = salida por FIFO de lo libre,
 *    sobrante = entrada; un "no esperado" sin lotes en la bodega crea el suyo.
 *  - Si el faltante supera lo libre (hay reservas), se rechaza y NO se mueve nada (tampoco las demás líneas).
 *  - No se ajusta dos veces; revertido con CU-44, se puede volver a ajustar.
 *  - El ajuste no cuenta como consumo y stockAFecha lo reconstruye bien.
 *  - Las alertas por diferencia del conteo (CU-57) quedan resueltas por quien aprueba.
 *
 * Semilla: la bodega 1 tiene MAT-FIFO (30 físicas, 5 reservadas: 25 libres), MAT-CRIT (8, crítico),
 * MAT-UNO (1), MAT-HERR (3) y PIN-TEST (20).
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const MOTIVO = 'Diferencia confirmada en el recuento';
/** Conteo de la bodega 1 con `contado` por SKU, ya procesado (CU-43). Devuelve su id. */
async function conteoProcesado(contado) {
  // La justificación permite un segundo conteo de la bodega en el día (CU-37 Exc 3)
  const r = await api('POST', '/api/conteos', { body: { bodega_id: 1, justificacion: 'Recuento de prueba',
    lineas: Object.entries(contado).map(([sku, cantidad]) => ({ sku, cantidad })) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await api('POST', `/api/conteos/${r.body.id}/procesar`)).status, 201);
  return r.body.id;
}
const ajustar = (id, skus, motivo = MOTIVO, rol) => api('POST', `/api/conteos/${id}/ajustes`, { body: { skus, motivo }, rol });

async function movimientosDe(id) {
  const { rows } = await db.query(
    `SELECT movimiento_inventario_id_movimiento::int AS id, material_sku AS sku, movimiento_inventario_cantidad::float AS cantidad,
            movimiento_inventario_tipo_movimiento_id_tipo_movimiento::int AS tipo,
            movimiento_inventario_motivo_movimiento_id_motivo_movimiento::int AS motivo, lote_id_lote::int AS lote
     FROM inventario.movimiento_inventario WHERE movimiento_inventario_referencia_origen = $1 ORDER BY 1`, [`CONTEO-${id}`]);
  return rows;
}

describe('Ajustar por la diferencia', () => {
  test('faltante y sobrante mueven el stock por la diferencia, con el motivo y la referencia del conteo', async () => {
    const id = await conteoProcesado({ 'MAT-FIFO': 27, 'PIN-TEST': 21, 'MAT-CRIT': 8 });
    const antes = new Date();

    const r = await ajustar(id, ['MAT-FIFO', 'PIN-TEST']);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 27, reservada: 5 });
    assert.deepEqual(await db.stockDe('PIN-TEST'), { fisica: 21, reservada: 0 });
    assert.deepEqual(await db.descuadresDeReservas(), []);

    const movs = await movimientosDe(id);
    assert.deepEqual(movs.map(m => [m.sku, m.cantidad, m.tipo, m.motivo]), [['MAT-FIFO', 3, 2, 4], ['PIN-TEST', 1, 1, 4]]);
    assert.equal(movs[0].lote, 1);                                   // FIFO: el lote más antiguo
    // stockAFecha reconstruye el stock de antes del ajuste
    const previo = await stockAFecha(db, antes);
    assert.equal(previo.get('MAT-FIFO'), 30);
    assert.equal(previo.get('PIN-TEST'), 20);
    // D53: el ajuste no es consumo
    const consumo = await consumoNeto(db, {});
    assert.ok(!consumo.get('MAT-FIFO'), `consumo de MAT-FIFO: ${consumo.get('MAT-FIFO')}`);

    const d = (await api('GET', `/api/conteos/${id}/diferencias`)).body.lineas;
    assert.deepEqual(d.filter(l => l.ajustado).map(l => l.sku).sort(), ['MAT-FIFO', 'PIN-TEST']);
    const hist = (await api('GET', '/api/movimientos?buscar=MAT-FIFO')).body.find(m => Number(m.id) === movs[0].id);
    assert.equal(hist.documento_tipo, 'conteo');
    assert.equal(hist.documento_ref, String(id));
  });

  test('un producto no esperado (sin lotes en la bodega) entra en un lote nuevo', async () => {
    await db.query(`INSERT INTO inventario.material (material_sku, material_nombre_material, material_estado, material_unidad_medida_id_unidad_medida)
                    VALUES ('MAT-NUEVO', 'Material sin stock', 'activo', 1)`);
    const id = await conteoProcesado({ 'MAT-NUEVO': 4 });
    assert.equal((await ajustar(id, ['MAT-NUEVO'])).status, 201);
    assert.deepEqual(await db.stockDe('MAT-NUEVO'), { fisica: 4, reservada: 0 });
    const [m] = await movimientosDe(id);
    assert.ok(m.lote, 'la entrada tiene lote (se puede revertir)');
  });
});

describe('Rechazos: no se mueve nada', () => {
  test('un faltante mayor que lo libre (hay reservas) se rechaza, y con él todas las líneas', async () => {
    const id = await conteoProcesado({ 'MAT-FIFO': 2, 'PIN-TEST': 19 });   // faltan 28 y hay 25 libres
    const movs = await db.contar('inventario.movimiento_inventario');
    const r = await ajustar(id, ['MAT-FIFO', 'PIN-TEST']);
    assert.equal(r.status, 400);
    assert.match(r.body.errores[0].error, /25 libre/);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 5 });
    assert.deepEqual(await db.stockDe('PIN-TEST'), { fisica: 20, reservada: 0 });
    assert.equal(await db.contar('inventario.movimiento_inventario'), movs);
  });

  test('conteo sin procesar, sin motivo, sin diferencia, otro rol', async () => {
    const c = await api('POST', '/api/conteos', { body: { bodega_id: 1, lineas: [{ sku: 'MAT-FIFO', cantidad: 28 }] } });
    assert.equal((await ajustar(c.body.id, ['MAT-FIFO'])).status, 400);   // confirmado, no procesado
    const id = await conteoProcesado({ 'MAT-FIFO': 28, 'MAT-CRIT': 8 });
    assert.equal((await ajustar(id, ['MAT-FIFO'], '')).status, 400);
    assert.equal((await ajustar(id, ['MAT-CRIT'])).status, 400);           // sin diferencia
    assert.equal((await ajustar(id, ['MAT-FIFO'], MOTIVO, 'jop')).status, 403);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 5 });
  });

  test('no se ajusta dos veces; revertido el ajuste (CU-44), se puede volver a ajustar', async () => {
    const id = await conteoProcesado({ 'MAT-FIFO': 28 });
    assert.equal((await ajustar(id, ['MAT-FIFO'])).status, 201);
    const otra = await ajustar(id, ['MAT-FIFO']);
    assert.equal(otra.status, 400);
    assert.match(otra.body.error, /Ya se ajustó/);

    const [m] = await movimientosDe(id);
    const rev = await api('POST', `/api/movimientos/${m.id}/revertir`, { body: { autorizacion: autorizacion(m.id) } });
    assert.equal(rev.status, 200, JSON.stringify(rev.body));
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 5 });

    assert.equal((await ajustar(id, ['MAT-FIFO'])).status, 201);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 28, reservada: 5 });
  });
});

describe('Alertas del conteo (CU-57)', () => {
  test('las alertas por diferencia del producto ajustado quedan resueltas por quien aprueba', async () => {
    const id = await conteoProcesado({ 'MAT-FIFO': 25, 'PIN-TEST': 17 });   // −16,7 % y −15 %: fuera de tolerancia
    assert.equal((await api('POST', `/api/conteos/${id}/alertas`)).status, 201);
    assert.equal((await ajustar(id, ['MAT-FIFO'])).status, 201);
    const { rows } = await db.query(
      `SELECT a.material_sku AS sku, a.alerta_inventario_estado AS estado, h.usuario_id_usuario::int AS usuario,
              h.historial_alerta_fecha_hora_resolucion IS NOT NULL AS con_fecha
       FROM inventario.alerta_inventario a LEFT JOIN inventario.historial_alerta h USING (historial_alerta_id_historial)
       WHERE a.conteo_ciclico_id_conteo = $1 ORDER BY 1`, [id]);
    assert.deepEqual(rows, [
      { sku: 'MAT-FIFO', estado: 'resuelta', usuario: 1, con_fecha: true },
      { sku: 'PIN-TEST', estado: 'activa', usuario: null, con_fecha: false },
    ]);
  });
});
