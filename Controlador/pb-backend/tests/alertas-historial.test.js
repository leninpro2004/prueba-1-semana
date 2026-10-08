const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * Historial de alertas (CU-55).
 *
 * Lo que protegen:
 *  - resolver registra la fecha Y el usuario, y no se puede resolver dos veces
 *    (antes se pisaba la fecha de resolución)
 *  - el cierre automático del generador registra la fecha (usuario "Sistema")
 *  - el promedio de resolución solo cuenta resueltas con fecha; las pendientes
 *    salen "en curso" (Exc 3)
 *  - el rango de fechas se valida (Exc 2) y se aplica a la fecha de generación
 *
 * Tipos de la semilla: 2 stock_critico (urgente), 5 tiempo reposicion (media),
 * 6 stock bajo minimo (alta).
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const historial = (qs = '', rol = 'gerencia') => api('GET', '/api/alertas/historial' + qs, { rol });

function fechaLocal(diasAtras = 0) {
  const d = new Date();
  d.setDate(d.getDate() - diasAtras);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Alerta directa en BD. `generada` y `resuelta` son horas atrás; `resuelta: undefined`
 * la deja activa, `resuelta: null` la deja resuelta SIN fecha (datos antiguos).
 */
async function alerta({ sku = 'MAT-FIFO', tipo = 6, generada = 48, resuelta, usuario = null, conHistorial = true } = {}) {
  let hist = null;
  if (conHistorial) {
    const { rows } = await db.query(
      `INSERT INTO inventario.historial_alerta (historial_alerta_fecha_hora_resolucion, usuario_id_usuario)
       VALUES (CASE WHEN $1::float IS NULL THEN NULL ELSE now() - make_interval(secs => $1::float * 3600) END, $2)
       RETURNING historial_alerta_id_historial AS id`,
      [resuelta ?? null, usuario]
    );
    hist = rows[0].id;
  }
  const { rows } = await db.query(
    `INSERT INTO inventario.alerta_inventario (alerta_inventario_mensaje, alerta_inventario_estado, material_sku,
       alerta_inventario_tipo_alerta_id_tipo_alerta, historial_alerta_id_historial, alerta_inventario_fecha_generacion)
     VALUES ('prueba', $1, $2, $3, $4, now() - make_interval(secs => $5::float * 3600))
     RETURNING alerta_inventario_id_alerta AS id`,
    [resuelta === undefined ? 'activa' : 'resuelta', sku, tipo, hist, generada]
  );
  return rows[0].id;
}

async function historialDe(alertaId) {
  const { rows } = await db.query(
    `SELECT ha.historial_alerta_fecha_hora_resolucion AS fecha, ha.usuario_id_usuario::int AS usuario
     FROM inventario.alerta_inventario a
     JOIN inventario.historial_alerta ha ON ha.historial_alerta_id_historial = a.historial_alerta_id_historial
     WHERE a.alerta_inventario_id_alerta = $1`,
    [alertaId]
  );
  return rows[0];
}

describe('Resolver alertas (CU-55)', () => {
  test('registra la fecha y el usuario que resolvió', async () => {
    const id = await alerta({ generada: 24 });
    const r = await api('PUT', `/api/alertas/${id}/resolver`);
    assert.equal(r.status, 200);

    const h = await historialDe(id);
    assert.ok(h.fecha);
    assert.equal(h.usuario, 1);

    const { body } = await historial();
    const a = body.alertas.find(x => String(x.id) === String(id));
    assert.equal(a.estado, 'Resuelta');
    assert.equal(a.resuelta_por, 'gerente.test');
    assert.ok(Math.abs(a.tiempo_resolucion_segundos - 24 * 3600) < 120, 'unas 24 horas');
  });

  test('no se puede resolver dos veces: 400 y la fecha no cambia', async () => {
    const id = await alerta({ generada: 24, resuelta: 2, usuario: 2 });
    const antes = await historialDe(id);

    const r = await api('PUT', `/api/alertas/${id}/resolver`);
    assert.equal(r.status, 400);
    assert.deepEqual(await historialDe(id), antes);
  });

  test('una alerta antigua sin historial se resuelve creándoselo', async () => {
    const id = await alerta({ conHistorial: false });
    assert.equal((await api('PUT', `/api/alertas/${id}/resolver`)).status, 200);
    const h = await historialDe(id);
    assert.ok(h.fecha);
    assert.equal(h.usuario, 1);
  });

  test('alerta inexistente: 404', async () => {
    assert.equal((await api('PUT', '/api/alertas/99999/resolver')).status, 404);
  });

  test('el cierre automático del generador registra la fecha, sin usuario ("Sistema")', async () => {
    await db.query(`UPDATE inventario.inventario_bodega SET inventario_bodega_cantidad_fisica = 0 WHERE material_sku = 'MAT-FIFO'`);
    await db.query(`UPDATE inventario.inventario_bodega SET inventario_bodega_cantidad_fisica = 1,
                    inventario_bodega_cantidad_reservada = 0 WHERE material_sku = 'MAT-FIFO' AND lote_id_lote = 1`);
    await api('POST', '/api/alertas/generar');
    const { rows } = await db.query(
      `SELECT alerta_inventario_id_alerta AS id FROM inventario.alerta_inventario
       WHERE material_sku = 'MAT-FIFO' AND alerta_inventario_estado = 'activa'`
    );
    assert.equal(rows.length, 1);

    await db.query(`UPDATE inventario.inventario_bodega SET inventario_bodega_cantidad_fisica = 30 WHERE material_sku = 'MAT-FIFO' AND lote_id_lote = 1`);
    await api('POST', '/api/alertas/generar');

    const h = await historialDe(rows[0].id);
    assert.ok(h.fecha, 'el cierre automático deja fecha de resolución');
    assert.equal(h.usuario, null);
    const a = (await historial()).body.alertas.find(x => String(x.id) === String(rows[0].id));
    assert.equal(a.resuelta_por, 'Sistema');
  });
});

describe('Historial de alertas (CU-55)', () => {
  test('resumen: el promedio solo cuenta resueltas con fecha; las pendientes van en curso', async () => {
    await alerta({ generada: 10, resuelta: 9, usuario: 1 });       // 1 h
    await alerta({ generada: 10, resuelta: 7 });                   // 3 h, Sistema
    await alerta({ generada: 10, resuelta: null });                // resuelta sin fecha: Sin registro
    const pend = await alerta({ generada: 5 });                    // pendiente

    const { status, body } = await historial();
    assert.equal(status, 200);
    assert.equal(body.resumen.total, 4);
    assert.equal(body.resumen.resueltas, 3);
    assert.equal(body.resumen.pendientes, 1);
    assert.equal(body.resumen.resueltas_con_tiempo, 2);
    assert.ok(Math.abs(body.resumen.tiempo_promedio_segundos - 2 * 3600) < 5, 'promedio de 1 h y 3 h');

    const p = body.alertas.find(x => String(x.id) === String(pend));
    assert.equal(p.estado, 'Pendiente');
    assert.equal(p.en_curso, true);
    assert.equal(p.tiempo_resolucion_segundos, null);
    assert.equal(p.resuelta_por, null);
    assert.deepEqual(body.alertas.map(a => a.resuelta_por).filter(Boolean).sort(), ['Sin registro', 'Sistema', 'gerente.test']);
  });

  test('severidad = prioridad del tipo; orden de la más reciente a la más antigua', async () => {
    await alerta({ tipo: 2, generada: 30 });
    await alerta({ tipo: 5, generada: 20 });
    const { body } = await historial();
    assert.deepEqual(body.alertas.map(a => [a.tipo, a.severidad]),
      [['tiempo reposicion', 'media'], ['stock_critico', 'urgente']]);
  });

  test('filtra por rango de fechas de generación, tipo y producto', async () => {
    await alerta({ sku: 'MAT-FIFO', tipo: 6, generada: 24 * 10 });   // hace 10 días
    await alerta({ sku: 'MAT-CRIT', tipo: 2, generada: 24 * 3 });    // hace 3 días
    await alerta({ sku: 'MAT-UNO',  tipo: 6, generada: 1 });

    // Hasta hace 2 días, no 1: entre las 00:00 y la 01:00 la alerta "de hace 1 hora" es de
    // AYER y entraba en el rango (el test fallaba a esa hora). Hace 3 días sigue dentro.
    let r = await historial(`?desde=${fechaLocal(5)}&hasta=${fechaLocal(2)}`);
    assert.deepEqual(r.body.alertas.map(a => a.sku), ['MAT-CRIT']);

    r = await historial('?tipo=stock bajo minimo');
    assert.deepEqual(r.body.alertas.map(a => a.sku).sort(), ['MAT-FIFO', 'MAT-UNO']);

    r = await historial('?producto=crítico');                         // por nombre
    assert.deepEqual(r.body.alertas.map(a => a.sku), ['MAT-CRIT']);
    assert.equal(r.body.resumen.total, 1, 'el resumen respeta los filtros');
    assert.equal(r.body.total_sistema, 3, 'total_sistema no depende de los filtros');
  });

  test('Exc 2: inicio posterior al fin o fechas futuras → 400', async () => {
    assert.equal((await historial(`?desde=${fechaLocal(1)}&hasta=${fechaLocal(3)}`)).status, 400);
    assert.equal((await historial(`?hasta=${fechaLocal(-1)}`)).status, 400);
    assert.equal((await historial(`?desde=${fechaLocal(-2)}`)).status, 400);
    assert.equal((await historial('?desde=26-09-2026')).status, 400);
    assert.equal((await historial(`?desde=${fechaLocal(0)}&hasta=${fechaLocal(0)}`)).status, 200, 'hoy es válido');
  });

  test('Exc 1: sin alertas en el sistema → lista vacía y total_sistema 0', async () => {
    const { body } = await historial('', 'jop');
    assert.deepEqual(body.alertas, []);
    assert.equal(body.total_sistema, 0);
    assert.equal(body.resumen.tiempo_promedio_segundos, null);
  });
});

describe('Exportación del historial (CU-76)', () => {
  test('la vista trae 500; con exportar=1 trae todo lo filtrado', async () => {
    await db.query(
      `INSERT INTO inventario.alerta_inventario (alerta_inventario_mensaje, alerta_inventario_estado, material_sku,
         alerta_inventario_tipo_alerta_id_tipo_alerta)
       SELECT 'masiva', 'activa', 'MAT-FIFO', 6 FROM generate_series(1, 520)`
    );

    const vista = await historial();
    assert.equal(vista.body.alertas.length, 500);
    assert.equal(vista.body.limitado, true);

    const exp = await historial('?exportar=1');
    assert.equal(exp.status, 200);
    assert.equal(exp.body.alertas.length, 520);
    assert.equal(exp.body.limitado, false);
    assert.equal(exp.body.resumen.total, 520);
  });
});
