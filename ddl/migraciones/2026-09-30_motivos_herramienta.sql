-- ============================================================
-- Migracion 2026-09-30 — Motivos 'perdida_herramienta' y 'baja_herramienta' (sesion 15, D52)
-- Schema: inventario | Grupo 14
--
-- Cerrar una asignacion de herramienta como "perdida" o "dada de baja" descuenta ahora
-- el stock con una salida por merma (D52). Cada caso tiene su motivo, colgado de la
-- clasificacion "merma", para que cuente como merma en los reportes y no como consumo.
--
-- Solo agrega filas de catalogo (tambien van en ddl/catalogos_inventario.sql).
-- Es IDEMPOTENTE. Respaldo previo: respaldo_antes_motivos_herramienta_2026-09-30.dump.
-- ============================================================

BEGIN;
SET search_path TO inventario;

INSERT INTO movimiento_inventario_motivo_movimiento
  (movimiento_inventario_motivo_movimiento_nombre, movimiento_inventario_clasificacion_salida_id_clasificacion_salida)
SELECT m.nombre, c.movimiento_inventario_clasificacion_salida_id_clasificacion_salida
FROM (VALUES ('perdida_herramienta'), ('baja_herramienta')) AS m(nombre)
JOIN movimiento_inventario_clasificacion_salida c ON LOWER(c.movimiento_inventario_clasificacion_salida_nombre) = 'merma'
WHERE NOT EXISTS (
  SELECT 1 FROM movimiento_inventario_motivo_movimiento x WHERE x.movimiento_inventario_motivo_movimiento_nombre = m.nombre
);

COMMIT;
