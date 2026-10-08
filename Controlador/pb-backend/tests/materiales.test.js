const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * CU-19: presentacion comercial del producto.
 *
 * Invariantes que protegen:
 *  - una presentacion invalida (vacia, solo espacios, mas de 150) nunca llega a la BD;
 *  - un PUT que NO trae la presentacion la conserva, con su fecha. Antes de CU-19
 *    cualquier edicion la dejaba en NULL, porque ninguna pantalla la enviaba;
 *  - la fecha de modificacion se mueve solo cuando la presentacion cambia de verdad.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const SKU = 'MAT-FIFO';

/** Presentacion y fecha de modificacion en BD. */
async function presentacion(sku = SKU) {
  const { rows } = await db.query(
    `SELECT material_presentacion AS valor, material_presentacion_fecha_modificacion AS fecha
     FROM inventario.material WHERE material_sku = $1`,
    [sku]
  );
  return rows[0];
}

/** Deja una presentacion con una fecha conocida en el pasado. */
async function sembrarPresentacion(valor) {
  await db.query(
    `UPDATE inventario.material
     SET material_presentacion = $1,
         material_presentacion_fecha_modificacion = '2026-01-15 10:00:00-03'
     WHERE material_sku = $2`,
    [valor, SKU]
  );
  return presentacion();
}

describe('Registrar la presentacion comercial (CU-19)', () => {
  test('una presentacion valida se guarda recortada y con fecha de modificacion', async () => {
    const r = await api('PUT', `/api/materiales/${SKU}`, { body: { presentacion: '  Caja x 50 unidades  ' } });

    assert.equal(r.status, 200);
    const p = await presentacion();
    assert.equal(p.valor, 'Caja x 50 unidades');
    assert.ok(p.fecha, 'debe registrar la fecha de modificacion');
  });

  test('Exc 1: vacia o solo espacios se rechaza y no toca la BD', async () => {
    const antes = await sembrarPresentacion('Bolsa 25 kg');

    for (const invalida of ['', '    ', null]) {
      const r = await api('PUT', `/api/materiales/${SKU}`, { body: { presentacion: invalida } });
      assert.equal(r.status, 400, `debe rechazar ${JSON.stringify(invalida)}`);
    }
    assert.deepEqual(await presentacion(), antes);
  });

  test('Exc 2: 151 caracteres se rechaza; 150 se acepta', async () => {
    const antes = await sembrarPresentacion('Bolsa 25 kg');

    const larga = await api('PUT', `/api/materiales/${SKU}`, { body: { presentacion: 'x'.repeat(151) } });
    assert.equal(larga.status, 400);
    assert.deepEqual(await presentacion(), antes);

    const limite = await api('PUT', `/api/materiales/${SKU}`, { body: { presentacion: 'x'.repeat(150) } });
    assert.equal(limite.status, 200);
    assert.equal((await presentacion()).valor.length, 150);
  });

  test('un PUT que no trae la presentacion la conserva, con su fecha', async () => {
    const antes = await sembrarPresentacion('Bolsa 25 kg');

    const r = await api('PUT', `/api/materiales/${SKU}`, { body: { nombre: 'Material renombrado' } });

    assert.equal(r.status, 200);
    assert.deepEqual(await presentacion(), antes);
  });

  test('reenviar la misma presentacion no mueve la fecha', async () => {
    const antes = await sembrarPresentacion('Bolsa 25 kg');

    const r = await api('PUT', `/api/materiales/${SKU}`, { body: { presentacion: 'Bolsa 25 kg' } });

    assert.equal(r.status, 200);
    assert.deepEqual(await presentacion(), antes);
  });

  test('sobrescribir una presentacion existente actualiza valor y fecha', async () => {
    const antes = await sembrarPresentacion('Bolsa 25 kg');

    const r = await api('PUT', `/api/materiales/${SKU}`, { body: { presentacion: 'Pallet 40 bolsas' } });

    assert.equal(r.status, 200);
    const p = await presentacion();
    assert.equal(p.valor, 'Pallet 40 bolsas');
    assert.ok(p.fecha > antes.fecha, 'la fecha debe avanzar');
  });

  test('GET devuelve la presentacion y su fecha', async () => {
    await sembrarPresentacion('Bolsa 25 kg');

    const r = await api('GET', `/api/materiales/${SKU}`);

    assert.equal(r.status, 200);
    assert.equal(r.body.presentacion, 'Bolsa 25 kg');
    assert.ok(r.body.presentacion_fecha_modificacion);
  });
});

describe('PUT parcial: los campos omitidos se conservan', () => {
  /** Los campos que un PUT parcial ponia en NULL antes del arreglo. */
  async function ficha() {
    const { rows } = await db.query(
      `SELECT material_descripcion, material_presentacion,
              material_stock_minimo, material_stock_maximo, material_stock_critico,
              material_categoria_general_id_categoria_general,
              material_categoria_funcional_id_categoria_funcional,
              material_clasificacion_nivel_especifico_id,
              material_nombre_material, material_estado
       FROM inventario.material WHERE material_sku = $1`,
      [SKU]
    );
    return rows[0];
  }

  /** Deja MAT-FIFO con todos los campos llenos. */
  async function completar() {
    await db.query(
      `UPDATE inventario.material
       SET material_descripcion = 'Descripcion original', material_presentacion = 'Caja x 50',
           material_stock_maximo = 100
       WHERE material_sku = $1`,
      [SKU]
    );
    return ficha();
  }

  test('vincular un proveedor no cambia ningun campo del material', async () => {
    const antes = await completar();

    // Desde CU-60 el vinculo tiene su propio endpoint
    const r = await api('POST', `/api/materiales/${SKU}/proveedores`, {
      body: { proveedor_id: 2, precio: 900, tiempo_reposicion: 5, cantidad_minima: 1 },
    });

    assert.equal(r.status, 201);
    assert.deepEqual(await ficha(), antes);
    assert.equal(await db.contar('inventario.material_proveedor',
      `material_sku = '${SKU}' AND proveedor_id_proveedor = 2`), 1);
  });

  test('un PUT con el antiguo vincular_proveedor ya no vincula ni toca el material', async () => {
    const antes = await completar();

    const r = await api('PUT', `/api/materiales/${SKU}`, {
      body: { vincular_proveedor: { proveedor_id: 2, tiempo_reposicion: 5 } },
    });

    assert.equal(r.status, 200);
    assert.deepEqual(await ficha(), antes);
    assert.equal(await db.contar('inventario.material_proveedor',
      `material_sku = '${SKU}' AND proveedor_id_proveedor = 2`), 0);
  });

  test('un PUT con solo el nombre conserva el resto', async () => {
    const antes = await completar();

    const r = await api('PUT', `/api/materiales/${SKU}`, { body: { nombre: 'Nombre nuevo' } });

    assert.equal(r.status, 200);
    assert.deepEqual(await ficha(), { ...antes, material_nombre_material: 'Nombre nuevo' });
  });

  test('un campo enviado como null explicito se limpia', async () => {
    const antes = await completar();

    const r = await api('PUT', `/api/materiales/${SKU}`, {
      body: { stock_maximo: null, descripcion: null },
    });

    assert.equal(r.status, 200);
    assert.deepEqual(await ficha(), { ...antes, material_stock_maximo: null, material_descripcion: null });
  });

  test('un minimo nuevo por debajo del critico guardado se rechaza sin tocar la BD', async () => {
    const antes = await completar();   // semilla: minimo 5, critico 2

    const r = await api('PUT', `/api/materiales/${SKU}`, { body: { stock_minimo: 2 } });

    assert.equal(r.status, 400);
    assert.deepEqual(await ficha(), antes);
  });

  test('borrar el minimo y fijar un critico a la vez se rechaza', async () => {
    const antes = await completar();

    const r = await api('PUT', `/api/materiales/${SKU}`, { body: { stock_minimo: null, stock_critico: 1 } });

    assert.equal(r.status, 400);
    assert.deepEqual(await ficha(), antes);
  });
});

describe('Vincular precio y tiempo por producto (CU-60)', () => {
  const vincular = (body, opciones = {}) =>
    api('POST', `/api/materiales/${SKU}/proveedores`, { body, ...opciones });
  const valido = { proveedor_id: 2, precio: 1500, tiempo_reposicion: 7, cantidad_minima: 10 };

  /** Relacion MAT-FIFO / proveedor en BD, o undefined. */
  async function relacion(proveedorId) {
    const { rows } = await db.query(
      `SELECT material_proveedor_precio_referencial::float AS precio,
              material_proveedor_tiempo_reposicion          AS tiempo,
              material_proveedor_cantidad_minima::float     AS cantidad_minima,
              material_proveedor_proveedor_principal        AS principal
       FROM inventario.material_proveedor WHERE material_sku = $1 AND proveedor_id_proveedor = $2`,
      [SKU, proveedorId]
    );
    return rows[0];
  }

  /** Historial de precios de MAT-FIFO con un proveedor, del mas antiguo al mas nuevo. */
  async function historial(proveedorId) {
    const { rows } = await db.query(
      `SELECT precio_unitario::float AS precio, fecha_vigencia_hasta AS hasta
       FROM inventario.historial_precio_material
       WHERE material_sku = $1 AND proveedor_id_proveedor = $2 ORDER BY historial_precio_id`,
      [SKU, proveedorId]
    );
    return rows;
  }

  test('vincular un proveedor nuevo guarda la relacion y abre su precio en el historial', async () => {
    const r = await vincular(valido);

    assert.equal(r.status, 201);
    assert.deepEqual(await relacion(2), { precio: 1500, tiempo: 7, cantidad_minima: 10, principal: false });
    const h = await historial(2);
    assert.equal(h.length, 1);
    assert.equal(h[0].precio, 1500);
    assert.equal(h[0].hasta, null);
  });

  test('Exc 1: precio, plazo o cantidad en cero, negativos o vacios se rechazan sin escribir', async () => {
    const invalidos = [
      { precio: 0 }, { precio: -5 }, { precio: null },
      { tiempo_reposicion: 0 }, { tiempo_reposicion: 2.5 }, { tiempo_reposicion: null },
      { cantidad_minima: 0 }, { cantidad_minima: null },
    ];
    for (const malo of invalidos) {
      const r = await vincular({ ...valido, ...malo });
      assert.equal(r.status, 400, `debe rechazar ${JSON.stringify(malo)}`);
      assert.equal(r.body.campo, Object.keys(malo)[0], 'indica el campo invalido');
    }
    assert.equal(await relacion(2), undefined);
    assert.equal((await historial(2)).length, 0);
  });

  test('Exc 2: sin confirmar devuelve 409 con los valores vigentes y no cambia nada', async () => {
    await vincular(valido);

    const r = await vincular({ ...valido, precio: 2000 });

    assert.equal(r.status, 409);
    assert.deepEqual(r.body.vigentes, { precio: 1500, tiempo_reposicion: 7, cantidad_minima: 10 });
    assert.equal((await relacion(2)).precio, 1500);
    assert.equal((await historial(2)).length, 1);
  });

  test('Exc 2: con confirmar actualiza y deja el precio anterior cerrado en el historial', async () => {
    await vincular(valido);

    const r = await vincular({ ...valido, precio: 2000, tiempo_reposicion: 4, cantidad_minima: 5, confirmar: true });

    assert.equal(r.status, 200);
    assert.deepEqual(await relacion(2), { precio: 2000, tiempo: 4, cantidad_minima: 5, principal: false });
    const h = await historial(2);
    assert.equal(h.length, 2);
    assert.equal(h[0].precio, 1500);
    assert.ok(h[0].hasta, 'el precio anterior queda con fecha de termino');
    assert.equal(h[1].precio, 2000);
    assert.equal(h[1].hasta, null);
  });

  test('una relacion antigua sin historial registra igual su precio anterior al actualizar', async () => {
    // La semilla vincula MAT-FIFO con el proveedor 1 a 1000, sin fila en el historial
    const r = await vincular({ proveedor_id: 1, precio: 1200, tiempo_reposicion: 3, cantidad_minima: 1, confirmar: true });

    assert.equal(r.status, 200);
    const h = await historial(1);
    assert.deepEqual(h.map(x => x.precio), [1000, 1200]);
    assert.ok(h[0].hasta);
    assert.equal(h[1].hasta, null);
  });

  test('si el precio no cambia, actualizar no toca el historial', async () => {
    await vincular(valido);

    await vincular({ ...valido, tiempo_reposicion: 9, confirmar: true });

    assert.equal((await relacion(2)).tiempo, 9);
    assert.equal((await historial(2)).length, 1);
  });

  test('JOP no puede vincular proveedores (403)', async () => {
    const r = await vincular(valido, { rol: 'jop' });
    assert.equal(r.status, 403);
    assert.equal(await relacion(2), undefined);
  });

  test('la ficha no envia precios de proveedor al rol JOP', async () => {
    const jop = await api('GET', `/api/materiales/${SKU}`, { rol: 'jop' });
    const ger = await api('GET', `/api/materiales/${SKU}`);

    assert.ok(jop.body.proveedores.length > 0);
    assert.ok(jop.body.proveedores.every(p => !('precio_referencial' in p)));
    assert.equal(parseFloat(ger.body.proveedores[0].precio_referencial), 1000);
  });
});

describe('Crear producto con o sin presentacion (CU-19)', () => {
  const base = { nombre: 'Producto CU-19', unidad_medida_id: 1, categoria_general_id: 1, categoria_funcional_id: 2 };

  test('sin presentacion se crea igual: no es obligatoria al crear', async () => {
    const r = await api('POST', '/api/materiales', { body: { ...base, sku: 'CU19-SIN' } });

    assert.equal(r.status, 201);
    assert.deepEqual(await presentacion('CU19-SIN'), { valor: null, fecha: null });
  });

  test('con presentacion se guarda con fecha; con mas de 150 se rechaza sin crear', async () => {
    const ok = await api('POST', '/api/materiales', { body: { ...base, sku: 'CU19-CON', presentacion: ' Caja x 12 ' } });
    assert.equal(ok.status, 201);
    const p = await presentacion('CU19-CON');
    assert.equal(p.valor, 'Caja x 12');
    assert.ok(p.fecha);

    const larga = await api('POST', '/api/materiales', { body: { ...base, sku: 'CU19-LARGA', presentacion: 'x'.repeat(151) } });
    assert.equal(larga.status, 400);
    assert.equal(await db.contar('inventario.material', "material_sku = 'CU19-LARGA'"), 0);
  });
});
