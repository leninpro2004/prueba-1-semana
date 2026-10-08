-- ============================================================
-- Catálogos base del schema inventario (sesión 15, punto 27)
-- Grupo 14 | Generado desde la BD real el 30-09-2026 con los mismos ids.
--
-- El DDL (ddl_inventario.sql) crea las tablas vacías; sin estos catálogos una BD nueva
-- no puede registrar movimientos, generar alertas ni crear materiales. Se corre DESPUÉS
-- de los tres DDL. Es IDEMPOTENTE: ON CONFLICT DO NOTHING (no duplica ni pisa lo que ya
-- exista) y al final ajusta las secuencias de identidad.
-- npm run test:preparar lo carga, así que se comprueba desde cero cada vez.
-- ============================================================

-- El archivo es UTF-8: sin esto, psql en Windows lo lee como WIN1252 y daña los acentos
-- ("Instalación", "Técnico"...), que el backend busca por nombre
SET client_encoding = 'UTF8';

BEGIN;
SET search_path TO inventario;


-- Tipos de movimiento (el código busca "entrada" y "salida" por nombre)
INSERT INTO movimiento_inventario_tipo_movimiento (movimiento_inventario_tipo_movimiento_id_tipo_movimiento, movimiento_inventario_tipo_movimiento_nombre)
OVERRIDING SYSTEM VALUE VALUES
  ('1', 'entrada'),
  ('2', 'salida'),
  ('3', 'transferencia'),
  ('4', 'ajuste'),
  ('5', 'reverso')
ON CONFLICT DO NOTHING;
SELECT setval(pg_get_serial_sequence('inventario.movimiento_inventario_tipo_movimiento', 'movimiento_inventario_tipo_movimiento_id_tipo_movimiento'), (SELECT MAX(movimiento_inventario_tipo_movimiento_id_tipo_movimiento) FROM movimiento_inventario_tipo_movimiento));

-- Clasificaciones de salida ("Traslado" no cuenta como consumo)
INSERT INTO movimiento_inventario_clasificacion_salida (movimiento_inventario_clasificacion_salida_id_clasificacion_sal, movimiento_inventario_clasificacion_salida_nombre)
OVERRIDING SYSTEM VALUE VALUES
  ('1', 'produccion'),
  ('2', 'merma'),
  ('3', 'devolucion'),
  ('4', 'ajuste_inventario'),
  ('5', 'Traslado')
ON CONFLICT DO NOTHING;
SELECT setval(pg_get_serial_sequence('inventario.movimiento_inventario_clasificacion_salida', 'movimiento_inventario_clasificacion_salida_id_clasificacion_sal'), (SELECT MAX(movimiento_inventario_clasificacion_salida_id_clasificacion_sal) FROM movimiento_inventario_clasificacion_salida));

-- Motivos (el código busca devolucion_consumo, despacho_venta, traslado_bodega, compra_proveedor, reverso_autorizado)
INSERT INTO movimiento_inventario_motivo_movimiento (movimiento_inventario_motivo_movimiento_id_motivo_movimiento, movimiento_inventario_motivo_movimiento_nombre, movimiento_inventario_clasificacion_salida_id_clasificacion_sal)
OVERRIDING SYSTEM VALUE VALUES
  ('1', 'compra_proveedor', NULL),
  ('2', 'consumo_produccion', '1'),
  ('3', 'merma_proceso', '2'),
  ('4', 'devolucion_cliente', '3'),
  ('5', 'ajuste_inventario', '4'),
  ('6', 'reverso_autorizado', NULL),
  ('7', 'devolucion_consumo', NULL),
  ('8', 'despacho_venta', '1'),
  ('9', 'traslado_bodega', '5'),
  ('10', 'perdida_herramienta', '2'),
  ('11', 'baja_herramienta', '2')
ON CONFLICT DO NOTHING;
SELECT setval(pg_get_serial_sequence('inventario.movimiento_inventario_motivo_movimiento', 'movimiento_inventario_motivo_movimiento_id_motivo_movimiento'), (SELECT MAX(movimiento_inventario_motivo_movimiento_id_motivo_movimiento) FROM movimiento_inventario_motivo_movimiento));

-- Prioridades de alerta
INSERT INTO alerta_inventario_nivel_prioridad (alerta_inventario_nivel_prioridad_id_nivel_prioridad, alerta_inventario_prioridad_nombre)
OVERRIDING SYSTEM VALUE VALUES
  ('1', 'media'),
  ('2', 'alta'),
  ('3', 'urgente')
ON CONFLICT DO NOTHING;
SELECT setval(pg_get_serial_sequence('inventario.alerta_inventario_nivel_prioridad', 'alerta_inventario_nivel_prioridad_id_nivel_prioridad'), (SELECT MAX(alerta_inventario_nivel_prioridad_id_nivel_prioridad) FROM alerta_inventario_nivel_prioridad));

-- Tipos de alerta (el generador los busca por nombre EXACTO normalizado)
INSERT INTO alerta_inventario_tipo_alerta (alerta_inventario_tipo_alerta_id_tipo_alerta, alerta_inventario_tipo_alerta_nombre, alerta_inventario_nivel_prioridad_id)
OVERRIDING SYSTEM VALUE VALUES
  ('2', 'stock_critico', '3'),
  ('3', 'stock_maximo', '1'),
  ('5', 'tiempo reposicion', '1'),
  ('6', 'stock bajo minimo', '2'),
  ('8', 'diferencia inventario', '2'),
  ('9', 'diferencia inventario critica', '3'),
  ('10', 'ubicacion incorrecta', '1'),
  ('11', 'faltante en retiro', '2')
ON CONFLICT DO NOTHING;
SELECT setval(pg_get_serial_sequence('inventario.alerta_inventario_tipo_alerta', 'alerta_inventario_tipo_alerta_id_tipo_alerta'), (SELECT MAX(alerta_inventario_tipo_alerta_id_tipo_alerta) FROM alerta_inventario_tipo_alerta));

-- Tolerancias del conteo cíclico (CU-43/57), editables por gerencia
INSERT INTO tolerancia_conteo (tolerancia_conteo_tipo, tolerancia_conteo_tolerancia_pct, tolerancia_conteo_umbral_critico_pct, tolerancia_conteo_fecha_modificacion, usuario_id_usuario) VALUES
  ('critico', '1.00', '5.00', '2026-09-26T00:34:15.042Z', NULL),
  ('no_critico', '5.00', '20.00', '2026-09-26T00:34:15.042Z', NULL)
ON CONFLICT DO NOTHING;

-- Áreas de trabajo (R1: cada OT es de un área; "instalacion" = CU-120)
INSERT INTO area_trabajo (area_trabajo_id_area, area_trabajo_clasificacion, area_trabajo_activo, area_trabajo_nombre_area)
OVERRIDING SYSTEM VALUE VALUES
  ('1', 'produccion', TRUE, 'Corte y habilitación'),
  ('2', 'produccion', TRUE, 'Pintura'),
  ('3', 'produccion', TRUE, 'Armado'),
  ('4', 'logistica', TRUE, 'Bodega'),
  ('5', 'instalacion', TRUE, 'Instalación')
ON CONFLICT DO NOTHING;
SELECT setval(pg_get_serial_sequence('inventario.area_trabajo', 'area_trabajo_id_area'), (SELECT MAX(area_trabajo_id_area) FROM area_trabajo));

-- Unidades de medida
INSERT INTO material_unidad_medida (material_unidad_medida_id_unidad_medida, material_unidad_medida_nombre)
OVERRIDING SYSTEM VALUE VALUES
  ('1', 'plancha'),
  ('2', 'litro'),
  ('3', 'metro'),
  ('4', 'unidad'),
  ('5', 'kilogramo')
ON CONFLICT DO NOTHING;
SELECT setval(pg_get_serial_sequence('inventario.material_unidad_medida', 'material_unidad_medida_id_unidad_medida'), (SELECT MAX(material_unidad_medida_id_unidad_medida) FROM material_unidad_medida));

-- Categoría funcional del material
INSERT INTO material_categoria_funcional (material_categoria_funcional_id_categoria_funcional, material_categoria_funcional_nombre)
OVERRIDING SYSTEM VALUE VALUES
  ('1', 'Herramienta'),
  ('2', 'Insumo'),
  ('3', 'Materia Prima')
ON CONFLICT DO NOTHING;
SELECT setval(pg_get_serial_sequence('inventario.material_categoria_funcional', 'material_categoria_funcional_id_categoria_funcional'), (SELECT MAX(material_categoria_funcional_id_categoria_funcional) FROM material_categoria_funcional));

-- Categoría general del material
INSERT INTO material_categoria_general (material_categoria_general_id_categoria_general, material_categoria_general_nombre)
OVERRIDING SYSTEM VALUE VALUES
  ('1', 'Materia Prima'),
  ('2', 'Material Crítico')
ON CONFLICT DO NOTHING;
SELECT setval(pg_get_serial_sequence('inventario.material_categoria_general', 'material_categoria_general_id_categoria_general'), (SELECT MAX(material_categoria_general_id_categoria_general) FROM material_categoria_general));

-- Clasificación de materiales: categoría
INSERT INTO material_clasificacion_categoria (material_clasificacion_categoria_id, material_clasificacion_categoria_nombre_categoria)
OVERRIDING SYSTEM VALUE VALUES
  ('1', 'Fierro'),
  ('2', 'Pintura'),
  ('3', 'Madera')
ON CONFLICT DO NOTHING;
SELECT setval(pg_get_serial_sequence('inventario.material_clasificacion_categoria', 'material_clasificacion_categoria_id'), (SELECT MAX(material_clasificacion_categoria_id) FROM material_clasificacion_categoria));

-- Clasificación de materiales: subcategoría
INSERT INTO material_clasificacion_subcategoria (material_clasificacion_subcategoria_id, material_clasificacion_subcategoria_nombre_subcategoria, material_clasificacion_subcategoria_es_color_custom, material_clasificacion_categoria_id)
OVERRIDING SYSTEM VALUE VALUES
  ('1', 'Plancha galvanizada', FALSE, '1'),
  ('2', 'Tubo estructural', FALSE, '1'),
  ('3', 'Blanco estándar', FALSE, '2'),
  ('4', 'Gris RAL-7016', FALSE, '2'),
  ('5', 'Verde oliva custom', TRUE, '2'),
  ('6', 'Pino radiata', FALSE, '3')
ON CONFLICT DO NOTHING;
SELECT setval(pg_get_serial_sequence('inventario.material_clasificacion_subcategoria', 'material_clasificacion_subcategoria_id'), (SELECT MAX(material_clasificacion_subcategoria_id) FROM material_clasificacion_subcategoria));

-- Clasificación de materiales: nivel específico
INSERT INTO material_clasificacion_nivel_especifico (material_clasificacion_nivel_especifico_id, material_clasificacion_nivel_especifico_nombre_nivel_especifico, material_clasificacion_subcategoria_id)
OVERRIDING SYSTEM VALUE VALUES
  ('1', 'Calibre 14', '1'),
  ('2', 'Calibre 16', '1'),
  ('3', '40x40mm', '2'),
  ('4', 'Esmalte', '3'),
  ('5', 'Anticorrosiva', '4'),
  ('6', 'Esmalte custom', '5'),
  ('7', 'Tabla 1x6', '6')
ON CONFLICT DO NOTHING;
SELECT setval(pg_get_serial_sequence('inventario.material_clasificacion_nivel_especifico', 'material_clasificacion_nivel_especifico_id'), (SELECT MAX(material_clasificacion_nivel_especifico_id) FROM material_clasificacion_nivel_especifico));

-- Perfiles (base de la migración a permisos, migracion-permisos.md)
INSERT INTO perfil (perfil_id_perfil, perfil_nombre_perfil, perfil_descripcion)
OVERRIDING SYSTEM VALUE VALUES
  ('1', 'gerencia', 'Acceso completo'),
  ('2', 'jop', 'Jefe de Operaciones — sin datos financieros'),
  ('3', 'bodeguero', 'Gestión de bodega e inventario'),
  ('4', 'administrador', 'Administración del sistema'),
  ('5', 'secretaria', 'Secretaría'),
  ('6', 'tecnico', 'Técnico')
ON CONFLICT DO NOTHING;
SELECT setval(pg_get_serial_sequence('inventario.perfil', 'perfil_id_perfil'), (SELECT MAX(perfil_id_perfil) FROM perfil));

-- Permisos
INSERT INTO permiso (permiso_id_permiso, permiso_modulo, permiso_accion, permiso_descripcion, permiso_nombre_del_permiso)
OVERRIDING SYSTEM VALUE VALUES
  ('1', 'inventario', 'ver', NULL, 'inv_ver'),
  ('2', 'inventario', 'crear', NULL, 'inv_crear'),
  ('3', 'inventario', 'editar', NULL, 'inv_editar'),
  ('4', 'inventario', 'configurar', NULL, 'inv_configurar'),
  ('5', 'inventario', 'revertir', NULL, 'inv_revertir'),
  ('6', 'alertas', 'resolver', NULL, 'alert_resolver'),
  ('7', 'reportes', 'generar', NULL, 'rep_generar')
ON CONFLICT DO NOTHING;
SELECT setval(pg_get_serial_sequence('inventario.permiso', 'permiso_id_permiso'), (SELECT MAX(permiso_id_permiso) FROM permiso));

-- Permisos por perfil
INSERT INTO perfil_permiso (perfil_id_perfil, permiso_id_permiso, perfil_permiso_activo) VALUES
  ('1', '1', TRUE),
  ('1', '2', TRUE),
  ('1', '3', TRUE),
  ('1', '4', TRUE),
  ('1', '5', TRUE),
  ('1', '6', TRUE),
  ('1', '7', TRUE),
  ('2', '1', TRUE),
  ('2', '2', TRUE),
  ('2', '3', TRUE),
  ('2', '6', TRUE),
  ('3', '1', TRUE),
  ('3', '2', TRUE),
  ('3', '3', TRUE),
  ('4', '1', TRUE),
  ('4', '2', TRUE),
  ('4', '3', TRUE),
  ('4', '4', TRUE)
ON CONFLICT DO NOTHING;

COMMIT;
