-- ============================================================
-- Migracion 2026-09-28 — finanzas.item_nota_venta.sku_material (D40)
-- Schema: finanzas (de OTRO grupo) | Aplicada por Grupo 14 (Inventario)
--
-- EXCEPCION a la regla 7 ("no escribir en finanzas"), autorizada por el usuario
-- el 2026-09-28 porque Finanzas no alcanzo a agregarla y bloquea las sesiones 11
-- a 14 (CU-122, CU-124, CU-131). Detalle para Finanzas: docs/sprint/reporte-finanzas.md.
--
-- Una linea de venta puede ser una puerta (id_producto_terminado), un servicio
-- (solo descripcion) o, con esta columna, un MATERIAL VENDIDO SUELTO. Inventario
-- la lee para detectar insumos especiales vendidos (CU-122) y reservar stock de
-- las ventas aprobadas (CU-131). Mismo patron que detalle_cotizacion.sku_material.
--
-- Es IDEMPOTENTE (IF NOT EXISTS). Solo agrega una columna NULL: no cambia datos.
-- Respaldo previo: respaldo_antes_sku_material_2026-09-28.dump (fuera del repo).
-- ============================================================

BEGIN;

ALTER TABLE finanzas.item_nota_venta ADD COLUMN IF NOT EXISTS sku_material VARCHAR(16);

COMMENT ON COLUMN finanzas.item_nota_venta.sku_material IS
  'FK blanda hacia inventario.material — sin constraint cross-schema. Material vendido suelto; NULL en lineas de puerta (id_producto_terminado) o de servicio. Agregada por Inventario (Grupo 14) el 2026-09-28.';

CREATE INDEX IF NOT EXISTS idx_inv_sku_material ON finanzas.item_nota_venta(sku_material);

COMMIT;
