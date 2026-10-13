const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { api, bajar, levantar } = require('./helpers/api');
const db = require('./helpers/db');
const { reiniciarLimitesLogin } = require('../src/controllers/authController');

/**
 * Límite de intentos del login y cabeceras de seguridad (F-02: S-03 y S-05).
 *
 * Lo que se protege: tras 5 fallos seguidos un usuario queda bloqueado 15 minutos aunque
 * luego llegue la contraseña correcta (si no, adivinar contraseñas no tendría freno); el
 * bloqueo es de ESE usuario, no de los demás; un éxito antes del quinto fallo limpia la
 * cuenta; y una misma IP con 30 fallos queda bloqueada aunque pruebe usuarios distintos.
 * En los tests todas las peticiones vienen de la misma IP (127.0.0.1).
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); reiniciarLimitesLogin(); });
after(async () => { await bajar(); await db.cerrar(); reiniciarLimitesLogin(); });

const CLAVE = 'clave-de-prueba';

/** Contraseña conocida para un usuario de la semilla (1 = gerente.test, 2 = jop.test). */
async function conClave(id, clave = CLAVE) {
  await db.query(
    `INSERT INTO inventario.usuario_contrasena (usuario_id_usuario, usuario_contrasena) VALUES ($1, $2)`,
    [id, await bcrypt.hash(clave, 4)]
  );
}

const login = (username, password) =>
  api('POST', '/api/auth/login', { body: { username, password }, sinToken: true });

describe('Límite por usuario (S-03)', () => {
  test('5 fallos bloquean al usuario: el 6.º intento da 429 aunque la contraseña sea correcta', async () => {
    await conClave(1);
    for (let i = 0; i < 5; i++) assert.equal((await login('gerente.test', 'mala')).status, 401);

    const r = await login('gerente.test', CLAVE);
    assert.equal(r.status, 429);
    assert.match(r.body.error, /intentos fallidos/);
    assert.equal(await db.contar('finanzas.evento_auditoria', `accion_realizada = 'login'`), 0);
  });

  test('el bloqueo es de ese usuario: otro usuario sigue entrando', async () => {
    await conClave(1);
    await conClave(2);
    for (let i = 0; i < 5; i++) await login('gerente.test', 'mala');

    assert.equal((await login('jop.test', CLAVE)).status, 200);
  });

  test('no distingue mayúsculas: cambiar el usuario de forma no salta el bloqueo', async () => {
    await conClave(1);
    for (let i = 0; i < 5; i++) await login('gerente.test', 'mala');

    assert.equal((await login('GERENTE.TEST', 'mala')).status, 429);
  });

  test('un éxito antes del 5.º fallo limpia la cuenta del usuario', async () => {
    await conClave(1);
    for (let i = 0; i < 4; i++) await login('gerente.test', 'mala');
    assert.equal((await login('gerente.test', CLAVE)).status, 200);

    for (let i = 0; i < 4; i++) assert.equal((await login('gerente.test', 'mala')).status, 401);
    assert.equal((await login('gerente.test', CLAVE)).status, 200);
  });
});

describe('Límite por IP (S-03)', () => {
  test('30 fallos desde la misma IP la bloquean, también para un usuario sin fallos', async () => {
    await conClave(2);
    for (let i = 0; i < 30; i++) {
      assert.equal((await login(`no.existe.${i}`, 'mala')).status, 401);
    }

    const r = await login('jop.test', CLAVE);
    assert.equal(r.status, 429);
  });
});

describe('Cabeceras de seguridad de la API (S-05)', () => {
  test('nosniff, sin marcos, sin referer, sin caché y sin X-Powered-By', async () => {
    const res = await fetch((await levantar()) + '/api/health');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});
