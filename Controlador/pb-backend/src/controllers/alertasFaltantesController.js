const { query } = require('../db/pool');
const { ocultaMontos, quitarCampos } = require('../middleware/auth');
const { notificarPorRol } = require('./notificacionesController');
const auditoria = require('./auditoriaController');

/**
 * Ventana por defecto para considerar una OT "proxima" (OPUS-2).
 * Antes estaba fija en 48 horas, lo que dejaba fuera casi todos los faltantes
 * reales: las OTs sin fecha de instalacion y las que se instalan en mas de 2 dias
 * nunca generaban alerta. Ahora son 90 dias por defecto y se puede ajustar por
 * query param (?horas_anticipacion=N).
 */
const HORAS_ANTICIPACION_DEFAULT = 24 * 90; // 90 dias

/**
 * POST /api/alertas-faltantes/generar
 * Revisa las OTs abiertas y genera alertas por stock insuficiente (CU-105)
 * Query params: ?horas_anticipacion=N  (default: 2160 = 90 dias)
 */
async function generar(req, res) {
  const horasParam = parseInt(req.query.horas_anticipacion, 10);
  const horas = Number.isFinite(horasParam) && horasParam > 0
    ? horasParam
    : HORAS_ANTICIPACION_DEFAULT;

  try {
    const r = await generarAlertasFaltantes({ horasAnticipacion: horas });

    let message;
    if (r.generadas > 0) {
      message = `Se generaron ${r.generadas} alerta(s) de faltante`
              + (r.actualizadas > 0 ? ` y se actualizaron ${r.actualizadas} existente(s).` : '.');
    } else if (r.actualizadas > 0) {
      message = `No se detectaron faltantes nuevos. Se actualizaron ${r.actualizadas} alerta(s) existente(s).`;
    } else if (r.revisados > 0) {
      message = `No se detectaron faltantes nuevos: los ${r.revisados} faltante(s) detectado(s) ya tienen una alerta abierta.`;
    } else {
      message = 'No se detectaron faltantes: las ordenes de trabajo abiertas tienen stock suficiente.';
    }

    if (r.generadas > 0 || r.actualizadas > 0) {
      await auditoria.registrar(req.user?.id, 'Generar alertas faltantes',
        `${r.generadas} generada(s), ${r.actualizadas} actualizada(s) sobre ${r.revisados} faltante(s) detectado(s)`);
    }

    res.json({
      message,
      total: r.generadas,          // compatibilidad con el frontend existente
      generadas: r.generadas,
      actualizadas: r.actualizadas,
      sin_cambio: r.sinCambio,
      revisados: r.revisados,
      horas_anticipacion: horas,
      detalle: r.detalle
    });
  } catch (err) {
    console.error('Error generando alertas faltantes:', err);
    // CU-113 CP3: Informar que la verificacion de faltantes no pudo completarse
    res.status(500).json({
      error: 'La verificación de faltantes no pudo completarse. Los datos de la agenda de instalaciones no están disponibles. Solicite reintentar.',
      reintentar: true
    });
  }
}

/**
 * Logica central: detecta materiales con stock insuficiente en OTs abiertas.
 *
 * OPUS-2 — que cambio respecto de la version anterior:
 *  - La ventana de 48h fijas (`fecha_instalacion BETWEEN NOW() AND NOW()+48h`)
 *    descartaba practicamente todo. Ahora la ventana es configurable (90 dias por
 *    defecto), se incluyen las OTs SIN fecha de instalacion y las OTs SIN proyecto,
 *    y no se descarta una instalacion ya vencida que sigue con la OT abierta.
 *  - La necesidad se agrupa por (material, proyecto) sumando lo estimado de TODAS
 *    las OTs de ese proyecto: antes cada OT competia por la misma alerta y solo
 *    sobrevivia la cantidad de la primera.
 *  - Si ya existe una alerta abierta para ese par, se ACTUALIZA con las cantidades
 *    vigentes en vez de ignorarla en silencio.
 */
async function generarAlertasFaltantes(opts = {}) {
  const horas = Number.isFinite(opts.horasAnticipacion) && opts.horasAnticipacion > 0
    ? opts.horasAnticipacion
    : HORAS_ANTICIPACION_DEFAULT;

  const { rows: faltantes } = await query(
    `WITH necesidad AS (
       SELECT
         mot.material_sku                                        AS sku,
         ot.proyecto_id_proyecto                                 AS proyecto_id,
         SUM(COALESCE(mot.material_orden_trabajo_consumo_estimado, 0)) AS requerido,
         MIN(proy.fecha_instalacion)                             AS fecha_instalacion,
         ARRAY_AGG(DISTINCT mot.orden_trabajo_id_orden ORDER BY mot.orden_trabajo_id_orden) AS ordenes
       FROM material_orden_trabajo mot
       JOIN orden_trabajo ot ON ot.orden_trabajo_id_orden = mot.orden_trabajo_id_orden
       LEFT JOIN terreno.proyecto proy ON proy.id_proyecto = ot.proyecto_id_proyecto
       WHERE ot.orden_trabajo_estado NOT IN ('cancelada', 'finalizada', 'completada', 'listo', 'cerrada')
         AND COALESCE(mot.material_orden_trabajo_consumo_estimado, 0) > 0
         -- OTs sin fecha de instalacion tambien cuentan; las vencidas con la OT
         -- todavia abierta son las mas urgentes, por eso no hay cota inferior.
         AND (proy.fecha_instalacion IS NULL
              OR proy.fecha_instalacion <= NOW() + ($1::int * INTERVAL '1 hour'))
       GROUP BY mot.material_sku, ot.proyecto_id_proyecto
     )
     SELECT
       n.sku,
       m.material_nombre_material                AS nombre_material,
       n.proyecto_id,
       proy.codigo_proyecto                      AS proyecto_codigo,
       n.ordenes,
       n.requerido,
       n.fecha_instalacion,
       COALESCE(stock.disponible, 0)             AS disponible,
       CASE WHEN n.fecha_instalacion IS NULL THEN NULL
            ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (n.fecha_instalacion - NOW())) / 3600))
       END                                       AS horas_anticipacion,
       mp.proveedor_id_proveedor                 AS proveedor_id,
       mp.material_proveedor_tiempo_reposicion   AS tiempo_reposicion
     FROM necesidad n
     JOIN material m ON m.material_sku = n.sku
     LEFT JOIN terreno.proyecto proy ON proy.id_proyecto = n.proyecto_id
     LEFT JOIN LATERAL (
       SELECT SUM(ib.inventario_bodega_cantidad_fisica) -
              SUM(ib.inventario_bodega_cantidad_reservada) AS disponible
       FROM inventario_bodega ib
       WHERE ib.material_sku = n.sku
     ) stock ON TRUE
     LEFT JOIN material_proveedor mp
            ON mp.material_sku = n.sku
           AND mp.material_proveedor_proveedor_principal = TRUE
     WHERE n.requerido > COALESCE(stock.disponible, 0)
     ORDER BY n.fecha_instalacion ASC NULLS LAST, n.sku`,
    [horas]
  );

  let generadas = 0, actualizadas = 0, sinCambio = 0;
  const detalle = [];

  for (const f of faltantes) {
    const ots = (f.ordenes || []).join(', ');

    // Alerta abierta ya existente para el mismo par (material, proyecto)
    const { rows: existe } = await query(
      `SELECT alerta_faltante_pedido_id_alerta_faltante  AS id,
              alerta_faltante_pedido_cantidad_requerida  AS requerido,
              alerta_faltante_pedido_cantidad_disponible AS disponible
       FROM alerta_faltante_pedido
       WHERE material_sku = $1
         AND proyecto_id_proyecto IS NOT DISTINCT FROM $2
         AND alerta_faltante_pedido_estado IN ('activa', 'en_gestion', 'solicitud_emitida')
         -- CU-122: las de insumo especial (sin proyecto) no son faltantes de OT
         AND alerta_faltante_pedido_origen = 'faltante'
       ORDER BY alerta_faltante_pedido_id_alerta_faltante DESC
       LIMIT 1`,
      [f.sku, f.proyecto_id || null]
    );

    if (existe.length > 0) {
      const cambio = parseFloat(existe[0].requerido || 0)  !== parseFloat(f.requerido) ||
                     parseFloat(existe[0].disponible || 0) !== parseFloat(f.disponible);
      if (cambio) {
        await query(
          `UPDATE alerta_faltante_pedido
           SET alerta_faltante_pedido_cantidad_requerida  = $2,
               alerta_faltante_pedido_cantidad_disponible = $3,
               alerta_faltante_pedido_horas_anticipacion  = $4
           WHERE alerta_faltante_pedido_id_alerta_faltante = $1`,
          [existe[0].id, f.requerido, f.disponible, f.horas_anticipacion]
        );
        actualizadas++;
        console.log(`[faltantes] ${f.sku} (proy ${f.proyecto_id ?? 's/proyecto'}, OT ${ots}): alerta #${existe[0].id} actualizada -> requerido ${f.requerido}, disponible ${f.disponible}`);
        detalle.push({ sku: f.sku, nombre: f.nombre_material, proyecto_id: f.proyecto_id, ordenes: f.ordenes,
                       requerido: parseFloat(f.requerido), disponible: parseFloat(f.disponible),
                       resultado: 'actualizada', alerta_id: existe[0].id });
      } else {
        sinCambio++;
        console.log(`[faltantes] ${f.sku} (proy ${f.proyecto_id ?? 's/proyecto'}, OT ${ots}): omitido, ya existe la alerta abierta #${existe[0].id} con las mismas cantidades`);
        detalle.push({ sku: f.sku, nombre: f.nombre_material, proyecto_id: f.proyecto_id, ordenes: f.ordenes,
                       requerido: parseFloat(f.requerido), disponible: parseFloat(f.disponible),
                       resultado: 'sin_cambio', alerta_id: existe[0].id });
      }
      continue;
    }

    const { rows: creada } = await query(
      `INSERT INTO alerta_faltante_pedido (
         alerta_faltante_pedido_cantidad_disponible,
         alerta_faltante_pedido_cantidad_requerida,
         alerta_faltante_pedido_horas_anticipacion,
         alerta_faltante_pedido_estado,
         material_sku,
         proveedor_id_proveedor,
         proyecto_id_proyecto
       ) VALUES ($1, $2, $3, 'activa', $4, $5, $6)
       RETURNING alerta_faltante_pedido_id_alerta_faltante AS id`,
      [f.disponible, f.requerido, f.horas_anticipacion, f.sku, f.proveedor_id || null, f.proyecto_id || null]
    );
    generadas++;
    console.log(`[faltantes] ${f.sku} (proy ${f.proyecto_id ?? 's/proyecto'}, OT ${ots}): alerta #${creada[0].id} generada -> requerido ${f.requerido}, disponible ${f.disponible}`);
    detalle.push({ sku: f.sku, nombre: f.nombre_material, proyecto_id: f.proyecto_id, ordenes: f.ordenes,
                   requerido: parseFloat(f.requerido), disponible: parseFloat(f.disponible),
                   resultado: 'generada', alerta_id: creada[0].id });
  }

  // Notificar al JOP si se generaron alertas
  if (generadas > 0) {
    notificarPorRol({
      tipo: 'alerta_faltante',
      mensaje: `Se detectaron ${generadas} producto(s) con stock insuficiente para pedidos próximos.`,
      origen: 'alertas_faltantes',
      rol: 'jop'
    });
  }

  return { generadas, actualizadas, sinCambio, revisados: faltantes.length, detalle };
}

/**
 * GET /api/alertas-faltantes
 * Lista alertas de faltante con filtros (CU-105, CU-106)
 * Query params: ?estado=&buscar=
 */
async function listar(req, res) {
  const { estado, buscar, horas } = req.query;
  try {
    const { rows } = await query(
      `SELECT
         afp.alerta_faltante_pedido_id_alerta_faltante AS id,
         afp.alerta_faltante_pedido_fecha_generacion   AS fecha,
         COALESCE((SELECT SUM(ib.inventario_bodega_cantidad_fisica - ib.inventario_bodega_cantidad_reservada)
                   FROM inventario_bodega ib WHERE ib.material_sku = afp.material_sku), 0) AS cantidad_disponible,
         afp.alerta_faltante_pedido_cantidad_disponible AS cantidad_disponible_almacenada,
         afp.alerta_faltante_pedido_cantidad_requerida  AS cantidad_requerida,
         afp.alerta_faltante_pedido_horas_anticipacion  AS horas_anticipacion,
         afp.alerta_faltante_pedido_estado              AS estado,
         afp.material_sku                               AS sku,
         m.material_nombre_material                     AS material_nombre,
         m.material_material_critico                    AS es_critico,
         u_mat.material_unidad_medida_nombre            AS unidad,
         afp.proveedor_id_proveedor                     AS proveedor_id,
         p.proveedor_razon_social                       AS proveedor_nombre,
         mp.material_proveedor_tiempo_reposicion        AS tiempo_reposicion,
         afp.proyecto_id_proyecto                       AS proyecto_id,
         proy.codigo_proyecto                           AS proyecto_codigo,
         proy.nombre_referencia                         AS proyecto_nombre,
         proy.fecha_instalacion                          AS fecha_instalacion,
         afp.usuario_id_usuario                         AS resuelto_por_id,
         u.usuario_username                             AS resuelto_por,
         ots.ordenes                                    AS ordenes_afectadas
       FROM alerta_faltante_pedido afp
       JOIN material m ON m.material_sku = afp.material_sku
       LEFT JOIN material_unidad_medida u_mat
              ON u_mat.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
       LEFT JOIN proveedor p ON p.proveedor_id_proveedor = afp.proveedor_id_proveedor
       LEFT JOIN material_proveedor mp
              ON mp.material_sku = afp.material_sku
             AND mp.proveedor_id_proveedor = afp.proveedor_id_proveedor
       LEFT JOIN terreno.proyecto proy ON proy.id_proyecto = afp.proyecto_id_proyecto
       LEFT JOIN usuario u ON u.usuario_id_usuario = afp.usuario_id_usuario
       -- OPUS-3: OTs abiertas que necesitan este material en el proyecto de la alerta.
       -- alerta_faltante_pedido no guarda la OT, el vinculo se reconstruye por
       -- (material, proyecto). IS NOT DISTINCT FROM para que las alertas sin
       -- proyecto matcheen las OTs sin proyecto.
       LEFT JOIN LATERAL (
         SELECT COALESCE(json_agg(json_build_object(
                  'id',       ot.orden_trabajo_id_orden,
                  'estado',   ot.orden_trabajo_estado,
                  'estimado', mot.material_orden_trabajo_consumo_estimado,
                  'real',     mot.material_orden_trabajo_consumo_real
                ) ORDER BY ot.orden_trabajo_id_orden), '[]'::json) AS ordenes
         FROM material_orden_trabajo mot
         JOIN orden_trabajo ot ON ot.orden_trabajo_id_orden = mot.orden_trabajo_id_orden
         WHERE mot.material_sku = afp.material_sku
           AND ot.proyecto_id_proyecto IS NOT DISTINCT FROM afp.proyecto_id_proyecto
           AND ot.orden_trabajo_estado NOT IN ('cancelada', 'finalizada', 'completada', 'listo', 'cerrada')
       ) ots ON TRUE
       -- CU-122: esta vista es de faltantes de OT; los insumos especiales tienen su pestaña
       WHERE afp.alerta_faltante_pedido_origen = 'faltante'
         AND ($1::text IS NULL OR afp.alerta_faltante_pedido_estado = $1)
         AND ($2::text IS NULL OR
              afp.material_sku ILIKE '%' || $2 || '%' OR
              m.material_nombre_material ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR afp.alerta_faltante_pedido_fecha_generacion >= NOW() - (($3::int) * INTERVAL '1 hour'))
       ORDER BY
         CASE afp.alerta_faltante_pedido_estado
           WHEN 'activa' THEN 0
           WHEN 'en_gestion' THEN 1
           WHEN 'solicitud_emitida' THEN 2
           ELSE 3
         END,
         afp.alerta_faltante_pedido_fecha_generacion ASC`,
      [estado || null, buscar || null, horas || null]
    );

    // CU-114 CP2: Actualizar proactivamente alertas activas cuyo stock real subió
    for (const row of rows) {
      if (row.estado === 'activa') {
        const almacenado = parseFloat(row.cantidad_disponible_almacenada || 0);
        const real = parseFloat(row.cantidad_disponible || 0);
        if (real > almacenado) {
          await query(
            `UPDATE alerta_faltante_pedido
             SET alerta_faltante_pedido_estado = 'en_gestion',
                 alerta_faltante_pedido_cantidad_disponible = $2
             WHERE alerta_faltante_pedido_id_alerta_faltante = $1`,
            [row.id, real]
          );
          row.estado = 'en_gestion';
        }
      }
    }

    res.json(rows);
  } catch (err) {
    console.error('Error listando alertas faltantes:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/alertas-faltantes/:id
 * Detalle de un faltante con proveedor sugerido (CU-106)
 */
async function obtener(req, res) {
  const { id } = req.params;
  try {
    const { rows: alerta } = await query(
      `SELECT
         afp.alerta_faltante_pedido_id_alerta_faltante AS id,
         afp.alerta_faltante_pedido_estado              AS estado,
         afp.alerta_faltante_pedido_cantidad_disponible AS cantidad_disponible,
         afp.alerta_faltante_pedido_cantidad_requerida  AS cantidad_requerida,
         afp.material_sku                               AS sku,
         m.material_nombre_material                     AS material_nombre,
         m.material_material_critico                    AS es_critico,
         afp.proyecto_id_proyecto                       AS proyecto_id,
         proy.codigo_proyecto                           AS proyecto_codigo,
         proy.nombre_referencia                         AS proyecto_nombre,
         ots.ordenes                                    AS ordenes_afectadas
       FROM alerta_faltante_pedido afp
       JOIN material m ON m.material_sku = afp.material_sku
       LEFT JOIN terreno.proyecto proy ON proy.id_proyecto = afp.proyecto_id_proyecto
       -- OPUS-3: OTs abiertas que necesitan este material en el proyecto de la alerta.
       -- alerta_faltante_pedido no guarda la OT, el vinculo se reconstruye por
       -- (material, proyecto). IS NOT DISTINCT FROM para que las alertas sin
       -- proyecto matcheen las OTs sin proyecto.
       LEFT JOIN LATERAL (
         SELECT COALESCE(json_agg(json_build_object(
                  'id',       ot.orden_trabajo_id_orden,
                  'estado',   ot.orden_trabajo_estado,
                  'estimado', mot.material_orden_trabajo_consumo_estimado,
                  'real',     mot.material_orden_trabajo_consumo_real
                ) ORDER BY ot.orden_trabajo_id_orden), '[]'::json) AS ordenes
         FROM material_orden_trabajo mot
         JOIN orden_trabajo ot ON ot.orden_trabajo_id_orden = mot.orden_trabajo_id_orden
         WHERE mot.material_sku = afp.material_sku
           AND ot.proyecto_id_proyecto IS NOT DISTINCT FROM afp.proyecto_id_proyecto
           AND ot.orden_trabajo_estado NOT IN ('cancelada', 'finalizada', 'completada', 'listo', 'cerrada')
       ) ots ON TRUE
       WHERE afp.alerta_faltante_pedido_id_alerta_faltante = $1`,
      [id]
    );

    if (alerta.length === 0) {
      return res.status(404).json({ error: 'Alerta de faltante no encontrada' });
    }

    const a = alerta[0];

    // CU-106 Exc 1: verificar si el stock cambió recientemente
    const { rows: stockActual } = await query(
      `SELECT COALESCE(SUM(inventario_bodega_cantidad_fisica) -
                        SUM(inventario_bodega_cantidad_reservada), 0) AS disponible
       FROM inventario_bodega WHERE material_sku = $1`,
      [a.sku]
    );
    const disponibleActual = parseFloat(stockActual[0]?.disponible || 0);

    // Proveedores del producto con tiempos de entrega (CU-106)
    const { rows: proveedores } = await query(
      `SELECT
         p.proveedor_id_proveedor                  AS id,
         p.proveedor_razon_social                  AS nombre,
         p.proveedor_estado                        AS estado,
         mp.material_proveedor_tiempo_reposicion   AS tiempo_reposicion,
         mp.material_proveedor_precio_referencial  AS precio_referencial,
         mp.material_proveedor_proveedor_principal AS es_principal
       FROM material_proveedor mp
       JOIN proveedor p ON p.proveedor_id_proveedor = mp.proveedor_id_proveedor
       WHERE mp.material_sku = $1
       ORDER BY mp.material_proveedor_proveedor_principal DESC,
                mp.material_proveedor_tiempo_reposicion ASC NULLS LAST`,
      [a.sku]
    );

    // CU-114 CP2: Si el stock cambió, actualizar la alerta en BD
    let estado_resolucion = null;
    const disponibleAlmacenado = parseFloat(a.cantidad_disponible || 0);
    if (disponibleActual > disponibleAlmacenado && a.estado === 'activa') {
      // Stock aumentó y alerta estaba activa — marcar como en_gestion
      await query(
        `UPDATE alerta_faltante_pedido
         SET alerta_faltante_pedido_estado = 'en_gestion',
             alerta_faltante_pedido_cantidad_disponible = $2
         WHERE alerta_faltante_pedido_id_alerta_faltante = $1`,
        [a.id, disponibleActual]
      );
      a.estado = 'en_gestion';
      a.cantidad_disponible = disponibleActual;
      estado_resolucion = 'en_gestion';
    } else if (disponibleActual !== disponibleAlmacenado) {
      // Stock cambió pero no subió — solo actualizar cantidad almacenada
      await query(
        `UPDATE alerta_faltante_pedido
         SET alerta_faltante_pedido_cantidad_disponible = $2
         WHERE alerta_faltante_pedido_id_alerta_faltante = $1`,
        [a.id, disponibleActual]
      );
      a.cantidad_disponible = disponibleActual;
    }
    if (disponibleActual >= parseFloat(a.cantidad_requerida)) {
      estado_resolucion = 'en_resolucion';
    }

    // Montos ocultos a jop en el backend: ve plazos y proveedor principal, no precios
    if (ocultaMontos(req)) quitarCampos(proveedores, ['precio_referencial']);

    res.json({
      ...a,
      stock_actual: disponibleActual,
      estado_resolucion,
      proveedores,
      sin_proveedores: proveedores.length === 0,
      proveedor_sin_tiempo: proveedores.length > 0 &&
        proveedores.every(p => !p.tiempo_reposicion)
    });
  } catch (err) {
    console.error('Error obteniendo alerta faltante:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * PUT /api/alertas-faltantes/:id/solicitud
 * Marca la alerta como "solicitud emitida" (CU-107)
 * Body: { proveedor_id? }
 */
async function emitirSolicitud(req, res) {
  const { id } = req.params;
  const { proveedor_id } = req.body;
  const userId = req.user.id;

  try {
    // Verificar que no exista solicitud duplicada (CU-107 Exc 2)
    const { rows: alerta } = await query(
      `SELECT alerta_faltante_pedido_estado AS estado,
              material_sku AS sku, proyecto_id_proyecto AS proyecto_id,
              alerta_faltante_pedido_origen AS origen, nota_venta_id_nota_venta AS venta_id
       FROM alerta_faltante_pedido
       WHERE alerta_faltante_pedido_id_alerta_faltante = $1`,
      [id]
    );

    if (alerta.length === 0) {
      return res.status(404).json({ error: 'Alerta no encontrada' });
    }

    if (alerta[0].estado === 'solicitud_emitida') {
      return res.status(400).json({
        error: 'Ya existe una solicitud de compra activa para este producto y pedido'
      });
    }

    // CU-115: Verificar que no exista otra alerta con solicitud emitida para mismo SKU+proyecto
    const { rows: duplicados } = await query(
      `SELECT alerta_faltante_pedido_id_alerta_faltante AS id
       FROM alerta_faltante_pedido
       WHERE material_sku = $1
         AND proyecto_id_proyecto IS NOT DISTINCT FROM $2
         AND alerta_faltante_pedido_estado = 'solicitud_emitida'
         AND alerta_faltante_pedido_id_alerta_faltante != $3
         -- CU-122: un insumo especial se compra por venta; dos ventas del mismo SKU no son duplicado
         AND alerta_faltante_pedido_origen = $4
         AND nota_venta_id_nota_venta IS NOT DISTINCT FROM $5`,
      [alerta[0].sku, alerta[0].proyecto_id, id, alerta[0].origen, alerta[0].venta_id]
    );

    if (duplicados.length > 0) {
      // CU-115 CP2: Suggest alternative proveedor instead of blocking
      const { rows: altProveedores } = await query(
        `SELECT p.proveedor_id_proveedor AS id, p.proveedor_razon_social AS nombre,
                mp.material_proveedor_tiempo_reposicion AS tiempo_reposicion
         FROM material_proveedor mp
         JOIN proveedor p ON p.proveedor_id_proveedor = mp.proveedor_id_proveedor
         WHERE mp.material_sku = $1
         ORDER BY mp.material_proveedor_proveedor_principal DESC,
                  mp.material_proveedor_tiempo_reposicion ASC NULLS LAST`,
        [alerta[0].sku]
      );
      return res.status(400).json({
        error: `Ya existe una solicitud de compra emitida (alerta #${duplicados[0].id}) para este material y proyecto.`,
        proveedores_alternativos: altProveedores.length > 1 ? altProveedores.slice(1) : [],
        sugerencia: 'Considere usar un proveedor alternativo o resolver la solicitud existente antes de emitir una nueva.'
      });
    }

    // Actualizar proveedor si se seleccionó uno distinto (CU-107 Exc 1)
    await query(
      `UPDATE alerta_faltante_pedido
       SET alerta_faltante_pedido_estado = 'solicitud_emitida',
           proveedor_id_proveedor = COALESCE($1, proveedor_id_proveedor),
           usuario_id_usuario = $2
       WHERE alerta_faltante_pedido_id_alerta_faltante = $3`,
      [proveedor_id || null, userId, id]
    );

    // Notificar a gerencia
    notificarPorRol({
      tipo: 'solicitud_compra',
      mensaje: `Solicitud de compra de emergencia emitida para ${alerta[0].sku}`,
      origen: 'alertas_faltantes',
      rol: 'gerencia'
    });

    auditoria.registrar(userId, 'emitir_solicitud_compra', `Alerta #${id}, SKU: ${alerta[0].sku}`);
    res.json({ message: 'Solicitud de compra de emergencia emitida correctamente' });
  } catch (err) {
    console.error('Error emitiendo solicitud:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * PUT /api/alertas-faltantes/:id/resolver
 * Cierra el ciclo de la alerta (CU-105B)
 * Body: { accion: 'resuelta'|'pospuesta'|'descartada', motivo: string }
 */
async function resolver(req, res) {
  const { id } = req.params;
  const { accion, motivo } = req.body;
  const userId = req.user.id;

  if (!accion || !['resuelta', 'pospuesta', 'descartada'].includes(accion)) {
    return res.status(400).json({ error: 'Acción debe ser: resuelta, pospuesta o descartada' });
  }

  // CU-105B Exc 2: motivo obligatorio
  if (!motivo || !motivo.trim()) {
    return res.status(400).json({ error: 'Debe ingresar un motivo de cierre' });
  }

  try {
    // CU-105B Exc 1: verificar que siga activa
    const { rows: alerta } = await query(
      `SELECT alerta_faltante_pedido_estado AS estado
       FROM alerta_faltante_pedido
       WHERE alerta_faltante_pedido_id_alerta_faltante = $1`,
      [id]
    );

    if (alerta.length === 0) {
      return res.status(404).json({ error: 'Alerta no encontrada' });
    }

    if (['resuelta', 'descartada'].includes(alerta[0].estado)) {
      return res.status(400).json({
        error: 'La alerta ya fue resuelta o descartada por otro usuario'
      });
    }

    await query(
      `UPDATE alerta_faltante_pedido
       SET alerta_faltante_pedido_estado = $1,
           usuario_id_usuario = $2
       WHERE alerta_faltante_pedido_id_alerta_faltante = $3`,
      [accion, userId, id]
    );

    // Registrar en auditoría
    auditoria.registrar(userId, 'resolver_alerta_faltante', `Alerta #${id} → ${accion}: ${motivo}`);

    res.json({ message: `Alerta marcada como '${accion}' correctamente` });
  } catch (err) {
    console.error('Error resolviendo alerta faltante:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = { generar, listar, obtener, emitirSolicitud, resolver, generarAlertasFaltantes };
