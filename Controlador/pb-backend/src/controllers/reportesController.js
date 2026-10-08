const { query } = require('../db/pool');
const { conTransaccion, responderError } = require('../db/tx');
const { stockAFecha, consumoNeto, precioVigente } = require('../db/historico');
const { ocultaMontos, quitarCampos } = require('../middleware/auth');
const auditoria = require('./auditoriaController');

/** Estados que no cuentan en ningún total: anulados, en espera o rechazados. */
const ESTADOS_NO_VIGENTES = ['revertido', 'pendiente_aprobacion', 'rechazado'];
const esMovimientoVigente = (r) => !ESTADOS_NO_VIGENTES.includes(r.estado) && r.revierte_a == null;

/**
 * Clasificaciones de salida que son merma: el MISMO criterio con el que
 * registrarSalida exige evidencia y aprobación (movimientosController).
 */
const PATRONES_MERMA = ['%pérdida%', '%perdida%', '%merma%'];

/**
 * GET /api/reportes/movimientos
 * Reporte de movimientos por rango de fechas
 * Query params: ?desde=&hasta=&tipo=
 */
async function reporteMovimientos(req, res) {
  // OPUS-9 (Req #1): orden_trabajo_id filtra los movimientos de una OT concreta
  const { desde, hasta, tipo, buscar, orden_trabajo_id } = req.query;

  if (orden_trabajo_id !== undefined && orden_trabajo_id !== '' && isNaN(parseInt(orden_trabajo_id))) {
    return res.status(400).json({ error: 'orden_trabajo_id debe ser numérico' });
  }

  if (!desde || !hasta) {
    return res.status(400).json({ error: 'Los parámetros desde y hasta son requeridos' });
  }

  try {
    const { rows } = await query(
      `SELECT
         mi.movimiento_inventario_id_movimiento            AS id,
         mi.movimiento_inventario_fecha_hora               AS fecha_hora,
         mi.movimiento_inventario_cantidad                 AS cantidad,
         mi.movimiento_inventario_estado                   AS estado,
         mi.material_sku                                   AS sku,
         m.material_nombre_material                        AS material,
         b.bodega_nombre_bodega                            AS bodega,
         tm.movimiento_inventario_tipo_movimiento_nombre   AS tipo,
         mot.movimiento_inventario_motivo_movimiento_nombre AS motivo,
         cs.movimiento_inventario_clasificacion_salida_nombre AS clasificacion_salida,
         u.usuario_username                                AS usuario,
         l.lote_numero_lote                                AS lote,
         -- OPUS-9 (Req #1): OT que origino el movimiento (NULL si no viene de un consumo)
         mi.orden_trabajo_id_orden                         AS orden_trabajo_id,
         -- CU-44: si es un inverso, el movimiento que revierte
         mi.movimiento_inventario_id_revertido             AS revierte_a,
         -- Precio referencial del proveedor principal (solo gerencia lo verá en el frontend)
         mp.material_proveedor_precio_referencial          AS precio_unitario
       FROM movimiento_inventario mi
       JOIN material m ON m.material_sku = mi.material_sku
       JOIN movimiento_inventario_tipo_movimiento tm
            ON tm.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
             = mi.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
       LEFT JOIN bodega b   ON b.bodega_id_bodega = mi.bodega_id_bodega
       LEFT JOIN lote l     ON l.lote_id_lote = mi.lote_id_lote
       LEFT JOIN usuario u  ON u.usuario_id_usuario = mi.usuario_id_usuario
       LEFT JOIN movimiento_inventario_motivo_movimiento mot
            ON mot.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
             = mi.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
       LEFT JOIN movimiento_inventario_clasificacion_salida cs
            ON cs.movimiento_inventario_clasificacion_salida_id_clasificacion_salida
             = mot.movimiento_inventario_clasificacion_salida_id_clasificacion_salida
       -- Precio referencial del proveedor principal
       LEFT JOIN material_proveedor mp
            ON mp.material_sku = mi.material_sku
           AND mp.material_proveedor_proveedor_principal = TRUE
       WHERE mi.movimiento_inventario_fecha_hora >= $1::date
         AND mi.movimiento_inventario_fecha_hora < ($2::date + INTERVAL '1 day')
         AND ($3::text IS NULL OR tm.movimiento_inventario_tipo_movimiento_nombre ILIKE '%' || $3 || '%')
         AND ($4::text IS NULL OR mi.material_sku ILIKE '%' || $4 || '%' OR m.material_nombre_material ILIKE '%' || $4 || '%')
         AND ($5::bigint IS NULL OR mi.orden_trabajo_id_orden = $5::bigint)
       ORDER BY mi.movimiento_inventario_fecha_hora DESC`,
      [desde, hasta, tipo || null, buscar || null, orden_trabajo_id || null]
    );

    // Montos ocultos en el BACKEND para quien no es gerencia (FR-59), igual que en
    // reporteMermas. Antes se enviaba a todos los roles y solo la vista lo escondia.
    if (req.user?.rol !== 'gerencia') {
      for (const r of rows) delete r.precio_unitario;
    }

    // Resumen: solo movimientos VIGENTES. Anulados (revertido y sus inversos, D23),
    // mermas pendientes y rechazadas se listan con su estado pero no cuentan.
    const vigentes = rows.filter(esMovimientoVigente);
    const esTipo = (r, t) => r.tipo?.toLowerCase().includes(t);
    const resumen = {
      total_movimientos: vigentes.length,
      total_entradas: vigentes.filter(r => esTipo(r, 'entrada')).length,
      total_salidas:  vigentes.filter(r => esTipo(r, 'salida')).length,
      // Un traslado es una salida con clasificacion "Traslado" (+ su entrada en destino)
      total_traslados: vigentes.filter(r => esTipo(r, 'salida') &&
                                            r.clasificacion_salida?.toLowerCase().includes('traslado')).length,
      // OPUS-9: cuantos de estos movimientos estan vinculados a una OT
      con_orden_trabajo: vigentes.filter(r => r.orden_trabajo_id != null).length,
      excluidos: rows.length - vigentes.length,
    };

    res.json({ resumen, movimientos: rows });
  } catch (err) {
    console.error('Error generando reporte movimientos:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/reportes/mermas
 * Reporte de mermas (FR-50) — movimientos con motivo de pérdida/daño
 * Query params: ?desde=&hasta=&motivo=
 * Nota: precio_unitario solo se devuelve si el usuario es gerencia (FR-59)
 */
async function reporteMermas(req, res) {
  const { desde, hasta, motivo } = req.query;

  if (!desde || !hasta) {
    return res.status(400).json({ error: 'Los parámetros desde y hasta son requeridos' });
  }

  const esGerencia = req.user?.rol === 'gerencia';

  try {
    const { rows } = await query(
      `SELECT
         mi.movimiento_inventario_id_movimiento              AS id,
         mi.movimiento_inventario_fecha_hora                 AS fecha,
         mi.movimiento_inventario_cantidad                   AS cantidad,
         mi.movimiento_inventario_estado                     AS estado,
         mi.material_sku                                     AS sku,
         m.material_nombre_material                          AS producto,
         mot.movimiento_inventario_motivo_movimiento_nombre  AS motivo,
         u.usuario_username                                  AS usuario,
         mp.material_proveedor_precio_referencial            AS precio_unitario
       FROM movimiento_inventario mi
       JOIN material m ON m.material_sku = mi.material_sku
       JOIN movimiento_inventario_tipo_movimiento tm
            ON tm.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
             = mi.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
       JOIN movimiento_inventario_motivo_movimiento mot
            ON mot.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
             = mi.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
       LEFT JOIN movimiento_inventario_clasificacion_salida cs
            ON cs.movimiento_inventario_clasificacion_salida_id_clasificacion_salida
             = mot.movimiento_inventario_clasificacion_salida_id_clasificacion_salida
       LEFT JOIN usuario u ON u.usuario_id_usuario = mi.usuario_id_usuario
       LEFT JOIN material_proveedor mp
            ON mp.material_sku = mi.material_sku
           AND mp.material_proveedor_proveedor_principal = TRUE
       WHERE mi.movimiento_inventario_fecha_hora >= $1::date
         AND mi.movimiento_inventario_fecha_hora < ($2::date + INTERVAL '1 day')
         AND tm.movimiento_inventario_tipo_movimiento_nombre ILIKE '%salida%'
         -- CU-75: el mismo criterio de merma que la salida. Antes solo '%pérdida%',
         -- que no coincidia con 'merma' ni con 'perdida': el reporte salia vacio.
         AND LOWER(cs.movimiento_inventario_clasificacion_salida_nombre) LIKE ANY ($4::text[])
         -- Revertidas (error anulado, D31) y rechazadas (la pérdida no ocurrió) no se listan
         AND mi.movimiento_inventario_estado NOT IN ('revertido', 'rechazado')
         AND ($3::text IS NULL OR mot.movimiento_inventario_motivo_movimiento_nombre ILIKE '%' || $3 || '%')
       ORDER BY mi.movimiento_inventario_fecha_hora DESC`,
      [desde, hasta, motivo || null, PATRONES_MERMA]
    );

    // KPIs: solo mermas confirmadas. Las pendientes de aprobación se listan
    // marcadas, pero todavía no son una pérdida aceptada.
    const confirmadas  = rows.filter(r => r.estado !== 'pendiente_aprobacion');
    const pendientes   = rows.filter(r => r.estado === 'pendiente_aprobacion');
    const totalUnidades = confirmadas.reduce((s, r) => s + parseFloat(r.cantidad || 0), 0);
    const totalValor    = confirmadas.reduce((s, r) => s + parseFloat(r.cantidad || 0) * parseFloat(r.precio_unitario || 0), 0);
    const skusDistintos = new Set(confirmadas.map(r => r.sku)).size;

    // Si es JOP, eliminar precio_unitario de cada fila (FR-59)
    const mermas = rows.map(r => {
      const row = { ...r };
      if (!esGerencia) {
        delete row.precio_unitario;
      } else {
        row.valor_merma = parseFloat(r.cantidad || 0) * parseFloat(r.precio_unitario || 0);
      }
      return row;
    });

    // CU-72 CP3: Contar productos sin precio unitario referencial
    const productosSinPrecio = new Set(
      confirmadas.filter(r => !r.precio_unitario || parseFloat(r.precio_unitario) === 0)
          .map(r => r.sku)
    ).size;

    const resumen = {
      total_eventos:   confirmadas.length,
      total_unidades:  totalUnidades,
      skus_afectados:  skusDistintos,
      productos_sin_precio: productosSinPrecio,
      pendientes:            pendientes.length,
      unidades_pendientes:   pendientes.reduce((s, r) => s + parseFloat(r.cantidad || 0), 0),
      // Solo gerencia recibe el valor monetario
      ...(esGerencia && { valor_total_merma: totalValor }),
    };

    res.json({ resumen, mermas });
  } catch (err) {
    console.error('Error generando reporte mermas:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/reportes/valorizacion
 * Valor económico total del inventario (CU-64) — solo gerencia
 */
async function valorizacion(req, res) {
  try {
    const { rows } = await query(
      `SELECT
         m.material_sku                               AS sku,
         m.material_nombre_material                   AS nombre,
         m.material_material_critico                  AS es_critico,
         u.material_unidad_medida_nombre              AS unidad,
         cg.material_categoria_general_nombre         AS categoria,
         COALESCE(SUM(ib.inventario_bodega_cantidad_fisica), 0) AS stock_total,
         mp.material_proveedor_precio_referencial     AS precio_unitario
       FROM material m
       LEFT JOIN material_unidad_medida u
              ON u.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
       LEFT JOIN material_categoria_general cg
              ON cg.material_categoria_general_id_categoria_general = m.material_categoria_general_id_categoria_general
       LEFT JOIN inventario_bodega ib ON ib.material_sku = m.material_sku
       LEFT JOIN material_proveedor mp
              ON mp.material_sku = m.material_sku
             AND mp.material_proveedor_proveedor_principal = TRUE
       WHERE m.material_estado = 'activo'
       GROUP BY m.material_sku, m.material_nombre_material,
                m.material_material_critico,
                u.material_unidad_medida_nombre,
                cg.material_categoria_general_nombre,
                mp.material_proveedor_precio_referencial
       HAVING COALESCE(SUM(ib.inventario_bodega_cantidad_fisica), 0) > 0
       ORDER BY m.material_nombre_material`
    );

    const detalle = rows.map(r => {
      const stock  = parseFloat(r.stock_total || 0);
      const precio = parseFloat(r.precio_unitario || 0);
      return {
        ...r,
        valor_linea: stock * precio,
        sin_precio: !r.precio_unitario
      };
    });

    const valorTotal    = detalle.reduce((s, d) => s + d.valor_linea, 0);
    const sinPrecio     = detalle.filter(d => d.sin_precio).length;
    const totalProductos = detalle.length;

    // CU-64 Exc 1: todo sin precio
    if (sinPrecio === totalProductos && totalProductos > 0) {
      return res.json({
        detalle,
        resumen: {
          valor_total: 0,
          moneda: 'CLP',
          total_productos: totalProductos,
          sin_precio: sinPrecio,
          estado: 'No es posible calcular el valor. Ningún producto tiene precio referencial.'
        }
      });
    }

    res.json({
      detalle,
      resumen: {
        valor_total: valorTotal,
        moneda: 'CLP',
        total_productos: totalProductos,
        sin_precio: sinPrecio,
        estado: sinPrecio > 0 ? 'Estimado/Incompleto' : 'Completo'
      }
    });
  } catch (err) {
    console.error('Error generando valorización:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/reportes/consumo-area
 * Consumo de materiales por área de trabajo (CU-65)
 * Query params: ?area_id=&desde=&hasta=
 */
async function consumoArea(req, res) {
  const { area_id, desde, hasta } = req.query;
  try {
    const { rows } = await query(
      `SELECT
         at.area_trabajo_id_area                    AS area_id,
         at.area_trabajo_nombre_area                AS area_nombre,
         m.material_sku                             AS sku,
         m.material_nombre_material                 AS material_nombre,
         u.material_unidad_medida_nombre            AS unidad,
         SUM(mot.material_orden_trabajo_consumo_real) AS total_consumido,
         mp.material_proveedor_precio_referencial   AS precio_unitario,
         COUNT(DISTINCT ot.orden_trabajo_id_orden)  AS ordenes_involucradas
       FROM material_orden_trabajo mot
       JOIN orden_trabajo ot ON ot.orden_trabajo_id_orden = mot.orden_trabajo_id_orden
       JOIN area_trabajo at  ON at.area_trabajo_id_area = ot.area_trabajo_id_area
       JOIN material m       ON m.material_sku = mot.material_sku
       LEFT JOIN material_unidad_medida u
              ON u.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
       LEFT JOIN material_proveedor mp
              ON mp.material_sku = mot.material_sku
             AND mp.material_proveedor_proveedor_principal = TRUE
       WHERE mot.material_orden_trabajo_consumo_real IS NOT NULL
         AND ($1::text IS NULL OR $1::text = '' OR at.area_trabajo_id_area = $1::bigint)
         AND ($2::text IS NULL OR $2::text = '' OR ot.orden_trabajo_fecha_hora >= $2::date)
         AND ($3::text IS NULL OR $3::text = '' OR ot.orden_trabajo_fecha_hora <= $3::date + INTERVAL '1 day')
       GROUP BY at.area_trabajo_id_area, at.area_trabajo_nombre_area,
                m.material_sku, m.material_nombre_material,
                u.material_unidad_medida_nombre,
                mp.material_proveedor_precio_referencial
       ORDER BY at.area_trabajo_nombre_area, SUM(mot.material_orden_trabajo_consumo_real) DESC`,
      [area_id || null, desde || null, hasta || null]
    );

    // CU-65 Exc 1: sin datos
    if (rows.length === 0) {
      return res.json({
        consumos: [],
        mensaje: 'No se encontraron consumos registrados para los filtros aplicados'
      });
    }

    // Agrupar por área para el resumen
    const porArea = {};
    for (const r of rows) {
      if (!porArea[r.area_id]) {
        porArea[r.area_id] = { area_id: r.area_id, area: r.area_nombre, total_consumo: 0, costo_total: 0, materiales: 0 };
      }
      const consumido = parseFloat(r.total_consumido || 0);
      const precio    = parseFloat(r.precio_unitario || 0);
      porArea[r.area_id].total_consumo += consumido;
      porArea[r.area_id].costo_total   += consumido * precio;
      porArea[r.area_id].materiales++;
    }

    // CU-69 Exc 2: comparar con promedio histórico por área.
    // OPUS-12: antes esto era una query POR ÁREA dentro de un loop (N+1). Ahora
    // es UNA sola consulta que devuelve el promedio mensual de todas las áreas.
    const UMBRAL_ANOMALIA_PCT = 50; // 50% sobre el promedio = pico anómalo
    try {
      const { rows: hist } = await query(
        `SELECT sub.area_id, COALESCE(AVG(sub.mes_total), 0) AS promedio_mensual
         FROM (
           SELECT ot.area_trabajo_id_area AS area_id,
                  DATE_TRUNC('month', ot.orden_trabajo_fecha_hora) AS mes,
                  SUM(mot.material_orden_trabajo_consumo_real *
                      COALESCE(mp.material_proveedor_precio_referencial, 0)) AS mes_total
           FROM material_orden_trabajo mot
           JOIN orden_trabajo ot ON ot.orden_trabajo_id_orden = mot.orden_trabajo_id_orden
           LEFT JOIN material_proveedor mp
                  ON mp.material_sku = mot.material_sku
                 AND mp.material_proveedor_proveedor_principal = TRUE
           WHERE mot.material_orden_trabajo_consumo_real IS NOT NULL
             AND ot.area_trabajo_id_area IS NOT NULL
             AND ot.orden_trabajo_fecha_hora < COALESCE($1::date, CURRENT_DATE)
           GROUP BY 1, 2
         ) sub
         GROUP BY sub.area_id`,
        [desde || null]
      );

      const promedioPorArea = {};
      hist.forEach(h => { promedioPorArea[h.area_id] = parseFloat(h.promedio_mensual || 0); });

      for (const areaId of Object.keys(porArea)) {
        const promedio = promedioPorArea[areaId] || 0;
        porArea[areaId].promedio_historico = Math.round(promedio);
        if (promedio > 0 && porArea[areaId].costo_total > promedio * (1 + UMBRAL_ANOMALIA_PCT / 100)) {
          porArea[areaId].alerta_anomalia = true;
          porArea[areaId].mensaje_anomalia = 'Pico de consumo anómalo detectado. Revise el detalle de salidas.';
          porArea[areaId].desviacion_pct = Math.round(((porArea[areaId].costo_total / promedio) - 1) * 100);
        }
      }
    } catch (e) {
      // Si falla el cálculo histórico, continuar sin advertencia
      console.warn('No se pudo calcular el promedio histórico por área:', e.message);
    }

    const resumenPorArea = Object.values(porArea);
    // Montos ocultos a jop en el backend: ve cantidades y el aviso de anomalía
    // (un porcentaje), pero no precios, costos ni el promedio histórico en CLP
    if (ocultaMontos(req)) {
      quitarCampos(rows, ['precio_unitario']);
      quitarCampos(resumenPorArea, ['costo_total', 'promedio_historico']);
    }
    res.json({ consumos: rows, resumen_por_area: resumenPorArea });
  } catch (err) {
    console.error('Error generando consumo por área:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/* ══════════════════════════════════════════════════════════════════════
   OPUS-12 (Req #4) — Datos preprocesados para los graficos de consumo
   por area. El detalle tabular lo sigue dando consumoArea; esto devuelve
   { labels, datasets } listo para dibujar.
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Consumo valorizado por OT/material, que es la base de los tres agrupamientos.
 * El precio es el del proveedor PRINCIPAL: el LEFT JOIN sin ese filtro
 * multiplicaria las filas de un material con varios proveedores.
 */
const BASE_CONSUMO = `
  SELECT ot.area_trabajo_id_area                       AS area_id,
         at.area_trabajo_nombre_area                   AS area,
         m.material_sku                                AS sku,
         m.material_nombre_material                    AS material,
         DATE_TRUNC('month', ot.orden_trabajo_fecha_hora) AS mes,
         mot.material_orden_trabajo_consumo_real       AS cantidad,
         mot.material_orden_trabajo_consumo_real
           * COALESCE(mp.material_proveedor_precio_referencial, 0) AS costo
  FROM material_orden_trabajo mot
  JOIN orden_trabajo ot ON ot.orden_trabajo_id_orden = mot.orden_trabajo_id_orden
  JOIN area_trabajo at  ON at.area_trabajo_id_area = ot.area_trabajo_id_area
  JOIN material m       ON m.material_sku = mot.material_sku
  LEFT JOIN material_proveedor mp
         ON mp.material_sku = mot.material_sku
        AND mp.material_proveedor_proveedor_principal = TRUE
  WHERE mot.material_orden_trabajo_consumo_real IS NOT NULL
    AND ($1::date IS NULL OR ot.orden_trabajo_fecha_hora >= $1::date)
    AND ($2::date IS NULL OR ot.orden_trabajo_fecha_hora < $2::date + INTERVAL '1 day')`;

/** Periodo inmediatamente anterior, del mismo largo, para comparar. */
function periodoAnterior(desde, hasta) {
  if (!desde || !hasta) return null;
  const d = new Date(desde), h = new Date(hasta);
  if (isNaN(d) || isNaN(h) || h < d) return null;
  const dias = Math.round((h - d) / 86400000) + 1;
  const prevHasta = new Date(d.getTime() - 86400000);
  const prevDesde = new Date(prevHasta.getTime() - (dias - 1) * 86400000);
  return { desde: prevDesde.toISOString().slice(0, 10), hasta: prevHasta.toISOString().slice(0, 10) };
}

/**
 * GET /api/reportes/consumo-area/grafico?desde=&hasta=&agrupar=area|material|mes
 * - area:     costo y cantidad por area, con % del total y variacion vs el periodo anterior
 * - material: top 10 materiales por costo, desglosado por area (barras agrupadas)
 * - mes:      serie mensual por area (ultimos 12 meses si no se da rango)
 * Montos ocultos a jop en el backend: para jop todo se mide en CANTIDAD (orden,
 * porcentajes, variación y series) y no viaja ningún campo de costo.
 */
async function consumoAreaGrafico(req, res) {
  const { desde, hasta } = req.query;
  const agrupar = ['area', 'material', 'mes'].includes(req.query.agrupar) ? req.query.agrupar : 'area';
  const params = [desde || null, hasta || null];
  const sinMontos = ocultaMontos(req);
  const medida = sinMontos ? 'cantidad' : 'costo';   // columna de BASE_CONSUMO: valor fijo, no viene del usuario

  try {
    if (agrupar === 'area') {
      const { rows } = await query(
        `SELECT b.area_id, b.area,
                SUM(b.costo)              AS costo,
                SUM(b.cantidad)           AS cantidad,
                COUNT(DISTINCT b.sku)     AS materiales,
                COUNT(*)                  AS lineas
         FROM (${BASE_CONSUMO}) b
         GROUP BY b.area_id, b.area
         ORDER BY SUM(b.${medida}) DESC`,
        params
      );

      // Variacion contra el periodo anterior del mismo largo (solo si hay rango)
      const prev = periodoAnterior(desde, hasta);
      let previoPorArea = {};
      if (prev) {
        const { rows: anterior } = await query(
          `SELECT b.area_id, SUM(b.${medida}) AS valor FROM (${BASE_CONSUMO}) b GROUP BY b.area_id`,
          [prev.desde, prev.hasta]
        );
        anterior.forEach(a => { previoPorArea[a.area_id] = parseFloat(a.valor || 0); });
      }

      const total = rows.reduce((a, r) => a + parseFloat(r[medida] || 0), 0);
      const areas = rows.map(r => {
        const valor = parseFloat(r[medida] || 0);
        const previo = prev ? (previoPorArea[r.area_id] || 0) : null;
        return {
          area_id: r.area_id,
          area: r.area,
          ...(sinMontos ? {} : { costo: valor }),
          cantidad: parseFloat(r.cantidad || 0),
          materiales: parseInt(r.materiales),
          porcentaje: total > 0 ? Math.round((valor / total) * 1000) / 10 : 0,
          [sinMontos ? 'cantidad_periodo_anterior' : 'costo_periodo_anterior']: previo,
          variacion_pct: previo > 0 ? Math.round(((valor / previo) - 1) * 1000) / 10 : null,
        };
      });

      return res.json({
        agrupar,
        medida,
        periodo: { desde: desde || null, hasta: hasta || null, anterior: prev },
        [sinMontos ? 'total_cantidad' : 'total_costo']: total,
        labels: areas.map(a => a.area),
        datasets: [
          ...(sinMontos ? [] : [{ label: 'Costo', data: areas.map(a => a.costo) }]),
          { label: 'Cantidad', data: areas.map(a => a.cantidad) },
        ],
        areas,
      });
    }

    if (agrupar === 'material') {
      // Top 10 por costo sumando todas las areas
      const { rows: top } = await query(
        `SELECT b.sku, b.material, SUM(b.costo) AS costo, SUM(b.cantidad) AS cantidad
         FROM (${BASE_CONSUMO}) b
         GROUP BY b.sku, b.material
         ORDER BY SUM(b.${medida}) DESC, SUM(b.cantidad) DESC
         LIMIT 10`,
        params
      );

      if (top.length === 0) {
        return res.json({ agrupar, medida, periodo: { desde: desde || null, hasta: hasta || null }, labels: [], datasets: [], materiales: [] });
      }

      const skus = top.map(t => t.sku);
      const { rows: porArea } = await query(
        `SELECT b.sku, b.area_id, b.area, SUM(b.${medida}) AS valor
         FROM (${BASE_CONSUMO}) b
         WHERE b.sku = ANY($3::text[])
         GROUP BY b.sku, b.area_id, b.area
         ORDER BY b.area`,
        [...params, skus]
      );

      // Una serie por area: cada dato es lo que esa area consumio de ese material
      const areas = [...new Map(porArea.map(r => [r.area_id, r.area])).entries()];
      const mapa = {};
      porArea.forEach(r => { mapa[`${r.sku}|${r.area_id}`] = parseFloat(r.valor || 0); });

      return res.json({
        agrupar,
        medida,
        periodo: { desde: desde || null, hasta: hasta || null },
        labels: top.map(t => t.material),
        skus,
        datasets: areas.map(([areaId, area]) => ({
          label: area,
          data: skus.map(sku => mapa[`${sku}|${areaId}`] || 0),
        })),
        materiales: top.map(t => ({
          sku: t.sku, material: t.material,
          ...(sinMontos ? {} : { costo: parseFloat(t.costo || 0) }), cantidad: parseFloat(t.cantidad || 0),
        })),
      });
    }

    // agrupar === 'mes': si no hay rango, los ultimos 12 meses
    const desdeMes = desde || null;
    const { rows } = await query(
      `SELECT TO_CHAR(b.mes, 'YYYY-MM') AS mes, b.area_id, b.area, SUM(b.${medida}) AS valor
       FROM (${BASE_CONSUMO}) b
       WHERE ($1::date IS NOT NULL OR b.mes >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '11 months')
       GROUP BY 1, b.area_id, b.area
       ORDER BY 1`,
      [desdeMes, hasta || null]
    );

    const meses = [...new Set(rows.map(r => r.mes))].sort();
    const areasMes = [...new Map(rows.map(r => [r.area_id, r.area])).entries()];
    const mapaMes = {};
    rows.forEach(r => { mapaMes[`${r.mes}|${r.area_id}`] = parseFloat(r.valor || 0); });

    return res.json({
      agrupar,
      medida,
      periodo: { desde: desde || null, hasta: hasta || null },
      labels: meses,
      datasets: areasMes.map(([areaId, area]) => ({
        label: area,
        data: meses.map(m => mapaMes[`${m}|${areaId}`] || 0),
      })),
      [sinMontos ? 'total_cantidad' : 'total_costo']: rows.reduce((a, r) => a + parseFloat(r.valor || 0), 0),
    });
  } catch (err) {
    console.error('Error generando gráfico de consumo por área:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/* ══════════════════════════════════════════════════════════════════════
   OPUS-7 (Req #9) — Rango de la programacion
   Antes era fijo: "7 dias desde hoy". Ahora la unidad base es la SEMANA
   ISO (lunes a domingo) y el rango es configurable.
   ══════════════════════════════════════════════════════════════════════ */

const RANGOS_PROGRAMACION = {
  '1s': { intervalo: '7 days',   etiqueta: 'Esta semana (lunes a domingo)' },
  '2s': { intervalo: '14 days',  etiqueta: '2 semanas' },
  '1m': { intervalo: '1 month',  etiqueta: '1 mes' },
  '3m': { intervalo: '3 months', etiqueta: '3 meses' },
  '1a': { intervalo: '1 year',   etiqueta: '1 año' },
};

/**
 * Resuelve el rango pedido a fechas concretas.
 * Query params: ?rango=1s|2s|1m|3m|1a y ?semana_inicio=YYYY-MM-DD (opcional).
 * El inicio SIEMPRE se lleva al lunes de esa semana (DATE_TRUNC('week') usa
 * lunes por el estandar ISO), asi el reporte nunca parte a mitad de semana.
 */
async function resolverRangoProgramacion(reqQuery) {
  const rango = RANGOS_PROGRAMACION[reqQuery.rango] ? reqQuery.rango : '1s';
  const base  = reqQuery.semana_inicio && /^\d{4}-\d{2}-\d{2}$/.test(reqQuery.semana_inicio)
    ? reqQuery.semana_inicio
    : null;

  // TO_CHAR y no ::date: node-postgres convierte los `date` a objetos Date de JS
  // y al interpolarlos quedaba "Mon Aug 10 2026 00:00:00 GMT-0400..." en el nombre
  // del archivo exportado y en los mensajes. Como texto YYYY-MM-DD son directamente
  // usables tanto en el SQL ($n::date) como en la respuesta al frontend.
  const { rows } = await query(
    `SELECT TO_CHAR(DATE_TRUNC('week', COALESCE($1::date, CURRENT_DATE)), 'YYYY-MM-DD') AS desde,
            TO_CHAR(DATE_TRUNC('week', COALESCE($1::date, CURRENT_DATE)) + $2::interval - INTERVAL '1 day', 'YYYY-MM-DD') AS hasta,
            TO_CHAR(DATE_TRUNC('week', COALESCE($1::date, CURRENT_DATE)) + $2::interval, 'YYYY-MM-DD') AS hasta_exclusivo`,
    [base, RANGOS_PROGRAMACION[rango].intervalo]
  );

  return {
    rango,
    etiqueta: RANGOS_PROGRAMACION[rango].etiqueta,
    desde: rows[0].desde,
    hasta: rows[0].hasta,
    hasta_exclusivo: rows[0].hasta_exclusivo,
  };
}

/**
 * WHERE compartido por la vista y las dos exportaciones: OTs abiertas cuya
 * fecha de referencia (instalacion del proyecto, o fecha de la OT si no tiene
 * proyecto) cae dentro del rango. Los tres endpoints usaban copias distintas de
 * esta condicion y las exportaciones ademas mostraban como "fecha" la de la OT
 * en vez de la de instalacion.
 */
const WHERE_PROGRAMACION = `
       WHERE ot.orden_trabajo_estado NOT IN ('cancelada', 'finalizada', 'completada', 'cerrada')
         AND COALESCE(p.fecha_instalacion, ot.orden_trabajo_fecha_hora::date) >= $1::date
         AND COALESCE(p.fecha_instalacion, ot.orden_trabajo_fecha_hora::date) <  $2::date`;

/** Empleado tentativo (OPUS-7): si no se asigno uno, cae al responsable de la OT. */
const SELECT_EMPLEADO_TENTATIVO = `
         ot.empleado_tentativo_id                   AS empleado_tentativo_id,
         COALESCE(et.usuario_username, u.usuario_username) AS empleado_tentativo,
         (ot.empleado_tentativo_id IS NULL)         AS empleado_tentativo_heredado`;

const JOIN_EMPLEADO_TENTATIVO = `
       LEFT JOIN usuario et ON et.usuario_id_usuario = ot.empleado_tentativo_id`;

/**
 * GET /api/reportes/programacion-semanal
 * OTs programadas en los próximos 7 días (CU-120, CU-121)
 */
async function programacionSemanal(req, res) {
  try {
    const periodo = await resolverRangoProgramacion(req.query);

    const { rows } = await query(
      `SELECT
         ot.orden_trabajo_id_orden                  AS id,
         COALESCE(p.fecha_instalacion, ot.orden_trabajo_fecha_hora::date) AS fecha,
         ot.orden_trabajo_estado                    AS estado,
         p.codigo_proyecto                          AS proyecto_codigo,
         p.nombre_referencia                        AS proyecto_nombre,
         at.area_trabajo_nombre_area                AS area,
         u.usuario_username                         AS responsable,
${SELECT_EMPLEADO_TENTATIVO},
         COALESCE(res.total_materiales, 0)          AS total_materiales,
         COALESCE(res.materiales_con_faltante, 0)   AS materiales_con_faltante
       FROM orden_trabajo ot
       LEFT JOIN terreno.proyecto p ON p.id_proyecto = ot.proyecto_id_proyecto
       LEFT JOIN area_trabajo at    ON at.area_trabajo_id_area = ot.area_trabajo_id_area
       LEFT JOIN usuario u          ON u.usuario_id_usuario = ot.usuario_id_usuario
${JOIN_EMPLEADO_TENTATIVO}
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS total_materiales,
                COUNT(*) FILTER (
                  WHERE COALESCE((SELECT SUM(ib.inventario_bodega_cantidad_fisica
                                           - ib.inventario_bodega_cantidad_reservada)
                                  FROM inventario_bodega ib
                                  WHERE ib.material_sku = mot.material_sku), 0)
                        < COALESCE(mot.material_orden_trabajo_consumo_estimado, 0)
                ) AS materiales_con_faltante
         FROM material_orden_trabajo mot
         WHERE mot.orden_trabajo_id_orden = ot.orden_trabajo_id_orden
       ) res ON TRUE
${WHERE_PROGRAMACION}
       ORDER BY COALESCE(p.fecha_instalacion, ot.orden_trabajo_fecha_hora::date) ASC,
                ot.orden_trabajo_id_orden ASC`,
      [periodo.desde, periodo.hasta_exclusivo]
    );

    // CU-120 Exc 1
    if (rows.length === 0) {
      return res.json({
        programacion: [],
        periodo,
        mensaje: `No existen instalaciones programadas entre el ${periodo.desde} y el ${periodo.hasta}`
      });
    }

    // CU-121: alertas de insumos faltantes
    const conFaltantes = rows.filter(r => parseInt(r.materiales_con_faltante) > 0);

    res.json({
      programacion: rows,
      periodo,
      resumen: {
        total_ots: rows.length,
        con_faltantes: conFaltantes.length,
        sin_faltantes: rows.length - conFaltantes.length
      }
    });
  } catch (err) {
    console.error('Error generando programación semanal:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/** CU-76: límite de filas exportables y campo CSV con las reglas de utils/csvExport.js. */
const LIMITE_FILAS_CSV = 10000;
function campoCsv(v) {
  if (v == null) return '';
  const s = String(v);
  return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * GET /api/reportes/programacion-semanal/exportar
 * CU-122: Exportar cronograma semanal como CSV
 */
async function exportarProgramacion(req, res) {
  try {
    // OPUS-7: mismo rango y misma fecha de referencia que la vista. Antes usaba
    // 7 dias fijos y mostraba la fecha de la OT en vez de la de instalacion.
    const periodo = await resolverRangoProgramacion(req.query);

    const { rows } = await query(
      `SELECT
         ot.orden_trabajo_id_orden                  AS id,
         COALESCE(p.fecha_instalacion, ot.orden_trabajo_fecha_hora::date) AS fecha,
         ot.orden_trabajo_estado                    AS estado,
         p.codigo_proyecto                          AS proyecto_codigo,
         p.nombre_referencia                        AS proyecto_nombre,
         at.area_trabajo_nombre_area                AS area,
         u.usuario_username                         AS responsable,
${SELECT_EMPLEADO_TENTATIVO}
       FROM orden_trabajo ot
       LEFT JOIN terreno.proyecto p ON p.id_proyecto = ot.proyecto_id_proyecto
       LEFT JOIN area_trabajo at    ON at.area_trabajo_id_area = ot.area_trabajo_id_area
       LEFT JOIN usuario u          ON u.usuario_id_usuario = ot.usuario_id_usuario
${JOIN_EMPLEADO_TENTATIVO}
${WHERE_PROGRAMACION}
       ORDER BY COALESCE(p.fecha_instalacion, ot.orden_trabajo_fecha_hora::date) ASC,
                ot.orden_trabajo_id_orden ASC`,
      [periodo.desde, periodo.hasta_exclusivo]
    );

    // CU-122 Exc 1 / CU-76 Exc 3
    if (rows.length === 0) {
      return res.status(400).json({ error: `No hay datos para exportar entre el ${periodo.desde} y el ${periodo.hasta}` });
    }
    // CU-76 Exc 1
    if (rows.length > LIMITE_FILAS_CSV) {
      return res.status(400).json({
        error: `El reporte tiene ${rows.length.toLocaleString('es-CL')} filas y el límite de exportación es ` +
               `${LIMITE_FILAS_CSV.toLocaleString('es-CL')}. Acote el rango antes de descargar.`,
      });
    }

    // Generar CSV — OPUS-7: incluye el empleado tentativo.
    // CU-76: mismo formato que utils/csvExport.js del frontend: ';' (Excel es-CL),
    // campos entre comillas si hace falta (antes se borraban las comas del nombre
    // del proyecto) y fecha dd/mm/aaaa.
    const headers = ['OT', 'Fecha instalación', 'Estado', 'Código Proyecto', 'Nombre Proyecto', 'Área', 'Responsable', 'Empleado tentativo'];
    const csvRows = rows.map(r => {
      const f = new Date(r.fecha);   // tipo date: node-postgres lo entrega a medianoche LOCAL
      return [
        r.id,
        `${String(f.getDate()).padStart(2, '0')}/${String(f.getMonth() + 1).padStart(2, '0')}/${f.getFullYear()}`,
        r.estado,
        r.proyecto_codigo,
        r.proyecto_nombre,
        r.area,
        r.responsable,
        (r.empleado_tentativo || '') + (r.empleado_tentativo_heredado && r.empleado_tentativo ? ' (responsable)' : '')
      ].map(campoCsv).join(';');
    });

    const csv = [headers.map(campoCsv).join(';'), ...csvRows].join('\r\n');

    await auditoria.registrar(req.user?.id, 'Exportar reporte',
      `Programación exportada en CSV — ${periodo.desde} a ${periodo.hasta} (${rows.length} registro(s))`);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="programacion_${periodo.desde}_${periodo.hasta}.csv"`);
    res.send('\uFEFF' + csv); // BOM para Excel
  } catch (err) {
    console.error('Error exportando programación:', err);
    res.status(500).json({ error: 'Error generando el archivo CSV. Intente nuevamente.' });
  }
}

/**
 * GET /api/reportes/programacion-semanal/exportar-pdf
 * CU-134: Exportar cronograma semanal como PDF real
 */
async function exportarProgramacionPDF(req, res) {
  try {
    const periodo = await resolverRangoProgramacion(req.query);

    const { rows } = await query(
      `SELECT
         ot.orden_trabajo_id_orden                  AS id,
         COALESCE(p.fecha_instalacion, ot.orden_trabajo_fecha_hora::date) AS fecha,
         ot.orden_trabajo_estado                    AS estado,
         p.codigo_proyecto                          AS proyecto_codigo,
         p.nombre_referencia                        AS proyecto_nombre,
         at.area_trabajo_nombre_area                AS area,
         u.usuario_username                         AS responsable,
${SELECT_EMPLEADO_TENTATIVO},
         p.rut_cliente                              AS cliente,
         (SELECT string_agg(m2.material_nombre_material, ', ' ORDER BY m2.material_nombre_material)
          FROM material_orden_trabajo mot2
          JOIN material m2 ON m2.material_sku = mot2.material_sku
          WHERE mot2.orden_trabajo_id_orden = ot.orden_trabajo_id_orden
         ) AS insumos
       FROM orden_trabajo ot
       LEFT JOIN terreno.proyecto p ON p.id_proyecto = ot.proyecto_id_proyecto
       LEFT JOIN area_trabajo at    ON at.area_trabajo_id_area = ot.area_trabajo_id_area
       LEFT JOIN usuario u          ON u.usuario_id_usuario = ot.usuario_id_usuario
${JOIN_EMPLEADO_TENTATIVO}
${WHERE_PROGRAMACION}
       ORDER BY COALESCE(p.fecha_instalacion, ot.orden_trabajo_fecha_hora::date) ASC,
                ot.orden_trabajo_id_orden ASC`,
      [periodo.desde, periodo.hasta_exclusivo]
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: `No hay datos para exportar entre el ${periodo.desde} y el ${periodo.hasta}` });
    }

    const PDFDocument = require('pdfkit');
    const pdfDoc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 40 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="programacion_${periodo.desde}_${periodo.hasta}.pdf"`);
    pdfDoc.pipe(res);

    // Título
    pdfDoc.font('Helvetica-Bold').fontSize(18).fillColor('#333333')
      .text('Programación de Instalaciones', { align: 'center' });
    pdfDoc.moveDown(0.3);
    // OPUS-7: el subtitulo dice el periodo real exportado
    pdfDoc.font('Helvetica').fontSize(10).fillColor('#666666')
      .text(`${periodo.etiqueta}: ${periodo.desde} al ${periodo.hasta}`, { align: 'center' });
    pdfDoc.font('Helvetica').fontSize(9).fillColor('#888888')
      .text(`Generado: ${new Date().toLocaleDateString('sv-SE')} — Puertas Blindadas ERP — Módulo Inventario`, { align: 'center' });
    pdfDoc.moveDown(1.2);

    // Configuración tabla — OPUS-7: se agrega "Empleado tentativo"
    const colWidths = [30, 60, 55, 70, 95, 60, 70, 70, 75, 95];
    const headers   = ['OT', 'Fecha inst.', 'Estado', 'Cód. Proyecto', 'Nombre Proyecto', 'Cliente', 'Área', 'Responsable', 'Empleado tent.', 'Insumos'];
    const tableLeft = 40;
    const rowH = 24;
    let curY = pdfDoc.y;

    // Función auxiliar para dibujar una fila
    function drawRow(y, values, isHeader) {
      let x = tableLeft;
      values.forEach((val, i) => {
        // Fondo
        pdfDoc.save();
        if (isHeader) {
          pdfDoc.rect(x, y, colWidths[i], rowH).fill('#4472C4');
        }
        pdfDoc.restore();

        // Texto
        pdfDoc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(isHeader ? 9 : 8)
          .fillColor(isHeader ? '#FFFFFF' : '#333333')
          .text(val, x + 4, y + 7, { width: colWidths[i] - 8, height: rowH, lineBreak: false });
        x += colWidths[i];
      });

      // Bordes de fila
      if (!isHeader) {
        pdfDoc.save();
        pdfDoc.rect(tableLeft, y, colWidths.reduce((a, b) => a + b, 0), rowH)
          .strokeColor('#D0D0D0').lineWidth(0.5).stroke();
        pdfDoc.restore();
      }
    }

    // Header
    drawRow(curY, headers, true);
    curY += rowH;

    // Data rows
    rows.forEach((r, idx) => {
      if (curY + rowH > pdfDoc.page.height - 50) {
        pdfDoc.addPage();
        curY = 40;
        drawRow(curY, headers, true);
        curY += rowH;
      }

      // Fondo alterno
      if (idx % 2 === 0) {
        pdfDoc.save();
        pdfDoc.rect(tableLeft, curY, colWidths.reduce((a, b) => a + b, 0), rowH).fill('#F5F5F5');
        pdfDoc.restore();
      }

      drawRow(curY, [
        String(r.id),
        r.fecha ? new Date(r.fecha).toLocaleDateString('sv-SE') : '—',
        r.estado || '',
        r.proyecto_codigo || '',
        (r.proyecto_nombre || '').substring(0, 22),
        (r.cliente || '—').substring(0, 16),
        r.area || '',
        r.responsable || '',
        (r.empleado_tentativo || '—').substring(0, 14),
        (r.insumos || '—').substring(0, 20)
      ], false);

      curY += rowH;
    });

    // Footer
    pdfDoc.moveDown(1);
    pdfDoc.font('Helvetica').fontSize(9).fillColor('#888888')
      .text(`Total: ${rows.length} orden(es) de trabajo programadas — periodo ${periodo.desde} a ${periodo.hasta}`, tableLeft, curY + 12);

    await auditoria.registrar(req.user?.id, 'Exportar reporte', `Programación semanal exportada en formato PDF (${rows.length} registro(s))`);

    pdfDoc.end();
  } catch (err) {
    console.error('Error exportando PDF:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error generando el archivo. Intente nuevamente.' });
    }
  }
}

/**
 * GET /api/reportes/areas
 * CU-69: Lista áreas de trabajo para filtro de consumo por área
 */
async function listarAreas(req, res) {
  try {
    const { rows } = await query(
      // CU-102: la clasificación y el estado permiten ofrecer solo áreas de producción activas
      `SELECT area_trabajo_id_area AS id, area_trabajo_nombre_area AS nombre,
              area_trabajo_clasificacion AS clasificacion, area_trabajo_activo AS activo
       FROM area_trabajo
       ORDER BY area_trabajo_nombre_area`
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listando áreas:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/* ══════════════════════════════════════════════════════════════════════
   CU-71 — Índice de rotación
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Niveles sobre el índice MENSUALIZADO (índice × 30 ÷ días del período), para que
 * el mismo producto no cambie de nivel solo porque se eligió un período más largo.
 *   alta  >= 1     (el stock se renueva al menos una vez al mes)
 *   media >= 0,25  (entre una vez al mes y una vez cada cuatro meses)
 *   baja  <  0,25
 *   sin_rotacion   consumo neto 0 en el período
 */
const UMBRALES_ROTACION = { base_dias: 30, alta: 1, media: 0.25 };

/** 'YYYY-MM-DD' de una fecha LOCAL (nunca toISOString, que es UTC). */
function fechaLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Date local de un 'YYYY-MM-DD', o null si el texto no es una fecha real (p. ej. 2026-02-30). */
function leerFecha(txt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(txt || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return fechaLocal(d) === txt ? d : null;
}

/**
 * GET /api/reportes/rotacion?desde=YYYY-MM-DD&hasta=YYYY-MM-DD — CU-71, gerencia y jop.
 *
 * Por material activo que no sea herramienta:
 *   stock al inicio = stockAFecha(desde, 00:00); al final = stockAFecha(día siguiente a hasta, 00:00)
 *   stock promedio  = (inicio + final) ÷ 2   (SIMPLIFICACIÓN declarada: no pondera por días)
 *   consumo         = consumoNeto del período (misma regla que CU-47)
 *   índice          = consumo ÷ stock promedio; Exc 2: promedio <= 0 → "N/A", fuera del orden
 * Exc 1: fechas inválidas, desde > hasta o hasta futura → 400.
 * Exc 3: sin movimientos de consumo en el período → aviso y listas vacías.
 * Todo se lee en UNA transacción de solo lectura con la misma foto de la BD, así
 * un movimiento que llegue entre consultas no descuadra el inicio con el final.
 */
async function rotacion(req, res) {
  const { desde, hasta } = req.query;
  const dDesde = leerFecha(desde);
  const dHasta = leerFecha(hasta);

  if (!dDesde || !dHasta) {
    return res.status(400).json({ error: 'Ingrese un período válido: fecha de inicio y de fin con formato dd/mm/aaaa.' });
  }
  if (dDesde > dHasta) {
    return res.status(400).json({ error: 'La fecha de inicio no puede ser posterior a la fecha de fin. Reingrese el período.' });
  }
  if (hasta > fechaLocal(new Date())) {
    return res.status(400).json({ error: 'La fecha de fin no puede ser futura. Reingrese el período.' });
  }

  const dFin = new Date(dHasta.getFullYear(), dHasta.getMonth(), dHasta.getDate() + 1);
  const finExclusivo = fechaLocal(dFin);
  const dias = Math.round((dFin - dDesde) / 86400000);   // round: absorbe el cambio de hora

  try {
    const r = await conTransaccion(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const { rows: materiales } = await client.query(
        `SELECT m.material_sku AS sku, m.material_nombre_material AS nombre,
                m.material_material_critico AS es_critico,
                u.material_unidad_medida_nombre AS unidad,
                cg.material_categoria_general_nombre AS categoria
         FROM material m
         LEFT JOIN material_unidad_medida u
                ON u.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
         LEFT JOIN material_categoria_general cg
                ON cg.material_categoria_general_id_categoria_general = m.material_categoria_general_id_categoria_general
         WHERE m.material_estado = 'activo'
           AND m.material_es_herramienta IS NOT TRUE
         ORDER BY m.material_nombre_material`
      );
      return {
        materiales,
        inicio:  await stockAFecha(client, desde),
        final:   await stockAFecha(client, finExclusivo),
        consumo: await consumoNeto(client, { desde, hasta: finExclusivo }),
      };
    });

    const periodo = { desde, hasta, dias };
    const umbrales = UMBRALES_ROTACION;

    // Exc 3: ningún movimiento de consumo en el período
    if (r.consumo.size === 0) {
      return res.json({
        periodo, umbrales, productos: [], no_calculables: [],
        mensaje: 'No hay datos de consumo en el período seleccionado para calcular la rotación.',
      });
    }

    const redondear = (v, n = 4) => Math.round(v * 10 ** n) / 10 ** n;
    const productos = [];
    const noCalculables = [];

    for (const m of r.materiales) {
      const inicio   = r.inicio.get(m.sku) ?? 0;
      const final    = r.final.get(m.sku) ?? 0;
      const promedio = (inicio + final) / 2;
      const consumo  = r.consumo.get(m.sku) ?? 0;
      const fila = {
        ...m,
        stock_inicio: redondear(inicio),
        stock_final: redondear(final),
        stock_promedio: redondear(promedio),
        consumo: redondear(consumo),
        // Stock negativo en el pasado = hubo cambios de stock sin movimiento (datos antiguos)
        historial_incompleto: inicio < -1e-9 || final < -1e-9,
      };

      if (promedio <= 1e-9) {
        noCalculables.push({ ...fila, indice: null, indice_mensual: null, nivel: 'na' });
        continue;
      }
      // Devolver más de lo consumido dentro del período no es rotación negativa
      const indice  = Math.max(consumo, 0) / promedio;
      const mensual = indice * umbrales.base_dias / dias;
      const nivel = consumo <= 1e-9            ? 'sin_rotacion'
                  : mensual >= umbrales.alta   ? 'alta'
                  : mensual >= umbrales.media  ? 'media'
                  : 'baja';
      productos.push({ ...fila, indice: redondear(indice), indice_mensual: redondear(mensual), nivel });
    }

    // De menor a mayor: la baja rotación, que es lo que se busca, queda arriba
    productos.sort((a, b) => a.indice - b.indice || a.nombre.localeCompare(b.nombre));

    const cuenta = n => productos.filter(p => p.nivel === n).length;
    res.json({
      periodo, umbrales,
      resumen: {
        total: productos.length + noCalculables.length,
        alta: cuenta('alta'), media: cuenta('media'), baja: cuenta('baja'),
        sin_rotacion: cuenta('sin_rotacion'), na: noCalculables.length,
        historial_incompleto: [...productos, ...noCalculables].filter(p => p.historial_incompleto).length,
      },
      productos,
      no_calculables: noCalculables,
    });
  } catch (err) {
    responderError(res, err, 'Error calculando rotación:');
  }
}

/* ══════════════════════════════════════════════════════════════════════
   CU-75 — Reportes históricos consolidados
   ══════════════════════════════════════════════════════════════════════ */

const SIN_CATEGORIA = 'Sin categoría';
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** La granularidad anual compara el año elegido con los anteriores. */
const ANIOS_COMPARADOS = 5;

/**
 * Saldo valorizado en CLP por categoría justo antes de `instante`, con los precios
 * vigentes en `fechaPrecio` (D22). Un stock reconstruido negativo (cambios antiguos
 * sin movimiento) se valoriza en 0 y se cuenta como historial incompleto.
 */
async function saldoValorizado(client, materiales, instante, fechaPrecio) {
  const stock  = await stockAFecha(client, instante);
  const precio = await precioVigente(client, fechaPrecio);
  const porCategoria = {};
  let total = 0, sinPrecio = 0, incompleto = 0;
  for (const m of materiales) {
    let cantidad = stock.get(m.sku) ?? 0;
    if (cantidad < -1e-9) { incompleto++; cantidad = 0; }
    if (cantidad <= 1e-9) continue;
    const p = precio.get(m.sku)?.precio;
    if (p == null) { sinPrecio++; continue; }
    const valor = cantidad * p;
    porCategoria[m.categoria] = (porCategoria[m.categoria] || 0) + valor;
    total += valor;
  }
  for (const c of Object.keys(porCategoria)) porCategoria[c] = Math.round(porCategoria[c]);
  return { total: Math.round(total), por_categoria: porCategoria, sin_precio: sinPrecio, historial_incompleto: incompleto };
}

/**
 * GET /api/reportes/historico?anio=AAAA — CU-75, solo gerencia (son montos).
 *
 * Saldo al cierre de cada mes del año, por categoría general, valorizado en CLP
 * con el precio vigente al cierre. Sin tabla de cierres: stockAFecha reconstruye
 * cada uno (D21). Incluye TODOS los materiales, activos o no y herramientas: un
 * material hoy inactivo tuvo stock y valor en su momento.
 *  - Año en curso: solo hasta el mes actual; su cierre es "a la fecha".
 *  - Exc 3: año futuro → 400.
 *  - Exc 2: meses cuyo cierre es anterior al primer movimiento → "sin información".
 *  - Exc 1: ningún mes con información → mensaje, sin datos.
 *  - `anual`: cierres de diciembre del año elegido y los 4 anteriores con información.
 * Mensual y trimestral se arman en la vista a partir de `meses`.
 */
async function historico(req, res) {
  const anio = String(req.query.anio || '');
  if (!/^\d{4}$/.test(anio) || Number(anio) < 2000) {
    return res.status(400).json({ error: 'Seleccione un año válido.' });
  }
  const hoyD = new Date();
  const hoy = fechaLocal(hoyD);
  const anioNum = Number(anio);
  if (anioNum > hoyD.getFullYear()) {
    return res.status(400).json({ error: 'No se pueden generar reportes históricos para períodos futuros. Seleccione el año en curso o uno anterior.' });
  }

  /** Cierre del mes (1-12) de un año: instante exclusivo y fecha del precio. */
  const cierre = (a, mes) => {
    const ultimoDia = fechaLocal(new Date(a, mes, 0));
    const aLaFecha  = ultimoDia >= hoy;
    return {
      fecha: aLaFecha ? hoy : ultimoDia,
      a_la_fecha: aLaFecha,
      instante: fechaLocal(new Date(a, mes, 1)),   // primer día del mes siguiente
    };
  };

  try {
    const r = await conTransaccion(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const { rows: materiales } = await client.query(
        `SELECT m.material_sku AS sku,
                COALESCE(cg.material_categoria_general_nombre, '${SIN_CATEGORIA}') AS categoria
         FROM material m
         LEFT JOIN material_categoria_general cg
                ON cg.material_categoria_general_id_categoria_general = m.material_categoria_general_id_categoria_general`
      );
      // Fecha LOCAL del primer movimiento: el ::date usa la zona horaria de la sesión
      const { rows: pm } = await client.query(
        `SELECT MIN(movimiento_inventario_fecha_hora)::date::text AS primero FROM movimiento_inventario`
      );
      const primero = pm[0].primero;   // null si no hay ningún movimiento
      const conInfo = (c) => primero != null && c.fecha >= primero;

      const ultimoMes = anioNum === hoyD.getFullYear() ? hoyD.getMonth() + 1 : 12;
      const meses = [];
      for (let mes = 1; mes <= ultimoMes; mes++) {
        const c = cierre(anioNum, mes);
        const base = {
          mes: `${anio}-${String(mes).padStart(2, '0')}`,
          etiqueta: `${MESES_CORTOS[mes - 1]} ${anio}`,
          cierre: c.fecha, a_la_fecha: c.a_la_fecha,
          con_informacion: conInfo(c),
        };
        meses.push(base.con_informacion
          ? { ...base, ...await saldoValorizado(client, materiales, c.instante, c.fecha) }
          : base);
      }

      const anual = [];
      for (let a = anioNum - ANIOS_COMPARADOS + 1; a <= anioNum; a++) {
        const c = cierre(a, a === hoyD.getFullYear() ? hoyD.getMonth() + 1 : 12);
        if (!conInfo(c)) continue;
        anual.push({ anio: a, etiqueta: String(a), cierre: c.fecha, a_la_fecha: c.a_la_fecha,
                     ...await saldoValorizado(client, materiales, c.instante, c.fecha) });
      }

      const categorias = [...new Set(materiales.map(m => m.categoria))]
        .sort((x, y) => (x === SIN_CATEGORIA) - (y === SIN_CATEGORIA) || x.localeCompare(y));
      return { primero, meses, anual, categorias };
    });

    // Exc 1: ningún mes del año tiene información
    if (!r.meses.some(m => m.con_informacion)) {
      return res.json({
        anio: anioNum, primer_movimiento: r.primero, categorias: r.categorias, meses: [], anual: [],
        mensaje: r.primero
          ? `No existen registros de inventario para ${anio}. El primer movimiento registrado es del ${r.primero.split('-').reverse().join('/')}: elija otro año.`
          : 'No existen registros de inventario. Elija otro año cuando haya movimientos registrados.',
      });
    }

    res.json({
      anio: anioNum,
      primer_movimiento: r.primero,
      categorias: r.categorias,
      meses: r.meses,
      anual: r.anual,
      // Exc 2: meses sin información dentro del año
      meses_sin_informacion: r.meses.filter(m => !m.con_informacion).map(m => m.mes),
    });
  } catch (err) {
    responderError(res, err, 'Error generando reporte histórico:');
  }
}

/* ══════════════════════════════════════════════════════════════════════
   CU-104 — Ranking de desviaciones críticas por impacto
   ══════════════════════════════════════════════════════════════════════ */

/** Tipos de CU-103 que son pérdida: sobregasto y consumo no planificado (sin base). */
const TIPOS_PERDIDA = ['sobre_gasto', 'sin_base'];

/**
 * GET /api/reportes/desviaciones?desde=&hasta=&area_id= — CU-104, gerencia y jop.
 *
 * Lee los diferenciales procesados en CU-103 de las OTs cuya FECHA DE LA OT cae en
 * el período (reprocesar una OT no la cambia de período), opcionalmente de un área
 * (la de la OT). El ranking lleva solo las pérdidas (sobre_gasto y sin_base),
 * ordenadas por impacto en CLP de mayor a menor; las que no tienen precio van al
 * final por desviación %. Ahorros y "sin desviación" solo se cuentan en el resumen.
 *  - Exc 1: fechas inválidas o desde > hasta → 400.
 *  - Exc 2: ningún diferencial para los criterios → mensaje, sin ranking.
 * Para jop se quitan los montos DESPUÉS de ordenar: ve el mismo orden (D36).
 */
async function desviaciones(req, res) {
  const { desde, hasta } = req.query;
  const areaId = req.query.area_id ? String(req.query.area_id) : null;
  const dDesde = leerFecha(desde);
  const dHasta = leerFecha(hasta);

  if (!dDesde || !dHasta) {
    return res.status(400).json({ error: 'Ingrese un período válido: fecha de inicio y de fin con formato dd/mm/aaaa.' });
  }
  if (dDesde > dHasta) {
    return res.status(400).json({ error: 'La fecha de inicio no puede ser posterior a la fecha de fin. Corrija las fechas.' });
  }
  if (areaId != null && !/^\d+$/.test(areaId)) {
    return res.status(400).json({ error: 'El área seleccionada no es válida.' });
  }

  try {
    let area = null;
    if (areaId != null) {
      const { rows } = await query(
        `SELECT area_trabajo_id_area AS id, area_trabajo_nombre_area AS nombre FROM area_trabajo WHERE area_trabajo_id_area = $1`,
        [areaId]
      );
      if (rows.length === 0) return res.status(400).json({ error: 'El área seleccionada no existe.' });
      area = rows[0];
    }

    // El ::date del rango usa la zona horaria de la sesión (fecha local), como en los demás reportes
    const { rows } = await query(
      `SELECT d.orden_trabajo_id_orden::int AS ot_id,
              TO_CHAR(ot.orden_trabajo_fecha_hora, 'YYYY-MM-DD') AS ot_fecha,
              ot.orden_trabajo_estado AS ot_estado,
              a.area_trabajo_id_area::int AS area_id, a.area_trabajo_nombre_area AS area,
              d.material_sku AS sku, m.material_nombre_material AS nombre,
              u.material_unidad_medida_nombre AS unidad,
              d.diferencial_consumo_estimado::float AS estimado, d.diferencial_consumo_real::float AS real,
              d.diferencial_consumo_desviacion_abs::float AS desviacion_abs,
              d.diferencial_consumo_desviacion_pct::float AS desviacion_pct,
              d.diferencial_consumo_tipo AS tipo, d.diferencial_consumo_impacto_clp::float AS impacto_clp
       FROM diferencial_consumo d
       JOIN orden_trabajo ot ON ot.orden_trabajo_id_orden = d.orden_trabajo_id_orden
       JOIN area_trabajo a   ON a.area_trabajo_id_area = ot.area_trabajo_id_area
       JOIN material m       ON m.material_sku = d.material_sku
       LEFT JOIN material_unidad_medida u
              ON u.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
       WHERE ot.orden_trabajo_fecha_hora >= $1::date
         AND ot.orden_trabajo_fecha_hora < ($2::date + INTERVAL '1 day')
         AND ($3::bigint IS NULL OR ot.area_trabajo_id_area = $3::bigint)
       ORDER BY d.diferencial_consumo_impacto_clp DESC NULLS LAST,
                d.diferencial_consumo_desviacion_pct DESC NULLS FIRST,
                d.diferencial_consumo_desviacion_abs DESC,
                d.orden_trabajo_id_orden, d.material_sku`,
      [desde, hasta, areaId]
    );

    const periodo = { desde, hasta };
    const cuenta = t => rows.filter(r => r.tipo === t).length;
    const ranking = rows
      .filter(r => TIPOS_PERDIDA.includes(r.tipo))
      .map((r, i) => ({ posicion: i + 1, ...r, sin_precio: r.impacto_clp == null }));
    const resumen = {
      procesados: rows.length,
      items: ranking.length,
      ots: new Set(ranking.map(r => r.ot_id)).size,
      sobre_gasto: cuenta('sobre_gasto'), sin_base: cuenta('sin_base'),
      ahorro: cuenta('ahorro'), sin_desviacion: cuenta('sin_desviacion'),
      sin_precio: ranking.filter(r => r.sin_precio).length,
      impacto_total_clp: Math.round(ranking.reduce((s, r) => s + (r.impacto_clp || 0), 0) * 100) / 100,
    };
    if (ocultaMontos(req)) {
      quitarCampos(ranking, ['impacto_clp']);
      quitarCampos([resumen], ['impacto_total_clp']);
    }

    // Exc 2: nada procesado para los criterios; o todo lo procesado es ahorro o sin desviación
    let mensaje;
    if (rows.length === 0) {
      mensaje = 'Sin resultados: no hay diferenciales de consumo procesados para las OTs del período' +
                (area ? ` en el área ${area.nombre}` : '') + '.';
    } else if (ranking.length === 0) {
      mensaje = `Sin resultados: los ${rows.length} ítem(s) procesados del período no tienen sobregasto ` +
                '(son ahorros o no tienen desviación).';
    }
    res.json({ periodo, area, resumen, ranking, ...(mensaje && { mensaje }) });
  } catch (err) {
    responderError(res, err, 'Error generando el ranking de desviaciones:');
  }
}

module.exports = { reporteMovimientos, reporteMermas, valorizacion, consumoArea, consumoAreaGrafico, programacionSemanal, exportarProgramacion, exportarProgramacionPDF, listarAreas, rotacion, historico, desviaciones };
