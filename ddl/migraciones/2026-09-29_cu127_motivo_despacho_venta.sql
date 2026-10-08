-- ============================================================
-- Migracion 2026-09-29 — Motivo 'despacho_venta' (CU-127, sesion 13)
-- Schema: inventario | Grupo 14
--
-- La salida definitiva de un pedido de instalacion (CU-127) se registra como salida con
-- este motivo. Cuenta como CONSUMO (decision del usuario, sesion 13): es material que deja
-- la empresa, y asi entra en la rotacion (CU-71) y en la cobertura de reposicion (CU-47).
-- Toma la clasificacion del motivo 'consumo_produccion': el nombre de la clasificacion no
-- coincide entre la BD real ('produccion') y la de tests ('consumo').
--
-- Solo agrega una fila de catalogo (el DDL no trae los catalogos base; ver el hallazgo en
-- docs/sprint/ddl-cambios.md). Es IDEMPOTENTE.
-- Respaldo previo: respaldo_antes_cu127_2026-09-29.dump (fuera del repo).
-- ============================================================

BEGIN;
SET search_path TO inventario;

INSERT INTO movimiento_inventario_motivo_movimiento (movimiento_inventario_motivo_movimiento_nombre,
       movimiento_inventario_clasificacion_salida_id_clasificacion_sal)
SELECT 'despacho_venta', movimiento_inventario_clasificacion_salida_id_clasificacion_sal
FROM movimiento_inventario_motivo_movimiento
WHERE movimiento_inventario_motivo_movimiento_nombre = 'consumo_produccion'
  AND NOT EXISTS (SELECT 1 FROM movimiento_inventario_motivo_movimiento
                  WHERE movimiento_inventario_motivo_movimiento_nombre = 'despacho_venta');

COMMIT;
