const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * Recetas / plantillas por tipo de puerta (OPUS-19).
 *
 * Lo que protegen estos tests:
 *  - la cantidad que llega a la OT lleva la merma aplicada (cantidad * (1 + merma));
 *  - cargar dos veces NO duplica ni pisa lo que ya estaba (modo por defecto);
 *  - los materiales de la OT que no están en la receta nunca se tocan;
 *  - un lote inválido en la edición de la receta no guarda NADA (lección de OPUS-4).
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

/** Estimado que la OT tiene registrado para un material. */
async function estimado(otId, sku) {
  const { rows } = await db.query(
    `SELECT material_orden_trabajo_consumo_estimado AS est
     FROM inventario.material_orden_trabajo
     WHERE orden_trabajo_id_orden = $1 AND material_sku = $2`,
    [otId, sku]
  );
  return rows.length && rows[0].est != null ? parseFloat(rows[0].est) : null;
}

describe('Consultar recetas', () => {
  test('el listado trae los productos con su cantidad de materiales', async () => {
    const r = await api('GET', '/api/recetas');

    assert.equal(r.status, 200);
    const receta = r.body.find(x => x.codigo === 'PB-TEST');
    assert.equal(receta.total_materiales, '2');
  });

  test('el detalle aplica la merma sobre la cantidad base', async () => {
    const r = await api('GET', '/api/recetas/1');

    assert.equal(r.status, 200);
    const fifo = r.body.materiales.find(m => m.sku === 'MAT-FIFO');
    const crit = r.body.materiales.find(m => m.sku === 'MAT-CRIT');
    // 2 * (1 + 0.25) = 2.5 ; 4 * (1 + 0) = 4
    assert.equal(parseFloat(fifo.cantidad_con_merma), 2.5);
    assert.equal(parseFloat(crit.cantidad_con_merma), 4);
  });

  test('una receta inexistente da 404', async () => {
    const r = await api('GET', '/api/recetas/999');
    assert.equal(r.status, 404);
  });

  test('un id no numérico da 400', async () => {
    const r = await api('GET', '/api/recetas/abc');
    assert.equal(r.status, 400);
  });
});

describe('Resolver la receta de una OT', () => {
  test('sigue la cadena OT -> especificación -> producto', async () => {
    const r = await api('GET', '/api/recetas/por-orden/3');

    assert.equal(r.status, 200);
    assert.equal(r.body.producto.codigo, 'PB-TEST');
    assert.equal(r.body.motivo_sin_receta, null);
    assert.equal(r.body.materiales.length, 2);
  });

  test('una OT sin especificación devuelve 200 con el motivo, no un error', async () => {
    const r = await api('GET', '/api/recetas/por-orden/1');

    assert.equal(r.status, 200);
    assert.equal(r.body.producto, null);
    assert.match(r.body.motivo_sin_receta, /especificación/i);
  });

  test('una OT inexistente da 404', async () => {
    const r = await api('GET', '/api/recetas/por-orden/999');
    assert.equal(r.status, 404);
  });
});

describe('Cargar una receta en una OT', () => {
  test('carga los materiales con la merma ya aplicada', async () => {
    const r = await api('POST', '/api/recetas/1/cargar-en-ot/3');

    assert.equal(r.status, 200);
    assert.equal(r.body.agregados, 2);
    assert.equal(r.body.omitidos, 0);
    assert.equal(await estimado(3, 'MAT-FIFO'), 2.5);
    assert.equal(await estimado(3, 'MAT-CRIT'), 4);
  });

  test('cargar dos veces no duplica: la segunda vez queda todo omitido', async () => {
    await api('POST', '/api/recetas/1/cargar-en-ot/3');
    const r = await api('POST', '/api/recetas/1/cargar-en-ot/3');

    assert.equal(r.status, 200);
    assert.equal(r.body.agregados, 0);
    assert.equal(r.body.omitidos, 2);
    assert.equal(await estimado(3, 'MAT-FIFO'), 2.5);

    const { rows } = await db.query(
      `SELECT COUNT(*) AS n FROM inventario.material_orden_trabajo WHERE orden_trabajo_id_orden = 3`
    );
    assert.equal(rows[0].n, '2');
  });

  test('el modo por defecto NO pisa un estimado que ya existía', async () => {
    // La OT 1 ya trae MAT-FIFO estimado en 12 desde la semilla.
    const r = await api('POST', '/api/recetas/1/cargar-en-ot/1');

    assert.equal(r.status, 200);
    assert.equal(await estimado(1, 'MAT-FIFO'), 12);
    assert.equal(r.body.resultados.find(x => x.sku === 'MAT-FIFO').resultado, 'omitido');
  });

  test('modo=reemplazar sí sobrescribe el estimado existente', async () => {
    const r = await api('POST', '/api/recetas/1/cargar-en-ot/1?modo=reemplazar');

    assert.equal(r.status, 200);
    assert.equal(r.body.actualizados, 2);
    assert.equal(await estimado(1, 'MAT-FIFO'), 2.5);
  });

  test('los materiales de la OT que no están en la receta no se tocan', async () => {
    // MAT-UNO no forma parte de PB-TEST
    await db.query(
      `INSERT INTO inventario.material_orden_trabajo
         (material_sku, orden_trabajo_id_orden, material_orden_trabajo_consumo_estimado)
       VALUES ('MAT-UNO', 3, 9)`
    );

    await api('POST', '/api/recetas/1/cargar-en-ot/3?modo=reemplazar');

    assert.equal(await estimado(3, 'MAT-UNO'), 9);
  });

  test('una OT cerrada se rechaza y no escribe nada', async () => {
    const r = await api('POST', '/api/recetas/1/cargar-en-ot/2');

    assert.equal(r.status, 400);
    assert.equal(await estimado(2, 'MAT-FIFO'), null);
  });

  test('una receta sin materiales se rechaza', async () => {
    const r = await api('POST', '/api/recetas/2/cargar-en-ot/3');

    assert.equal(r.status, 400);
    assert.match(r.body.error, /no tiene materiales/i);
  });

  test('un modo inválido da 400', async () => {
    const r = await api('POST', '/api/recetas/1/cargar-en-ot/3?modo=zzz');
    assert.equal(r.status, 400);
  });

  test('una receta inexistente da 404 y no toca la OT', async () => {
    const r = await api('POST', '/api/recetas/999/cargar-en-ot/3');

    assert.equal(r.status, 404);
    const { rows } = await db.query(
      `SELECT COUNT(*) AS n FROM inventario.material_orden_trabajo WHERE orden_trabajo_id_orden = 3`
    );
    assert.equal(rows[0].n, '0');
  });
});

describe('Editar una receta', () => {
  test('reemplaza la lista de materiales', async () => {
    const r = await api('PUT', '/api/recetas/1', {
      body: { materiales: [{ sku: 'MAT-UNO', cantidad_base: 5, merma: 0.1, area_id: 1 }] },
    });

    assert.equal(r.status, 200);
    assert.equal(r.body.materiales.length, 1);
    assert.equal(parseFloat(r.body.materiales[0].cantidad_con_merma), 5.5);
  });

  test('sesión 15: un material inactivo que ya estaba se conserva si no se toca; modificarlo o agregarlo se rechaza', async () => {
    await db.query(`UPDATE inventario.material SET material_estado = 'inactivo' WHERE material_sku IN ('MAT-FIFO', 'MAT-UNO')`);
    const receta = (fifo, extra = []) => ({ materiales: [
      { sku: 'MAT-FIFO', cantidad_base: 2, merma: 0.25, area_id: 1, ...fifo },
      { sku: 'MAT-CRIT', cantidad_base: 7, merma: 0, area_id: 1 },     // el activo sí cambia
      ...extra,
    ] });

    const ok = await api('PUT', '/api/recetas/1', { body: receta({}) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.materiales.find(m => m.sku === 'MAT-CRIT').cantidad_base * 1, 7);

    for (const cambio of [{ cantidad_base: 3 }, { merma: 0.1 }, { area_id: 2 }]) {
      const r = await api('PUT', '/api/recetas/1', { body: receta(cambio) });
      assert.equal(r.status, 400, JSON.stringify(cambio));
      assert.match(r.body.errores.find(e => e.sku === 'MAT-FIFO').error, /inactivo/);
    }
    const nuevo = await api('PUT', '/api/recetas/1', { body: receta({}, [{ sku: 'MAT-UNO', cantidad_base: 1, merma: 0, area_id: 1 }]) });
    assert.equal(nuevo.status, 400);
    assert.match(nuevo.body.errores.find(e => e.sku === 'MAT-UNO').error, /no se puede agregar/);
  });

  test('un SKU inválido en el lote no guarda NADA', async () => {
    const r = await api('PUT', '/api/recetas/1', {
      body: {
        materiales: [
          { sku: 'MAT-UNO',   cantidad_base: 5, merma: 0, area_id: 1 },
          { sku: 'NO-EXISTE', cantidad_base: 1, merma: 0, area_id: 1 },
        ],
      },
    });

    assert.equal(r.status, 400);
    // La receta original sigue intacta: 2 materiales, ninguno MAT-UNO
    const { rows } = await db.query(
      `SELECT material_sku FROM inventario.material_producto_terminado
       WHERE producto_terminado_id_producto = 1 ORDER BY 1`
    );
    assert.deepEqual(rows.map(x => x.material_sku), ['MAT-CRIT', 'MAT-FIFO']);
  });

  test('una merma >= 1 se rechaza: se expresa como fracción', async () => {
    const r = await api('PUT', '/api/recetas/1', {
      body: { materiales: [{ sku: 'MAT-UNO', cantidad_base: 5, merma: 20, area_id: 1 }] },
    });

    assert.equal(r.status, 400);
    assert.match(r.body.error, /fracción/i);
  });

  test('un SKU repetido en el lote se rechaza', async () => {
    const r = await api('PUT', '/api/recetas/1', {
      body: {
        materiales: [
          { sku: 'MAT-UNO', cantidad_base: 5, merma: 0, area_id: 1 },
          { sku: 'MAT-UNO', cantidad_base: 3, merma: 0, area_id: 1 },
        ],
      },
    });

    assert.equal(r.status, 400);
  });

  test('CU-102: jop puede editar una receta dentro de las 24 h desde su creación', async () => {
    const r = await api('PUT', '/api/recetas/1', {
      rol: 'jop',
      body: { materiales: [{ sku: 'MAT-UNO', cantidad_base: 5, merma: 0, area_id: 1 }] },
    });

    assert.equal(r.status, 200);
  });
});

/* ══════════════════════════════════════════════════════════════════════
   CU-102 (D37): módulo de recetas. Crear, regla de edición de 24 h, duplicar
   como nueva versión, desactivar y área por insumo.
   Semilla: receta 1 (PB-TEST) = MAT-FIFO 2 (merma 0,25) + MAT-CRIT 4; receta 2
   vacía; OT 3 del área 1 (Corte) vinculada a la receta 1; área 2 = Pintura.
   ══════════════════════════════════════════════════════════════════════ */

/** Antigüedad de la receta en horas (la semilla la crea "ahora"). */
const envejecer = (id, horas) => db.query(
  `UPDATE inventario.producto_terminado
   SET producto_terminado_fecha_creacion = now() - make_interval(hours => $2)
   WHERE producto_terminado_id_producto = $1`, [id, horas]);

const insumosDe = async (id) => (await db.query(
  `SELECT material_sku AS sku, material_producto_terminado_cantidad_estimada::float AS cantidad,
          area_trabajo_id_area::int AS area
   FROM inventario.material_producto_terminado WHERE producto_terminado_id_producto = $1 ORDER BY 1`, [id])).rows;

const cuantasRecetas = () => db.contar('inventario.producto_terminado');

describe('Crear receta (CU-102)', () => {
  test('crea la receta con sus insumos y su área; la unidad sale del material', async () => {
    const r = await api('POST', '/api/recetas', {
      rol: 'jop',
      body: { nombre: 'Puerta Especial ABC', codigo: 'PB-ABC', tipo: 'especial',
              materiales: [{ sku: 'MAT-UNO', cantidad_base: 2, merma: 0.1, area_id: 2 },
                           { sku: 'PIN-TEST', cantidad_base: 1.5, area_id: 2 }] },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));

    const d = (await api('GET', `/api/recetas/${r.body.id}`)).body;
    assert.equal(d.producto.nombre, 'Puerta Especial ABC');
    assert.equal(d.producto.en_plazo, true);
    const uno = d.materiales.find(m => m.sku === 'MAT-UNO');
    assert.equal(uno.area, 'Pintura');
    assert.equal(uno.unidad, 'unidad');
    assert.equal(parseFloat(uno.cantidad_con_merma), 2.2);
    assert.equal(Number(d.materiales.find(m => m.sku === 'PIN-TEST').area_id), 2);
  });

  test('Exc 1: SKU inexistente, inactivo o herramienta → 400 con cada fila, y no se crea nada', async () => {
    await db.query(`UPDATE inventario.material SET material_estado = 'inactivo' WHERE material_sku = 'MAT-UNO'`);
    const antes = await cuantasRecetas();
    const r = await api('POST', '/api/recetas', {
      body: { nombre: 'Con errores', codigo: 'PB-ERR', materiales: [
        { sku: 'NO-EXISTE', cantidad_base: 1, area_id: 1 }, { sku: 'MAT-UNO', cantidad_base: 1, area_id: 1 },
        { sku: 'MAT-HERR', cantidad_base: 1, area_id: 1 }, { sku: 'MAT-FIFO', cantidad_base: 1, area_id: 1 }] },
    });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.errores.map(e => [e.fila, e.campo]), [[1, 'sku'], [2, 'sku'], [3, 'sku']]);
    assert.equal(await cuantasRecetas(), antes);
  });

  test('Exc 3: cantidad cero o negativa → 400 señalando el campo, y no se crea nada', async () => {
    const antes = await cuantasRecetas();
    const r = await api('POST', '/api/recetas', {
      body: { nombre: 'Cantidades malas', codigo: 'PB-CANT', materiales: [
        { sku: 'MAT-FIFO', cantidad_base: 0 }, { sku: 'MAT-CRIT', cantidad_base: -2 }] },
    });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.errores.map(e => e.campo), ['cantidad_base', 'cantidad_base']);
    assert.equal(await cuantasRecetas(), antes);
  });

  test('sin insumos, sin nombre, sin código, código repetido o área que no es de producción se rechazan', async () => {
    const base = { nombre: 'X', codigo: 'PB-X', materiales: [{ sku: 'MAT-FIFO', cantidad_base: 1, area_id: 1 }] };
    assert.equal((await api('POST', '/api/recetas', { body: { ...base, materiales: [] } })).status, 400);
    assert.equal((await api('POST', '/api/recetas', { body: { ...base, nombre: '  ' } })).status, 400);
    const sinCodigo = await api('POST', '/api/recetas', { body: { ...base, codigo: '  ' } });
    assert.equal(sinCodigo.status, 400);
    assert.equal(sinCodigo.body.campo, 'codigo');
    assert.equal((await api('POST', '/api/recetas', { body: { ...base, codigo: 'pb-test' } })).status, 409);
    const area = await api('POST', '/api/recetas', { body: { ...base, materiales: [{ sku: 'MAT-FIFO', cantidad_base: 1, area_id: 999 }] } });
    assert.equal(area.status, 400);
    assert.equal(area.body.errores[0].campo, 'area_id');
  });
});

describe('Editar receta: 24 h libre, después solo gerencia con motivo (CU-102)', () => {
  const nueva = { materiales: [{ sku: 'MAT-UNO', cantidad_base: 3, area_id: 1 }] };

  test('jop, pasadas las 24 h → 403 y la receta no cambia', async () => {
    await envejecer(1, 25);
    const r = await api('PUT', '/api/recetas/1', { rol: 'jop', body: nueva });
    assert.equal(r.status, 403);
    assert.equal(r.body.codigo, 'FUERA_DE_PLAZO');
    assert.deepEqual((await insumosDe(1)).map(i => i.sku), ['MAT-CRIT', 'MAT-FIFO']);
  });

  test('gerencia, pasadas las 24 h: sin motivo → 400; con motivo guarda sin reiniciar el plazo', async () => {
    await envejecer(1, 30);
    const sin = await api('PUT', '/api/recetas/1', { body: nueva });
    assert.equal(sin.status, 400);
    assert.equal(sin.body.codigo, 'MOTIVO_REQUERIDO');

    const con = await api('PUT', '/api/recetas/1', { body: { ...nueva, motivo: 'Corrige cantidad digitada mal' } });
    assert.equal(con.status, 200);
    assert.deepEqual((await insumosDe(1)).map(i => i.sku), ['MAT-UNO']);
    assert.equal(con.body.producto.en_plazo, false, 'editar no reinicia el plazo de 24 h');
  });

  test('una receta inactiva no se edita', async () => {
    await api('PUT', '/api/recetas/1/estado', { body: { activo: false } });
    assert.equal((await api('PUT', '/api/recetas/1', { body: nueva })).status, 400);
  });
});

describe('Duplicar como nueva versión (CU-102 Exc 2)', () => {
  test('sin reemplazo: copia insumos y áreas; la original sigue activa; la copia tiene plazo nuevo', async () => {
    await db.query(`UPDATE inventario.material_producto_terminado SET area_trabajo_id_area = 2
                    WHERE producto_terminado_id_producto = 1 AND material_sku = 'MAT-CRIT'`);
    await envejecer(1, 48);
    const r = await api('POST', '/api/recetas/1/duplicar', { rol: 'jop', body: { nombre: 'Puerta de prueba v2', codigo: 'PB-TEST-2' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));

    assert.deepEqual(await insumosDe(r.body.id), await insumosDe(1));
    const orig = (await api('GET', '/api/recetas/1')).body.producto;
    const copia = (await api('GET', `/api/recetas/${r.body.id}`)).body.producto;
    assert.equal(orig.activo, true);
    assert.equal(copia.en_plazo, true);
  });

  test('con reemplazo: la original queda inactiva y apunta a la nueva', async () => {
    const r = await api('POST', '/api/recetas/1/duplicar', { body: { nombre: 'Puerta de prueba v2', codigo: 'PB-TEST-V2', reemplaza: true } });
    assert.equal(r.status, 201);

    const orig = (await api('GET', '/api/recetas/1')).body;
    assert.equal(orig.producto.activo, false);
    assert.equal(orig.producto.reemplazada_por_nombre, 'Puerta de prueba v2');
    assert.deepEqual((await api('GET', `/api/recetas/${r.body.id}`)).body.reemplaza_a.map(x => x.id), ['1']);
    const activas = (await api('GET', '/api/recetas')).body.map(x => x.id);
    assert.ok(!activas.includes('1'));
  });
});

describe('Código obligatorio y sugerencia al duplicar (CU-102, D37)', () => {
  test('el código se guarda en mayúsculas y duplicar sin código se rechaza', async () => {
    const r = await api('POST', '/api/recetas', {
      body: { nombre: 'Minúsculas', codigo: '  pb-min-1 ', materiales: [{ sku: 'MAT-FIFO', cantidad_base: 1, area_id: 1 }] },
    });
    assert.equal(r.status, 201);
    assert.equal((await api('GET', `/api/recetas/${r.body.id}`)).body.producto.codigo, 'PB-MIN-1');

    const d = await api('POST', '/api/recetas/1/duplicar', { body: { nombre: 'Sin código' } });
    assert.equal(d.status, 400);
    assert.equal(d.body.campo, 'codigo');
  });

  test('sugiere <código>-V2 y "<nombre> v2"; sigue la numeración y salta los códigos ocupados', async () => {
    const s1 = (await api('GET', '/api/recetas/1/sugerencia-duplicado', { rol: 'jop' })).body;
    assert.deepEqual(s1, { codigo: 'PB-TEST-V2', nombre: 'Puerta de prueba v2' });

    const v2 = await api('POST', '/api/recetas/1/duplicar', { body: s1 });
    assert.equal(v2.status, 201);
    // Desde la original, V2 ya está ocupado → V3; desde la V2, la siguiente también es V3
    assert.equal((await api('GET', '/api/recetas/1/sugerencia-duplicado')).body.codigo, 'PB-TEST-V3');
    const s3 = (await api('GET', `/api/recetas/${v2.body.id}/sugerencia-duplicado`)).body;
    assert.deepEqual(s3, { codigo: 'PB-TEST-V3', nombre: 'Puerta de prueba v3' });
  });
});

describe('Desactivar y reactivar (CU-102)', () => {
  test('una receta inactiva no se lista, no se carga en una OT y la OT lo explica', async () => {
    const r = await api('PUT', '/api/recetas/1/estado', { rol: 'jop', body: { activo: false } });
    assert.equal(r.status, 200);

    assert.ok(!(await api('GET', '/api/recetas')).body.some(x => x.id === '1'));
    assert.ok((await api('GET', '/api/recetas?incluir_inactivos=true')).body.some(x => x.id === '1'));
    assert.equal((await api('POST', '/api/recetas/1/cargar-en-ot/3')).status, 400);
    assert.match((await api('GET', '/api/recetas/por-orden/3')).body.motivo_sin_receta, /inactiva/);
    assert.equal(await estimado(3, 'MAT-FIFO'), null);
  });

  test('reactivar la vuelve a ofrecer y quita el "reemplazada por"', async () => {
    await api('POST', '/api/recetas/1/duplicar', { body: { nombre: 'v2', codigo: 'PB-TEST-V2', reemplaza: true } });
    const r = await api('PUT', '/api/recetas/1/estado', { body: { activo: true } });
    assert.equal(r.status, 200);
    const p = (await api('GET', '/api/recetas/1')).body.producto;
    assert.equal(p.activo, true);
    assert.equal(p.reemplazada_por_id, null);
  });
});

describe('Área por insumo al cargar en la OT (CU-102, R1)', () => {
  test('la OT carga solo los insumos de su área', async () => {
    // MAT-CRIT pasa a Pintura (2); MAT-FIFO sigue en Corte (1), el área de la OT 3.
    await db.query(`UPDATE inventario.material_producto_terminado SET area_trabajo_id_area = 2
                    WHERE producto_terminado_id_producto = 1 AND material_sku = 'MAT-CRIT'`);

    const porOrden = (await api('GET', '/api/recetas/por-orden/3')).body;
    assert.deepEqual(porOrden.materiales.map(m => m.sku), ['MAT-FIFO']);

    const r = await api('POST', '/api/recetas/1/cargar-en-ot/3');
    assert.equal(r.status, 200);
    assert.equal(await estimado(3, 'MAT-FIFO'), 2.5);
    assert.equal(await estimado(3, 'MAT-CRIT'), null);

    // Elegida a mano para Pintura: solo la de Pintura
    const pintura = (await api('GET', '/api/recetas/1?area_id=2')).body;
    assert.deepEqual(pintura.materiales.map(m => m.sku), ['MAT-CRIT']);
  });

  test('R1: un insumo sin área se rechaza (se descontaría en todas las OT de la puerta)', async () => {
    const r = await api('POST', '/api/recetas', {
      body: { nombre: 'Sin área', codigo: 'PB-SIN-AREA', materiales: [{ sku: 'MAT-FIFO', cantidad_base: 1 }] },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.errores[0].campo, 'area_id');
  });
});

describe('Permisos (CU-102)', () => {
  test('solo gerencia y jop crean, duplican y cambian estado', async () => {
    const jwt = require('jsonwebtoken');
    const { levantar } = require('./helpers/api');
    const url = await levantar();
    const tecnico = jwt.sign({ id: 2, username: 'jop.test', rol: 'tecnico' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    // Solo POST y PUT: siempre llevan cuerpo
    const pedir = (metodo, ruta, body) => {
      const opciones = { method: metodo, headers: { Authorization: `Bearer ${tecnico}`, 'Content-Type': 'application/json' } };
      opciones.body = JSON.stringify(body);
      return fetch(url + ruta, opciones);
    };
    assert.equal((await pedir('POST', '/api/recetas', { nombre: 'x', materiales: [{ sku: 'MAT-FIFO', cantidad_base: 1 }] })).status, 403);
    assert.equal((await pedir('POST', '/api/recetas/1/duplicar', {})).status, 403);
    assert.equal((await pedir('PUT', '/api/recetas/1/estado', { activo: false })).status, 403);
    assert.equal((await pedir('PUT', '/api/recetas/1', { materiales: [] })).status, 403);
  });
});
