const { query } = require('../db/pool');
const auditoria = require('./auditoriaController');

/**
 * GET /api/notificaciones
 * Lista notificaciones del usuario autenticado (CU-45, CU-46)
 * Query params: ?estado=&tipo=&limit=
 */
async function listar(req, res) {
  const { estado, tipo, limit: lim } = req.query;
  const userId = req.user.id;
  const maxRows = Math.min(parseInt(lim) || 50, 200);

  try {
    const { rows } = await query(
      `SELECT
         n.notificacion_id_notificacion   AS id,
         n.notificacion_tipo_notificacion AS tipo,
         n.notificacion_mensaje           AS mensaje,
         n.notificacion_fecha_generacion  AS fecha,
         n.notificacion_estado_lectura    AS estado,
         n.notificacion_origen            AS origen,
         n.alerta_inventario_id_alerta    AS alerta_id
       FROM notificacion n
       WHERE n.usuario_id_usuario = $1
         AND ($2::text IS NULL OR n.notificacion_estado_lectura = $2)
         AND ($3::text IS NULL OR n.notificacion_tipo_notificacion ILIKE '%' || $3 || '%')
       ORDER BY n.notificacion_fecha_generacion DESC
       LIMIT $4`,
      [userId, estado || null, tipo || null, maxRows]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listando notificaciones:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/notificaciones/resumen
 * Conteo de no leídas para badge (CU-45)
 */
async function resumen(req, res) {
  const userId = req.user.id;
  try {
    const { rows } = await query(
      `SELECT COUNT(*) AS no_leidas
       FROM notificacion
       WHERE usuario_id_usuario = $1
         AND notificacion_estado_lectura = 'no_leida'`,
      [userId]
    );
    res.json({ no_leidas: parseInt(rows[0].no_leidas) });
  } catch (err) {
    console.error('Error resumen notificaciones:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * PUT /api/notificaciones/:id/leer
 * Marca una notificación como leída
 */
async function marcarLeida(req, res) {
  const { id } = req.params;
  const userId = req.user.id;
  try {
    const { rowCount } = await query(
      `UPDATE notificacion
       SET notificacion_estado_lectura = 'leida'
       WHERE notificacion_id_notificacion = $1
         AND usuario_id_usuario = $2`,
      [id, userId]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Notificación no encontrada' });
    }
    res.json({ message: 'Notificación marcada como leída' });
  } catch (err) {
    console.error('Error marcando notificación:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * PUT /api/notificaciones/leer-todas
 * Marca todas las notificaciones del usuario como leídas
 */
async function marcarTodasLeidas(req, res) {
  const userId = req.user.id;
  try {
    const { rowCount } = await query(
      `UPDATE notificacion
       SET notificacion_estado_lectura = 'leida'
       WHERE usuario_id_usuario = $1
         AND notificacion_estado_lectura = 'no_leida'`,
      [userId]
    );
    await auditoria.registrar(userId, 'marcar_todas_leidas', `${rowCount} notificación(es) marcadas como leídas`);
    res.json({ message: `${rowCount} notificación(es) marcadas como leídas` });
  } catch (err) {
    console.error('Error marcando todas leídas:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * Función interna: crear notificación para uno o varios usuarios
 * Se llama desde otros controladores (alertas, mermas, etc.)
 *
 * @param {object} opts
 * @param {string} opts.tipo   — ej: 'alerta_stock', 'merma_pendiente', 'programacion'
 * @param {string} opts.mensaje
 * @param {string} opts.origen — ej: 'sistema', 'alertas', 'movimientos'
 * @param {number|null} opts.alertaId — FK a alerta_inventario (opcional)
 * @param {number[]} opts.usuarioIds — lista de usuarios destinatarios
 */
async function crearNotificacion({ tipo, mensaje, origen, alertaId, usuarioIds }) {
  try {
    for (const uid of usuarioIds) {
      await query(
        `INSERT INTO notificacion (
           notificacion_tipo_notificacion, notificacion_mensaje,
           notificacion_origen, alerta_inventario_id_alerta,
           usuario_id_usuario
         ) VALUES ($1, $2, $3, $4, $5)`,
        [tipo, mensaje, origen || 'sistema', alertaId || null, uid]
      );
    }
  } catch (err) {
    console.warn('No se pudo crear notificación:', err.message);
  }
}

/**
 * Función interna: crear notificación para todos los usuarios de un rol
 *
 * @param {object} opts — mismos que crearNotificacion + opts.rol ('gerencia'|'jop')
 */
async function notificarPorRol({ tipo, mensaje, origen, alertaId, rol }) {
  try {
    const colRol = rol === 'gerencia' ? 'usuario_es_gerencia' : 'usuario_es_jop';
    const { rows } = await query(
      `SELECT usuario_id_usuario AS id FROM usuario
       WHERE ${colRol} = TRUE AND usuario_estado_cuenta IN ('activo', 'activa')`
    );
    if (rows.length > 0) {
      await crearNotificacion({
        tipo, mensaje, origen, alertaId,
        usuarioIds: rows.map(r => r.id)
      });
    }
  } catch (err) {
    console.warn('No se pudo notificar por rol:', err.message);
  }
}

module.exports = {
  listar, resumen, marcarLeida, marcarTodasLeidas,
  crearNotificacion, notificarPorRol
};
