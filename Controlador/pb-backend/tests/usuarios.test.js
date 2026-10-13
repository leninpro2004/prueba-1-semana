const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');
const { aplicarProgramaciones } = require('../src/controllers/usuariosController');

/**
 * Gestion de usuarios (pantalla Usuarios, solo gerencia).
 *
 * Lo que protegen:
 *  - D68: la cuenta solo guarda 'activo' o 'inactivo'. La pantalla mandaba 'activa' y el
 *    filtro "Activos" escondia a los usuarios guardados como 'activo'. Se acepta la forma
 *    femenina en la entrada, pero se guarda la masculina, y el CHECK del DDL rechaza otra.
 *
 * Semilla: gerente.test (id 1) y jop.test (id 2), los dos 'activo'.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const estadoDe = async (username) => {
  const { rows } = await db.query(
    `SELECT usuario_estado_cuenta AS estado FROM inventario.usuario WHERE usuario_username = $1`, [username]
  );
  return rows[0]?.estado;
};

const crear = (extra = {}) => api('POST', '/api/usuarios', {
  body: { username: 'nuevo.test', password: 'Clave12345', nombre: 'Nuevo', apellido: 'Test', rol: 'jop', ...extra },
});

describe('D68: estado de la cuenta', () => {
  test('crear sin estado guarda activo', async () => {
    const r = await crear();
    assert.equal(r.status, 201);
    assert.equal(await estadoDe('nuevo.test'), 'activo');
  });

  test('crear con "activa" guarda activo', async () => {
    const r = await crear({ estado: 'activa' });
    assert.equal(r.status, 201);
    assert.equal(await estadoDe('nuevo.test'), 'activo');
  });

  test('crear con un estado desconocido → 400 y no crea el usuario', async () => {
    const r = await crear({ estado: 'suspendido' });
    assert.equal(r.status, 400);
    assert.equal(await estadoDe('nuevo.test'), undefined);
  });

  test('editar con "inactiva" y luego "activa" guarda inactivo y activo', async () => {
    const { body } = await crear();
    let r = await api('PUT', `/api/usuarios/${body.id}/permisos`, { body: { rol: 'jop', estado: 'inactiva' } });
    assert.equal(r.status, 200);
    assert.equal(await estadoDe('nuevo.test'), 'inactivo');

    r = await api('PUT', `/api/usuarios/${body.id}/permisos`, { body: { rol: 'jop', estado: 'activa' } });
    assert.equal(r.status, 200);
    assert.equal(await estadoDe('nuevo.test'), 'activo');
  });

  test('editar con un estado desconocido → 400 y no cambia nada', async () => {
    const r = await api('PUT', '/api/usuarios/2/permisos', { body: { rol: 'jop', estado: 'suspendido' } });
    assert.equal(r.status, 400);
    assert.equal(await estadoDe('jop.test'), 'activo');
  });

  test('el filtro de activos trae a todos los activos, se pida "activo" o "activa"', async () => {
    await db.query(`UPDATE inventario.usuario SET usuario_estado_cuenta = 'inactivo' WHERE usuario_id_usuario = 2`);
    for (const estado of ['activo', 'activa']) {
      const r = await api('GET', `/api/usuarios?estado=${estado}`);
      assert.equal(r.status, 200);
      // B-01: la semilla tiene un usuario por rol; todos activos salvo el jop desactivado arriba
      assert.deepEqual(r.body.map(u => u.username).sort(),
        ['admin.test', 'gerente.test', 'secretaria.test', 'tecnico.test']);
    }
    const r = await api('GET', '/api/usuarios?estado=inactivo');
    assert.deepEqual(r.body.map(u => u.username), ['jop.test']);
  });

  test('la BD rechaza un estado fuera de activo / inactivo', async () => {
    await assert.rejects(
      db.query(`UPDATE inventario.usuario SET usuario_estado_cuenta = 'activa' WHERE usuario_id_usuario = 2`),
      /ck_usuario_estado_cuenta/
    );
  });
});

describe('editar permisos sin rol', () => {
  const rolesDe = async (id) => {
    const { rows } = await db.query(
      `SELECT usuario_es_gerencia AS gerencia, usuario_es_jop AS jop FROM inventario.usuario WHERE usuario_id_usuario = $1`, [id]
    );
    return rows[0];
  };

  test('solo con estado conserva el rol del unico gerente', async () => {
    const r = await api('PUT', '/api/usuarios/1/permisos', { body: { estado: 'activo' } });
    assert.equal(r.status, 200);
    assert.deepEqual(await rolesDe(1), { gerencia: true, jop: false });
  });

  test('solo con estado conserva el rol de un gerente que se desactiva', async () => {
    // Usuario nuevo: jop.test tiene OT abiertas en la semilla y no se puede desactivar
    const { body } = await crear({ rol: 'gerencia' });
    const r = await api('PUT', `/api/usuarios/${body.id}/permisos`, { body: { estado: 'inactivo' } });
    assert.equal(r.status, 200);
    assert.deepEqual(await rolesDe(body.id), { gerencia: true, jop: false });
    assert.equal(await estadoDe('nuevo.test'), 'inactivo');
  });
});

/**
 * B-04: las programaciones de cuentas las aplica el backend (timer de 1 minuto en index.js, que
 * en los tests no corre: aquí se llama a aplicarProgramaciones directamente), y la lista muestra
 * el estado efectivo aunque el timer todavía no haya pasado.
 */
describe('Programaciones de cuentas (B-04)', () => {
  const programar = (username, columna, intervalo) => db.query(
    `UPDATE inventario.usuario SET ${columna} = now() + $2::interval WHERE usuario_username = $1`, [username, intervalo]);

  test('la lista muestra inactiva una cuenta con la desactivación vencida, también al filtrar', async () => {
    await programar('jop.test', 'usuario_desactivacion_programada', '-1 minute');
    const r = await api('GET', '/api/usuarios');
    assert.equal(r.body.find(u => u.username === 'jop.test').estado, 'inactivo');
    const inactivos = await api('GET', '/api/usuarios?estado=inactivo');
    assert.ok(inactivos.body.some(u => u.username === 'jop.test'));
    assert.equal(await estadoDe('jop.test'), 'activo', 'la lista no escribe: eso lo hace el timer');
  });

  test('aplicarProgramaciones desactiva y activa las vencidas, limpia la programación, notifica y audita', async () => {
    await programar('jop.test', 'usuario_desactivacion_programada', '-1 minute');
    await db.query(`UPDATE inventario.usuario SET usuario_estado_cuenta = 'inactivo' WHERE usuario_username = 'tecnico.test'`);
    await programar('tecnico.test', 'usuario_activacion_programada', '-1 minute');

    const r = await aplicarProgramaciones();
    assert.deepEqual([r.desactivados, r.activados], [['jop.test'], ['tecnico.test']]);
    assert.equal(await estadoDe('jop.test'), 'inactivo');
    assert.equal(await estadoDe('tecnico.test'), 'activo');
    assert.equal(await db.contar('inventario.usuario',
      `usuario_desactivacion_programada IS NOT NULL OR usuario_activacion_programada IS NOT NULL`), 0);
    assert.ok(await db.contar('inventario.notificacion', `notificacion_tipo_notificacion = 'programacion_ejecutada'`) >= 2);
    assert.equal(await db.contar('finanzas.evento_auditoria', `accion_realizada = 'programacion_ejecutada'`), 2);
  });

  test('una programación futura no se aplica ni cambia la lista', async () => {
    await programar('jop.test', 'usuario_desactivacion_programada', '1 hour');
    assert.equal((await aplicarProgramaciones()).procesadas, 0);
    assert.equal(await estadoDe('jop.test'), 'activo');
    const r = await api('GET', '/api/usuarios');
    assert.equal(r.body.find(u => u.username === 'jop.test').estado, 'activo');
  });
});

/**
 * B-19: los 5 roles. La lista mostraba "otro" (y el modal, "Gerencia") para técnico, administrador y
 * secretaria, y cambiar un técnico a jop no tenía efecto: solo se tocaban las marcas de gerencia y jop.
 * Semilla: un usuario por rol (1 gerente.test, 2 jop.test, 3 tecnico.test, 4 secretaria.test, 5 admin.test).
 */
describe('Los 5 roles (B-19)', () => {
  const marcas = async (id) => {
    const { rows } = await db.query(
      `SELECT usuario_es_gerencia AS gerencia, usuario_es_jop AS jop, usuario_es_tecnico AS tecnico,
              usuario_es_administrador AS administrador, usuario_es_secretaria AS secretaria
       FROM inventario.usuario WHERE usuario_id_usuario = $1`, [id]);
    return Object.entries(rows[0]).filter(([, v]) => v).map(([k]) => k);
  };
  const rolEnLista = async (username) => (await api('GET', '/api/usuarios')).body.find(u => u.username === username)?.rol;

  test('la lista muestra el rol real de cada uno y filtra por cualquiera de los 5', async () => {
    const r = await api('GET', '/api/usuarios');
    const porUsuario = Object.fromEntries(r.body.map(u => [u.username, u.rol]));
    assert.deepEqual(
      ['gerente.test', 'jop.test', 'tecnico.test', 'secretaria.test', 'admin.test'].map(u => porUsuario[u]),
      ['gerencia', 'jop', 'tecnico', 'secretaria', 'administrador']);
    const tecnicos = await api('GET', '/api/usuarios?rol=tecnico');
    assert.deepEqual(tecnicos.body.map(u => u.username), ['tecnico.test']);
  });

  test('cambiar un técnico a jop deja una sola marca y su rol pasa a jop; y de vuelta', async () => {
    assert.equal((await api('PUT', '/api/usuarios/3/permisos', { body: { rol: 'jop' } })).status, 200);
    assert.deepEqual(await marcas(3), ['jop']);
    assert.equal(await rolEnLista('tecnico.test'), 'jop');

    assert.equal((await api('PUT', '/api/usuarios/3/permisos', { body: { rol: 'tecnico' } })).status, 200);
    assert.deepEqual(await marcas(3), ['tecnico']);
  });

  test('un rol desconocido → 400 al editar y al crear, sin cambiar nada', async () => {
    const r = await api('PUT', '/api/usuarios/3/permisos', { body: { rol: 'otro' } });
    assert.equal(r.status, 400);
    assert.deepEqual(await marcas(3), ['tecnico']);
    assert.equal((await crear({ rol: 'otro' })).status, 400);
    assert.equal(await db.contar('inventario.usuario', `usuario_username = 'nuevo.test'`), 0);
  });

  test('crear con un rol que no es gerencia ni jop lo asigna', async () => {
    const r = await crear({ rol: 'secretaria' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(await marcas(r.body.id), ['secretaria']);
  });

  test('la regla del último gerente sigue: no se le puede pasar a otro rol', async () => {
    const r = await api('PUT', '/api/usuarios/1/permisos', { body: { rol: 'administrador' } });
    assert.equal(r.status, 400);
    assert.deepEqual(await marcas(1), ['gerencia']);
  });
});
