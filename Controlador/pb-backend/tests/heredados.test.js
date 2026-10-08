const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * Sesión 15, hallazgos heredados (punto 21).
 *  - cambiar-password con la clave actual incorrecta responde 400, no 401: el frontend
 *    cierra la sesión ante un 401, y un error de tipeo no debe sacar al usuario.
 *  - Una stock_critico de CU-47 de un producto SIN stock_minimo se resuelve sola cuando
 *    vuelve el stock disponible (el generador no la evaluaba y quedaba activa).
 *
 * Semilla: MAT-UNO sin stock_minimo, 1 disponible en la bodega 1. Tipo 2 = stock_critico.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

test('cambiar la contraseña con la actual incorrecta → 400 (no cierra la sesión); con la correcta → 200', async () => {
  await db.query(`INSERT INTO inventario.usuario_contrasena (usuario_id_usuario, usuario_contrasena) VALUES (1, $1)`,
    [await bcrypt.hash('clave-actual', 4)]);
  const mal = await api('POST', '/api/auth/cambiar-password', { body: { password_actual: 'otra', password_nueva: 'nueva-clave-1' } });
  assert.equal(mal.status, 400);
  assert.match(mal.body.error, /incorrecta/);
  const bien = await api('POST', '/api/auth/cambiar-password', { body: { password_actual: 'clave-actual', password_nueva: 'nueva-clave-1' } });
  assert.equal(bien.status, 200);
});

/** Alerta stock_critico activa de un SKU, como la deja CU-47. */
async function critica(sku) {
  const { rows: h } = await db.query(`INSERT INTO inventario.historial_alerta DEFAULT VALUES RETURNING historial_alerta_id_historial AS id`);
  const { rows } = await db.query(
    `INSERT INTO inventario.alerta_inventario (alerta_inventario_mensaje, alerta_inventario_estado, material_sku,
       alerta_inventario_tipo_alerta_id_tipo_alerta, historial_alerta_id_historial)
     VALUES ('sin stock disponible', 'activa', $1, 2, $2) RETURNING alerta_inventario_id_alerta AS id`, [sku, h[0].id]);
  return rows[0].id;
}
async function estado(id) {
  const { rows } = await db.query(
    `SELECT a.alerta_inventario_estado AS estado, ha.historial_alerta_fecha_hora_resolucion AS fecha
     FROM inventario.alerta_inventario a LEFT JOIN inventario.historial_alerta ha USING (historial_alerta_id_historial)
     WHERE a.alerta_inventario_id_alerta = $1`, [id]);
  return rows[0];
}

test('stock_critico de un producto sin mínimo: se resuelve al volver el stock; sin stock sigue activa', async () => {
  const conStock = await critica('MAT-UNO');                              // MAT-UNO: 1 disponible, sin mínimo
  await db.query(`UPDATE inventario.material SET material_stock_minimo = NULL, material_stock_critico = NULL WHERE material_sku = 'MAT-HERR'`);
  await db.query(`UPDATE inventario.inventario_bodega SET inventario_bodega_cantidad_fisica = 0 WHERE material_sku = 'MAT-HERR'`);
  const sinStock = await critica('MAT-HERR');

  assert.equal((await api('POST', '/api/alertas/generar')).status, 200);

  const a = await estado(conStock);
  assert.equal(a.estado, 'resuelta');
  assert.ok(a.fecha, 'con fecha de resolución');
  assert.equal((await estado(sinStock)).estado, 'activa');
});
