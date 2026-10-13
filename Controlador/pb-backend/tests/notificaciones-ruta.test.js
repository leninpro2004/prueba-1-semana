const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');
const { crearNotificacion } = require('../src/controllers/notificacionesController');

/**
 * Destino de las notificaciones (B-06).
 *
 * Lo que se protege: toda notificación que crea el backend dice a qué pantalla lleva (la ruta se
 * guarda en notificacion_origen y el frontend la sigue tal cual), para que el clic en la campana
 * nunca quede sin efecto. Las únicas excepciones son las dos programaciones de cuentas, cuyo
 * mensaje es el dato que procesa B-04 y que el frontend ya lleva a Usuarios por su tipo.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const CONTROLLERS = path.join(__dirname, '..', 'src', 'controllers');
const SIN_RUTA = new Set(['programacion_desactivacion', 'programacion_activacion']);

/**
 * Cada llamada a notificarPorRol({...}) o crearNotificacion({...}) de los controllers, con su bloque de
 * opciones (hasta el "})" que abre una línea: un "})" dentro del mensaje, como `(${sku})`, no lo cierra).
 * notificacionesController.js se salta: ahí están las definiciones, no los avisos.
 */
function llamadasDelCodigo() {
  const llamadas = [];
  for (const archivo of fs.readdirSync(CONTROLLERS).filter(f => f.endsWith('.js') && f !== 'notificacionesController.js')) {
    const texto = fs.readFileSync(path.join(CONTROLLERS, archivo), 'utf8');
    const patron = /(?:notificarPorRol|crearNotificacion)\(\{/g;
    let m;
    while ((m = patron.exec(texto))) {
      const resto = texto.slice(m.index);
      const fin = resto.search(/\n\s*\}\)/);
      const bloque = fin >= 0 ? resto.slice(0, fin) : resto.slice(0, resto.indexOf('})'));
      const tipo = (/tipo:\s*['"]([a-z_]+)['"]/.exec(bloque) || [])[1] || '(tipo desconocido)';
      llamadas.push({ archivo, tipo, bloque });
    }
  }
  return llamadas;
}

describe('Toda notificación lleva su ruta', () => {
  test('cada notificarPorRol/crearNotificacion del backend pasa `ruta:` (salvo las programaciones)', () => {
    const llamadas = llamadasDelCodigo();
    assert.ok(llamadas.length >= 15, `se esperaban al menos 15 avisos y se encontraron ${llamadas.length}`);
    const sinRuta = llamadas
      .filter(l => !SIN_RUTA.has(l.tipo) && !/\bruta:/.test(l.bloque))
      .map(l => `${l.archivo}: ${l.tipo}`);
    assert.deepEqual(sinRuta, [], 'avisos sin ruta: el clic en la notificación no llevaría a ninguna parte');
  });
});

describe('crearNotificacion', () => {
  const origenDe = async () => (await db.query(
    `SELECT notificacion_origen AS o FROM inventario.notificacion ORDER BY notificacion_id_notificacion DESC LIMIT 1`
  )).rows[0].o;

  test('con ruta, la guarda en origen; sin ruta, conserva el origen', async () => {
    await crearNotificacion({ tipo: 'prueba', mensaje: 'm', origen: 'conteos', ruta: '/conteos/7/diferencias', usuarioIds: [1] });
    assert.equal(await origenDe(), '/conteos/7/diferencias');

    await crearNotificacion({ tipo: 'prueba', mensaje: 'm', origen: 'conteos', usuarioIds: [1] });
    assert.equal(await origenDe(), 'conteos');
  });
});

describe('Un aviso real', () => {
  test('el bloqueo de la firma de gerencia avisa a Gerencia con la ruta a la auditoría', async () => {
    await db.query(
      `INSERT INTO inventario.usuario_contrasena (usuario_id_usuario, usuario_contrasena) VALUES (1, $1)`,
      [await bcrypt.hash('clave-de-prueba', 4)]
    );
    for (let i = 0; i < 3; i++) {
      await api('POST', '/api/auth/reautenticar', {
        rol: 'jop', body: { username: 'gerente.test', password: 'mala', accion: 'movimiento_manual' },
      });
    }

    const { rows } = await db.query(
      `SELECT usuario_id_usuario::int AS usr, notificacion_origen AS ruta
       FROM inventario.notificacion WHERE notificacion_tipo_notificacion = 'seguridad'`
    );
    assert.deepEqual(rows, [{ usr: 1, ruta: '/usuarios?tab=auditoria' }]);
  });
});
