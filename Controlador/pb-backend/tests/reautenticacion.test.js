const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * Reautenticación antes de revertir un movimiento (CU-42). Desde F-11 (paso 2) es la firma de un
 * gerente (POST /auth/reautenticar con usuario y contraseña) para la acción revertir_movimiento,
 * que la ruta exige en el header X-Autorizacion (middleware/firma.js).
 *
 * Lo que se protege: el registro de cada intento, el bloqueo a los 3 fallos seguidos (calculado
 * desde la tabla, no en memoria), que el token quede atado a la acción, y que lo que no se puede
 * revertir se rechace ANTES de pedir la firma (CU-44 Exc 1).
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const CLAVE = 'clave-de-prueba';
let hash = null;

/** Contraseña del gerente de la semilla (usuario 1) y un movimiento para revertir. */
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

const reautenticar = (password, opciones = {}) =>
  api('POST', '/api/auth/reautenticar', {
    body: { username: 'gerente.test', password, accion: 'revertir_movimiento' },
    ...opciones,
  });

const revertir = (mov, firma) =>
  api('POST', `/api/movimientos/${mov}/revertir`, { sinFirma: true, ...(firma && { firma }) });

const intentos = (exitoso) => db.contar('inventario.reautenticacion_intento',
  'usuario_id_usuario = 1 AND reautenticacion_intento_exitoso = $1', [exitoso]);

describe('Reautenticación para revertir (CU-42, F-11)', () => {
  test('contraseña correcta: firma para revertir, de un solo uso, y queda registrada', async () => {
    const mov = await preparar();
    const r = await reautenticar(CLAVE);

    assert.equal(r.status, 200);
    const claims = jwt.verify(r.body.autorizacion, process.env.JWT_SECRET);
    assert.equal(claims.tipo, 'firma');
    assert.equal(Number(claims.firmante), 1);
    assert.equal(claims.accion, 'revertir_movimiento');
    assert.ok(claims.exp - claims.iat <= 300, 'el token dura como máximo 5 minutos');

    const { rows } = await db.query(
      `SELECT reautenticacion_intento_accion AS accion
       FROM inventario.reautenticacion_intento WHERE reautenticacion_intento_exitoso`
    );
    assert.deepEqual(rows.map(x => x.accion), ['revertir_movimiento']);

    assert.equal((await revertir(mov)).status, 428, 'sin la firma no revierte');
    assert.equal((await revertir(mov, r.body.autorizacion)).status, 200);
  });

  test('contraseña incorrecta: 403 (no 401, que cierra la sesión) y se registra el intento', async () => {
    await preparar();
    const r = await reautenticar('otra-clave');

    assert.equal(r.status, 403);
    assert.equal(r.body.intentos_restantes, 2);
    assert.equal(await intentos(false), 1);
  });

  test('al tercer fallo seguido: 423, notifica a Gerencia y bloquea incluso con la clave correcta', async () => {
    await preparar();
    assert.equal((await reautenticar('mala-1')).status, 403);
    assert.equal((await reautenticar('mala-2')).status, 403);

    const tercero = await reautenticar('mala-3');
    assert.equal(tercero.status, 423);
    assert.ok(tercero.body.bloqueado_hasta);
    assert.equal(await db.contar('inventario.notificacion', `notificacion_tipo_notificacion = 'seguridad'`), 1);

    const bloqueado = await reautenticar(CLAVE);
    assert.equal(bloqueado.status, 423);
    assert.equal(bloqueado.body.autorizacion, undefined);
    assert.equal(await intentos(false), 3, 'durante el bloqueo no se registran intentos');
    assert.equal(await intentos(true), 0);
  });

  test('pasados 15 minutos se desbloquea', async () => {
    await preparar();
    for (const clave of ['mala-1', 'mala-2', 'mala-3']) await reautenticar(clave);
    assert.equal((await reautenticar(CLAVE)).status, 423);

    await db.query(
      `UPDATE inventario.reautenticacion_intento
       SET reautenticacion_intento_fecha_hora = reautenticacion_intento_fecha_hora - INTERVAL '16 minutes'`
    );
    assert.equal((await reautenticar(CLAVE)).status, 200);
  });

  test('vencido el bloqueo hay otros 3 intentos, no uno', async () => {
    await preparar();
    for (const clave of ['mala-1', 'mala-2', 'mala-3']) await reautenticar(clave);
    await db.query(
      `UPDATE inventario.reautenticacion_intento
       SET reautenticacion_intento_fecha_hora = reautenticacion_intento_fecha_hora - INTERVAL '16 minutes'`
    );

    assert.equal((await reautenticar('mala-4')).status, 403);
    assert.equal((await reautenticar('mala-5')).status, 403);
    assert.equal((await reautenticar('mala-6')).status, 423);
  });

  test('un éxito resetea el contador de fallos', async () => {
    await preparar();
    await reautenticar('mala-1');
    await reautenticar('mala-2');
    assert.equal((await reautenticar(CLAVE)).status, 200);

    await reautenticar('mala-3');
    const r = await reautenticar('mala-4');
    assert.equal(r.status, 403);
    assert.equal(r.body.intentos_restantes, 1);
  });

  test('revertir sigue siendo solo de gerencia: un jop recibe 403 sin que se le pida la firma', async () => {
    const mov = await preparar();
    const r = await api('POST', `/api/movimientos/${mov}/revertir`, { rol: 'jop', sinFirma: true });
    assert.equal(r.status, 403);
  });

  test('CU-44 Exc 1: un movimiento ya revertido o un inverso se rechaza antes de pedir la firma', async () => {
    const mov = await preparar();
    const r = await api('POST', `/api/movimientos/${mov}/revertir`);
    assert.equal(r.status, 200);
    const intentosAntes = await db.contar('inventario.reautenticacion_intento');

    assert.equal((await revertir(mov)).status, 400, 'ya revertido');
    assert.equal((await revertir(r.body.inverso_id)).status, 400, 'es el inverso');
    assert.equal(await db.contar('inventario.reautenticacion_intento'), intentosAntes, 'no gasta intentos');
  });

  test('validaciones: movimiento inexistente o id inválido sin pedir la firma; sin contraseña; acción inválida', async () => {
    await preparar();
    assert.equal((await revertir(99999)).status, 404);
    assert.equal((await revertir('abc')).status, 400);
    assert.equal((await reautenticar('')).status, 400);
    const accion = await api('POST', '/api/auth/reautenticar', {
      body: { username: 'gerente.test', password: CLAVE, accion: 'borrar_todo' },
    });
    assert.equal(accion.status, 400);
    assert.equal(await db.contar('inventario.reautenticacion_intento'), 0);
  });
});
