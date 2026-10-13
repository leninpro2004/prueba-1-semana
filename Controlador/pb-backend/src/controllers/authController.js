const bcrypt   = require('bcrypt');
const jwt      = require('jsonwebtoken');
const { query } = require('../db/pool');
const { conTransaccion, ErrorNegocio, responderError } = require('../db/tx');
const auditoria = require('./auditoriaController');
const { notificarPorRol } = require('./notificacionesController');
const { rolDe } = require('../middleware/auth');
const { ACCIONES_FIRMA } = require('../config/firmas');
const { firmarToken } = require('../middleware/firma');

/* S-03 (F-02): límite de intentos fallidos del login, en memoria (se reinicia con el proceso).
   Por usuario: 5 fallos en 15 min lo bloquean hasta que vence la ventana, aunque luego llegue la
   contraseña correcta. Por IP: 30 fallos en 15 min (contra quien prueba muchos usuarios). Solo se
   cuentan los fallos, para que una capacitación con todos detrás de la misma IP no se bloquee.
   Detrás de nginx, la IP real exige TRUST_PROXY=1 (S-10, src/index.js). */
const LOGIN_VENTANA_MS     = 15 * 60 * 1000;
const LOGIN_MAX_POR_USUARIO = 5;
const LOGIN_MAX_POR_IP      = 30;
const _loginFallosUsuario = new Map();
const _loginFallosIp      = new Map();

/** Fallos vigentes de una clave (descarta los vencidos). */
function fallosVigentes(mapa, clave, ahora) {
  const vigentes = (mapa.get(clave) || []).filter(t => ahora - t < LOGIN_VENTANA_MS);
  if (vigentes.length) mapa.set(clave, vigentes); else mapa.delete(clave);
  return vigentes;
}

/** Minutos que faltan para poder intentar de nuevo, o 0 si puede intentar. */
function loginBloqueado(usuarioClave, ip, ahora = Date.now()) {
  const espera = (fallos, max) => (fallos.length >= max
    ? Math.ceil((fallos[fallos.length - max] + LOGIN_VENTANA_MS - ahora) / 60000) : 0);
  return Math.max(
    espera(fallosVigentes(_loginFallosUsuario, usuarioClave, ahora), LOGIN_MAX_POR_USUARIO),
    espera(fallosVigentes(_loginFallosIp, ip, ahora), LOGIN_MAX_POR_IP));
}

function registrarFalloLogin(usuarioClave, ip, ahora = Date.now()) {
  for (const [mapa, clave] of [[_loginFallosUsuario, usuarioClave], [_loginFallosIp, ip]]) {
    mapa.set(clave, [...fallosVigentes(mapa, clave, ahora), ahora]);
  }
}

/**
 * B-20: cada login fallido queda en la auditoría con su IP. Con usuario inexistente va a nombre del
 * sistema (id 0) con el texto intentado recortado (alguien pudo escribir su contraseña en el campo de
 * usuario). Si este fallo completa un límite de S-03, se registra además el bloqueo, una sola vez: los
 * intentos siguientes reciben 429 antes de llegar aquí.
 */
async function auditarFalloLogin(usuarioId, username, usuarioClave, ip) {
  const nombre = String(username).trim().slice(0, 40);
  await auditoria.registrar(usuarioId, 'login_fallido',
    usuarioId ? `Contraseña incorrecta para ${nombre}` : `Usuario inexistente: "${nombre}"`, { ip });
  const porUsuario = (_loginFallosUsuario.get(usuarioClave) || []).length >= LOGIN_MAX_POR_USUARIO;
  const porIp      = (_loginFallosIp.get(ip) || []).length >= LOGIN_MAX_POR_IP;
  if (porUsuario || porIp) {
    await auditoria.registrar(usuarioId, 'bloqueo_login', porUsuario
      ? `${LOGIN_MAX_POR_USUARIO} fallos seguidos para "${nombre}": login bloqueado 15 minutos`
      : `${LOGIN_MAX_POR_IP} fallos desde la misma IP: login bloqueado 15 minutos para esa IP`, { ip });
  }
}

/** Solo para los tests: vuelve a cero los contadores. */
function reiniciarLimitesLogin() {
  _loginFallosUsuario.clear();
  _loginFallosIp.clear();
}

/**
 * POST /api/auth/login
 * Body: { username, password }
 *
 * El modelo tiene:
 *   usuario.usuario_username
 *   usuario.usuario_estado_cuenta  ('activo' | 'inactivo')
 *   usuario.usuario_es_gerencia    BOOLEAN
 *   usuario.usuario_es_jop         BOOLEAN
 *   usuario_contrasena.usuario_contrasena (hash bcrypt)
 */
async function login(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña son requeridos' });
  }

  // S-03: se decide antes de tocar la base; la clave del usuario no distingue mayúsculas
  const usuarioClave = String(username).trim().toLowerCase();
  const ip = req.ip || 'desconocida';
  const minutos = loginBloqueado(usuarioClave, ip);
  if (minutos > 0) {
    return res.status(429).json({
      error: `Demasiados intentos fallidos. Intente nuevamente en ${minutos} minuto${minutos === 1 ? '' : 's'}.`,
    });
  }

  try {
    // Buscar usuario + contraseña en una sola query
    const { rows } = await query(
      `SELECT
         u.usuario_id_usuario                               AS id,
         u.usuario_username                                 AS username,
         u.usuario_nombre_completo_primer_nombre_usuario    AS primer_nombre,
         u.usuario_nombre_completo_primer_apellido_usuario  AS primer_apellido,
         u.usuario_estado_cuenta                            AS estado,
         u.usuario_es_gerencia                              AS es_gerencia,
         u.usuario_es_jop                                   AS es_jop,
         u.usuario_es_tecnico                               AS es_tecnico,
         u.usuario_es_administrador                         AS es_admin,
         u.usuario_es_secretaria                            AS es_sec,
         uc.usuario_contrasena                              AS password_hash,
         uc.es_temporal                                     AS es_temporal
       FROM usuario u
       JOIN usuario_contrasena uc ON uc.usuario_id_usuario = u.usuario_id_usuario
       WHERE u.usuario_username = $1
       ORDER BY u.usuario_id_usuario LIMIT 1`,
      [username]
    );

    if (rows.length === 0) {
      registrarFalloLogin(usuarioClave, ip);
      await auditarFalloLogin(null, username, usuarioClave, ip);
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    const user = rows[0];

    // Verificar estado de cuenta
    if (!['activo','activa'].includes(user.estado)) {
      return res.status(403).json({ error: 'Cuenta inactiva. Contacta a Gerencia.' });
    }

    // Verificar contraseña
    const passwordOk = await bcrypt.compare(password, user.password_hash);
    if (!passwordOk) {
      registrarFalloLogin(usuarioClave, ip);
      await auditarFalloLogin(user.id, username, usuarioClave, ip);
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    _loginFallosUsuario.delete(usuarioClave);   // un éxito limpia los fallos del usuario (no los de la IP)

    // Rol para el frontend desde los booleanos es_* (B-01: misma regla que el middleware)
    const rol = rolDe(user);

    const nombre = `${user.primer_nombre || ''} ${user.primer_apellido || ''}`.trim();

    // Generar JWT
    const token = jwt.sign(
      { id: user.id, username: user.username, nombre, rol },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    // Actualizar última conexión
    await query(
      `UPDATE usuario SET usuario_fecha_ultima_conexion = now()
       WHERE usuario_id_usuario = $1`,
      [user.id]
    );

    await auditoria.registrar(user.id, 'login', `Inicio de sesión: ${user.username}`, { ip: req.ip });

    // CU-84 CP3: Verificar si la contraseña es temporal (persistido en BD)
    const requiere_cambio = user.es_temporal === true;

    res.json({
      token,
      user: { id: user.id, username: user.username, nombre, rol },
      ...(requiere_cambio && { requiere_cambio_password: true })
    });

  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/auth/cambiar-password
 * Requiere token. Body: { password_actual, password_nueva }
 */
async function cambiarPassword(req, res) {
  const { password_actual, password_nueva } = req.body;
  const userId = req.user.id;

  if (!password_actual || !password_nueva) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }
  if (password_nueva.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }

  try {
    const { rows } = await query(
      `SELECT usuario_contrasena FROM usuario_contrasena WHERE usuario_id_usuario = $1`,
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const ok = await bcrypt.compare(password_actual, rows[0].usuario_contrasena);
    if (!ok) {
      // Sesión 15: 400, no 401 (con 401 el frontend cierra la sesión por un error de tipeo)
      return res.status(400).json({ error: 'Contraseña actual incorrecta' });
    }

    const hash = await bcrypt.hash(password_nueva, 12);
    await query(
      `UPDATE usuario_contrasena SET usuario_contrasena = $1, es_temporal = FALSE
       WHERE usuario_id_usuario = $2`,
      [hash, userId]
    );

    await auditoria.registrar(userId, 'cambiar_password', `Usuario ID ${userId} cambió su contraseña`, { ip: req.ip });
    res.json({ message: 'Contraseña actualizada correctamente' });

  } catch (err) {
    console.error('Error cambiando contraseña:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/auth/solicitar-recuperacion
 * CU-82: Genera token temporal de recuperación
 * Body: { username } — acepta username o email
 */
// CU-83: Antispam — limitar a 3 solicitudes por IP en 15 minutos
const _recuperacionIntentos = new Map();
function verificarAntispam(ip) {
  const ahora = Date.now();
  const ventana = 15 * 60 * 1000; // 15 minutos
  if (!_recuperacionIntentos.has(ip)) _recuperacionIntentos.set(ip, []);
  const intentos = _recuperacionIntentos.get(ip).filter(t => ahora - t < ventana);
  _recuperacionIntentos.set(ip, intentos);
  if (intentos.length >= 3) return false;
  intentos.push(ahora);
  return true;
}

/* B-02 (D80): el autoservicio por token queda apagado salvo RECUPERACION_AUTOSERVICIO=true
   (solo desarrollo: no hay envío de correo y el token volvería en la respuesta pública).
   La recuperación la hace gerencia (POST /usuarios/:id/recuperar-password) y, para un
   gerente, el comando del servidor: docs/fase-cierre/recuperacion-acceso.md */
const autoservicioRecuperacion = () => process.env.RECUPERACION_AUTOSERVICIO === 'true';
const MENSAJE_RECUPERACION_GERENCIA =
  'La recuperación de contraseñas la hace gerencia: pídale una contraseña temporal. ' +
  'Si usted es de gerencia, contacte al soporte técnico.';

async function solicitarRecuperacion(req, res) {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: 'Debe ingresar su correo electrónico o nombre de usuario' });
  }

  // Misma respuesta exista o no el usuario, y sin tocar la base
  if (!autoservicioRecuperacion()) {
    return res.json({ message: MENSAJE_RECUPERACION_GERENCIA, autoservicio: false });
  }

  // CU-83 CP4: Control antispam
  const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
  if (!verificarAntispam(clientIp)) {
    return res.status(429).json({ error: 'Demasiadas solicitudes de recuperación. Intente nuevamente en 15 minutos.' });
  }

  try {
    // Buscar por username O por correo electrónico
    const { rows } = await query(
      `SELECT u.usuario_id_usuario AS id, u.usuario_username AS username,
              u.usuario_estado_cuenta AS estado
       FROM usuario u
       WHERE u.usuario_username = $1
          OR u.usuario_correo = $1`,
      [username]
    );

    // CU-77 Exc 1: usuario no encontrado — respondemos genéricamente por seguridad
    if (rows.length === 0) {
      return res.json({
        message: 'Si el usuario existe, se ha generado un enlace de recuperación.'
      });
    }

    // CU-77 Exc 2: cuenta inactiva
    if (!['activo', 'activa'].includes(rows[0].estado)) {
      return res.json({
        message: 'Si el usuario existe, se ha generado un enlace de recuperación.'
      });
    }

    // Generar token temporal con expiración de 30 min
    const token = jwt.sign(
      { id: rows[0].id, tipo: 'recuperacion' },
      process.env.JWT_SECRET,
      { expiresIn: '30m' }
    );

    await auditoria.registrar(rows[0].id, 'solicitar_recuperacion', `Solicitud de recuperación para: ${rows[0].username}`, { ip: req.ip });

    // En producción se enviaría por email. Aquí lo devolvemos en la respuesta (simulado).
    res.json({
      message: 'Si el usuario existe, se ha generado un enlace de recuperación.',
      token_recuperacion: token,
      nota: 'En producción este token se enviaría por correo electrónico.',
      expira_en: '30 minutos'
    });
  } catch (err) {
    console.error('Error en solicitar recuperación:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/auth/resetear-password
 * CU-77: Consume token de recuperación y establece nueva contraseña
 * Body: { token, password_nueva }
 */
async function resetearPassword(req, res) {
  const { token, password_nueva } = req.body;

  // B-02: sin autoservicio ningún token cambia una contraseña (ni se regenera uno vencido)
  if (!autoservicioRecuperacion()) {
    return res.status(400).json({ error: MENSAJE_RECUPERACION_GERENCIA, autoservicio: false });
  }

  if (!token || !password_nueva) {
    return res.status(400).json({ error: 'Token y nueva contraseña son requeridos' });
  }

  if (password_nueva.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }

  try {
    // Verificar token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      // CU-83 Exc 2: token expirado — generar automáticamente uno nuevo
      if (e.name === 'TokenExpiredError') {
        const payload = jwt.decode(token);
        if (payload && payload.id && payload.tipo === 'recuperacion') {
          const nuevoToken = jwt.sign(
            { id: payload.id, tipo: 'recuperacion' },
            process.env.JWT_SECRET,
            { expiresIn: '30m' }
          );
          await auditoria.registrar(payload.id, 'solicitar_recuperacion', `Token expirado — se generó automáticamente un nuevo enlace de recuperación`, { ip: req.ip });
          return res.status(400).json({
            error: 'El enlace de recuperación ha expirado. Se ha generado automáticamente uno nuevo.',
            token_regenerado: nuevoToken,
            expira_en: '30 minutos'
          });
        }
      }
      // Token inválido (no expirado, sino corrupto o manipulado)
      return res.status(400).json({ error: 'El enlace de recuperación es inválido. Solicite uno nuevo.' });
    }

    if (decoded.tipo !== 'recuperacion') {
      return res.status(400).json({ error: 'Token inválido' });
    }

    const hash = await bcrypt.hash(password_nueva, 12);
    await query(
      `UPDATE usuario_contrasena SET usuario_contrasena = $1
       WHERE usuario_id_usuario = $2`,
      [hash, decoded.id]
    );

    await auditoria.registrar(decoded.id, 'resetear_password', `Contraseña restablecida para usuario ID ${decoded.id}`, { ip: req.ip });
    res.json({ message: 'Contraseña restablecida correctamente. Inicie sesión con su nueva contraseña.' });
  } catch (err) {
    console.error('Error reseteando contraseña:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/auth/me
 * B-01: el usuario de la sesión según la BD (el frontend ya no lo guarda en el
 * navegador). req.user lo arma el authMiddleware desde la BD; aquí se agrega si la
 * contraseña es temporal, para que el cambio obligatorio sobreviva a un F5.
 */
async function me(req, res) {
  try {
    const { rows } = await query(
      `SELECT es_temporal FROM usuario_contrasena WHERE usuario_id_usuario = $1`, [req.user.id]
    );
    res.json({
      ...req.user,
      ...(rows[0]?.es_temporal === true && { requiere_cambio_password: true }),
    });
  } catch (err) {
    console.error('Error consultando el usuario de la sesión:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/auth/session-status
 * OPUS-8: el frontend lo consulta cada 60s para cerrar la sesion en vivo cuando
 * un administrador desactiva la cuenta (o cuando vence la desactivacion
 * programada). Si la cuenta ya no esta activa, el authMiddleware corta antes con
 * 401 + codigo CUENTA_DESACTIVADA, que es lo que dispara el logout.
 */
async function sessionStatus(req, res) {
  try {
    const { rows } = await query(
      `SELECT usuario_estado_cuenta            AS estado,
              usuario_desactivacion_programada AS desactivacion_programada,
              usuario_activacion_programada    AS activacion_programada
       FROM usuario WHERE usuario_id_usuario = $1`,
      [req.user.id]
    );

    if (rows.length === 0) {
      return res.status(401).json({ activo: false, error: 'Cuenta no encontrada', codigo: 'CUENTA_DESACTIVADA' });
    }

    res.json({
      activo: ['activo', 'activa'].includes(rows[0].estado),
      estado: rows[0].estado,
      rol: req.user.rol, // B-01: el frontend recarga el usuario si cambió
      desactivacion_programada: rows[0].desactivacion_programada,
      activacion_programada: rows[0].activacion_programada
    });
  } catch (err) {
    console.error('Error consultando estado de sesión:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/* ── CU-42 y F-11: firma de un gerente antes de una operación sensible ───── */

const REAUTH_MAX_FALLOS      = 3;
const REAUTH_MINUTOS_BLOQUEO = 15;

/**
 * Fallos consecutivos del usuario desde su último éxito, y si está bloqueado.
 * Se calcula desde la tabla (D27), así que el bloqueo sobrevive a un reinicio.
 * Cada 3 fallos seguidos bloquean 15 min; durante el bloqueo no se registran
 * intentos, así que al vencer el usuario tiene otros 3. Un éxito resetea.
 * Es independiente del login: ni uno cuenta para el otro.
 */
async function estadoReautenticacion(client, uid) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS fallos,
            max(reautenticacion_intento_fecha_hora) + make_interval(mins => $2)          AS hasta,
            max(reautenticacion_intento_fecha_hora) + make_interval(mins => $2) > now() AS vigente
     FROM reautenticacion_intento
     WHERE usuario_id_usuario = $1
       AND NOT reautenticacion_intento_exitoso
       AND reautenticacion_intento_fecha_hora > COALESCE(
             (SELECT max(reautenticacion_intento_fecha_hora) FROM reautenticacion_intento
              WHERE usuario_id_usuario = $1 AND reautenticacion_intento_exitoso),
             '-infinity')`,
    [uid, REAUTH_MINUTOS_BLOQUEO]
  );
  const { fallos, hasta, vigente } = rows[0];
  const bloqueado = fallos > 0 && fallos % REAUTH_MAX_FALLOS === 0 && vigente;
  return { fallos, bloqueadoHasta: bloqueado ? hasta : null };
}

const horaChile = (fecha) => new Date(fecha).toLocaleTimeString('es-CL',
  { hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago' });

/**
 * POST /api/auth/reautenticar (CU-42, F-11) — Body: { username, password, accion }.
 * Firma de un GERENTE (no necesariamente el de la sesión) para una acción del catálogo de
 * config/firmas.js, revertir un movimiento incluido. Éxito → { autorizacion }: token de 5 min y
 * un solo uso para esa acción, que el cliente manda en el header X-Autorizacion (middleware/firma.js).
 * Cada intento queda en reautenticacion_intento; 3 fallos seguidos bloquean la firma de ese
 * gerente 15 min y se notifica a Gerencia. Contraseña incorrecta → 403, no 401 (el frontend
 * cierra la sesión ante un 401).
 */
async function reautenticar(req, res) {
  const { username, password, accion } = req.body || {};
  if (!Object.prototype.hasOwnProperty.call(ACCIONES_FIRMA, accion)) {
    return res.status(400).json({ error: 'La acción indicada no requiere autorización.' });
  }
  if (!String(username || '').trim() || !password) {
    return res.status(400).json({ error: 'Ingrese el usuario y la contraseña de un gerente.' });
  }

  try {
    const r = await conTransaccion(async (client) => {
      const { rows: u } = await client.query(
        `SELECT usuario_id_usuario AS id, usuario_username AS username, usuario_estado_cuenta AS estado,
                usuario_es_gerencia AS es_gerencia, usuario_es_tecnico AS es_tecnico,
                usuario_es_administrador AS es_admin, usuario_es_secretaria AS es_sec
         FROM usuario WHERE usuario_username = $1
         ORDER BY usuario_id_usuario LIMIT 1`,
        [String(username).trim()]
      );
      if (u.length === 0 || !['activo', 'activa'].includes(u[0].estado) || rolDe(u[0]) !== 'gerencia') {
        throw new ErrorNegocio(403, { error: 'Ese usuario no puede autorizar: la firma debe ser de un gerente con la cuenta activa.' });
      }
      const firmante = u[0];
      // FOR UPDATE: dos intentos simultáneos sobre el mismo gerente se procesan de a uno
      const { rows: pass } = await client.query(
        `SELECT usuario_contrasena AS hash FROM usuario_contrasena WHERE usuario_id_usuario = $1 FOR UPDATE`,
        [firmante.id]
      );
      if (pass.length === 0) {
        throw new ErrorNegocio(403, { error: 'Ese gerente no tiene una contraseña registrada.' });
      }

      const estado = await estadoReautenticacion(client, firmante.id);
      if (estado.bloqueadoHasta) {
        throw new ErrorNegocio(423, {
          error: `La firma de ${firmante.username} está bloqueada por ${REAUTH_MAX_FALLOS} intentos fallidos. ` +
                 `Intente nuevamente a las ${horaChile(estado.bloqueadoHasta)}.`,
          bloqueado_hasta: estado.bloqueadoHasta,
        });
      }

      const ok = await bcrypt.compare(String(password), pass[0].hash);
      const { rows: ins } = await client.query(
        `INSERT INTO reautenticacion_intento (usuario_id_usuario, reautenticacion_intento_exitoso, reautenticacion_intento_accion)
         VALUES ($1, $2, $3) RETURNING reautenticacion_intento_fecha_hora AS fecha`,
        [firmante.id, ok, accion]
      );

      if (ok) return { ok: true, firmante };
      const fallos = estado.fallos + 1;
      if (fallos % REAUTH_MAX_FALLOS === 0) {
        return { ok: false, firmante,
                 bloqueadoHasta: new Date(new Date(ins[0].fecha).getTime() + REAUTH_MINUTOS_BLOQUEO * 60000) };
      }
      return { ok: false, firmante, restantes: REAUTH_MAX_FALLOS - (fallos % REAUTH_MAX_FALLOS) };
    });

    // Después del COMMIT: el intento ya quedó registrado aunque esto falle.
    const quien = req.user.nombre || req.user.username;
    if (r.ok) {
      await auditoria.registrar(req.user.id, 'firma_gerencia',
        `${ACCIONES_FIRMA[accion]} (${accion}): autorizó ${r.firmante.username}`, { ip: req.ip });
      return res.json({ autorizacion: firmarToken(accion, r.firmante.id), expira_en_segundos: 300 });
    }

    if (r.bloqueadoHasta) {
      const hora = horaChile(r.bloqueadoHasta);
      await auditoria.registrar(req.user.id, 'bloqueo_reautenticacion',
        `${REAUTH_MAX_FALLOS} fallos con la firma de ${r.firmante.username} para ${accion}; bloqueado hasta ${hora}`, { ip: req.ip });
      await notificarPorRol({
        tipo: 'seguridad',
        origen: 'seguridad',
        ruta: '/usuarios?tab=auditoria',
        rol: 'gerencia',
        mensaje: `Bloqueo de autorización: ${quien} falló ${REAUTH_MAX_FALLOS} veces seguidas la contraseña de ` +
                 `${r.firmante.username} al pedir autorización para ${ACCIONES_FIRMA[accion]}. Queda bloqueado hasta las ${hora}.`,
      });
      return res.status(423).json({
        error: `Contraseña incorrecta. Se alcanzaron ${REAUTH_MAX_FALLOS} intentos fallidos: la firma de ` +
               `${r.firmante.username} queda bloqueada hasta las ${hora}. Se notificó a Gerencia.`,
        bloqueado_hasta: r.bloqueadoHasta,
      });
    }

    return res.status(403).json({
      error: `Contraseña incorrecta. Le quedan ${r.restantes} intento(s).`,
      intentos_restantes: r.restantes,
    });
  } catch (err) {
    responderError(res, err, 'Error en la firma de gerencia:');
  }
}

module.exports = { reiniciarLimitesLogin, login, cambiarPassword, solicitarRecuperacion, resetearPassword, me, sessionStatus, reautenticar
};
