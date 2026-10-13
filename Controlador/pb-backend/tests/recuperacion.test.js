const { test, before, after, beforeEach, afterEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { api, bajar, levantar } = require('./helpers/api');
const db = require('./helpers/db');
const { recuperarAcceso } = require('../scripts/recuperarAcceso');

/**
 * Recuperación de contraseña (B-02, D80).
 *
 * Lo que se protege: con el autoservicio apagado (el valor por defecto) ninguna
 * respuesta pública entrega un token ni permite cambiar una contraseña; un token
 * de recuperación nunca sirve como sesión; y la recuperación desde el servidor
 * deja una clave temporal que obliga a cambiarla, también para gerencia.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); delete process.env.RECUPERACION_AUTOSERVICIO; });
afterEach(() => { delete process.env.RECUPERACION_AUTOSERVICIO; });
after(async () => { await bajar(); await db.cerrar(); });

const CLAVE = 'clave-de-prueba';

/** Contraseña conocida para el gerente de la semilla (usuario 1). */
async function conClave(id = 1, clave = CLAVE) {
  await db.query(
    `INSERT INTO inventario.usuario_contrasena (usuario_id_usuario, usuario_contrasena) VALUES ($1, $2)`,
    [id, await bcrypt.hash(clave, 4)]
  );
}

const hashDe = async (id) => (await db.query(
  `SELECT usuario_contrasena AS h FROM inventario.usuario_contrasena WHERE usuario_id_usuario = $1`, [id]
)).rows[0]?.h;

const tokenRecuperacion = (extra = {}, opciones = { expiresIn: '30m' }) =>
  jwt.sign({ id: 1, tipo: 'recuperacion', ...extra }, process.env.JWT_SECRET, opciones);

const solicitar = (username) =>
  api('POST', '/api/auth/solicitar-recuperacion', { body: { username }, sinToken: true });
const resetear = (token, password_nueva = 'nueva-clave-123') =>
  api('POST', '/api/auth/resetear-password', { body: { token, password_nueva }, sinToken: true });
const login = (username, password) =>
  api('POST', '/api/auth/login', { body: { username, password }, sinToken: true });

describe('autoservicio apagado (por defecto)', () => {
  test('solicitar no entrega token y responde igual exista o no el usuario', async () => {
    await conClave();
    const existe = await solicitar('gerente.test');
    const noExiste = await solicitar('nadie.aqui');

    assert.equal(existe.status, 200);
    assert.equal(existe.body.autoservicio, false);
    assert.deepEqual(existe.body, noExiste.body);
    assert.doesNotMatch(JSON.stringify(existe.body), /eyJ/, 'ninguna respuesta pública lleva un JWT');
    assert.equal(await db.contar('finanzas.evento_auditoria', `accion_realizada = 'solicitar_recuperacion'`), 0);
  });

  test('resetear rechaza un token válido y no cambia la contraseña', async () => {
    await conClave();
    const antes = await hashDe(1);

    const r = await resetear(tokenRecuperacion());

    assert.equal(r.status, 400);
    assert.equal(await hashDe(1), antes);
  });

  test('resetear con un token vencido no regenera otro', async () => {
    await conClave();
    const vencido = tokenRecuperacion({ exp: Math.floor(Date.now() / 1000) - 60 }, {});

    const r = await resetear(vencido);

    assert.equal(r.status, 400);
    assert.equal(r.body.token_regenerado, undefined);
  });
});

test('un token de recuperación no sirve como sesión', async () => {
  const base = await levantar();
  const res = await fetch(base + '/api/materiales', {
    headers: { Authorization: `Bearer ${tokenRecuperacion()}` },
  });
  assert.equal(res.status, 401);
});

test('autoservicio encendido (solo desarrollo): el flujo con token sigue funcionando', async () => {
  process.env.RECUPERACION_AUTOSERVICIO = 'true';
  await conClave();

  const s = await solicitar('gerente.test');
  assert.equal(s.status, 200);
  assert.ok(s.body.token_recuperacion);

  const r = await resetear(s.body.token_recuperacion, 'otra-clave-456');
  assert.equal(r.status, 200);
  assert.equal((await login('gerente.test', 'otra-clave-456')).status, 200);
});

describe('recuperación desde el servidor', () => {
  test('a un gerente le deja una clave temporal que obliga a cambiarla', async () => {
    await conClave();

    const r = await recuperarAcceso('gerente.test');

    assert.equal(r.username, 'gerente.test');
    assert.equal(r.es_gerencia, true);
    assert.equal((await login('gerente.test', CLAVE)).status, 401, 'la clave anterior deja de servir');
    const nuevo = await login('gerente.test', r.clave);
    assert.equal(nuevo.status, 200);
    assert.equal(nuevo.body.requiere_cambio_password, true);
    assert.equal(await db.contar('finanzas.evento_auditoria',
      `accion_realizada = 'recuperar_acceso_servidor' AND id_usuario = 0`), 1);
  });

  test('crea la contraseña si el usuario no tenía y acepta el correo', async () => {
    await db.query(`UPDATE inventario.usuario SET usuario_correo = 'jop@test.cl' WHERE usuario_id_usuario = 2`);

    const r = await recuperarAcceso('jop@test.cl');

    assert.equal(r.username, 'jop.test');
    assert.equal((await login('jop.test', r.clave)).status, 200);
  });

  test('un usuario inexistente no cambia nada', async () => {
    await assert.rejects(recuperarAcceso('nadie.aqui'), /No existe/);
    assert.equal(await db.contar('inventario.usuario_contrasena'), 0);
  });
});
