const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');
const { consumoNeto } = require('../src/db/historico');

/**
 * Seguimiento de pinturas con descuento de stock (OPUS-16).
 *
 * El invariante que protegen: el stock se mueve SIEMPRE por la DIFERENCIA contra
 * lo que este seguimiento ya había descontado, nunca por la cantidad completa.
 * Ese fue el bug que costó corregir en OPUS-1 (modo 'actualizar' descontaba dos
 * veces) y es el que el plan de OPUS-16 marca como el riesgo principal.
 *
 * La pintura de la semilla (PIN-TEST) está en KILOGRAMOS con 20 kg en la bodega 1.
 * El envase se pesa en gramos: 1500 gr consumidos = 1,5 kg descontados.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const PIN = 'PIN-TEST';
const STOCK_INICIAL = 20;

/** Estado en BD de un seguimiento. */
async function seguimiento(id) {
  const { rows } = await db.query(
    `SELECT estado, peso_consumido_gr, stock_descontado_kg
     FROM inventario.seguimiento_pintura WHERE seguimiento_pintura_id = $1`,
    [id]
  );
  return rows.length ? {
    estado: rows[0].estado,
    consumido: rows[0].peso_consumido_gr != null ? parseFloat(rows[0].peso_consumido_gr) : null,
    descontado: parseFloat(rows[0].stock_descontado_kg),
  } : null;
}

/** Movimientos de la pintura que siguen contando (no revertidos), con signo y motivo. */
async function movimientosVigentes() {
  const { rows } = await db.query(
    `SELECT CASE WHEN tm.movimiento_inventario_tipo_movimiento_nombre = 'entrada' THEN 1 ELSE -1 END
              * mi.movimiento_inventario_cantidad AS firmado,
            mot.movimiento_inventario_motivo_movimiento_nombre AS motivo
     FROM inventario.movimiento_inventario mi
     JOIN inventario.movimiento_inventario_tipo_movimiento tm
       ON tm.movimiento_inventario_tipo_movimiento_id_tipo_movimiento = mi.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
     LEFT JOIN inventario.movimiento_inventario_motivo_movimiento mot
       ON mot.movimiento_inventario_motivo_movimiento_id_motivo_movimiento = mi.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
     WHERE mi.material_sku = $1 AND mi.movimiento_inventario_estado <> 'revertido'
     ORDER BY mi.movimiento_inventario_id_movimiento`,
    [PIN]
  );
  return rows.map(r => ({ firmado: parseFloat(r.firmado), motivo: r.motivo }));
}

describe('Registrar uso de pintura', () => {
  test('un retiro abierto NO mueve stock: el consumo todavía es desconocido', async () => {
    const r = await api('POST', '/api/seguimiento-pinturas', {
      body: { sku: PIN, peso_entrada_gr: 2400, bodega_id: 1, area_trabajo_id: 2 },
    });

    assert.equal(r.status, 201);
    assert.equal((await db.stockDe(PIN)).fisica, STOCK_INICIAL);
    assert.equal((await seguimiento(r.body.id)).estado, 'abierto');
  });

  test('un uso cerrado de una sola vez descuenta el consumo', async () => {
    const r = await api('POST', '/api/seguimiento-pinturas', {
      body: { sku: PIN, peso_entrada_gr: 2400, peso_salida_gr: 900, bodega_id: 1, area_trabajo_id: 2 },
    });

    assert.equal(r.status, 201);
    assert.equal(r.body.peso_consumido_gr, 1500);        // 2400 - 900
    assert.equal(r.body.stock_descontado_kg, 1.5);       // 1500 gr = 1,5 kg
    assert.equal((await db.stockDe(PIN)).fisica, STOCK_INICIAL - 1.5);
  });

  test('genera el movimiento de inventario correspondiente', async () => {
    await api('POST', '/api/seguimiento-pinturas', {
      body: { sku: PIN, peso_entrada_gr: 2400, peso_salida_gr: 900, bodega_id: 1, area_trabajo_id: 2 },
    });

    const { rows } = await db.query(
      `SELECT movimiento_inventario_cantidad AS cantidad
       FROM inventario.movimiento_inventario WHERE material_sku = $1`,
      [PIN]
    );
    assert.equal(rows.length, 1);
    assert.equal(parseFloat(rows[0].cantidad), 1.5);
  });

  test('un material que no es pintura se rechaza y no mueve stock', async () => {
    const antes = await db.stockDe('MAT-FIFO');

    const r = await api('POST', '/api/seguimiento-pinturas', {
      body: { sku: 'MAT-FIFO', peso_entrada_gr: 2400, peso_salida_gr: 900, bodega_id: 1, area_trabajo_id: 2 },
    });

    assert.equal(r.status, 400);
    assert.equal((await db.stockDe('MAT-FIFO')).fisica, antes.fisica);
  });

  test('un peso de vuelta mayor que el de salida se rechaza sin mover stock', async () => {
    const r = await api('POST', '/api/seguimiento-pinturas', {
      body: { sku: PIN, peso_entrada_gr: 900, peso_salida_gr: 2400, bodega_id: 1, area_trabajo_id: 2 },
    });

    assert.equal(r.status, 400);
    assert.equal((await db.stockDe(PIN)).fisica, STOCK_INICIAL);
  });

  test('un consumo mayor al stock disponible se rechaza y no escribe el seguimiento', async () => {
    // 25 kg de consumo contra 20 kg de stock
    const r = await api('POST', '/api/seguimiento-pinturas', {
      body: { sku: PIN, peso_entrada_gr: 25000, peso_salida_gr: 0, bodega_id: 1, area_trabajo_id: 2 },
    });

    assert.equal(r.status, 400);
    assert.equal((await db.stockDe(PIN)).fisica, STOCK_INICIAL);
    const { rows } = await db.query(`SELECT COUNT(*) AS n FROM inventario.seguimiento_pintura`);
    assert.equal(rows[0].n, '0');   // ROLLBACK: no quedó el seguimiento sin su descuento
  });
});

describe('Devolver el envase', () => {
  test('descuenta el consumo al devolver', async () => {
    const abierto = await api('POST', '/api/seguimiento-pinturas', {
      body: { sku: PIN, peso_entrada_gr: 2400, bodega_id: 1, area_trabajo_id: 2 },
    });

    const r = await api('PUT', `/api/seguimiento-pinturas/${abierto.body.id}/devolver`, {
      body: { peso_salida_gr: 900 },
    });

    assert.equal(r.status, 200);
    assert.equal(r.body.stock_descontado_kg, 1.5);
    assert.equal((await db.stockDe(PIN)).fisica, STOCK_INICIAL - 1.5);
    assert.equal((await seguimiento(abierto.body.id)).estado, 'cerrado');
  });

  test('no se puede devolver dos veces', async () => {
    const a = await api('POST', '/api/seguimiento-pinturas', {
      body: { sku: PIN, peso_entrada_gr: 2400, bodega_id: 1, area_trabajo_id: 2 },
    });
    await api('PUT', `/api/seguimiento-pinturas/${a.body.id}/devolver`, { body: { peso_salida_gr: 900 } });

    const r = await api('PUT', `/api/seguimiento-pinturas/${a.body.id}/devolver`, { body: { peso_salida_gr: 500 } });

    assert.equal(r.status, 400);
    // El segundo intento no volvió a descontar
    assert.equal((await db.stockDe(PIN)).fisica, STOCK_INICIAL - 1.5);
  });

  test('un seguimiento inexistente da 404', async () => {
    const r = await api('PUT', '/api/seguimiento-pinturas/999/devolver', { body: { peso_salida_gr: 900 } });
    assert.equal(r.status, 404);
  });
});

describe('Corregir un consumo ya registrado', () => {
  /* Este bloque es el corazón de OPUS-16: el stock se mueve por la DIFERENCIA. */

  test('corregir hacia ARRIBA descuenta solo la diferencia', async () => {
    const a = await api('POST', '/api/seguimiento-pinturas', {
      body: { sku: PIN, peso_entrada_gr: 2400, peso_salida_gr: 900, bodega_id: 1, area_trabajo_id: 2 },
    });
    // consumo 1500 gr -> stock 18,5

    // Se corrige: el envase volvió pesando 400, así que se consumieron 2000 gr
    const r = await api('PUT', `/api/seguimiento-pinturas/${a.body.id}`, {
      body: { peso_salida_gr: 400 },
    });

    assert.equal(r.status, 200);
    assert.equal(r.body.ajuste_stock_kg, 0.5);              // solo los 500 gr de diferencia
    assert.equal((await db.stockDe(PIN)).fisica, STOCK_INICIAL - 2);
    assert.equal((await seguimiento(a.body.id)).descontado, 2);
  });

  test('corregir hacia ABAJO devuelve la diferencia al stock', async () => {
    const a = await api('POST', '/api/seguimiento-pinturas', {
      body: { sku: PIN, peso_entrada_gr: 2400, peso_salida_gr: 400, bodega_id: 1, area_trabajo_id: 2 },
    });
    // consumo 2000 gr -> stock 18

    const r = await api('PUT', `/api/seguimiento-pinturas/${a.body.id}`, {
      body: { peso_salida_gr: 1400 },
    });

    assert.equal(r.status, 200);
    assert.equal(r.body.ajuste_stock_kg, -1);
    assert.equal((await db.stockDe(PIN)).fisica, STOCK_INICIAL - 1);
  });

  test('corregir sin cambiar el consumo no mueve el stock', async () => {
    const a = await api('POST', '/api/seguimiento-pinturas', {
      body: { sku: PIN, peso_entrada_gr: 2400, peso_salida_gr: 900, bodega_id: 1, area_trabajo_id: 2 },
    });

    const r = await api('PUT', `/api/seguimiento-pinturas/${a.body.id}`, {
      body: { observacion: 'solo cambio la nota' },
    });

    assert.equal(r.status, 200);
    assert.equal(r.body.ajuste_stock_kg, 0);
    assert.equal((await db.stockDe(PIN)).fisica, STOCK_INICIAL - 1.5);
  });

  test('una corrección inválida se rechaza y no mueve stock', async () => {
    const a = await api('POST', '/api/seguimiento-pinturas', {
      body: { sku: PIN, peso_entrada_gr: 2400, peso_salida_gr: 900, bodega_id: 1, area_trabajo_id: 2 },
    });

    // el envase no puede volver pesando más de lo que salió
    const r = await api('PUT', `/api/seguimiento-pinturas/${a.body.id}`, {
      body: { peso_salida_gr: 5000 },
    });

    assert.equal(r.status, 400);
    assert.equal((await db.stockDe(PIN)).fisica, STOCK_INICIAL - 1.5);
    assert.equal((await seguimiento(a.body.id)).descontado, 1.5);
  });

  test('corregir varias veces seguidas no acumula descuentos de más', async () => {
    const a = await api('POST', '/api/seguimiento-pinturas', {
      body: { sku: PIN, peso_entrada_gr: 3000, peso_salida_gr: 2000, bodega_id: 1, area_trabajo_id: 2 },
    });

    await api('PUT', `/api/seguimiento-pinturas/${a.body.id}`, { body: { peso_salida_gr: 1000 } });
    await api('PUT', `/api/seguimiento-pinturas/${a.body.id}`, { body: { peso_salida_gr: 2500 } });
    await api('PUT', `/api/seguimiento-pinturas/${a.body.id}`, { body: { peso_salida_gr: 2000 } });

    // Volvió al consumo original: el stock tiene que estar exactamente como tras el primer registro
    assert.equal((await db.stockDe(PIN)).fisica, STOCK_INICIAL - 1);
    assert.equal((await seguimiento(a.body.id)).descontado, 1);
  });
});

describe('Anular un seguimiento', () => {
  test('devuelve al stock todo lo que había descontado', async () => {
    const a = await api('POST', '/api/seguimiento-pinturas', {
      body: { sku: PIN, peso_entrada_gr: 2400, peso_salida_gr: 900, bodega_id: 1, area_trabajo_id: 2 },
    });

    const r = await api('PUT', `/api/seguimiento-pinturas/${a.body.id}/anular`, {
      body: { motivo: 'se pesó mal el envase' },
    });

    assert.equal(r.status, 200);
    assert.equal(r.body.devuelto_kg, 1.5);
    assert.equal((await db.stockDe(PIN)).fisica, STOCK_INICIAL);   // exactamente como al inicio
    assert.equal((await seguimiento(a.body.id)).estado, 'anulado');
  });

  test('con correcciones de por medio, los movimientos vigentes y el consumo neto quedan en cero', async () => {
    const a = await api('POST', '/api/seguimiento-pinturas', {
      body: { sku: PIN, peso_entrada_gr: 2400, peso_salida_gr: 900, bodega_id: 1, area_trabajo_id: 2 },   // −1,5 kg
    });
    await api('PUT', `/api/seguimiento-pinturas/${a.body.id}`, { body: { peso_salida_gr: 1400 } });  // +0,5 kg
    await api('PUT', `/api/seguimiento-pinturas/${a.body.id}/anular`, { body: {} });                  // +1 kg

    const movs = await movimientosVigentes();
    assert.equal(movs.reduce((s, m) => s + m.firmado, 0), 0, 'la historia cuadra con el stock');
    assert.deepEqual(movs.filter(m => m.firmado > 0).map(m => m.motivo), ['devolucion_consumo', 'devolucion_consumo']);
    assert.equal((await consumoNeto(db)).get(PIN), 0, 'sin OT, la devolución igual resta del consumo');
    assert.equal((await db.stockDe(PIN)).fisica, STOCK_INICIAL);
  });

  test('anular un retiro abierto no mueve stock (no había descontado nada)', async () => {
    const a = await api('POST', '/api/seguimiento-pinturas', {
      body: { sku: PIN, peso_entrada_gr: 2400, bodega_id: 1, area_trabajo_id: 2 },
    });

    const r = await api('PUT', `/api/seguimiento-pinturas/${a.body.id}/anular`, { body: {} });

    assert.equal(r.status, 200);
    assert.equal((await db.stockDe(PIN)).fisica, STOCK_INICIAL);
  });

  test('no se puede anular dos veces', async () => {
    const a = await api('POST', '/api/seguimiento-pinturas', {
      body: { sku: PIN, peso_entrada_gr: 2400, peso_salida_gr: 900, bodega_id: 1, area_trabajo_id: 2 },
    });
    await api('PUT', `/api/seguimiento-pinturas/${a.body.id}/anular`, { body: {} });

    const r = await api('PUT', `/api/seguimiento-pinturas/${a.body.id}/anular`, { body: {} });

    assert.equal(r.status, 400);
    assert.equal((await db.stockDe(PIN)).fisica, STOCK_INICIAL);   // no devolvió de nuevo
  });

  test('un anulado no se puede corregir ni devolver', async () => {
    const a = await api('POST', '/api/seguimiento-pinturas', {
      body: { sku: PIN, peso_entrada_gr: 2400, bodega_id: 1, area_trabajo_id: 2 },
    });
    await api('PUT', `/api/seguimiento-pinturas/${a.body.id}/anular`, { body: {} });

    const dev = await api('PUT', `/api/seguimiento-pinturas/${a.body.id}/devolver`, { body: { peso_salida_gr: 900 } });
    const cor = await api('PUT', `/api/seguimiento-pinturas/${a.body.id}`, { body: { peso_salida_gr: 900 } });

    assert.equal(dev.status, 400);
    assert.equal(cor.status, 400);
    assert.equal((await db.stockDe(PIN)).fisica, STOCK_INICIAL);
  });

  test('un anulado no cuenta como consumo en el listado', async () => {
    const a = await api('POST', '/api/seguimiento-pinturas', {
      body: { sku: PIN, peso_entrada_gr: 2400, peso_salida_gr: 900, bodega_id: 1, area_trabajo_id: 2 },
    });
    await api('PUT', `/api/seguimiento-pinturas/${a.body.id}/anular`, { body: {} });

    const lista = await api('GET', '/api/seguimiento-pinturas');

    assert.equal(lista.status, 200);
    assert.equal(lista.body.seguimientos.length, 0);       // oculto por defecto
    assert.equal(lista.body.resumen.consumido_gr, 0);
  });
});

describe('OT y área del retiro (D65)', () => {
  const registrar = (extra) => api('POST', '/api/seguimiento-pinturas', {
    body: { sku: PIN, peso_entrada_gr: 2400, peso_salida_gr: 900, bodega_id: 1, ...extra },
  });

  test('con OT abierta, el área del registro es la de la OT', async () => {
    const r = await registrar({ orden_trabajo_id: 1 });          // OT 1: en curso, área Corte (1)
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const { rows } = await db.query(
      `SELECT area_trabajo_id::int AS area FROM inventario.seguimiento_pintura WHERE seguimiento_pintura_id = $1`, [r.body.id]);
    assert.equal(rows[0].area, 1);
  });

  test('rechazos sin mover stock: OT finalizada, área distinta a la de la OT, o sin OT y sin área', async () => {
    for (const extra of [{ orden_trabajo_id: 2 }, { orden_trabajo_id: 1, area_trabajo_id: 2 }, {}]) {
      const r = await registrar(extra);
      assert.equal(r.status, 400, JSON.stringify(extra));
    }
    assert.equal(await db.contar('inventario.seguimiento_pintura'), 0);
    assert.deepEqual(await db.stockDe(PIN), { fisica: STOCK_INICIAL, reservada: 0 });
  });
});
