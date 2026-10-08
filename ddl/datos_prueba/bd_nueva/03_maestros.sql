-- ============================================================
-- Datos de prueba (BD NUEVA) — 03 · Maestros: bodegas, proveedores, materiales, recetas y reglas de integración
-- Grupo 14 | Generado por generador/generar.js: NO editar a mano (regenerar).
--
-- Bodega Sur no tiene productos a propósito (CU-37 Exc 2).
-- Perfiles Nuevo Norte no tiene compras ni precios (CU-61, CU-62, CU-64); Distribuidora Cerrada está inactiva.
-- LIJ-120 y PIN-CUS no tienen proveedor; MAT-INAC está inactivo; VID-BLI está descontinuado.
--
-- Orden de carga: ddl_inventario.sql, ddl_terreno.sql, ddl_finanzas.sql,
-- catalogos_inventario.sql y luego 01..06 de esta carpeta (ver README.md).
-- Las fechas son relativas al día de carga (CURRENT_DATE - n).
-- ============================================================

-- El archivo es UTF-8: sin esto, psql en Windows lo lee como WIN1252 y daña los acentos
SET client_encoding = 'UTF8';

BEGIN;

INSERT INTO inventario.bodega (bodega_id_bodega, bodega_nombre_bodega, bodega_direccion, bodega_estado, bodega_codigo)
OVERRIDING SYSTEM VALUE
VALUES
  (1, 'Bodega Central', 'Av. Los Industriales 1450, Quilicura', 'activo', 'BC'),
  (2, 'Bodega Planta', 'Camino Lo Echevers 820, Quilicura', 'activo', 'BP'),
  (3, 'Bodega Obra Norte', 'Av. Recoleta 3300, Recoleta (obra)', 'activo', 'BON'),
  (4, 'Bodega Sur', 'Av. Lo Espejo 2100, San Bernardo', 'activo', 'BS');
INSERT INTO inventario.anaquel (anaquel_id_anaquel, anaquel_descripcion, bodega_id_bodega)
OVERRIDING SYSTEM VALUE
VALUES
  (1, 'Central A - Aceros y perfiles', 1),
  (2, 'Central B - Cerraduras y herrajes', 1),
  (3, 'Central C - Fijaciones y sellos', 1),
  (4, 'Central D - Consumibles y herramientas', 1),
  (5, 'Planta P1 - Pinturas', 2),
  (6, 'Planta P2 - Maderas y herrajes', 2),
  (7, 'Obra Norte O1 - Contenedor', 3),
  (8, 'Sur S1 - Rack principal', 4);

INSERT INTO inventario.proveedor (proveedor_id_proveedor, proveedor_razon_social, proveedor_pais, proveedor_tipo_proveedor, proveedor_rubro, proveedor_contacto_primer_nombre, proveedor_contacto_primer_apellido, proveedor_estado, proveedor_doc_identidad_tipo_identificador, proveedor_doc_identidad_rut_proveedor_opcional)
OVERRIDING SYSTEM VALUE
VALUES
  (1, 'Aceros del Pacífico S.A.', 'Chile', 'distribuidor', 'Aceros y perfiles', 'Carolina', 'Méndez', 'activo', 'RUT', '96543210-8'),
  (2, 'Pinturas Andinas Ltda.', 'Chile', 'fabricante', 'Pinturas y recubrimientos', 'Rodrigo', 'Lagos', 'activo', 'RUT', '77321654-1'),
  (3, 'Ferretería Industrial Sur SpA', 'Chile', 'distribuidor', 'Ferretería, fijaciones y herrajes', 'Paula', 'Contreras', 'activo', 'RUT', '76987321-K'),
  (4, 'Maderas del Maule Ltda.', 'Chile', 'productor', 'Maderas', 'Hernán', 'Tapia', 'activo', 'RUT', '78456123-2'),
  (5, 'Importadora Blindex Ltda.', 'Chile', 'importador', 'Cerraduras y accesorios importados', 'Valentina', 'Ibáñez', 'activo', 'RUT', '76123987-2'),
  (6, 'Perfiles Nuevo Norte SpA', 'Chile', 'distribuidor', 'Aceros y perfiles', 'Ignacio', 'Araya', 'activo', 'RUT', '77888999-4'),
  (7, 'Distribuidora Cerrada Ltda.', 'Chile', 'distribuidor', 'Sellos y adhesivos', 'Mónica', 'Vidal', 'inactivo', 'RUT', '76555444-6');
INSERT INTO inventario.proveedor_contacto_telefono (proveedor_id_proveedor, proveedor_contacto_telefono)
VALUES
  (1, '+56 2 2345 6789'),
  (2, '+56 2 2456 7890'),
  (3, '+56 2 2567 8901'),
  (4, '+56 71 234 5678'),
  (5, '+56 2 2678 9012'),
  (6, '+56 55 234 5678'),
  (7, '+56 2 2789 0123');
INSERT INTO inventario.proveedor_contacto_correo (proveedor_id_proveedor, proveedor_contacto_correo)
VALUES
  (1, 'ventas@acerosdelpacifico.test'),
  (2, 'pedidos@pinturasandinas.test'),
  (3, 'contacto@ferreteriasur.test'),
  (4, 'ventas@maderasdelmaule.test'),
  (5, 'importaciones@blindex.test'),
  (6, 'contacto@nuevonorte.test'),
  (7, 'ventas@distcerrada.test');

INSERT INTO inventario.material (material_sku, material_nombre_material, material_descripcion, material_material_critico, material_presentacion, material_presentacion_fecha_modificacion, material_stock_critico, material_stock_maximo, material_stock_minimo, material_es_rotativo, material_estado, es_material_pintura_custom, material_pintura_pintura_custom, es_material_pintura_no_custom, material_pintura_no_custom, material_categoria_general_id_categoria_general, material_categoria_funcional_id_categoria_funcional, material_clasificacion_nivel_especifico_id, material_unidad_medida_id_unidad_medida, material_es_herramienta, material_valor_adquisicion, material_fecha_adquisicion, material_descontinuado)
VALUES
  ('ACE-C14', 'Plancha acero galvanizado cal. 14', 'Acero para hojas y marcos de puerta blindada', TRUE, 'Plancha 1220 x 2440 mm, paquete de 10 unidades', CURRENT_DATE - 400 + TIME '12:00', 8, 120, 20, TRUE, 'activo', NULL, NULL, NULL, NULL, 2, 3, 1, 1, FALSE, NULL, NULL, FALSE),
  ('ACE-C16', 'Plancha acero galvanizado cal. 16', NULL, FALSE, 'Plancha 1220 x 2440 mm, paquete de 10 unidades', CURRENT_DATE - 400 + TIME '12:00', 4, 60, 10, TRUE, 'activo', NULL, NULL, NULL, NULL, 1, 3, 2, 1, FALSE, NULL, NULL, FALSE),
  ('TUB-4040', 'Tubo estructural 40x40x2 mm', NULL, FALSE, 'Tira de 6 metros', CURRENT_DATE - 400 + TIME '12:00', 20, 400, 60, TRUE, 'activo', NULL, NULL, NULL, NULL, 1, 3, 3, 3, FALSE, NULL, NULL, FALSE),
  ('PIN-BLA', 'Pintura esmalte blanco', NULL, FALSE, 'Tineta de 20 kg', CURRENT_DATE - 400 + TIME '12:00', 5, 80, 15, TRUE, 'activo', NULL, NULL, TRUE, 'blanco', 1, 2, 4, 5, FALSE, NULL, NULL, FALSE),
  ('PIN-GRS', 'Pintura anticorrosiva gris RAL-7016', NULL, FALSE, 'Tineta de 20 kg', CURRENT_DATE - 400 + TIME '12:00', 5, 90, 15, TRUE, 'activo', NULL, NULL, TRUE, 'gris RAL-7016', 1, 2, 5, 5, FALSE, NULL, NULL, FALSE),
  ('PIN-CUS', 'Pintura verde oliva personalizada', 'Color a pedido del cliente: se compra por venta', FALSE, NULL, NULL, NULL, NULL, NULL, FALSE, 'activo', TRUE, 'verde oliva', NULL, NULL, 1, 2, 6, 5, FALSE, NULL, NULL, FALSE),
  ('MAD-PIN', 'Tabla pino radiata 1x6', NULL, FALSE, NULL, NULL, 20, 400, 50, TRUE, 'activo', NULL, NULL, NULL, NULL, 1, 3, 7, 3, FALSE, NULL, NULL, FALSE),
  ('ELE-SOLD', 'Electrodo soldadura E6011 3/32', NULL, FALSE, 'Caja de 5 kg', CURRENT_DATE - 400 + TIME '12:00', 2, 40, 5, TRUE, 'activo', NULL, NULL, NULL, NULL, 1, 2, NULL, 5, FALSE, NULL, NULL, FALSE),
  ('DIS-CORTE', 'Disco de corte metal 7 pulgadas', NULL, FALSE, 'Caja de 25 unidades', CURRENT_DATE - 400 + TIME '12:00', 5, 100, 10, TRUE, 'activo', NULL, NULL, NULL, NULL, 1, 2, NULL, 4, FALSE, NULL, NULL, FALSE),
  ('CER-MUL', 'Cerradura multipunto de seguridad', NULL, TRUE, 'Caja individual con 3 llaves', CURRENT_DATE - 400 + TIME '12:00', 2, 40, 5, TRUE, 'activo', NULL, NULL, NULL, NULL, 2, 2, NULL, 4, FALSE, NULL, NULL, FALSE),
  ('BIS-ACE', 'Bisagra de acero reforzada 4 pulgadas', NULL, FALSE, NULL, NULL, 3, 120, 6, TRUE, 'activo', NULL, NULL, NULL, NULL, 1, 2, NULL, 4, FALSE, NULL, NULL, FALSE),
  ('MIR-PUE', 'Mirilla gran angular 200 grados', NULL, FALSE, NULL, NULL, 2, 40, 4, TRUE, 'activo', NULL, NULL, NULL, NULL, 1, 2, NULL, 4, FALSE, NULL, NULL, FALSE),
  ('TAR-ANC', 'Tarugo de anclaje 10 mm', NULL, FALSE, 'Bolsa de 100 unidades', CURRENT_DATE - 400 + TIME '12:00', 40, 1200, 100, TRUE, 'activo', NULL, NULL, NULL, NULL, 1, 2, NULL, 4, FALSE, NULL, NULL, FALSE),
  ('ESP-POL', 'Espuma de poliuretano 750 ml', NULL, FALSE, NULL, NULL, 3, 60, 8, TRUE, 'activo', NULL, NULL, NULL, NULL, 1, 2, NULL, 4, FALSE, NULL, NULL, FALSE),
  ('SIL-TRA', 'Sellador de silicona transparente 280 ml', NULL, FALSE, 'Caja de 12 cartuchos', CURRENT_DATE - 400 + TIME '12:00', 4, 80, 10, TRUE, 'activo', NULL, NULL, NULL, NULL, 1, 2, NULL, 4, FALSE, NULL, NULL, FALSE),
  ('BUR-GOM', 'Burlete de goma EPDM', NULL, FALSE, 'Rollo de 50 metros', CURRENT_DATE - 400 + TIME '12:00', 15, 400, 40, TRUE, 'activo', NULL, NULL, NULL, NULL, 1, 2, NULL, 3, FALSE, NULL, NULL, FALSE),
  ('CER-BIO', 'Cerradura biométrica importada', 'Se importa por venta', TRUE, NULL, NULL, NULL, NULL, NULL, FALSE, 'activo', NULL, NULL, NULL, NULL, 2, 2, NULL, 4, FALSE, NULL, NULL, FALSE),
  ('VID-BLI', 'Visor blindado importado', 'El fabricante dejó de producirlo', FALSE, NULL, NULL, NULL, NULL, NULL, FALSE, 'activo', NULL, NULL, NULL, NULL, 1, 2, NULL, 4, FALSE, NULL, NULL, TRUE),
  ('MAN-BRO', 'Manilla de bronce artesanal', NULL, FALSE, NULL, NULL, NULL, NULL, NULL, FALSE, 'activo', NULL, NULL, NULL, NULL, 1, 2, NULL, 4, FALSE, NULL, NULL, FALSE),
  ('ADH-EPO', 'Adhesivo epóxico bicomponente', NULL, FALSE, NULL, NULL, NULL, NULL, NULL, TRUE, 'activo', NULL, NULL, NULL, NULL, 1, 2, NULL, 4, FALSE, NULL, NULL, FALSE),
  ('LIJ-120', 'Lija al agua grano 120', NULL, FALSE, NULL, NULL, 8, 200, 20, TRUE, 'activo', NULL, NULL, NULL, NULL, 1, 2, NULL, 4, FALSE, NULL, NULL, FALSE),
  ('GUA-NIT', 'Guantes de nitrilo (par)', NULL, FALSE, NULL, NULL, 20, 300, 50, TRUE, 'activo', NULL, NULL, NULL, NULL, 1, 2, NULL, 4, FALSE, NULL, NULL, FALSE),
  ('MAT-INAC', 'Perfil de aluminio 30x30 (dado de baja)', 'Ya no se usa en las puertas', FALSE, NULL, NULL, NULL, NULL, NULL, TRUE, 'inactivo', NULL, NULL, NULL, NULL, 1, 3, NULL, 3, FALSE, NULL, NULL, FALSE),
  ('HER-TAL', 'Taladro percutor 800 W', NULL, FALSE, NULL, NULL, NULL, NULL, NULL, TRUE, 'activo', NULL, NULL, NULL, NULL, NULL, 1, NULL, 4, TRUE, 89990, CURRENT_DATE - 300, FALSE),
  ('HER-ESM', 'Esmeril angular 4 1/2 pulgadas', NULL, FALSE, NULL, NULL, NULL, NULL, NULL, TRUE, 'activo', NULL, NULL, NULL, NULL, NULL, 1, NULL, 4, TRUE, 54990, CURRENT_DATE - 280, FALSE);

-- CU-30: un código interno por SKU (prefijo 2, 12 dígitos), como los genera el backend
INSERT INTO inventario.material_codigo_barras (material_sku, material_codigo_barras)
VALUES
  ('ACE-C14', '200000000001'),
  ('ACE-C16', '200000000002'),
  ('TUB-4040', '200000000003'),
  ('PIN-BLA', '200000000004'),
  ('PIN-GRS', '200000000005'),
  ('PIN-CUS', '200000000006'),
  ('MAD-PIN', '200000000007'),
  ('ELE-SOLD', '200000000008'),
  ('DIS-CORTE', '200000000009'),
  ('CER-MUL', '200000000010'),
  ('BIS-ACE', '200000000011'),
  ('MIR-PUE', '200000000012'),
  ('TAR-ANC', '200000000013'),
  ('ESP-POL', '200000000014'),
  ('SIL-TRA', '200000000015'),
  ('BUR-GOM', '200000000016'),
  ('CER-BIO', '200000000017'),
  ('VID-BLI', '200000000018'),
  ('MAN-BRO', '200000000019'),
  ('ADH-EPO', '200000000020'),
  ('LIJ-120', '200000000021'),
  ('GUA-NIT', '200000000022'),
  ('MAT-INAC', '200000000023'),
  ('HER-TAL', '200000000024'),
  ('HER-ESM', '200000000025');
SELECT setval('inventario.seq_codigo_barras_interno', 25);

INSERT INTO inventario.material_proveedor (material_sku, proveedor_id_proveedor, material_proveedor_tiempo_reposicion, material_proveedor_precio_referencial, material_proveedor_proveedor_principal, material_proveedor_cantidad_minima)
VALUES
  ('ACE-C14', 1, 5, 33110, TRUE, 10),
  ('ACE-C14', 3, 3, 35060, FALSE, 5),
  ('ACE-C16', 1, 5, 30220, TRUE, 10),
  ('TUB-4040', 1, NULL, 9950, TRUE, 30),
  ('TUB-4040', 6, 7, NULL, FALSE, NULL),
  ('PIN-BLA', 2, 4, 15690, TRUE, 4),
  ('PIN-GRS', 2, 4, 16690, TRUE, 4),
  ('MAD-PIN', 4, 6, 4590, TRUE, 50),
  ('ELE-SOLD', 3, 3, 7740, TRUE, 5),
  ('DIS-CORTE', 3, 4, 2510, TRUE, 25),
  ('CER-MUL', 3, 5, 52430, TRUE, 5),
  ('CER-MUL', 5, 15, 45500, FALSE, 10),
  ('BIS-ACE', 3, 3, 4240, TRUE, 20),
  ('MIR-PUE', 3, 4, 5480, TRUE, 5),
  ('TAR-ANC', 3, 2, 195, TRUE, 100),
  ('ESP-POL', 7, 3, 4240, TRUE, 12),
  ('SIL-TRA', 3, 3, 3150, TRUE, 12),
  ('BUR-GOM', 3, 5, 923, TRUE, 50),
  ('CER-BIO', 5, 20, 189000, TRUE, 1),
  ('VID-BLI', 5, 25, 98000, TRUE, 1),
  ('MAN-BRO', 5, 15, 35000, TRUE, 1),
  ('ADH-EPO', 3, 3, 7500, TRUE, NULL),
  ('GUA-NIT', 3, 2, 450, TRUE, 50),
  ('HER-TAL', 3, 5, 89990, TRUE, NULL),
  ('HER-ESM', 3, 5, 54990, TRUE, NULL);

-- Recetas (CU-102). PB-STD-000 es la versión anterior, desactivada y reemplazada por PB-STD-001
INSERT INTO inventario.producto_terminado (producto_terminado_id_producto, producto_terminado_tipo_producto, producto_terminado_nombre_producto, producto_terminado_codigo_producto, producto_terminado_activo, producto_terminado_fecha_creacion, producto_terminado_reemplazada_por)
OVERRIDING SYSTEM VALUE
VALUES
  (1, 'simple', 'Puerta blindada estándar 90x200', 'PB-STD-001', TRUE, CURRENT_DATE - 380 + TIME '10:00', NULL),
  (2, 'doble', 'Puerta blindada doble hoja 160x210', 'PB-DBL-001', TRUE, CURRENT_DATE - 380 + TIME '10:00', NULL),
  (3, 'simple', 'Puerta blindada con cerradura biométrica', 'PB-ESP-001', TRUE, CURRENT_DATE - 380 + TIME '10:00', NULL),
  (4, 'simple', 'Hoja de reposición (sin insumos de instalación)', 'PB-REP-001', TRUE, CURRENT_DATE - 380 + TIME '10:00', NULL),
  (5, 'simple', 'Puerta blindada estándar 90x200 (versión anterior)', 'PB-STD-000', FALSE, CURRENT_DATE - 420 + TIME '10:00', 1);
INSERT INTO inventario.material_producto_terminado (material_sku, producto_terminado_id_producto, material_producto_terminado_cantidad_estimada, material_producto_terminado_merma_estimada, area_trabajo_id_area)
VALUES
  ('ACE-C14', 1, 2, 0.1, 1),
  ('TUB-4040', 1, 6, 0.05, 1),
  ('ELE-SOLD', 1, 0.5, 0.1, 3),
  ('DIS-CORTE', 1, 1, 0, 3),
  ('PIN-GRS', 1, 1.2, 0.1, 2),
  ('PIN-BLA', 1, 1, 0.1, 2),
  ('CER-MUL', 1, 1, 0, 5),
  ('BIS-ACE', 1, 3, 0, 5),
  ('MIR-PUE', 1, 1, 0, 5),
  ('TAR-ANC', 1, 8, 0.25, 5),
  ('ESP-POL', 1, 1, 0, 5),
  ('SIL-TRA', 1, 1, 0, 5),
  ('BUR-GOM', 1, 5.5, 0.1, 5),
  ('ACE-C14', 2, 4, 0.1, 1),
  ('TUB-4040', 2, 10, 0.05, 1),
  ('ELE-SOLD', 2, 0.9, 0.1, 3),
  ('DIS-CORTE', 2, 2, 0, 3),
  ('PIN-GRS', 2, 2.2, 0.1, 2),
  ('PIN-BLA', 2, 1.8, 0.1, 2),
  ('CER-MUL', 2, 2, 0, 5),
  ('BIS-ACE', 2, 6, 0, 5),
  ('MIR-PUE', 2, 1, 0, 5),
  ('TAR-ANC', 2, 12, 0.25, 5),
  ('ESP-POL', 2, 2, 0, 5),
  ('SIL-TRA', 2, 2, 0, 5),
  ('BUR-GOM', 2, 9, 0.1, 5),
  ('ACE-C14', 3, 2, 0.1, 1),
  ('TUB-4040', 3, 6, 0.05, 1),
  ('PIN-CUS', 3, 1.5, 0.1, 2),
  ('CER-BIO', 3, 1, 0, 5),
  ('BIS-ACE', 3, 3, 0, 5),
  ('TAR-ANC', 3, 8, 0.25, 5),
  ('SIL-TRA', 3, 1, 0, 5),
  ('ACE-C14', 4, 2, 0.1, 1),
  ('PIN-GRS', 4, 1.2, 0.1, 2),
  ('ACE-C14', 5, 2.2, 0.1, 1),
  ('TUB-4040', 5, 6, 0.1, 1),
  ('PIN-GRS', 5, 1.4, 0.1, 2),
  ('CER-MUL', 5, 1, 0, 5),
  ('BIS-ACE', 5, 3, 0, 5),
  ('TAR-ANC', 5, 8, 0.25, 5);

-- CU-108: una sola regla, Terreno + jop (entradas y salidas). Finanzas no tiene reglas.
INSERT INTO inventario.permiso (permiso_id_permiso, permiso_modulo, permiso_accion, permiso_descripcion, permiso_nombre_del_permiso)
OVERRIDING SYSTEM VALUE
VALUES
  (8, 'inventario', 'entrada_desde_terreno', 'CU-108: registrar entradas de inventario desde Terreno', 'inv_entrada_desde_terreno'),
  (9, 'inventario', 'salida_desde_terreno', 'CU-108: registrar salidas de inventario desde Terreno', 'inv_salida_desde_terreno');
INSERT INTO inventario.perfil_permiso (perfil_id_perfil, permiso_id_permiso, perfil_permiso_activo)
VALUES
  (2, 8, TRUE),
  (2, 9, TRUE);

SELECT setval(pg_get_serial_sequence('inventario.bodega', 'bodega_id_bodega'), (SELECT MAX(bodega_id_bodega) FROM inventario.bodega));
SELECT setval(pg_get_serial_sequence('inventario.anaquel', 'anaquel_id_anaquel'), (SELECT MAX(anaquel_id_anaquel) FROM inventario.anaquel));
SELECT setval(pg_get_serial_sequence('inventario.proveedor', 'proveedor_id_proveedor'), (SELECT MAX(proveedor_id_proveedor) FROM inventario.proveedor));
SELECT setval(pg_get_serial_sequence('inventario.producto_terminado', 'producto_terminado_id_producto'), (SELECT MAX(producto_terminado_id_producto) FROM inventario.producto_terminado));
SELECT setval(pg_get_serial_sequence('inventario.permiso', 'permiso_id_permiso'), (SELECT MAX(permiso_id_permiso) FROM inventario.permiso));

COMMIT;
