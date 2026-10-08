-- ============================================================
-- Datos de prueba (BD NUEVA) — 06 · Operación: órdenes de trabajo, conteos y alertas
-- Grupo 14 | Generado por generador/generar.js: NO editar a mano (regenerar).
--
-- OT abiertas, finalizadas sin procesar y procesadas con sus diferenciales (CU-103, CU-104).
-- Conteos: uno antiguo procesado, uno de la Obra Norte procesado con alerta activa, y dos confirmados
-- sin procesar (Obra Norte con diferencias, Planta conforme). Historial de alertas para CU-55.
--
-- Orden de carga: ddl_inventario.sql, ddl_terreno.sql, ddl_finanzas.sql,
-- catalogos_inventario.sql y luego 01..06 de esta carpeta (ver README.md).
-- Las fechas son relativas al día de carga (CURRENT_DATE - n).
-- ============================================================

-- El archivo es UTF-8: sin esto, psql en Windows lo lee como WIN1252 y daña los acentos
SET client_encoding = 'UTF8';

BEGIN;

INSERT INTO inventario.orden_trabajo (orden_trabajo_id_orden, orden_trabajo_fecha_hora, orden_trabajo_estado, especificaciones_puerta_id_especificacion_puerta, proyecto_id_proyecto, area_trabajo_id_area, usuario_id_usuario, producto_terminado_id_producto, orden_trabajo_cantidad_puertas)
OVERRIDING SYSTEM VALUE
VALUES
  (1, CURRENT_DATE - 60 + TIME '08:30', 'finalizada', 1, 1, 1, 2, 1, 4),
  (2, CURRENT_DATE - 58 + TIME '08:30', 'finalizada', 1, 1, 2, 2, 1, 4),
  (3, CURRENT_DATE - 56 + TIME '08:30', 'finalizada', 1, 1, 3, 2, 1, 4),
  (4, CURRENT_DATE - 35 + TIME '08:30', 'finalizada', 2, 2, 1, 2, 2, 2),
  (5, CURRENT_DATE - 33 + TIME '08:30', 'finalizada', 2, 2, 2, 2, 2, 2),
  (6, CURRENT_DATE - 20 + TIME '08:30', 'finalizada', 1, 3, 1, 2, 1, 3),
  (7, CURRENT_DATE - 15 + TIME '08:30', 'finalizada', 1, 3, 3, 2, 1, 2),
  (8, CURRENT_DATE - 12 + TIME '08:30', 'finalizada', 1, 3, 2, 2, 1, 2),
  (9, CURRENT_DATE - 3 + TIME '08:30', 'en_curso', 2, 4, 1, 2, 2, 1),
  (10, CURRENT_DATE - 2 + TIME '08:30', 'en_curso', 1, 4, 2, 2, 1, 2);
INSERT INTO inventario.material_orden_trabajo (material_sku, orden_trabajo_id_orden, material_orden_trabajo_consumo_estimado, material_orden_trabajo_consumo_real)
VALUES
  ('ACE-C14', 1, 8.8, 10),
  ('TUB-4040', 1, 25.2, 24),
  ('PIN-GRS', 2, 5.28, 6.1),
  ('PIN-BLA', 2, 4.4, 4.4),
  ('ELE-SOLD', 3, 2.2, 3),
  ('DIS-CORTE', 3, 4, 4),
  ('ACE-C14', 4, 8.8, 9),
  ('TUB-4040', 4, 21, 23),
  ('DIS-CORTE', 4, 0, 2),
  ('PIN-GRS', 5, 4.84, 4.5),
  ('PIN-BLA', 5, 3.96, 4.2),
  ('ACE-C14', 6, 6.6, 7),
  ('TUB-4040', 6, 18.9, 20),
  ('ELE-SOLD', 7, 1.1, NULL),
  ('DIS-CORTE', 7, 2, NULL),
  ('PIN-GRS', 8, 2.64, 2.8),
  ('PIN-BLA', 8, 0, 1),
  ('ACE-C14', 9, 4.4, 4),
  ('TUB-4040', 9, 10.5, NULL),
  ('PIN-GRS', 10, 2.64, NULL),
  ('PIN-BLA', 10, 2.2, NULL);
INSERT INTO inventario.diferencial_consumo (diferencial_consumo_id, orden_trabajo_id_orden, material_sku, diferencial_consumo_fecha, diferencial_consumo_estimado, diferencial_consumo_real, diferencial_consumo_desviacion_abs, diferencial_consumo_desviacion_pct, diferencial_consumo_tipo, diferencial_consumo_impacto_clp, usuario_id_usuario)
OVERRIDING SYSTEM VALUE
VALUES
  (1, 1, 'ACE-C14', CURRENT_DATE - 55 + TIME '11:00', 8.8, 10, 1.2, 13.64, 'sobre_gasto', 38712, 1),
  (2, 1, 'TUB-4040', CURRENT_DATE - 55 + TIME '11:00', 25.2, 24, -1.2, -4.76, 'ahorro', -11772, 1),
  (3, 2, 'PIN-GRS', CURRENT_DATE - 53 + TIME '11:00', 5.28, 6.1, 0.82, 15.53, 'sobre_gasto', 13480.8, 1),
  (4, 2, 'PIN-BLA', CURRENT_DATE - 53 + TIME '11:00', 4.4, 4.4, 0, 0, 'sin_desviacion', 0, 1),
  (5, 3, 'ELE-SOLD', CURRENT_DATE - 52 + TIME '11:00', 2.2, 3, 0.8, 36.36, 'sobre_gasto', 6056, 1),
  (6, 3, 'DIS-CORTE', CURRENT_DATE - 52 + TIME '11:00', 4, 4, 0, 0, 'sin_desviacion', 0, 1),
  (7, 4, 'ACE-C14', CURRENT_DATE - 30 + TIME '11:00', 8.8, 9, 0.2, 2.27, 'sobre_gasto', 6542, 1),
  (8, 4, 'TUB-4040', CURRENT_DATE - 30 + TIME '11:00', 21, 23, 2, 9.52, 'sobre_gasto', 19820, 1),
  (9, 4, 'DIS-CORTE', CURRENT_DATE - 30 + TIME '11:00', 0, 2, 2, NULL, 'sin_base', 4980, 1),
  (10, 5, 'PIN-GRS', CURRENT_DATE - 29 + TIME '11:00', 4.84, 4.5, -0.34, -7.02, 'ahorro', -5623.6, 1),
  (11, 5, 'PIN-BLA', CURRENT_DATE - 29 + TIME '11:00', 3.96, 4.2, 0.24, 6.06, 'sobre_gasto', 3734.4, 1);

INSERT INTO inventario.conteo_ciclico (conteo_ciclico_id_conteo, conteo_ciclico_fecha_hora, conteo_ciclico_estado, conteo_ciclico_fecha_confirmacion, conteo_ciclico_fecha_procesamiento, conteo_ciclico_resultado, bodega_id_bodega, usuario_id_usuario, usuario_procesa_id)
OVERRIDING SYSTEM VALUE
VALUES
  (1, CURRENT_DATE - 90 + TIME '16:30', 'procesado', CURRENT_DATE - 90 + TIME '16:30', CURRENT_DATE - 88 + TIME '10:00', 'con_diferencias', 1, 2, 1),
  (2, CURRENT_DATE - 10 + TIME '16:00', 'procesado', CURRENT_DATE - 10 + TIME '16:00', CURRENT_DATE - 9 + TIME '09:00', 'con_diferencias', 3, 2, 1),
  (3, CURRENT_DATE - 2 + TIME '16:00', 'confirmado', CURRENT_DATE - 2 + TIME '16:00', NULL, NULL, 3, 2, NULL),
  (4, CURRENT_DATE - 1 + TIME '11:00', 'confirmado', CURRENT_DATE - 1 + TIME '11:00', NULL, NULL, 2, 2, NULL);
INSERT INTO inventario.conteo_ciclico_detalle (conteo_ciclico_id_conteo, material_sku, conteo_ciclico_detalle_cantidad_contada, conteo_ciclico_detalle_stock_teorico, conteo_ciclico_detalle_no_esperado)
VALUES
  (1, 'ADH-EPO', NULL, 12, FALSE),
  (1, 'BIS-ACE', NULL, 21, FALSE),
  (1, 'BUR-GOM', 98.5, 99, FALSE),
  (1, 'CER-BIO', NULL, 0, FALSE),
  (1, 'CER-MUL', NULL, 9, FALSE),
  (1, 'DIS-CORTE', 61, 59, FALSE),
  (1, 'ELE-SOLD', NULL, 2.5, FALSE),
  (1, 'HER-ESM', NULL, 4, FALSE),
  (1, 'ESP-POL', NULL, 20, FALSE),
  (1, 'LIJ-120', NULL, 27, FALSE),
  (1, 'MIR-PUE', NULL, 10, FALSE),
  (1, 'MAT-INAC', NULL, 0, FALSE),
  (1, 'ACE-C14', 51, 52, FALSE),
  (1, 'ACE-C16', NULL, 28, FALSE),
  (1, 'SIL-TRA', 12, 12, FALSE),
  (1, 'HER-TAL', NULL, 3, FALSE),
  (1, 'TAR-ANC', 592, 592, FALSE),
  (1, 'TUB-4040', NULL, 100, FALSE),
  (1, 'VID-BLI', NULL, 0, FALSE),
  (2, 'BUR-GOM', 50, 50, FALSE),
  (2, 'CER-MUL', 4, 4, FALSE),
  (2, 'ESP-POL', 12, 12, FALSE),
  (2, 'SIL-TRA', 24, 24, FALSE),
  (2, 'TAR-ANC', 94, 100, FALSE),
  (3, 'BUR-GOM', 49.5, 50, FALSE),
  (3, 'CER-MUL', 3, 4, FALSE),
  (3, 'ESP-POL', 12, 12, FALSE),
  (3, 'SIL-TRA', NULL, 24, FALSE),
  (3, 'TAR-ANC', 92, 100, FALSE),
  (4, 'BIS-ACE', 3, 3, FALSE),
  (4, 'PIN-GRS', 30, 30, FALSE),
  (4, 'PIN-BLA', 24.5, 25, FALSE),
  (4, 'MAD-PIN', 118, 120, FALSE);
INSERT INTO inventario.diferencia_inventario (diferencia_inventario_id, conteo_ciclico_id_conteo, material_sku, diferencia_inventario_stock_teorico, diferencia_inventario_cantidad_contada, diferencia_inventario_diferencia, diferencia_inventario_diferencia_pct, diferencia_inventario_clasificacion, diferencia_inventario_supera_tolerancia, diferencia_inventario_fecha, usuario_id_usuario, diferencia_inventario_tolerancia_pct, diferencia_inventario_umbral_critico_pct)
OVERRIDING SYSTEM VALUE
VALUES
  (1, 1, 'BUR-GOM', 99, 98.5, -0.5, -0.51, 'faltante', FALSE, CURRENT_DATE - 88 + TIME '10:00', 1, 5, 20),
  (2, 1, 'DIS-CORTE', 59, 61, 2, 3.39, 'sobrante', FALSE, CURRENT_DATE - 88 + TIME '10:00', 1, 5, 20),
  (3, 1, 'ACE-C14', 52, 51, -1, -1.92, 'faltante', TRUE, CURRENT_DATE - 88 + TIME '10:00', 1, 1, 5),
  (4, 1, 'SIL-TRA', 12, 12, 0, 0, 'sin_diferencia', FALSE, CURRENT_DATE - 88 + TIME '10:00', 1, 5, 20),
  (5, 1, 'TAR-ANC', 592, 592, 0, 0, 'sin_diferencia', FALSE, CURRENT_DATE - 88 + TIME '10:00', 1, 5, 20),
  (6, 2, 'BUR-GOM', 50, 50, 0, 0, 'sin_diferencia', FALSE, CURRENT_DATE - 9 + TIME '09:00', 1, 5, 20),
  (7, 2, 'CER-MUL', 4, 4, 0, 0, 'sin_diferencia', FALSE, CURRENT_DATE - 9 + TIME '09:00', 1, 1, 5),
  (8, 2, 'ESP-POL', 12, 12, 0, 0, 'sin_diferencia', FALSE, CURRENT_DATE - 9 + TIME '09:00', 1, 5, 20),
  (9, 2, 'SIL-TRA', 24, 24, 0, 0, 'sin_diferencia', FALSE, CURRENT_DATE - 9 + TIME '09:00', 1, 5, 20),
  (10, 2, 'TAR-ANC', 100, 94, -6, -6, 'faltante', TRUE, CURRENT_DATE - 9 + TIME '09:00', 1, 5, 20);

-- Alertas: historial (CU-55), las de los conteos, las del retiro de NV-PRUEBA-07 y las de stock vigentes
INSERT INTO inventario.historial_alerta (historial_alerta_id_historial, historial_alerta_fecha_hora_resolucion, usuario_id_usuario)
OVERRIDING SYSTEM VALUE
VALUES
  (1, CURRENT_DATE - 85 + TIME '12:00', 1),
  (2, NULL, NULL),
  (3, NULL, NULL),
  (4, NULL, NULL),
  (5, CURRENT_DATE - 330 + TIME '21:11', 1),
  (6, CURRENT_DATE - 319 + TIME '10:36', 1),
  (7, CURRENT_DATE - 312 + TIME '15:57', 2),
  (8, CURRENT_DATE - 300 + TIME '10:42', NULL),
  (9, CURRENT_DATE - 294 + TIME '23:11', NULL),
  (10, NULL, NULL),
  (11, CURRENT_DATE - 275 + TIME '16:13', 1),
  (12, CURRENT_DATE - 265 + TIME '22:18', 1),
  (13, CURRENT_DATE - 257 + TIME '21:26', 2),
  (14, CURRENT_DATE - 249 + TIME '16:44', NULL),
  (15, CURRENT_DATE - 239 + TIME '14:42', NULL),
  (16, NULL, NULL),
  (17, CURRENT_DATE - 221 + TIME '07:01', 1),
  (18, CURRENT_DATE - 210 + TIME '08:42', 1),
  (19, CURRENT_DATE - 204 + TIME '14:32', 2),
  (20, CURRENT_DATE - 193 + TIME '23:08', NULL),
  (21, CURRENT_DATE - 183 + TIME '00:51', NULL),
  (22, NULL, NULL),
  (23, CURRENT_DATE - 165 + TIME '10:17', 1),
  (24, CURRENT_DATE - 157 + TIME '23:53', 1),
  (25, CURRENT_DATE - 148 + TIME '20:42', 2),
  (26, CURRENT_DATE - 140 + TIME '07:31', NULL),
  (27, CURRENT_DATE - 130 + TIME '22:19', NULL),
  (28, NULL, NULL),
  (29, CURRENT_DATE - 113 + TIME '08:51', 1),
  (30, CURRENT_DATE - 102 + TIME '02:54', 1),
  (31, CURRENT_DATE - 96 + TIME '20:29', 2),
  (32, CURRENT_DATE - 87 + TIME '20:20', NULL),
  (33, CURRENT_DATE - 75 + TIME '03:38', NULL),
  (34, NULL, NULL),
  (35, CURRENT_DATE - 60 + TIME '15:14', 1),
  (36, CURRENT_DATE - 49 + TIME '21:33', 1),
  (37, CURRENT_DATE - 41 + TIME '01:10', 2),
  (38, CURRENT_DATE - 32 + TIME '04:13', NULL),
  (39, CURRENT_DATE - 22 + TIME '23:15', NULL),
  (40, NULL, NULL),
  (41, NULL, NULL),
  (42, NULL, NULL);
INSERT INTO inventario.alerta_inventario (alerta_inventario_id_alerta, alerta_inventario_mensaje, alerta_inventario_fecha_generacion, alerta_inventario_fecha_est_agotamiento, alerta_inventario_estado, material_sku, proveedor_id_proveedor, alerta_inventario_tipo_alerta_id_tipo_alerta, historial_alerta_id_historial, bodega_id_bodega, conteo_ciclico_id_conteo, alerta_inventario_diferencia, alerta_inventario_diferencia_pct, alerta_inventario_cantidad_sugerida, usuario_id_usuario)
OVERRIDING SYSTEM VALUE
VALUES
  (1, 'Diferencia de conteo: faltante de 1 (-1,92 %). Teórico 52, contado 51 en el conteo #1.', CURRENT_DATE - 88 + TIME '10:05', NULL, 'resuelta', 'ACE-C14', NULL, 8, 1, 1, 1, -1, -1.92, NULL, 1),
  (2, 'Diferencia de conteo: faltante de 6 (-6 %). Teórico 100, contado 94 en el conteo #2.', CURRENT_DATE - 9 + TIME '09:05', NULL, 'activa', 'TAR-ANC', NULL, 8, 2, 3, 2, -6, -6, NULL, 1),
  (3, 'Venta NV-PRUEBA-07: Tarugo de anclaje 10 mm no está en la ubicación indicada (Bodega Central: Central C - Fijaciones y sellos (lote ' || 'LOTE-' || to_char(CURRENT_DATE - 38, 'YYYYMMDD') || '-155' || ')). Observación: El anaquel tiene otra medida de tarugo.', CURRENT_DATE - 5 + TIME '11:10', NULL, 'activa', 'TAR-ANC', NULL, 10, 3, 1, NULL, NULL, NULL, NULL, 2),
  (4, 'Venta NV-PRUEBA-07: retiro parcial de Tarugo de anclaje 10 mm en Bodega Central. Se retiraron 6 de 10; faltan 4. Reponga o ubique el material: el pedido no se puede cargar hasta completarlo.', CURRENT_DATE - 5 + TIME '11:20', NULL, 'activa', 'TAR-ANC', NULL, 11, 4, 1, NULL, -4, NULL, NULL, 2),
  (5, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 330 + TIME '10:11', NULL, 'resuelta', 'ACE-C14', NULL, 6, 5, NULL, NULL, NULL, NULL, NULL, NULL),
  (6, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 321 + TIME '11:36', NULL, 'resuelta', 'DIS-CORTE', NULL, 6, 6, NULL, NULL, NULL, NULL, NULL, NULL),
  (7, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 312 + TIME '12:57', NULL, 'resuelta', 'PIN-GRS', NULL, 6, 7, NULL, NULL, NULL, NULL, NULL, NULL),
  (8, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 303 + TIME '13:42', NULL, 'resuelta', 'TAR-ANC', NULL, 6, 8, NULL, NULL, NULL, NULL, NULL, NULL),
  (9, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 294 + TIME '14:11', NULL, 'resuelta', 'BUR-GOM', NULL, 6, 9, NULL, NULL, NULL, NULL, NULL, NULL),
  (10, 'Stock actual en nivel crítico', CURRENT_DATE - 285 + TIME '10:40', NULL, 'resuelta', 'CER-MUL', NULL, 2, 10, NULL, NULL, NULL, NULL, NULL, NULL),
  (11, 'Cobertura menor que el plazo del proveedor. Reordenar Plancha acero galvanizado cal. 14.', CURRENT_DATE - 276 + TIME '12:13', NULL, 'resuelta', 'ACE-C14', 1, 5, 11, NULL, NULL, NULL, NULL, NULL, NULL),
  (12, 'Cobertura menor que el plazo del proveedor. Reordenar Disco de corte metal 7 pulgadas.', CURRENT_DATE - 267 + TIME '08:18', NULL, 'resuelta', 'DIS-CORTE', 3, 5, 12, NULL, NULL, NULL, NULL, NULL, NULL),
  (13, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 258 + TIME '12:26', NULL, 'resuelta', 'ELE-SOLD', NULL, 6, 13, NULL, NULL, NULL, NULL, NULL, NULL),
  (14, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 249 + TIME '12:44', NULL, 'resuelta', 'MAD-PIN', NULL, 6, 14, NULL, NULL, NULL, NULL, NULL, NULL),
  (15, 'Stock actual en nivel crítico', CURRENT_DATE - 240 + TIME '16:42', NULL, 'resuelta', 'PIN-BLA', NULL, 2, 15, NULL, NULL, NULL, NULL, NULL, NULL),
  (16, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 231 + TIME '11:15', NULL, 'resuelta', 'SIL-TRA', NULL, 6, 16, NULL, NULL, NULL, NULL, NULL, NULL),
  (17, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 222 + TIME '09:01', NULL, 'resuelta', 'ACE-C14', NULL, 6, 17, NULL, NULL, NULL, NULL, NULL, NULL),
  (18, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 213 + TIME '16:42', NULL, 'resuelta', 'DIS-CORTE', NULL, 6, 18, NULL, NULL, NULL, NULL, NULL, NULL),
  (19, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 204 + TIME '08:32', NULL, 'resuelta', 'PIN-GRS', NULL, 6, 19, NULL, NULL, NULL, NULL, NULL, NULL),
  (20, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 195 + TIME '10:08', NULL, 'resuelta', 'TAR-ANC', NULL, 6, 20, NULL, NULL, NULL, NULL, NULL, NULL),
  (21, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 186 + TIME '13:51', NULL, 'resuelta', 'BUR-GOM', NULL, 6, 21, NULL, NULL, NULL, NULL, NULL, NULL),
  (22, 'Stock actual en nivel crítico', CURRENT_DATE - 177 + TIME '11:54', NULL, 'resuelta', 'CER-MUL', NULL, 2, 22, NULL, NULL, NULL, NULL, NULL, NULL),
  (23, 'Cobertura menor que el plazo del proveedor. Reordenar Plancha acero galvanizado cal. 14.', CURRENT_DATE - 168 + TIME '15:17', NULL, 'resuelta', 'ACE-C14', 1, 5, 23, NULL, NULL, NULL, NULL, NULL, NULL),
  (24, 'Cobertura menor que el plazo del proveedor. Reordenar Disco de corte metal 7 pulgadas.', CURRENT_DATE - 159 + TIME '13:53', NULL, 'resuelta', 'DIS-CORTE', 3, 5, 24, NULL, NULL, NULL, NULL, NULL, NULL),
  (25, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 150 + TIME '13:42', NULL, 'resuelta', 'ELE-SOLD', NULL, 6, 25, NULL, NULL, NULL, NULL, NULL, NULL),
  (26, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 141 + TIME '14:31', NULL, 'resuelta', 'MAD-PIN', NULL, 6, 26, NULL, NULL, NULL, NULL, NULL, NULL),
  (27, 'Stock actual en nivel crítico', CURRENT_DATE - 132 + TIME '11:19', NULL, 'resuelta', 'PIN-BLA', NULL, 2, 27, NULL, NULL, NULL, NULL, NULL, NULL),
  (28, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 123 + TIME '14:31', NULL, 'resuelta', 'SIL-TRA', NULL, 6, 28, NULL, NULL, NULL, NULL, NULL, NULL),
  (29, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 114 + TIME '11:51', NULL, 'resuelta', 'ACE-C14', NULL, 6, 29, NULL, NULL, NULL, NULL, NULL, NULL),
  (30, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 105 + TIME '09:54', NULL, 'resuelta', 'DIS-CORTE', NULL, 6, 30, NULL, NULL, NULL, NULL, NULL, NULL),
  (31, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 96 + TIME '11:29', NULL, 'resuelta', 'PIN-GRS', NULL, 6, 31, NULL, NULL, NULL, NULL, NULL, NULL),
  (32, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 87 + TIME '09:20', NULL, 'resuelta', 'TAR-ANC', NULL, 6, 32, NULL, NULL, NULL, NULL, NULL, NULL),
  (33, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 78 + TIME '08:38', NULL, 'resuelta', 'BUR-GOM', NULL, 6, 33, NULL, NULL, NULL, NULL, NULL, NULL),
  (34, 'Stock actual en nivel crítico', CURRENT_DATE - 69 + TIME '13:17', NULL, 'resuelta', 'CER-MUL', NULL, 2, 34, NULL, NULL, NULL, NULL, NULL, NULL),
  (35, 'Cobertura menor que el plazo del proveedor. Reordenar Plancha acero galvanizado cal. 14.', CURRENT_DATE - 60 + TIME '08:14', NULL, 'resuelta', 'ACE-C14', 1, 5, 35, NULL, NULL, NULL, NULL, NULL, NULL),
  (36, 'Cobertura menor que el plazo del proveedor. Reordenar Disco de corte metal 7 pulgadas.', CURRENT_DATE - 51 + TIME '13:33', NULL, 'resuelta', 'DIS-CORTE', 3, 5, 36, NULL, NULL, NULL, NULL, NULL, NULL),
  (37, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 42 + TIME '12:10', NULL, 'resuelta', 'ELE-SOLD', NULL, 6, 37, NULL, NULL, NULL, NULL, NULL, NULL),
  (38, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 33 + TIME '15:13', NULL, 'resuelta', 'MAD-PIN', NULL, 6, 38, NULL, NULL, NULL, NULL, NULL, NULL),
  (39, 'Stock actual en nivel crítico', CURRENT_DATE - 24 + TIME '15:15', NULL, 'resuelta', 'PIN-BLA', NULL, 2, 39, NULL, NULL, NULL, NULL, NULL, NULL),
  (40, 'Stock actual bajo el mínimo definido', CURRENT_DATE - 15 + TIME '13:09', NULL, 'resuelta', 'SIL-TRA', NULL, 6, 40, NULL, NULL, NULL, NULL, NULL, NULL),
  (41, 'Stock actual (12) bajo el mínimo definido', CURRENT_DATE - 2 + TIME '18:30', NULL, 'activa', 'ACE-C14', NULL, 6, 41, NULL, NULL, NULL, NULL, NULL, NULL),
  (42, 'Stock actual (0) en nivel crítico', CURRENT_DATE - 2 + TIME '18:30', NULL, 'activa', 'GUA-NIT', NULL, 2, 42, NULL, NULL, NULL, NULL, NULL, NULL);

SELECT setval(pg_get_serial_sequence('inventario.orden_trabajo', 'orden_trabajo_id_orden'), (SELECT MAX(orden_trabajo_id_orden) FROM inventario.orden_trabajo));
SELECT setval(pg_get_serial_sequence('inventario.diferencial_consumo', 'diferencial_consumo_id'), (SELECT MAX(diferencial_consumo_id) FROM inventario.diferencial_consumo));
SELECT setval(pg_get_serial_sequence('inventario.conteo_ciclico', 'conteo_ciclico_id_conteo'), (SELECT MAX(conteo_ciclico_id_conteo) FROM inventario.conteo_ciclico));
SELECT setval(pg_get_serial_sequence('inventario.diferencia_inventario', 'diferencia_inventario_id'), (SELECT MAX(diferencia_inventario_id) FROM inventario.diferencia_inventario));
SELECT setval(pg_get_serial_sequence('inventario.historial_alerta', 'historial_alerta_id_historial'), (SELECT MAX(historial_alerta_id_historial) FROM inventario.historial_alerta));
SELECT setval(pg_get_serial_sequence('inventario.alerta_inventario', 'alerta_inventario_id_alerta'), (SELECT MAX(alerta_inventario_id_alerta) FROM inventario.alerta_inventario));

COMMIT;
