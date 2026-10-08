/**
 * Reglas históricas compartidas por los reportes (CU-71, CU-75) y la evaluación
 * de cobertura (CU-47). Una sola definición de "consumo" para todo el sistema:
 * dos copias de la misma regla es garantía de que una se queda atrás.
 *
 * Todas las funciones reciben `db`: un client de una transacción abierta o el
 * módulo db/pool. Solo leen.
 */

/**
 * Consumo neto por material en [desde, hasta): lo que salió de bodega para usarse,
 * menos lo que se devolvió de ese consumo.
 *
 *  - Cuentan los movimientos 'completado' o 'confirmado': sin revertidos,
 *    rechazados ni mermas pendientes de aprobación.
 *  - Sin movimientos inversos de CU-44 (D23): el original ya está 'revertido'.
 *  - Suman las salidas, salvo los traslados (el material sigue en la empresa) y los ajustes de
 *    inventario (D53: corrigen el registro, no son material usado).
 *  - Restan las devoluciones de consumo: motivo 'devolucion_consumo' (OT y
 *    pinturas) o, en registros anteriores a ese motivo, cualquier entrada con OT.
 *
 * `desde` y `hasta` son instantes (Date o texto que PostgreSQL entienda como
 * timestamptz; 'YYYY-MM-DD' es la medianoche local). null = sin límite.
 * Devuelve Map sku -> consumo neto (puede ser negativo si se devolvió más de lo
 * que se consumió dentro de la ventana).
 */
async function consumoNeto(db, { desde = null, hasta = null } = {}) {
  const { rows } = await db.query(
    `SELECT mi.material_sku AS sku,
            SUM(CASE WHEN LOWER(tm.movimiento_inventario_tipo_movimiento_nombre) = 'salida'
                     THEN mi.movimiento_inventario_cantidad
                     ELSE -mi.movimiento_inventario_cantidad END) AS neto
     FROM movimiento_inventario mi
     JOIN movimiento_inventario_tipo_movimiento tm
          ON tm.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
           = mi.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
     LEFT JOIN movimiento_inventario_motivo_movimiento mot
          ON mot.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
           = mi.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
     LEFT JOIN movimiento_inventario_clasificacion_salida cs
          ON cs.movimiento_inventario_clasificacion_salida_id_clasificacion_sal
           = mot.movimiento_inventario_clasificacion_salida_id_clasificacion_sal
     WHERE ($1::timestamptz IS NULL OR mi.movimiento_inventario_fecha_hora >= $1::timestamptz)
       AND ($2::timestamptz IS NULL OR mi.movimiento_inventario_fecha_hora <  $2::timestamptz)
       AND mi.movimiento_inventario_estado IN ('completado', 'confirmado')
       AND mi.movimiento_inventario_id_revertido IS NULL
       AND (   (LOWER(tm.movimiento_inventario_tipo_movimiento_nombre) = 'salida'
                AND COALESCE(LOWER(cs.movimiento_inventario_clasificacion_salida_nombre), '') NOT LIKE '%traslado%'
                AND COALESCE(LOWER(cs.movimiento_inventario_clasificacion_salida_nombre), '') <> 'ajuste_inventario')
            OR (LOWER(tm.movimiento_inventario_tipo_movimiento_nombre) = 'entrada'
                AND (   LOWER(mot.movimiento_inventario_motivo_movimiento_nombre) = 'devolucion_consumo'
                     OR mi.orden_trabajo_id_orden IS NOT NULL)))
     GROUP BY mi.material_sku`,
    [desde, hasta]
  );
  return new Map(rows.map(r => [r.sku, parseFloat(r.neto)]));
}

/**
 * Stock físico por material justo ANTES de `instante` (D21): el stock actual
 * menos todo lo que se movió desde ese instante en adelante. No hay tabla de
 * cierres: se reconstruye hacia atrás desde los movimientos.
 *
 * Qué movimientos se deshacen: los que realmente movieron el stock.
 *  - Entradas suman y salidas restan. Otros tipos ('ajuste', el 'reverso' anterior
 *    a CU-44) no dicen su sentido y cuentan 0.
 *  - 'pendiente_aprobacion' SÍ cuenta: la merma ya descontó el stock.
 *  - 'revertido' y los inversos de CU-44 NO cuentan (D23): el par suma cero, y
 *    "Eliminar material" de una OT y la reversión marcan el original sin inverso.
 *  - 'rechazado' NO cuenta: el rechazo devolvió el stock sin movimiento.
 *
 * La historia que se obtiene es la CORREGIDA: un movimiento anulado no existe en
 * ninguna fecha, tampoco entre su registro y su anulación (en ese intervalo el
 * sistema mostraba menos o más stock que el reconstruido). Es lo coherente con
 * anular = "ese movimiento fue un error".
 *
 * `instante`: Date o texto timestamptz ('YYYY-MM-DD' = medianoche local).
 * Devuelve Map sku -> stock para todos los materiales. Si hubo cambios de stock
 * sin movimiento (datos antiguos), el pasado reconstruido puede dar negativo:
 * no se corrige aquí, lo informa quien lo usa.
 */
async function stockAFecha(db, instante) {
  const { rows } = await db.query(
    `SELECT m.material_sku AS sku,
            COALESCE(st.fisica, 0) - COALESCE(mv.neto, 0) AS stock
     FROM material m
     LEFT JOIN (SELECT material_sku, SUM(inventario_bodega_cantidad_fisica) AS fisica
                FROM inventario_bodega GROUP BY material_sku) st
            ON st.material_sku = m.material_sku
     LEFT JOIN (SELECT mi.material_sku,
                       SUM(CASE LOWER(tm.movimiento_inventario_tipo_movimiento_nombre)
                             WHEN 'entrada' THEN  mi.movimiento_inventario_cantidad
                             WHEN 'salida'  THEN -mi.movimiento_inventario_cantidad
                             ELSE 0 END) AS neto
                FROM movimiento_inventario mi
                JOIN movimiento_inventario_tipo_movimiento tm
                     ON tm.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
                      = mi.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
                WHERE mi.movimiento_inventario_fecha_hora >= $1::timestamptz
                  AND mi.movimiento_inventario_estado NOT IN ('revertido', 'rechazado')
                  AND mi.movimiento_inventario_id_revertido IS NULL
                GROUP BY mi.material_sku) mv
            ON mv.material_sku = m.material_sku`,
    [instante]
  );
  return new Map(rows.map(r => [r.sku, parseFloat(r.stock)]));
}

/**
 * Precio unitario en CLP de cada material vigente en `fecha` ('YYYY-MM-DD'), para
 * valorizar saldos históricos (CU-75, D22). Por orden:
 *   1. el último precio del proveedor PRINCIPAL en historial_precio_material con
 *      vigencia desde <= fecha;
 *   2. si no hay, el último de cualquier proveedor;
 *   3. si no hay, el precio referencial actual del proveedor principal;
 *   4. si no, sin precio (precio null).
 * El proveedor principal se toma con LATERAL ... LIMIT 1: un JOIN directo a
 * material_proveedor multiplica las filas.
 * Devuelve Map sku -> { precio, fuente } con fuente 'historial' | 'historial_otro' | 'referencial' | null.
 */
async function precioVigente(db, fecha) {
  const { rows } = await db.query(
    `SELECT m.material_sku AS sku,
            hp.precio AS principal, ho.precio AS otro, mp.referencial
     FROM material m
     LEFT JOIN LATERAL (
       SELECT x.proveedor_id_proveedor AS proveedor, x.material_proveedor_precio_referencial AS referencial
       FROM material_proveedor x
       WHERE x.material_sku = m.material_sku AND x.material_proveedor_proveedor_principal = TRUE
       ORDER BY x.proveedor_id_proveedor LIMIT 1
     ) mp ON TRUE
     LEFT JOIN LATERAL (
       SELECT h.precio_unitario AS precio FROM historial_precio_material h
       WHERE h.material_sku = m.material_sku AND h.proveedor_id_proveedor = mp.proveedor
         AND h.moneda = 'CLP' AND h.fecha_vigencia_desde <= $1::date
       ORDER BY h.fecha_vigencia_desde DESC, h.historial_precio_id DESC LIMIT 1
     ) hp ON TRUE
     LEFT JOIN LATERAL (
       SELECT h.precio_unitario AS precio FROM historial_precio_material h
       WHERE h.material_sku = m.material_sku
         AND h.moneda = 'CLP' AND h.fecha_vigencia_desde <= $1::date
       ORDER BY h.fecha_vigencia_desde DESC, h.historial_precio_id DESC LIMIT 1
     ) ho ON TRUE`,
    [fecha]
  );
  return new Map(rows.map(r => {
    const [precio, fuente] =
      r.principal   != null ? [r.principal, 'historial'] :
      r.otro        != null ? [r.otro, 'historial_otro'] :
      r.referencial != null ? [r.referencial, 'referencial'] : [null, null];
    return [r.sku, { precio: precio == null ? null : parseFloat(precio), fuente }];
  }));
}

module.exports = { consumoNeto, stockAFecha, precioVigente };
