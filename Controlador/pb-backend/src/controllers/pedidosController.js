const { query } = require('../db/pool');
const { ErrorNegocio, conTransaccion, responderError } = require('../db/tx');

/**
 * OPUS-3: reserva FIFO de stock para un material, bloqueando las filas de
 * inventario_bodega (FOR UPDATE) para que dos reservas simultaneas del mismo
 * material no lean el mismo disponible. Devuelve { ok, disponible, lotes }.
 * Si no alcanza el stock NO reserva nada y responde ok:false.
 */
async function reservarStockFifo(client, sku, cantidad) {
  const { rows: lotes } = await client.query(
    `SELECT ib.lote_id_lote, ib.bodega_id_bodega,
            ib.inventario_bodega_cantidad_fisica - ib.inventario_bodega_cantidad_reservada AS disponible
     FROM inventario_bodega ib
     JOIN lote l ON l.lote_id_lote = ib.lote_id_lote
     WHERE ib.material_sku = $1
       AND ib.inventario_bodega_cantidad_fisica > ib.inventario_bodega_cantidad_reservada
     ORDER BY l.lote_fecha_ingreso ASC NULLS LAST
     FOR UPDATE OF ib`,
    [sku]
  );

  const disponible = lotes.reduce((acc, l) => acc + parseFloat(l.disponible), 0);
  if (cantidad > disponible + 1e-9) return { ok: false, disponible, lotes: [] };

  let restante = cantidad;
  const usados = [];
  for (const lote of lotes) {
    if (restante <= 1e-9) break;
    const reservar = Math.min(restante, parseFloat(lote.disponible));
    await client.query(
      `UPDATE inventario_bodega
       SET inventario_bodega_cantidad_reservada = inventario_bodega_cantidad_reservada + $1
       WHERE material_sku = $2 AND lote_id_lote = $3 AND bodega_id_bodega = $4`,
      [reservar, sku, lote.lote_id_lote, lote.bodega_id_bodega]
    );
    usados.push({ lote_id: lote.lote_id_lote, bodega_id: lote.bodega_id_bodega, cantidad: reservar });
    restante -= reservar;
  }
  return { ok: true, disponible, lotes: usados };
}

/**
 * GET /api/pedidos
 * Lista órdenes de trabajo con estado de stock para el checklist (FR-65, FR-74)
 * Query params: ?estado=&buscar=&page=&limit=
 *
 * OPUS-6: el stock disponible y lo ya reservado se calculan con subconsultas
 * LATERAL por material, no con LEFT JOINs directos. Antes, si un material tenia
 * mas de una reserva activa para la misma OT, el JOIN multiplicaba las filas y
 * total_materiales / materiales_ok contaban de mas (una OT de 2 materiales podia
 * reportar 3). Ademas ya_reservado tomaba UNA reserva en vez de la suma.
 * Sin page/limit devuelve la lista completa (compatibilidad con el dashboard).
 */
async function listar(req, res) {
  const { estado, buscar, page, limit } = req.query;

  const usaPaginacion = page != null || limit != null;
  const limitNum  = Math.max(1, Math.min(parseInt(limit || 20, 10) || 20, 200));
  const pageNum   = Math.max(1, parseInt(page || 1, 10) || 1);
  const offsetNum = (pageNum - 1) * limitNum;

  try {
    const { rows } = await query(
      `SELECT
         ot.orden_trabajo_id_orden                           AS id,
         ot.orden_trabajo_fecha_hora                         AS fecha,
         ot.orden_trabajo_estado                             AS estado,
         ot.proyecto_id_proyecto                             AS proyecto_id,
         p.codigo_proyecto                                   AS proyecto_codigo,
         p.nombre_referencia                                 AS proyecto_nombre,
         p.estado_operacional                                AS proyecto_estado,
         p.rut_cliente                                       AS rut_cliente,
         at.area_trabajo_nombre_area                         AS area,
         u.usuario_username                                  AS responsable,
         COALESCE(res.total_materiales, 0)                   AS total_materiales,
         COALESCE(res.materiales_ok, 0)                      AS materiales_ok,
         COALESCE(res.materiales_faltantes, 0)               AS materiales_faltantes,
         COALESCE(res.criticos_faltantes, 0)                 AS criticos_faltantes,
         COUNT(*) OVER()                                     AS total_registros
       FROM orden_trabajo ot
       LEFT JOIN terreno.proyecto p ON p.id_proyecto = ot.proyecto_id_proyecto
       LEFT JOIN area_trabajo at    ON at.area_trabajo_id_area = ot.area_trabajo_id_area
       LEFT JOIN usuario u          ON u.usuario_id_usuario = ot.usuario_id_usuario
       -- Resumen de materiales de la OT: UNA fila por material, sin fan-out
       LEFT JOIN LATERAL (
         SELECT
           COUNT(*)                                                        AS total_materiales,
           COUNT(*) FILTER (WHERE d.reservado >= d.requerido
                               OR d.disponible >= d.requerido)             AS materiales_ok,
           COUNT(*) FILTER (WHERE d.reservado < d.requerido
                              AND d.disponible < d.requerido)              AS materiales_faltantes,
           COUNT(*) FILTER (WHERE d.reservado < d.requerido
                              AND d.disponible < d.requerido
                              AND d.es_critico)                            AS criticos_faltantes
         FROM (
           SELECT
             COALESCE(mot.material_orden_trabajo_consumo_estimado, 0) AS requerido,
             m.material_material_critico                              AS es_critico,
             COALESCE((SELECT SUM(ib.inventario_bodega_cantidad_fisica
                                - ib.inventario_bodega_cantidad_reservada)
                       FROM inventario_bodega ib
                       WHERE ib.material_sku = mot.material_sku), 0)   AS disponible,
             COALESCE((SELECT SUM(ri.reserva_inventario_cantidad_reservada)
                       FROM reserva_inventario ri
                       WHERE ri.material_sku = mot.material_sku
                         AND ri.orden_trabajo_id_orden = ot.orden_trabajo_id_orden
                         AND ri.reserva_inventario_estado_reserva = 'activa'), 0) AS reservado
           FROM material_orden_trabajo mot
           JOIN material m ON m.material_sku = mot.material_sku
           WHERE mot.orden_trabajo_id_orden = ot.orden_trabajo_id_orden
         ) d
       ) res ON TRUE
       WHERE ($1::text IS NULL OR ot.orden_trabajo_estado = $1)
         AND ($2::text IS NULL OR
              p.codigo_proyecto ILIKE '%' || $2 || '%' OR
              p.nombre_referencia ILIKE '%' || $2 || '%')
       ORDER BY ot.orden_trabajo_fecha_hora DESC
       LIMIT $3 OFFSET $4`,
      [estado || null, buscar || null,
       usaPaginacion ? limitNum : null,     // LIMIT NULL = sin limite
       usaPaginacion ? offsetNum : 0]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listando pedidos:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/pedidos/:id/checklist
 * Checklist detallado de materiales para una orden de trabajo (FR-74)
 * Muestra estado disponible / faltante / reservado por material
 */
async function checklist(req, res) {
  const { id } = req.params;
  try {
    // Datos de la orden
    const { rows: orden } = await query(
      `SELECT
         ot.orden_trabajo_id_orden    AS id,
         ot.orden_trabajo_estado      AS estado,
         ot.orden_trabajo_fecha_hora  AS fecha,
         ot.proyecto_id_proyecto      AS proyecto_id,
         p.codigo_proyecto            AS proyecto_codigo,
         p.nombre_referencia          AS proyecto_nombre,
         p.rut_cliente                AS rut_cliente,
         at.area_trabajo_nombre_area       AS area,
         u.usuario_username           AS responsable
       FROM orden_trabajo ot
       LEFT JOIN terreno.proyecto p ON p.id_proyecto = ot.proyecto_id_proyecto
       LEFT JOIN area_trabajo at    ON at.area_trabajo_id_area = ot.area_trabajo_id_area
       LEFT JOIN usuario u          ON u.usuario_id_usuario = ot.usuario_id_usuario
       WHERE ot.orden_trabajo_id_orden = $1`,
      [id]
    );

    if (orden.length === 0) {
      return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
    }

    // Materiales requeridos con stock disponible (FR-65)
    // OPUS-6: stock y reservas con subconsultas LATERAL. Antes el LEFT JOIN a
    // inventario_bodega + LEFT JOIN a reserva_inventario se multiplicaban entre si:
    // con dos reservas activas del mismo material el SKU aparecia DUPLICADO en el
    // checklist y el stock disponible salia al doble.
    const { rows: materiales } = await query(
      `SELECT
         mot.material_sku                                    AS sku,
         m.material_nombre_material                          AS nombre,
         m.material_material_critico                         AS es_critico,
         um.material_unidad_medida_nombre                    AS unidad,
         mot.material_orden_trabajo_consumo_estimado         AS cantidad_requerida,
         mot.material_orden_trabajo_consumo_real             AS cantidad_real,
         COALESCE(stock.disponible, 0)                       AS stock_disponible,
         COALESCE(res.reservado, 0)                          AS ya_reservado,
         res.reserva_ids                                     AS reserva_ids,
         CASE
           WHEN COALESCE(res.reservado, 0) >= COALESCE(mot.material_orden_trabajo_consumo_estimado, 0)
             THEN 'reservado'
           WHEN COALESCE(stock.disponible, 0) >= COALESCE(mot.material_orden_trabajo_consumo_estimado, 0)
             THEN 'disponible'
           ELSE 'faltante'
         END                                                 AS estado_stock
       FROM material_orden_trabajo mot
       JOIN material m ON m.material_sku = mot.material_sku
       LEFT JOIN material_unidad_medida um
              ON um.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
       LEFT JOIN LATERAL (
         SELECT SUM(ib.inventario_bodega_cantidad_fisica
                  - ib.inventario_bodega_cantidad_reservada) AS disponible
         FROM inventario_bodega ib
         WHERE ib.material_sku = mot.material_sku
       ) stock ON TRUE
       LEFT JOIN LATERAL (
         SELECT SUM(ri.reserva_inventario_cantidad_reservada) AS reservado,
                ARRAY_AGG(ri.reserva_inventario_id_reserva ORDER BY ri.reserva_inventario_id_reserva) AS reserva_ids
         FROM reserva_inventario ri
         WHERE ri.material_sku = mot.material_sku
           AND ri.orden_trabajo_id_orden = mot.orden_trabajo_id_orden
           AND ri.reserva_inventario_estado_reserva = 'activa'
       ) res ON TRUE
       WHERE mot.orden_trabajo_id_orden = $1
       ORDER BY estado_stock DESC, m.material_nombre_material`,
      [id]
    );

    // Preparaciones del pedido
    const { rows: preparaciones } = await query(
      `SELECT
         pp.preparacion_pedido_id_preparacion AS id,
         pp.preparacion_pedido_observacion    AS observacion,
         ppe.preparacion_pedido_estado_nombre_estado     AS estado,
         ppe.preparacion_pedido_estado_timestamp_accion  AS timestamp
       FROM preparacion_pedido pp
       JOIN reserva_inventario ri ON ri.reserva_inventario_id_reserva = pp.reserva_inventario_id_reserva
       LEFT JOIN preparacion_pedido_estado ppe
              ON ppe.preparacion_pedido_id_preparacion = pp.preparacion_pedido_id_preparacion
       WHERE ri.orden_trabajo_id_orden = $1
       ORDER BY ppe.preparacion_pedido_estado_timestamp_accion DESC`,
      [id]
    );

    // CU-108 / CU-117: ubicaciones para facilitar la recolección.
    // OPUS-6: ahora incluye el ANAQUEL — inventario_bodega.anaquel_id_anaquel existe
    // desde OPUS-5, antes solo se podia mostrar la bodega.
    const { rows: ubicaciones } = await query(
      `SELECT
         ib.material_sku                                     AS sku,
         ib.bodega_id_bodega                                 AS bodega_id,
         b.bodega_nombre_bodega                              AS bodega_nombre,
         ib.anaquel_id_anaquel                               AS anaquel_id,
         a.anaquel_descripcion                               AS anaquel,
         SUM(ib.inventario_bodega_cantidad_fisica)           AS cantidad
       FROM inventario_bodega ib
       JOIN bodega b ON b.bodega_id_bodega = ib.bodega_id_bodega
       LEFT JOIN anaquel a ON a.anaquel_id_anaquel = ib.anaquel_id_anaquel
       JOIN material_orden_trabajo mot
            ON mot.material_sku = ib.material_sku
           AND mot.orden_trabajo_id_orden = $1
       WHERE ib.inventario_bodega_cantidad_fisica > 0
       GROUP BY ib.material_sku, ib.bodega_id_bodega, b.bodega_nombre_bodega,
                ib.anaquel_id_anaquel, a.anaquel_descripcion
       ORDER BY b.bodega_nombre_bodega, a.anaquel_descripcion NULLS LAST`,
      [id]
    );

    // Crear mapa de ubicación por SKU
    const ubicacionPorSku = {};
    for (const u of ubicaciones) {
      if (!ubicacionPorSku[u.sku]) ubicacionPorSku[u.sku] = [];
      ubicacionPorSku[u.sku].push({
        bodega_id: u.bodega_id,
        bodega: u.bodega_nombre,
        anaquel_id: u.anaquel_id,
        anaquel: u.anaquel,
        cantidad: parseFloat(u.cantidad)
      });
    }

    // CU-118: Detectar materiales con solicitud de compra emitida
    const { rows: solicitudes } = await query(
      `SELECT DISTINCT material_sku AS sku
       FROM alerta_faltante_pedido
       WHERE proyecto_id_proyecto IS NOT DISTINCT FROM $1
         AND alerta_faltante_pedido_estado = 'solicitud_emitida'`,
      [orden[0].proyecto_id]
    );
    const skusSolicitud = new Set(solicitudes.map(s => s.sku));

    // CU-119: Para materiales faltantes, buscar stock disponible en otras bodegas
    // OPUS-6: agrupado POR BODEGA. Antes devolvia una fila por lote, asi que la
    // misma bodega aparecia repetida varias veces en el aviso de traslado.
    const { rows: stockOtrasBodegas } = await query(
      `SELECT ib.material_sku        AS sku,
              ib.bodega_id_bodega    AS bodega_id,
              b.bodega_nombre_bodega AS bodega,
              SUM(ib.inventario_bodega_cantidad_fisica
                - ib.inventario_bodega_cantidad_reservada) AS disponible
       FROM inventario_bodega ib
       JOIN bodega b ON b.bodega_id_bodega = ib.bodega_id_bodega
       JOIN material_orden_trabajo mot
            ON mot.material_sku = ib.material_sku
           AND mot.orden_trabajo_id_orden = $1
       GROUP BY ib.material_sku, ib.bodega_id_bodega, b.bodega_nombre_bodega
       HAVING SUM(ib.inventario_bodega_cantidad_fisica
                - ib.inventario_bodega_cantidad_reservada) > 0
       ORDER BY 4 DESC`,
      [id]
    );
    const stockAlternativo = {};
    for (const s of stockOtrasBodegas) {
      if (!stockAlternativo[s.sku]) stockAlternativo[s.sku] = [];
      stockAlternativo[s.sku].push({ bodega_id: s.bodega_id, bodega: s.bodega, disponible: parseFloat(s.disponible) });
    }

    // Enriquecer materiales con ubicaciones, solicitud de compra y stock alternativo
    const materialesConUbicacion = materiales.map(m => ({
      ...m,
      ubicaciones: ubicacionPorSku[m.sku] || [],
      solicitud_compra: skusSolicitud.has(m.sku),
      stock_otras_bodegas: m.estado_stock === 'faltante' ? (stockAlternativo[m.sku] || []) : []
    }));

    res.json({
      orden: orden[0],
      materiales: materialesConUbicacion,
      preparaciones,
      resumen: {
        total:      materiales.length,
        disponible: materiales.filter(m => m.estado_stock === 'disponible').length,
        reservado:  materiales.filter(m => m.estado_stock === 'reservado').length,
        faltante:   materiales.filter(m => m.estado_stock === 'faltante').length,
      }
    });
  } catch (err) {
    console.error('Error obteniendo checklist:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/pedidos/:id/discrepancia
 * CU-110: Reportar discrepancia en checklist
 * Body: { sku, tipo, descripcion }
 */
async function reportarDiscrepancia(req, res) {
  const { id } = req.params;
  const { sku, tipo, descripcion } = req.body;
  const userId = req.user.id;

  // CU-110 Exc 1: campos obligatorios
  if (!sku || !descripcion || !descripcion.trim()) {
    return res.status(400).json({ error: 'SKU y descripción de la discrepancia son requeridos' });
  }

  // CU-110 Exc 2: verificar que la OT existe
  try {
    const { rows: ot } = await query(
      `SELECT orden_trabajo_id_orden AS id, proyecto_id_proyecto AS proyecto_id
       FROM orden_trabajo WHERE orden_trabajo_id_orden = $1`, [id]
    );
    if (ot.length === 0) {
      return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
    }

    // CU-110 Exc 3: verificar que el material pertenece a la OT
    // OPUS-6: se trae tambien el consumo estimado para que la alerta nazca con la
    // cantidad requerida real. Antes se guardaba requerida = 0 y en la vista de
    // faltantes la alerta aparecia como "requiere 0".
    const { rows: mat } = await query(
      `SELECT material_sku,
              COALESCE(material_orden_trabajo_consumo_estimado, 0) AS requerido
       FROM material_orden_trabajo
       WHERE orden_trabajo_id_orden = $1 AND material_sku = $2`, [id, sku]
    );
    if (mat.length === 0) {
      return res.status(400).json({ error: 'El material no está asociado a esta orden de trabajo' });
    }

    // Generar alerta de discrepancia usando alerta_faltante_pedido
    const { rows: stockActual } = await query(
      `SELECT COALESCE(SUM(inventario_bodega_cantidad_fisica) -
                        SUM(inventario_bodega_cantidad_reservada), 0) AS disponible
       FROM inventario_bodega WHERE material_sku = $1`, [sku]
    );

    await query(
      `INSERT INTO alerta_faltante_pedido (
         alerta_faltante_pedido_cantidad_disponible,
         alerta_faltante_pedido_cantidad_requerida,
         alerta_faltante_pedido_horas_anticipacion,
         alerta_faltante_pedido_estado,
         material_sku, proyecto_id_proyecto, usuario_id_usuario
       ) VALUES ($1, $2, 0, 'activa', $3, $4, $5)`,
      [stockActual[0]?.disponible || 0, mat[0].requerido, sku, ot[0].proyecto_id, userId]
    );

    // Notificar
    const { notificarPorRol } = require('./notificacionesController');
    notificarPorRol({
      tipo: 'discrepancia_checklist',
      mensaje: `Discrepancia reportada en OT #${id} para ${sku}: ${tipo || 'general'} — ${descripcion}`,
      origen: 'pedidos',
      rol: 'jop'
    });

    const audLog = require('./auditoriaController');
    audLog.registrar(userId, 'reportar_discrepancia', `OT: ${id}, SKU: ${sku}, tipo: ${tipo || 'general'}`);

    // CU-119: Verificar si hay stock en otras bodegas para sugerir traslado
    // OPUS-6: agrupado POR BODEGA. Antes devolvia una fila por lote, asi que el
    // aviso repetia la misma bodega tantas veces como lotes tuviera el material.
    const { rows: otrasBodegas } = await query(
      `SELECT b.bodega_id_bodega      AS bodega_id,
              b.bodega_nombre_bodega  AS bodega,
              SUM(ib.inventario_bodega_cantidad_fisica
                - ib.inventario_bodega_cantidad_reservada) AS cantidad,
              MIN(u.material_unidad_medida_nombre) AS unidad
       FROM inventario_bodega ib
       JOIN bodega b ON b.bodega_id_bodega = ib.bodega_id_bodega
       JOIN material mat ON mat.material_sku = ib.material_sku
       LEFT JOIN material_unidad_medida u ON u.material_unidad_medida_id_unidad_medida = mat.material_unidad_medida_id_unidad_medida
       WHERE ib.material_sku = $1
       GROUP BY b.bodega_id_bodega, b.bodega_nombre_bodega
       HAVING SUM(ib.inventario_bodega_cantidad_fisica
                - ib.inventario_bodega_cantidad_reservada) > 0
       ORDER BY 3 DESC`,
      [sku]
    );

    res.status(201).json({
      message: 'Discrepancia reportada correctamente. Se generó una alerta.',
      stock_otras_bodegas: otrasBodegas.length > 0 ? otrasBodegas : undefined
    });
  } catch (err) {
    console.error('Error reportando discrepancia:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/pedidos/:id/reservar
 * Reservar stock para una orden de trabajo (FR-65)
 */
async function reservar(req, res) {
  const { id } = req.params;
  const { materiales } = req.body;
  // materiales: [{ sku, cantidad }]

  if (!Array.isArray(materiales) || materiales.length === 0) {
    return res.status(400).json({ error: 'Debes enviar al menos un material a reservar' });
  }

  try {
    const resultados = await conTransaccion(async (client) => {
      // OPUS-3: la OT tiene que existir y estar abierta. Ademas necesitamos su
      // proyecto: la reserva se guardaba sin proyecto_id_proyecto y por eso la
      // vista de reservas mostraba siempre el proyecto vacio.
      const { rows: ot } = await client.query(
        `SELECT orden_trabajo_id_orden AS id, orden_trabajo_estado AS estado,
                proyecto_id_proyecto AS proyecto_id
         FROM orden_trabajo WHERE orden_trabajo_id_orden = $1`,
        [id]
      );
      if (ot.length === 0) {
        throw new ErrorNegocio(404, { error: 'Orden de trabajo no encontrada' });
      }
      if (['cancelada', 'finalizada', 'completada', 'cerrada'].includes(String(ot[0].estado).toLowerCase())) {
        throw new ErrorNegocio(400, { error: 'No se puede reservar stock para una OT cerrada o cancelada' });
      }

      const out = [];
      for (const item of materiales) {
        const { sku } = item;
        const cantidad = parseFloat(item.cantidad);

        if (!sku || isNaN(cantidad) || cantidad <= 0) {
          out.push({ sku: sku || null, estado: 'omitido', motivo: 'SKU o cantidad invalidos' });
          continue;
        }

        // Reserva FIFO con bloqueo: el chequeo de disponible y el incremento de
        // cantidad_reservada ocurren dentro de la misma transaccion.
        const fifo = await reservarStockFifo(client, sku, cantidad);
        if (!fifo.ok) {
          out.push({ sku, estado: 'faltante', disponible: fifo.disponible, requerido: cantidad });
          continue;
        }

        const { rows: reserva } = await client.query(
          `INSERT INTO reserva_inventario (
             reserva_inventario_cantidad_reservada,
             reserva_inventario_estado_reserva,
             material_sku,
             orden_trabajo_id_orden,
             proyecto_id_proyecto
           ) VALUES ($1, 'activa', $2, $3, $4)
           RETURNING reserva_inventario_id_reserva AS id`,
          [cantidad, sku, id, ot[0].proyecto_id || null]
        );

        out.push({ sku, estado: 'reservado', id: reserva[0]?.id, cantidad, lotes: fifo.lotes.length });
      }
      return out;
    });

    const reservados = resultados.filter(r => r.estado === 'reservado');
    const todoOk = resultados.length > 0 && resultados.every(r => r.estado === 'reservado');

    if (reservados.length > 0) {
      const audLog = require('./auditoriaController');
      await audLog.registrar(req.user?.id, 'reservar_materiales',
        `OT #${id}: ${reservados.length} material(es) reservado(s) — ${reservados.map(r => `${r.sku} x${r.cantidad}`).join(', ')}`);
    }

    res.status(todoOk ? 200 : 207).json({
      message: todoOk
        ? 'Todos los materiales reservados correctamente'
        : 'Reserva parcial — algunos materiales no tienen stock suficiente',
      resultados
    });
  } catch (err) {
    responderError(res, err, 'Error reservando materiales:');
  }
}

module.exports = { listar, checklist, reservar, reportarDiscrepancia, reservarStockFifo };   // CU-131 reutiliza el FIFO
