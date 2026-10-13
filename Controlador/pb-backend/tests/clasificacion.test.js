const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * B-14: mantenedor de la clasificación de materiales.
 *
 * Lo que protegen:
 *  - Nada que un material use se borra: 409 y la BD queda igual.
 *  - Fusionar mueve TODOS los materiales al destino y borra el origen, en una transacción.
 *  - Una rama sin uso (categoría → subcategorías → niveles) se borra completa.
 *  - Nombres únicos entre hermanos, sin distinguir mayúsculas.
 *  - Solo gerencia escribe (y lee el mantenedor).
 *
 * Semilla: categoría general 1 (MAT-FIFO, MAT-UNO, MAT-HERR, PIN-TEST) y 2 (MAT-CRIT);
 * funcional 1 (MAT-HERR) y 2 (el resto). El árbol de clasificación parte vacío.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const BASE = '/api/materiales/catalogos/clasificacion';

async function crear(tipo, body) {
  const r = await api('POST', `${BASE}/${tipo}`, { body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return Number(r.body.id);   // BIGINT: pg lo entrega como texto
}

/** Categoría → subcategoría (con su nivel inicial). Devuelve los tres ids. */
async function rama(nombreCat = 'Herrajes', nombreSub = 'Bisagras') {
  const cat = await crear('categoria', { nombre: nombreCat });
  const sub = await crear('subcategoria', { nombre: nombreSub, padre_id: cat });
  const { rows } = await db.query(
    `SELECT material_clasificacion_nivel_especifico_id AS id FROM inventario.material_clasificacion_nivel_especifico
     WHERE material_clasificacion_subcategoria_id = $1`, [sub]);
  return { cat, sub, nivel: Number(rows[0].id) };
}

async function asignarNivel(sku, nivel) {
  await db.query(`UPDATE inventario.material SET material_clasificacion_nivel_especifico_id = $1 WHERE material_sku = $2`, [nivel, sku]);
}

async function columnaDe(sku, col) {
  const { rows } = await db.query(`SELECT ${col} AS v FROM inventario.material WHERE material_sku = $1`, [sku]);
  return rows[0].v == null ? null : Number(rows[0].v);
}

const NIVEL = 'material_clasificacion_nivel_especifico_id';
const GENERAL = 'material_categoria_general_id_categoria_general';
const FUNCIONAL = 'material_categoria_funcional_id_categoria_funcional';

describe('Crear y renombrar', () => {
  test('una subcategoría nueva trae su nivel inicial y aparece en el catálogo de productos', async () => {
    const { cat, sub, nivel } = await rama();
    const r = await api('GET', '/api/materiales/catalogos/categorias');
    assert.equal(r.status, 200);
    assert.ok(r.body.clasificacion.categorias.some(c => Number(c.id) === cat));
    assert.ok(r.body.clasificacion.subcategorias.some(s => Number(s.id) === sub && Number(s.categoria_id) === cat));
    assert.ok(r.body.clasificacion.niveles.some(n => Number(n.id) === nivel && Number(n.subcategoria_id) === sub));
  });

  test('nombre repetido entre hermanos → 409; en otra rama sí se puede', async () => {
    const { cat } = await rama('Herrajes', 'Bisagras');
    const dup = await api('POST', `${BASE}/subcategoria`, { body: { nombre: '  bisagras ', padre_id: cat } });
    assert.equal(dup.status, 409);
    const otra = await crear('categoria', { nombre: 'Pintura' });
    await crear('subcategoria', { nombre: 'Bisagras', padre_id: otra });
    assert.equal((await api('POST', `${BASE}/general`, { body: { nombre: 'materiaprima' } })).status, 409);
  });

  test('validaciones: nombre vacío, tipo desconocido, padre inexistente', async () => {
    assert.equal((await api('POST', `${BASE}/general`, { body: { nombre: '   ' } })).status, 400);
    assert.equal((await api('POST', `${BASE}/otro`, { body: { nombre: 'X' } })).status, 404);
    assert.equal((await api('POST', `${BASE}/nivel`, { body: { nombre: 'X', padre_id: 999 } })).status, 404);
    assert.equal((await api('POST', `${BASE}/nivel`, { body: { nombre: 'X' } })).status, 400);
    assert.equal(await db.contar('inventario.material_clasificacion_nivel_especifico'), 0);
  });

  test('renombrar conserva los materiales y cambia es_color_custom de la subcategoría', async () => {
    const { sub, nivel } = await rama();
    await asignarNivel('MAT-FIFO', nivel);
    let r = await api('PUT', `${BASE}/nivel/${nivel}`, { body: { nombre: 'Acero 3"' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api('PUT', `${BASE}/subcategoria/${sub}`, { body: { es_color_custom: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await columnaDe('MAT-FIFO', NIVEL), nivel);
    const { rows } = await db.query(
      `SELECT material_clasificacion_subcategoria_es_color_custom AS c, material_clasificacion_subcategoria_nombre_subcategoria AS n
       FROM inventario.material_clasificacion_subcategoria WHERE material_clasificacion_subcategoria_id = $1`, [sub]);
    assert.deepEqual(rows[0], { c: true, n: 'Bisagras' });   // el nombre omitido se conserva
    r = await api('PUT', `${BASE}/general/1`, { body: { nombre: 'MaterialCrítico' } });
    assert.equal(r.status, 409);
  });
});

describe('Borrar y fusionar', () => {
  test('borrar algo en uso → 409 y no cambia nada', async () => {
    const { cat, sub, nivel } = await rama();
    await asignarNivel('MAT-FIFO', nivel);
    const antes = {
      cat: await db.contar('inventario.material_clasificacion_categoria'),
      sub: await db.contar('inventario.material_clasificacion_subcategoria'),
      niv: await db.contar('inventario.material_clasificacion_nivel_especifico'),
      gen: await db.contar('inventario.material_categoria_general'),
      fun: await db.contar('inventario.material_categoria_funcional'),
    };
    for (const ruta of [`categoria/${cat}`, `subcategoria/${sub}`, `nivel/${nivel}`, 'general/1', 'funcional/2']) {
      const r = await api('DELETE', `${BASE}/${ruta}`);
      assert.equal(r.status, 409, `${ruta} → ${r.status}`);
    }
    assert.deepEqual({
      cat: await db.contar('inventario.material_clasificacion_categoria'),
      sub: await db.contar('inventario.material_clasificacion_subcategoria'),
      niv: await db.contar('inventario.material_clasificacion_nivel_especifico'),
      gen: await db.contar('inventario.material_categoria_general'),
      fun: await db.contar('inventario.material_categoria_funcional'),
    }, antes);
    assert.equal(await columnaDe('MAT-FIFO', NIVEL), nivel);
  });

  test('una categoría sin uso se borra con sus subcategorías y niveles', async () => {
    const { cat, sub } = await rama();
    await crear('nivel', { nombre: 'Acero', padre_id: sub });
    const otra = await rama('Pintura', 'Esmalte');
    const r = await api('DELETE', `${BASE}/categoria/${cat}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await db.contar('inventario.material_clasificacion_categoria'), 1);
    assert.equal(await db.contar('inventario.material_clasificacion_subcategoria'), 1);
    assert.equal(await db.contar('inventario.material_clasificacion_nivel_especifico'), 1);
    assert.equal(await db.contar('inventario.material_clasificacion_subcategoria',
      'material_clasificacion_subcategoria_id = $1', [otra.sub]), 1);
  });

  test('fusionar una categoría general mueve todos sus materiales y la borra', async () => {
    const r = await api('DELETE', `${BASE}/general/1?mover_a=2`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.movidos, 4);
    for (const sku of ['MAT-FIFO', 'MAT-UNO', 'MAT-HERR', 'PIN-TEST', 'MAT-CRIT']) {
      assert.equal(await columnaDe(sku, GENERAL), 2, sku);
    }
    assert.equal(await db.contar('inventario.material_categoria_general'), 1);
  });

  test('fusionar la categoría funcional y un nivel', async () => {
    let r = await api('DELETE', `${BASE}/funcional/1?mover_a=2`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await columnaDe('MAT-HERR', FUNCIONAL), 2);

    const a = await rama('Herrajes', 'Bisagras');
    const b = await rama('Ferretería', 'Bisagras');
    await asignarNivel('MAT-FIFO', a.nivel);
    await asignarNivel('MAT-UNO', a.nivel);
    r = await api('DELETE', `${BASE}/nivel/${a.nivel}?mover_a=${b.nivel}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await columnaDe('MAT-FIFO', NIVEL), b.nivel);
    assert.equal(await columnaDe('MAT-UNO', NIVEL), b.nivel);
    // la subcategoría que quedó sin uso ya se puede borrar
    assert.equal((await api('DELETE', `${BASE}/subcategoria/${a.sub}`)).status, 200);
  });

  test('fusionar: destino inexistente o igual → error y no se mueve nada; categoría y subcategoría no se fusionan', async () => {
    assert.equal((await api('DELETE', `${BASE}/general/1?mover_a=999`)).status, 404);
    assert.equal((await api('DELETE', `${BASE}/general/1?mover_a=1`)).status, 400);
    assert.equal(await columnaDe('MAT-FIFO', GENERAL), 1);
    const a = await rama('Herrajes', 'Bisagras');
    const b = await rama('Pintura', 'Esmalte');
    assert.equal((await api('DELETE', `${BASE}/categoria/${a.cat}?mover_a=${b.cat}`)).status, 400);
    assert.equal(await db.contar('inventario.material_categoria_general'), 2);
  });

  test('la auditoría registra la fusión', async () => {
    await api('DELETE', `${BASE}/general/1?mover_a=2`);
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM finanzas.evento_auditoria WHERE accion_realizada = 'fusionar_clasificacion'`);
    assert.equal(rows[0].n, 1);
  });
});

describe('Uso y permisos', () => {
  test('el listado informa cuántos productos usa cada elemento', async () => {
    const { cat, sub, nivel } = await rama();
    await asignarNivel('MAT-FIFO', nivel);
    await asignarNivel('MAT-CRIT', nivel);
    const r = await api('GET', BASE);
    assert.equal(r.status, 200);
    assert.equal(r.body.generales.find(g => Number(g.id) === 1).usos, 4);
    assert.equal(r.body.funcionales.find(f => Number(f.id) === 2).usos, 4);
    assert.equal(r.body.clasificacion.niveles.find(n => Number(n.id) === nivel).usos, 2);
    assert.equal(r.body.clasificacion.subcategorias.find(s => Number(s.id) === sub).usos, 2);
    assert.equal(r.body.clasificacion.categorias.find(c => Number(c.id) === cat).usos, 2);
  });

  test('jop y administrador no leen ni escriben el mantenedor', async () => {
    for (const rol of ['jop', 'administrador']) {
      assert.equal((await api('GET', BASE, { rol })).status, 403, rol);
      assert.equal((await api('POST', `${BASE}/general`, { rol, body: { nombre: 'X' } })).status, 403, rol);
      assert.equal((await api('PUT', `${BASE}/general/1`, { rol, body: { nombre: 'X' } })).status, 403, rol);
      assert.equal((await api('DELETE', `${BASE}/general/1?mover_a=2`, { rol })).status, 403, rol);
    }
    assert.equal(await columnaDe('MAT-FIFO', GENERAL), 1);
    assert.equal(await db.contar('inventario.material_categoria_general'), 2);
  });
});
