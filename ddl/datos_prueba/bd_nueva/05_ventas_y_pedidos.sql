-- ============================================================
-- Datos de prueba (BD NUEVA) — 05 · Ventas (finanzas) y pedidos de instalación
-- Grupo 14 | Generado por generador/generar.js: NO editar a mano (regenerar).
--
-- Ventas NV-PRUEBA-01..22 en finanzas (excepción autorizada a la regla 7), con puertas (recetas) y
-- materiales sueltos (sku_material). Los pedidos de instalación están en cada estado de despacho y
-- las reservas cuadran con inventario_bodega de 04. Detalle de qué venta sirve para cada caso: README.md.
--
-- Orden de carga: ddl_inventario.sql, ddl_terreno.sql, ddl_finanzas.sql,
-- catalogos_inventario.sql y luego 01..06 de esta carpeta (ver README.md).
-- Las fechas son relativas al día de carga (CURRENT_DATE - n).
-- ============================================================

-- El archivo es UTF-8: sin esto, psql en Windows lo lee como WIN1252 y daña los acentos
SET client_encoding = 'UTF8';

BEGIN;

INSERT INTO finanzas.nota_venta (id_nota_venta, numero_nota_venta, id_cliente_financiero, id_proyecto_financiero, fecha_emision, fecha_max_entrega, tipo_nota_venta, estado_pedido, estado_pago, observacion)
OVERRIDING SYSTEM VALUE
VALUES
  (1, 'NV-PRUEBA-01', 1, 1, CURRENT_DATE - 20, CURRENT_DATE + 25, 'producto', 'aprobada', 'pendiente', 'DATOS DE PRUEBA — Inventario G14'),
  (2, 'NV-PRUEBA-02', 4, 4, CURRENT_DATE - 18, CURRENT_DATE + 30, 'producto', 'aprobada', 'pendiente', 'DATOS DE PRUEBA — Inventario G14'),
  (3, 'NV-PRUEBA-03', 2, 2, CURRENT_DATE - 16, CURRENT_DATE + 40, 'producto', 'aprobada', 'pendiente', 'DATOS DE PRUEBA — Inventario G14'),
  (4, 'NV-PRUEBA-04', 3, 3, CURRENT_DATE - 15, CURRENT_DATE + 15, 'producto', 'aprobada', 'pendiente', 'DATOS DE PRUEBA — Inventario G14'),
  (5, 'NV-PRUEBA-05', 1, 1, CURRENT_DATE - 14, CURRENT_DATE + 18, 'producto', 'aprobada', 'pendiente', 'DATOS DE PRUEBA — Inventario G14'),
  (6, 'NV-PRUEBA-06', 2, 2, CURRENT_DATE - 22, CURRENT_DATE + 10, 'producto', 'aprobada', 'pendiente', 'DATOS DE PRUEBA — Inventario G14'),
  (7, 'NV-PRUEBA-07', 4, 4, CURRENT_DATE - 24, CURRENT_DATE + 8, 'producto', 'aprobada', 'pendiente', 'DATOS DE PRUEBA — Inventario G14'),
  (8, 'NV-PRUEBA-08', 1, 1, CURRENT_DATE - 26, CURRENT_DATE + 7, 'producto', 'aprobada', 'pendiente', 'DATOS DE PRUEBA — Inventario G14'),
  (9, 'NV-PRUEBA-09', 2, 2, CURRENT_DATE - 28, CURRENT_DATE + 5, 'producto', 'aprobada', 'pendiente', 'DATOS DE PRUEBA — Inventario G14'),
  (10, 'NV-PRUEBA-10', 3, 3, CURRENT_DATE - 21, CURRENT_DATE + 9, 'producto', 'aprobada', 'pendiente', 'DATOS DE PRUEBA — Inventario G14'),
  (11, 'NV-PRUEBA-11', 1, 1, CURRENT_DATE - 35, CURRENT_DATE - 5, 'producto', 'aprobada', 'pendiente', 'DATOS DE PRUEBA — Inventario G14'),
  (12, 'NV-PRUEBA-12', 2, 2, CURRENT_DATE - 12, CURRENT_DATE + 20, 'producto', 'aprobada', 'pendiente', 'DATOS DE PRUEBA — Inventario G14'),
  (13, 'NV-PRUEBA-13', 3, 3, CURRENT_DATE - 11, CURRENT_DATE + 20, 'producto', 'aprobada', 'pendiente', 'DATOS DE PRUEBA — Inventario G14'),
  (14, 'NV-PRUEBA-14', 1, 1, CURRENT_DATE - 10, CURRENT_DATE + 35, 'producto', 'aprobada', 'pendiente', 'DATOS DE PRUEBA — Inventario G14'),
  (15, 'NV-PRUEBA-15', 4, 4, CURRENT_DATE - 9, CURRENT_DATE + 25, 'producto', 'pendiente', 'pendiente', 'DATOS DE PRUEBA — Inventario G14'),
  (16, 'NV-PRUEBA-16', 2, 2, CURRENT_DATE - 13, CURRENT_DATE + 12, 'producto', 'aprobada', 'pendiente', 'DATOS DE PRUEBA — Inventario G14'),
  (17, 'NV-PRUEBA-17', 3, 3, CURRENT_DATE - 19, CURRENT_DATE + 10, 'producto', 'cancelada', 'pendiente', 'DATOS DE PRUEBA — Inventario G14'),
  (18, 'NV-PRUEBA-18', 4, 4, CURRENT_DATE - 10, CURRENT_DATE + 25, 'producto', 'aprobada', 'pendiente', 'DATOS DE PRUEBA — Inventario G14'),
  (19, 'NV-PRUEBA-19', 2, 2, CURRENT_DATE - 5, CURRENT_DATE + 12, 'producto', 'aprobada', 'pendiente', 'DATOS DE PRUEBA — Inventario G14'),
  (20, 'NV-PRUEBA-20', 1, 1, CURRENT_DATE - 12, CURRENT_DATE + 30, 'producto', 'aprobada', 'pendiente', 'DATOS DE PRUEBA — Inventario G14'),
  (21, 'NV-PRUEBA-21', 3, 3, CURRENT_DATE - 8, CURRENT_DATE + 20, 'producto', 'cancelada', 'pendiente', 'DATOS DE PRUEBA — Inventario G14'),
  (22, 'NV-PRUEBA-22', 4, 4, CURRENT_DATE - 7, CURRENT_DATE + 14, 'producto', 'aprobada', 'pendiente', 'DATOS DE PRUEBA — Inventario G14');
INSERT INTO finanzas.item_nota_venta (id_item_nota_venta, id_nota_venta, id_producto_terminado, sku_material, descripcion_item, cantidad, precio_unitario, requiere_produccion, requiere_instalacion, estado_item)
OVERRIDING SYSTEM VALUE
VALUES
  (1, 1, 1, NULL, 'Puerta blindada estándar 90x200', 2, 1250000, TRUE, TRUE, 'pendiente'),
  (2, 1, NULL, NULL, 'Instalación de puerta blindada', 2, 180000, FALSE, FALSE, 'pendiente'),
  (3, 2, 4, NULL, 'Hoja de reposición (sin insumos de instalación)', 1, 690000, TRUE, TRUE, 'pendiente'),
  (4, 3, 2, NULL, 'Puerta blindada doble hoja 160x210', 10, 2100000, TRUE, TRUE, 'pendiente'),
  (5, 3, NULL, NULL, 'Instalación de puerta doble hoja', 10, 250000, FALSE, FALSE, 'pendiente'),
  (6, 4, 1, NULL, 'Puerta blindada estándar 90x200', 1, 1250000, TRUE, TRUE, 'pendiente'),
  (7, 5, 2, NULL, 'Puerta blindada doble hoja 160x210', 1, 2100000, TRUE, TRUE, 'pendiente'),
  (8, 6, 1, NULL, 'Puerta blindada estándar 90x200', 1, 1250000, TRUE, TRUE, 'pendiente'),
  (9, 7, 1, NULL, 'Puerta blindada estándar 90x200', 1, 1250000, TRUE, TRUE, 'pendiente'),
  (10, 8, 1, NULL, 'Puerta blindada estándar 90x200', 1, 1250000, TRUE, TRUE, 'pendiente'),
  (11, 9, 2, NULL, 'Puerta blindada doble hoja 160x210', 1, 2100000, TRUE, TRUE, 'pendiente'),
  (12, 10, 1, NULL, 'Puerta blindada estándar 90x200', 1, 1250000, TRUE, TRUE, 'pendiente'),
  (13, 11, 1, NULL, 'Puerta blindada estándar 90x200', 2, 1250000, TRUE, TRUE, 'pendiente'),
  (14, 11, NULL, NULL, 'Instalación de puerta blindada', 2, 180000, FALSE, FALSE, 'pendiente'),
  (15, 12, NULL, 'ACE-C16', 'Plancha acero galvanizado cal. 16', 5, 32000, FALSE, FALSE, 'pendiente'),
  (16, 12, NULL, 'MAD-PIN', 'Tabla pino radiata 1x6', 12, 5200, FALSE, FALSE, 'pendiente'),
  (17, 12, NULL, 'PIN-BLA', 'Pintura esmalte blanco', 4, 16500, FALSE, FALSE, 'pendiente'),
  (18, 13, NULL, 'MAT-INAC', 'Perfil de aluminio 30x30 (dado de baja)', 10, 7000, FALSE, FALSE, 'pendiente'),
  (19, 13, NULL, 'ELE-SOLD', 'Electrodo soldadura E6011 3/32', 3, 8900, FALSE, FALSE, 'pendiente'),
  (20, 14, NULL, 'ACE-C14', 'Plancha acero galvanizado cal. 14', 150, 36000, FALSE, FALSE, 'pendiente'),
  (21, 15, NULL, 'SIL-TRA', 'Sellador de silicona transparente 280 ml', 5, 3900, FALSE, FALSE, 'pendiente'),
  (22, 16, NULL, 'DIS-CORTE', 'Disco de corte metal 7 pulgadas', 10, 3100, FALSE, FALSE, 'pendiente'),
  (23, 16, NULL, 'BUR-GOM', 'Burlete de goma EPDM', 20, 1200, FALSE, FALSE, 'pendiente'),
  (24, 17, NULL, 'PIN-GRS', 'Pintura anticorrosiva gris RAL-7016', 6, 17500, FALSE, FALSE, 'pendiente'),
  (25, 18, NULL, 'CER-BIO', 'Cerradura biométrica importada', 2, 245000, FALSE, FALSE, 'pendiente'),
  (26, 18, 3, NULL, 'Puerta blindada con cerradura biométrica', 1, 1890000, TRUE, TRUE, 'pendiente'),
  (27, 19, NULL, 'CER-BIO', 'Cerradura biométrica importada', 2, 245000, FALSE, FALSE, 'pendiente'),
  (28, 20, NULL, 'VID-BLI', 'Visor blindado importado', 2, 129000, FALSE, FALSE, 'pendiente'),
  (29, 21, NULL, 'CER-BIO', 'Cerradura biométrica importada', 1, 245000, FALSE, FALSE, 'pendiente'),
  (30, 22, NULL, 'ELE-SOLD', 'Electrodo soldadura E6011 3/32', 2, 8900, FALSE, FALSE, 'pendiente');

INSERT INTO inventario.preparacion_pedido (preparacion_pedido_id_preparacion, preparacion_pedido_observacion, usuario_id_usuario, nota_venta_id_nota_venta, preparacion_pedido_fecha_creacion)
OVERRIDING SYSTEM VALUE
VALUES
  (1, 'Salida en camión de reparto, patente PR-UE-26.', 2, 11, CURRENT_DATE - 14 + TIME '10:00'),
  (2, NULL, 2, 9, CURRENT_DATE - 12 + TIME '10:00'),
  (3, NULL, 2, 8, CURRENT_DATE - 10 + TIME '11:00'),
  (4, NULL, 2, 7, CURRENT_DATE - 8 + TIME '11:00'),
  (5, NULL, 2, 6, CURRENT_DATE - 7 + TIME '10:00'),
  (6, NULL, 2, 10, CURRENT_DATE - 6 + TIME '10:00'),
  (7, NULL, 2, 5, CURRENT_DATE - 4 + TIME '10:30'),
  (8, NULL, 2, 4, CURRENT_DATE - 3 + TIME '11:00');
INSERT INTO inventario.preparacion_pedido_detalle (preparacion_pedido_detalle_id, preparacion_pedido_id_preparacion, material_sku, preparacion_pedido_detalle_cantidad_requerida, preparacion_pedido_detalle_origen, bodega_id_bodega, preparacion_pedido_detalle_cantidad_retirada, preparacion_pedido_detalle_fecha_retiro, usuario_id_retiro)
OVERRIDING SYSTEM VALUE
VALUES
  (1, 1, 'CER-MUL', 2, 'receta', 1, 2, CURRENT_DATE - 11 + TIME '10:30', 2),
  (2, 1, 'BIS-ACE', 6, 'receta', 1, 6, CURRENT_DATE - 11 + TIME '10:30', 2),
  (3, 1, 'MIR-PUE', 2, 'receta', 1, 2, CURRENT_DATE - 11 + TIME '10:30', 2),
  (4, 1, 'TAR-ANC', 20, 'receta', 1, 20, CURRENT_DATE - 11 + TIME '10:30', 2),
  (5, 1, 'ESP-POL', 2, 'receta', 1, 2, CURRENT_DATE - 11 + TIME '10:30', 2),
  (6, 1, 'SIL-TRA', 2, 'receta', 1, 2, CURRENT_DATE - 11 + TIME '10:30', 2),
  (7, 1, 'BUR-GOM', 12.1, 'receta', 1, 12.1, CURRENT_DATE - 11 + TIME '10:30', 2),
  (8, 2, 'CER-MUL', 2, 'receta', 1, 2, CURRENT_DATE - 8 + TIME '10:00', 2),
  (9, 2, 'BIS-ACE', 6, 'receta', 1, 6, CURRENT_DATE - 8 + TIME '10:00', 2),
  (10, 2, 'MIR-PUE', 1, 'receta', 1, 1, CURRENT_DATE - 8 + TIME '10:00', 2),
  (11, 2, 'TAR-ANC', 15, 'receta', 1, 15, CURRENT_DATE - 8 + TIME '10:00', 2),
  (12, 2, 'ESP-POL', 2, 'receta', 1, 2, CURRENT_DATE - 8 + TIME '10:00', 2),
  (13, 2, 'SIL-TRA', 2, 'receta', 1, 2, CURRENT_DATE - 8 + TIME '10:00', 2),
  (14, 2, 'BUR-GOM', 9.9, 'receta', 1, 9.9, CURRENT_DATE - 8 + TIME '10:00', 2),
  (15, 3, 'CER-MUL', 1, 'receta', 1, 1, CURRENT_DATE - 7 + TIME '11:00', 2),
  (16, 3, 'BIS-ACE', 3, 'receta', 1, 3, CURRENT_DATE - 7 + TIME '11:00', 2),
  (17, 3, 'MIR-PUE', 1, 'receta', 1, 1, CURRENT_DATE - 7 + TIME '11:00', 2),
  (18, 3, 'TAR-ANC', 10, 'receta', 1, 10, CURRENT_DATE - 7 + TIME '11:00', 2),
  (19, 3, 'ESP-POL', 1, 'receta', 1, 1, CURRENT_DATE - 7 + TIME '11:00', 2),
  (20, 3, 'SIL-TRA', 1, 'receta', 1, 1, CURRENT_DATE - 7 + TIME '11:00', 2),
  (21, 3, 'BUR-GOM', 6.05, 'receta', 1, 6.05, CURRENT_DATE - 7 + TIME '11:00', 2),
  (22, 4, 'CER-MUL', 1, 'receta', 1, 1, CURRENT_DATE - 5 + TIME '10:00', 2),
  (23, 4, 'BIS-ACE', 3, 'receta', 1, 3, CURRENT_DATE - 5 + TIME '11:00', 2),
  (24, 4, 'MIR-PUE', 1, 'receta', 1, 1, CURRENT_DATE - 5 + TIME '11:00', 2),
  (25, 4, 'TAR-ANC', 10, 'receta', 1, 6, CURRENT_DATE - 5 + TIME '11:20', 2),
  (26, 4, 'ESP-POL', 1, 'receta', 1, 1, CURRENT_DATE - 5 + TIME '11:00', 2),
  (27, 4, 'SIL-TRA', 1, 'receta', 1, 1, CURRENT_DATE - 5 + TIME '11:00', 2),
  (28, 4, 'BUR-GOM', 6.05, 'receta', 1, 6.05, CURRENT_DATE - 5 + TIME '11:00', 2),
  (29, 5, 'CER-MUL', 1, 'receta', 1, NULL, NULL, NULL),
  (30, 5, 'BIS-ACE', 3, 'receta', 1, NULL, NULL, NULL),
  (31, 5, 'MIR-PUE', 1, 'receta', 1, NULL, NULL, NULL),
  (32, 5, 'TAR-ANC', 10, 'receta', 1, NULL, NULL, NULL),
  (33, 5, 'ESP-POL', 1, 'receta', 1, NULL, NULL, NULL),
  (34, 5, 'SIL-TRA', 1, 'receta', 1, NULL, NULL, NULL),
  (35, 5, 'BUR-GOM', 6.05, 'receta', 1, NULL, NULL, NULL),
  (36, 6, 'CER-MUL', 1, 'receta', 1, 1, CURRENT_DATE - 4 + TIME '10:00', 2),
  (37, 6, 'BIS-ACE', 3, 'receta', 1, 3, CURRENT_DATE - 4 + TIME '10:00', 2),
  (38, 6, 'MIR-PUE', 1, 'receta', 1, 1, CURRENT_DATE - 4 + TIME '10:00', 2),
  (39, 6, 'TAR-ANC', 10, 'receta', 1, 10, CURRENT_DATE - 4 + TIME '10:00', 2),
  (40, 6, 'ESP-POL', 1, 'receta', 1, 1, CURRENT_DATE - 4 + TIME '10:00', 2),
  (41, 6, 'SIL-TRA', 1, 'receta', 1, 1, CURRENT_DATE - 4 + TIME '10:00', 2),
  (42, 6, 'BUR-GOM', 6.05, 'receta', 1, 6.05, CURRENT_DATE - 4 + TIME '10:00', 2),
  (43, 7, 'CER-MUL', 2, 'receta', 1, NULL, NULL, NULL),
  (44, 7, 'BIS-ACE', 6, 'receta', 1, NULL, NULL, NULL),
  (45, 7, 'MIR-PUE', 1, 'receta', 1, NULL, NULL, NULL),
  (46, 7, 'TAR-ANC', 15, 'receta', 1, NULL, NULL, NULL),
  (47, 7, 'ESP-POL', 2, 'receta', 1, NULL, NULL, NULL),
  (48, 7, 'SIL-TRA', 2, 'receta', 1, NULL, NULL, NULL),
  (49, 7, 'BUR-GOM', 9.9, 'receta', 1, NULL, NULL, NULL),
  (50, 8, 'CER-MUL', 1, 'receta', 1, NULL, NULL, NULL),
  (51, 8, 'BIS-ACE', 3, 'receta', 1, NULL, NULL, NULL),
  (52, 8, 'MIR-PUE', 1, 'receta', 1, NULL, NULL, NULL),
  (53, 8, 'TAR-ANC', 10, 'receta', 1, NULL, NULL, NULL),
  (54, 8, 'ESP-POL', 1, 'receta', 1, NULL, NULL, NULL),
  (55, 8, 'SIL-TRA', 1, 'receta', 1, NULL, NULL, NULL),
  (56, 8, 'BUR-GOM', 6.05, 'receta', 1, NULL, NULL, NULL);
INSERT INTO inventario.preparacion_pedido_estado (preparacion_pedido_estado_id_estado_preparacion, preparacion_pedido_estado_nombre_estado, preparacion_pedido_estado_timestamp_accion, preparacion_pedido_id_preparacion, usuario_id_usuario, empleado_rut)
OVERRIDING SYSTEM VALUE
VALUES
  (1, 'vinculado', CURRENT_DATE - 14 + TIME '10:00', 1, 2, NULL),
  (2, 'vinculado', CURRENT_DATE - 12 + TIME '10:00', 2, 2, NULL),
  (3, 'preparado', CURRENT_DATE - 12 + TIME '15:00', 1, 2, NULL),
  (4, 'en_carga', CURRENT_DATE - 10 + TIME '09:00', 1, 2, '17333444-3'),
  (5, 'en_carga', CURRENT_DATE - 10 + TIME '09:20', 1, 2, '18444555-7'),
  (6, 'vinculado', CURRENT_DATE - 10 + TIME '11:00', 3, 2, NULL),
  (7, 'en_transito', CURRENT_DATE - 9 + TIME '08:45', 1, 1, NULL),
  (8, 'preparado', CURRENT_DATE - 9 + TIME '15:00', 2, 2, NULL),
  (9, 'vinculado', CURRENT_DATE - 8 + TIME '11:00', 4, 2, NULL),
  (10, 'preparado', CURRENT_DATE - 8 + TIME '16:00', 3, 2, NULL),
  (11, 'en_carga', CURRENT_DATE - 7 + TIME '09:15', 2, 2, '15111222-6'),
  (12, 'vinculado', CURRENT_DATE - 7 + TIME '10:00', 5, 2, NULL),
  (13, 'preparado', CURRENT_DATE - 7 + TIME '16:00', 4, 2, NULL),
  (14, 'vinculado', CURRENT_DATE - 6 + TIME '10:00', 6, 2, NULL),
  (15, 'preparado', CURRENT_DATE - 6 + TIME '16:00', 5, 2, NULL),
  (16, 'preparado', CURRENT_DATE - 5 + TIME '15:00', 6, 2, NULL),
  (17, 'vinculado', CURRENT_DATE - 4 + TIME '10:30', 7, 2, NULL),
  (18, 'vinculado', CURRENT_DATE - 3 + TIME '11:00', 8, 2, NULL);

INSERT INTO inventario.reserva_inventario (reserva_inventario_id_reserva, reserva_inventario_cantidad_reservada, reserva_inventario_fecha_reserva, reserva_inventario_fecha_liberacion, reserva_inventario_estado_reserva, material_sku, nota_venta_id_nota_venta, lote_id_lote, bodega_id_bodega, preparacion_pedido_detalle_id, usuario_id_usuario, usuario_id_liberacion, reserva_inventario_motivo_liberacion)
OVERRIDING SYSTEM VALUE
VALUES
  (1, 6, CURRENT_DATE - 15 + TIME '10:00', CURRENT_DATE - 8 + TIME '12:00', 'anulada', 'PIN-GRS', 17, 158, 2, NULL, 2, 1, 'Venta cancelada por el cliente'),
  (2, 2, CURRENT_DATE - 14 + TIME '10:00', CURRENT_DATE - 9 + TIME '08:45', 'liberada', 'CER-MUL', 11, 151, 1, 1, NULL, NULL, NULL),
  (3, 6, CURRENT_DATE - 14 + TIME '10:00', CURRENT_DATE - 9 + TIME '08:45', 'liberada', 'BIS-ACE', 11, 138, 1, 2, NULL, NULL, NULL),
  (4, 2, CURRENT_DATE - 14 + TIME '10:00', CURRENT_DATE - 9 + TIME '08:45', 'liberada', 'MIR-PUE', 11, 145, 1, 3, NULL, NULL, NULL),
  (5, 20, CURRENT_DATE - 14 + TIME '10:00', CURRENT_DATE - 9 + TIME '08:45', 'liberada', 'TAR-ANC', 11, 155, 1, 4, NULL, NULL, NULL),
  (6, 2, CURRENT_DATE - 14 + TIME '10:00', CURRENT_DATE - 9 + TIME '08:45', 'liberada', 'ESP-POL', 11, 147, 1, 5, NULL, NULL, NULL),
  (7, 2, CURRENT_DATE - 14 + TIME '10:00', CURRENT_DATE - 9 + TIME '08:45', 'liberada', 'SIL-TRA', 11, 162, 1, 6, NULL, NULL, NULL),
  (8, 12.1, CURRENT_DATE - 14 + TIME '10:00', CURRENT_DATE - 9 + TIME '08:45', 'liberada', 'BUR-GOM', 11, 152, 1, 7, NULL, NULL, NULL),
  (9, 2, CURRENT_DATE - 12 + TIME '10:00', NULL, 'activa', 'CER-MUL', 9, 151, 1, 8, NULL, NULL, NULL),
  (10, 6, CURRENT_DATE - 12 + TIME '10:00', NULL, 'activa', 'BIS-ACE', 9, 138, 1, 9, NULL, NULL, NULL),
  (11, 1, CURRENT_DATE - 12 + TIME '10:00', NULL, 'activa', 'MIR-PUE', 9, 145, 1, 10, NULL, NULL, NULL),
  (12, 15, CURRENT_DATE - 12 + TIME '10:00', NULL, 'activa', 'TAR-ANC', 9, 155, 1, 11, NULL, NULL, NULL),
  (13, 2, CURRENT_DATE - 12 + TIME '10:00', NULL, 'activa', 'ESP-POL', 9, 147, 1, 12, NULL, NULL, NULL),
  (14, 2, CURRENT_DATE - 12 + TIME '10:00', NULL, 'activa', 'SIL-TRA', 9, 167, 1, 13, NULL, NULL, NULL),
  (15, 9.9, CURRENT_DATE - 12 + TIME '10:00', NULL, 'activa', 'BUR-GOM', 9, 152, 1, 14, NULL, NULL, NULL),
  (16, 1, CURRENT_DATE - 10 + TIME '11:00', NULL, 'activa', 'CER-MUL', 8, 151, 1, 15, NULL, NULL, NULL),
  (17, 3, CURRENT_DATE - 10 + TIME '11:00', NULL, 'activa', 'BIS-ACE', 8, 138, 1, 16, NULL, NULL, NULL),
  (18, 1, CURRENT_DATE - 10 + TIME '11:00', NULL, 'activa', 'MIR-PUE', 8, 145, 1, 17, NULL, NULL, NULL),
  (19, 10, CURRENT_DATE - 10 + TIME '11:00', NULL, 'activa', 'TAR-ANC', 8, 155, 1, 18, NULL, NULL, NULL),
  (20, 1, CURRENT_DATE - 10 + TIME '11:00', NULL, 'activa', 'ESP-POL', 8, 147, 1, 19, NULL, NULL, NULL),
  (21, 1, CURRENT_DATE - 10 + TIME '11:00', NULL, 'activa', 'SIL-TRA', 8, 167, 1, 20, NULL, NULL, NULL),
  (22, 6.05, CURRENT_DATE - 10 + TIME '11:00', NULL, 'activa', 'BUR-GOM', 8, 152, 1, 21, NULL, NULL, NULL),
  (23, 1, CURRENT_DATE - 8 + TIME '11:00', NULL, 'activa', 'CER-MUL', 7, 163, 1, 22, NULL, NULL, NULL),
  (24, 3, CURRENT_DATE - 8 + TIME '11:00', NULL, 'activa', 'BIS-ACE', 7, 138, 1, 23, NULL, NULL, NULL),
  (25, 1, CURRENT_DATE - 8 + TIME '11:00', NULL, 'activa', 'MIR-PUE', 7, 145, 1, 24, NULL, NULL, NULL),
  (26, 10, CURRENT_DATE - 8 + TIME '11:00', NULL, 'activa', 'TAR-ANC', 7, 155, 1, 25, NULL, NULL, NULL),
  (27, 1, CURRENT_DATE - 8 + TIME '11:00', NULL, 'activa', 'ESP-POL', 7, 147, 1, 26, NULL, NULL, NULL),
  (28, 1, CURRENT_DATE - 8 + TIME '11:00', NULL, 'activa', 'SIL-TRA', 7, 167, 1, 27, NULL, NULL, NULL),
  (29, 6.05, CURRENT_DATE - 8 + TIME '11:00', NULL, 'activa', 'BUR-GOM', 7, 152, 1, 28, NULL, NULL, NULL),
  (30, 1, CURRENT_DATE - 7 + TIME '10:00', NULL, 'activa', 'CER-MUL', 6, 163, 1, 29, NULL, NULL, NULL),
  (31, 3, CURRENT_DATE - 7 + TIME '10:00', NULL, 'activa', 'BIS-ACE', 6, 138, 1, 30, NULL, NULL, NULL),
  (32, 1, CURRENT_DATE - 7 + TIME '10:00', NULL, 'activa', 'MIR-PUE', 6, 145, 1, 31, NULL, NULL, NULL),
  (33, 10, CURRENT_DATE - 7 + TIME '10:00', NULL, 'activa', 'TAR-ANC', 6, 155, 1, 32, NULL, NULL, NULL),
  (34, 1, CURRENT_DATE - 7 + TIME '10:00', NULL, 'activa', 'ESP-POL', 6, 147, 1, 33, NULL, NULL, NULL),
  (35, 1, CURRENT_DATE - 7 + TIME '10:00', NULL, 'activa', 'SIL-TRA', 6, 167, 1, 34, NULL, NULL, NULL),
  (36, 6.05, CURRENT_DATE - 7 + TIME '10:00', NULL, 'activa', 'BUR-GOM', 6, 152, 1, 35, NULL, NULL, NULL),
  (37, 1, CURRENT_DATE - 6 + TIME '10:00', NULL, 'activa', 'CER-MUL', 10, 163, 1, 36, NULL, NULL, NULL),
  (38, 3, CURRENT_DATE - 6 + TIME '10:00', NULL, 'activa', 'BIS-ACE', 10, 138, 1, 37, NULL, NULL, NULL),
  (39, 1, CURRENT_DATE - 6 + TIME '10:00', NULL, 'activa', 'MIR-PUE', 10, 145, 1, 38, NULL, NULL, NULL),
  (40, 10, CURRENT_DATE - 6 + TIME '10:00', NULL, 'activa', 'TAR-ANC', 10, 155, 1, 39, NULL, NULL, NULL),
  (41, 1, CURRENT_DATE - 6 + TIME '10:00', NULL, 'activa', 'ESP-POL', 10, 147, 1, 40, NULL, NULL, NULL),
  (42, 1, CURRENT_DATE - 6 + TIME '10:00', NULL, 'activa', 'SIL-TRA', 10, 167, 1, 41, NULL, NULL, NULL),
  (43, 6.05, CURRENT_DATE - 6 + TIME '10:00', NULL, 'activa', 'BUR-GOM', 10, 152, 1, 42, NULL, NULL, NULL),
  (44, 4, CURRENT_DATE - 5 + TIME '10:30', NULL, 'activa', 'DIS-CORTE', 16, 157, 1, NULL, 1, NULL, NULL),
  (45, 6, CURRENT_DATE - 5 + TIME '10:30', NULL, 'activa', 'DIS-CORTE', 16, 177, 1, NULL, 1, NULL, NULL),
  (46, 0.8, CURRENT_DATE - 5 + TIME '10:30', NULL, 'activa', 'BUR-GOM', 16, 152, 1, NULL, 1, NULL, NULL),
  (47, 19.2, CURRENT_DATE - 5 + TIME '10:30', NULL, 'activa', 'BUR-GOM', 16, 152, 3, NULL, 1, NULL, NULL),
  (48, 2, CURRENT_DATE - 4 + TIME '10:30', NULL, 'activa', 'CER-MUL', 5, 163, 1, 43, NULL, NULL, NULL),
  (49, 1, CURRENT_DATE - 4 + TIME '10:30', NULL, 'activa', 'BIS-ACE', 5, 138, 1, 44, NULL, NULL, NULL),
  (50, 2, CURRENT_DATE - 4 + TIME '10:30', NULL, 'activa', 'BIS-ACE', 5, 160, 1, 44, NULL, NULL, NULL),
  (51, 3, CURRENT_DATE - 4 + TIME '10:30', NULL, 'activa', 'BIS-ACE', 5, 164, 1, 44, NULL, NULL, NULL),
  (52, 15, CURRENT_DATE - 4 + TIME '10:30', NULL, 'activa', 'TAR-ANC', 5, 13, 1, 46, NULL, NULL, NULL),
  (53, 2, CURRENT_DATE - 4 + TIME '10:30', NULL, 'activa', 'ESP-POL', 5, 147, 1, 47, NULL, NULL, NULL),
  (54, 2, CURRENT_DATE - 4 + TIME '10:30', NULL, 'activa', 'SIL-TRA', 5, 167, 1, 48, NULL, NULL, NULL),
  (55, 9.9, CURRENT_DATE - 4 + TIME '10:30', NULL, 'activa', 'BUR-GOM', 5, 168, 1, 49, NULL, NULL, NULL),
  (56, 2, CURRENT_DATE - 4 + TIME '12:00', NULL, 'activa', 'ELE-SOLD', 22, 149, 1, NULL, 2, NULL, NULL),
  (57, 1, CURRENT_DATE - 3 + TIME '11:00', NULL, 'activa', 'CER-MUL', 4, 163, 1, 50, NULL, NULL, NULL),
  (58, 3, CURRENT_DATE - 3 + TIME '11:00', NULL, 'activa', 'BIS-ACE', 4, 164, 1, 51, NULL, NULL, NULL),
  (59, 1, CURRENT_DATE - 3 + TIME '11:00', NULL, 'activa', 'MIR-PUE', 4, 179, 1, 52, NULL, NULL, NULL),
  (60, 1, CURRENT_DATE - 3 + TIME '11:00', NULL, 'activa', 'TAR-ANC', 4, 13, 1, 53, NULL, NULL, NULL),
  (61, 9, CURRENT_DATE - 3 + TIME '11:00', NULL, 'activa', 'TAR-ANC', 4, 155, 1, 53, NULL, NULL, NULL),
  (62, 1, CURRENT_DATE - 3 + TIME '11:00', NULL, 'activa', 'ESP-POL', 4, 147, 1, 54, NULL, NULL, NULL),
  (63, 1, CURRENT_DATE - 3 + TIME '11:00', NULL, 'activa', 'SIL-TRA', 4, 167, 1, 55, NULL, NULL, NULL),
  (64, 6.05, CURRENT_DATE - 3 + TIME '11:00', NULL, 'activa', 'BUR-GOM', 4, 168, 1, 56, NULL, NULL, NULL);

SELECT setval(pg_get_serial_sequence('finanzas.nota_venta', 'id_nota_venta'), (SELECT MAX(id_nota_venta) FROM finanzas.nota_venta));
SELECT setval(pg_get_serial_sequence('finanzas.item_nota_venta', 'id_item_nota_venta'), (SELECT MAX(id_item_nota_venta) FROM finanzas.item_nota_venta));
SELECT setval(pg_get_serial_sequence('inventario.preparacion_pedido', 'preparacion_pedido_id_preparacion'), (SELECT MAX(preparacion_pedido_id_preparacion) FROM inventario.preparacion_pedido));
SELECT setval(pg_get_serial_sequence('inventario.preparacion_pedido_detalle', 'preparacion_pedido_detalle_id'), (SELECT MAX(preparacion_pedido_detalle_id) FROM inventario.preparacion_pedido_detalle));
SELECT setval(pg_get_serial_sequence('inventario.preparacion_pedido_estado', 'preparacion_pedido_estado_id_estado_preparacion'), (SELECT MAX(preparacion_pedido_estado_id_estado_preparacion) FROM inventario.preparacion_pedido_estado));
SELECT setval(pg_get_serial_sequence('inventario.reserva_inventario', 'reserva_inventario_id_reserva'), (SELECT MAX(reserva_inventario_id_reserva) FROM inventario.reserva_inventario));

COMMIT;
