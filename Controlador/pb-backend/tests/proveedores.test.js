const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * Proveedores: estado y actualizacion parcial.
 *
 * Los dos invariantes que protegen:
 *  - un proveedor desactivado SIEMPRE se puede volver a activar. `eliminar` lo
 *    desactiva cuando tiene materiales, facturas o lotes asociados, y sin camino
 *    de vuelta esa desactivacion era definitiva.
 *  - una actualizacion PARCIAL no borra los campos que no vienen en el cuerpo.
 *    El modal de edicion no manda tipo, pais ni apellido de contacto, asi que cada
 *    edicion desde la UI los perdia en silencio.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

/** Fila cruda del proveedor, para mirar los campos que la API no siempre expone. */
async function proveedor(id) {
  const { rows } = await db.query(
    `SELECT proveedor_razon_social AS nombre, proveedor_estado AS estado,
            proveedor_rubro AS rubro, proveedor_tipo_proveedor AS tipo,
            proveedor_pais AS pais,
            proveedor_contacto_primer_nombre AS contacto_nombre,
            proveedor_contacto_primer_apellido AS contacto_apellido
     FROM inventario.proveedor WHERE proveedor_id_proveedor = $1`,
    [id]
  );
  return rows[0] || null;
}

describe('Activar y desactivar un proveedor', () => {
  test('desactivar y volver a activar deja el proveedor como estaba', async () => {
    const off = await api('PUT', '/api/proveedores/1/estado', { body: { estado: 'inactivo' } });
    assert.equal(off.status, 200);
    assert.equal((await proveedor(1)).estado, 'inactivo');

    const on = await api('PUT', '/api/proveedores/1/estado', { body: { estado: 'activo' } });
    assert.equal(on.status, 200);
    assert.equal((await proveedor(1)).estado, 'activo');
  });

  test('cambiar el estado NO toca el resto de los campos', async () => {
    const antes = await proveedor(1);

    await api('PUT', '/api/proveedores/1/estado', { body: { estado: 'inactivo' } });

    const despues = await proveedor(1);
    assert.equal(despues.rubro, antes.rubro);
    assert.equal(despues.tipo, antes.tipo);
    assert.equal(despues.pais, antes.pais);
    assert.equal(despues.contacto_apellido, antes.contacto_apellido);
  });

  test('un proveedor que `eliminar` desactivo se puede reactivar', async () => {
    // El proveedor 1 tiene material_proveedor asociado en la semilla, así que
    // DELETE lo desactiva en vez de borrarlo.
    const del = await api('DELETE', '/api/proveedores/1');
    assert.equal(del.status, 200);
    assert.equal(del.body.desactivado, true);
    assert.equal((await proveedor(1)).estado, 'inactivo');

    // Y ahora hay camino de vuelta
    const on = await api('PUT', '/api/proveedores/1/estado', { body: { estado: 'activo' } });
    assert.equal(on.status, 200);
    assert.equal((await proveedor(1)).estado, 'activo');
  });

  test('un estado inválido se rechaza sin tocar nada', async () => {
    const r = await api('PUT', '/api/proveedores/1/estado', { body: { estado: 'suspendido' } });

    assert.equal(r.status, 400);
    assert.equal((await proveedor(1)).estado, 'activo');
  });

  test('un proveedor inexistente da 404', async () => {
    const r = await api('PUT', '/api/proveedores/999/estado', { body: { estado: 'activo' } });
    assert.equal(r.status, 404);
  });

  test('el listado filtra por estado', async () => {
    await api('PUT', '/api/proveedores/1/estado', { body: { estado: 'inactivo' } });

    const inactivos = await api('GET', '/api/proveedores?estado=inactivo');
    const activos   = await api('GET', '/api/proveedores?estado=activo');

    assert.equal(inactivos.body.length, 1);
    assert.equal(inactivos.body[0].estado, 'inactivo');
    assert.ok(activos.body.every(p => p.estado === 'activo'));
  });
});

describe('Actualizar un proveedor', () => {
  test('una actualización PARCIAL no borra los campos que no se envían', async () => {
    // Exactamente lo que manda el modal de edición: sin tipo, pais ni apellido.
    const r = await api('PUT', '/api/proveedores/1', {
      body: {
        nombre: 'Proveedor Test',
        rubro: 'Aceros',
        contacto_nombre: 'Ana',
        correos: ['test@proveedor.cl'],
        telefonos: ['+56900000000'],
      },
    });

    assert.equal(r.status, 200);
    const p = await proveedor(1);
    assert.equal(p.tipo, 'distribuidor');
    assert.equal(p.pais, 'Chile');
    assert.equal(p.contacto_apellido, 'Rojas');
  });

  test('un campo enviado vacío SÍ se limpia: es una acción deliberada', async () => {
    const r = await api('PUT', '/api/proveedores/1', {
      body: { nombre: 'Proveedor Test', pais: '' },
    });

    assert.equal(r.status, 200);
    const p = await proveedor(1);
    assert.equal(p.pais, null);
    assert.equal(p.tipo, 'distribuidor');   // el que no se mandó sigue ahí
  });

  test('actualizar no cambia el estado si no se envía', async () => {
    await api('PUT', '/api/proveedores/1/estado', { body: { estado: 'inactivo' } });

    await api('PUT', '/api/proveedores/1', { body: { nombre: 'Proveedor Test' } });

    assert.equal((await proveedor(1)).estado, 'inactivo');
  });

  test('un proveedor inexistente da 404', async () => {
    const r = await api('PUT', '/api/proveedores/999', { body: { nombre: 'Nada' } });
    assert.equal(r.status, 404);
  });
});

describe('Historial de precios por proveedor (CU-61)', () => {
  /** Siembra precios del proveedor 1 con fechas conocidas, en desorden a proposito. */
  async function sembrarPrecios() {
    await db.query(
      `INSERT INTO inventario.historial_precio_material
         (material_sku, proveedor_id_proveedor, precio_unitario, fecha_vigencia_desde, fuente, usuario_id_usuario)
       VALUES ('MAT-FIFO', 1, 1200, '2026-03-10', 'manual',  1),
              ('MAT-FIFO', 1, 1000, '2026-01-05', 'manual',  1),
              ('MAT-CRIT', 1, 5000, '2026-02-20', 'factura', 2)`
    );
  }
  const precios = (id, qs = '', opciones = {}) => api('GET', `/api/proveedores/${id}/precios${qs}`, opciones);
  const fecha = (f) => new Date(f).toLocaleDateString('sv-SE');

  test('devuelve los precios en orden cronologico con producto y usuario', async () => {
    await sembrarPrecios();

    const r = await precios(1);

    assert.equal(r.status, 200);
    assert.equal(r.body.total_proveedor, 3);
    assert.deepEqual(r.body.precios.map(p => fecha(p.fecha)), ['2026-01-05', '2026-02-20', '2026-03-10']);
    assert.deepEqual(r.body.precios.map(p => p.usuario), ['gerente.test', 'jop.test', 'gerente.test']);
    assert.equal(r.body.precios[1].material, 'Material crítico');
    assert.deepEqual(r.body.productos.map(p => p.sku).sort(), ['MAT-CRIT', 'MAT-FIFO']);
  });

  test('filtra por producto y por rango de fechas', async () => {
    await sembrarPrecios();

    const porSku = await precios(1, '?sku=MAT-FIFO');
    const porRango = await precios(1, '?desde=2026-02-01&hasta=2026-02-28');

    assert.deepEqual(porSku.body.precios.map(p => parseFloat(p.precio_unitario)), [1000, 1200]);
    assert.deepEqual(porRango.body.precios.map(p => p.sku), ['MAT-CRIT']);
    assert.equal(porRango.body.total_proveedor, 3, 'el total sin filtros no cambia con el filtro');
  });

  test('Exc 1: un proveedor sin historial devuelve total_proveedor 0', async () => {
    const r = await precios(2);
    assert.equal(r.status, 200);
    assert.equal(r.body.total_proveedor, 0);
    assert.deepEqual(r.body.precios, []);
  });

  test('rango invertido da 400 y proveedor inexistente da 404', async () => {
    assert.equal((await precios(1, '?desde=2026-03-01&hasta=2026-01-01')).status, 400);
    assert.equal((await precios(999)).status, 404);
  });

  test('los historiales de precios son solo para gerencia (JOP recibe 403)', async () => {
    await sembrarPrecios();
    assert.equal((await precios(1, '', { rol: 'jop' })).status, 403);
    assert.equal((await api('GET', '/api/materiales/MAT-FIFO/precios', { rol: 'jop' })).status, 403);
    assert.equal((await api('GET', '/api/materiales/MAT-FIFO/historial-precios', { rol: 'jop' })).status, 403);
    assert.equal((await api('GET', '/api/materiales/MAT-FIFO/precios')).status, 200);
  });
});

describe('Variacion de precios (CU-64)', () => {
  /**
   * Proveedor 1: MAT-FIFO 1000 → 1250 → 1250 (sin cambio); MAT-CRIT un unico precio.
   * Proveedor 2: MAT-FIFO 800, intercalado en fecha, para comprobar que la variacion
   * se calcula por proveedor y no mezcla precios de otro.
   */
  async function sembrar() {
    await db.query(
      `INSERT INTO inventario.historial_precio_material
         (material_sku, proveedor_id_proveedor, precio_unitario, fecha_vigencia_desde, fuente, usuario_id_usuario)
       VALUES ('MAT-FIFO', 1, 1000, '2026-01-05', 'manual',  1),
              ('MAT-FIFO', 2,  800, '2026-02-01', 'manual',  1),
              ('MAT-FIFO', 1, 1250, '2026-03-10', 'factura', 1),
              ('MAT-FIFO', 1, 1250, '2026-05-02', 'manual',  1),
              ('MAT-CRIT', 1, 5000, '2026-02-20', 'manual',  1)`
    );
  }
  const num = (v) => (v == null ? null : parseFloat(v));
  const fila = (p) => ({ sku: p.sku, anterior: num(p.precio_anterior), abs: num(p.variacion_abs), pct: num(p.variacion_pct), n: p.registros_producto });

  test('por proveedor: variacion absoluta y porcentual respecto del registro anterior del producto', async () => {
    await sembrar();

    const r = await api('GET', '/api/proveedores/1/precios');

    assert.deepEqual(r.body.precios.map(fila), [
      { sku: 'MAT-FIFO', anterior: null, abs: null, pct: null, n: 3 },   // primer precio
      { sku: 'MAT-CRIT', anterior: null, abs: null, pct: null, n: 1 },   // Exc 2: unico precio
      { sku: 'MAT-FIFO', anterior: 1000, abs: 250,  pct: 25,   n: 3 },
      { sku: 'MAT-FIFO', anterior: 1250, abs: 0,    pct: 0,    n: 3 },   // sin cambio
    ]);
  });

  test('con filtro de fechas, el primer registro del rango conserva su precio anterior', async () => {
    await sembrar();

    const r = await api('GET', '/api/proveedores/1/precios?desde=2026-03-01&sku=MAT-FIFO');

    assert.equal(r.body.precios.length, 2);
    assert.equal(num(r.body.precios[0].precio_anterior), 1000, 'se compara con el precio de enero, fuera del rango');
    assert.equal(num(r.body.precios[0].variacion_pct), 25);
  });

  test('por producto: la variacion se calcula contra el precio anterior del MISMO proveedor', async () => {
    await sembrar();

    const r = await api('GET', '/api/materiales/MAT-FIFO/precios');
    const deProv1 = r.body.precios.filter(p => String(p.proveedor_id) === '1');
    const deProv2 = r.body.precios.filter(p => String(p.proveedor_id) === '2');

    // El listado por producto va del mas reciente al mas antiguo
    assert.deepEqual(deProv1.map(p => num(p.precio_anterior)), [1250, 1000, null]);
    assert.equal(num(deProv1[1].variacion_abs), 250, 'no se compara con los 800 del proveedor 2');
    assert.equal(deProv2[0].precio_anterior, null);
    assert.equal(deProv2[0].registros_producto, 1);
  });
});
