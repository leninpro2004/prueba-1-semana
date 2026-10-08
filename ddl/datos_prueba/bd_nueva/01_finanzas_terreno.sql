-- ============================================================
-- Datos de prueba (BD NUEVA) — 01 · Finanzas y Terreno (filas mínimas)
-- Grupo 14 | Generado por generador/generar.js: NO editar a mano (regenerar).
--
-- EXCEPCIÓN a la regla 7 (no escribir en finanzas ni terreno), autorizada por el usuario el 2026-09-30:
-- una BD nueva no tiene clientes, proyectos, empleados ni ventas, y sin ellos no se prueban los CU
-- de pedidos, ventas y carga. Todo es reconocible: códigos PRY-PRUEBA-*, correos .test.
--
-- Orden de carga: ddl_inventario.sql, ddl_terreno.sql, ddl_finanzas.sql,
-- catalogos_inventario.sql y luego 01..06 de esta carpeta (ver README.md).
-- Las fechas son relativas al día de carga (CURRENT_DATE - n).
-- ============================================================

-- El archivo es UTF-8: sin esto, psql en Windows lo lee como WIN1252 y daña los acentos
SET client_encoding = 'UTF8';

BEGIN;

-- Finanzas: tipos de cliente, clientes y proyectos
INSERT INTO finanzas.tipo_cliente (id_tipo_cliente, nombre_tipo_cliente, descripcion, activo)
OVERRIDING SYSTEM VALUE
VALUES
  (1, 'Empresa', 'Cliente con RUT de empresa (dato de prueba)', TRUE),
  (2, 'Persona natural', 'Cliente particular (dato de prueba)', TRUE);
INSERT INTO finanzas.cliente_financiero (id_cliente_financiero, rut_cliente, id_tipo_cliente, nombre_razon_social, telefono_principal, correo_principal, estado_cliente)
OVERRIDING SYSTEM VALUE
VALUES
  (1, '76111111-6', 1, 'Constructora Los Andes SpA', '+56 9 8111 1111', 'compras@losandes.test', 'activo'),
  (2, '76222222-1', 1, 'Inmobiliaria Costa Sur Ltda.', '+56 9 8222 2222', 'proyectos@costasur.test', 'activo'),
  (3, '12345678-5', 2, 'Roberto Figueroa Soto', '+56 9 8333 3333', 'rfigueroa@correo.test', 'activo'),
  (4, '76333333-7', 1, 'Hotel Mirador del Lago S.A.', '+56 9 8444 4444', 'mantencion@miradorlago.test', 'activo');
INSERT INTO finanzas.proyecto_financiero (id_proyecto_financiero, id_cliente_financiero, id_proyecto_terreno, codigo_proyecto, nombre_referencia, fecha_ingreso, estado_financiero, observacion)
OVERRIDING SYSTEM VALUE
VALUES
  (1, 1, 1, 'PRY-PRUEBA-01', 'Edificio Los Andes - Torre A', CURRENT_DATE - 120, 'activo', 'DATOS DE PRUEBA — Inventario G14'),
  (2, 2, 2, 'PRY-PRUEBA-02', 'Condominio Costa Sur - Etapa 2', CURRENT_DATE - 90, 'activo', 'DATOS DE PRUEBA — Inventario G14'),
  (3, 3, 3, 'PRY-PRUEBA-03', 'Casa Figueroa', CURRENT_DATE - 60, 'activo', 'DATOS DE PRUEBA — Inventario G14'),
  (4, 4, 4, 'PRY-PRUEBA-04', 'Hotel Mirador - Remodelación', CURRENT_DATE - 30, 'activo', 'DATOS DE PRUEBA — Inventario G14');

-- Finanzas: empleados (CU-125: responsable de la carga; Ricardo Toro está inactivo)
INSERT INTO finanzas.empleado_cargo (empleado_cargo_id_cargo, empleado_cargo_nombre)
OVERRIDING SYSTEM VALUE
VALUES
  (1, 'Operario de bodega'),
  (2, 'Chofer'),
  (3, 'Instaladora'),
  (4, 'Jefe de cuadrilla');
INSERT INTO finanzas.empleado_tipo_vinculo_laboral (empleado_tipo_vinculo_laboral_id_tipo_vinculo, empleado_tipo_vinculo_laboral_nombre, empleado_tipo_vinculo_laboral_seguro_cesantia)
OVERRIDING SYSTEM VALUE
VALUES
  (1, 'Indefinido', TRUE),
  (2, 'Plazo fijo', TRUE);
INSERT INTO finanzas.empleado (empleado_rut_empleado, empleado_nombre_empleado_primer_nombre_empleado, empleado_nombre_empleado_primer_apellido_empleado, empleado_estado, empleado_fecha_ingreso, empleado_cargo_id_cargo, empleado_tipo_vinculo_laboral_id_tipo_vinculo)
VALUES
  ('15111222-6', 'Pedro', 'Salinas', 'activo', CURRENT_DATE - 900, 1, 1),
  ('16222333-K', 'Luis', 'Carrasco', 'activo', CURRENT_DATE - 780, 2, 1),
  ('17333444-3', 'Marcela', 'Díaz', 'activo', CURRENT_DATE - 660, 3, 1),
  ('18444555-7', 'Diego', 'Morales', 'activo', CURRENT_DATE - 540, 4, 1),
  ('14555666-K', 'Ricardo', 'Toro', 'inactivo', CURRENT_DATE - 420, 1, 1);

-- Terreno: clientes, proyectos y especificaciones de puerta (ligadas a las recetas)
INSERT INTO terreno.cliente (rut_cliente, razon_social, contacto_principal, correo, telefono, es_cliente_b2c, es_cliente_b2b)
VALUES
  ('76111111-6', 'Constructora Los Andes SpA', 'Marcelo Olivares', 'compras@losandes.test', '+56 9 8111 1111', FALSE, TRUE),
  ('76222222-1', 'Inmobiliaria Costa Sur Ltda.', 'Daniela Paredes', 'proyectos@costasur.test', '+56 9 8222 2222', FALSE, TRUE),
  ('12345678-5', 'Roberto Figueroa Soto', 'Roberto Figueroa', 'rfigueroa@correo.test', '+56 9 8333 3333', TRUE, FALSE),
  ('76333333-7', 'Hotel Mirador del Lago S.A.', 'Claudia Riquelme', 'mantencion@miradorlago.test', '+56 9 8444 4444', FALSE, TRUE);
INSERT INTO terreno.proyecto (id_proyecto, codigo_proyecto, nombre_referencia, fecha_instalacion, fecha_ingreso, estado_operacional, estado_produccion, rut_cliente)
OVERRIDING SYSTEM VALUE
VALUES
  (1, 'PRY-PRUEBA-01', 'Edificio Los Andes - Torre A', CURRENT_DATE + 30, CURRENT_DATE - 120, 'en_curso', 'en_proceso', '76111111-6'),
  (2, 'PRY-PRUEBA-02', 'Condominio Costa Sur - Etapa 2', CURRENT_DATE + 45, CURRENT_DATE - 90, 'en_curso', 'en_proceso', '76222222-1'),
  (3, 'PRY-PRUEBA-03', 'Casa Figueroa', CURRENT_DATE + 20, CURRENT_DATE - 60, 'en_curso', 'en_proceso', '12345678-5'),
  (4, 'PRY-PRUEBA-04', 'Hotel Mirador - Remodelación', CURRENT_DATE + 60, CURRENT_DATE - 30, 'en_curso', 'en_proceso', '76333333-7');
INSERT INTO terreno.medidas_puerta (id_medidas, medidas_marco_ancho, medidas_marco_alto, medidas_marco_espesor, medidas_vano_vertical_ancho, medidas_vano_vertical_alto, medidas_vano_vertical_espesor, medidas_vano_horizontal_ancho, medidas_vano_horizontal_alto, medidas_vano_horizontal_espesor, medidas_alojamiento_vertical_alto, medidas_alojamiento_vertical_ancho, medidas_alojamiento_vertical_espesor, medidas_alojamiento_horizontal_alto, medidas_alojamiento_horizontal_ancho, medidas_alojamiento_horizontal_espesor, alojamiento_vertical, medidas_de_marco_ancho, medidas_de_marco_alto, medidas_de_marco_espesor)
OVERRIDING SYSTEM VALUE
VALUES
  (1, 90, 200, 10, 90, 200, 10, 90, 200, 10, 200, 90, 10, 200, 90, 10, 200, 90, 200, 10),
  (2, 160, 210, 10, 160, 210, 10, 160, 210, 10, 210, 160, 10, 210, 160, 10, 210, 160, 210, 10),
  (3, 90, 200, 10, 90, 200, 10, 90, 200, 10, 200, 90, 10, 200, 90, 10, 200, 90, 200, 10),
  (4, 80, 200, 10, 80, 200, 10, 80, 200, 10, 200, 80, 10, 200, 80, 10, 200, 80, 200, 10);
INSERT INTO terreno.especificacion_puerta (id_especificacion_puerta, modelo_puerta, zona, sentido_apertura, materialidad_vano, materialidad_marco_actual, solucion_marco, hoja_pasiva, hoja_activa, diseno_puerta, cubrejuntas, bisagras, id_medidas, producto_terminado_id)
OVERRIDING SYSTEM VALUE
VALUES
  (1, 'Estándar 90x200', 'acceso principal', 'derecha', 'hormigón', 'madera', 'reemplazo', 'no aplica', 'hoja activa acero', 'liso', TRUE, 'tres bisagras', 1, 1),
  (2, 'Doble hoja 160x210', 'acceso edificio', 'doble', 'hormigón', 'acero', 'reemplazo', 'hoja pasiva acero', 'hoja activa acero', 'liso', TRUE, 'seis bisagras', 2, 2),
  (3, 'Estándar con biometría', 'acceso departamento', 'izquierda', 'albañilería', 'madera', 'marco nuevo', 'no aplica', 'hoja activa acero', 'tablero', TRUE, 'tres bisagras', 3, 3),
  (4, 'Hoja de reposición', 'bodega', 'derecha', 'hormigón', 'acero', 'se mantiene', 'no aplica', 'hoja activa acero', 'liso', FALSE, 'tres bisagras', 4, 4);

SELECT setval(pg_get_serial_sequence('finanzas.tipo_cliente', 'id_tipo_cliente'), (SELECT MAX(id_tipo_cliente) FROM finanzas.tipo_cliente));
SELECT setval(pg_get_serial_sequence('finanzas.cliente_financiero', 'id_cliente_financiero'), (SELECT MAX(id_cliente_financiero) FROM finanzas.cliente_financiero));
SELECT setval(pg_get_serial_sequence('finanzas.proyecto_financiero', 'id_proyecto_financiero'), (SELECT MAX(id_proyecto_financiero) FROM finanzas.proyecto_financiero));
SELECT setval(pg_get_serial_sequence('finanzas.empleado_cargo', 'empleado_cargo_id_cargo'), (SELECT MAX(empleado_cargo_id_cargo) FROM finanzas.empleado_cargo));
SELECT setval(pg_get_serial_sequence('finanzas.empleado_tipo_vinculo_laboral', 'empleado_tipo_vinculo_laboral_id_tipo_vinculo'), (SELECT MAX(empleado_tipo_vinculo_laboral_id_tipo_vinculo) FROM finanzas.empleado_tipo_vinculo_laboral));
SELECT setval(pg_get_serial_sequence('terreno.proyecto', 'id_proyecto'), (SELECT MAX(id_proyecto) FROM terreno.proyecto));
SELECT setval(pg_get_serial_sequence('terreno.medidas_puerta', 'id_medidas'), (SELECT MAX(id_medidas) FROM terreno.medidas_puerta));
SELECT setval(pg_get_serial_sequence('terreno.especificacion_puerta', 'id_especificacion_puerta'), (SELECT MAX(id_especificacion_puerta) FROM terreno.especificacion_puerta));

COMMIT;
