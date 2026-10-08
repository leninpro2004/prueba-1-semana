const jwt = require('jsonwebtoken');
const { query } = require('../db/pool');
const auditoria = require('../controllers/auditoriaController');

/**
 * Verifica el token JWT en el header Authorization.
 * Si es válido, verifica que la cuenta siga activa en la BD
 * y adjunta el payload en req.user.
 */
async function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Verificar que la cuenta sigue activa en la base de datos
    const { rows } = await query(
      `SELECT usuario_estado_cuenta            AS estado,
              usuario_username                 AS username,
              usuario_desactivacion_programada AS desactivacion_programada,
              usuario_activacion_programada    AS activacion_programada
       FROM inventario.usuario WHERE usuario_id_usuario = $1`,
      [payload.id]
    );

    if (!rows.length) {
      return res.status(401).json({ error: 'Cuenta desactivada. Contacte al administrador.' });
    }

    let estado = rows[0].estado;

    /* OPUS-8: aplicar aqui las programaciones vencidas del propio usuario.
       Asi la desactivacion surte efecto en su PROXIMO request, sin depender de un
       cron ni de que alguien abra el dashboard. */
    if (rows[0].activacion_programada && new Date(rows[0].activacion_programada) <= new Date()) {
      await query(
        `UPDATE inventario.usuario
         SET usuario_estado_cuenta = 'activo', usuario_activacion_programada = NULL
         WHERE usuario_id_usuario = $1`,
        [payload.id]
      );
      estado = 'activo';
      await auditoria.registrar(auditoria.USUARIO_SISTEMA, 'programacion_ejecutada',
        `Usuario ${rows[0].username} (ID ${payload.id}) activado automáticamente`);
    }

    if (rows[0].desactivacion_programada && new Date(rows[0].desactivacion_programada) <= new Date()) {
      await query(
        `UPDATE inventario.usuario
         SET usuario_estado_cuenta = 'inactivo', usuario_desactivacion_programada = NULL
         WHERE usuario_id_usuario = $1`,
        [payload.id]
      );
      await auditoria.registrar(auditoria.USUARIO_SISTEMA, 'programacion_ejecutada',
        `Usuario ${rows[0].username} (ID ${payload.id}) desactivado automáticamente`);
      return res.status(401).json({
        error: 'Su cuenta ha sido desactivada según la programación establecida. Contacte al administrador.',
        codigo: 'CUENTA_DESACTIVADA'
      });
    }

    if (!['activo','activa'].includes(estado)) {
      return res.status(401).json({
        error: 'Cuenta desactivada. Contacte al administrador.',
        codigo: 'CUENTA_DESACTIVADA'
      });
    }

    req.user = payload; // { id, username, nombre, rol }
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token inválido o expirado' });
    }
    return res.status(500).json({ error: 'Error interno de autenticación' });
  }
}

/**
 * Solo permite acceso a usuarios con rol gerencia.
 * Usar después de authMiddleware.
 */
function soloGerencia(req, res, next) {
  if (req.user?.rol !== 'gerencia') {
    return res.status(403).json({ error: 'Acceso restringido a gerencia' });
  }
  next();
}

/**
 * Permite acceso a gerencia, administrador y jop.
 * Bloquea solo roles sin acceso operativo (técnico, secretaria).
 */
function soloOperativo(req, res, next) {
  const rolesPermitidos = ['gerencia', 'administrador', 'jop'];
  if (!rolesPermitidos.includes(req.user?.rol)) {
    return res.status(403).json({ error: 'Acceso restringido a personal operativo' });
  }
  next();
}

/**
 * D62: gerencia y administrador (borrar bodegas y anaqueles, como ya lo limita la pantalla).
 */
function soloGerenciaOAdministrador(req, res, next) {
  if (!['gerencia', 'administrador'].includes(req.user?.rol)) {
    return res.status(403).json({ error: 'Acceso restringido a gerencia y administración' });
  }
  next();
}

/**
 * Invariante: los montos (precios, costos, valores) se ocultan al rol jop EN EL
 * BACKEND, no solo en la vista. Los controllers que devuelven montos a roles que
 * incluyen jop lo consultan y quitan esos campos. tests/montos-jop.test.js recorre
 * los endpoints como jop y falla si alguno los envía.
 */
function ocultaMontos(req) {
  // D50 (sesión 15): también al técnico. Secretaria y administrador sí los ven.
  return ['jop', 'tecnico'].includes(req.user?.rol);
}

/** Quita `campos` de cada objeto de `filas` (en el lugar). Devuelve `filas`. */
function quitarCampos(filas, campos) {
  for (const f of filas) for (const c of campos) delete f[c];
  return filas;
}

module.exports = { authMiddleware, soloGerencia, soloOperativo, soloGerenciaOAdministrador, ocultaMontos, quitarCampos };
