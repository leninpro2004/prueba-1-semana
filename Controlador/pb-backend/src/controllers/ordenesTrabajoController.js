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
const { ESTADOS_VINCULABLES } = require('./pedidosVentaController');   // F-06: ventas aprobadas o en proceso (D44)
const { cerrarReserva } = require('./reservasController');             // F-28: anular libera las reservas
const { normalizarMedidas } = require('../config/medidas');               // F-08

/* ======================================================================
   OPUS-1 - Nucleo transaccional de consumos reales
   Todo lo que toca stock (inventario_bodega + material_orden_trabajo +
   movimiento_inventario) pasa por aqui dentro de un BEGIN/COMMIT unico.
   conTransaccion / ErrorNegocio / responderError viven en db/tx.js (OPUS-3),
   compartidos con pedidosController y reservasController.
   ====================================================================== */

const { ESTADOS_OT_CERRADA, ESTADO_OT_CANCELADA, SQL_ESTADOS_OT_CERRADA } = require('../db/estadosOT');   // F-28: lista única

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
              pr.codigo_proyecto AS proyecto_codigo,   -- F-24: la pestaña Consumo avisa si es de prueba
              -- R1: área de la OT y receta cargada
              ot.area_trabajo_id_area AS area_id, a.area_trabajo_nombre_area AS area,
              ot.producto_terminado_id_producto AS receta_id, ot.orden_trabajo_cantidad_puertas AS cantidad_puertas,
              pt.producto_terminado_codigo_producto AS receta_codigo, pt.producto_terminado_nombre_producto AS receta_nombre,
              -- B-03: responsable (se puede cambiar desde el detalle)
              ot.usuario_id_usuario AS responsable_id, ur.usuario_username AS responsable
       FROM orden_trabajo ot
       LEFT JOIN area_trabajo a ON a.area_trabajo_id_area = ot.area_trabajo_id_area
       LEFT JOIN producto_terminado pt ON pt.producto_terminado_id_producto = ot.producto_terminado_id_producto
       LEFT JOIN usuario ur ON ur.usuario_id_usuario = ot.usuario_id_usuario
       LEFT JOIN terreno.proyecto pr ON pr.id_proyecto = ot.proyecto_id_proyecto
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

/** Fecha local YYYY-MM-DD de hoy (nunca desde toISOString(), que es UTC). */
function hoyLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// F-10 (D75): de dónde sale el precio unitario de cada material (precioVigente de db/historico.js)
const NOTA_PRECIO = {
  historial:      'Último precio de compra',
  historial_otro: 'Último precio de compra (otro proveedor)',
  referencial:    'Precio referencial (sin compras)',
};

/**
 * OT (con proyecto y cantidad de puertas) y el costo de sus consumos reales, valorizados al precio
 * vigente hoy: último precio de compra del proveedor principal, si no el de cualquier proveedor y,
 * si no hay compras, el precio referencial (D75). null si la OT no existe.
 */
async function costoMaterialesOT(id) {
  const { rows: ot } = await query(
    `SELECT ot.orden_trabajo_id_orden AS id, ot.orden_trabajo_estado AS estado,
            ot.orden_trabajo_cantidad_puertas AS puertas,
            p.codigo_proyecto AS proyecto_codigo, p.nombre_referencia AS proyecto_nombre
     FROM orden_trabajo ot
     LEFT JOIN terreno.proyecto p ON p.id_proyecto = ot.proyecto_id_proyecto
     WHERE ot.orden_trabajo_id_orden = $1`,
    [id]
  );
  if (ot.length === 0) return null;

  const { rows: materiales } = await query(
    `SELECT
       mot.material_sku                             AS sku,
       m.material_nombre_material                   AS nombre,
       u.material_unidad_medida_nombre              AS unidad,
       mot.material_orden_trabajo_consumo_real      AS cantidad_real
     FROM material_orden_trabajo mot
     JOIN material m ON m.material_sku = mot.material_sku
     LEFT JOIN material_unidad_medida u
            ON u.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
     WHERE mot.orden_trabajo_id_orden = $1
       AND mot.material_orden_trabajo_consumo_real IS NOT NULL
     ORDER BY m.material_nombre_material`,
    [id]
  );

  const precios = await precioVigente({ query }, hoyLocal());
  const detalle = materiales.map(m => {
    const cant = parseFloat(m.cantidad_real || 0);
    const { precio = null, fuente = null } = precios.get(m.sku) || {};
    return {
      ...m,
      precio_unitario: precio,
      costo_linea: cant * (precio || 0),
      fuente_precio: fuente,
      // CU-93 Exc 1
      sin_precio: precio == null,
      // CU-93 Exc 2
      nota_precio: precio == null ? 'Sin precio: no suma al costo' : NOTA_PRECIO[fuente],
    };
  });
  return { orden: ot[0], detalle, costoTotal: detalle.reduce((s, d) => s + d.costo_linea, 0) };
}

/**
 * GET /api/ordenes-trabajo/:id/costos
 * Consolidar costos de materiales (CU-93), con el mismo precio que la rentabilidad (F-10).
 */
async function costos(req, res) {
  const { id } = req.params;
  try {
    const r = await costoMaterialesOT(id);
    if (!r) {
      return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
    }
    const { orden, detalle, costoTotal } = r;
    const incompleto = detalle.some(d => d.sin_precio);

    res.json({
      orden,
      detalle,
      resumen: {
        costo_total_materiales: costoTotal,
        moneda: 'CLP',
        estado_calculo: incompleto ? 'Estimado/Incompleto' : 'Completo',
        total_insumos: detalle.length,
        sin_precio: detalle.filter(d => d.sin_precio).length,
        con_precio_referencial: detalle.filter(d => d.fuente_precio === 'referencial').length,
      }
    });
  } catch (err) {
    console.error('Error consolidando costos:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/** Número de un query param: vacío u omitido → `porDefecto`; texto no numérico → NaN. */
function numeroDe(valor, porDefecto) {
  if (valor == null || String(valor).trim() === '') return porDefecto;
  return Number(String(valor).replace(',', '.'));
}

/**
 * GET /api/ordenes-trabajo/:id/rentabilidad?margen=40[&reserva=15][&adicional=200000]
 * Precio sugerido (CU-94) con la fórmula del cliente (D75, carta de cotización 250380):
 *   costo de producción = materiales de la OT + costo adicional por puerta × puertas de la OT
 *                         (mano de obra, consumibles, pintura y embalaje: no salen de inventario)
 *   precio por margen   = costo de producción / (1 − margen)
 *   precio sugerido     = precio por margen / (1 − reserva de negociación)
 * Montos netos (sin IVA). IVA, descuentos e instalación son de la cotización (Finanzas).
 */
async function rentabilidad(req, res) {
  const { id } = req.params;
  const margen = numeroDe(req.query.margen, NaN);
  const reserva = numeroDe(req.query.reserva, 0);
  const adicional = numeroDe(req.query.adicional, 0);

  // CU-94 Exc 3
  if (!Number.isFinite(margen) || margen <= 0 || margen >= 100) {
    return res.status(400).json({ error: 'El margen de utilidad debe ser un porcentaje mayor que 0 y menor que 100.' });
  }
  if (!Number.isFinite(reserva) || reserva < 0 || reserva >= 100) {
    return res.status(400).json({ error: 'La reserva de negociación debe ser un porcentaje entre 0 y menos de 100.' });
  }
  if (!Number.isFinite(adicional) || adicional < 0) {
    return res.status(400).json({ error: 'El costo adicional por puerta debe ser un monto mayor o igual a 0.' });
  }

  try {
    const r = await costoMaterialesOT(id);
    if (!r) {
      return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
    }
    const { orden, detalle, costoTotal } = r;

    // CU-94 Exc 1
    if (detalle.length === 0) {
      return res.status(400).json({ error: 'No existen datos de producción disponibles para analizar' });
    }

    const puertasRegistradas = Number(orden.puertas) > 0;
    const puertas = puertasRegistradas ? Number(orden.puertas) : 1;
    const costoAdicional = adicional * puertas;
    const costoProduccion = costoTotal + costoAdicional;
    const precioMargen = costoProduccion / (1 - margen / 100);
    const precioSugerido = Math.round(precioMargen / (1 - reserva / 100));

    const advertencias = [];
    // CU-94 Exc 2
    const sinPrecio = detalle.filter(d => d.sin_precio);
    if (sinPrecio.length) {
      advertencias.push('El precio sugerido se basa en datos incompletos. Algunos insumos no tienen precio registrado: ' +
        sinPrecio.map(d => d.nombre).join(', ') + '.');
    }
    const referencial = detalle.filter(d => d.fuente_precio === 'referencial');
    if (referencial.length) {
      advertencias.push('Sin compras registradas, se usó el precio referencial del proveedor para: ' +
        referencial.map(d => d.nombre).join(', ') + '.');
    }
    if (adicional > 0 && !puertasRegistradas) {
      advertencias.push('La OT no tiene registrada la cantidad de puertas: el costo adicional se calculó para 1 puerta.');
    }

    res.json({
      orden,
      costo_materiales: costoTotal,
      costo_adicional_puerta: adicional,
      puertas,
      costo_adicional: costoAdicional,
      costo_produccion: costoProduccion,
      margen_pct: margen,
      precio_margen: Math.round(precioMargen),
      reserva_pct: reserva,
      precio_sugerido: precioSugerido,
      margen_monto: precioSugerido - costoProduccion,
      moneda: 'CLP',
      advertencias,
      // El primer aviso, con el nombre de antes
      advertencia: advertencias[0] ?? null,
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

      // F-07 (#14): la auditoría muestra el nombre de la bodega, no su id
      const { rows: bod } = bodegaDevuelta
        ? await client.query(`SELECT bodega_nombre_bodega AS nombre FROM bodega WHERE bodega_id_bodega = $1`, [bodegaDevuelta])
        : { rows: [] };
      return { consumoReal, bodegaDevuelta, bodegaNombre: bod[0]?.nombre, proyecto_id: ot.proyecto_id };
    });

    await auditoria.registrar(userId, 'Eliminar material de OT',
      r.consumoReal > 0
        ? `Material SKU ${sku} eliminado de OT #${id}; se devolvieron ${r.consumoReal} al inventario (bodega ${r.bodegaNombre ?? '#' + r.bodegaDevuelta})`
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
   R1: consumo en la OT desde la receta (docs/incremento-3-4/decisiones.md, R1)
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
 * Body: { receta_id?, cantidad_puertas?, reemplazar_receta?, bodega_id?, motivo?,
 *         lineas: [{ sku, estimado?, real, motivo? }] }
 *
 * F-05: cambiar un real YA guardado (consumo extra o menor) exige el `motivo` de la línea;
 * quitar un material que tenía consumo exige el `motivo` general. El primer registro no lo pide.
 * El motivo queda en la descripción del movimiento de la diferencia.
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
        lineas.push({ sku, estimado, realTxt: l.real, motivo: String(l.motivo ?? '').trim() });
      }
      // F-05: motivo para quitar materiales que ya tenían consumo (no vienen en `lineas`)
      const motivoGeneral = String(b.motivo ?? '').trim();
      if (motivoGeneral.length > MAX_MOTIVO_CORRECCION) {
        errores.push({ sku: null, error: `El motivo admite hasta ${MAX_MOTIVO_CORRECCION} caracteres.` });
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
      // F-05: con real ya guardado, cambiarlo es un consumo extra o menor y exige motivo
      const conRealGuardado = new Set(actuales.filter(a => a.real != null).map(a => a.sku));

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
        if (Math.abs(l.delta) > 1e-9 && conRealGuardado.has(l.sku)) {
          if (!l.motivo) {
            errores.push({ sku: l.sku, campo: 'motivo', error: 'Ya tenía un consumo registrado: indique el motivo del cambio.' });
          } else if (l.motivo.length > MAX_MOTIVO_CORRECCION) {
            errores.push({ sku: l.sku, campo: 'motivo', error: `El motivo admite hasta ${MAX_MOTIVO_CORRECCION} caracteres.` });
          }
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
        } else if (q.real != null && parseFloat(q.real) > 1e-9 && !motivoGeneral) {
          errores.push({ sku: q.sku, campo: 'motivo', error: 'Tenía consumo registrado: indique el motivo para quitarlo de la OT.' });
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
      const aplicar = async (sku, delta, anterior, nuevo, motivo) => {
        try {
          await aplicarDeltaConsumo(client, {
            delta, sku, otId: id, ot, bodegaSolicitada: delta > 0 ? bodegaId : null, userId,
            // F-05: el motivo del consumo extra o menor queda en el movimiento de la diferencia
            nota: `Consumo OT #${id} (${anterior} → ${nuevo})` + (motivo ? `: ${motivo}` : ''),
          });
        } catch (e) {
          if (e instanceof ErrorNegocio) e.payload = { ...e.payload, error: `${sku}: ${e.payload.error}`, sku };
          throw e;
        }
        cambios.push({ sku, anterior, nuevo, delta, ...(motivo && { motivo }) });
      };

      for (const q of quitados) {
        const real = q.real == null ? 0 : parseFloat(q.real);
        if (real > 1e-9) await aplicar(q.sku, -real, real, 0, motivoGeneral);
        await client.query(
          `DELETE FROM material_orden_trabajo WHERE orden_trabajo_id_orden = $1 AND material_sku = $2`, [id, q.sku]
        );
      }
      const noPintura = lineas.filter(l => !l.esPintura);
      for (const l of [...noPintura.filter(x => x.delta < 0), ...noPintura.filter(x => x.delta >= 0)]) {
        if (Math.abs(l.delta) > 1e-9) await aplicar(l.sku, l.delta, l.anterior, l.real, conRealGuardado.has(l.sku) ? l.motivo : '');
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

    const detalle = r.cambios.map(c => `${c.sku} ${c.anterior}→${c.nuevo}` + (c.motivo ? ` (${c.motivo})` : '')).join(', ');
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

/* ══════════════════════════════════════════════════════════════════════
   F-06 (D70, D71): crear OT desde Inventario. Una OT por área.
   ══════════════════════════════════════════════════════════════════════ */

const ESTADO_OT_INICIAL = 'pendiente';

/** Proyecto de Terreno de una venta (finanzas, solo lectura), por su proyecto financiero. */
const SQL_VENTAS_CON_PROYECTO = `
  SELECT nv.id_nota_venta AS id, nv.numero_nota_venta AS numero, nv.estado_pedido AS estado,
         nv.fecha_max_entrega AS fecha_entrega, pf.id_proyecto_terreno AS proyecto_id
  FROM finanzas.nota_venta nv
  LEFT JOIN finanzas.proyecto_financiero pf ON pf.id_proyecto_financiero = nv.id_proyecto_financiero`;

/**
 * GET /api/ordenes-trabajo/opciones-nueva
 * Lo que necesita el formulario "Nueva OT": áreas activas, proyectos de Terreno, ventas
 * aprobadas o en proceso (D44) con su proyecto, y usuarios activos para responsable.
 * Las recetas se piden aparte (GET /recetas).
 */
async function opcionesNueva(req, res) {
  try {
    const [areas, proyectos, ventas, usuarios] = await Promise.all([
      query(`SELECT area_trabajo_id_area AS id, area_trabajo_nombre_area AS nombre
             FROM area_trabajo WHERE area_trabajo_activo IS NOT FALSE ORDER BY area_trabajo_nombre_area`),
      query(`SELECT id_proyecto AS id, codigo_proyecto AS codigo, nombre_referencia AS nombre
             FROM terreno.proyecto ORDER BY codigo_proyecto`),
      query(`${SQL_VENTAS_CON_PROYECTO}
             WHERE LOWER(nv.estado_pedido) = ANY($1::text[])
             ORDER BY nv.fecha_max_entrega NULLS LAST, nv.numero_nota_venta`, [ESTADOS_VINCULABLES]),
      query(`SELECT usuario_id_usuario AS id, usuario_username AS username,
                    TRIM(CONCAT(usuario_nombre_completo_primer_nombre_usuario, ' ',
                                usuario_nombre_completo_primer_apellido_usuario)) AS nombre
             FROM usuario WHERE usuario_estado_cuenta IN ('activo', 'activa') ORDER BY usuario_username`),
    ]);
    res.json({ areas: areas.rows, proyectos: proyectos.rows, ventas: ventas.rows, usuarios: usuarios.rows });
  } catch (err) {
    responderError(res, err, 'Error cargando las opciones de la nueva OT:');
  }
}

/**
 * POST /api/ordenes-trabajo   (soloOperativo) — F-06
 * Body: { area_id, proyecto_id?, nota_venta_id?, receta_id?, cantidad_puertas?, responsable_id? }
 *
 * La OT no tiene columna de venta: si se elige una venta, se liga a SU proyecto de Terreno
 * (proyecto_financiero.id_proyecto_terreno) y, si no tiene, se rechaza. La receta debe tener
 * insumos del área (R1: la OT carga solo los de su área). Responsable por defecto: quien la crea.
 * Todo se valida antes de escribir; la auditoría va después del COMMIT.
 */
async function crear(req, res) {
  const b = req.body || {};
  const id = (v) => (v == null || v === '' ? null : String(v));
  const areaId = id(b.area_id), proyectoPedido = id(b.proyecto_id), ventaId = id(b.nota_venta_id);
  const recetaId = id(b.receta_id), responsableId = id(b.responsable_id) ?? String(req.user.id);

  for (const [valor, nombre] of [[areaId, 'El área'], [proyectoPedido, 'El proyecto'], [ventaId, 'La venta'],
                                 [recetaId, 'La receta'], [responsableId, 'El responsable']]) {
    if (valor != null && !/^\d+$/.test(valor)) return res.status(400).json({ error: `${nombre} no es válido.` });
  }
  if (!areaId) return res.status(400).json({ error: 'Indique el área de la OT.', campo: 'area_id' });
  let puertas = null;
  if (recetaId) {
    puertas = Number(b.cantidad_puertas);
    if (!Number.isInteger(puertas) || puertas < 1 || puertas > 1000) {
      return res.status(400).json({ error: 'La cantidad de puertas debe ser un número entero entre 1 y 1000.', campo: 'cantidad_puertas' });
    }
  }

  try {
    const ot = await conTransaccion(async (client) => {
      const { rows: area } = await client.query(
        `SELECT area_trabajo_nombre_area AS nombre, area_trabajo_activo AS activo
         FROM area_trabajo WHERE area_trabajo_id_area = $1`, [areaId]);
      if (!area.length) throw new ErrorNegocio(400, { error: 'El área no existe.', campo: 'area_id' });
      if (area[0].activo === false) throw new ErrorNegocio(400, { error: `El área ${area[0].nombre} está inactiva.`, campo: 'area_id' });

      // Proyecto: el elegido o el de la venta (deben coincidir si vienen los dos)
      let proyectoId = proyectoPedido;
      let venta = null;
      if (ventaId) {
        const { rows } = await client.query(`${SQL_VENTAS_CON_PROYECTO} WHERE nv.id_nota_venta = $1`, [ventaId]);
        venta = rows[0];
        if (!venta) throw new ErrorNegocio(400, { error: 'La venta no existe.', campo: 'nota_venta_id' });
        if (!ESTADOS_VINCULABLES.includes(String(venta.estado).toLowerCase())) {
          throw new ErrorNegocio(400, { error: `La venta ${venta.numero} no está aprobada ni en proceso.`, campo: 'nota_venta_id' });
        }
        if (venta.proyecto_id == null) {
          throw new ErrorNegocio(400, {
            error: `La venta ${venta.numero} no tiene un proyecto de Terreno asociado: elija el proyecto directamente.`,
            campo: 'nota_venta_id',
          });
        }
        if (proyectoId && proyectoId !== String(venta.proyecto_id)) {
          throw new ErrorNegocio(400, { error: `La venta ${venta.numero} pertenece a otro proyecto.`, campo: 'proyecto_id' });
        }
        proyectoId = String(venta.proyecto_id);
      }
      let proyecto = null;   // F-07 (#14): código y nombre para la auditoría
      if (proyectoId) {
        const { rows } = await client.query(
          `SELECT codigo_proyecto AS codigo, nombre_referencia AS nombre FROM terreno.proyecto WHERE id_proyecto = $1`, [proyectoId]);
        if (!rows.length) throw new ErrorNegocio(400, { error: 'El proyecto no existe.', campo: 'proyecto_id' });
        proyecto = `${rows[0].codigo} ${rows[0].nombre}`;
      }

      if (recetaId) {
        const { rows: rec } = await client.query(
          `SELECT pt.producto_terminado_codigo_producto AS codigo, pt.producto_terminado_activo AS activo,
                  EXISTS (SELECT 1 FROM material_producto_terminado mpt
                          WHERE mpt.producto_terminado_id_producto = pt.producto_terminado_id_producto
                            AND mpt.area_trabajo_id_area = $2) AS tiene_del_area
           FROM producto_terminado pt WHERE pt.producto_terminado_id_producto = $1`, [recetaId, areaId]);
        if (!rec.length) throw new ErrorNegocio(400, { error: 'La receta no existe.', campo: 'receta_id' });
        if (!rec[0].activo) throw new ErrorNegocio(400, { error: `La receta ${rec[0].codigo} está inactiva.`, campo: 'receta_id' });
        if (!rec[0].tiene_del_area) {
          throw new ErrorNegocio(400, { error: `La receta ${rec[0].codigo} no tiene insumos del área ${area[0].nombre}.`, campo: 'receta_id' });
        }
      }

      const { rows: resp } = await client.query(
        `SELECT usuario_username AS username, usuario_estado_cuenta AS estado FROM usuario WHERE usuario_id_usuario = $1`,
        [responsableId]);
      if (!resp.length) throw new ErrorNegocio(400, { error: 'El responsable no existe.', campo: 'responsable_id' });
      if (!['activo', 'activa'].includes(resp[0].estado)) {
        throw new ErrorNegocio(400, { error: `El responsable ${resp[0].username} no tiene la cuenta activa.`, campo: 'responsable_id' });
      }

      const { rows: [nueva] } = await client.query(
        `INSERT INTO orden_trabajo (orden_trabajo_estado, area_trabajo_id_area, usuario_id_usuario, proyecto_id_proyecto,
                                    producto_terminado_id_producto, orden_trabajo_cantidad_puertas)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING orden_trabajo_id_orden AS id`,
        [ESTADO_OT_INICIAL, areaId, responsableId, proyectoId, recetaId, puertas]);
      return { id: Number(nueva.id), area: area[0].nombre, responsable: resp[0].username, venta, proyecto };
    });

    await auditoria.registrar(req.user.id, 'crear_orden_trabajo',
      `OT #${ot.id} · área ${ot.area} · responsable ${ot.responsable}` +
      (ot.venta ? ` · venta ${ot.venta.numero}` : '') + (ot.proyecto ? ` · proyecto ${ot.proyecto}` : '') +
      (recetaId ? ` · receta #${recetaId} × ${puertas}` : ''));
    res.status(201).json({ id: ot.id, estado: ESTADO_OT_INICIAL, message: `OT #${ot.id} creada.` });
  } catch (err) {
    responderError(res, err, 'Error creando la OT:');
  }
}

/* ══════════════════════════════════════════════════════════════════════
   F-28: anular (nunca borrar) una OT
   ══════════════════════════════════════════════════════════════════════ */

/**
 * PUT /api/ordenes-trabajo/:id/anular   (gerencia y jop) — F-28
 * Body: { motivo }
 *
 * La OT pasa a 'cancelada' y conserva su historial (consumos devueltos, movimientos, auditoría).
 * Solo una OT abierta y SIN consumo vigente: si algún material tiene real > 0 o hay pinturas en
 * el Seguimiento sin anular, 409 con el detalle; primero se devuelve el consumo (real 0, F-05).
 * Sus reservas activas se liberan en la misma transacción. El motivo queda en la auditoría y en
 * las reservas liberadas (la OT no tiene columna de motivo; agregarla sería DDL).
 */
async function anular(req, res) {
  const { id } = req.params;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la OT debe ser numérico' });
  const motivo = String(req.body?.motivo ?? '').trim();
  if (!motivo) return res.status(400).json({ error: 'Indique el motivo de la anulación.', campo: 'motivo' });
  if (motivo.length > MAX_MOTIVO_CORRECCION) {
    return res.status(400).json({ error: `El motivo admite hasta ${MAX_MOTIVO_CORRECCION} caracteres.`, campo: 'motivo' });
  }

  try {
    const r = await conTransaccion(async (client) => {
      const { rows: ot } = await client.query(
        `SELECT orden_trabajo_estado AS estado FROM orden_trabajo WHERE orden_trabajo_id_orden = $1 FOR UPDATE`, [id]);
      if (!ot.length) throw new ErrorNegocio(404, { error: 'Orden de trabajo no encontrada' });
      if (ESTADOS_OT_CERRADA.includes(String(ot[0].estado).toLowerCase())) {
        throw new ErrorNegocio(400, { error: `La orden de trabajo ya está ${ot[0].estado}: no se puede anular.` });
      }

      // Consumo vigente: lo descontado y no devuelto, y las pinturas del seguimiento
      const { rows: consumos } = await client.query(
        `SELECT mot.material_sku AS sku, m.material_nombre_material AS nombre,
                mot.material_orden_trabajo_consumo_real::float AS real
         FROM material_orden_trabajo mot
         JOIN material m ON m.material_sku = mot.material_sku
         WHERE mot.orden_trabajo_id_orden = $1 AND mot.material_orden_trabajo_consumo_real > 0
         ORDER BY mot.material_sku`, [id]);
      const { rows: [pint] } = await client.query(
        `SELECT COUNT(*)::int AS n FROM seguimiento_pintura WHERE orden_trabajo_id_orden = $1 AND estado <> 'anulado'`, [id]);
      if (consumos.length > 0 || pint.n > 0) {
        throw new ErrorNegocio(409, {
          error: 'No se puede anular: la OT tiene consumo registrado. ' + [
            consumos.length > 0 && `Devuelva primero a bodega lo consumido (deje el real en 0 en Consumo): ${consumos.map(c => `${c.sku} ${c.real}`).join(', ')}.`,
            pint.n > 0 && `Anule primero los ${pint.n} registro(s) del Seguimiento de pinturas.`,
          ].filter(Boolean).join(' '),
          codigo: 'OT_CON_CONSUMO', consumos, pinturas: pint.n,
        });
      }

      // Reservas activas: se liberan con el mismo cierre que usa la pantalla de Reservas
      const { rows: reservas } = await client.query(
        `SELECT reserva_inventario_id_reserva AS id FROM reserva_inventario
         WHERE orden_trabajo_id_orden = $1 AND reserva_inventario_estado_reserva = 'activa'
         ORDER BY reserva_inventario_id_reserva`, [id]);
      for (const res_ of reservas) {
        await cerrarReserva(client, res_.id, 'liberada', { usuarioId: req.user.id, motivo: `OT #${id} anulada: ${motivo}` });
      }

      await client.query(
        `UPDATE orden_trabajo SET orden_trabajo_estado = $2 WHERE orden_trabajo_id_orden = $1`, [id, ESTADO_OT_CANCELADA]);
      return { reservas: reservas.length };
    });

    await auditoria.registrar(req.user.id, 'anular_ot',
      `OT #${id} anulada: ${motivo}` + (r.reservas ? ` · ${r.reservas} reserva(s) liberada(s)` : ''));
    res.json({
      message: `OT #${id} anulada.` + (r.reservas ? ` Se liberaron ${r.reservas} reserva(s).` : ''),
      reservas_liberadas: r.reservas,
    });
  } catch (err) {
    responderError(res, err, 'Error anulando la OT:');
  }
}

/* ══════════════════════════════════════════════════════════════════════
   B-03: cambiar el responsable de una OT
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Valida que `id` sea un usuario activo que puede quedar como responsable.
 * Lanza ErrorNegocio 400 si no. Devuelve su username. (Lo comparte usuariosController.reasignarOT.)
 */
async function validarResponsable(client, id) {
  if (!/^\d+$/.test(String(id ?? ''))) throw new ErrorNegocio(400, { error: 'Indique el nuevo responsable.', campo: 'responsable_id' });
  const { rows } = await client.query(
    `SELECT usuario_username AS username, usuario_estado_cuenta AS estado FROM usuario WHERE usuario_id_usuario = $1`, [id]);
  if (!rows.length) throw new ErrorNegocio(400, { error: 'El responsable no existe.', campo: 'responsable_id' });
  if (!['activo', 'activa'].includes(rows[0].estado)) {
    throw new ErrorNegocio(400, { error: `${rows[0].username} no tiene la cuenta activa.`, campo: 'responsable_id' });
  }
  return rows[0].username;
}

/**
 * PUT /api/ordenes-trabajo/:id/responsable   (soloGerencia) — B-03
 * Body: { responsable_id }. Solo una OT abierta; el nuevo responsable, activo y distinto del actual.
 */
async function cambiarResponsable(req, res) {
  const { id } = req.params;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la OT debe ser numérico' });
  const nuevo = req.body?.responsable_id;
  try {
    const r = await conTransaccion(async (client) => {
      const { rows: ot } = await client.query(
        `SELECT ot.orden_trabajo_estado AS estado, ot.usuario_id_usuario AS actual_id, u.usuario_username AS actual
         FROM orden_trabajo ot LEFT JOIN usuario u ON u.usuario_id_usuario = ot.usuario_id_usuario
         WHERE ot.orden_trabajo_id_orden = $1 FOR UPDATE OF ot`, [id]);
      if (!ot.length) throw new ErrorNegocio(404, { error: 'Orden de trabajo no encontrada' });
      if (ESTADOS_OT_CERRADA.includes(String(ot[0].estado).toLowerCase())) {
        throw new ErrorNegocio(400, { error: `La orden de trabajo está ${ot[0].estado}: no se cambia su responsable.` });
      }
      const username = await validarResponsable(client, nuevo);
      if (String(ot[0].actual_id) === String(nuevo)) {
        throw new ErrorNegocio(400, { error: `${username} ya es el responsable de esta OT.`, campo: 'responsable_id' });
      }
      await client.query(`UPDATE orden_trabajo SET usuario_id_usuario = $2 WHERE orden_trabajo_id_orden = $1`, [id, nuevo]);
      return { anterior: ot[0].actual, nuevo: username };
    });
    await auditoria.registrar(req.user.id, 'cambiar_responsable_ot', `OT #${id}: ${r.anterior ?? '—'} → ${r.nuevo}`);
    res.json({ message: `Responsable de la OT #${id}: ${r.nuevo}.` });
  } catch (err) {
    responderError(res, err, 'Error cambiando el responsable de la OT:');
  }
}

/**
 * PUT /api/ordenes-trabajo/:id/medidas   (soloOperativo) — F-08 (D74)
 * Body: { medidas: { vano_ancho_mm, vano_alto_mm, hojas, mdf, perfil_marco_mm } } o { medidas: null }
 * para quitarlas. Solo una OT abierta. No mueve stock: las cantidades por fórmula se recalculan
 * al precargar la receta en la pestaña Consumo.
 */
async function guardarMedidas(req, res) {
  const { id } = req.params;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la OT debe ser numérico' });
  const body = req.body || {};
  if (!('medidas' in body)) return res.status(400).json({ error: 'Indique las medidas de la puerta.' });
  let medidas = null;
  if (body.medidas != null) {
    const n = normalizarMedidas(body.medidas);
    if (n.errores) {
      return res.status(400).json({
        error: n.errores.length === 1 ? n.errores[0].error + '.' : 'Revise las medidas de la puerta.', errores: n.errores,
      });
    }
    medidas = n.medidas;
  }
  try {
    await conTransaccion(async (client) => {
      const { rows: ot } = await client.query(
        `SELECT orden_trabajo_estado AS estado FROM orden_trabajo WHERE orden_trabajo_id_orden = $1 FOR UPDATE`, [id]);
      if (!ot.length) throw new ErrorNegocio(404, { error: 'Orden de trabajo no encontrada' });
      if (ESTADOS_OT_CERRADA.includes(String(ot[0].estado).toLowerCase())) {
        throw new ErrorNegocio(400, { error: `La orden de trabajo está ${ot[0].estado}: no se cambian sus medidas.` });
      }
      await client.query(`UPDATE orden_trabajo SET orden_trabajo_medidas = $2 WHERE orden_trabajo_id_orden = $1`,
        [id, medidas == null ? null : JSON.stringify(medidas)]);
    });
    const texto = medidas
      ? `vano ${medidas.vano_ancho_mm} × ${medidas.vano_alto_mm} mm, ${medidas.hojas} hoja(s), ` +
        `perfil ${medidas.perfil_marco_mm} mm${medidas.mdf ? ', con MDF' : ''}`
      : 'sin medidas';
    await auditoria.registrar(req.user.id, 'medidas_ot', `OT #${id}: ${texto}`);
    res.json({ message: medidas ? `Medidas guardadas: ${texto}.` : 'Se quitaron las medidas de la OT.', medidas });
  } catch (err) {
    responderError(res, err, 'Error guardando las medidas de la OT:');
  }
}

/**
 * GET /api/ordenes-trabajo/proyectos
 * F-24: proyectos de Terreno (solo lectura) con sus OT abiertas, terminadas y anuladas, para
 * crear una OT desde el proyecto. Lista todos; la vista marca los de prueba.
 */
async function proyectosConOT(req, res) {
  try {
    const { rows } = await query(
      `SELECT p.id_proyecto AS id, p.codigo_proyecto AS codigo, p.nombre_referencia AS nombre,
              to_char(p.fecha_instalacion, 'YYYY-MM-DD') AS fecha_instalacion,
              p.estado_operacional, p.estado_produccion,
              COUNT(ot.orden_trabajo_id_orden) FILTER (
                WHERE LOWER(ot.orden_trabajo_estado) NOT IN (${SQL_ESTADOS_OT_CERRADA}))::int AS ot_abiertas,
              COUNT(ot.orden_trabajo_id_orden) FILTER (
                WHERE LOWER(ot.orden_trabajo_estado) IN (${SQL_ESTADOS_OT_CERRADA})
                  AND LOWER(ot.orden_trabajo_estado) <> $1)::int AS ot_terminadas,
              COUNT(ot.orden_trabajo_id_orden) FILTER (
                WHERE LOWER(ot.orden_trabajo_estado) = $1)::int AS ot_anuladas
       FROM terreno.proyecto p
       LEFT JOIN orden_trabajo ot ON ot.proyecto_id_proyecto = p.id_proyecto
       GROUP BY p.id_proyecto
       ORDER BY p.codigo_proyecto`,
      [ESTADO_OT_CANCELADA]
    );
    res.json(rows);
  } catch (err) {
    responderError(res, err, 'Error listando los proyectos:');
  }
}

/* ── F-29 (D83): crear proyectos desde Inventario, temporal ──
   Excepción a la regla 7 autorizada por el usuario (11/10): mientras Terreno no cree proyectos, gerencia
   los crea aquí (y su cliente, si es nuevo) para poder abrir OT durante la marcha blanca. Se quita cuando
   Terreno (o el schema común, P-08) los cree; en F-26 se migran si proyecto cambia de schema. */

// Valores que usan los datos de Terreno disponibles; Terreno aún no define otros.
const PROYECTO_ESTADO_OPERACIONAL = 'en_curso';
const PROYECTO_ESTADO_PRODUCCION = 'en_proceso';
const CODIGO_PROYECTO_MAX = 30;

/** RUT chileno '12345678-5' (sin puntos, guion y DV) validado por módulo 11; null si no es válido. */
function normalizarRut(valor) {
  const s = String(valor ?? '').replace(/\./g, '').replace(/\s/g, '').toUpperCase();
  const m = /^(\d{7,8})-?([\dK])$/.exec(s);
  if (!m) return null;
  let suma = 0, mult = 2;
  for (const d of m[1].split('').reverse()) { suma += Number(d) * mult; mult = mult === 7 ? 2 : mult + 1; }
  const r = 11 - (suma % 11);
  const dv = r === 11 ? '0' : r === 10 ? 'K' : String(r);
  return dv === m[2] ? `${m[1]}-${dv}` : null;
}

/** Siguiente código libre PRY-AAAA-NNN del año en curso. */
async function codigoProyectoSugerido(db) {
  const anio = new Date().getFullYear();
  const { rows } = await db.query(
    `SELECT COALESCE(MAX(SUBSTRING(codigo_proyecto FROM '^PRY-${anio}-(\\d+)$')::int), 0) + 1 AS n
     FROM terreno.proyecto WHERE codigo_proyecto ~ '^PRY-${anio}-\\d+$'`);
  return `PRY-${anio}-${String(rows[0].n).padStart(3, '0')}`;
}

/**
 * GET /api/ordenes-trabajo/proyectos/nuevo (gerencia)
 * Lo que necesita el formulario "Nuevo proyecto": clientes de Terreno y el código sugerido.
 */
async function opcionesNuevoProyecto(req, res) {
  try {
    const { rows: clientes } = await query(
      `SELECT rut_cliente AS rut, razon_social FROM terreno.cliente ORDER BY razon_social`);
    res.json({ clientes, codigo_sugerido: await codigoProyectoSugerido({ query }) });
  } catch (err) {
    responderError(res, err, 'Error cargando las opciones del nuevo proyecto:');
  }
}

/**
 * POST /api/ordenes-trabajo/proyectos (gerencia)
 * Body: { codigo, nombre, fecha_instalacion, rut_cliente } o, con un cliente nuevo,
 *       { codigo, nombre, fecha_instalacion, cliente_nuevo: { rut, razon_social, contacto, correo, telefono, es_empresa } }
 * Escribe en terreno.proyecto (y terreno.cliente) en una transacción. El código no se repite.
 */
async function crearProyecto(req, res) {
  const b = req.body || {};
  const txt = (v) => (typeof v === 'string' ? v.trim() : '');
  const malo = (error, campo) => res.status(400).json({ error, campo });

  const codigo = txt(b.codigo).toUpperCase();
  const nombre = txt(b.nombre);
  const fecha = txt(b.fecha_instalacion);
  if (!codigo || codigo.length > CODIGO_PROYECTO_MAX || !/^[A-Z0-9][A-Z0-9-]*$/.test(codigo)) {
    return malo(`El código es obligatorio: letras, números y guiones, hasta ${CODIGO_PROYECTO_MAX} caracteres.`, 'codigo');
  }
  if (nombre.length < 3 || nombre.length > 150) return malo('El nombre debe tener entre 3 y 150 caracteres.', 'nombre');
  const [fa, fm, fd] = fecha.split('-').map(Number);
  const fechaReal = new Date(fa, fm - 1, fd);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || fechaReal.getMonth() !== fm - 1 || fechaReal.getDate() !== fd) {
    return malo('Indique la fecha de instalación.', 'fecha_instalacion');
  }

  let clienteNuevo = null;
  let rutCliente = null;
  if (b.cliente_nuevo) {
    const c = b.cliente_nuevo;
    const rut = normalizarRut(c.rut);
    if (!rut) return malo('El RUT del cliente no es válido (ej: 12345678-5).', 'cliente_rut');
    for (const [campo, titulo] of [['razon_social', 'el nombre o razón social'], ['contacto', 'el contacto'], ['telefono', 'el teléfono']]) {
      if (!txt(c[campo])) return malo(`Indique ${titulo} del cliente.`, `cliente_${campo}`);
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(txt(c.correo))) return malo('El correo del cliente no es válido.', 'cliente_correo');
    clienteNuevo = { rut, razon_social: txt(c.razon_social), contacto: txt(c.contacto), correo: txt(c.correo),
                     telefono: txt(c.telefono), es_empresa: c.es_empresa !== false };
    rutCliente = rut;
  } else {
    rutCliente = normalizarRut(b.rut_cliente) || txt(b.rut_cliente);
    if (!rutCliente) return malo('Elija el cliente del proyecto o cree uno nuevo.', 'rut_cliente');
  }

  try {
    const creado = await conTransaccion(async (client) => {
      // Dos proyectos con el mismo código creados a la vez: el segundo espera y ve el primero
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('terreno.proyecto.codigo'))`);
      const { rows: dup } = await client.query(
        `SELECT 1 FROM terreno.proyecto WHERE UPPER(TRIM(codigo_proyecto)) = $1`, [codigo]);
      if (dup.length) {
        throw new ErrorNegocio(409, { error: `Ya existe un proyecto con el código ${codigo}.`, campo: 'codigo',
                                      codigo_sugerido: await codigoProyectoSugerido(client) });
      }

      const { rows: cli } = await client.query(`SELECT 1 FROM terreno.cliente WHERE rut_cliente = $1`, [rutCliente]);
      if (clienteNuevo && cli.length) {
        throw new ErrorNegocio(409, { error: `El cliente ${rutCliente} ya existe: elíjalo de la lista.`, campo: 'cliente_rut' });
      }
      if (!clienteNuevo && !cli.length) {
        throw new ErrorNegocio(404, { error: 'El cliente elegido no existe.', campo: 'rut_cliente' });
      }
      if (clienteNuevo) {
        await client.query(
          `INSERT INTO terreno.cliente (rut_cliente, razon_social, contacto_principal, correo, telefono, es_cliente_b2c, es_cliente_b2b)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [clienteNuevo.rut, clienteNuevo.razon_social, clienteNuevo.contacto, clienteNuevo.correo, clienteNuevo.telefono,
           !clienteNuevo.es_empresa, clienteNuevo.es_empresa]);
      }

      const { rows } = await client.query(
        `INSERT INTO terreno.proyecto (codigo_proyecto, nombre_referencia, fecha_instalacion, fecha_ingreso,
                                       estado_operacional, estado_produccion, rut_cliente)
         VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6)
         RETURNING id_proyecto AS id, codigo_proyecto AS codigo, nombre_referencia AS nombre`,
        [codigo, nombre, fecha, PROYECTO_ESTADO_OPERACIONAL, PROYECTO_ESTADO_PRODUCCION, rutCliente]);
      return rows[0];
    });

    await auditoria.registrar(req.user?.id, 'crear_proyecto',
      `Proyecto ${creado.codigo} (#${creado.id})${clienteNuevo ? `, cliente nuevo ${clienteNuevo.rut}` : ''}`);
    res.status(201).json({ ...creado, cliente_creado: !!clienteNuevo });
  } catch (err) {
    responderError(res, err, 'Error creando el proyecto:');
  }
}

module.exports = {
  crear, opcionesNueva, anular, proyectosConOT, opcionesNuevoProyecto, crearProyecto, cambiarResponsable, validarResponsable, guardarMedidas,
  listar, consultarConsumos, registrarConsumo, editarConsumo,
  registrarEstimados, comparativo, costos, rentabilidad,
  eliminarMaterial, asignarEmpleadoTentativo, movimientosOT,
  finalizar, consultarDiferenciales, procesarDiferenciales,
  guardarConsumo, corregirConsumoCerrada,
  ESTADOS_OT_CERRADA,   // D65: también la usa seguimientoPinturas
};
