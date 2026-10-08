-- ============================================================
-- Semilla de la BD de test — Puertas Blindadas
--
-- Datos MÍNIMOS y EXPLÍCITOS: cada test sabe exactamente qué existe.
-- No es una copia de la base real a propósito: un test que depende de
-- datos que nadie controla se rompe cuando alguien toca esos datos.
--
-- Se ejecuta entero antes de cada archivo de tests (ver db.js).
-- ============================================================

SET search_path TO inventario;

-- ── Catálogos ───────────────────────────────────────────────
INSERT INTO material_unidad_medida (material_unidad_medida_id_unidad_medida, material_unidad_medida_nombre)
OVERRIDING SYSTEM VALUE VALUES (1, 'unidad'), (2, 'litro'), (3, 'kilogramo');

INSERT INTO material_categoria_general (material_categoria_general_id_categoria_general, material_categoria_general_nombre)
OVERRIDING SYSTEM VALUE VALUES (1, 'MateriaPrima'), (2, 'MaterialCrítico');

INSERT INTO material_categoria_funcional (material_categoria_funcional_id_categoria_funcional, material_categoria_funcional_nombre)
OVERRIDING SYSTEM VALUE VALUES (1, 'Herramienta'), (2, 'Insumo');

INSERT INTO movimiento_inventario_tipo_movimiento (movimiento_inventario_tipo_movimiento_id_tipo_movimiento, movimiento_inventario_tipo_movimiento_nombre)
OVERRIDING SYSTEM VALUE VALUES (1, 'entrada'), (2, 'salida'), (3, 'ajuste');

INSERT INTO movimiento_inventario_clasificacion_salida (movimiento_inventario_clasificacion_salida_id_clasificacion_sal, movimiento_inventario_clasificacion_salida_nombre)
OVERRIDING SYSTEM VALUE VALUES (1, 'consumo'), (2, 'perdida'), (3, 'ajuste_inventario');

INSERT INTO movimiento_inventario_motivo_movimiento
  (movimiento_inventario_motivo_movimiento_id_motivo_movimiento,
   movimiento_inventario_motivo_movimiento_nombre,
   movimiento_inventario_clasificacion_salida_id_clasificacion_sal)
OVERRIDING SYSTEM VALUE VALUES
  (1, 'compra_proveedor',    NULL),
  (2, 'consumo_produccion',  1),
  (3, 'merma',               2),
  (4, 'ajuste_inventario',   3),
  (5, 'reverso_autorizado',  NULL),  -- CU-44: motivo del movimiento inverso
  (6, 'devolucion_consumo',  NULL),  -- devoluciones de consumo de OT y pinturas: restan del consumo
  (7, 'despacho_venta',      1);     -- CU-127: salida de un pedido de instalación (cuenta como consumo)

-- Catalogo de alertas. Los nombres son los CANONICOS que quedaron tras consolidar
-- los duplicados del 2026-09-20: el generador los busca por match EXACTO sobre el
-- nombre normalizado (los guiones bajos cuentan como espacios).
INSERT INTO alerta_inventario_nivel_prioridad (alerta_inventario_nivel_prioridad_id_nivel_prioridad,
                                               alerta_inventario_prioridad_nombre)
OVERRIDING SYSTEM VALUE VALUES (1, 'urgente'), (2, 'alta'), (3, 'media');

INSERT INTO alerta_inventario_tipo_alerta (alerta_inventario_tipo_alerta_id_tipo_alerta,
                                           alerta_inventario_tipo_alerta_nombre,
                                           alerta_inventario_nivel_prioridad_id)
OVERRIDING SYSTEM VALUE VALUES
  (2, 'stock_critico',     1),
  (5, 'tiempo reposicion', 3),
  (6, 'stock bajo minimo', 2),
  (7, 'diferencia inventario',         2),   -- CU-57
  (8, 'diferencia inventario critica', 1),   -- CU-57
  (9, 'ubicacion incorrecta',          3),   -- CU-126 Exc 1
  (10, 'faltante en retiro',           2);   -- CU-126 Exc 3

-- CU-43: tolerancias de conteo (los mismos valores iniciales que la migracion)
INSERT INTO tolerancia_conteo (tolerancia_conteo_tipo, tolerancia_conteo_tolerancia_pct, tolerancia_conteo_umbral_critico_pct)
VALUES ('critico', 1, 5), ('no_critico', 5, 20);

INSERT INTO area_trabajo (area_trabajo_id_area, area_trabajo_nombre_area, area_trabajo_clasificacion, area_trabajo_activo)
OVERRIDING SYSTEM VALUE VALUES
  (1, 'Corte', 'produccion', TRUE),
  (2, 'Pintura', 'produccion', TRUE),
  (3, 'Instalación', 'instalacion', TRUE);   -- CU-120: insumos que viajan a terreno

-- ── Estructura ──────────────────────────────────────────────
INSERT INTO bodega (bodega_id_bodega, bodega_nombre_bodega, bodega_estado)
OVERRIDING SYSTEM VALUE VALUES (1, 'Bodega Test', 'activo'), (2, 'Bodega Secundaria', 'activo');

INSERT INTO anaquel (anaquel_id_anaquel, anaquel_descripcion, bodega_id_bodega)
OVERRIDING SYSTEM VALUE VALUES (1, 'Estante A', 1);

-- El proveedor 1 trae rubro/tipo/pais/contacto cargados a proposito: son los campos
-- que una actualizacion parcial borraba en silencio (ver tests/proveedores.test.js).
INSERT INTO proveedor (proveedor_id_proveedor, proveedor_razon_social, proveedor_estado,
                       proveedor_rubro, proveedor_tipo_proveedor, proveedor_pais,
                       proveedor_contacto_primer_nombre, proveedor_contacto_primer_apellido)
OVERRIDING SYSTEM VALUE VALUES
  (1, 'Proveedor Test', 'activo', 'Aceros', 'distribuidor', 'Chile', 'Ana', 'Rojas'),
  (2, 'Proveedor Sin Uso', 'activo', 'Varios', NULL, NULL, NULL, NULL);

-- ── Usuarios: uno de gerencia y uno de JOP ──────────────────
INSERT INTO usuario (usuario_id_usuario, usuario_username, usuario_estado_cuenta,
                     usuario_es_gerencia, usuario_es_tecnico, usuario_es_jop,
                     usuario_es_administrador, usuario_es_secretaria)
OVERRIDING SYSTEM VALUE VALUES
  (1, 'gerente.test', 'activo', TRUE,  FALSE, FALSE, FALSE, FALSE),
  (2, 'jop.test',     'activo', FALSE, FALSE, TRUE,  FALSE, FALSE);

-- CU-108 (V1): perfiles por nombre de rol. 'bodeguero' no tiene usuarios a proposito.
INSERT INTO perfil (perfil_id_perfil, perfil_nombre_perfil)
OVERRIDING SYSTEM VALUE VALUES (1, 'gerencia'), (2, 'jop'), (3, 'bodeguero');

-- ── Materiales ──────────────────────────────────────────────
-- MAT-FIFO: dos lotes, para probar el descuento FIFO
-- MAT-CRIT: material crítico, para las mermas que requieren aprobación
-- MAT-UNO:  una sola unidad, para probar stock insuficiente
INSERT INTO material (material_sku, material_nombre_material, material_material_critico,
                      material_es_rotativo, material_estado, material_unidad_medida_id_unidad_medida,
                      material_categoria_general_id_categoria_general,
                      material_categoria_funcional_id_categoria_funcional,
                      material_es_herramienta, material_stock_minimo, material_stock_critico)
VALUES
  ('MAT-FIFO', 'Material con dos lotes', FALSE, TRUE, 'activo', 1, 1, 2, FALSE, 5, 2),
  ('MAT-CRIT', 'Material crítico',       TRUE,  TRUE, 'activo', 1, 2, 2, FALSE, 5, 2),
  ('MAT-UNO',  'Material con 1 unidad',  FALSE, TRUE, 'activo', 1, 1, 2, FALSE, NULL, NULL),
  ('MAT-HERR', 'Herramienta de prueba',  FALSE, TRUE, 'activo', 1, 1, 1, TRUE,  NULL, NULL);

-- OPUS-16: una pintura, en KILOGRAMOS (unidad 3). El envase se pesa en gramos y
-- el consumo se descuenta dividiendo por 1000.
INSERT INTO material (material_sku, material_nombre_material, material_material_critico,
                      material_es_rotativo, material_estado, material_unidad_medida_id_unidad_medida,
                      material_categoria_general_id_categoria_general,
                      material_categoria_funcional_id_categoria_funcional,
                      material_es_herramienta, material_stock_minimo, material_stock_critico,
                      es_material_pintura_no_custom, material_pintura_no_custom)
VALUES
  ('PIN-TEST', 'Pintura de prueba', FALSE, TRUE, 'activo', 3, 1, 2, FALSE, NULL, NULL, TRUE, 'blanco');

INSERT INTO material_proveedor (material_sku, proveedor_id_proveedor,
                                material_proveedor_precio_referencial,
                                material_proveedor_proveedor_principal)
VALUES ('MAT-FIFO', 1, 1000, TRUE), ('MAT-CRIT', 1, 5000, TRUE);

-- ── Producto terminado y su receta (OPUS-19) ────────────────
-- PB-TEST tiene DOS materiales con merma distinta, para comprobar que la cantidad
-- que llega a la OT es cantidad * (1 + merma): 2*1.25 = 2.5 y 4*1 = 4.
INSERT INTO producto_terminado (producto_terminado_id_producto, producto_terminado_codigo_producto,
                                producto_terminado_nombre_producto, producto_terminado_tipo_producto,
                                producto_terminado_activo)
OVERRIDING SYSTEM VALUE VALUES
  (1, 'PB-TEST',  'Puerta de prueba',      'simple', TRUE),
  (2, 'PB-VACIA', 'Producto sin materiales', 'simple', TRUE);

-- R1: el área es obligatoria. Las dos filas son de Corte (1), el área de las OT 1 y 3.
INSERT INTO material_producto_terminado (material_sku, producto_terminado_id_producto,
                                         material_producto_terminado_cantidad_estimada,
                                         material_producto_terminado_merma_estimada,
                                         area_trabajo_id_area)
VALUES
  ('MAT-FIFO', 1, 2, 0.25, 1),
  ('MAT-CRIT', 1, 4, 0,    1);

-- ── Lotes y stock ───────────────────────────────────────────
-- El lote 1 es más antiguo que el 2: FIFO debe consumir primero el 1.
INSERT INTO lote (lote_id_lote, lote_numero_lote, lote_fecha_ingreso, lote_estado, proveedor_id_proveedor)
OVERRIDING SYSTEM VALUE VALUES
  (1, 'LOTE-VIEJO',  '2026-01-01', 'activo', 1),
  (2, 'LOTE-NUEVO',  '2026-06-01', 'activo', 1),
  (3, 'LOTE-CRIT',   '2026-01-15', 'activo', 1),
  (4, 'LOTE-UNO',    '2026-01-20', 'activo', 1),
  (5, 'LOTE-PIN',    '2026-02-01', 'activo', 1);

INSERT INTO inventario_bodega (material_sku, lote_id_lote, bodega_id_bodega,
                               inventario_bodega_cantidad_fisica, inventario_bodega_cantidad_reservada)
VALUES
  ('MAT-FIFO', 1, 1, 10, 0),   -- lote viejo: 10 libres
  ('MAT-FIFO', 2, 1, 20, 5),   -- lote nuevo: 20 físicas, 5 reservadas -> 15 libres
  ('MAT-CRIT', 3, 1, 8,  0),
  ('MAT-UNO',  4, 1, 1,  0),
  ('MAT-HERR', 4, 1, 3,  0),
  ('PIN-TEST', 5, 1, 20, 0);   -- 20 kg de pintura, para OPUS-16

-- ── Terreno: cliente y proyecto ─────────────────────────────
SET search_path TO terreno;
INSERT INTO cliente (rut_cliente, razon_social, contacto_principal, correo, telefono,
                     es_cliente_b2c, es_cliente_b2b)
VALUES ('11111111-1', 'Cliente Test', 'Contacto Test', 'cliente@test.cl', '+56900000000', TRUE, FALSE);

INSERT INTO proyecto (id_proyecto, codigo_proyecto, nombre_referencia, fecha_instalacion,
                      fecha_ingreso, estado_operacional, estado_produccion, rut_cliente)
OVERRIDING SYSTEM VALUE
VALUES (1, 'PRY-TEST', 'Proyecto de prueba', '2026-12-01', '2026-01-01', 'en_curso', 'en_proceso', '11111111-1');

-- ── Especificación de puerta, con su producto (OPUS-19) ─────
-- Es el eslabón OT -> especificacion_puerta -> producto_terminado -> receta.
INSERT INTO medidas_puerta (
  id_medidas, medidas_marco_ancho, medidas_marco_alto, medidas_marco_espesor,
  medidas_vano_vertical_ancho, medidas_vano_vertical_alto, medidas_vano_vertical_espesor,
  medidas_vano_horizontal_ancho, medidas_vano_horizontal_alto, medidas_vano_horizontal_espesor,
  medidas_alojamiento_vertical_alto, medidas_alojamiento_vertical_ancho, medidas_alojamiento_vertical_espesor,
  medidas_alojamiento_horizontal_alto, medidas_alojamiento_horizontal_ancho, medidas_alojamiento_horizontal_espesor,
  alojamiento_vertical, medidas_de_marco_ancho, medidas_de_marco_alto, medidas_de_marco_espesor)
OVERRIDING SYSTEM VALUE VALUES
  (1, 90,200,10, 90,200,10, 90,200,10, 200,90,10, 200,90,10, 200, 90,200,10);

INSERT INTO especificacion_puerta (id_especificacion_puerta, modelo_puerta, zona, sentido_apertura,
                                   materialidad_vano, materialidad_marco_actual, solucion_marco,
                                   hoja_pasiva, hoja_activa, diseno_puerta, cubrejuntas, bisagras,
                                   id_medidas, producto_terminado_id)
OVERRIDING SYSTEM VALUE VALUES
  (1, 'Modelo Test', 'norte', 'derecha', 'hormigon', 'madera', 'reemplazo',
   'no aplica', 'hoja activa acero', 'liso', TRUE, 'tres bisagras', 1, 1);

-- ── Finanzas: empleado (para asignar herramientas) ──────────
SET search_path TO finanzas;
INSERT INTO empleado_cargo (empleado_cargo_id_cargo, empleado_cargo_nombre)
OVERRIDING SYSTEM VALUE VALUES (1, 'Operario');

INSERT INTO empleado_tipo_vinculo_laboral (empleado_tipo_vinculo_laboral_id_tipo_vinculo,
                                           empleado_tipo_vinculo_laboral_nombre,
                                           empleado_tipo_vinculo_laboral_seguro_cesantia)
OVERRIDING SYSTEM VALUE VALUES (1, 'Indefinido', TRUE);

INSERT INTO empleado (empleado_rut_empleado, empleado_nombre_empleado_primer_nombre_empleado,
                      empleado_nombre_empleado_primer_apellido_empleado, empleado_estado,
                      empleado_fecha_ingreso, empleado_cargo_id_cargo,
                      empleado_tipo_vinculo_laboral_id_tipo_vinculo)
VALUES ('22222222-2', 'Empleado', 'Test', 'activo', '2024-01-01', 1, 1);

-- ── Órdenes de trabajo ──────────────────────────────────────
SET search_path TO inventario;
-- OT 1: abierta, con estimados. OT 2: cerrada, para probar los rechazos.
INSERT INTO orden_trabajo (orden_trabajo_id_orden, orden_trabajo_fecha_hora, orden_trabajo_estado,
                           area_trabajo_id_area, usuario_id_usuario, proyecto_id_proyecto)
OVERRIDING SYSTEM VALUE VALUES
  (1, '2026-06-01', 'en_curso',  1, 2, 1),
  (2, '2026-06-02', 'finalizada', 1, 2, 1);

-- OT 3: abierta y vinculada a una especificación, para probar la carga de receta.
INSERT INTO orden_trabajo (orden_trabajo_id_orden, orden_trabajo_fecha_hora, orden_trabajo_estado,
                           area_trabajo_id_area, usuario_id_usuario, proyecto_id_proyecto,
                           especificaciones_puerta_id_especificacion_puerta)
OVERRIDING SYSTEM VALUE VALUES (3, '2026-06-03', 'en_curso', 1, 2, 1, 1);

INSERT INTO material_orden_trabajo (material_sku, orden_trabajo_id_orden,
                                    material_orden_trabajo_consumo_estimado,
                                    material_orden_trabajo_consumo_real)
VALUES
  ('MAT-FIFO', 1, 12, NULL),
  ('MAT-CRIT', 1, 4,  NULL);

-- ── Reserva que respalda las 5 unidades reservadas de MAT-FIFO ──────────
-- La semilla TIENE que cumplir el invariante del sistema (reservas activas ==
-- stock reservado). Un fixture que ya nace descuadrado hace imposible distinguir
-- un bug real del ruido de los datos de prueba.
INSERT INTO reserva_inventario (reserva_inventario_id_reserva, reserva_inventario_cantidad_reservada,
                                reserva_inventario_fecha_reserva, reserva_inventario_estado_reserva,
                                material_sku, proyecto_id_proyecto, orden_trabajo_id_orden)
OVERRIDING SYSTEM VALUE VALUES (1, 5, '2026-06-01', 'activa', 'MAT-FIFO', 1, 1);
