const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');
const { reiniciarLimitesLogin } = require('../src/controllers/authController');

/**
 * IP en la auditoría de seguridad (B-20).
 *
 * Lo que se protege: los eventos de seguridad (login exitoso y fallido, bloqueo del login, firma de
 * gerencia) quedan en la auditoría con la IP de origen; un login fallido queda registrado aunque el
 * usuario no exista, sin guardar más de 40 caracteres de lo escrito; y el bloqueo se registra una
 * sola vez. En los tests la IP es siempre la local (127.0.0.1, a veces como ::ffff:127.0.0.1).
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); reiniciarLimitesLogin(); });
after(async () => { await bajar(); await db.cerrar(); reiniciarLimitesLogin(); });

const CLAVE = 'clave-de-prueba';
const IP_LOCAL = /127\.0\.0\.1|::1/;

async function conClave(id = 1) {
  await db.query(
    `INSERT INTO inventario.usuario_contrasena (usuario_id_usuario, usuario_contrasena) VALUES ($1, $2)`,
    [id, await bcrypt.hash(CLAVE, 4)]
  );
}

const login = (username, password) =>
  api('POST', '/api/auth/login', { body: { username, password }, sinToken: true });

/** Eventos de una acción, del más antiguo al más nuevo. */
const eventos = async (accion) => (await db.query(
  `SELECT id_usuario::int AS usuario, registro_afectado AS detalle, observacion, ip_origen AS ip
   FROM finanzas.evento_auditoria WHERE accion_realizada = $1 ORDER BY id_evento`, [accion])).rows;

describe('Login', () => {
  test('el login exitoso guarda la IP', async () => {
    await conClave(1);
    assert.equal((await login('gerente.test', CLAVE)).status, 200);

    const [e] = await eventos('login');
    assert.equal(e.usuario, 1);
    assert.match(e.ip, IP_LOCAL);
  });

  test('contraseña incorrecta: login_fallido a nombre del usuario, con IP', async () => {
    await conClave(1);
    assert.equal((await login('gerente.test', 'mala')).status, 401);

    const [e] = await eventos('login_fallido');
    assert.equal(e.usuario, 1);
    assert.match(e.detalle, /gerente\.test/);
    assert.match(e.ip, IP_LOCAL);
  });

  test('usuario inexistente: a nombre del sistema (0) y lo escrito recortado a 40 caracteres', async () => {
    const escrito = 'x'.repeat(60);
    assert.equal((await login(escrito, 'mala')).status, 401);

    const [e] = await eventos('login_fallido');
    assert.equal(e.usuario, 0);
    assert.ok(e.detalle.includes('x'.repeat(40)) && !e.detalle.includes('x'.repeat(41)), e.detalle);
    assert.match(e.ip, IP_LOCAL);
  });

  test('el bloqueo queda una sola vez, en el fallo que completa el límite', async () => {
    await conClave(1);
    for (let i = 0; i < 4; i++) await login('gerente.test', 'mala');
    assert.equal((await eventos('bloqueo_login')).length, 0);

    await login('gerente.test', 'mala');                         // 5.º fallo: bloquea
    assert.equal((await login('gerente.test', 'mala')).status, 429);
    assert.equal((await login('gerente.test', CLAVE)).status, 429);

    const bloqueos = await eventos('bloqueo_login');
    assert.equal(bloqueos.length, 1);
    assert.equal(bloqueos[0].usuario, 1);
    assert.match(bloqueos[0].ip, IP_LOCAL);
    assert.equal((await eventos('login_fallido')).length, 5, 'los 429 no se auditan como fallos');
  });
});

describe('Firma de gerencia', () => {
  test('la firma queda con la IP de quien la pidió', async () => {
    await conClave(1);
    const f = await api('POST', '/api/auth/reautenticar', {
      rol: 'jop', body: { username: 'gerente.test', password: CLAVE, accion: 'movimiento_manual' },
    });
    assert.equal(f.status, 200, JSON.stringify(f.body));

    const [e] = await eventos('firma_gerencia');
    assert.equal(e.usuario, 2);
    assert.match(e.ip, IP_LOCAL);
  });
});

describe('Pantalla de auditoría', () => {
  test('GET /usuarios/auditoria devuelve la IP de los eventos de seguridad', async () => {
    await conClave(1);
    await login('gerente.test', CLAVE);

    const r = await api('GET', '/api/usuarios/auditoria?accion=login');
    assert.equal(r.status, 200);
    const fila = r.body.find(x => x.accion === 'login');
    assert.ok(fila, JSON.stringify(r.body));
    assert.match(fila.ip, IP_LOCAL);
  });
});
