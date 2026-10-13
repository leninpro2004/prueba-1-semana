const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * R1: pestaña Consumo de la OT, desde la receta (docs/incremento-3-4/decisiones.md, R1).
 *
 * Lo que protegen:
 *  - "Guardar" mueve el stock SOLO por la diferencia con lo ya registrado; quitar un
 *    material ya consumido lo devuelve a bodega.
 *  - Un rechazo (stock insuficiente, material inactivo, herramienta...) no mueve nada.
 *  - Las pinturas no se descuentan aquí: su real sale del Seguimiento de pinturas.
 *  - La OT guarda la receta y las puertas; cambiar de receta pide confirmación.
 *
 * Semilla: OT 3 abierta, área Corte, especificación → receta 1 (PB-TEST: MAT-FIFO 2 con
 * merma 0,25 y MAT-CRIT 4, ambos de Corte). OT 2 finalizada. Stock en la bodega 1:
 * MAT-FIFO 30 físicas (25 disponibles), MAT-CRIT 8, MAT-UNO 1, PIN-TEST 20 kg.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const RUTA = '/api/ordenes-trabajo/3/consumo';
const guardar = (body, rol) => api('PUT', RUTA, { body, rol });

/** Estimado y real de la OT 3, por SKU. */
async function consumoOT(ot = 3) {
  const { rows } = await db.query(
    `SELECT material_sku AS sku, material_orden_trabajo_consumo_estimado::float AS est,
            material_orden_trabajo_consumo_real::float AS real
     FROM inventario.material_orden_trabajo WHERE orden_trabajo_id_orden = $1 ORDER BY 1`, [ot]
  );
  return Object.fromEntries(rows.map(r => [r.sku, { est: r.est, real: r.real }]));
}

const movimientosOT = (ot = 3) => db.contar('inventario.movimiento_inventario', 'orden_trabajo_id_orden = $1', [ot]);

/** Receta 1 para 2 puertas, con el real que se indique. */
const conReceta = (fifo, crit, extra = []) => ({
  receta_id: 1, cantidad_puertas: 2,
  lineas: [{ sku: 'MAT-FIFO', estimado: 5, real: fifo }, { sku: 'MAT-CRIT', estimado: 8, real: crit }, ...extra],
});

/** F-05: el mismo cuerpo con motivo en cada línea y general (reajustes y quitados). */
const conMotivo = (body, motivo = 'Ajuste de prueba') => ({
  ...body, motivo, lineas: body.lineas.map(l => ({ ...l, motivo })),
});

describe('Receta precargada', () => {
  test('por la especificación de la OT, con la cantidad para N puertas', async () => {
    const cantidades = (r) => Object.fromEntries(r.body.materiales.map(m => [m.sku, m.cantidad_total]));
    let r = await api('GET', '/api/recetas/por-orden/3');
    assert.equal(r.body.origen, 'especificacion');
    assert.deepEqual(cantidades(r), { 'MAT-CRIT': 4, 'MAT-FIFO': 2.5 });

    r = await api('GET', '/api/recetas/por-orden/3?puertas=2');
    assert.deepEqual(cantidades(r), { 'MAT-CRIT': 8, 'MAT-FIFO': 5 });
    assert.equal((await api('GET', '/api/recetas/por-orden/3?puertas=0')).status, 400);
  });

  test('después de guardar, precarga la receta y las puertas guardadas en la OT', async () => {
    await guardar(conReceta(5, 8));
    const r = await api('GET', '/api/recetas/por-orden/3');
    assert.equal(r.body.origen, 'ot');
    assert.equal(r.body.puertas, 2);
    assert.equal(r.body.orden.receta_id, '1');
  });
});

describe('Guardar consumo', () => {
  test('descuenta el real por FIFO, guarda estimado, real, receta y puertas', async () => {
    const r = await guardar(conReceta(6, 8));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await consumoOT(), { 'MAT-CRIT': { est: 8, real: 8 }, 'MAT-FIFO': { est: 5, real: 6 } });
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 24, reservada: 5 });
    assert.equal(await db.stockDeLote('MAT-FIFO', 1), 4);            // lote viejo primero
    assert.deepEqual(await db.stockDe('MAT-CRIT'), { fisica: 0, reservada: 0 });
    assert.deepEqual(await db.descuadresDeReservas(), []);
    const { rows } = await db.query(
      `SELECT producto_terminado_id_producto::int AS receta, orden_trabajo_cantidad_puertas AS puertas
       FROM inventario.orden_trabajo WHERE orden_trabajo_id_orden = 3`);
    assert.deepEqual(rows[0], { receta: 1, puertas: 2 });
  });

  test('corregir y volver a guardar mueve solo la diferencia', async () => {
    await guardar(conReceta(6, 8));
    const movs = await movimientosOT();
    const r = await guardar(conMotivo(conReceta(4, 8)));            // FIFO 6 → 4: devuelve 2; CRIT igual
    assert.equal(r.status, 200);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 26, reservada: 5 });
    assert.deepEqual(await db.stockDe('MAT-CRIT'), { fisica: 0, reservada: 0 });
    assert.equal(await movimientosOT(), movs + 1);
  });

  test('quitar un material ya consumido lo devuelve a bodega y lo saca de la OT', async () => {
    await guardar(conReceta(6, 8));
    const r = await guardar(conMotivo({ receta_id: 1, cantidad_puertas: 2, lineas: [{ sku: 'MAT-FIFO', estimado: 5, real: 6 }] }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.quitados, ['MAT-CRIT']);
    assert.deepEqual(await db.stockDe('MAT-CRIT'), { fisica: 8, reservada: 0 });
    assert.equal((await consumoOT())['MAT-CRIT'], undefined);
  });

  test('un material agregado a mano queda sin estimado', async () => {
    await guardar(conReceta(5, 8, [{ sku: 'MAT-UNO', estimado: null, real: 1 }]));
    assert.deepEqual((await consumoOT())['MAT-UNO'], { est: null, real: 1 });
    assert.deepEqual(await db.stockDe('MAT-UNO'), { fisica: 0, reservada: 0 });
  });
});

describe('F-05: consumo extra o menor con motivo', () => {
  /** Descripción del último movimiento de la OT para un SKU. */
  const ultimaDescripcion = async (sku) => (await db.query(
    `SELECT movimiento_inventario_descripcion_motivo AS d FROM inventario.movimiento_inventario
     WHERE orden_trabajo_id_orden = 3 AND material_sku = $1
     ORDER BY movimiento_inventario_id_movimiento DESC LIMIT 1`, [sku]
  )).rows[0]?.d;

  test('el primer registro no pide motivo', async () => {
    const r = await guardar(conReceta(5, 8));
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  test('reajustar un real ya guardado sin motivo → 400 y no se mueve nada', async () => {
    await guardar(conReceta(5, 8));
    const movs = await movimientosOT();
    const antes = await db.stockDe('MAT-FIFO');

    const r = await guardar(conReceta(6, 8));                       // FIFO 5 → 6 sin motivo

    assert.equal(r.status, 400);
    assert.deepEqual(r.body.errores.map(e => [e.sku, e.campo]), [['MAT-FIFO', 'motivo']]);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), antes);
    assert.equal((await consumoOT())['MAT-FIFO'].real, 5);
    assert.equal(await movimientosOT(), movs);
  });

  test('con motivo mueve solo la diferencia y el movimiento lleva el motivo', async () => {
    await guardar(conReceta(5, 8));
    const r = await guardar({
      receta_id: 1, cantidad_puertas: 2,
      lineas: [{ sku: 'MAT-FIFO', estimado: 5, real: 6.2, motivo: 'Se cortó mal' }, { sku: 'MAT-CRIT', estimado: 8, real: 8 }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 23.8, reservada: 5 });   // 30 − 6,2
    assert.match(await ultimaDescripcion('MAT-FIFO'), /\(5 → 6\.2\): Se cortó mal/);
  });

  test('también un consumo menor (devuelve a bodega) pide motivo', async () => {
    await guardar(conReceta(5, 8));
    assert.equal((await guardar(conReceta(5, 7))).status, 400);
    const r = await guardar({ ...conReceta(5, 7), lineas: [conReceta(5, 7).lineas[0], { ...conReceta(5, 7).lineas[1], motivo: 'Sobró una plancha' }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await db.stockDe('MAT-CRIT'), { fisica: 1, reservada: 0 });
    assert.match(await ultimaDescripcion('MAT-CRIT'), /Sobró una plancha/);
  });

  test('quitar un material con consumo pide el motivo general', async () => {
    await guardar(conReceta(5, 8));
    const soloFifo = { receta_id: 1, cantidad_puertas: 2, lineas: [{ sku: 'MAT-FIFO', estimado: 5, real: 5 }] };

    const sin = await guardar(soloFifo);
    assert.equal(sin.status, 400);
    assert.deepEqual(await db.stockDe('MAT-CRIT'), { fisica: 0, reservada: 0 });

    const con = await guardar({ ...soloFifo, motivo: 'No se usó en esta OT' });
    assert.equal(con.status, 200, JSON.stringify(con.body));
    assert.deepEqual(await db.stockDe('MAT-CRIT'), { fisica: 8, reservada: 0 });
    assert.match(await ultimaDescripcion('MAT-CRIT'), /No se usó en esta OT/);
  });
});

describe('Rechazos: no se mueve nada', () => {
  test('stock insuficiente de un material → 400 que nombra el SKU; los demás tampoco se descuentan', async () => {
    const r = await guardar(conReceta(26, 2));                      // MAT-FIFO tiene 25 disponibles
    assert.equal(r.status, 400);
    assert.match(r.body.error, /MAT-FIFO/);
    assert.deepEqual(await db.stockDe('MAT-CRIT'), { fisica: 8, reservada: 0 });
    assert.deepEqual(await consumoOT(), {});
    assert.equal(await movimientosOT(), 0);
  });

  test('material inactivo: no se registra ni corrige; si no cambia, se puede guardar igual', async () => {
    await guardar(conReceta(5, 2));
    await db.query(`UPDATE inventario.material SET material_estado = 'inactivo' WHERE material_sku = 'MAT-CRIT'`);
    const r = await guardar(conMotivo(conReceta(5, 3)));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /inactivo/);
    assert.deepEqual(await db.stockDe('MAT-CRIT'), { fisica: 6, reservada: 0 });
    assert.equal((await guardar(conMotivo(conReceta(6, 2)))).status, 200);   // CRIT sin cambio, FIFO sí
  });

  test('herramienta, SKU inexistente, repetido o real inválido → 400 con todos los errores', async () => {
    const r = await guardar({ lineas: [
      { sku: 'MAT-HERR', real: 1 }, { sku: 'NO-EXISTE', real: 1 },
      { sku: 'MAT-UNO', real: -1 }, { sku: 'MAT-FIFO', real: 1 }, { sku: 'MAT-FIFO', real: 2 }] });
    assert.equal(r.status, 400);
    assert.equal(r.body.errores.length, 4);
    assert.equal(await movimientosOT(), 0);
  });

  test('una OT cerrada no admite consumo', async () => {
    const r = await api('PUT', '/api/ordenes-trabajo/2/consumo', { body: { lineas: [{ sku: 'MAT-UNO', real: 1 }] } });
    assert.equal(r.status, 400);
  });
});

describe('Pinturas y receta', () => {
  const seguimiento = (kg, estado = 'cerrado') => db.query(
    `INSERT INTO inventario.seguimiento_pintura (material_sku, orden_trabajo_id_orden, peso_entrada_gr, peso_salida_gr,
                                                 fecha_devolucion, estado, stock_descontado_kg)
     VALUES ('PIN-TEST', 3, 2000, 500, now(), $2, $1)`, [kg, estado]);

  test('una pintura no se descuenta al guardar: su real sale del seguimiento', async () => {
    await seguimiento(1.5);
    const r = await guardar(conReceta(5, 8, [{ sku: 'PIN-TEST', estimado: 2, real: 9 }]));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await db.stockDe('PIN-TEST'), { fisica: 20, reservada: 0 });
    assert.deepEqual((await consumoOT())['PIN-TEST'], { est: 2, real: 1.5 });
  });

  test('la pestaña lee el real de la pintura en vivo del seguimiento, aunque no se haya guardado', async () => {
    await guardar(conReceta(5, 8, [{ sku: 'PIN-TEST', estimado: 2, real: null }]));
    await seguimiento(0.5);                                          // pesaje posterior al último "Guardar"
    await seguimiento(0, 'abierto');
    const r = await api('GET', '/api/ordenes-trabajo/3/consumos');
    const pin = r.body.materiales.find(m => m.sku === 'PIN-TEST');
    assert.equal(parseFloat(pin.real), 0.5);
    assert.equal(pin.pintura_retiros_abiertos, 1);
    assert.equal(parseFloat(pin.varianza), -1.5);
  });

  test('una pintura con retiros en la OT aparece aunque no esté en la receta', async () => {
    await seguimiento(1.2);
    const r = await api('GET', '/api/ordenes-trabajo/3/consumos');
    const pin = r.body.materiales.find(m => m.sku === 'PIN-TEST');
    assert.equal(pin.es_pintura, true);
    assert.equal(pin.estimado, null);
    assert.equal(parseFloat(pin.real), 1.2);
  });

  test('una pintura con usos en el seguimiento no se puede quitar de la OT', async () => {
    await seguimiento(1.5);
    await guardar(conReceta(5, 8, [{ sku: 'PIN-TEST', estimado: 2, real: null }]));
    const r = await guardar(conReceta(5, 8));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Seguimiento de pinturas/);
  });

  test('finalizar la OT deja el real de la pintura con lo último del seguimiento', async () => {
    await guardar(conReceta(5, 8, [{ sku: 'PIN-TEST', estimado: 2, real: null }]));
    await seguimiento(0.75);
    assert.equal((await api('PUT', '/api/ordenes-trabajo/3/finalizar')).status, 200);
    assert.equal((await consumoOT())['PIN-TEST'].real, 0.75);
  });

  test('cambiar a otra receta pide confirmación (409); con reemplazar_receta se guarda', async () => {
    await guardar(conReceta(5, 8));
    const otra = await api('POST', '/api/recetas', {
      body: { nombre: 'Otra puerta', codigo: 'PB-OTRA', materiales: [{ sku: 'MAT-UNO', cantidad_base: 1, area_id: 1 }] },
    });
    // La receta anterior tenía consumo: quitarla pide motivo (F-05)
    const body = { receta_id: otra.body.id, cantidad_puertas: 1, motivo: 'Cambio de receta',
                   lineas: [{ sku: 'MAT-UNO', estimado: 1, real: 1 }] };
    let r = await guardar(body);
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'RECETA_DISTINTA');
    assert.deepEqual(await db.stockDe('MAT-UNO'), { fisica: 1, reservada: 0 });

    r = await guardar({ ...body, reemplazar_receta: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(await consumoOT()), ['MAT-UNO']);   // la receta anterior se devolvió
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 5 });
  });
});
