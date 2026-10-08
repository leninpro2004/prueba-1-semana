const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * CU-108: reglas de integración entre módulos sobre perfil_permiso (V1).
 *
 * Lo que protegen: una regla = (módulo, perfil) con sus tipos; cada tipo es una
 * fila de perfil_permiso que NUNCA se borra (desactivar = activo FALSE); no se
 * duplica una regla activa sin confirmar (Exc 2); desactivar la última regla de
 * un módulo con movimientos recientes pide confirmación (Exc 3).
 *
 * Semilla: perfiles 1 gerencia, 2 jop, 3 bodeguero (sin usuarios).
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const RUTA = '/api/integracion/reglas';
const JOP = 2;
const GERENCIA = 1;

/** Filas de perfil_permiso de las reglas de integración, para ver que nada se borra. */
async function filas() {
  const { rows } = await db.query(
    `SELECT pp.perfil_id_perfil::int AS perfil, p.permiso_accion AS accion, pp.perfil_permiso_activo AS activo
     FROM inventario.perfil_permiso pp JOIN inventario.permiso p USING (permiso_id_permiso)
     WHERE p.permiso_modulo = 'inventario' AND p.permiso_accion LIKE '%desde%'
     ORDER BY 1, 2`
  );
  return rows;
}

async function auditorias() {
  return db.contar('finanzas.evento_auditoria', `accion_realizada = 'Integración entre módulos'`);
}

/** Un movimiento registrado desde otro módulo (lo que CU-107 hará), para la Exc 3. */
async function movimientoDesde(modulo, diasAtras = 0) {
  await db.query(
    `INSERT INTO inventario.movimiento_inventario
       (movimiento_inventario_fecha_hora, movimiento_inventario_cantidad, movimiento_inventario_estado,
        material_sku, usuario_id_usuario, movimiento_inventario_tipo_movimiento_id_tipo_movimiento,
        movimiento_inventario_modulo_origen)
     VALUES (now() - make_interval(days => $2), 1, 'completado', 'MAT-FIFO', 1, 2, $1)`,
    [modulo, diasAtras]
  );
}

describe('Consulta', () => {
  test('sin reglas: tabla vacía, con las opciones del formulario (Exc 1)', async () => {
    const r = await api('GET', RUTA);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.reglas, []);
    assert.deepEqual(r.body.modulos.map(m => m.valor), ['terreno', 'finanzas']);
    assert.deepEqual(r.body.tipos, ['entrada', 'salida']);
    const porNombre = Object.fromEntries(r.body.perfiles.map(p => [p.nombre, p.usuarios]));
    assert.deepEqual(porNombre, { bodeguero: 0, gerencia: 1, jop: 1 });
  });

  test('jop no puede ver ni configurar reglas', async () => {
    assert.equal((await api('GET', RUTA, { rol: 'jop' })).status, 403);
    const r = await api('POST', RUTA, { rol: 'jop', body: { modulo: 'terreno', perfil_id: JOP, tipos: ['salida'] } });
    assert.equal(r.status, 403);
    assert.deepEqual(await filas(), []);
  });
});

describe('Crear (POST)', () => {
  test('crea los permisos y una fila de perfil_permiso por tipo, y audita', async () => {
    const r = await api('POST', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: ['salida', 'entrada'] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await filas(), [
      { perfil: JOP, accion: 'entrada_desde_terreno', activo: true },
      { perfil: JOP, accion: 'salida_desde_terreno', activo: true },
    ]);
    assert.deepEqual(r.body.reglas, [{
      modulo: 'terreno', modulo_nombre: 'Terreno', perfil_id: JOP, perfil: 'jop', tipos: ['entrada', 'salida'], activa: true,
    }]);
    assert.equal(await auditorias(), 1);
  });

  test('un segundo perfil reutiliza el mismo permiso (no lo duplica)', async () => {
    await api('POST', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: ['salida'] } });
    await api('POST', RUTA, { body: { modulo: 'terreno', perfil_id: GERENCIA, tipos: ['salida'] } });
    assert.equal(await db.contar('inventario.permiso', `permiso_accion = 'salida_desde_terreno'`), 1);
    assert.equal((await filas()).length, 2);
  });

  test('Exc 2: regla activa para el mismo módulo y rol → 409 con la vigente, sin cambios', async () => {
    await api('POST', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: ['salida'] } });
    const r = await api('POST', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: ['entrada'] } });
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'REGLA_EXISTENTE');
    assert.deepEqual(r.body.regla.tipos, ['salida']);
    assert.deepEqual(await filas(), [{ perfil: JOP, accion: 'salida_desde_terreno', activo: true }]);
    assert.equal(await auditorias(), 1);
  });

  test('Exc 2: con actualizar=true reemplaza los tipos; el que sale queda inactivo, no se borra', async () => {
    await api('POST', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: ['salida'] } });
    const r = await api('POST', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: ['entrada'], actualizar: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await filas(), [
      { perfil: JOP, accion: 'entrada_desde_terreno', activo: true },
      { perfil: JOP, accion: 'salida_desde_terreno', activo: false },
    ]);
  });

  test('el mismo rol en otro módulo es otra regla (no es Exc 2)', async () => {
    await api('POST', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: ['salida'] } });
    const r = await api('POST', RUTA, { body: { modulo: 'finanzas', perfil_id: JOP, tipos: ['salida'] } });
    assert.equal(r.status, 200);
    assert.equal(r.body.reglas.length, 2);
  });

  test('validaciones: módulo, rol, tipos → 400 sin escribir nada', async () => {
    const casos = [
      { modulo: 'produccion', perfil_id: JOP, tipos: ['salida'] },
      { modulo: 'terreno', perfil_id: 999, tipos: ['salida'] },
      { modulo: 'terreno', perfil_id: 'x', tipos: ['salida'] },
      { modulo: 'terreno', perfil_id: JOP, tipos: [] },
      { modulo: 'terreno', perfil_id: JOP, tipos: ['ajuste'] },
      { modulo: 'terreno', perfil_id: JOP },
    ];
    for (const body of casos) {
      const r = await api('POST', RUTA, { body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.body.error);
    }
    assert.deepEqual(await filas(), []);
    assert.equal(await db.contar('inventario.permiso'), 0);
  });
});

describe('Modificar y desactivar (PUT)', () => {
  test('desactivar deja las filas en FALSE; reactivar las vuelve a TRUE', async () => {
    await api('POST', RUTA, { body: { modulo: 'finanzas', perfil_id: JOP, tipos: ['entrada', 'salida'] } });
    let r = await api('PUT', RUTA, { body: { modulo: 'finanzas', perfil_id: JOP, tipos: [] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reglas[0].activa, false);
    assert.ok((await filas()).every(f => !f.activo));
    assert.equal((await filas()).length, 2);

    r = await api('PUT', RUTA, { body: { modulo: 'finanzas', perfil_id: JOP, tipos: ['salida'] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.reglas[0].tipos, ['salida']);
  });

  test('una regla que no existe → 404', async () => {
    const r = await api('PUT', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: [] } });
    assert.equal(r.status, 404);
  });

  test('sin cambios: responde bien y no audita', async () => {
    await api('POST', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: ['salida'] } });
    const r = await api('PUT', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: ['salida'] } });
    assert.equal(r.status, 200);
    assert.equal(await auditorias(), 1);
  });

  test('Exc 3: última regla activa con movimientos recientes → 409; con confirmar se desactiva', async () => {
    await api('POST', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: ['salida'] } });
    await movimientoDesde('terreno', 2);

    let r = await api('PUT', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: [] } });
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'OPERACIONES_EN_CURSO');
    assert.equal(r.body.operaciones.movimientos, 1);
    assert.deepEqual(await filas(), [{ perfil: JOP, accion: 'salida_desde_terreno', activo: true }]);

    r = await api('PUT', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: [], confirmar: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(await filas(), [{ perfil: JOP, accion: 'salida_desde_terreno', activo: false }]);
  });

  test('Exc 3 no aplica: otra regla activa del módulo, movimientos antiguos o de otro módulo', async () => {
    await api('POST', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: ['salida'] } });
    await api('POST', RUTA, { body: { modulo: 'terreno', perfil_id: GERENCIA, tipos: ['salida'] } });
    await movimientoDesde('terreno', 45);
    await movimientoDesde('finanzas', 1);
    // Queda la de gerencia activa
    assert.equal((await api('PUT', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: [] } })).status, 200);
    // Última de terreno, pero el único movimiento de terreno tiene 45 días
    assert.equal((await api('PUT', RUTA, { body: { modulo: 'terreno', perfil_id: GERENCIA, tipos: [] } })).status, 200);
  });

  test('eliminar: borra las filas de la regla, deja el permiso en el catálogo y audita', async () => {
    await api('POST', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: ['salida'] } });
    await api('POST', RUTA, { body: { modulo: 'terreno', perfil_id: GERENCIA, tipos: ['salida'] } });
    const r = await api('DELETE', RUTA, { body: { modulo: 'terreno', perfil_id: JOP } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await filas(), [{ perfil: GERENCIA, accion: 'salida_desde_terreno', activo: true }]);
    assert.equal(await db.contar('inventario.permiso', `permiso_accion = 'salida_desde_terreno'`), 1);
    assert.equal(await auditorias(), 3);
    assert.equal((await api('DELETE', RUTA, { body: { modulo: 'terreno', perfil_id: JOP } })).status, 404);
  });

  test('eliminar la última regla activa con movimientos recientes pide confirmación (Exc 3); una inactiva no', async () => {
    await api('POST', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: ['salida'] } });
    await movimientoDesde('terreno', 1);
    let r = await api('DELETE', RUTA, { body: { modulo: 'terreno', perfil_id: JOP } });
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'OPERACIONES_EN_CURSO');
    assert.equal((await filas()).length, 1);
    r = await api('DELETE', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, confirmar: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(await filas(), []);

    await api('POST', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: ['salida'] } });
    await api('PUT', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: [], confirmar: true } });
    assert.equal((await api('DELETE', RUTA, { body: { modulo: 'terreno', perfil_id: JOP } })).status, 200);
  });

  test('jop no puede eliminar reglas', async () => {
    await api('POST', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: ['salida'] } });
    assert.equal((await api('DELETE', RUTA, { rol: 'jop', body: { modulo: 'terreno', perfil_id: JOP } })).status, 403);
    assert.equal((await filas()).length, 1);
  });

  test('quitar un tipo sin desactivar la regla no pide confirmación (no es Exc 3)', async () => {
    await api('POST', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: ['entrada', 'salida'] } });
    await movimientoDesde('terreno', 1);
    const r = await api('PUT', RUTA, { body: { modulo: 'terreno', perfil_id: JOP, tipos: ['salida'] } });
    assert.equal(r.status, 200);
  });
});
