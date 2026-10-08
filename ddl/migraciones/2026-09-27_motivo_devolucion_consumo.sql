-- ============================================================
-- Migracion 2026-09-27 — Motivo 'devolucion_consumo' (sesion 8, antes de CU-71)
-- Schema: inventario | Grupo 14
--
-- Las entradas que devuelven consumo (correccion a la baja o anulacion, en OT y
-- en pinturas) se registraban con el motivo 'ajuste_inventario' y solo restaban
-- del consumo si tenian OT. Ahora llevan un motivo propio y restan siempre
-- (src/db/historico.js, consumoNeto). El backend falla con un mensaje claro si
-- este motivo no existe: una devolucion sin el inflaria el consumo en silencio.
--
-- Solo agrega una fila de catalogo: no cambia la estructura. Por eso no hay
-- cambio en ddl_inventario.sql (el DDL no trae los catalogos base; ver el
-- hallazgo en docs/sprint/ddl-cambios.md).
--
-- Es IDEMPOTENTE: el INSERT solo corre si el motivo no existe.
-- No hay datos que corregir: en la BD real no habia entradas con OT ni con
-- 'ajuste_inventario' al aplicarla.
-- Respaldo previo: respaldo_antes_devolucion_consumo_2026-09-27.dump (fuera del repo).
-- ============================================================

BEGIN;
SET search_path TO inventario;

INSERT INTO movimiento_inventario_motivo_movimiento (movimiento_inventario_motivo_movimiento_nombre)
SELECT 'devolucion_consumo'
WHERE NOT EXISTS (
  SELECT 1 FROM movimiento_inventario_motivo_movimiento
  WHERE movimiento_inventario_motivo_movimiento_nombre = 'devolucion_consumo'
);

COMMIT;
