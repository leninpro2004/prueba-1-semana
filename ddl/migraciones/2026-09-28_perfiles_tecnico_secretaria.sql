-- ============================================================
-- Migracion 2026-09-28 — Perfiles 'tecnico' y 'secretaria' (sesion 10, CU-108)
-- Schema: inventario | Grupo 14
--
-- V1 (docs/sprint/decisiones.md): las reglas de integracion entre modulos de
-- CU-108 se guardan en perfil_permiso, y el perfil de un usuario se obtiene por
-- el NOMBRE de su rol. La tabla perfil no tenia los roles tecnico y secretaria,
-- que ya existen en el sistema (booleanos usuario_es_*): se registran aqui.
--
-- Solo agrega filas: no cambia la estructura. Por eso no hay cambio en
-- ddl_inventario.sql (el DDL no trae los catalogos base).
--
-- Es IDEMPOTENTE: cada INSERT solo corre si el perfil no existe.
-- Respaldo previo: respaldo_antes_perfiles_cu108_2026-09-28.dump (fuera del repo).
-- ============================================================

BEGIN;
SET search_path TO inventario;

INSERT INTO perfil (perfil_nombre_perfil, perfil_descripcion)
SELECT v.nombre, v.descripcion
FROM (VALUES ('tecnico',    'Técnico'),
             ('secretaria', 'Secretaría')) AS v(nombre, descripcion)
WHERE NOT EXISTS (SELECT 1 FROM perfil p WHERE p.perfil_nombre_perfil = v.nombre);

COMMIT;
