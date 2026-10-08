const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * D47 en Herramientas: el RUT de un empleado nunca se muestra, ni siquiera cuando no
 * tiene nombre. Viaja solo como valor del selector.
 *
 * Semilla: MAT-HERR (herramienta, 3 en la bodega 1); empleado 22222222-2 "Empleado Test"
 * (cargo Operario). Aquí se agrega uno sin nombre.
 */

const SIN_NOMBRE = '33333333-3';

before(async () => { await db.resetear(); });
beforeEach(async () => {
  await db.resetear();
  await db.query(
    `INSERT INTO finanzas.empleado (empleado_rut_empleado, empleado_nombre_empleado_primer_nombre_empleado,
       empleado_nombre_empleado_primer_apellido_empleado, empleado_estado, empleado_fecha_ingreso,
       empleado_cargo_id_cargo, empleado_tipo_vinculo_laboral_id_tipo_vinculo)
     VALUES ($1, '', '', 'activo', '2024-01-01', 1, 1)`, [SIN_NOMBRE]);
});
after(async () => { await bajar(); await db.cerrar(); });

test('asignar a un empleado sin nombre: la auditoría dice "Empleado sin nombre", no el RUT', async () => {
  const r = await api('POST', '/api/herramientas/MAT-HERR/asignar', { body: { empleado_rut: SIN_NOMBRE, cantidad: 1 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const { rows } = await db.query(
    `SELECT registro_afectado AS d FROM finanzas.evento_auditoria WHERE accion_realizada = 'Asignar herramienta'`);
  assert.equal(rows.length, 1);
  assert.match(rows[0].d, /Empleado sin nombre/);
  assert.ok(!rows[0].d.includes(SIN_NOMBRE), 'el RUT no queda en la auditoría');
});

test('asignar a un empleado con nombre: la auditoría lleva su nombre', async () => {
  await api('POST', '/api/herramientas/MAT-HERR/asignar', { body: { empleado_rut: '22222222-2', cantidad: 1 } });
  const { rows } = await db.query(
    `SELECT registro_afectado AS d FROM finanzas.evento_auditoria WHERE accion_realizada = 'Asignar herramienta'`);
  assert.match(rows[0].d, /Empleado Test/);
  assert.ok(!rows[0].d.includes('22222222-2'));
});

test('el catálogo trae el cargo, para distinguir homónimos sin mostrar el RUT', async () => {
  const r = await api('GET', '/api/herramientas/catalogo');
  assert.equal(r.status, 200);
  const e = r.body.empleados.find(x => x.rut === '22222222-2');
  assert.deepEqual([e.nombre, e.cargo], ['Empleado Test', 'Operario']);
  assert.equal(r.body.empleados.find(x => x.rut === SIN_NOMBRE).nombre, null);
});
