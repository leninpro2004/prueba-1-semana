-- ============================================================
-- Datos de prueba (BD NUEVA) — 02 · Usuarios
-- Grupo 14 | Generado por generador/generar.js: NO editar a mano (regenerar).
--
-- Un usuario por rol, más un segundo de gerencia para probar el bloqueo de CU-42 sin trabar al primero.
-- Todos con la MISMA contraseña de prueba (ver README.md). Sirve también para la BD vacía.
--
-- Orden de carga: ddl_inventario.sql, ddl_terreno.sql, ddl_finanzas.sql,
-- catalogos_inventario.sql y luego 01..06 de esta carpeta (ver README.md).
-- Las fechas son relativas al día de carga (CURRENT_DATE - n).
-- ============================================================

-- El archivo es UTF-8: sin esto, psql en Windows lo lee como WIN1252 y daña los acentos
SET client_encoding = 'UTF8';

BEGIN;

INSERT INTO inventario.usuario (usuario_id_usuario, usuario_username, usuario_correo, usuario_estado_cuenta, usuario_nombre_completo_primer_nombre_usuario, usuario_nombre_completo_primer_apellido_usuario, usuario_es_gerencia, usuario_es_jop, usuario_es_tecnico, usuario_es_administrador, usuario_es_secretaria, perfil_id_perfil, usuario_fecha_de_creacion)
OVERRIDING SYSTEM VALUE
VALUES
  (1, 'gerente.prueba', 'gerente.prueba@puertasblindadas.test', 'activo', 'Gabriela', 'Rojas', TRUE, FALSE, FALSE, FALSE, FALSE, 1, CURRENT_DATE - 460 + TIME '09:00'),
  (2, 'jop.prueba', 'jop.prueba@puertasblindadas.test', 'activo', 'Javier', 'Muñoz', FALSE, TRUE, FALSE, FALSE, FALSE, 2, CURRENT_DATE - 460 + TIME '09:00'),
  (3, 'tecnico.prueba', 'tecnico.prueba@puertasblindadas.test', 'activo', 'Tomás', 'Soto', FALSE, FALSE, TRUE, FALSE, FALSE, 6, CURRENT_DATE - 460 + TIME '09:00'),
  (4, 'admin.prueba', 'admin.prueba@puertasblindadas.test', 'activo', 'Andrea', 'Fuentes', FALSE, FALSE, FALSE, TRUE, FALSE, 4, CURRENT_DATE - 460 + TIME '09:00'),
  (5, 'secretaria.prueba', 'secretaria.prueba@puertasblindadas.test', 'activo', 'Sofía', 'Pérez', FALSE, FALSE, FALSE, FALSE, TRUE, 5, CURRENT_DATE - 460 + TIME '09:00'),
  (6, 'gerente2.prueba', 'gerente2.prueba@puertasblindadas.test', 'activo', 'Gonzalo', 'Vera', TRUE, FALSE, FALSE, FALSE, FALSE, 1, CURRENT_DATE - 460 + TIME '09:00');
INSERT INTO inventario.usuario_contrasena (usuario_id_usuario, usuario_contrasena, es_temporal)
VALUES
  (1, '$2b$12$9vuDVQ..HFVaDPm9mBQ3q.DAM2NsZdFuvbcoTVXlG7pK.WKzlIdyK', FALSE),
  (2, '$2b$12$9vuDVQ..HFVaDPm9mBQ3q.DAM2NsZdFuvbcoTVXlG7pK.WKzlIdyK', FALSE),
  (3, '$2b$12$9vuDVQ..HFVaDPm9mBQ3q.DAM2NsZdFuvbcoTVXlG7pK.WKzlIdyK', FALSE),
  (4, '$2b$12$9vuDVQ..HFVaDPm9mBQ3q.DAM2NsZdFuvbcoTVXlG7pK.WKzlIdyK', FALSE),
  (5, '$2b$12$9vuDVQ..HFVaDPm9mBQ3q.DAM2NsZdFuvbcoTVXlG7pK.WKzlIdyK', FALSE),
  (6, '$2b$12$9vuDVQ..HFVaDPm9mBQ3q.DAM2NsZdFuvbcoTVXlG7pK.WKzlIdyK', FALSE);
SELECT setval(pg_get_serial_sequence('inventario.usuario', 'usuario_id_usuario'), (SELECT MAX(usuario_id_usuario) FROM inventario.usuario));

COMMIT;
