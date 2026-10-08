const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');
const auditoria = require('../src/controllers/auditoriaController');
const { revisarVentas } = require('../src/controllers/insumosEspecialesController');

/**
 * D59: auditoría en finanzas.evento_auditoria (hasta el schema 4 común).
 *
 * Lo que protegen:
 *  - Ningún evento se pierde: un detalle de más de 100 caracteres se guarda completo en
 *    `observacion` (antes el INSERT fallaba en silencio), y una acción sin usuario queda a
 *    nombre del sistema (id_usuario = 0), que la pestaña Auditoría muestra como tal.
 *  - Las acciones automáticas se auditan solo si cambian algo: una revisión en vacío no escribe.
 *  - Las programaciones de cuentas aplicadas por el middleware quedan auditadas.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

async function eventos() {
  const { rows } = await db.query(
    `SELECT id_usuario::int AS usuario, accion_realizada AS accion, registro_afectado AS corto, observacion AS completo
     FROM finanzas.evento_auditoria ORDER BY id_evento`);
  return rows;
}

describe('registrar', () => {
  test('un detalle corto va en registro_afectado, sin observacion', async () => {
    await auditoria.registrar(1, 'accion_prueba', 'detalle corto');
    assert.deepEqual(await eventos(), [{ usuario: 1, accion: 'accion_prueba', corto: 'detalle corto', completo: null }]);
  });

  test('un detalle de más de 100 caracteres se guarda completo en observacion (antes se perdía)', async () => {
    const largo = 'x'.repeat(250);
    await auditoria.registrar(1, 'accion_prueba', largo);
    const [e] = await eventos();
    assert.equal(e.completo, largo);
    assert.equal(e.corto.length, 100);
    assert.ok(e.corto.endsWith('…'));
  });

  test('sin usuario se registra a nombre del sistema (id 0)', async () => {
    await auditoria.registrar(null, 'accion_prueba', 'automática');
    await auditoria.registrar(undefined, 'accion_prueba', 'automática');
    assert.deepEqual((await eventos()).map(e => e.usuario), [0, 0]);
  });

  test('la pestaña Auditoría muestra "Sistema (automático)" y el detalle completo', async () => {
    const largo = 'Detalle largo de inventario: ' + 'y'.repeat(120);
    await auditoria.registrar(null, 'accion_prueba', largo);
    const r = await api('GET', '/api/usuarios/auditoria?accion=accion_prueba');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.length, 1);
    assert.equal(r.body[0].usuario, 'Sistema (automático)');
    assert.equal(r.body[0].detalle, largo);
  });
});

describe('acciones automáticas', () => {
  test('una revisión de insumos especiales que no cambia nada no escribe en la auditoría', async () => {
    const r = await revisarVentas();          // sin ventas: nada que alertar
    assert.equal(r.nuevas, 0);
    assert.deepEqual(await eventos(), []);
  });

  test('la revisión del timer (sin usuario) que crea una alerta se audita a nombre del sistema', async () => {
    await db.query(`UPDATE inventario.material SET material_es_rotativo = FALSE WHERE material_sku = 'MAT-UNO'`);
    await db.query(`INSERT INTO finanzas.tipo_cliente (id_tipo_cliente, nombre_tipo_cliente) OVERRIDING SYSTEM VALUE VALUES (1, 'empresa')`);
    await db.query(`INSERT INTO finanzas.cliente_financiero (id_cliente_financiero, rut_cliente, id_tipo_cliente, nombre_razon_social)
                    OVERRIDING SYSTEM VALUE VALUES (1, '11111111-1', 1, 'Cliente de prueba')`);
    await db.query(`INSERT INTO finanzas.nota_venta (id_nota_venta, numero_nota_venta, id_cliente_financiero, fecha_emision, estado_pedido)
                    OVERRIDING SYSTEM VALUE VALUES (1, 'NV-T1', 1, CURRENT_DATE, 'aprobada')`);
    await db.query(`INSERT INTO finanzas.item_nota_venta (id_nota_venta, sku_material, descripcion_item, cantidad, precio_unitario)
                    VALUES (1, 'MAT-UNO', 'línea de prueba', 1, 1000)`);
    const r = await revisarVentas();
    assert.equal(r.nuevas, 1);
    assert.deepEqual((await eventos()).map(e => [e.usuario, e.accion]), [[0, 'alerta_insumo_especial']]);

    await revisarVentas();                    // la segunda no cambia nada: no escribe
    assert.equal((await eventos()).length, 1);
  });

  test('generar alertas (lo llaman el Dashboard y Alertas al abrirse) solo se audita si generó alguna', async () => {
    const r1 = await api('POST', '/api/alertas/generar');
    assert.equal(r1.status, 200);
    await db.query(`UPDATE inventario.alerta_inventario SET alerta_inventario_estado = 'resuelta'`);
    await db.query(`UPDATE inventario.material SET material_stock_minimo = 1000 WHERE material_sku = 'MAT-FIFO'`);
    const r2 = await api('POST', '/api/alertas/generar');
    assert.ok(r2.body.total > 0, JSON.stringify(r2.body));
    const r3 = await api('POST', '/api/alertas/generar');   // ya existen: no genera de nuevo
    assert.equal(r3.body.total, 0);
    const audit = (await eventos()).filter(e => e.accion === 'generar_alertas');
    assert.equal(audit.length, r1.body.total > 0 ? 2 : 1);
    assert.ok(audit.every(e => e.usuario === 0), 'a nombre del sistema');
  });

  test('una desactivación programada aplicada por el middleware queda auditada a nombre del sistema', async () => {
    await db.query(`UPDATE inventario.usuario SET usuario_desactivacion_programada = now() - INTERVAL '1 minute'
                    WHERE usuario_id_usuario = 2`);
    const r = await api('GET', '/api/materiales', { rol: 'jop' });
    assert.equal(r.status, 401);
    const [e] = await eventos();
    assert.deepEqual([e.usuario, e.accion], [0, 'programacion_ejecutada']);
    assert.match(e.corto, /jop\.test \(ID 2\) desactivado automáticamente/);
  });

  test('una activación programada aplicada por el middleware queda auditada a nombre del sistema', async () => {
    await db.query(`UPDATE inventario.usuario SET usuario_estado_cuenta = 'inactivo',
                      usuario_activacion_programada = now() - INTERVAL '1 minute' WHERE usuario_id_usuario = 2`);
    const r = await api('GET', '/api/materiales', { rol: 'jop' });
    assert.equal(r.status, 200);
    const [e] = await eventos();
    assert.deepEqual([e.usuario, e.accion], [0, 'programacion_ejecutada']);
    assert.match(e.corto, /activado automáticamente/);
  });
});
