const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { api, bajar, levantar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * D62: toda ruta que escribe exige un rol, no solo sesión iniciada.
 *
 * Lo que protegen:
 *  - Técnico y secretaria (que aún no tienen permisos definidos: migración a perfiles) no
 *    escriben nada: 403 y la BD queda igual.
 *  - Nadie que hoy trabaja pierde acceso: jop sigue registrando movimientos y bodegas.
 *  - Lo que la pantalla limita a gerencia (editar, activar/desactivar y eliminar proveedores)
 *    o a gerencia y administrador (borrar bodegas y anaqueles) también lo limita el backend.
 *
 * Se agrega aquí toda ruta nueva que escriba.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

/** Llama con un rol cualquiera (los helpers solo firman gerencia y jop). */
async function comoRol(rol, metodo, ruta, body = {}) {
  const url = await levantar();
  const token = jwt.sign({ id: 2, username: 'jop.test', rol }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const opciones = { method: metodo, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  if (metodo !== 'GET') opciones.body = JSON.stringify(body);
  const r = await fetch(url + ruta, opciones);
  return { status: r.status, body: await r.json().catch(() => null) };
}

// Las 28 rutas que escriben y antes solo pedían sesión, más las nuevas
const RUTAS = [
  ['POST', '/api/materiales'], ['PUT', '/api/materiales/MAT-FIFO'],
  ['POST', '/api/bodegas'], ['PUT', '/api/bodegas/1'], ['DELETE', '/api/bodegas/2'],
  ['POST', '/api/bodegas/1/anaqueles'], ['PUT', '/api/bodegas/1/anaqueles/1'], ['DELETE', '/api/bodegas/1/anaqueles/1'],
  ['POST', '/api/proveedores'], ['PUT', '/api/proveedores/1'], ['PUT', '/api/proveedores/1/estado'], ['DELETE', '/api/proveedores/1'],
  ['POST', '/api/movimientos/entrada'], ['POST', '/api/movimientos/salida'], ['POST', '/api/movimientos/traslado'],
  ['POST', '/api/movimientos/verificar-mermas-pendientes'],
  ['POST', '/api/ordenes-trabajo/1/consumos'], ['PUT', '/api/ordenes-trabajo/1/consumos/MAT-FIFO'],
  ['PUT', '/api/ordenes-trabajo/1/estimados'], ['PUT', '/api/ordenes-trabajo/1/consumo'],
  ['DELETE', '/api/ordenes-trabajo/1/materiales/MAT-FIFO'],
  ['PUT', '/api/herramientas/asignaciones/1/devolver'], ['POST', '/api/herramientas/MAT-FIFO/asignar'],
  ['POST', '/api/herramientas/MAT-FIFO/mantenimiento'],
  ['POST', '/api/seguimiento-pinturas'], ['PUT', '/api/seguimiento-pinturas/1/devolver'],
  ['PUT', '/api/seguimiento-pinturas/1/anular'], ['PUT', '/api/seguimiento-pinturas/1'],
  // D51 (pedidos de instalación)
  ['PUT', '/api/pedidos-venta/1/devolucion/MAT-FIFO'], ['PUT', '/api/pedidos-venta/1/deshacer-preparado'],
  ['PUT', '/api/pedidos-venta/1/cancelar'],
  // D53 (ajuste por conteo) y D54 (corrección de una OT cerrada)
  ['POST', '/api/conteos/1/ajustes'], ['PUT', '/api/ordenes-trabajo/2/correccion'],
];

/** Una foto de las tablas que estas rutas tocan. */
async function foto() {
  const tablas = ['inventario.material', 'inventario.bodega', 'inventario.anaquel', 'inventario.proveedor',
                  'inventario.movimiento_inventario', 'inventario.inventario_bodega', 'inventario.seguimiento_pintura'];
  const r = {};
  for (const t of tablas) r[t] = await db.contar(t);
  r.stock = await db.stockDe('MAT-FIFO');
  const { rows } = await db.query(`SELECT proveedor_estado AS e FROM inventario.proveedor ORDER BY proveedor_id_proveedor`);
  r.proveedores = rows.map(x => x.e);
  return r;
}

describe('Técnico y secretaria no escriben', () => {
  for (const rol of ['tecnico', 'secretaria']) {
    test(`${rol}: 403 en todas las rutas que escriben y la BD queda igual`, async () => {
      const antes = await foto();
      for (const [metodo, ruta] of RUTAS) {
        const r = await comoRol(rol, metodo, ruta, { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 1, nombre: 'X' });
        assert.equal(r.status, 403, `${metodo} ${ruta} → ${r.status}`);
      }
      assert.deepEqual(await foto(), antes);
    });
  }
});

describe('Lo que cada rol conserva', () => {
  test('jop sigue registrando movimientos', async () => {
    const r = await api('POST', '/api/movimientos/salida', {
      rol: 'jop', body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 1, tipo_movimiento_id: 2, motivo_id: 2 },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  test('editar, activar/desactivar y eliminar proveedores: solo gerencia (como la pantalla)', async () => {
    for (const [metodo, ruta] of [['PUT', '/api/proveedores/1'], ['PUT', '/api/proveedores/1/estado'], ['DELETE', '/api/proveedores/1']]) {
      assert.equal((await comoRol('jop', metodo, ruta)).status, 403, `jop ${metodo} ${ruta}`);
      assert.equal((await comoRol('administrador', metodo, ruta)).status, 403, `administrador ${metodo} ${ruta}`);
    }
    const r = await api('PUT', '/api/proveedores/1/estado', { body: { estado: 'inactivo' } });
    assert.notEqual(r.status, 403, 'gerencia sí');
  });

  test('D51 y D54: deshacer o cancelar un pedido y corregir una OT cerrada, solo gerencia', async () => {
    for (const ruta of ['/api/pedidos-venta/1/deshacer-preparado', '/api/pedidos-venta/1/cancelar', '/api/ordenes-trabajo/2/correccion']) {
      assert.equal((await comoRol('jop', 'PUT', ruta, { motivo: 'x' })).status, 403, `jop PUT ${ruta}`);
      assert.equal((await comoRol('administrador', 'PUT', ruta, { motivo: 'x' })).status, 403, `administrador PUT ${ruta}`);
    }
  });

  test('borrar bodegas y anaqueles: gerencia y administrador, no jop', async () => {
    assert.equal((await comoRol('jop', 'DELETE', '/api/bodegas/2')).status, 403);
    assert.equal((await comoRol('jop', 'DELETE', '/api/bodegas/1/anaqueles/1')).status, 403);
    const r = await comoRol('administrador', 'DELETE', '/api/bodegas/2');   // la bodega 2 está vacía
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});
