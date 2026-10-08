const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { api, bajar, levantar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * CU-37: conteo ciclico por bodega.
 *
 * Invariantes que protegen:
 *  - el stock teorico se guarda AL CONFIRMAR y no cambia con movimientos posteriores
 *    (D6): si cambiara, CU-43 mostraria diferencias falsas;
 *  - el teorico es la cantidad FISICA, no la disponible;
 *  - un conteo rechazado no deja nada escrito;
 *  - el conteo es ciego: ni la preparacion ni el detalle envian el teorico.
 *
 * Semilla: la bodega 1 tiene MAT-FIFO (30 fisicas, 5 reservadas), MAT-CRIT (8),
 * MAT-UNO (1), MAT-HERR (3) y PIN-TEST (20). La bodega 2 no tiene productos.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

/** Detalle guardado en BD de un conteo, indexado por SKU. */
async function detalle(id) {
  const { rows } = await db.query(
    `SELECT material_sku AS sku,
            conteo_ciclico_detalle_cantidad_contada AS contada,
            conteo_ciclico_detalle_stock_teorico    AS teorico,
            conteo_ciclico_detalle_no_esperado      AS no_esperado,
            conteo_ciclico_detalle_observacion      AS observacion
     FROM inventario.conteo_ciclico_detalle WHERE conteo_ciclico_id_conteo = $1`,
    [id]
  );
  return Object.fromEntries(rows.map(r => [r.sku, {
    ...r,
    contada: r.contada === null ? null : parseFloat(r.contada),
    teorico: r.teorico === null ? null : parseFloat(r.teorico),
  }]));
}

const conteo = (lineas, extra = {}) => api('POST', '/api/conteos', { body: { bodega_id: 1, lineas, ...extra } });

describe('Registrar un conteo (CU-37)', () => {
  test('guarda el teorico FISICO al confirmar y no cambia con una salida posterior', async () => {
    const r = await conteo([{ sku: 'MAT-FIFO', cantidad: 29 }, { sku: 'MAT-CRIT', cantidad: 8, observacion: ' caja abierta ' }]);
    assert.equal(r.status, 201);

    let d = await detalle(r.body.id);
    // 30 fisicas aunque 5 esten reservadas
    assert.equal(d['MAT-FIFO'].teorico, 30);
    assert.equal(d['MAT-FIFO'].contada, 29);
    assert.equal(d['MAT-CRIT'].observacion, 'caja abierta');

    const salida = await api('POST', '/api/movimientos/salida', {
      body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 4, tipo_movimiento_id: 2, motivo_id: 2 },
    });
    assert.equal(salida.status, 201);

    d = await detalle(r.body.id);
    assert.equal(d['MAT-FIFO'].teorico, 30);
  });

  test('queda confirmado, con fecha de confirmacion y usuario', async () => {
    const r = await conteo([{ sku: 'MAT-UNO', cantidad: 1 }]);
    const { rows } = await db.query(
      `SELECT conteo_ciclico_estado AS estado, conteo_ciclico_fecha_confirmacion AS conf, usuario_id_usuario AS usr
       FROM inventario.conteo_ciclico WHERE conteo_ciclico_id_conteo = $1`, [r.body.id]
    );
    assert.equal(rows[0].estado, 'confirmado');
    assert.ok(rows[0].conf);
    assert.equal(String(rows[0].usr), '1');
  });

  test('acepta decimales', async () => {
    const r = await conteo([{ sku: 'PIN-TEST', cantidad: '19,75' }, { sku: 'MAT-FIFO', cantidad: 30.5 }]);
    assert.equal(r.status, 201);
    const d = await detalle(r.body.id);
    assert.equal(d['PIN-TEST'].contada, 19.75);
    assert.equal(d['MAT-FIFO'].contada, 30.5);
  });

  test('los productos de la bodega no enviados quedan sin contar (NULL), con su teorico', async () => {
    const r = await conteo([{ sku: 'MAT-FIFO', cantidad: 30 }]);
    assert.equal(r.body.sin_contar, 4);
    const d = await detalle(r.body.id);
    assert.equal(Object.keys(d).length, 5);
    assert.equal(d['MAT-HERR'].contada, null);
    assert.equal(d['MAT-HERR'].teorico, 3);
  });

  test('un producto que no esta en la bodega entra como no esperado con teorico 0 (Exc 4)', async () => {
    await api('POST', '/api/materiales', { body: { sku: 'CONT-NUEVO', nombre: 'Fuera de la bodega', unidad_medida_id: 1 } });

    const r = await conteo([{ sku: 'MAT-FIFO', cantidad: 30 }, { sku: 'cont-nuevo', cantidad: 2 }]);
    assert.equal(r.status, 201);
    assert.equal(r.body.no_esperados, 1);
    const d = await detalle(r.body.id);
    assert.equal(d['CONT-NUEVO'].no_esperado, true);
    assert.equal(d['CONT-NUEVO'].teorico, 0);
    assert.equal(d['CONT-NUEVO'].contada, 2);
    assert.equal(d['MAT-FIFO'].no_esperado, false);
  });
});

describe('Rechazos del conteo (CU-37)', () => {
  test('cantidad negativa o no numerica → 400 y no se guarda nada (Exc 1)', async () => {
    for (const cantidad of [-1, 'abc', '1.23456']) {
      const r = await conteo([{ sku: 'MAT-FIFO', cantidad: 30 }, { sku: 'MAT-CRIT', cantidad }]);
      assert.equal(r.status, 400, `cantidad ${cantidad}`);
      assert.equal(r.body.sku, 'MAT-CRIT');
    }
    assert.equal(await db.contar('inventario.conteo_ciclico'), 0);
    assert.equal(await db.contar('inventario.conteo_ciclico_detalle'), 0);
  });

  test('bodega sin productos → 400 (Exc 2)', async () => {
    const prep = await api('GET', '/api/conteos/bodega/2/preparar');
    assert.equal(prep.status, 400);

    const r = await api('POST', '/api/conteos', { body: { bodega_id: 2, lineas: [{ sku: 'MAT-FIFO', cantidad: 1 }] } });
    assert.equal(r.status, 400);
    assert.equal(await db.contar('inventario.conteo_ciclico'), 0);
  });

  test('segundo conteo del dia sin justificacion → 409; con justificacion → 201 (Exc 3)', async () => {
    const primero = await conteo([{ sku: 'MAT-FIFO', cantidad: 30 }]);
    assert.equal(primero.status, 201);

    const prep = await api('GET', '/api/conteos/bodega/1/preparar');
    assert.equal(String(prep.body.conteo_hoy.id), String(primero.body.id));

    const sin = await conteo([{ sku: 'MAT-FIFO', cantidad: 28 }]);
    assert.equal(sin.status, 409);
    assert.equal(String(sin.body.conteo_existente.id), String(primero.body.id));
    assert.equal(await db.contar('inventario.conteo_ciclico'), 1);

    const con = await conteo([{ sku: 'MAT-FIFO', cantidad: 28 }], { justificacion: 'Recuento por diferencia grande' });
    assert.equal(con.status, 201);
    assert.equal(await db.contar('inventario.conteo_ciclico'), 2);
  });

  test('un SKU que no existe en el catalogo → 400 sin guardar nada', async () => {
    const r = await conteo([{ sku: 'MAT-FIFO', cantidad: 30 }, { sku: 'NO-EXISTE', cantidad: 1 }]);
    assert.equal(r.status, 400);
    assert.equal(await db.contar('inventario.conteo_ciclico'), 0);
  });

  test('un conteo sin ninguna cantidad → 400', async () => {
    const r = await conteo([{ sku: 'MAT-FIFO', cantidad: '' }]);
    assert.equal(r.status, 400);
  });

  test('el rol tecnico no puede contar (403)', async () => {
    const base = await levantar();
    const token = jwt.sign({ id: 2, username: 'tec', nombre: 'Tec', rol: 'tecnico' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const r = await fetch(base + '/api/conteos', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 403);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   CU-43: detectar diferencias
   Tolerancias de la semilla: critico 1 % / 5 %, no critico 5 % / 20 %.
   MAT-CRIT es critico (teorico 8); MAT-FIFO no lo es (teorico 30).
   ══════════════════════════════════════════════════════════════════════════ */

/** Filas de diferencia_inventario de un conteo, indexadas por SKU. */
async function difs(id) {
  const { rows } = await db.query(
    `SELECT material_sku AS sku,
            diferencia_inventario_stock_teorico::float    AS teorico,
            diferencia_inventario_cantidad_contada::float AS contada,
            diferencia_inventario_diferencia::float       AS dif,
            diferencia_inventario_diferencia_pct::float   AS pct,
            diferencia_inventario_clasificacion           AS clasif,
            diferencia_inventario_supera_tolerancia       AS supera,
            diferencia_inventario_tolerancia_pct::float   AS tol,
            diferencia_inventario_umbral_critico_pct::float AS umbral
     FROM inventario.diferencia_inventario WHERE conteo_ciclico_id_conteo = $1`,
    [id]
  );
  return Object.fromEntries(rows.map(r => [r.sku, r]));
}

async function estadoConteo(id) {
  const { rows } = await db.query(
    `SELECT conteo_ciclico_estado AS estado, conteo_ciclico_resultado AS resultado,
            conteo_ciclico_fecha_procesamiento AS fecha, usuario_procesa_id AS usr
     FROM inventario.conteo_ciclico WHERE conteo_ciclico_id_conteo = $1`, [id]
  );
  return rows[0];
}

const procesar = (id, rol) => api('POST', `/api/conteos/${id}/procesar`, { rol });

describe('Detectar diferencias (CU-43)', () => {
  test('compara contra el teorico GUARDADO: una salida posterior al conteo no cambia la diferencia', async () => {
    const c = await conteo([{ sku: 'MAT-FIFO', cantidad: 28 }]);
    await api('POST', '/api/movimientos/salida', {
      body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 4, tipo_movimiento_id: 2, motivo_id: 2 },
    });

    const r = await procesar(c.body.id);
    assert.equal(r.status, 201);
    const d = await difs(c.body.id);
    assert.equal(d['MAT-FIFO'].teorico, 30);
    assert.equal(d['MAT-FIFO'].dif, -2);
    assert.equal(d['MAT-FIFO'].pct, -6.67);
    assert.equal(d['MAT-FIFO'].clasif, 'faltante');
    assert.equal(d['MAT-FIFO'].supera, true);   // 6,67 % > 5 % (no critico)
  });

  test('la tolerancia depende de si el producto es critico, y el limite es inclusivo', async () => {
    const c = await conteo([
      { sku: 'MAT-FIFO', cantidad: 31.5 },   // +5 % exacto, no critico (5 %) → dentro
      { sku: 'MAT-CRIT', cantidad: 8.09 },   // +1,125 %, critico (1 %) → fuera
      { sku: 'MAT-HERR', cantidad: 3 },      // sin diferencia
    ]);
    await procesar(c.body.id);
    const d = await difs(c.body.id);
    assert.equal(d['MAT-FIFO'].pct, 5);
    assert.equal(d['MAT-FIFO'].supera, false);
    assert.equal(d['MAT-FIFO'].clasif, 'sobrante');
    assert.equal(d['MAT-FIFO'].tol, 5);
    assert.equal(d['MAT-CRIT'].supera, true);
    assert.equal(d['MAT-CRIT'].tol, 1);
    assert.equal(d['MAT-CRIT'].umbral, 5);
    assert.equal(d['MAT-HERR'].clasif, 'sin_diferencia');
    assert.equal(d['MAT-HERR'].supera, false);
  });

  test('un producto no esperado (teorico 0): % NULL, sobrante y fuera de tolerancia', async () => {
    await api('POST', '/api/materiales', { body: { sku: 'CONT-NUEVO', nombre: 'Fuera de la bodega', unidad_medida_id: 1 } });
    const c = await conteo([{ sku: 'MAT-FIFO', cantidad: 30 }, { sku: 'CONT-NUEVO', cantidad: 2 }]);
    await procesar(c.body.id);
    const d = await difs(c.body.id);
    assert.equal(d['CONT-NUEVO'].pct, null);
    assert.equal(d['CONT-NUEVO'].clasif, 'sobrante');
    assert.equal(d['CONT-NUEVO'].supera, true);
  });

  test('las lineas sin contar se excluyen y se informan (Exc 1)', async () => {
    const c = await conteo([{ sku: 'MAT-FIFO', cantidad: 30 }, { sku: 'MAT-CRIT', cantidad: 8 }]);
    const prev = await api('GET', `/api/conteos/${c.body.id}/diferencias`);
    assert.equal(prev.status, 200);
    assert.equal(prev.body.procesado, false);
    assert.equal(prev.body.lineas.length, 2);
    assert.deepEqual(prev.body.sin_contar.map(s => s.sku).sort(), ['MAT-HERR', 'MAT-UNO', 'PIN-TEST']);
    // la vista previa no guarda nada
    assert.equal(await db.contar('inventario.diferencia_inventario'), 0);

    await procesar(c.body.id);
    assert.equal(await db.contar('inventario.diferencia_inventario'), 2);
  });

  test('todo dentro de tolerancia → conforme (Exc 2); si algo la supera → con_diferencias', async () => {
    const ok = await conteo([{ sku: 'MAT-FIFO', cantidad: 30 }, { sku: 'MAT-CRIT', cantidad: 8 }]);
    const r = await procesar(ok.body.id);
    assert.equal(r.body.resultado, 'conforme');
    const e = await estadoConteo(ok.body.id);
    assert.equal(e.estado, 'procesado');
    assert.equal(e.resultado, 'conforme');
    assert.ok(e.fecha);
    assert.equal(String(e.usr), '1');

    const mal = await api('POST', '/api/conteos', {
      body: { bodega_id: 1, justificacion: 'recuento', lineas: [{ sku: 'MAT-CRIT', cantidad: 5 }] },
    });
    assert.equal((await procesar(mal.body.id)).body.resultado, 'con_diferencias');
  });

  test('procesar dos veces → 409 sin duplicar filas (Exc 3); el GET devuelve lo guardado', async () => {
    const c = await conteo([{ sku: 'MAT-FIFO', cantidad: 29 }]);
    assert.equal((await procesar(c.body.id)).status, 201);
    const otra = await procesar(c.body.id);
    assert.equal(otra.status, 409);
    assert.equal(await db.contar('inventario.diferencia_inventario'), 1);

    const g = await api('GET', `/api/conteos/${c.body.id}/diferencias`);
    assert.equal(g.body.procesado, true);
    assert.equal(g.body.lineas[0].diferencia, -1);
  });

  test('procesar no mueve el stock', async () => {
    const antes = await db.stockDe('MAT-FIFO');
    const c = await conteo([{ sku: 'MAT-FIFO', cantidad: 10 }]);
    await procesar(c.body.id);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), antes);
    assert.equal(await db.contar('inventario.movimiento_inventario'), 0);
  });

  test('el rol JOP no ve ni procesa diferencias (403)', async () => {
    const c = await conteo([{ sku: 'MAT-FIFO', cantidad: 30 }]);
    assert.equal((await api('GET', `/api/conteos/${c.body.id}/diferencias`, { rol: 'jop' })).status, 403);
    assert.equal((await procesar(c.body.id, 'jop')).status, 403);
    assert.equal((await estadoConteo(c.body.id)).estado, 'confirmado');
  });
});

describe('Tolerancias editables por Gerencia (D10)', () => {
  test('cambiarlas afecta a los conteos que se procesan despues, no a los ya procesados', async () => {
    const antes = await conteo([{ sku: 'MAT-FIFO', cantidad: 31 }]);   // +3,33 %
    await procesar(antes.body.id);

    const put = await api('PUT', '/api/conteos/tolerancias', {
      body: { no_critico: { tolerancia_pct: 2, umbral_critico_pct: 10 } },
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.tolerancias.no_critico.tolerancia_pct, 2);
    assert.equal(put.body.tolerancias.critico.tolerancia_pct, 1);   // el otro tipo no cambia

    const despues = await api('POST', '/api/conteos', {
      body: { bodega_id: 1, justificacion: 'recuento', lineas: [{ sku: 'MAT-FIFO', cantidad: 31 }] },
    });
    await procesar(despues.body.id);

    const a = (await difs(antes.body.id))['MAT-FIFO'];
    const b = (await difs(despues.body.id))['MAT-FIFO'];
    assert.equal(a.supera, false);
    assert.equal(a.tol, 5);
    assert.equal(b.supera, true);
    assert.equal(b.tol, 2);
  });

  test('valida los valores: umbral mayor que la tolerancia, sin negativos', async () => {
    for (const body of [
      { critico: { tolerancia_pct: 5, umbral_critico_pct: 5 } },
      { critico: { tolerancia_pct: -1, umbral_critico_pct: 5 } },
      { critico: { tolerancia_pct: 'abc', umbral_critico_pct: 5 } },
      { critico: { tolerancia_pct: 1, umbral_critico_pct: 2000 } },
      {},
    ]) {
      const r = await api('PUT', '/api/conteos/tolerancias', { body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    const g = await api('GET', '/api/conteos/tolerancias');
    assert.equal(g.body.critico.tolerancia_pct, 1);
    assert.equal(g.body.critico.umbral_critico_pct, 5);
  });

  test('solo gerencia las ve y las cambia', async () => {
    assert.equal((await api('GET', '/api/conteos/tolerancias', { rol: 'jop' })).status, 403);
    const r = await api('PUT', '/api/conteos/tolerancias', {
      rol: 'jop', body: { critico: { tolerancia_pct: 3, umbral_critico_pct: 9 } },
    });
    assert.equal(r.status, 403);
  });

  test('sin filas en la tabla (instalacion nueva) se usan los valores iniciales', async () => {
    await db.query('DELETE FROM inventario.tolerancia_conteo');
    const g = await api('GET', '/api/conteos/tolerancias');
    assert.equal(g.status, 200);
    assert.equal(g.body.critico.configurado, false);
    assert.equal(g.body.critico.tolerancia_pct, 1);
    assert.equal(g.body.no_critico.umbral_critico_pct, 20);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   CU-57: alertas por diferencia de inventario
   Tipos de la semilla: 7 = 'diferencia inventario' (alta), 8 = '... critica' (urgente)
   ══════════════════════════════════════════════════════════════════════════ */

async function alertasDiferencia() {
  const { rows } = await db.query(
    `SELECT alerta_inventario_id_alerta AS id, material_sku AS sku, bodega_id_bodega::int AS bodega,
            alerta_inventario_tipo_alerta_id_tipo_alerta::int AS tipo, alerta_inventario_estado AS estado,
            conteo_ciclico_id_conteo::int AS conteo, alerta_inventario_diferencia::float AS dif,
            alerta_inventario_diferencia_pct::float AS pct, usuario_id_usuario::int AS usr,
            historial_alerta_id_historial AS hist
     FROM inventario.alerta_inventario WHERE conteo_ciclico_id_conteo IS NOT NULL ORDER BY material_sku`
  );
  return rows;
}

/** Conteo confirmado y procesado; devuelve su id. */
async function conteoProcesado(lineas, extra = {}) {
  const c = await api('POST', '/api/conteos', { body: { bodega_id: 1, lineas, ...extra } });
  assert.equal(c.status, 201);
  assert.equal((await procesar(c.body.id)).status, 201);
  return Number(c.body.id);   // BIGINT llega como texto en la API
}

const generarAlertas = (id, rol) => api('POST', `/api/conteos/${id}/alertas`, { rol });

describe('Alertas por diferencia de inventario (CU-57)', () => {
  test('solo las diferencias fuera de tolerancia generan alerta; severidad segun el umbral guardado', async () => {
    // MAT-FIFO no critico (5 % / 20 %): 28 de 30 = -6,67 % → alta
    // MAT-CRIT critico (1 % / 5 %): 7 de 8 = -12,5 % → critica
    // MAT-HERR: sin diferencia → sin alerta
    const id = await conteoProcesado([
      { sku: 'MAT-FIFO', cantidad: 28 }, { sku: 'MAT-CRIT', cantidad: 7 }, { sku: 'MAT-HERR', cantidad: 3 },
    ]);
    const r = await generarAlertas(id, 'jop');
    assert.equal(r.status, 201);
    assert.equal(r.body.creadas, 2);
    assert.equal(r.body.criticas, 1);

    const a = await alertasDiferencia();
    assert.equal(a.length, 2);
    const fifo = a.find(x => x.sku === 'MAT-FIFO');
    const crit = a.find(x => x.sku === 'MAT-CRIT');
    assert.equal(fifo.tipo, 7);
    assert.equal(fifo.pct, -6.67);
    assert.equal(fifo.dif, -2);
    assert.equal(fifo.bodega, 1);
    assert.equal(fifo.conteo, id);
    assert.equal(fifo.usr, 2);           // el JOP que las genero
    assert.ok(fifo.hist);                // con su historial, como las de stock
    assert.equal(crit.tipo, 8);
    assert.equal(fifo.estado, 'activa');
  });

  test('un producto sin teorico (no esperado) genera alerta critica', async () => {
    await api('POST', '/api/materiales', { body: { sku: 'CONT-NUEVO', nombre: 'Fuera de la bodega', unidad_medida_id: 1 } });
    const id = await conteoProcesado([{ sku: 'MAT-FIFO', cantidad: 30 }, { sku: 'CONT-NUEVO', cantidad: 2 }]);
    await generarAlertas(id);
    const a = await alertasDiferencia();
    assert.equal(a.length, 1);
    assert.equal(a[0].sku, 'CONT-NUEVO');
    assert.equal(a[0].tipo, 8);
    assert.equal(a[0].pct, null);
  });

  test('un conteo conforme no genera nada (Exc 1)', async () => {
    const id = await conteoProcesado([{ sku: 'MAT-FIFO', cantidad: 30 }]);
    const r = await generarAlertas(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.creadas, 0);
    assert.equal((await alertasDiferencia()).length, 0);
  });

  test('un recuento actualiza la alerta activa del mismo producto y bodega, sin duplicarla (Exc 2)', async () => {
    const primero = await conteoProcesado([{ sku: 'MAT-FIFO', cantidad: 28 }]);    // -6,67 % → alta
    await generarAlertas(primero);
    const [antes] = await alertasDiferencia();

    const segundo = await conteoProcesado([{ sku: 'MAT-FIFO', cantidad: 20 }], { justificacion: 'recuento' }); // -33 % → critica
    const r = await generarAlertas(segundo);
    assert.equal(r.body.actualizadas, 1);
    assert.equal(r.body.creadas, 0);

    const a = await alertasDiferencia();
    assert.equal(a.length, 1);
    assert.equal(a[0].id, antes.id);
    assert.equal(a[0].conteo, segundo);
    assert.equal(a[0].dif, -10);
    assert.equal(a[0].tipo, 8);   // la severidad sube con la nueva diferencia
  });

  test('una alerta ya resuelta no se actualiza: el nuevo conteo crea otra', async () => {
    const primero = await conteoProcesado([{ sku: 'MAT-FIFO', cantidad: 28 }]);
    await generarAlertas(primero);
    const [vieja] = await alertasDiferencia();
    await api('PUT', `/api/alertas/${vieja.id}/resolver`);

    const segundo = await conteoProcesado([{ sku: 'MAT-FIFO', cantidad: 27 }], { justificacion: 'recuento' });
    assert.equal((await generarAlertas(segundo)).body.creadas, 1);
    assert.equal((await alertasDiferencia()).length, 2);
  });

  test('las criticas notifican a Gerencia con UN aviso por conteo (Exc 3)', async () => {
    const id = await conteoProcesado([{ sku: 'MAT-CRIT', cantidad: 4 }, { sku: 'MAT-FIFO', cantidad: 10 }]); // ambas criticas
    await generarAlertas(id);
    const { rows } = await db.query(
      `SELECT usuario_id_usuario::int AS usr, notificacion_mensaje AS msg
       FROM inventario.notificacion WHERE notificacion_tipo_notificacion = 'diferencia_inventario'`
    );
    assert.equal(rows.length, 1);          // un solo gerente en la semilla, un solo aviso
    assert.equal(rows[0].usr, 1);
    assert.match(rows[0].msg, /2 diferencia/);
  });

  test('sin criticas no se notifica', async () => {
    const id = await conteoProcesado([{ sku: 'MAT-FIFO', cantidad: 28 }]);
    await generarAlertas(id);
    assert.equal(await db.contar('inventario.notificacion', `notificacion_tipo_notificacion = 'diferencia_inventario'`), 0);
  });

  test('generar dos veces → 409; conteo sin procesar → 400; tecnico → 403', async () => {
    const id = await conteoProcesado([{ sku: 'MAT-FIFO', cantidad: 28 }]);
    assert.equal((await generarAlertas(id)).status, 201);
    assert.equal((await generarAlertas(id)).status, 409);
    assert.equal((await alertasDiferencia()).length, 1);

    const sinProcesar = await api('POST', '/api/conteos', {
      body: { bodega_id: 1, justificacion: 'otro', lineas: [{ sku: 'MAT-FIFO', cantidad: 1 }] },
    });
    assert.equal((await generarAlertas(sinProcesar.body.id)).status, 400);

    const base = await levantar();
    const token = jwt.sign({ id: 2, username: 'tec', nombre: 'Tec', rol: 'tecnico' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const r = await fetch(`${base}/api/conteos/${id}/alertas`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 403);
  });

  test('el detalle del conteo informa si ya se generaron sus alertas', async () => {
    const id = await conteoProcesado([{ sku: 'MAT-FIFO', cantidad: 28 }]);
    assert.equal((await api('GET', `/api/conteos/${id}`)).body.alertas_generadas, 0);
    await generarAlertas(id);
    assert.equal((await api('GET', `/api/conteos/${id}`)).body.alertas_generadas, 1);
  });
});

describe('Alertas de stock y de diferencia no se pisan (CU-57, regresion)', () => {
  test('el generador de alertas de stock no cierra una alerta por diferencia', async () => {
    const id = await conteoProcesado([{ sku: 'MAT-FIFO', cantidad: 28 }]);
    await generarAlertas(id);
    // MAT-FIFO tiene 30 con minimo 5: no necesita alerta de stock, y antes eso
    // resolvia TODA alerta activa del SKU
    const g = await api('POST', '/api/alertas/generar');
    assert.equal(g.status, 200);
    const [a] = await alertasDiferencia();
    assert.equal(a.estado, 'activa');
  });

  test('una alerta por diferencia activa no impide la alerta de stock bajo del mismo SKU', async () => {
    const id = await conteoProcesado([{ sku: 'MAT-FIFO', cantidad: 28 }]);
    await generarAlertas(id);
    await db.query(`UPDATE inventario.material SET material_stock_minimo = 100 WHERE material_sku = 'MAT-FIFO'`);

    await api('POST', '/api/alertas/generar');
    const stock = await db.contar('inventario.alerta_inventario',
      `material_sku = 'MAT-FIFO' AND conteo_ciclico_id_conteo IS NULL AND alerta_inventario_estado = 'activa'`);
    assert.equal(stock, 1);
    assert.equal((await alertasDiferencia())[0].estado, 'activa');
  });

  test('el listado de alertas trae bodega, diferencia y conteo', async () => {
    const id = await conteoProcesado([{ sku: 'MAT-FIFO', cantidad: 28 }]);
    await generarAlertas(id);
    const r = await api('GET', '/api/alertas');
    const a = r.body.find(x => x.conteo_id !== null && String(x.conteo_id) === String(id));
    assert.ok(a);
    assert.equal(a.bodega, 'Bodega Test');
    assert.equal(parseFloat(a.diferencia), -2);
    assert.equal(a.tipo, 'diferencia inventario');
    assert.equal(a.prioridad, 'alta');
  });
});

describe('Conteo ciego (CU-37, D9)', () => {
  test('ni la preparacion ni el detalle envian el stock teorico', async () => {
    const prep = await api('GET', '/api/conteos/bodega/1/preparar', { rol: 'jop' });
    assert.equal(prep.status, 200);
    assert.equal(prep.body.productos.length, 5);
    assert.ok(prep.body.productos.every(p => !('teorico' in p) && !('stock_teorico' in p) && !('cantidad_fisica' in p)));

    const r = await conteo([{ sku: 'MAT-FIFO', cantidad: 30 }]);
    const det = await api('GET', `/api/conteos/${r.body.id}`, { rol: 'jop' });
    assert.equal(det.status, 200);
    assert.ok(det.body.lineas.every(l => !('stock_teorico' in l) && !('teorico' in l)));
  });
});
