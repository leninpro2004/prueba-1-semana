-- ============================================================
-- Datos de prueba (BD NUEVA) — 07 · OPCIONAL: volumen para CU-76 (límite de 10.000 filas)
-- Grupo 14 | Escrito a mano (no lo genera generador/generar.js).
--
-- Agrega el material TOR-AUT (tornillo autoperforante) con 15 compras de 2.000 unidades
-- (una cada 30 días) y 10.200 salidas de 2 unidades repartidas en 15 meses: 10.215
-- movimientos coherentes. Con esto, exportar el historial de movimientos (o solo los de
-- TOR-AUT) supera las 10.000 filas y el sistema pide acotar los filtros (CU-76 Exc 1).
--
-- Se carga DESPUÉS de 01..06. Las salidas nunca dejan el stock negativo: se consumen unas
-- 45 unidades al día y cada compra trae 2.000 cada 30 días. Stock final: 9.600, por FIFO
-- (los 10 lotes más antiguos quedan en 0, el 11.º con 1.600 y los 4 últimos enteros).
-- ============================================================

-- El archivo es UTF-8: sin esto, psql en Windows lo lee como WIN1252 y daña los acentos
SET client_encoding = 'UTF8';

BEGIN;
SET search_path TO inventario;

INSERT INTO material (material_sku, material_nombre_material, material_descripcion, material_material_critico,
                      material_presentacion, material_presentacion_fecha_modificacion, material_stock_critico,
                      material_stock_maximo, material_stock_minimo, material_es_rotativo, material_estado,
                      material_categoria_general_id_categoria_general, material_categoria_funcional_id_categoria_funcional,
                      material_unidad_medida_id_unidad_medida, material_es_herramienta)
VALUES ('TOR-AUT', 'Tornillo autoperforante 8 x 1 pulgada', 'Fijación de refuerzos interiores (alto volumen de movimientos)',
        FALSE, 'Caja de 1.000 unidades', now(), 400, 20000, 1000, TRUE, 'activo', 1, 2, 4, FALSE);

INSERT INTO material_codigo_barras (material_sku, material_codigo_barras)
VALUES ('TOR-AUT', '2' || lpad(nextval('seq_codigo_barras_interno')::text, 11, '0'));

INSERT INTO material_proveedor (material_sku, proveedor_id_proveedor, material_proveedor_tiempo_reposicion,
                                material_proveedor_precio_referencial, material_proveedor_proveedor_principal,
                                material_proveedor_cantidad_minima)
VALUES ('TOR-AUT', 3, 2, 20, TRUE, 1000);

-- 15 compras: factura, lote, fecha de pedido y precio (k = 0 es la más antigua, hace 450 días)
INSERT INTO factura_compra (factura_compra_numero_factura, factura_compra_fecha_emision, proveedor_id_proveedor, factura_compra_tipo_compra)
SELECT 'F-FIS-TOR-' || lpad(k::text, 3, '0'), CURRENT_DATE - (450 - 30 * k), 3, 'nacional'
FROM generate_series(0, 14) AS k;

INSERT INTO lote (lote_numero_lote, lote_fecha_ingreso, lote_fecha_recepcion, lote_estado, proveedor_id_proveedor, factura_compra_id_factura)
SELECT 'LOTE-TOR-' || lpad(k::text, 3, '0'), CURRENT_DATE - (450 - 30 * k), CURRENT_DATE - (450 - 30 * k), 'activo', 3,
       (SELECT factura_compra_id_factura FROM factura_compra WHERE factura_compra_numero_factura = 'F-FIS-TOR-' || lpad(k::text, 3, '0'))
FROM generate_series(0, 14) AS k;

INSERT INTO lote_fecha_pedido (lote_fecha_pedido_fecha_pedido, lote_fecha_pedido_precio_unitario, lote_id_lote)
SELECT l.lote_fecha_ingreso - 3, 18 + (k / 5), l.lote_id_lote
FROM generate_series(0, 14) AS k
JOIN lote l ON l.lote_numero_lote = 'LOTE-TOR-' || lpad(k::text, 3, '0');

INSERT INTO historial_precio_material (material_sku, proveedor_id_proveedor, precio_unitario, moneda, fecha_vigencia_desde,
                                       fuente, factura_compra_id, usuario_id_usuario, created_at)
SELECT 'TOR-AUT', 3, 18 + (k / 5), 'CLP', l.lote_fecha_ingreso, 'factura', l.factura_compra_id_factura, 1, l.lote_fecha_ingreso + TIME '09:00'
FROM generate_series(0, 14) AS k
JOIN lote l ON l.lote_numero_lote = 'LOTE-TOR-' || lpad(k::text, 3, '0');

-- Entradas de compra (09:00 del día de recepción)
INSERT INTO movimiento_inventario (movimiento_inventario_fecha_hora, movimiento_inventario_cantidad, movimiento_inventario_estado,
                                   material_sku, bodega_id_bodega, lote_id_lote, factura_compra_id_factura_compra, usuario_id_usuario,
                                   movimiento_inventario_tipo_movimiento_id_tipo_movimiento,
                                   movimiento_inventario_motivo_movimiento_id_motivo_movimiento)
SELECT l.lote_fecha_ingreso + TIME '09:00', 2000, 'completado', 'TOR-AUT', 1, l.lote_id_lote, l.factura_compra_id_factura, 1, 1, 1
FROM generate_series(0, 14) AS k
JOIN lote l ON l.lote_numero_lote = 'LOTE-TOR-' || lpad(k::text, 3, '0')
ORDER BY k;

-- 10.200 salidas de 2 unidades, del día 449 al día 2 (sin lote, como las salidas manuales)
INSERT INTO movimiento_inventario (movimiento_inventario_fecha_hora, movimiento_inventario_cantidad, movimiento_inventario_estado,
                                   material_sku, bodega_id_bodega, usuario_id_usuario,
                                   movimiento_inventario_tipo_movimiento_id_tipo_movimiento,
                                   movimiento_inventario_motivo_movimiento_id_motivo_movimiento,
                                   movimiento_inventario_descripcion_motivo)
SELECT CURRENT_DATE - (449 - ((i - 1) * 448 / 10200)) + TIME '10:00' + make_interval(mins => (i * 37) % 420),
       2, 'completado', 'TOR-AUT', 1, CASE WHEN i % 5 = 0 THEN 1 ELSE 2 END, 2, 2,
       CASE i % 3 WHEN 0 THEN 'Consumo en armado' WHEN 1 THEN 'Consumo en producción' ELSE 'Entrega a cuadrilla' END
FROM generate_series(1, 10200) AS i
ORDER BY i;

-- Stock final por FIFO: lo que queda de cada lote después de 20.400 unidades consumidas
INSERT INTO inventario_bodega (material_sku, lote_id_lote, bodega_id_bodega, inventario_bodega_cantidad_fisica,
                               inventario_bodega_cantidad_reservada, anaquel_id_anaquel)
SELECT 'TOR-AUT', l.lote_id_lote, 1, LEAST(2000, GREATEST(0, 2000 * (k + 1) - 20400)), 0, 3
FROM generate_series(0, 14) AS k
JOIN lote l ON l.lote_numero_lote = 'LOTE-TOR-' || lpad(k::text, 3, '0');

COMMIT;
