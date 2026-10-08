const { query } = require('./pool');

/**
 * Entregas de proveedores: la consulta base de CU-62, CU-63 y CU-65 (una sola,
 * igual que BASE_CONSUMO en reportes, para que las tres métricas no diverjan).
 *
 * Una fila por LOTE con fecha de pedido y proveedor (decisión V2, validada en la
 * sesión 7):
 *   fecha_pedido     = la primera fecha de lote_fecha_pedido que NO sea posterior a
 *                      la recepción (la tabla trae fechas posteriores: la semilla
 *                      original la usó como historial de precios)
 *   fecha_recepcion  = lote.lote_fecha_recepcion; NULL = pedido pendiente (Exc 2)
 *   dias_habiles     = días hábiles entre pedido y recepción: lunes a viernes, SIN
 *                      feriados (simplificación declarada). Viernes → lunes = 1.
 *   plazo_prometido  = material_proveedor_tiempo_reposicion ACTUAL del producto con
 *                      ese proveedor (no hay histórico de plazos)
 *   sku              = el de la entrada que creó el lote (o, si no hay, el del stock)
 *
 * Filtros: proveedorId, sku, desde/hasta (sobre la recepción; las pendientes, sobre
 * la fecha de pedido). Sin montos: el rol jop también ve estas métricas.
 */
const SQL_ENTREGAS = `
  WITH base AS (
    SELECT l.lote_id_lote                          AS lote_id,
           l.lote_numero_lote                      AS lote,
           l.proveedor_id_proveedor                AS proveedor_id,
           l.lote_fecha_recepcion                  AS fecha_recepcion,
           (SELECT MIN(fp.lote_fecha_pedido_fecha_pedido) FROM lote_fecha_pedido fp
             WHERE fp.lote_id_lote = l.lote_id_lote
               AND (l.lote_fecha_recepcion IS NULL OR fp.lote_fecha_pedido_fecha_pedido <= l.lote_fecha_recepcion)
           )                                       AS fecha_pedido,
           COALESCE(
             (SELECT mi.material_sku FROM movimiento_inventario mi
               JOIN movimiento_inventario_tipo_movimiento tm
                    ON tm.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
                     = mi.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
              WHERE mi.lote_id_lote = l.lote_id_lote
                AND LOWER(tm.movimiento_inventario_tipo_movimiento_nombre) = 'entrada'
              ORDER BY mi.movimiento_inventario_fecha_hora, mi.movimiento_inventario_id_movimiento
              LIMIT 1),
             (SELECT MIN(ib.material_sku) FROM inventario_bodega ib WHERE ib.lote_id_lote = l.lote_id_lote)
           )                                       AS sku
    FROM lote l
  )
  SELECT b.lote_id, b.lote, b.proveedor_id, p.proveedor_razon_social AS proveedor,
         b.sku, m.material_nombre_material AS producto,
         to_char(b.fecha_pedido, 'YYYY-MM-DD')     AS fecha_pedido,
         to_char(b.fecha_recepcion, 'YYYY-MM-DD')  AS fecha_recepcion,
         -- Aritmética de FECHAS (date + int), sin timestamptz: un generate_series con
         -- INTERVAL '1 day' pasa por la zona horaria y en el cambio de horario de Chile
         -- (la medianoche no existe) se corría una hora y perdía el último día.
         CASE WHEN b.fecha_recepcion IS NULL THEN NULL
              ELSE (SELECT count(*)::int
                    FROM generate_series(1, b.fecha_recepcion - b.fecha_pedido) AS i
                    WHERE EXTRACT(ISODOW FROM b.fecha_pedido + i) < 6)
         END                                       AS dias_habiles,
         mp.material_proveedor_tiempo_reposicion   AS plazo_prometido
  FROM base b
  LEFT JOIN proveedor p ON p.proveedor_id_proveedor = b.proveedor_id
  LEFT JOIN material m  ON m.material_sku = b.sku
  LEFT JOIN material_proveedor mp
         ON mp.material_sku = b.sku AND mp.proveedor_id_proveedor = b.proveedor_id
  WHERE b.fecha_pedido IS NOT NULL
    AND b.proveedor_id IS NOT NULL
    AND ($1::bigint IS NULL OR b.proveedor_id = $1::bigint)
    AND ($2::text   IS NULL OR b.sku = $2::text)
    AND ($3::date   IS NULL OR COALESCE(b.fecha_recepcion, b.fecha_pedido) >= $3::date)
    AND ($4::date   IS NULL OR COALESCE(b.fecha_recepcion, b.fecha_pedido) <= $4::date)
  ORDER BY COALESCE(b.fecha_recepcion, b.fecha_pedido) DESC, b.lote_id DESC`;

/** Entregas (recibidas y pendientes) según los filtros. */
async function consultarEntregas({ proveedorId = null, sku = null, desde = null, hasta = null } = {}) {
  const { rows } = await query(SQL_ENTREGAS, [proveedorId, sku, desde, hasta]);
  return rows.map(r => ({
    ...r,
    plazo_prometido: r.plazo_prometido == null ? null : parseInt(r.plazo_prometido),
    a_tiempo: r.dias_habiles == null || r.plazo_prometido == null ? null : r.dias_habiles <= parseInt(r.plazo_prometido),
  }));
}

const redondear1 = (v) => Math.round(v * 10) / 10;
const promedio = (xs) => (xs.length ? redondear1(xs.reduce((s, x) => s + x, 0) / xs.length) : null);

/**
 * Indicadores de un conjunto de entregas. Solo cuentan las RECIBIDAS; las
 * pendientes se informan aparte (CU-62 Exc 2). Sin recibidas: `disponible: false`
 * y sin promedio (Exc 1). El % de cumplimiento y la desviación solo usan las
 * entregas cuyo producto tiene plazo prometido con ese proveedor.
 */
function resumirEntregas(entregas) {
  const recibidas = entregas.filter(e => e.fecha_recepcion != null);
  const pendientes = entregas.length - recibidas.length;
  if (recibidas.length === 0) {
    return { disponible: false, entregas: 0, pendientes };
  }

  const dias = recibidas.map(e => e.dias_habiles).sort((a, b) => a - b);
  const mitad = Math.floor(dias.length / 2);
  const mediana = dias.length % 2 ? dias[mitad] : redondear1((dias[mitad - 1] + dias[mitad]) / 2);

  const conPlazo = recibidas.filter(e => e.plazo_prometido != null);
  const aTiempo  = conPlazo.filter(e => e.a_tiempo).length;
  return {
    disponible: true,
    entregas: recibidas.length,
    pendientes,
    promedio_dias: promedio(dias),
    mediana_dias: mediana,
    minimo_dias: dias[0],
    maximo_dias: dias[dias.length - 1],
    con_plazo: conPlazo.length,
    plazo_prometido_promedio: promedio(conPlazo.map(e => e.plazo_prometido)),
    a_tiempo: aTiempo,
    con_retraso: conPlazo.length - aTiempo,
    cumplimiento_pct: conPlazo.length ? redondear1((aTiempo / conPlazo.length) * 100) : null,
    retraso_pct: conPlazo.length ? redondear1(((conPlazo.length - aTiempo) / conPlazo.length) * 100) : null,
    // CU-63: desviación promedio en días (real − prometido; negativo = antes de plazo)
    desviacion_promedio_dias: promedio(conPlazo.map(e => e.dias_habiles - e.plazo_prometido)),
  };
}

module.exports = { consultarEntregas, resumirEntregas };
