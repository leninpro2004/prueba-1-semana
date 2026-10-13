const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar, firmaGerencia } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * F-04: mantenedor de áreas, unidades y motivos (pantalla Catálogos, solo gerencia).
 *
 * Lo que protegen:
 *  - CU-120 nunca queda sin área activa de instalación.
 *  - Nada en uso se borra: una unidad con productos o un motivo con movimientos → 409 y la BD igual.
 *  - Los motivos del sistema (el código los busca por nombre) no se renombran; borrarlos exige la
 *    firma de catálogos (F-11), como cualquier motivo, y se pueden restaurar.
 *  - Un motivo nuevo se comporta según su categoría (merma → pide evidencia) y no se confunde con
 *    uno del sistema.
 *
 * Semilla: áreas 1 Corte (OT 1, 2 y 3; receta 1), 2 Pintura, 3 Instalación. Unidades 1 unidad
 * (en uso), 2 litro (sin uso), 3 kilogramo. Motivos 1-8, con 3 'merma' propio (categoría 2 perdida);
 * no hay traslado_bodega, perdida_herramienta ni baja_herramienta. Sin movimientos.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });


async function area(id) {
  const { rows } = await db.query(
    `SELECT area_trabajo_nombre_area AS nombre, area_trabajo_clasificacion AS clasificacion, area_trabajo_activo AS activo
     FROM inventario.area_trabajo WHERE area_trabajo_id_area = $1`, [id]);
  return rows[0];
}

async function idMotivo(nombre) {
  const { rows } = await db.query(
    `SELECT movimiento_inventario_motivo_movimiento_id_motivo_movimiento AS id FROM inventario.movimiento_inventario_motivo_movimiento
     WHERE movimiento_inventario_motivo_movimiento_nombre = $1`, [nombre]);
  return rows.length ? Number(rows[0].id) : null;
}

const salida = (motivo_id, extra = {}) => api('POST', '/api/movimientos/salida', {
  body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 1, tipo_movimiento_id: 2, motivo_id, ...extra },
});

describe('Áreas', () => {
  test('lista con OT (abiertas y totales) y líneas de receta; crear y renombrar', async () => {
    let r = await api('GET', '/api/catalogos/areas');
    assert.equal(r.status, 200);
    const corte = r.body.areas.find(a => Number(a.id) === 1);
    assert.deepEqual([corte.ots, corte.ots_abiertas, corte.lineas_receta], [3, 2, 2]);

    r = await api('POST', '/api/catalogos/areas', { body: { nombre: 'Soldadura', clasificacion: 'produccion' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await api('PUT', '/api/catalogos/areas/1', { body: { nombre: 'Carpintería' } });
    assert.equal(r.status, 200);
    assert.deepEqual(await area(1), { nombre: 'Carpintería', clasificacion: 'produccion', activo: true });
  });

  test('nombre repetido (sin distinguir mayúsculas) → 409; clasificación desconocida → 400', async () => {
    assert.equal((await api('POST', '/api/catalogos/areas', { body: { nombre: 'pintura', clasificacion: 'produccion' } })).status, 409);
    assert.equal((await api('PUT', '/api/catalogos/areas/1', { body: { nombre: 'PINTURA' } })).status, 409);
    assert.equal((await api('POST', '/api/catalogos/areas', { body: { nombre: 'Otra', clasificacion: 'bodega' } })).status, 400);
    assert.equal(await db.contar('inventario.area_trabajo'), 3);
  });

  test('la única área activa de instalación no se desactiva ni se reclasifica; con otra, sí', async () => {
    assert.equal((await api('PUT', '/api/catalogos/areas/3', { body: { activo: false } })).status, 409);
    assert.equal((await api('PUT', '/api/catalogos/areas/3', { body: { clasificacion: 'produccion' } })).status, 409);
    assert.deepEqual(await area(3), { nombre: 'Instalación', clasificacion: 'instalacion', activo: true });

    await api('POST', '/api/catalogos/areas', { body: { nombre: 'Instalación 2', clasificacion: 'instalacion' } });
    assert.equal((await api('PUT', '/api/catalogos/areas/3', { body: { activo: false } })).status, 200);
    assert.equal((await area(3)).activo, false);
  });

  test('desactivar un área en uso no la borra: sus OT la conservan y no se ofrece para una OT nueva', async () => {
    assert.equal((await api('PUT', '/api/catalogos/areas/1', { body: { activo: false } })).status, 200);
    assert.equal(await db.contar('inventario.area_trabajo'), 3);
    assert.equal(await db.contar('inventario.orden_trabajo', 'area_trabajo_id_area = 1'), 3);
    const r = await api('POST', '/api/ordenes-trabajo', { body: { area_id: 1, proyecto_id: 1 } });
    assert.equal(r.status, 400);
    assert.equal(r.body.campo, 'area_id');
  });
});

describe('Unidades', () => {
  test('crear, renombrar y borrar una sin uso', async () => {
    let r = await api('POST', '/api/catalogos/unidades', { body: { nombre: 'galón' } });
    assert.equal(r.status, 201);
    assert.equal((await api('PUT', '/api/catalogos/unidades/2', { body: { nombre: 'lt' } })).status, 200);
    assert.equal((await api('DELETE', '/api/catalogos/unidades/2')).status, 200);
    r = await api('GET', '/api/catalogos/unidades');
    assert.deepEqual(r.body.map(u => u.nombre).sort(), ['galón', 'kilogramo', 'unidad']);
  });

  test('borrar una unidad en uso → 409 y sigue; nombre repetido → 409', async () => {
    const r = await api('DELETE', '/api/catalogos/unidades/1');
    assert.equal(r.status, 409);
    assert.ok(r.body.usos > 0);
    assert.equal(await db.contar('inventario.material_unidad_medida'), 3);
    assert.equal((await api('POST', '/api/catalogos/unidades', { body: { nombre: 'Litro' } })).status, 409);
  });
});

describe('Motivos', () => {
  test('marca los del sistema y lista los que faltan', async () => {
    const r = await api('GET', '/api/catalogos/motivos');
    assert.equal(r.status, 200);
    assert.equal(r.body.motivos.find(m => m.nombre === 'consumo_produccion').clave, 'consumo_produccion');
    assert.equal(r.body.motivos.find(m => m.nombre === 'merma').clave, null);
    assert.deepEqual(r.body.faltantes.map(f => f.clave).sort(), ['baja_herramienta', 'perdida_herramienta', 'traslado_bodega']);
  });

  test('un motivo nuevo de categoría merma exige evidencia en la salida', async () => {
    const c = await api('POST', '/api/catalogos/motivos', { body: { nombre: 'Rotura en taller', clasificacion_id: 2 } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const stock = await db.stockDe('MAT-FIFO');
    assert.equal((await salida(c.body.id)).status, 400);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), stock);
    assert.equal((await salida(c.body.id, { evidencia_url: 'https://foto.cl/1' })).status, 201);
  });

  test('sin categoría o con un nombre que se confunde con uno del sistema → 400', async () => {
    assert.equal((await api('POST', '/api/catalogos/motivos', { body: { nombre: 'Otro' } })).status, 400);
    assert.equal((await api('POST', '/api/catalogos/motivos', { body: { nombre: 'Ajuste inventario por merma', clasificacion_id: 2 } })).status, 400);
    assert.equal((await api('PUT', '/api/catalogos/motivos/3', { body: { nombre: 'consumo-produccion' } })).status, 400);
    assert.equal(await db.contar('inventario.movimiento_inventario_motivo_movimiento'), 9);   // los de la semilla
  });

  test('un motivo propio se renombra; con movimientos no se borra, sin ellos sí', async () => {
    assert.equal((await api('PUT', '/api/catalogos/motivos/3', { body: { nombre: 'Merma de taller' } })).status, 200);
    assert.equal((await salida(3, { evidencia_url: 'https://foto.cl/1' })).status, 201);
    assert.equal((await api('DELETE', '/api/catalogos/motivos/3')).status, 409);
    const c = await api('POST', '/api/catalogos/motivos', { body: { nombre: 'Sin uso', clasificacion_id: 2 } });
    assert.equal((await api('DELETE', `/api/catalogos/motivos/${c.body.id}`)).status, 200);
  });

  test('un motivo del sistema no se edita, y sin la firma de catálogos no se borra', async () => {
    const id = await idMotivo('consumo_produccion');
    assert.equal((await api('PUT', `/api/catalogos/motivos/${id}`, { body: { nombre: 'Consumo' } })).status, 409);
    const borrar = (firma) => api('DELETE', `/api/catalogos/motivos/${id}`, { sinFirma: true, ...(firma && { firma }) });
    const r = await borrar();
    assert.equal(r.status, 428);
    assert.equal(r.body.requiere_firma, 'catalogos');
    assert.equal((await borrar(firmaGerencia('revertir_movimiento'))).status, 428, 'firma de otra acción');
    assert.equal(await idMotivo('consumo_produccion'), id);
  });

  test('con la firma se borra; restaurarlo vuelve a dejar funcionando el consumo de las OT', async () => {
    const id = await idMotivo('consumo_produccion');
    assert.equal((await api('DELETE', `/api/catalogos/motivos/${id}`, { firma: firmaGerencia('catalogos') })).status, 200);
    assert.equal(await idMotivo('consumo_produccion'), null);
    assert.ok((await api('GET', '/api/catalogos/motivos')).body.faltantes.some(f => f.clave === 'consumo_produccion'));

    const r = await api('POST', '/api/catalogos/motivos/restaurar', { body: { clave: 'consumo_produccion', clasificacion_id: 1 } });
    assert.equal(r.status, 201);
    assert.equal((await api('POST', '/api/catalogos/motivos/restaurar', { body: { clave: 'consumo_produccion' } })).status, 409);

    const g = await api('PUT', '/api/ordenes-trabajo/3/consumo', {
      body: { receta_id: 1, cantidad_puertas: 2, lineas: [{ sku: 'MAT-FIFO', estimado: 5, real: 5 }, { sku: 'MAT-CRIT', estimado: 8, real: 8 }] },
    });
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.equal(await db.contar('inventario.movimiento_inventario',
      'orden_trabajo_id_orden = 3 AND movimiento_inventario_motivo_movimiento_id_motivo_movimiento = $1', [r.body.id]), 2);
  });

  test('un motivo con movimientos o inexistente se rechaza antes de pedir la firma (no la gasta)', async () => {
    const id = await idMotivo('consumo_produccion');
    assert.equal((await salida(id)).status, 201);
    assert.equal((await api('DELETE', `/api/catalogos/motivos/${id}`, { sinFirma: true })).status, 409);
    assert.equal((await api('DELETE', '/api/catalogos/motivos/99999', { sinFirma: true })).status, 404);
    // Una firma enviada a un motivo que no se puede borrar no se consume
    const firma = firmaGerencia('catalogos');
    assert.equal((await api('DELETE', `/api/catalogos/motivos/${id}`, { firma })).status, 409);
    assert.equal((await api('POST', '/api/catalogos/unidades', { body: { nombre: 'galón' }, firma, sinFirma: true })).status, 201);
    assert.equal(await idMotivo('consumo_produccion'), id);
  });
});

describe('Permisos', () => {
  test('jop no lee ni escribe el mantenedor', async () => {
    assert.equal((await api('GET', '/api/catalogos/areas', { rol: 'jop' })).status, 403);
    assert.equal((await api('POST', '/api/catalogos/unidades', { rol: 'jop', body: { nombre: 'x' } })).status, 403);
    assert.equal((await api('DELETE', '/api/catalogos/motivos/3', { rol: 'jop', sinFirma: true })).status, 403);
  });
});
