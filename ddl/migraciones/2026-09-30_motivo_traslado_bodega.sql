-- ============================================================
-- Migracion 2026-09-30 — Motivo 'traslado_bodega' (sesion 15, punto 9: traslados)
-- Schema: inventario | Grupo 14
--
-- Los traslados entre bodegas pasan a un endpoint propio (POST /movimientos/traslado)
-- que registra cada par salida + entrada con este motivo. Colgarlo de la clasificacion
-- "Traslado" es lo que lo excluye del consumo, la rotacion y la reposicion
-- (src/db/historico.js). La clasificacion ya existia en la BD real, pero sin motivos:
-- una salida por traslado quedaba sin motivo y contaba como consumo.
--
-- Solo agrega filas de catalogo: no cambia la estructura (ver D60). El DDL no trae
-- los catalogos base (hallazgo de docs/sprint/ddl-cambios.md).
--
-- Es IDEMPOTENTE: crea la clasificacion si falta y el motivo solo si no existe.
-- No hay datos que corregir: en la BD real no habia traslados registrados.
-- Respaldo previo: respaldo_antes_motivo_traslado_2026-09-30.dump (fuera del repo).
-- ============================================================

BEGIN;
SET search_path TO inventario;

INSERT INTO movimiento_inventario_clasificacion_salida (movimiento_inventario_clasificacion_salida_nombre)
SELECT 'Traslado'
WHERE NOT EXISTS (
  SELECT 1 FROM movimiento_inventario_clasificacion_salida
  WHERE LOWER(movimiento_inventario_clasificacion_salida_nombre) = 'traslado'
);

INSERT INTO movimiento_inventario_motivo_movimiento
  (movimiento_inventario_motivo_movimiento_nombre, movimiento_inventario_clasificacion_salida_id_clasificacion_salida)
SELECT 'traslado_bodega', c.movimiento_inventario_clasificacion_salida_id_clasificacion_salida
FROM movimiento_inventario_clasificacion_salida c
WHERE LOWER(c.movimiento_inventario_clasificacion_salida_nombre) = 'traslado'
  AND NOT EXISTS (
    SELECT 1 FROM movimiento_inventario_motivo_movimiento
    WHERE movimiento_inventario_motivo_movimiento_nombre = 'traslado_bodega'
  );

COMMIT;
