const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { api, bajar, autorizacion } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * Reautenticación antes de revertir un movimiento (CU-42).
 *
 * Lo que se protege: el registro de cada intento, el bloqueo a los 3 fallos
 * seguidos (calculado desde la tabla, no en memoria) y que el token de
 * autorización quede atado al usuario y al movimiento.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const CLAVE = 'clave-de-prueba';
let hash = null;

/** Contraseña del gerente de la semilla (usuario 1) y un movimiento para autorizar. */
async function preparar() {
  hash = hash || await bcrypt.hash(CLAVE, 4);
  await db.query(
    `INSERT INTO inventario.usuario_contrasena (usuario_id_usuario, usuario_contrasena) VALUES (1, $1)`,
    [hash]
  );
  const salida = await api('POST', '/api/movimientos/salida', {
    body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 1, tipo_movimiento_id: 2, motivo_id: 2 },
  });
  assert.equal(salida.status, 201);
  return salida.body.movimiento_id;
}

const reautenticar = (movimiento_id, password, opciones = {}) =>
  api('POST', '/api/auth/reautenticar', {
    body: { password, accion: 'revertir_movimiento', movimiento_id },
    ...opciones,
  });

const intentos = (exitoso) => db.contar('inventario.reautenticacion_intento',
  'usuario_id_usuario = 1 AND reautenticacion_intento_exitoso = $1', [exitoso]);

describe('Reautenticación (CU-42)', () => {
  test('contraseña correcta: token atado al usuario y al movimiento, y queda registrada', async () => {
    const mov = await preparar();
    const r = await reautenticar(mov, CLAVE);

    assert.equal(r.status, 200);
    const claims = jwt.verify(r.body.autorizacion, process.env.JWT_SECRET);
    assert.equal(claims.uid, 1);
    assert.equal(claims.mov, Number(mov));
    assert.equal(claims.accion, 'revertir_movimiento');
    assert.ok(claims.exp - claims.iat <= 300, 'el token dura como máximo 5 minutos');

    const { rows } = await db.query(
      `SELECT movimiento_inventario_id_movimiento AS mov, reautenticacion_intento_accion AS accion
       FROM inventario.reautenticacion_intento WHERE reautenticacion_intento_exitoso`
    );
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].mov), Number(mov));
    assert.equal(rows[0].accion, 'revertir_movimiento');
  });

  test('contraseña incorrecta: 403 (no 401, que cierra la sesión) y se registra el intento', async () => {
    const mov = await preparar();
    const r = await reautenticar(mov, 'otra-clave');

    assert.equal(r.status, 403);
    assert.equal(r.body.intentos_restantes, 2);
    assert.equal(await intentos(false), 1);
  });

  test('al tercer fallo seguido: 423, notifica a Gerencia y bloquea incluso con la clave correcta', async () => {
    const mov = await preparar();
    assert.equal((await reautenticar(mov, 'mala-1')).status, 403);
    assert.equal((await reautenticar(mov, 'mala-2')).status, 403);

    const tercero = await reautenticar(mov, 'mala-3');
    assert.equal(tercero.status, 423);
    assert.ok(tercero.body.bloqueado_hasta);
    assert.equal(await db.contar('inventario.notificacion', `notificacion_tipo_notificacion = 'seguridad'`), 1);

    const bloqueado = await reautenticar(mov, CLAVE);
    assert.equal(bloqueado.status, 423);
    assert.equal(bloqueado.body.autorizacion, undefined);
    assert.equal(await intentos(false), 3, 'durante el bloqueo no se registran intentos');
    assert.equal(await intentos(true), 0);
  });

  test('pasados 15 minutos se desbloquea', async () => {
    const mov = await preparar();
    for (const clave of ['mala-1', 'mala-2', 'mala-3']) await reautenticar(mov, clave);
    assert.equal((await reautenticar(mov, CLAVE)).status, 423);

    await db.query(
      `UPDATE inventario.reautenticacion_intento
       SET reautenticacion_intento_fecha_hora = reautenticacion_intento_fecha_hora - INTERVAL '16 minutes'`
    );
    assert.equal((await reautenticar(mov, CLAVE)).status, 200);
  });

  test('vencido el bloqueo hay otros 3 intentos, no uno', async () => {
    const mov = await preparar();
    for (const clave of ['mala-1', 'mala-2', 'mala-3']) await reautenticar(mov, clave);
    await db.query(
      `UPDATE inventario.reautenticacion_intento
       SET reautenticacion_intento_fecha_hora = reautenticacion_intento_fecha_hora - INTERVAL '16 minutes'`
    );

    assert.equal((await reautenticar(mov, 'mala-4')).status, 403);
    assert.equal((await reautenticar(mov, 'mala-5')).status, 403);
    assert.equal((await reautenticar(mov, 'mala-6')).status, 423);
  });

  test('un éxito resetea el contador de fallos', async () => {
    const mov = await preparar();
    await reautenticar(mov, 'mala-1');
    await reautenticar(mov, 'mala-2');
    assert.equal((await reautenticar(mov, CLAVE)).status, 200);

    await reautenticar(mov, 'mala-3');
    const r = await reautenticar(mov, 'mala-4');
    assert.equal(r.status, 403);
    assert.equal(r.body.intentos_restantes, 1);
  });

  test('solo gerencia', async () => {
    const mov = await preparar();
    const r = await reautenticar(mov, CLAVE, { rol: 'jop' });
    assert.equal(r.status, 403);
    assert.equal(await db.contar('inventario.reautenticacion_intento'), 0);
  });

  test('CU-44 Exc 1: un movimiento ya revertido o un inverso se rechaza antes de pedir la clave', async () => {
    const mov = await preparar();
    const r = await api('POST', `/api/movimientos/${mov}/revertir`, { body: { autorizacion: autorizacion(mov) } });
    assert.equal(r.status, 200);

    assert.equal((await reautenticar(mov, CLAVE)).status, 400, 'ya revertido');
    assert.equal((await reautenticar(r.body.inverso_id, CLAVE)).status, 400, 'es el inverso');
    assert.equal(await db.contar('inventario.reautenticacion_intento'), 0, 'no gasta intentos');
  });

  test('validaciones: movimiento inexistente, acción inválida, sin contraseña', async () => {
    await preparar();
    assert.equal((await reautenticar(99999, CLAVE)).status, 404);
    assert.equal((await reautenticar(1, '')).status, 400);
    const accion = await api('POST', '/api/auth/reautenticar', {
      body: { password: CLAVE, accion: 'borrar_todo', movimiento_id: 1 },
    });
    assert.equal(accion.status, 400);
    assert.equal(await db.contar('inventario.reautenticacion_intento'), 0);
  });
});
