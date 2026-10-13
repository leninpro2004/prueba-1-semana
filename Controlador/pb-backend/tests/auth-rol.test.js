const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { api, bajar, levantar, token } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * El rol sale de la BD, no del token ni del navegador (B-01).
 *
 * Lo que se protege: un token que dice otro rol no da sus permisos, un cambio de rol
 * en la BD corre desde el request siguiente (sin esperar a que venza el token) y
 * /auth/me entrega el usuario según la BD, que es lo único que el frontend guarda en memoria.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

/** Token firmado a mano: el usuario `id` dice tener el rol `rol`. */
const tokenQueDice = (id, rol) =>
  jwt.sign({ id, username: 'quien-sea', rol }, process.env.JWT_SECRET, { expiresIn: '5m' });

async function get(ruta, tk) {
  const base = await levantar();
  const r = await fetch(base + ruta, tk ? { headers: { Authorization: `Bearer ${tk}` } } : {});
  return { status: r.status, body: await r.json().catch(() => null) };
}

const cambiarRol = (id, { gerencia = false, jop = false }) => db.query(
  `UPDATE inventario.usuario SET usuario_es_gerencia = $2, usuario_es_jop = $3 WHERE usuario_id_usuario = $1`,
  [id, gerencia, jop]
);

describe('el token no decide el rol', () => {
  test('un jop con un token que dice "gerencia" no entra a una ruta de gerencia', async () => {
    const r = await get('/api/usuarios', tokenQueDice(2, 'gerencia'));
    assert.equal(r.status, 403);
  });

  test('ni ve los montos que se ocultan a jop', async () => {
    await db.query(
      `INSERT INTO inventario.factura_compra (factura_compra_numero_factura, factura_compra_monto_neto,
         factura_compra_fecha_emision, proveedor_id_proveedor)
       VALUES ('FAC-ROL-1', 54321, '2026-06-01', 1)`
    );
    // Control: el gerente de verdad sí ve el monto
    assert.match(JSON.stringify((await api('GET', '/api/facturas')).body), /54321/);

    const r = await get('/api/facturas', tokenQueDice(2, 'gerencia'));
    assert.equal(r.status, 200);
    assert.doesNotMatch(JSON.stringify(r.body), /54321/);
  });
});

describe('un cambio de rol corre desde el request siguiente', () => {
  test('degradar a un gerente le quita el acceso sin nuevo login', async () => {
    const tk = token('gerencia');
    assert.equal((await get('/api/usuarios', tk)).status, 200);

    await cambiarRol(1, { jop: true });

    assert.equal((await get('/api/usuarios', tk)).status, 403);
  });

  test('ascender a un jop le da el acceso sin nuevo login', async () => {
    const tk = token('jop');
    assert.equal((await get('/api/usuarios', tk)).status, 403);

    await cambiarRol(2, { gerencia: true });

    assert.equal((await get('/api/usuarios', tk)).status, 200);
  });
});

describe('GET /auth/me', () => {
  test('sin token → 401', async () => {
    assert.equal((await get('/api/auth/me')).status, 401);
  });

  test('devuelve el usuario y el rol de la BD, no los del token', async () => {
    const r = await get('/api/auth/me', tokenQueDice(2, 'gerencia'));
    assert.equal(r.status, 200);
    assert.equal(r.body.id, 2);
    assert.equal(r.body.username, 'jop.test');
    assert.equal(r.body.rol, 'jop');
    assert.equal(r.body.requiere_cambio_password, undefined);
  });

  test('marca el cambio obligatorio si la contraseña es temporal', async () => {
    await db.query(
      `INSERT INTO inventario.usuario_contrasena (usuario_id_usuario, usuario_contrasena, es_temporal)
       VALUES (3, 'hash', TRUE)`
    );
    const r = await api('GET', '/api/auth/me', { rol: 'tecnico' });
    assert.equal(r.body.rol, 'tecnico');
    assert.equal(r.body.requiere_cambio_password, true);
  });
});

test('session-status trae el rol actual', async () => {
  const tk = token('gerencia');
  assert.equal((await get('/api/auth/session-status', tk)).body.rol, 'gerencia');

  await cambiarRol(1, { jop: true });

  assert.equal((await get('/api/auth/session-status', tk)).body.rol, 'jop');
});
