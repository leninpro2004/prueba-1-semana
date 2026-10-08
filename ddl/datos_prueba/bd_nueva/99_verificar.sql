-- ============================================================
-- Verificación de los datos de prueba (SOLO LECTURA)
-- Grupo 14 | Correr después de cargar 01..06 (y 07 si se usó).
--
-- Cada consulta devuelve las filas con PROBLEMAS: si todo está bien, todas vuelven vacías
-- y la última muestra el resumen. Son los mismos invariantes que protegen los tests.
-- ============================================================

SET client_encoding = 'UTF8';
SET search_path TO inventario;

\echo '1. Stock por material = suma de sus movimientos (stockAFecha antes del primer movimiento debe ser 0)'
SELECT m.material_sku, COALESCE(st.fisica, 0) AS stock, COALESCE(mv.neto, 0) AS movimientos
FROM material m
LEFT JOIN (SELECT material_sku, SUM(inventario_bodega_cantidad_fisica) AS fisica FROM inventario_bodega GROUP BY 1) st
       ON st.material_sku = m.material_sku
LEFT JOIN (SELECT mi.material_sku,
                  SUM(CASE WHEN tm.movimiento_inventario_tipo_movimiento_nombre = 'entrada' THEN mi.movimiento_inventario_cantidad
                           WHEN tm.movimiento_inventario_tipo_movimiento_nombre = 'salida'  THEN -mi.movimiento_inventario_cantidad
                           ELSE 0 END) AS neto
           FROM movimiento_inventario mi
           JOIN movimiento_inventario_tipo_movimiento tm
             ON tm.movimiento_inventario_tipo_movimiento_id_tipo_movimiento = mi.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
           WHERE mi.movimiento_inventario_estado NOT IN ('revertido', 'rechazado')
             AND mi.movimiento_inventario_id_revertido IS NULL
           GROUP BY 1) mv ON mv.material_sku = m.material_sku
WHERE COALESCE(st.fisica, 0) <> COALESCE(mv.neto, 0);

\echo '2. Stock por material y bodega = sus movimientos en esa bodega'
WITH mov AS (
  -- Igual que stockAFecha: entradas suman, salidas restan, otros tipos (ajuste, reverso antiguo) cuentan 0
  SELECT mi.material_sku, mi.bodega_id_bodega,
         SUM(CASE tm.movimiento_inventario_tipo_movimiento_nombre WHEN 'entrada' THEN 1 WHEN 'salida' THEN -1 ELSE 0 END
             * mi.movimiento_inventario_cantidad) AS neto
  FROM movimiento_inventario mi
  JOIN movimiento_inventario_tipo_movimiento tm
    ON tm.movimiento_inventario_tipo_movimiento_id_tipo_movimiento = mi.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
  WHERE mi.movimiento_inventario_estado NOT IN ('revertido', 'rechazado') AND mi.movimiento_inventario_id_revertido IS NULL
  GROUP BY 1, 2),
stk AS (SELECT material_sku, bodega_id_bodega, SUM(inventario_bodega_cantidad_fisica) AS fisica FROM inventario_bodega GROUP BY 1, 2)
SELECT COALESCE(mov.material_sku, stk.material_sku) AS sku, COALESCE(mov.bodega_id_bodega, stk.bodega_id_bodega) AS bodega,
       COALESCE(stk.fisica, 0) AS stock, COALESCE(mov.neto, 0) AS movimientos
FROM mov FULL OUTER JOIN stk ON stk.material_sku = mov.material_sku AND stk.bodega_id_bodega = mov.bodega_id_bodega
WHERE COALESCE(stk.fisica, 0) <> COALESCE(mov.neto, 0);

\echo '3. Reservas activas = stock reservado (por material y por lote)'
WITH res AS (SELECT material_sku, lote_id_lote, bodega_id_bodega, SUM(reserva_inventario_cantidad_reservada) AS r
             FROM reserva_inventario WHERE reserva_inventario_estado_reserva = 'activa' GROUP BY 1, 2, 3),
     stk AS (SELECT material_sku, lote_id_lote, bodega_id_bodega, inventario_bodega_cantidad_reservada AS s FROM inventario_bodega)
SELECT COALESCE(res.material_sku, stk.material_sku) AS sku, COALESCE(res.lote_id_lote, stk.lote_id_lote) AS lote,
       COALESCE(res.bodega_id_bodega, stk.bodega_id_bodega) AS bodega, COALESCE(res.r, 0) AS reservas, COALESCE(stk.s, 0) AS reservado
FROM res FULL OUTER JOIN stk USING (material_sku, lote_id_lote, bodega_id_bodega)
WHERE COALESCE(res.r, 0) <> COALESCE(stk.s, 0);

\echo '4. Filas de stock imposibles (negativas o con más reservado que físico)'
SELECT * FROM inventario_bodega
WHERE inventario_bodega_cantidad_fisica < 0 OR inventario_bodega_cantidad_reservada < 0
   OR inventario_bodega_cantidad_reservada > inventario_bodega_cantidad_fisica;

\echo '5. Pedidos de instalación preparados o posteriores con lo reservado distinto de lo pedido'
WITH ult AS (
  SELECT DISTINCT ON (preparacion_pedido_id_preparacion) preparacion_pedido_id_preparacion AS prep,
         preparacion_pedido_estado_nombre_estado AS estado
  FROM preparacion_pedido_estado
  ORDER BY preparacion_pedido_id_preparacion, preparacion_pedido_estado_timestamp_accion DESC, preparacion_pedido_estado_id_estado_preparacion DESC)
SELECT ult.prep, ult.estado, d.material_sku, d.preparacion_pedido_detalle_cantidad_requerida AS requerida,
       COALESCE(SUM(ri.reserva_inventario_cantidad_reservada) FILTER (WHERE ri.reserva_inventario_estado_reserva = 'activa'), 0) AS reservada
FROM ult
JOIN preparacion_pedido_detalle d ON d.preparacion_pedido_id_preparacion = ult.prep
LEFT JOIN reserva_inventario ri ON ri.preparacion_pedido_detalle_id = d.preparacion_pedido_detalle_id
WHERE ult.estado IN ('preparado', 'en_carga')
GROUP BY 1, 2, 3, 4
HAVING COALESCE(SUM(ri.reserva_inventario_cantidad_reservada) FILTER (WHERE ri.reserva_inventario_estado_reserva = 'activa'), 0)
       <> d.preparacion_pedido_detalle_cantidad_requerida;

\echo '6. Movimientos con fecha futura'
SELECT movimiento_inventario_id_movimiento, movimiento_inventario_fecha_hora FROM movimiento_inventario
WHERE movimiento_inventario_fecha_hora > now();

\echo '7. Secuencias atrasadas (el próximo INSERT del sistema chocaría con un id existente)'
SELECT x.tabla, x.columna, x.maximo, x.secuencia
FROM (
  SELECT c.table_schema || '.' || c.table_name AS tabla, c.column_name AS columna,
         (xpath('/row/m/text()', query_to_xml(format('SELECT max(%I) AS m FROM %I.%I', c.column_name, c.table_schema, c.table_name), false, true, '')))[1]::text::bigint AS maximo,
         (xpath('/row/v/text()', query_to_xml(format('SELECT last_value AS v FROM %s', pg_get_serial_sequence(c.table_schema || '.' || c.table_name, c.column_name)), false, true, '')))[1]::text::bigint AS secuencia
  FROM information_schema.columns c
  WHERE c.table_schema IN ('inventario', 'finanzas', 'terreno') AND c.is_identity = 'YES'
) x
WHERE x.maximo IS NOT NULL AND x.secuencia < x.maximo;

\echo '8. Saldos históricos negativos (el saldo de un material en una bodega nunca bajó de 0 en ningún momento)'
WITH mov AS (
  SELECT mi.material_sku, mi.bodega_id_bodega, mi.movimiento_inventario_fecha_hora AS fecha,
         SUM(CASE tm.movimiento_inventario_tipo_movimiento_nombre WHEN 'entrada' THEN 1 WHEN 'salida' THEN -1 ELSE 0 END
             * mi.movimiento_inventario_cantidad)
           OVER (PARTITION BY mi.material_sku, mi.bodega_id_bodega
                 ORDER BY mi.movimiento_inventario_fecha_hora, mi.movimiento_inventario_id_movimiento) AS saldo
  FROM movimiento_inventario mi
  JOIN movimiento_inventario_tipo_movimiento tm
    ON tm.movimiento_inventario_tipo_movimiento_id_tipo_movimiento = mi.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
  WHERE mi.movimiento_inventario_estado NOT IN ('revertido', 'rechazado') AND mi.movimiento_inventario_id_revertido IS NULL)
SELECT material_sku, bodega_id_bodega, min(saldo) AS saldo_minimo, (array_agg(fecha ORDER BY saldo))[1] AS cuando
FROM mov GROUP BY 1, 2 HAVING min(saldo) < 0;

\echo 'Resumen'
SELECT (SELECT count(*) FROM material)                                   AS materiales,
       (SELECT count(*) FROM movimiento_inventario)                      AS movimientos,
       (SELECT count(*) FROM lote)                                       AS lotes,
       (SELECT count(*) FROM reserva_inventario WHERE reserva_inventario_estado_reserva = 'activa') AS reservas_activas,
       (SELECT count(*) FROM finanzas.nota_venta WHERE numero_nota_venta LIKE 'NV-PRUEBA-%') AS ventas_prueba,
       (SELECT count(*) FROM preparacion_pedido)                         AS pedidos_instalacion,
       (SELECT count(*) FROM orden_trabajo)                              AS ordenes_trabajo,
       (SELECT count(*) FROM conteo_ciclico)                             AS conteos,
       (SELECT count(*) FROM alerta_inventario)                          AS alertas,
       (SELECT min(movimiento_inventario_fecha_hora)::date FROM movimiento_inventario) AS primer_movimiento;
