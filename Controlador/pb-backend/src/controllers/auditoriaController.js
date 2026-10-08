const { query } = require('../db/pool');

/**
 * D59: las acciones automáticas (timer, programaciones de cuentas) se auditan a nombre
 * del sistema con id_usuario = 0. No es una fila de `usuario` (la FK es blanda): así no
 * existe una cuenta "sistema" con la que alguien pueda intentar entrar.
 */
const USUARIO_SISTEMA = 0;
const MAX_CORTO = 100;   // registro_afectado y accion_realizada son VARCHAR(100)

/**
 * Registra una acción en la tabla de auditoría (FR-60).
 * Se llama desde otros controladores después de cada operación.
 * D59: vive en finanzas.evento_auditoria hasta el schema 4 común. Un detalle de más de
 * 100 caracteres se guarda completo en `observacion` y abreviado en `registro_afectado`
 * (antes el INSERT fallaba y el evento se perdía). Sin usuario → sistema.
 *
 * @param {number|null} usuarioId — null o undefined = acción del sistema
 * @param {string} accion   — ej: 'crear_material', 'editar_usuario', 'registrar_entrada'
 * @param {string} detalle  — descripción del registro afectado
 */
async function registrar(usuarioId, accion, detalle) {
  const texto = detalle == null ? null : String(detalle);
  const largo = texto != null && texto.length > MAX_CORTO;
  try {
    await query(
      `INSERT INTO finanzas.evento_auditoria (
         id_usuario,
         accion_realizada,
         entidad_afectada,
         registro_afectado,
         observacion
       ) VALUES ($1, $2, $3, $4, $5)`,
      [usuarioId ?? USUARIO_SISTEMA, String(accion).slice(0, MAX_CORTO), 'inventario',
       largo ? texto.slice(0, MAX_CORTO - 1) + '…' : texto, largo ? texto : null]
    );
  } catch (err) {
    // La auditoría no debe romper el flujo principal
    console.error('❌ AUDITORÍA FALLÓ:', err.message, '| Params:', { usuarioId, accion, detalle });
  }
}

/**
 * GET /api/auditoria/acciones
 * Lista de acciones únicas disponibles para el filtro "Tipo de acción" (SONNET-6, Req #10).
 * Combina las mismas 3 fuentes que usuariosController.auditoria para que las opciones
 * coincidan con los datos realmente mostrados en esa vista.
 */
async function listarAcciones(req, res) {
  try {
    const { rows } = await query(
      `SELECT DISTINCT accion FROM (
         (SELECT 'registrar_movimiento' AS accion WHERE EXISTS (SELECT 1 FROM movimiento_inventario))
         UNION ALL
         (SELECT DISTINCT split_part(reporte_tipo_reporte, ':', 2) AS accion
          FROM reporte WHERE reporte_tipo_reporte LIKE 'auditoria:%')
         UNION ALL
         (SELECT DISTINCT accion_realizada AS accion FROM finanzas.evento_auditoria)
       ) t
       WHERE accion IS NOT NULL AND accion <> ''
       ORDER BY accion`
    );
    res.json(rows.map(r => r.accion));
  } catch (err) {
    console.error('Error listando acciones de auditoría:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = { registrar, listarAcciones, USUARIO_SISTEMA };
