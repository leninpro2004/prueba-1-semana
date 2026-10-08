const { query } = require('../db/pool');
const { ErrorNegocio, conTransaccion, responderError } = require('../db/tx');
const {
  tipoMovimientoId, motivoMovimientoId, motivoDevolucionConsumo,
  descontarFifo, reponerFifo, insertarMovimiento, resolverBodega,
} = require('../db/stock');
const auditoria = require('./auditoriaController');
const { ocultaMontos, quitarCampos } = require('../middleware/auth');
const { calcularDiferencial } = require('../db/desviaciones');
const { precioVigente } = require('../db/historico');
const { generarAlertasAutomaticas } = require('./alertasController');

/* ======================================================================
   OPUS-1 - Nucleo transaccional de consumos reales
   Todo lo que toca stock (inventario_bodega + material_orden_trabajo +
   movimiento_inventario) pasa por aqui dentro de un BEGIN/COMMIT unico.
   conTransaccion / ErrorNegocio / responderError viven en db/tx.js (OPUS-3),
   compartidos con pedidosController y reservasController.
   ====================================================================== */

const ESTADOS_OT_CERRADA = ['cancelada', 'finalizada', 'completada', 'cerrada'];

/** Carga la OT y valida que exista y este abierta (CU-89 Exc 4). */
async function cargarOTAbierta(client, id) {
  const { rows } = await client.query(
    `SELECT orden_trabajo_id_orden AS id, orden_trabajo_estado AS estado,
            proyecto_id_proyecto AS proyecto_id, usuario_id_usuario AS responsable_id
     FROM orden_trabajo WHERE orden_trabajo_id_orden = $1`,
    [id]
  );
  if (rows.length === 0) throw new ErrorNegocio(404, { error: 'Orden de trabajo no encontrada' });
  if (ESTADOS_OT_CERRADA.includes(String(rows[0].estado).toLowerCase())) {
    throw new ErrorNegocio(400, { error: 'No se pueden registrar consumos en una OT que no está abierta' });
  }
  return rows[0];
}

/**
 * Bodega/lote del ultimo movimiento vigente de este material en esta OT.
 * Es el destino natural al devolver stock por correccion o eliminacion.
 */
async function origenConsumoPrevio(client, otId, sku) {
  const { rows } = await client.query(
    `SELECT bodega_id_bodega AS bodega_id, lote_id_lote AS lote_id
     FROM movimiento_inventario
     WHERE orden_trabajo_id_orden = $1
       AND material_sku = $2
       AND movimiento_inventario_estado <> 'revertido'
     ORDER BY movimiento_inventario_fecha_hora DESC,
              movimiento_inventario_id_movimiento DESC
     LIMIT 1`,
    [otId, sku]
  );
  if (rows.length > 0) return rows[0];

  // Consumos anteriores a OPUS-1 no tienen movimiento vinculado a la OT:
  // caer a la bodega donde ese material tenga inventario.
  const { rows: fallback } = await client.query(
    `SELECT bodega_id_bodega AS bodega_id, lote_id_lote AS lote_id
     FROM inventario_bodega
     WHERE material_sku = $1
     ORDER BY inventario_bodega_cantidad_fisica DESC
     LIMIT 1`,
    [sku]
  );
  return fallback[0] || null;
}

/**
 * OPUS-9 (Req #1): el movimiento que genera un consumo hereda el trabajador
 * ASIGNADO A LA OT, no el usuario que lo registra. Cuando no son el mismo se
 * deja constancia de quien registro en la descripcion del movimiento: la
 * auditoria ya lo guarda, pero no se ve desde el historial de movimientos.
 */
async function autoriaMovimientoOT(client, ot, userId, nota) {
  if (!ot.responsable_id || String(ot.responsable_id) === String(userId)) {
    return { usuarioId: ot.responsable_id || userId || null, descripcion: nota };
  }
  const { rows } = await client.query(
    `SELECT usuario_username AS username FROM usuario WHERE usuario_id_usuario = $1`,
    [userId]
  );
  const quien = rows[0]?.username ? '@' + rows[0].username : 'usuario #' + userId;
  return { usuarioId: ot.responsable_id, descripcion: nota + ' · Registrado por ' + quien };
}

/**
 * Aplica al stock la diferencia de consumo real y deja el movimiento vinculado
 * a la OT (OPUS-1 / Req #1):
 *   delta > 0 -> salida  (se consumio mas): descuento FIFO
 *   delta < 0 -> entrada (se consumio menos): devolucion al inventario
 * delta == 0 no toca nada.
 */
async function aplicarDeltaConsumo(client, opts) {
  const { delta, sku, otId, ot, bodegaSolicitada, userId, nota } = opts;

  if (Math.abs(delta) < 1e-9) {
    return { bodega_id: bodegaSolicitada || null, movimiento_id: null, lotes: [] };
  }

  if (delta > 0) {
    const bodegaId = await resolverBodega(client, sku, bodegaSolicitada);
    const fifo     = await descontarFifo(client, sku, bodegaId, delta);
    const tipoId   = await tipoMovimientoId(client, 'salida');
    if (!tipoId) throw new ErrorNegocio(500, { error: 'No existe el tipo de movimiento "salida" en el catálogo' });

    const autoria = await autoriaMovimientoOT(client, ot, userId, nota);
    const movimientoId = await insertarMovimiento(client, {
      cantidad: delta, sku, bodegaId, loteId: fifo.lote_principal, usuarioId: autoria.usuarioId,
      tipoId, motivoId: await motivoMovimientoId(client, 'consumo_produccion'),
      descripcion: autoria.descripcion, proyectoId: ot.proyecto_id, otId
    });
    return { bodega_id: bodegaId, movimiento_id: movimientoId, lotes: fifo.lotes };
  }

  const origen   = await origenConsumoPrevio(client, otId, sku);
  const bodegaId = bodegaSolicitada || origen?.bodega_id;
  if (!bodegaId) {
    throw new ErrorNegocio(400, { error: 'No se pudo determinar la bodega a la que devolver el stock. Indique la bodega.' });
  }
  // Antes de tocar stock: sin este motivo la devolución no restaría del consumo
  const motivoId = await motivoDevolucionConsumo(client);

  const loteRepuesto = await reponerFifo(client, sku, bodegaId, -delta, origen?.lote_id);
  if (!loteRepuesto) {
    throw new ErrorNegocio(400, { error: `No existe inventario de ${sku} en la bodega #${bodegaId} donde devolver el stock.` });
  }

  const tipoId = await tipoMovimientoId(client, 'entrada');
  if (!tipoId) throw new ErrorNegocio(500, { error: 'No existe el tipo de movimiento "entrada" en el catálogo' });

  const autoria = await autoriaMovimientoOT(client, ot, userId, nota);
  const movimientoId = await insertarMovimiento(client, {
    cantidad: -delta, sku, bodegaId, loteId: loteRepuesto, usuarioId: autoria.usuarioId,
    tipoId, motivoId,
    descripcion: autoria.descripcion, proyectoId: ot.proyecto_id, otId
  });
  return { bodega_id: bodegaId, movimiento_id: movimientoId, lotes: [{ lote_id: loteRepuesto, cantidad: -delta }] };
}


/**
 * GET /api/ordenes-trabajo
 * Lista OTs con resumen de consumos
 * Query params: ?estado=&buscar=
 */
async function listar(req, res) {
  const { estado, buscar } = req.query;
  try {
    const { rows } = await query(
      `SELECT
         ot.orden_trabajo_id_orden                      AS id,
         ot.orden_trabajo_fecha_hora                    AS fecha,
         ot.orden_trabajo_estado                        AS estado,
         ot.proyecto_id_proyecto                        AS proyecto_id,
         p.codigo_proyecto                              AS proyecto_codigo,
         p.nombre_referencia                            AS proyecto_nombre,
         at.area_trabajo_nombre_area                    AS area,
         ot.area_trabajo_id_area                        AS area_id,   -- D65: pinturas fija el área de la OT
         u.usuario_username                             AS responsable,
         COUNT(mot.material_sku)                        AS total_materiales,
         COUNT(CASE WHEN mot.material_orden_trabajo_consumo_estimado IS NOT NULL THEN 1 END) AS con_estimado,
         COUNT(CASE WHEN mot.material_orden_trabajo_consumo_real IS NOT NULL THEN 1 END) AS con_real
       FROM orden_trabajo ot
       LEFT JOIN terreno.proyecto p ON p.id_proyecto = ot.proyecto_id_proyecto
       LEFT JOIN area_trabajo at    ON at.area_trabajo_id_area = ot.area_trabajo_id_area
       LEFT JOIN usuario u          ON u.usuario_id_usuario = ot.usuario_id_usuario
       LEFT JOIN material_orden_trabajo mot ON mot.orden_trabajo_id_orden = ot.orden_trabajo_id_orden
       WHERE ($1::text IS NULL OR ot.orden_trabajo_estado = $1)
         AND ($2::text IS NULL OR
              p.codigo_proyecto ILIKE '%' || $2 || '%' OR
              p.nombre_referencia ILIKE '%' || $2 || '%')
       GROUP BY ot.orden_trabajo_id_orden, ot.orden_trabajo_fecha_hora,
                ot.orden_trabajo_estado, ot.proyecto_id_proyecto,
                p.codigo_proyecto, p.nombre_referencia,
                at.area_trabajo_nombre_area, ot.area_trabajo_id_area, u.usuario_username
       ORDER BY ot.orden_trabajo_fecha_hora DESC`,
      [estado || null, buscar || null]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listando OTs:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/ordenes-trabajo/:id/consumos
 * Lista materiales con consumo estimado y real de una OT (CU-89B)
 */
async function consultarConsumos(req, res) {
  const { id } = req.params;
  try {
    // Verificar que la OT existe
    const { rows: ot } = await query(
      `SELECT ot.orden_trabajo_id_orden AS id, ot.orden_trabajo_estado AS estado,
              ot.proyecto_id_proyecto AS proyecto_id,
              -- R1: área de la OT y receta cargada
              ot.area_trabajo_id_area AS area_id, a.area_trabajo_nombre_area AS area,
              ot.producto_terminado_id_producto AS receta_id, ot.orden_trabajo_cantidad_puertas AS cantidad_puertas,
              pt.producto_terminado_codigo_producto AS receta_codigo, pt.producto_terminado_nombre_producto AS receta_nombre
       FROM orden_trabajo ot
       LEFT JOIN area_trabajo a ON a.area_trabajo_id_area = ot.area_trabajo_id_area
       LEFT JOIN producto_terminado pt ON pt.producto_terminado_id_producto = ot.producto_terminado_id_producto
       WHERE ot.orden_trabajo_id_orden = $1`,
      [id]
    );
    if (ot.length === 0) {
      return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
    }

    // CU-89B Exc 1: sin consumos
    // R1: el real de una PINTURA se lee en vivo del Seguimiento de pinturas (lo que ya
    // descontó el pesaje), y una pintura con retiros en esta OT aparece aunque no esté
    // en material_orden_trabajo. Así la pestaña Consumo nunca muestra un valor viejo.
    const { rows: materiales } = await query(
      `WITH seg AS (
         SELECT material_sku, SUM(stock_descontado_kg) AS kg,
                COUNT(*) FILTER (WHERE estado = 'abierto')::int AS abiertos
         FROM seguimiento_pintura
         WHERE orden_trabajo_id_orden = $1 AND estado <> 'anulado'
         GROUP BY material_sku
       ), filas AS (
         SELECT material_sku, orden_trabajo_id_orden,
                material_orden_trabajo_consumo_estimado, material_orden_trabajo_consumo_real
         FROM material_orden_trabajo WHERE orden_trabajo_id_orden = $1
         UNION ALL
         SELECT seg.material_sku, $1, NULL, NULL FROM seg
         WHERE NOT EXISTS (SELECT 1 FROM material_orden_trabajo x
                           WHERE x.orden_trabajo_id_orden = $1 AND x.material_sku = seg.material_sku)
       )
       SELECT
         mot.material_sku                             AS sku,
         m.material_nombre_material                   AS nombre,
         m.material_estado                            AS estado_material,
         m.material_material_critico                  AS es_critico,
         r.es_pintura,                                                    -- R1
         COALESCE(seg.abiertos, 0)                    AS pintura_retiros_abiertos,
         u.material_unidad_medida_nombre              AS unidad,
         mot.material_orden_trabajo_consumo_estimado  AS estimado,
         r.real                                       AS real,
         -- Precio vigente del proveedor principal
         mp.material_proveedor_precio_referencial     AS precio_unitario,
         -- OPUS-1: stock disponible actual (todas las bodegas) para mostrarlo
         -- junto al input de consumo real
         COALESCE((SELECT SUM(ib.inventario_bodega_cantidad_fisica
                            - ib.inventario_bodega_cantidad_reservada)
                   FROM inventario_bodega ib
                   WHERE ib.material_sku = mot.material_sku), 0) AS stock_disponible,
         -- OPUS-3: alerta de faltante abierta para este material en el proyecto de la OT
         falt.alerta_faltante_pedido_id_alerta_faltante AS alerta_faltante_id,
         falt.alerta_faltante_pedido_estado             AS alerta_faltante_estado,
         falt.alerta_faltante_pedido_cantidad_requerida AS alerta_faltante_requerido,
         CASE
           WHEN r.real IS NOT NULL
                AND mot.material_orden_trabajo_consumo_estimado IS NOT NULL
           THEN r.real - mot.material_orden_trabajo_consumo_estimado
           ELSE NULL
         END AS varianza
       FROM filas mot
       JOIN material m ON m.material_sku = mot.material_sku
       LEFT JOIN seg ON seg.material_sku = mot.material_sku
       CROSS JOIN LATERAL (
         SELECT (m.es_material_pintura_custom IS TRUE OR m.es_material_pintura_no_custom IS TRUE) AS es_pintura,
                CASE WHEN (m.es_material_pintura_custom IS TRUE OR m.es_material_pintura_no_custom IS TRUE)
                          AND seg.material_sku IS NOT NULL
                     THEN seg.kg ELSE mot.material_orden_trabajo_consumo_real END AS real
       ) r
       LEFT JOIN material_unidad_medida u
              ON u.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
       LEFT JOIN material_proveedor mp
              ON mp.material_sku = mot.material_sku
             AND mp.material_proveedor_proveedor_principal = TRUE
       LEFT JOIN LATERAL (
         SELECT afp.alerta_faltante_pedido_id_alerta_faltante,
                afp.alerta_faltante_pedido_estado,
                afp.alerta_faltante_pedido_cantidad_requerida
         FROM alerta_faltante_pedido afp
         WHERE afp.material_sku = mot.material_sku
           AND afp.proyecto_id_proyecto IS NOT DISTINCT FROM $2::bigint
           AND afp.alerta_faltante_pedido_estado IN ('activa', 'en_gestion', 'solicitud_emitida')
         ORDER BY afp.alerta_faltante_pedido_id_alerta_faltante DESC
         LIMIT 1
       ) falt ON TRUE
       WHERE mot.orden_trabajo_id_orden = $1
       ORDER BY m.material_nombre_material`,
      [id, ot[0].proyecto_id || null]
    );

    // Montos ocultos a jop en el backend
    if (ocultaMontos(req)) quitarCampos(materiales, ['precio_unitario']);

    res.json({
      orden: ot[0],
      materiales,
      resumen: {
        total: materiales.length,
        con_estimado: materiales.filter(m => m.estimado != null).length,
        con_real: materiales.filter(m => m.real != null).length,
        con_alerta_faltante: materiales.filter(m => m.alerta_faltante_id != null).length
      }
    });
  } catch (err) {
    console.error('Error consultando consumos OT:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/ordenes-trabajo/:id/consumos
 * Registrar consumo real de un material en una OT (CU-89, CU-90)
 * Body: { sku, cantidad, bodega_id?, modo? }   modo: 'sumar' | 'actualizar'
 *
 * OPUS-1: descuento FIFO + material_orden_trabajo + movimiento_inventario van
 * en UNA sola transaccion. Si algo falla se hace ROLLBACK, de modo que nunca
 * queda stock descontado sin consumo registrado (ni al reves).
 */
async function registrarConsumo(req, res) {
  const { id } = req.params;
  const { sku, cantidad, bodega_id, modo } = req.body;
  const userId = req.user.id;
  const cantidadNum = parseFloat(cantidad);

  // CU-89 Exc 1
  if (!sku || isNaN(cantidadNum) || cantidadNum <= 0) {
    return res.status(400).json({ error: 'SKU y cantidad positiva son requeridos' });
  }

  try {
    const r = await conTransaccion(async (client) => {
      const ot = await cargarOTAbierta(client, id);

      // CU-89 Exc 2: el producto debe existir
      const { rows: mat } = await client.query(
        `SELECT material_sku FROM material WHERE material_sku = $1`, [sku]
      );
      if (mat.length === 0) {
        throw new ErrorNegocio(404, { error: 'El SKU no corresponde a un producto registrado' });
      }

      // CU-89 Exc 3 / CU-96 CP3: el conflicto se resuelve ANTES de tocar stock.
      // (antes se descontaba primero y recien despues se devolvia el 409, dejando
      //  el stock descontado sin consumo asociado)
      const { rows: existente } = await client.query(
        `SELECT material_orden_trabajo_consumo_real AS real_actual
         FROM material_orden_trabajo
         WHERE material_sku = $1 AND orden_trabajo_id_orden = $2
         FOR UPDATE`,
        [sku, id]
      );
      const yaTieneReal     = existente.length > 0 && existente[0].real_actual != null;
      const consumoAnterior = yaTieneReal ? parseFloat(existente[0].real_actual) : 0;

      if (yaTieneReal && !modo) {
        throw new ErrorNegocio(409, {
          error: 'conflicto_consumo_existente',
          message: `El material ${sku} ya tiene consumo registrado (${consumoAnterior}). ¿Desea sumar o actualizar?`,
          consumo_actual: consumoAnterior,
          cantidad_nueva: cantidadNum,
        });
      }

      const accion = !yaTieneReal ? 'nuevo'
                   : modo === 'actualizar' ? 'actualizado'
                   : 'sumado';

      // En 'actualizar' el stock solo debe moverse por la DIFERENCIA: antes se
      // descontaba la cantidad completa, duplicando el descuento del consumo previo.
      const consumoFinal = accion === 'actualizado' ? cantidadNum : consumoAnterior + cantidadNum;
      const delta        = consumoFinal - consumoAnterior;

      const nota = accion === 'actualizado'
        ? `Corrección de consumo real OT #${id} (${consumoAnterior} → ${consumoFinal})`
        : `Consumo real OT #${id}`;

      const mov = await aplicarDeltaConsumo(client, {
        delta, sku, otId: id, ot, bodegaSolicitada: bodega_id, userId, nota
      });

      await client.query(
        `INSERT INTO material_orden_trabajo
           (material_sku, orden_trabajo_id_orden, material_orden_trabajo_consumo_real)
         VALUES ($1, $2, $3)
         ON CONFLICT (material_sku, orden_trabajo_id_orden)
         DO UPDATE SET material_orden_trabajo_consumo_real = EXCLUDED.material_orden_trabajo_consumo_real`,
        [sku, id, consumoFinal]
      );

      // CU-90 Exc 2: advertir si el material no tiene precio de referencia
      const { rows: precio } = await client.query(
        `SELECT material_proveedor_precio_referencial AS precio
         FROM material_proveedor
         WHERE material_sku = $1 AND material_proveedor_proveedor_principal = TRUE`,
        [sku]
      );

      return {
        accion, consumoAnterior, consumoFinal, delta,
        bodega_id: mov.bodega_id,
        movimiento_id: mov.movimiento_id,
        sinPrecio: !precio[0]?.precio
      };
    });

    const detalleAuditoria = r.accion === 'sumado'
      ? `Consumo acumulado en OT #${id}: SKU ${sku}, cantidad ${cantidadNum} (total: ${r.consumoFinal})`
      : r.accion === 'actualizado'
      ? `Consumo actualizado en OT #${id}: SKU ${sku}, anterior: ${r.consumoAnterior}, nuevo: ${r.consumoFinal}`
      : `Consumo registrado en OT #${id}: SKU ${sku}, cantidad ${cantidadNum}`;
    await auditoria.registrar(userId, 'Registrar consumo OT', detalleAuditoria);
    generarAlertasAutomaticas().catch(e => console.warn('Alertas:', e.message));

    // CU-96 CP3: mensaje diferenciado segun la accion realizada
    const msgConsumo = r.accion === 'sumado'
      ? `El material ${sku} ya tenía consumo registrado (${r.consumoAnterior}). Se sumó ${cantidadNum}. Nuevo total: ${r.consumoFinal}`
      : r.accion === 'actualizado'
      ? `El material ${sku} tenía consumo registrado (${r.consumoAnterior}). Se actualizó a ${r.consumoFinal}.`
      : 'Consumo registrado correctamente';

    res.status(201).json({
      message: msgConsumo,
      accion: r.accion,
      consumo_real: r.consumoFinal,
      bodega_id: r.bodega_id,
      movimiento_id: r.movimiento_id,
      ...(r.accion !== 'nuevo' && { consumo_anterior: r.consumoAnterior, consumo_nuevo: r.consumoFinal }),
      sin_precio: r.sinPrecio,
      ...(r.sinPrecio && { advertencia: 'Producto sin precio unitario. Costo marcado como pendiente de valorización.' })
    });
  } catch (err) {
    responderError(res, err, 'Error registrando consumo:');
  }
}

/**
 * PUT /api/ordenes-trabajo/:id/consumos/:sku
 * Corregir el consumo real ya registrado de un material (OPUS-1 Paso 3).
 * Body: { cantidad, bodega_id? }   cantidad >= 0 (0 = revertir el consumo completo)
 *
 * Ajusta el stock SOLO por la diferencia: si sube descuenta por FIFO, si baja
 * devuelve al inventario. Todo dentro de una transaccion.
 */
async function editarConsumo(req, res) {
  const { id, sku } = req.params;
  const { cantidad, bodega_id } = req.body;
  const userId = req.user?.id;
  const cantidadNum = parseFloat(cantidad);

  if (cantidad == null || isNaN(cantidadNum) || cantidadNum < 0) {
    return res.status(400).json({ error: 'El consumo real no puede ser negativo.' });
  }

  try {
    const r = await conTransaccion(async (client) => {
      const ot = await cargarOTAbierta(client, id);

      const { rows: existente } = await client.query(
        `SELECT material_orden_trabajo_consumo_real AS real_actual
         FROM material_orden_trabajo
         WHERE material_sku = $1 AND orden_trabajo_id_orden = $2
         FOR UPDATE`,
        [sku, id]
      );
      if (existente.length === 0) {
        throw new ErrorNegocio(404, { error: 'Material no encontrado en esta orden' });
      }
      if (existente[0].real_actual == null) {
        throw new ErrorNegocio(400, { error: 'Este material no tiene consumo real registrado. Use "Registrar consumo".' });
      }

      const consumoAnterior = parseFloat(existente[0].real_actual);
      const delta           = cantidadNum - consumoAnterior;

      const mov = await aplicarDeltaConsumo(client, {
        delta, sku, otId: id, ot, bodegaSolicitada: bodega_id, userId,
        nota: `Corrección de consumo real OT #${id} (${consumoAnterior} → ${cantidadNum})`
      });

      await client.query(
        `UPDATE material_orden_trabajo
         SET material_orden_trabajo_consumo_real = $1
         WHERE material_sku = $2 AND orden_trabajo_id_orden = $3`,
        [cantidadNum, sku, id]
      );

      return { consumoAnterior, consumoFinal: cantidadNum, delta, ...mov };
    });

    await auditoria.registrar(userId, 'Editar consumo OT',
      `Consumo corregido en OT #${id}: SKU ${sku}, anterior: ${r.consumoAnterior}, nuevo: ${r.consumoFinal}`);
    generarAlertasAutomaticas().catch(e => console.warn('Alertas:', e.message));

    res.json({
      message: r.delta === 0
        ? 'El consumo real no cambió.'
        : r.delta > 0
          ? `Consumo actualizado a ${r.consumoFinal}. Se descontaron ${r.delta} del inventario.`
          : `Consumo actualizado a ${r.consumoFinal}. Se devolvieron ${-r.delta} al inventario.`,
      consumo_anterior: r.consumoAnterior,
      consumo_real: r.consumoFinal,
      diferencia_stock: r.delta,
      bodega_id: r.bodega_id,
      movimiento_id: r.movimiento_id
    });
  } catch (err) {
    responderError(res, err, 'Error editando consumo:');
  }
}

/**
 * PUT /api/ordenes-trabajo/:id/estimados
 * Registrar o actualizar consumo estimado (CU-91, CU-91B)
 * Body: { materiales: [{ sku, cantidad_estimada }] }
 *
 * OPUS-4: antes el loop escribia material por material SIN transaccion y sin
 * validar que el SKU existiera. Un SKU inexistente en medio del lote reventaba
 * con FK violation -> 500, dejando guardados los materiales anteriores y
 * perdiendo los siguientes (de ahi el "los estimados no se registran completos").
 *
 * Ahora: se valida TODO el lote primero y recien despues se escribe, todo dentro
 * de una transaccion. Si cualquier material es invalido no se guarda ninguno y la
 * respuesta dice exactamente cual fallo y por que.
 */
async function registrarEstimados(req, res) {
  const { id } = req.params;
  const { materiales } = req.body;

  if (!Array.isArray(materiales) || materiales.length === 0) {
    return res.status(400).json({ error: 'Debe enviar al menos un material con cantidad estimada' });
  }

  try {
    const r = await conTransaccion(async (client) => {
      // CU-91 Exc 3: OT debe estar abierta
      const { rows: ot } = await client.query(
        `SELECT orden_trabajo_estado AS estado FROM orden_trabajo WHERE orden_trabajo_id_orden = $1`,
        [id]
      );
      if (ot.length === 0) {
        throw new ErrorNegocio(404, { error: 'Orden de trabajo no encontrada' });
      }
      if (['finalizada', 'completada', 'cerrada'].includes(String(ot[0].estado).toLowerCase())) {
        throw new ErrorNegocio(400, { error: 'No se pueden agregar estimaciones a órdenes cerradas' });
      }

      /* ── Fase 1: validar el lote COMPLETO antes de escribir nada ── */
      const errores = [];
      const vistos  = new Set();
      const items   = [];

      for (const item of materiales) {
        const sku = String(item?.sku || '').trim();
        const cantidad = parseFloat(item?.cantidad_estimada);

        if (!sku) {
          errores.push({ sku: item?.sku ?? null, error: 'Falta el SKU del material' });
          continue;
        }
        // CU-91 Exc 1
        if (item?.cantidad_estimada == null || isNaN(cantidad) || cantidad < 0) {
          errores.push({ sku, error: 'La cantidad debe ser un número mayor o igual a cero' });
          continue;
        }
        if (vistos.has(sku)) {
          errores.push({ sku, error: 'El material viene repetido en la lista' });
          continue;
        }
        vistos.add(sku);
        items.push({ sku, cantidad });
      }

      // El SKU tiene que existir: antes esto explotaba como FK violation a mitad del loop
      if (items.length > 0) {
        const { rows: existentes } = await client.query(
          `SELECT material_sku FROM material WHERE material_sku = ANY($1::text[])`,
          [items.map(i => i.sku)]
        );
        const conocidos = new Set(existentes.map(e => e.material_sku));
        for (const i of items) {
          if (!conocidos.has(i.sku)) {
            errores.push({ sku: i.sku, error: 'El SKU no corresponde a un producto registrado' });
          }
        }
      }

      if (errores.length > 0) {
        throw new ErrorNegocio(400, {
          error: errores.length === 1
            ? `No se guardó nada: ${errores[0].sku ?? 'un material'} — ${errores[0].error}`
            : `No se guardó nada: ${errores.length} material(es) de la lista tienen problemas.`,
          errores
        });
      }

      /* ── Fase 2: escribir, ya sabiendo que todo el lote es valido ── */
      const resultados = [];
      for (const { sku, cantidad } of items) {
        const { rows: previo } = await client.query(
          `SELECT material_orden_trabajo_consumo_estimado AS estimado,
                  material_orden_trabajo_consumo_real      AS real
           FROM material_orden_trabajo
           WHERE material_sku = $1 AND orden_trabajo_id_orden = $2
           FOR UPDATE`,
          [sku, id]
        );

        const existia    = previo.length > 0;
        const realActual = existia ? parseFloat(previo[0].real || 0) : 0;

        // CU-91B Exc 2: advertir si el real ya registrado supera el nuevo estimado
        const advertencia = realActual > cantidad
          ? 'El consumo real actual supera el nuevo estimado. La desviación será negativa.'
          : null;

        await client.query(
          `INSERT INTO material_orden_trabajo
             (material_sku, orden_trabajo_id_orden, material_orden_trabajo_consumo_estimado)
           VALUES ($1, $2, $3)
           ON CONFLICT (material_sku, orden_trabajo_id_orden)
           DO UPDATE SET material_orden_trabajo_consumo_estimado = EXCLUDED.material_orden_trabajo_consumo_estimado`,
          [sku, id, cantidad]
        );

        resultados.push({
          sku,
          cantidad_estimada: cantidad,
          [existia ? 'actualizado' : 'creado']: true,
          real_actual: realActual,
          advertencia
        });
      }

      return { resultados };
    });

    // CU-100 CP2: advertencias de desviacion
    const advertencias = r.resultados
      .filter(x => x.advertencia)
      .map(x => ({ sku: x.sku, real: x.real_actual || 0, estimado: x.cantidad_estimada }));

    await auditoria.registrar(req.user?.id, 'Registrar estimados OT',
      `Estimados registrados en OT #${id}: ${r.resultados.length} material(es) — ${r.resultados.map(x => `${x.sku}=${x.cantidad_estimada}`).join(', ')}`);

    res.json({
      message: `Estimados guardados correctamente (${r.resultados.length} material(es))`,
      guardados: r.resultados.length,
      resultados: r.resultados,
      ...(advertencias.length > 0 && { advertencias })
    });
  } catch (err) {
    responderError(res, err, 'Error registrando estimados:');
  }
}

/**
 * GET /api/ordenes-trabajo/:id/comparativo
 * Reporte estimado vs real (CU-92)
 */
async function comparativo(req, res) {
  const { id } = req.params;
  try {
    const { rows: ot } = await query(
      `SELECT orden_trabajo_id_orden AS id, orden_trabajo_estado AS estado
       FROM orden_trabajo WHERE orden_trabajo_id_orden = $1`,
      [id]
    );
    if (ot.length === 0) {
      return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
    }

    const { rows: materiales } = await query(
      `SELECT
         mot.material_sku                             AS sku,
         m.material_nombre_material                   AS nombre,
         u.material_unidad_medida_nombre              AS unidad,
         mot.material_orden_trabajo_consumo_estimado  AS estimado,
         mot.material_orden_trabajo_consumo_real      AS real,
         mp.material_proveedor_precio_referencial     AS precio_unitario
       FROM material_orden_trabajo mot
       JOIN material m ON m.material_sku = mot.material_sku
       LEFT JOIN material_unidad_medida u
              ON u.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
       LEFT JOIN material_proveedor mp
              ON mp.material_sku = mot.material_sku
             AND mp.material_proveedor_proveedor_principal = TRUE
       WHERE mot.orden_trabajo_id_orden = $1
       ORDER BY m.material_nombre_material`,
      [id]
    );

    // CU-92 Exc 1 y 2
    const sinEstimado = materiales.filter(m => m.estimado == null);
    const sinReal     = materiales.filter(m => m.real == null);
    const comparables = materiales.filter(m => m.estimado != null && m.real != null);

    // Calcular varianza para cada comparable
    const detalle = materiales.map(m => {
      const est  = parseFloat(m.estimado || 0);
      const real = parseFloat(m.real || 0);
      const precio = parseFloat(m.precio_unitario || 0);
      // Misma fórmula que los diferenciales de CU-103 (db/desviaciones.js)
      const d = calcularDiferencial(m.estimado, m.real);
      const varianza = m.estimado != null && d ? d.abs : null;
      const varianzaPct = d?.pct ?? null;
      const costoEstimado = est * precio;
      const costoReal     = real * precio;

      return {
        ...m,
        varianza,
        varianza_pct: varianzaPct != null ? Math.round(varianzaPct * 10) / 10 : null,
        costo_estimado: costoEstimado,
        costo_real: costoReal,
        costo_diferencia: costoReal - costoEstimado,
        sin_contraparte: (m.estimado == null && m.real != null) ? 'solo_real'
                       : (m.estimado != null && m.real == null) ? 'solo_estimado'
                       : null
      };
    });

    const resumen = {
      total_materiales: materiales.length,
      comparables: comparables.length,
      solo_estimado: sinReal.filter(m => m.estimado != null).length,
      solo_real: sinEstimado.filter(m => m.real != null).length,
      costo_total_estimado: detalle.reduce((s, d) => s + (d.costo_estimado || 0), 0),
      costo_total_real: detalle.reduce((s, d) => s + (d.costo_real || 0), 0)
    };
    // Montos ocultos a jop en el backend: ve estimado, real y varianza en cantidades
    if (ocultaMontos(req)) {
      quitarCampos(detalle, ['precio_unitario', 'costo_estimado', 'costo_real', 'costo_diferencia']);
      quitarCampos([resumen], ['costo_total_estimado', 'costo_total_real']);
    }

    res.json({ orden: ot[0], detalle, resumen });
  } catch (err) {
    console.error('Error generando comparativo:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/ordenes-trabajo/:id/costos
 * Consolidar costos de materiales (CU-93)
 */
async function costos(req, res) {
  const { id } = req.params;
  try {
    const { rows: ot } = await query(
      `SELECT ot.orden_trabajo_id_orden AS id, ot.orden_trabajo_estado AS estado,
              p.codigo_proyecto AS proyecto_codigo, p.nombre_referencia AS proyecto_nombre
       FROM orden_trabajo ot
       LEFT JOIN terreno.proyecto p ON p.id_proyecto = ot.proyecto_id_proyecto
       WHERE ot.orden_trabajo_id_orden = $1`,
      [id]
    );
    if (ot.length === 0) {
      return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
    }

    const { rows: materiales } = await query(
      `SELECT
         mot.material_sku                             AS sku,
         m.material_nombre_material                   AS nombre,
         u.material_unidad_medida_nombre              AS unidad,
         mot.material_orden_trabajo_consumo_real      AS cantidad_real,
         mp.material_proveedor_precio_referencial     AS precio_unitario
       FROM material_orden_trabajo mot
       JOIN material m ON m.material_sku = mot.material_sku
       LEFT JOIN material_unidad_medida u
              ON u.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
       LEFT JOIN material_proveedor mp
              ON mp.material_sku = mot.material_sku
             AND mp.material_proveedor_proveedor_principal = TRUE
       WHERE mot.orden_trabajo_id_orden = $1
         AND mot.material_orden_trabajo_consumo_real IS NOT NULL
       ORDER BY m.material_nombre_material`,
      [id]
    );

    const detalle = materiales.map(m => {
      const cant   = parseFloat(m.cantidad_real || 0);
      const precio = parseFloat(m.precio_unitario || 0);
      return {
        ...m,
        costo_linea: cant * precio,
        // CU-93 Exc 1
        sin_precio: !m.precio_unitario,
        // CU-93 Exc 2
        nota_precio: m.precio_unitario ? 'Precio vigente proveedor principal' : 'Estimado/Incompleto'
      };
    });

    const costoTotal   = detalle.reduce((s, d) => s + d.costo_linea, 0);
    const incompleto   = detalle.some(d => d.sin_precio);

    res.json({
      orden: ot[0],
      detalle,
      resumen: {
        costo_total_materiales: costoTotal,
        moneda: 'CLP',
        estado_calculo: incompleto ? 'Estimado/Incompleto' : 'Completo',
        total_insumos: detalle.length,
        sin_precio: detalle.filter(d => d.sin_precio).length
      }
    });
  } catch (err) {
    console.error('Error consolidando costos:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/ordenes-trabajo/:id/rentabilidad
 * Calcular precio sugerido con margen (CU-94)
 * Query params: ?margen=25 (porcentaje)
 */
async function rentabilidad(req, res) {
  const { id } = req.params;
  const margen = parseFloat(req.query.margen);

  // CU-94 Exc 3
  if (isNaN(margen) || margen <= 0) {
    return res.status(400).json({ error: 'El margen de utilidad debe ser un porcentaje válido mayor a 0' });
  }

  try {
    // Reutilizar lógica de costos
    const { rows: ot } = await query(
      `SELECT ot.orden_trabajo_id_orden AS id, ot.orden_trabajo_estado AS estado,
              p.codigo_proyecto AS proyecto_codigo, p.nombre_referencia AS proyecto_nombre
       FROM orden_trabajo ot
       LEFT JOIN terreno.proyecto p ON p.id_proyecto = ot.proyecto_id_proyecto
       WHERE ot.orden_trabajo_id_orden = $1`,
      [id]
    );

    if (ot.length === 0) {
      return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
    }

    const { rows: materiales } = await query(
      `SELECT
         mot.material_orden_trabajo_consumo_real      AS cantidad_real,
         mp.material_proveedor_precio_referencial     AS precio_unitario
       FROM material_orden_trabajo mot
       LEFT JOIN material_proveedor mp
              ON mp.material_sku = mot.material_sku
             AND mp.material_proveedor_proveedor_principal = TRUE
       WHERE mot.orden_trabajo_id_orden = $1
         AND mot.material_orden_trabajo_consumo_real IS NOT NULL`,
      [id]
    );

    // CU-94 Exc 1
    if (materiales.length === 0) {
      return res.status(400).json({ error: 'No existen datos de producción disponibles para analizar' });
    }

    const costoTotal = materiales.reduce((s, m) => {
      return s + (parseFloat(m.cantidad_real || 0) * parseFloat(m.precio_unitario || 0));
    }, 0);

    const incompleto = materiales.some(m => !m.precio_unitario);
    const precioSugerido = costoTotal * (1 + margen / 100);

    res.json({
      orden: ot[0],
      costo_materiales: costoTotal,
      margen_pct: margen,
      precio_sugerido: Math.round(precioSugerido),
      moneda: 'CLP',
      // CU-94 Exc 2
      advertencia: incompleto
        ? 'El precio sugerido se basa en datos incompletos. Algunos insumos no tienen precio registrado.'
        : null
    });
  } catch (err) {
    console.error('Error calculando rentabilidad:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * PUT /api/ordenes-trabajo/:id/empleado-tentativo
 * OPUS-7 (Req #9): asignar o quitar el empleado tentativo de la programacion.
 * Body: { empleado_id }  — null o vacio lo deja sin asignar (hereda el responsable).
 */
async function asignarEmpleadoTentativo(req, res) {
  const { id } = req.params;
  const { empleado_id } = req.body;

  try {
    const { rows: ot } = await query(
      `SELECT orden_trabajo_id_orden AS id, orden_trabajo_estado AS estado
       FROM orden_trabajo WHERE orden_trabajo_id_orden = $1`,
      [id]
    );
    if (ot.length === 0) {
      return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
    }

    let empleado = null;
    if (empleado_id) {
      const { rows: usr } = await query(
        `SELECT usuario_id_usuario AS id, usuario_username AS username, usuario_estado_cuenta AS estado
         FROM usuario WHERE usuario_id_usuario = $1`,
        [empleado_id]
      );
      if (usr.length === 0) {
        return res.status(404).json({ error: 'El empleado indicado no existe' });
      }
      if (!['activo', 'activa'].includes(usr[0].estado)) {
        return res.status(400).json({ error: 'No se puede asignar un empleado con la cuenta inactiva' });
      }
      empleado = usr[0];
    }

    await query(
      `UPDATE orden_trabajo SET empleado_tentativo_id = $1 WHERE orden_trabajo_id_orden = $2`,
      [empleado ? empleado.id : null, id]
    );

    await auditoria.registrar(req.user?.id, 'Asignar empleado tentativo',
      empleado
        ? `OT #${id}: empleado tentativo asignado a ${empleado.username}`
        : `OT #${id}: empleado tentativo removido (queda el responsable de la OT)`);

    res.json({
      message: empleado
        ? `Empleado tentativo actualizado a ${empleado.username}`
        : 'Empleado tentativo removido. Se usará el responsable de la OT.',
      empleado_tentativo_id: empleado ? empleado.id : null,
      empleado_tentativo: empleado ? empleado.username : null
    });
  } catch (err) {
    console.error('Error asignando empleado tentativo:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/* ── Eliminar material de OT ──────────────────── */
/**
 * DELETE /api/ordenes-trabajo/:id/materiales/:sku
 *
 * OPUS-1 Paso 4: antes usaba `pool.query` (no importado → ReferenceError en
 * runtime) y la columna `id_orden` (no existe: es orden_trabajo_id_orden).
 * Ahora es transaccional y, si el material tenia consumo real, DEVUELVE ese
 * stock al inventario y marca como 'revertido' los movimientos de la OT.
 */
const eliminarMaterial = async (req, res) => {
  const { id, sku } = req.params;
  const userId = req.user?.id;

  try {
    const r = await conTransaccion(async (client) => {
      const ot = await cargarOTAbierta(client, id);

      const { rows: mat } = await client.query(
        `SELECT material_orden_trabajo_consumo_real AS real_actual
         FROM material_orden_trabajo
         WHERE orden_trabajo_id_orden = $1 AND material_sku = $2
         FOR UPDATE`,
        [id, sku]
      );
      if (mat.length === 0) {
        throw new ErrorNegocio(404, { error: 'Material no encontrado en esta orden' });
      }

      const consumoReal = parseFloat(mat[0].real_actual) || 0;
      let bodegaDevuelta = null;

      if (consumoReal > 0) {
        const origen   = await origenConsumoPrevio(client, id, sku);
        bodegaDevuelta = origen?.bodega_id || null;
        if (!bodegaDevuelta) {
          throw new ErrorNegocio(400, { error: 'No se pudo determinar la bodega a la que devolver el stock de este consumo.' });
        }
        const loteRepuesto = await reponerFifo(client, sku, bodegaDevuelta, consumoReal, origen?.lote_id);
        if (!loteRepuesto) {
          throw new ErrorNegocio(400, { error: `No existe inventario de ${sku} en la bodega #${bodegaDevuelta} donde devolver el stock.` });
        }
        // Mismo criterio que movimientosController.revertir: se marcan los
        // movimientos originales, no se crea un contra-movimiento.
        await client.query(
          `UPDATE movimiento_inventario
           SET movimiento_inventario_estado = 'revertido'
           WHERE orden_trabajo_id_orden = $1
             AND material_sku = $2
             AND movimiento_inventario_estado <> 'revertido'`,
          [id, sku]
        );
      }

      await client.query(
        `DELETE FROM material_orden_trabajo
         WHERE orden_trabajo_id_orden = $1 AND material_sku = $2`,
        [id, sku]
      );

      return { consumoReal, bodegaDevuelta, proyecto_id: ot.proyecto_id };
    });

    await auditoria.registrar(userId, 'Eliminar material de OT',
      r.consumoReal > 0
        ? `Material SKU ${sku} eliminado de OT #${id}; se devolvieron ${r.consumoReal} al inventario (bodega #${r.bodegaDevuelta})`
        : `Material SKU ${sku} eliminado de OT #${id}`);
    generarAlertasAutomaticas().catch(e => console.warn('Alertas:', e.message));

    res.json({
      message: r.consumoReal > 0
        ? `Material eliminado. Se devolvieron ${r.consumoReal} unidades al inventario.`
        : 'Material eliminado de la orden de trabajo',
      stock_devuelto: r.consumoReal,
      bodega_id: r.bodegaDevuelta
    });
  } catch (err) {
    responderError(res, err, 'Error al eliminar material de OT:');
  }
};

/**
 * GET /api/ordenes-trabajo/:id/movimientos
 * Movimientos de inventario generados por esta OT (OPUS-9 / Req #1).
 * El vinculo lo da movimiento_inventario.orden_trabajo_id_orden (columna de OPUS-1).
 * Query params: ?tipo=&desde=&hasta=
 */
async function movimientosOT(req, res) {
  const { id } = req.params;
  const { tipo, desde, hasta } = req.query;

  try {
    const { rows: ot } = await query(
      `SELECT ot.orden_trabajo_id_orden AS id, ot.orden_trabajo_estado AS estado,
              ot.proyecto_id_proyecto   AS proyecto_id,
              u.usuario_username        AS responsable
       FROM orden_trabajo ot
       LEFT JOIN usuario u ON u.usuario_id_usuario = ot.usuario_id_usuario
       WHERE ot.orden_trabajo_id_orden = $1`,
      [id]
    );
    if (ot.length === 0) {
      return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
    }

    const { rows } = await query(
      `SELECT
         mi.movimiento_inventario_id_movimiento             AS id,
         mi.movimiento_inventario_fecha_hora                AS fecha_hora,
         mi.movimiento_inventario_cantidad                  AS cantidad,
         mi.movimiento_inventario_estado                    AS estado,
         mi.movimiento_inventario_descripcion_motivo        AS descripcion_motivo,
         mi.movimiento_inventario_evidencia_url             AS evidencia_url,
         mi.material_sku                                    AS sku,
         m.material_nombre_material                         AS material,
         um.material_unidad_medida_nombre                   AS unidad,
         b.bodega_nombre_bodega                             AS bodega,
         l.lote_numero_lote                                 AS lote,
         tm.movimiento_inventario_tipo_movimiento_nombre    AS tipo,
         mm.movimiento_inventario_motivo_movimiento_nombre  AS motivo,
         u.usuario_username                                 AS usuario
       FROM movimiento_inventario mi
       JOIN material m ON m.material_sku = mi.material_sku
       JOIN movimiento_inventario_tipo_movimiento tm
            ON tm.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
             = mi.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
       LEFT JOIN material_unidad_medida um
              ON um.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
       LEFT JOIN bodega b  ON b.bodega_id_bodega = mi.bodega_id_bodega
       LEFT JOIN lote l    ON l.lote_id_lote = mi.lote_id_lote
       LEFT JOIN usuario u ON u.usuario_id_usuario = mi.usuario_id_usuario
       LEFT JOIN movimiento_inventario_motivo_movimiento mm
            ON mm.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
             = mi.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
       WHERE mi.orden_trabajo_id_orden = $1
         AND ($2::text IS NULL OR tm.movimiento_inventario_tipo_movimiento_nombre ILIKE '%' || $2 || '%')
         AND ($3::date IS NULL OR mi.movimiento_inventario_fecha_hora >= $3::date)
         AND ($4::date IS NULL OR mi.movimiento_inventario_fecha_hora < ($4::date + INTERVAL '1 day'))
       ORDER BY mi.movimiento_inventario_fecha_hora DESC,
                mi.movimiento_inventario_id_movimiento DESC`,
      [id, tipo || null, desde || null, hasta || null]
    );

    const esTipo   = (r, t) => String(r.tipo || '').toLowerCase().includes(t);
    const vigentes = rows.filter(r => r.estado !== 'revertido');

    res.json({
      orden: ot[0],
      movimientos: rows,
      resumen: {
        total:      rows.length,
        entradas:   rows.filter(r => esTipo(r, 'entrada')).length,
        salidas:    rows.filter(r => esTipo(r, 'salida')).length,
        revertidos: rows.filter(r => r.estado === 'revertido').length,
        // Neto vigente: lo que efectivamente salio de bodega por esta OT
        // (las devoluciones por correccion de consumo restan)
        cantidad_neta: vigentes.reduce((acc, r) =>
          acc + (esTipo(r, 'salida') ? 1 : -1) * (parseFloat(r.cantidad) || 0), 0)
      }
    });
  } catch (err) {
    console.error('Error consultando movimientos de OT:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/* ══════════════════════════════════════════════════════════════════════
   CU-103: finalizar la OT y procesar sus diferenciales de consumo
   ══════════════════════════════════════════════════════════════════════ */

/** Estado que habilita el procesamiento de diferenciales (decisión del usuario, sesión 9). */
const ESTADO_FINALIZADA = 'finalizada';

/**
 * PUT /api/ordenes-trabajo/:id/finalizar — gerencia y jop.
 * Pasa la OT a 'finalizada'. Se bloquea (antes de escribir) si la OT no terminó de
 * verdad: reservas activas (dejarían stock apartado sin dueño) o retiros de pintura
 * sin devolver (su consumo todavía no se conoce). Una OT finalizada ya no admite
 * consumos ni estimados (cargarOTAbierta).
 */
async function finalizar(req, res) {
  const { id } = req.params;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la OT debe ser numérico' });
  try {
    await conTransaccion(async (client) => {
      const { rows: ot } = await client.query(
        `SELECT orden_trabajo_estado AS estado FROM orden_trabajo WHERE orden_trabajo_id_orden = $1 FOR UPDATE`, [id]
      );
      if (ot.length === 0) throw new ErrorNegocio(404, { error: 'Orden de trabajo no encontrada' });
      if (ESTADOS_OT_CERRADA.includes(String(ot[0].estado).toLowerCase())) {
        throw new ErrorNegocio(400, { error: `La orden de trabajo ya está ${ot[0].estado}.` });
      }
      const { rows: pend } = await client.query(
        `SELECT
           (SELECT COUNT(*) FROM reserva_inventario
            WHERE orden_trabajo_id_orden = $1 AND reserva_inventario_estado_reserva = 'activa')::int AS reservas,
           (SELECT COUNT(*) FROM seguimiento_pintura
            WHERE orden_trabajo_id_orden = $1 AND estado = 'abierto')::int AS retiros`,
        [id]
      );
      const { reservas, retiros } = pend[0];
      if (reservas > 0 || retiros > 0) {
        throw new ErrorNegocio(400, {
          error: 'No se puede finalizar: ' + [
            reservas > 0 && `${reservas} reserva(s) activa(s) (consúmalas o libérelas)`,
            retiros > 0 && `${retiros} retiro(s) de pintura sin devolver (registre el peso de devolución)`,
          ].filter(Boolean).join(' y ') + '.',
          reservas_activas: reservas, retiros_abiertos: retiros,
        });
      }
      // R1: el real de las pinturas queda con lo último del seguimiento, para las desviaciones
      await sincronizarPinturas(client, id);
      await client.query(
        `UPDATE orden_trabajo SET orden_trabajo_estado = $2 WHERE orden_trabajo_id_orden = $1`, [id, ESTADO_FINALIZADA]
      );
    });
    await auditoria.registrar(req.user?.id, 'finalizar_ot', `OT #${id} finalizada`);
    res.json({ message: `Orden de trabajo #${id} finalizada. Ya puede procesar sus diferenciales de consumo.` });
  } catch (err) {
    responderError(res, err, 'Error finalizando OT:');
  }
}

/**
 * Diferenciales procesados de una OT, con lo que la vista necesita. Los montos
 * (impacto en CLP) se quitan para jop en el backend (D36).
 */
async function armarDiferenciales(db, id, sinMontos) {
  const { rows: ot } = await db.query(
    `SELECT orden_trabajo_id_orden AS id, orden_trabajo_estado AS estado FROM orden_trabajo WHERE orden_trabajo_id_orden = $1`,
    [id]
  );
  if (ot.length === 0) throw new ErrorNegocio(404, { error: 'Orden de trabajo no encontrada' });

  const { rows: items } = await db.query(
    `SELECT d.material_sku AS sku, m.material_nombre_material AS nombre, u.material_unidad_medida_nombre AS unidad,
            d.diferencial_consumo_estimado::float AS estimado, d.diferencial_consumo_real::float AS real,
            d.diferencial_consumo_desviacion_abs::float AS desviacion_abs,
            d.diferencial_consumo_desviacion_pct::float AS desviacion_pct,
            d.diferencial_consumo_tipo AS tipo, d.diferencial_consumo_impacto_clp::float AS impacto_clp,
            d.diferencial_consumo_fecha AS fecha, us.usuario_username AS usuario
     FROM diferencial_consumo d
     JOIN material m ON m.material_sku = d.material_sku
     LEFT JOIN material_unidad_medida u ON u.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
     LEFT JOIN usuario us ON us.usuario_id_usuario = d.usuario_id_usuario
     WHERE d.orden_trabajo_id_orden = $1
     ORDER BY d.diferencial_consumo_impacto_clp DESC NULLS LAST, m.material_nombre_material`,
    [id]
  );
  // Planificados sin consumo registrado: se muestran aparte, nunca como ahorro del 100 %
  const { rows: sinConsumo } = await db.query(
    `SELECT mot.material_sku AS sku, m.material_nombre_material AS nombre,
            mot.material_orden_trabajo_consumo_estimado::float AS estimado
     FROM material_orden_trabajo mot JOIN material m ON m.material_sku = mot.material_sku
     WHERE mot.orden_trabajo_id_orden = $1
       AND mot.material_orden_trabajo_consumo_real IS NULL
       AND COALESCE(mot.material_orden_trabajo_consumo_estimado, 0) > 0
     ORDER BY m.material_nombre_material`,
    [id]
  );

  const cuenta = t => items.filter(i => i.tipo === t).length;
  const suma = t => items.filter(i => i.tipo === t).reduce((s, i) => s + (i.impacto_clp || 0), 0);
  const resumen = {
    items: items.length, sobre_gasto: cuenta('sobre_gasto'), ahorro: cuenta('ahorro'),
    sin_desviacion: cuenta('sin_desviacion'), sin_base: cuenta('sin_base'), sin_consumo_registrado: sinConsumo.length,
    impacto_sobre_gasto_clp: suma('sobre_gasto') + suma('sin_base'),
    impacto_ahorro_clp: suma('ahorro'),
    impacto_neto_clp: items.reduce((s, i) => s + (i.impacto_clp || 0), 0),
  };
  if (sinMontos) {
    quitarCampos(items, ['impacto_clp']);
    quitarCampos([resumen], ['impacto_sobre_gasto_clp', 'impacto_ahorro_clp', 'impacto_neto_clp']);
  }
  return {
    orden: ot[0],
    puede_procesar: ot[0].estado === ESTADO_FINALIZADA,
    procesado: items.length ? { fecha: items[0].fecha, usuario: items[0].usuario } : null,
    items: items.map(({ fecha, usuario, ...resto }) => resto),
    sin_consumo_registrado: sinConsumo,
    resumen,
  };
}

/** GET /api/ordenes-trabajo/:id/diferenciales — CU-103: lo procesado (gerencia y jop). */
async function consultarDiferenciales(req, res) {
  const { id } = req.params;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la OT debe ser numérico' });
  try {
    res.json(await armarDiferenciales({ query }, id, ocultaMontos(req)));
  } catch (err) {
    responderError(res, err, 'Error consultando diferenciales:');
  }
}

/**
 * CU-103: calcula y guarda los diferenciales de la OT, dentro de la transacción de quien llama. `fecha` es la de
 * la OT ('YYYY-MM-DD'): fija el precio vigente (D32). Exc 1 (sin estimado o sin real) → 400 SIN_DATOS. Reprocesar
 * actualiza las filas y borra las de materiales que ya no tienen real. Devuelve los SKU procesados.
 * La comparten el procesamiento (CU-103) y la corrección de una OT cerrada (D54).
 */
async function calcularDiferencialesOT(client, id, fecha, usuarioId) {
  const { rows: mats } = await client.query(
    `SELECT material_sku AS sku, material_orden_trabajo_consumo_estimado AS estimado,
            material_orden_trabajo_consumo_real AS real
     FROM material_orden_trabajo WHERE orden_trabajo_id_orden = $1`,
    [id]
  );
  const conEstimado = mats.some(m => parseFloat(m.estimado || 0) > 0);
  const conReal = mats.some(m => m.real != null);
  if (!conEstimado || !conReal) {
    throw new ErrorNegocio(400, {
      error: 'Diferencial N/A: la orden de trabajo no tiene ' +
             (!conEstimado && !conReal ? 'consumo estimado ni real' : !conEstimado ? 'consumo estimado' : 'consumo real') +
             ' registrado. No se procesó.',
      codigo: 'SIN_DATOS',
    });
  }

  const precios = await precioVigente(client, fecha);
  const procesados = [];
  for (const m of mats) {
    const d = calcularDiferencial(m.estimado, m.real);
    if (!d) continue;   // planificado sin consumo registrado: se omite
    const precio = precios.get(m.sku)?.precio;
    const impacto = precio == null ? null : Math.round(d.abs * precio * 100) / 100;
    await client.query(
      `INSERT INTO diferencial_consumo (orden_trabajo_id_orden, material_sku, diferencial_consumo_estimado,
         diferencial_consumo_real, diferencial_consumo_desviacion_abs, diferencial_consumo_desviacion_pct,
         diferencial_consumo_tipo, diferencial_consumo_impacto_clp, usuario_id_usuario)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (orden_trabajo_id_orden, material_sku) DO UPDATE SET
         diferencial_consumo_fecha = now(),
         diferencial_consumo_estimado = EXCLUDED.diferencial_consumo_estimado,
         diferencial_consumo_real = EXCLUDED.diferencial_consumo_real,
         diferencial_consumo_desviacion_abs = EXCLUDED.diferencial_consumo_desviacion_abs,
         diferencial_consumo_desviacion_pct = EXCLUDED.diferencial_consumo_desviacion_pct,
         diferencial_consumo_tipo = EXCLUDED.diferencial_consumo_tipo,
         diferencial_consumo_impacto_clp = EXCLUDED.diferencial_consumo_impacto_clp,
         usuario_id_usuario = EXCLUDED.usuario_id_usuario`,
      [id, m.sku, d.estimado, d.real, d.abs, d.pct == null ? null : Math.round(d.pct * 100) / 100,
       d.tipo, impacto, usuarioId]
    );
    procesados.push(m.sku);
  }
  // Reprocesar: lo que ya no tiene consumo real en la OT deja de estar en el historial
  await client.query(
    `DELETE FROM diferencial_consumo WHERE orden_trabajo_id_orden = $1 AND NOT (material_sku = ANY($2::text[]))`,
    [id, procesados]
  );
  return procesados;
}

/**
 * POST /api/ordenes-trabajo/:id/diferenciales — CU-103 (gerencia y jop).
 * Por cada ítem con consumo real: desviación = real − estimado, % = ÷ estimado × 100,
 * tipo (sobre_gasto / ahorro / sin_desviacion; sin estimado → sin_base, Exc 2) e
 * impacto = desviación × precio vigente a la fecha de la OT (precioVigente, D32).
 *  - Solo OTs 'finalizada'.
 *  - Exc 1: sin ningún ítem con estimado o sin ningún ítem con real → "N/A", no procesa.
 *  - Planificados sin consumo registrado: se omiten (no son ahorro) y se informan.
 *  - Reprocesar actualiza las filas (UNIQUE OT+SKU) y borra las de materiales que ya
 *    no tienen consumo real en la OT. Todo en una transacción.
 */
async function procesarDiferenciales(req, res) {
  const { id } = req.params;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la OT debe ser numérico' });
  try {
    const r = await conTransaccion(async (client) => {
      const { rows: ot } = await client.query(
        `SELECT orden_trabajo_estado AS estado, TO_CHAR(orden_trabajo_fecha_hora, 'YYYY-MM-DD') AS fecha
         FROM orden_trabajo WHERE orden_trabajo_id_orden = $1 FOR UPDATE`,
        [id]
      );
      if (ot.length === 0) throw new ErrorNegocio(404, { error: 'Orden de trabajo no encontrada' });
      if (ot[0].estado !== ESTADO_FINALIZADA) {
        throw new ErrorNegocio(400, {
          error: `Solo se procesan órdenes de trabajo finalizadas (esta está "${ot[0].estado}").`,
        });
      }

      const procesados = await calcularDiferencialesOT(client, id, ot[0].fecha, req.user.id);
      return { procesados: procesados.length };
    });

    await auditoria.registrar(req.user?.id, 'procesar_diferenciales', `OT #${id}: ${r.procesados} ítem(s)`);
    res.json({
      message: `Diferenciales de la OT #${id} procesados: ${r.procesados} ítem(s).`,
      ...await armarDiferenciales({ query }, id, ocultaMontos(req)),
    });
  } catch (err) {
    responderError(res, err, 'Error procesando diferenciales:');
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   R1: consumo en la OT desde la receta (docs/sprint/decisiones.md, R1)
   ══════════════════════════════════════════════════════════════════════════ */

const CANTIDAD_OT_RE = /^\d+(\.\d{1,4})?$/;

/**
 * Las pinturas no se descuentan desde la pestaña Consumo: su consumo real es lo que
 * descontó el Seguimiento de pinturas (pesaje, en kg). Se copia a material_orden_trabajo
 * SIN mover stock, para que CU-103/104 comparen estimado y real también en pinturas.
 */
async function sincronizarPinturas(client, otId) {
  await client.query(
    `INSERT INTO material_orden_trabajo (material_sku, orden_trabajo_id_orden, material_orden_trabajo_consumo_real)
     SELECT material_sku, $1, SUM(stock_descontado_kg)
     FROM seguimiento_pintura
     WHERE orden_trabajo_id_orden = $1 AND estado <> 'anulado'
     GROUP BY material_sku
     ON CONFLICT (material_sku, orden_trabajo_id_orden)
     DO UPDATE SET material_orden_trabajo_consumo_real = EXCLUDED.material_orden_trabajo_consumo_real`,
    [otId]
  );
}

/** Numero >= 0 con hasta 4 decimales (acepta coma). null si no es valido. */
function cantidadOT(v) {
  const t = String(v ?? '').trim().replace(',', '.');
  return CANTIDAD_OT_RE.test(t) ? Number(t) : null;
}

/**
 * PUT /api/ordenes-trabajo/:id/consumo
 * Body: { receta_id?, cantidad_puertas?, reemplazar_receta?, bodega_id?,
 *         lineas: [{ sku, estimado?, real }] }
 *
 * `lineas` es el estado COMPLETO deseado del consumo de la OT (pestaña Consumo):
 *  - "estimado" = columna "Según receta" (null en un material agregado a mano).
 *  - "real" = consumo real. El stock se mueve SOLO por la diferencia con lo ya
 *    registrado (aplicarDeltaConsumo: FIFO al subir, devolución al bajar).
 *  - Un material de la OT que no viene en la lista se quita: si tenía real, vuelve a bodega.
 *  - Pinturas: su real no se toma de aquí (sincronizarPinturas).
 * Todo en UNA transacción, validando la lista completa antes de tocar stock. Si falta
 * stock de un material, no se guarda nada.
 */
async function guardarConsumo(req, res) {
  const { id } = req.params;
  const b = req.body || {};
  const userId = req.user?.id;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la OT debe ser numérico' });

  try {
    const r = await conTransaccion(async (client) => {
      await client.query(`SELECT 1 FROM orden_trabajo WHERE orden_trabajo_id_orden = $1 FOR UPDATE`, [id]);
      const ot = await cargarOTAbierta(client, id);
      const { rows: [cab] } = await client.query(
        `SELECT producto_terminado_id_producto AS receta_id FROM orden_trabajo WHERE orden_trabajo_id_orden = $1`, [id]
      );

      /* ── 1. Validar el cuerpo completo ── */
      const errores = [];
      const recetaId = b.receta_id == null || b.receta_id === '' ? null : String(b.receta_id);
      let puertas = null;
      if (recetaId != null) {
        if (!/^\d+$/.test(recetaId)) errores.push({ sku: null, error: 'La receta no es válida.' });
        puertas = Number(b.cantidad_puertas);
        if (!Number.isInteger(puertas) || puertas < 1 || puertas > 1000) {
          errores.push({ sku: null, error: 'La cantidad de puertas debe ser un número entero entre 1 y 1000.' });
        }
      }
      const bodegaId = b.bodega_id == null || b.bodega_id === '' ? null : String(b.bodega_id);
      if (bodegaId != null && !/^\d+$/.test(bodegaId)) errores.push({ sku: null, error: 'La bodega no es válida.' });
      if (!Array.isArray(b.lineas)) errores.push({ sku: null, error: 'Falta la lista de materiales.' });

      const lineas = [];
      const vistos = new Set();
      for (const l of Array.isArray(b.lineas) ? b.lineas : []) {
        const sku = String(l?.sku ?? '').trim();
        if (!sku) { errores.push({ sku: null, error: 'Una fila no tiene material.' }); continue; }
        if (vistos.has(sku)) { errores.push({ sku, error: 'El material viene repetido en la lista.' }); continue; }
        vistos.add(sku);
        const estimado = l.estimado == null || l.estimado === '' ? null : cantidadOT(l.estimado);
        if (l.estimado != null && l.estimado !== '' && estimado == null) {
          errores.push({ sku, error: 'La cantidad según receta no es válida.' });
        }
        lineas.push({ sku, estimado, realTxt: l.real });
      }

      // Materiales: existen, no son herramientas; pinturas identificadas
      const skus = [...vistos];
      const { rows: mats } = skus.length ? await client.query(
        `SELECT material_sku AS sku, material_estado AS estado, material_es_herramienta AS herramienta,
                (es_material_pintura_custom IS TRUE OR es_material_pintura_no_custom IS TRUE) AS es_pintura
         FROM material WHERE material_sku = ANY($1::text[])`, [skus]
      ) : { rows: [] };
      const porSku = new Map(mats.map(m => [m.sku, m]));

      // Consumo ya registrado en la OT (bloqueado)
      const { rows: actuales } = await client.query(
        `SELECT material_sku AS sku, material_orden_trabajo_consumo_real AS real
         FROM material_orden_trabajo WHERE orden_trabajo_id_orden = $1 FOR UPDATE`, [id]
      );
      const registrado = new Map(actuales.map(a => [a.sku, a.real == null ? 0 : parseFloat(a.real)]));

      for (const l of lineas) {
        const m = porSku.get(l.sku);
        if (!m) { errores.push({ sku: l.sku, error: 'No existe en el catálogo.' }); continue; }
        if (m.herramienta) { errores.push({ sku: l.sku, error: 'Es una herramienta: no se consume.' }); continue; }
        l.esPintura = m.es_pintura === true;
        if (l.esPintura) continue;
        l.real = cantidadOT(l.realTxt);
        if (l.real == null) { errores.push({ sku: l.sku, error: 'El consumo real debe ser un número mayor o igual a 0, con hasta 4 decimales.' }); continue; }
        l.anterior = registrado.get(l.sku) ?? 0;
        l.delta = l.real - l.anterior;
        // Un material inactivo no admite movimientos (decisión de la sesión 10)
        if (Math.abs(l.delta) > 1e-9 && m.estado !== 'activo') {
          errores.push({ sku: l.sku, error: 'El material está inactivo: no se puede registrar ni corregir su consumo. Reactívelo o quítelo.' });
        }
      }

      // Materiales que se quitan: los de la OT que no vienen en la lista
      const { rows: pintSeg } = await client.query(
        `SELECT DISTINCT material_sku AS sku FROM seguimiento_pintura
         WHERE orden_trabajo_id_orden = $1 AND estado <> 'anulado'`, [id]
      );
      const conSeguimiento = new Set(pintSeg.map(p => p.sku));
      const quitados = actuales.filter(a => !vistos.has(a.sku));
      for (const q of quitados) {
        if (conSeguimiento.has(q.sku)) {
          errores.push({ sku: q.sku, error: 'Tiene usos en el Seguimiento de pinturas: no se puede quitar de la OT.' });
        }
      }

      // Receta: existe y está activa si se carga una nueva; reemplazar otra pide confirmación
      if (recetaId != null && errores.length === 0 && String(cab.receta_id ?? '') !== recetaId) {
        const { rows: rec } = await client.query(
          `SELECT producto_terminado_activo AS activo, producto_terminado_codigo_producto AS codigo
           FROM producto_terminado WHERE producto_terminado_id_producto = $1`, [recetaId]
        );
        if (!rec.length) errores.push({ sku: null, error: 'La receta no existe.' });
        else if (!rec[0].activo) errores.push({ sku: null, error: `La receta ${rec[0].codigo} está inactiva.` });
        else if (cab.receta_id != null && b.reemplazar_receta !== true) {
          const { rows: act } = await client.query(
            `SELECT producto_terminado_codigo_producto AS codigo, producto_terminado_nombre_producto AS nombre
             FROM producto_terminado WHERE producto_terminado_id_producto = $1`, [cab.receta_id]
          );
          throw new ErrorNegocio(409, {
            error: `Esta OT ya tiene cargada la receta ${act[0]?.codigo ?? '#' + cab.receta_id}. Confirme que quiere reemplazarla.`,
            codigo: 'RECETA_DISTINTA',
            receta_actual: { id: Number(cab.receta_id), codigo: act[0]?.codigo, nombre: act[0]?.nombre },
          });
        }
      }
      if (bodegaId != null && errores.length === 0) {
        const { rows: bod } = await client.query(`SELECT 1 FROM bodega WHERE bodega_id_bodega = $1`, [bodegaId]);
        if (!bod.length) errores.push({ sku: null, error: 'La bodega no existe.' });
      }

      if (errores.length > 0) {
        throw new ErrorNegocio(400, {
          error: errores.length === 1
            ? `No se guardó nada: ${errores[0].sku ? errores[0].sku + ' — ' : ''}${errores[0].error}`
            : `No se guardó nada: ${errores.length} problema(s) en la lista.`,
          errores,
        });
      }

      /* ── 2. Mover stock por la diferencia (primero lo que se devuelve) ── */
      const cambios = [];
      const aplicar = async (sku, delta, anterior, nuevo) => {
        try {
          await aplicarDeltaConsumo(client, {
            delta, sku, otId: id, ot, bodegaSolicitada: delta > 0 ? bodegaId : null, userId,
            nota: `Consumo OT #${id} (${anterior} → ${nuevo})`,
          });
        } catch (e) {
          if (e instanceof ErrorNegocio) e.payload = { ...e.payload, error: `${sku}: ${e.payload.error}`, sku };
          throw e;
        }
        cambios.push({ sku, anterior, nuevo, delta });
      };

      for (const q of quitados) {
        const real = q.real == null ? 0 : parseFloat(q.real);
        if (real > 1e-9) await aplicar(q.sku, -real, real, 0);
        await client.query(
          `DELETE FROM material_orden_trabajo WHERE orden_trabajo_id_orden = $1 AND material_sku = $2`, [id, q.sku]
        );
      }
      const noPintura = lineas.filter(l => !l.esPintura);
      for (const l of [...noPintura.filter(x => x.delta < 0), ...noPintura.filter(x => x.delta >= 0)]) {
        if (Math.abs(l.delta) > 1e-9) await aplicar(l.sku, l.delta, l.anterior, l.real);
      }

      /* ── 3. Estimado y real de cada línea; pinturas desde su seguimiento ── */
      for (const l of lineas) {
        await client.query(
          `INSERT INTO material_orden_trabajo
             (material_sku, orden_trabajo_id_orden, material_orden_trabajo_consumo_estimado, material_orden_trabajo_consumo_real)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (material_sku, orden_trabajo_id_orden)
           DO UPDATE SET material_orden_trabajo_consumo_estimado = EXCLUDED.material_orden_trabajo_consumo_estimado,
                         material_orden_trabajo_consumo_real =
                           CASE WHEN $5 THEN material_orden_trabajo.material_orden_trabajo_consumo_real
                                ELSE EXCLUDED.material_orden_trabajo_consumo_real END`,
          [l.sku, id, l.estimado, l.esPintura ? null : l.real, l.esPintura]
        );
      }
      await sincronizarPinturas(client, id);

      if (recetaId != null) {
        await client.query(
          `UPDATE orden_trabajo SET producto_terminado_id_producto = $2, orden_trabajo_cantidad_puertas = $3
           WHERE orden_trabajo_id_orden = $1`, [id, recetaId, puertas]
        );
      }
      return { cambios, quitados: quitados.map(q => q.sku), lineas: lineas.length };
    });

    const detalle = r.cambios.map(c => `${c.sku} ${c.anterior}→${c.nuevo}`).join(', ');
    await auditoria.registrar(userId, 'Guardar consumo OT',
      `OT #${id}` + (b.receta_id ? ` · receta #${b.receta_id} × ${b.cantidad_puertas}` : '') +
      `: ${detalle || 'sin movimientos de stock'}` + (r.quitados.length ? ` · quitados: ${r.quitados.join(', ')}` : ''));
    if (r.cambios.length) generarAlertasAutomaticas().catch(e => console.warn('Alertas:', e.message));

    const descontado = r.cambios.filter(c => c.delta > 0).length;
    const devuelto = r.cambios.filter(c => c.delta < 0).length;
    res.json({
      message: r.cambios.length
        ? `Consumo guardado: ${descontado} material(es) descontado(s) y ${devuelto} devuelto(s) a bodega.`
        : 'Consumo guardado. No hubo cambios de stock.',
      cambios: r.cambios,
      quitados: r.quitados,
    });
  } catch (err) {
    responderError(res, err, 'Error guardando el consumo de la OT:');
  }
}

/* ══════════════════════════════════════════════════════════════════════
   D54: corrección del consumo de una OT cerrada (solo gerencia, con motivo)
   ══════════════════════════════════════════════════════════════════════ */

const MAX_MOTIVO_CORRECCION = 255;

/**
 * PUT /api/ordenes-trabajo/:id/correccion   (soloGerencia) — D54
 * Body: { lineas: [{ sku, real }], motivo, bodega_id? }
 *
 * Una OT cerrada no admite consumos (cargarOTAbierta); gerencia corrige el consumo REAL que quedó mal, con motivo
 * (mismo patrón que la edición de recetas después de 24 h). La OT sigue cerrada:
 *  - El stock se mueve por la DIFERENCIA con lo registrado (aplicarDeltaConsumo: FIFO al subir, devolución al bajar),
 *    con los movimientos ligados a la OT y el motivo en la descripción.
 *  - Se corrige el real de un material de la OT o se agrega uno no registrado (sin estimado); para "quitarlo", real 0.
 *    No cambia la receta, los estimados ni el estado.
 *  - Las pinturas no: su real sale del Seguimiento de pinturas, que exige la OT abierta (D65).
 *  - Si la OT tenía diferenciales procesados (CU-103), se recalculan en la misma transacción.
 * Todo se valida antes de tocar stock; si un material no alcanza, no se guarda nada.
 */
async function corregirConsumoCerrada(req, res) {
  const { id } = req.params;
  const b = req.body || {};
  const userId = req.user?.id;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la OT debe ser numérico' });
  const motivo = String(b.motivo ?? '').trim();
  if (!motivo) return res.status(400).json({ error: 'Indique el motivo de la corrección.', campo: 'motivo' });
  if (motivo.length > MAX_MOTIVO_CORRECCION) return res.status(400).json({ error: `El motivo admite hasta ${MAX_MOTIVO_CORRECCION} caracteres.` });
  if (!Array.isArray(b.lineas) || b.lineas.length === 0) return res.status(400).json({ error: 'Indique los materiales a corregir.' });

  try {
    const r = await conTransaccion(async (client) => {
      const { rows: cab } = await client.query(
        `SELECT orden_trabajo_id_orden AS id, orden_trabajo_estado AS estado, proyecto_id_proyecto AS proyecto_id,
                usuario_id_usuario AS responsable_id, TO_CHAR(orden_trabajo_fecha_hora, 'YYYY-MM-DD') AS fecha
         FROM orden_trabajo WHERE orden_trabajo_id_orden = $1 FOR UPDATE`, [id]
      );
      if (!cab.length) throw new ErrorNegocio(404, { error: 'Orden de trabajo no encontrada' });
      const ot = cab[0];
      if (!ESTADOS_OT_CERRADA.includes(String(ot.estado).toLowerCase())) {
        throw new ErrorNegocio(400, { error: 'La OT está abierta: corrija el consumo desde la pestaña Consumo ("Guardar consumo").' });
      }

      /* ── 1. Validar todo antes de tocar stock ── */
      const errores = [];
      const bodegaId = b.bodega_id == null || b.bodega_id === '' ? null : String(b.bodega_id);
      if (bodegaId != null && !/^\d+$/.test(bodegaId)) errores.push({ sku: null, error: 'La bodega no es válida.' });
      const lineas = [];
      const vistos = new Set();
      for (const l of b.lineas) {
        const sku = String(l?.sku ?? '').trim();
        if (!sku) { errores.push({ sku: null, error: 'Una fila no tiene material.' }); continue; }
        if (vistos.has(sku)) { errores.push({ sku, error: 'El material viene repetido en la lista.' }); continue; }
        vistos.add(sku);
        const real = cantidadOT(l.real);
        if (real == null) { errores.push({ sku, error: 'El consumo real debe ser un número mayor o igual a 0, con hasta 4 decimales.' }); continue; }
        lineas.push({ sku, real });
      }
      const skus = lineas.map(l => l.sku);
      const { rows: mats } = skus.length ? await client.query(
        `SELECT material_sku AS sku, material_estado AS estado, material_es_herramienta AS herramienta,
                (es_material_pintura_custom IS TRUE OR es_material_pintura_no_custom IS TRUE) AS es_pintura
         FROM material WHERE material_sku = ANY($1::text[])`, [skus]
      ) : { rows: [] };
      const porSku = new Map(mats.map(m => [m.sku, m]));
      const { rows: actuales } = await client.query(
        `SELECT material_sku AS sku, material_orden_trabajo_consumo_real AS real
         FROM material_orden_trabajo WHERE orden_trabajo_id_orden = $1 FOR UPDATE`, [id]
      );
      const registrado = new Map(actuales.map(a => [a.sku, a.real == null ? 0 : parseFloat(a.real)]));
      for (const l of lineas) {
        const m = porSku.get(l.sku);
        if (!m) { errores.push({ sku: l.sku, error: 'No existe en el catálogo.' }); continue; }
        if (m.herramienta) { errores.push({ sku: l.sku, error: 'Es una herramienta: no se consume.' }); continue; }
        if (m.es_pintura) {
          errores.push({ sku: l.sku, error: 'Las pinturas se corrigen desde el Seguimiento de pinturas, que exige la OT abierta.' });
          continue;
        }
        l.anterior = registrado.get(l.sku) ?? 0;
        l.delta = l.real - l.anterior;
        if (Math.abs(l.delta) > 1e-9 && m.estado !== 'activo') {
          errores.push({ sku: l.sku, error: 'El material está inactivo: no se puede corregir su consumo. Reactívelo primero.' });
        }
      }
      if (bodegaId != null && errores.length === 0) {
        const { rows: bod } = await client.query(`SELECT 1 FROM bodega WHERE bodega_id_bodega = $1`, [bodegaId]);
        if (!bod.length) errores.push({ sku: null, error: 'La bodega no existe.' });
      }
      if (errores.length > 0) {
        throw new ErrorNegocio(400, {
          error: errores.length === 1
            ? `No se guardó nada: ${errores[0].sku ? errores[0].sku + ' — ' : ''}${errores[0].error}`
            : `No se guardó nada: ${errores.length} problema(s) en la lista.`,
          errores,
        });
      }
      const cambian = lineas.filter(l => Math.abs(l.delta) > 1e-9);
      if (!cambian.length) throw new ErrorNegocio(400, { error: 'No hay cambios: el consumo real indicado es igual al registrado.' });

      /* ── 2. Mover stock por la diferencia (primero lo que se devuelve) ── */
      const cambios = [];
      for (const l of [...cambian.filter(x => x.delta < 0), ...cambian.filter(x => x.delta > 0)]) {
        try {
          await aplicarDeltaConsumo(client, {
            delta: l.delta, sku: l.sku, otId: id, ot, bodegaSolicitada: l.delta > 0 ? bodegaId : null, userId,
            nota: `Corrección de la OT #${id} cerrada (${l.anterior} → ${l.real}): ${motivo}`,
          });
        } catch (e) {
          if (e instanceof ErrorNegocio) e.payload = { ...e.payload, error: `${l.sku}: ${e.payload.error}`, sku: l.sku };
          throw e;
        }
        // El estimado no se toca; un material agregado queda sin estimado
        await client.query(
          `INSERT INTO material_orden_trabajo (material_sku, orden_trabajo_id_orden, material_orden_trabajo_consumo_real)
           VALUES ($1, $2, $3)
           ON CONFLICT (material_sku, orden_trabajo_id_orden) DO UPDATE SET material_orden_trabajo_consumo_real = EXCLUDED.material_orden_trabajo_consumo_real`,
          [l.sku, id, l.real]
        );
        cambios.push({ sku: l.sku, anterior: l.anterior, nuevo: l.real, delta: l.delta });
      }

      /* ── 3. CU-103: si ya estaban procesados, los diferenciales se recalculan ── */
      const { rows: dif } = await client.query(`SELECT 1 FROM diferencial_consumo WHERE orden_trabajo_id_orden = $1 LIMIT 1`, [id]);
      const recalculados = dif.length > 0 && ot.estado === ESTADO_FINALIZADA;
      if (recalculados) await calcularDiferencialesOT(client, id, ot.fecha, userId);
      return { cambios, recalculados };
    });

    await auditoria.registrar(userId, 'Corrección OT cerrada',
      `OT #${id}: ${r.cambios.map(c => `${c.sku} ${c.anterior}→${c.nuevo}`).join(', ')} · ${motivo}` +
      (r.recalculados ? ' · diferenciales recalculados' : ''));
    generarAlertasAutomaticas().catch(e => console.warn('Alertas:', e.message));

    const descontado = r.cambios.filter(c => c.delta > 0).length;
    const devuelto = r.cambios.filter(c => c.delta < 0).length;
    res.json({
      message: `Corrección guardada: ${descontado} material(es) descontado(s) y ${devuelto} devuelto(s) a bodega. La OT sigue cerrada.` +
               (r.recalculados ? ' Sus diferenciales de consumo se recalcularon.' : ''),
      cambios: r.cambios,
      diferenciales_recalculados: r.recalculados,
    });
  } catch (err) {
    responderError(res, err, 'Error corrigiendo el consumo de la OT:');
  }
}

module.exports = {
  listar, consultarConsumos, registrarConsumo, editarConsumo,
  registrarEstimados, comparativo, costos, rentabilidad,
  eliminarMaterial, asignarEmpleadoTentativo, movimientosOT,
  finalizar, consultarDiferenciales, procesarDiferenciales,
  guardarConsumo, corregirConsumoCerrada,
  ESTADOS_OT_CERRADA,   // D65: también la usa seguimientoPinturas
};
