const bcrypt   = require('bcrypt');
const { query } = require('../db/pool');
const { ErrorNegocio, conTransaccion, responderError } = require('../db/tx');
const audLog = require('./auditoriaController');

// CU-84 CP3: Flag es_temporal en usuario_contrasena (persistido en BD)

/**
 * GET /api/usuarios
 * Lista todos los usuarios — solo gerencia (FR-57)
 */
async function listar(req, res) {
  const { buscar, rol, estado } = req.query;
  try {
    const { rows } = await query(
      `SELECT
         u.usuario_id_usuario                                    AS id,
         u.usuario_username                                      AS username,
         u.usuario_correo                                        AS correo,
         u.usuario_estado_cuenta                                 AS estado,
         u.usuario_fecha_de_creacion                             AS creado,
         u.usuario_fecha_ultima_conexion                         AS ultima_conexion,
         u.usuario_desactivacion_programada                      AS desactivacion_programada,
         u.usuario_activacion_programada                         AS activacion_programada,
         u.usuario_es_gerencia                                   AS es_gerencia,
         u.usuario_es_jop                                        AS es_jop,
         CONCAT_WS(' ',
           u.usuario_nombre_completo_primer_nombre_usuario,
           u.usuario_nombre_completo_primer_apellido_usuario)    AS nombre_completo,
         CASE
           WHEN u.usuario_es_gerencia THEN 'gerencia'
           WHEN u.usuario_es_jop      THEN 'jop'
           ELSE 'otro'
         END AS rol
       FROM usuario u
       WHERE ($1::text IS NULL OR
              u.usuario_username ILIKE '%' || $1 || '%' OR
              u.usuario_correo   ILIKE '%' || $1 || '%' OR
              CONCAT(u.usuario_nombre_completo_primer_nombre_usuario, ' ',
                     u.usuario_nombre_completo_primer_apellido_usuario) ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR
              ($2 = 'gerencia' AND u.usuario_es_gerencia = TRUE) OR
              ($2 = 'jop'      AND u.usuario_es_jop = TRUE))
         AND ($3::text IS NULL OR u.usuario_estado_cuenta ILIKE $3 OR u.usuario_estado_cuenta ILIKE $3 || 'a')
       ORDER BY u.usuario_nombre_completo_primer_apellido_usuario`,
      [buscar || null, rol || null, estado || null]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listando usuarios:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/usuarios
 * Crear usuario — solo gerencia (CU-72 a CU-75)
 */
async function crear(req, res) {
  const {
    username, correo, password,
    nombre, apellido, rol, estado
  } = req.body;

  if (!username || !password || !rol) {
    return res.status(400).json({ error: 'Username, contraseña y rol son requeridos' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }

  try {
    // El hash se calcula ANTES de abrir la transacción: bcrypt con coste 12 tarda
    // ~100 ms y no tiene sentido mantener una transacción abierta mientras tanto.
    const hash = await bcrypt.hash(password, 12);

    // El usuario y su contraseña se crean juntos o no se crea ninguno. Antes eran
    // dos queries sueltas: si fallaba el INSERT de la contraseña quedaba un usuario
    // SIN credenciales, imposible de usar y ocupando el username (que es UNIQUE).
    const userId = await conTransaccion(async (client) => {
      const { rows: exist } = await client.query(
        `SELECT usuario_id_usuario FROM usuario
         WHERE usuario_username = $1 OR ($2::text IS NOT NULL AND usuario_correo = $2)`,
        [username, correo || null]
      );
      if (exist.length > 0) {
        throw new ErrorNegocio(409, { error: 'El username o correo ya está en uso' });
      }

      const { rows } = await client.query(
        `INSERT INTO usuario (
           usuario_username, usuario_correo,
           usuario_nombre_completo_primer_nombre_usuario,
           usuario_nombre_completo_primer_apellido_usuario,
           usuario_estado_cuenta,
           usuario_es_gerencia, usuario_es_jop
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING usuario_id_usuario AS id`,
        [
          username, correo || null,
          nombre || null, apellido || null,
          estado || 'activa',
          rol === 'gerencia', rol === 'jop'
        ]
      );

      const id = rows[0].id;
      await client.query(
        `INSERT INTO usuario_contrasena (usuario_id_usuario, usuario_contrasena) VALUES ($1, $2)`,
        [id, hash]
      );
      return id;
    });

    await audLog.registrar(req.user?.id, 'crear_usuario', `username: ${username}, rol: ${rol}`);
    res.status(201).json({ message: 'Usuario creado correctamente', id: userId });
  } catch (err) {
    // usuario_username y usuario_correo son UNIQUE en la BD: si dos altas
    // simultáneas pasan el chequeo de arriba, la segunda choca acá. Sin esto
    // el usuario veía un 500 en vez del 409 que corresponde.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'El username o correo ya está en uso' });
    }
    responderError(res, err, 'Error creando usuario:');
  }
}

/**
 * PUT /api/usuarios/:id/permisos
 * Editar rol y estado de un usuario — solo gerencia (FR-61)
 */
async function editarPermisos(req, res) {
  const { id }    = req.params;
  const { rol, estado } = req.body;

  if (!rol && !estado) {
    return res.status(400).json({ error: 'Debes enviar al menos rol o estado' });
  }

  try {
    // CU-83 Exc 1: no puede desactivarse a sí mismo
    if (estado && ['inactivo', 'inactiva'].includes(estado.toLowerCase()) && parseInt(id) === parseInt(req.user.id)) {
      return res.status(400).json({ error: 'No puede desactivar su propia cuenta' });
    }

    // CU-82 Exc: no degradar al último gerencia
    if (rol && rol !== 'gerencia') {
      const { rows: target } = await query(
        `SELECT usuario_es_gerencia FROM usuario WHERE usuario_id_usuario = $1`, [id]
      );
      if (target.length > 0 && target[0].usuario_es_gerencia) {
        const { rows: gerencias } = await query(
          `SELECT COUNT(*) AS total FROM usuario
           WHERE usuario_es_gerencia = TRUE AND usuario_estado_cuenta IN ('activo','activa')`
        );
        if (parseInt(gerencias[0].total) <= 1) {
          return res.status(400).json({ error: 'No se puede degradar al único usuario con rol Gerencia' });
        }
      }
    }

    // CU-83 Exc: verificar OTs pendientes antes de desactivar
    if (estado && ['inactivo', 'inactiva'].includes(estado.toLowerCase())) {
      const { rows: ots } = await query(
        `SELECT COUNT(*) AS pendientes FROM orden_trabajo
         WHERE usuario_id_usuario = $1
           AND orden_trabajo_estado NOT IN ('cancelada','finalizada','completada','cerrada')`,
        [id]
      );
      if (parseInt(ots[0]?.pendientes || 0) > 0) {
        return res.status(400).json({
          error: `El usuario tiene ${ots[0].pendientes} orden(es) de trabajo pendientes. Reasígnelas antes de desactivar.`
        });
      }
    }

    // CU-82 Exc / CU-89 CP3: verificar cuenta inactiva antes de cambiar rol
    if (rol) {
      const { rows: usr } = await query(
        `SELECT usuario_estado_cuenta AS estado FROM usuario WHERE usuario_id_usuario = $1`, [id]
      );
      if (usr.length > 0 && !['activo', 'activa'].includes(usr[0].estado)
          && (!estado || !['activo', 'activa'].includes(estado.toLowerCase()))) {
        return res.status(400).json({ error: 'No se pueden editar permisos de una cuenta inactiva. Reactive la cuenta primero.' });
      }
    }

    const { rowCount } = await query(
      `UPDATE usuario SET
         usuario_es_gerencia  = CASE WHEN $1 = 'gerencia' THEN TRUE  ELSE FALSE END,
         usuario_es_jop       = CASE WHEN $1 = 'jop'      THEN TRUE  ELSE FALSE END,
         usuario_estado_cuenta = COALESCE($2, usuario_estado_cuenta),
         usuario_fecha_de_ultima_edicion = now()
       WHERE usuario_id_usuario = $3`,
      [rol || 'jop', estado || null, id]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    audLog.registrar(req.user?.id, 'editar_permisos', `usuario_id: ${id}, rol: ${rol}, estado: ${estado}`);
    res.json({ message: 'Permisos actualizados correctamente' });
  } catch (err) {
    console.error('Error editando permisos:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/usuarios/:id/recuperar-password
 * Genera nueva contraseña temporal — solo gerencia (FR-56)
 */
async function recuperarPassword(req, res) {
  const { id } = req.params;

  try {
    // CU-84: No se puede resetear la propia contraseña desde este panel
    if (parseInt(id) === parseInt(req.user.id)) {
      return res.status(403).json({ error: 'No puede resetear su propia contraseña desde este panel. Use la opción de cambio de contraseña.' });
    }

    const { rows } = await query(
      `SELECT usuario_correo, usuario_username, usuario_es_gerencia FROM usuario WHERE usuario_id_usuario = $1`, [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // CU-84 Exc 1: No se puede resetear la clave de otro usuario con rol de Gerencia
    if (rows[0].usuario_es_gerencia) {
      return res.status(403).json({ error: 'Por políticas de seguridad, no se puede resetear la clave de un usuario con rol de Gerencia' });
    }

    // En producción aquí iría el envío de email con enlace de recuperación.
    // Por ahora generamos una contraseña temporal y la devolvemos.
    const tempPassword = Math.random().toString(36).slice(-10);
    const hash = await bcrypt.hash(tempPassword, 12);

    await query(
      `UPDATE usuario_contrasena SET usuario_contrasena = $1, es_temporal = TRUE WHERE usuario_id_usuario = $2`,
      [hash, id]
    );

    await audLog.registrar(req.user?.id, 'recuperar_password', `Contraseña temporal generada para usuario ${rows[0].usuario_username} (ID ${id})`);
    res.json({
      message: `Contraseña temporal generada para ${rows[0].usuario_username}`,
      // En producción NO devolver la contraseña — enviar por email
      password_temporal: tempPassword,
      correo: rows[0].usuario_correo
    });
  } catch (err) {
    console.error('Error recuperando contraseña:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/usuarios/auditoria
 * Historial de acciones de usuarios — solo gerencia (FR-60)
 * Nota: la auditoría real requiere una tabla de logs dedicada.
 * Por ahora devuelve los movimientos registrados por cada usuario.
 */
async function auditoria(req, res) {
  const { desde, hasta, usuario_id, accion } = req.query;

  // CU-88 CP3: Validar rango de fechas
  if (desde && hasta && desde > hasta) {
    return res.status(400).json({ error: 'La fecha de inicio no puede ser posterior a la fecha de fin' });
  }

  // CU-88 CP4: No permitir fechas futuras.
  // La fecha de "hoy" se arma en LOCAL: con toISOString() (UTC) el límite se
  // corría al día siguiente desde media tarde en Chile, así que la validación
  // aceptaba o rechazaba lo mismo según la hora del día.
  const ahora = new Date();
  const hoy = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}-${String(ahora.getDate()).padStart(2, '0')}`;
  if ((desde && desde > hoy) || (hasta && hasta > hoy)) {
    return res.status(400).json({ error: 'No se pueden buscar registros con fechas futuras' });
  }

  try {
    // CU-34: Include movimiento_inventario, reporte AND finanzas.evento_auditoria
    // SONNET-6: filtro de accion se aplica en la consulta externa (combinable con desde/hasta/usuario_id)
    const { rows } = await query(
      `SELECT * FROM (
        (SELECT
           mi.movimiento_inventario_fecha_hora   AS timestamp,
           u.usuario_username                    AS usuario,
           u.usuario_rut_usuario                 AS rut,
           'registrar_movimiento'                AS accion,
           CONCAT(
             tm.movimiento_inventario_tipo_movimiento_nombre, ' — SKU ',
             mi.material_sku, ', cantidad: ', mi.movimiento_inventario_cantidad
           )                                     AS detalle
         FROM movimiento_inventario mi
         JOIN usuario u ON u.usuario_id_usuario = mi.usuario_id_usuario
         JOIN movimiento_inventario_tipo_movimiento tm
              ON tm.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
               = mi.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
         WHERE ($1::text IS NULL OR $1::text = '' OR mi.movimiento_inventario_fecha_hora >= $1::date)
           AND ($2::text IS NULL OR $2::text = '' OR mi.movimiento_inventario_fecha_hora < ($2::date + INTERVAL '1 day'))
           AND ($3::text IS NULL OR $3::text = '' OR mi.usuario_id_usuario = $3::bigint))
        UNION ALL
        (SELECT
           r.reporte_fecha_generacion       AS timestamp,
           COALESCE(u2.usuario_username, 'Sistema') AS usuario,
           u2.usuario_rut_usuario           AS rut,
           split_part(r.reporte_tipo_reporte, ':', 2) AS accion,
           split_part(r.reporte_tipo_reporte, ':', 3) AS detalle
         FROM reporte r
         LEFT JOIN usuario u2 ON u2.usuario_id_usuario = r.usuario_id_usuario
         WHERE r.reporte_tipo_reporte LIKE 'auditoria:%'
           AND ($1::text IS NULL OR $1::text = '' OR r.reporte_fecha_generacion >= $1::date)
           AND ($2::text IS NULL OR $2::text = '' OR r.reporte_fecha_generacion < ($2::date + INTERVAL '1 day'))
           AND ($3::text IS NULL OR $3::text = '' OR r.usuario_id_usuario = $3::bigint))
        UNION ALL
        (SELECT
           ea.fecha_hora                    AS timestamp,
           -- D59: id_usuario 0 = acción automática del sistema
           CASE WHEN ea.id_usuario = 0 THEN 'Sistema (automático)'
                ELSE COALESCE(u3.usuario_username, 'Sistema') END AS usuario,
           u3.usuario_rut_usuario           AS rut,
           ea.accion_realizada              AS accion,
           -- D59: el detalle largo de Inventario va completo en observacion
           CASE WHEN ea.entidad_afectada = 'inventario' AND ea.observacion IS NOT NULL
                THEN ea.observacion ELSE ea.registro_afectado END AS detalle
         FROM finanzas.evento_auditoria ea
         LEFT JOIN usuario u3 ON u3.usuario_id_usuario = ea.id_usuario
         WHERE ($1::text IS NULL OR $1::text = '' OR ea.fecha_hora >= $1::date)
           AND ($2::text IS NULL OR $2::text = '' OR ea.fecha_hora < ($2::date + INTERVAL '1 day'))
           AND ($3::text IS NULL OR $3::text = '' OR ea.id_usuario = $3::bigint))
      ) combinado
      WHERE ($4::text IS NULL OR $4::text = '' OR combinado.accion ILIKE '%' || $4 || '%')
      ORDER BY timestamp DESC
      LIMIT 200`,
      [desde || null, hasta || null, usuario_id || null, accion || null]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error obteniendo auditoria:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/usuarios/:id/programar-desactivacion
 * CU-83.1: Programa desactivación diferida
 * Body: { fecha }
 */
async function programarDesactivacion(req, res) {
  const { id } = req.params;
  const { fecha } = req.body;

  if (!fecha) {
    return res.status(400).json({ error: 'Debe seleccionar la fecha y hora de desactivación' });
  }

  // CU-83.1 Exc 1: fecha pasada
  if (isNaN(new Date(fecha).getTime()) || new Date(fecha) <= new Date()) {
    return res.status(400).json({ error: 'La fecha programada debe ser posterior a la actual' });
  }

  try {
    // CU-83.1 Exc 2: no programarse a sí mismo
    if (parseInt(id) === parseInt(req.user.id)) {
      return res.status(400).json({ error: 'No puede programar la desactivación de su propia cuenta' });
    }

    // OPUS-8: la programacion vive en la tabla usuario, no dentro del mensaje de
    // una notificacion. Antes el dato solo existia como JSON en notificacion, no se
    // podia consultar ni cancelar, y nada lo aplicaba si el usuario seguia logueado.
    const { rows } = await query(
      `UPDATE usuario
       SET usuario_desactivacion_programada = $1,
           usuario_fecha_de_ultima_edicion  = now()
       WHERE usuario_id_usuario = $2
       RETURNING usuario_username AS username, usuario_estado_cuenta AS estado`,
      [fecha, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Se mantiene la notificacion, ahora solo como aviso
    try {
      const { crearNotificacion } = require('./notificacionesController');
      await crearNotificacion({
        tipo: 'programacion_desactivacion',
        mensaje: `La cuenta de ${rows[0].username} se desactivará el ${new Date(fecha).toLocaleString('es-CL')}`,
        origen: 'usuarios',
        usuarioIds: [req.user.id]
      });
    } catch (e) { console.warn('No se pudo notificar la programación:', e.message); }

    await audLog.registrar(req.user?.id, 'programar_desactivacion', `usuario_id: ${id} (${rows[0].username}), fecha: ${fecha}`);
    res.json({
      message: `Desactivación de ${rows[0].username} programada para ${new Date(fecha).toLocaleString('es-CL')}`,
      desactivacion_programada: fecha
    });
  } catch (err) {
    console.error('Error programando desactivación:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/usuarios/:id/programar-activacion
 * CU-83.2: Programa activación diferida
 * Body: { fecha }
 */
async function programarActivacion(req, res) {
  const { id } = req.params;
  const { fecha } = req.body;

  if (!fecha) {
    return res.status(400).json({ error: 'Debe seleccionar la fecha y hora de activación' });
  }
  if (isNaN(new Date(fecha).getTime()) || new Date(fecha) <= new Date()) {
    return res.status(400).json({ error: 'La fecha programada debe ser posterior a la actual' });
  }

  try {
    const { rows } = await query(
      `UPDATE usuario
       SET usuario_activacion_programada   = $1,
           usuario_fecha_de_ultima_edicion = now()
       WHERE usuario_id_usuario = $2
       RETURNING usuario_username AS username`,
      [fecha, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    try {
      const { crearNotificacion } = require('./notificacionesController');
      await crearNotificacion({
        tipo: 'programacion_activacion',
        mensaje: `La cuenta de ${rows[0].username} se reactivará el ${new Date(fecha).toLocaleString('es-CL')}`,
        origen: 'usuarios',
        usuarioIds: [req.user.id]
      });
    } catch (e) { console.warn('No se pudo notificar la programación:', e.message); }

    await audLog.registrar(req.user?.id, 'programar_activacion', `usuario_id: ${id} (${rows[0].username}), fecha: ${fecha}`);
    res.json({
      message: `Activación de ${rows[0].username} programada para ${new Date(fecha).toLocaleString('es-CL')}`,
      activacion_programada: fecha
    });
  } catch (err) {
    console.error('Error programando activación:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * DELETE /api/usuarios/:id/programacion?tipo=desactivacion|activacion
 * OPUS-8: cancelar una programacion pendiente. Antes no habia forma de deshacerla.
 */
async function cancelarProgramacion(req, res) {
  const { id } = req.params;
  const tipo = req.query.tipo === 'activacion' ? 'activacion' : 'desactivacion';
  const columna = tipo === 'activacion'
    ? 'usuario_activacion_programada'
    : 'usuario_desactivacion_programada';

  try {
    const { rows } = await query(
      `UPDATE usuario
       SET ${columna} = NULL, usuario_fecha_de_ultima_edicion = now()
       WHERE usuario_id_usuario = $1
       RETURNING usuario_username AS username`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    await audLog.registrar(req.user?.id, 'cancelar_programacion',
      `usuario_id: ${id} (${rows[0].username}), tipo: ${tipo}`);
    res.json({ message: `Programación de ${tipo} cancelada para ${rows[0].username}` });
  } catch (err) {
    console.error('Error cancelando programación:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/usuarios/procesar-programaciones
 * Aplica las programaciones vencidas. Se llama desde el dashboard al cargar.
 *
 * OPUS-8: lee las columnas de `usuario` en vez de parsear JSON de notificaciones.
 * El middleware de auth aplica la desactivacion al usuario afectado en su proximo
 * request; esto cubre a los usuarios que NO estan conectados.
 */
async function procesarProgramaciones(req, res) {
  try {
    const { rows: desactivados } = await query(
      `UPDATE usuario
       SET usuario_estado_cuenta = 'inactivo',
           usuario_desactivacion_programada = NULL,
           usuario_fecha_de_ultima_edicion = now()
       WHERE usuario_desactivacion_programada IS NOT NULL
         AND usuario_desactivacion_programada <= now()
       RETURNING usuario_id_usuario AS id, usuario_username AS username`
    );

    const { rows: activados } = await query(
      `UPDATE usuario
       SET usuario_estado_cuenta = 'activo',
           usuario_activacion_programada = NULL,
           usuario_fecha_de_ultima_edicion = now()
       WHERE usuario_activacion_programada IS NOT NULL
         AND usuario_activacion_programada <= now()
       RETURNING usuario_id_usuario AS id, usuario_username AS username`
    );

    for (const u of [...desactivados, ...activados]) {
      const esDesactivacion = desactivados.some(d => d.id === u.id);
      const accionTexto = esDesactivacion ? 'desactivada' : 'activada';
      try {
        const { notificarPorRol } = require('./notificacionesController');
        await notificarPorRol({
          tipo: 'programacion_ejecutada',
          mensaje: `La cuenta de ${u.username} ha sido ${accionTexto} automáticamente según la programación establecida.`,
          origen: 'usuarios',
          rol: 'gerencia'
        });
      } catch (e) { console.warn('No se pudo notificar programación ejecutada:', e.message); }

      // D59: la ejecución es automática; quien abrió el dashboard solo la disparó
      await audLog.registrar(audLog.USUARIO_SISTEMA, 'programacion_ejecutada',
        `Usuario ${u.username} (ID ${u.id}) ${esDesactivacion ? 'desactivado' : 'activado'} automáticamente`);
    }

    res.json({
      procesadas: desactivados.length + activados.length,
      desactivados: desactivados.map(u => u.username),
      activados: activados.map(u => u.username)
    });
  } catch (err) {
    console.error('Error procesando programaciones:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * Middleware: CU-81.1 — Detectar extracción masiva de información
 * Cuenta exportaciones del usuario en los últimos 5 minutos
 */
async function deteccionExtraccionMasiva(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return next();

    const { rows } = await query(
      `SELECT COUNT(*) AS total FROM reporte
       WHERE usuario_id_usuario = $1
         AND reporte_tipo_reporte LIKE 'auditoria:exportar_%'
         AND reporte_fecha_generacion >= now() - INTERVAL '5 minutes'`,
      [userId]
    );

    const umbral = 10;
    if (parseInt(rows[0]?.total || 0) >= umbral) {
      // CU-88 Exc 1: Si es gerencia, registrar pero NO bloquear
      if (req.user?.rol === 'gerencia') {
        audLog.registrar(userId, 'exportar_reporte_masivo', `Ruta: ${req.path} (gerencia — no bloqueado)`);
        return next();
      }

      const { notificarPorRol } = require('./notificacionesController');
      notificarPorRol({
        tipo: 'extraccion_masiva',
        mensaje: `Alerta de seguridad: El usuario ID ${userId} ha realizado ${rows[0].total} exportaciones en los últimos 5 minutos.`,
        origen: 'seguridad',
        rol: 'gerencia'
      });

      return res.status(429).json({
        error: 'Se ha detectado un volumen inusual de exportaciones. La acción ha sido bloqueada temporalmente y se ha notificado a Gerencia.'
      });
    }

    // Registrar la exportación actual
    audLog.registrar(userId, 'exportar_reporte', `Ruta: ${req.path}`);
    next();
  } catch {
    // Middleware de detección: si falla, nunca debe bloquear la exportación
    next();
  }
}

module.exports = {
  listar, crear, editarPermisos, recuperarPassword, auditoria,
  programarDesactivacion, cancelarProgramacion, programarActivacion, procesarProgramaciones,
  deteccionExtraccionMasiva
};
