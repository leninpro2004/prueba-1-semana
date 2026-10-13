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

/* ── F-15: herramientas por trabajador y por período ─────────────────── */

/** Asignación de MAT-HERR con fechas fijas (directo en la tabla: el endpoint usa now()). */
async function asignacion(rut, estado, desde, hasta = null, cantidad = 1) {
  await db.query(
    `INSERT INTO inventario.asignacion_herramienta (material_sku, empleado_rut, cantidad, estado, fecha_asignacion, fecha_devolucion)
     VALUES ('MAT-HERR', $1, $2, $3, $4::timestamptz, $5::timestamptz)`, [rut, cantidad, estado, desde, hasta]);
}
const listar = (qs) => api('GET', `/api/herramientas/asignaciones?${qs}`);

test('F-15: filtro por empleado y totales por estado aunque se miren solo las vigentes', async () => {
  await asignacion('22222222-2', 'asignada', '2026-09-01 10:00', null, 2);
  await asignacion('22222222-2', 'devuelta', '2026-08-01 10:00', '2026-08-20 10:00');
  await asignacion('22222222-2', 'perdida', '2026-07-01 10:00', '2026-07-10 10:00');
  await asignacion(SIN_NOMBRE, 'asignada', '2026-09-05 10:00');

  const r = await listar('empleado_rut=22222222-2');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.asignaciones.length, 1, 'por defecto, solo las vigentes');
  assert.deepEqual(r.body.resumen.por_estado, {
    asignada: { asignaciones: 1, unidades: 2 },
    devuelta: { asignaciones: 1, unidades: 1 },
    perdida: { asignaciones: 1, unidades: 1 },
    dada_de_baja: { asignaciones: 0, unidades: 0 },
  });
  const todas = await listar('empleado_rut=22222222-2&estado=todos');
  assert.equal(todas.body.asignaciones.length, 3);
  assert.ok(todas.body.asignaciones.every(a => a.empleado_rut === '22222222-2'));
});

test('F-15: el período deja las asignaciones vigentes en algún momento de él', async () => {
  await asignacion('22222222-2', 'asignada', '2026-08-15 10:00');                      // desde agosto, sigue
  await asignacion('22222222-2', 'devuelta', '2026-09-10 10:00', '2026-09-12 10:00'); // dentro de septiembre
  await asignacion('22222222-2', 'devuelta', '2026-07-01 10:00', '2026-08-31 10:00'); // devuelta antes
  await asignacion('22222222-2', 'devuelta', '2026-10-02 10:00', '2026-10-05 10:00'); // entregada después

  const r = await listar('empleado_rut=22222222-2&estado=todos&desde=2026-09-01&hasta=2026-09-30');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.asignaciones.map(a => new Date(a.fecha_asignacion).getMonth() + 1).sort(), [8, 9]);
  assert.equal(r.body.resumen.por_estado.devuelta.asignaciones, 1);
});

test('F-15: fecha mal escrita o desde posterior a hasta → 400', async () => {
  assert.equal((await listar('desde=01-09-2026')).status, 400);
  assert.equal((await listar('desde=2026-09-30&hasta=2026-09-01')).status, 400);
});
