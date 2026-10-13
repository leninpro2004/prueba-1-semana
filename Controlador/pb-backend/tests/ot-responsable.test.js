const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * Reasignar las OT de un usuario (B-03).
 *
 * Lo que se protege: el responsable de una OT abierta se cambia solo a un usuario activo;
 * no se puede desactivar (ni programar la desactivación de) alguien con OT abiertas, y
 * reasignarlas en bloque mueve solo las abiertas, en una transacción.
 *
 * Semilla: el usuario 2 (jop) es responsable de las OT 1 y 3 (abiertas) y 2 (finalizada).
 * Usuarios 3 a 5: técnico, secretaria y administrador, activos.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const responsables = async () => Object.fromEntries((await db.query(
  `SELECT orden_trabajo_id_orden::int AS id, usuario_id_usuario::int AS u FROM inventario.orden_trabajo ORDER BY 1`
)).rows.map(r => [r.id, r.u]));
const cambiar = (ot, responsable_id, rol) => api('PUT', `/api/ordenes-trabajo/${ot}/responsable`, { body: { responsable_id }, rol });
const desactivar = (id) => api('PUT', `/api/usuarios/${id}/permisos`, { body: { estado: 'inactivo' } });
const reasignar = (id, responsable_id) => api('POST', `/api/usuarios/${id}/reasignar-ot`, { body: { responsable_id } });

describe('cambiar el responsable de una OT', () => {
  test('OT abierta → el nuevo responsable, auditado y visible en el encabezado', async () => {
    const r = await cambiar(1, 5);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await responsables())[1], 5);
    assert.equal(await db.contar('finanzas.evento_auditoria', `accion_realizada = 'cambiar_responsable_ot'`), 1);
    const det = await api('GET', '/api/ordenes-trabajo/1/consumos');
    assert.equal(det.body.orden.responsable, 'admin.test');
  });

  test('rechazos: inexistente, inactivo, el mismo, OT cerrada → 400 sin cambios', async () => {
    await db.query(`UPDATE inventario.usuario SET usuario_estado_cuenta = 'inactivo' WHERE usuario_id_usuario = 4`);
    const antes = await responsables();
    assert.match((await cambiar(1, 99)).body.error, /no existe/);
    assert.match((await cambiar(1, 4)).body.error, /no tiene la cuenta activa/);
    assert.match((await cambiar(1, 2)).body.error, /ya es el responsable/);
    assert.equal((await cambiar(2, 5)).status, 400);                 // OT 2 finalizada
    assert.deepEqual(await responsables(), antes);
  });

  test('solo gerencia', async () => {
    assert.equal((await cambiar(1, 5, 'jop')).status, 403);
    assert.equal((await responsables())[1], 2);
  });
});

describe('desactivar a un usuario con OT abiertas', () => {
  test('bloquea con OT_PENDIENTES; reasignar todas y luego desactivar funciona', async () => {
    const bloqueo = await desactivar(2);
    assert.equal(bloqueo.status, 400);
    assert.equal(bloqueo.body.codigo, 'OT_PENDIENTES');
    assert.equal(bloqueo.body.pendientes, 2);

    const r = await reasignar(2, 5);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.reasignadas, [1, 3]);
    assert.deepEqual(await responsables(), { 1: 5, 2: 2, 3: 5 });  // la finalizada conserva quién la llevó

    assert.equal((await desactivar(2)).status, 200);
  });

  test('programar la desactivación también se bloquea', async () => {
    const manana = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const r = await api('POST', '/api/usuarios/2/programar-desactivacion', { body: { fecha: manana } });
    assert.equal(r.status, 400);
    assert.equal(r.body.codigo, 'OT_PENDIENTES');
    const { rows } = await db.query(
      `SELECT usuario_desactivacion_programada AS p FROM inventario.usuario WHERE usuario_id_usuario = 2`);
    assert.equal(rows[0].p, null);
  });

  test('reasignar a sí mismo o a un inactivo → 400 sin cambios', async () => {
    await db.query(`UPDATE inventario.usuario SET usuario_estado_cuenta = 'inactivo' WHERE usuario_id_usuario = 4`);
    const antes = await responsables();
    assert.equal((await reasignar(2, 2)).status, 400);
    assert.equal((await reasignar(2, 4)).status, 400);
    assert.deepEqual(await responsables(), antes);
  });
});
