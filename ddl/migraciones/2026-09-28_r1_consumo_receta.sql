-- ============================================================
-- Migracion 2026-09-28 — R1: consumo en la OT desde la receta
-- Schema: inventario | Grupo 14
--
-- Decision R1 (docs/sprint/decisiones.md):
--  1. La OT guarda la receta que cargo (su id ya es la version: versionar = duplicar)
--     y para cuantas puertas.
--  2. El area de cada insumo de la receta pasa a ser OBLIGATORIA (cambia D37): un
--     insumo sin area se cargaria en todas las OT de la puerta (una por area) y se
--     descontaria varias veces. Las filas sin area se completan antes del NOT NULL
--     con las areas acordadas con el usuario.
--
-- Es IDEMPOTENTE. Respaldo previo: respaldo_antes_r1_2026-09-28.dump (fuera del repo).
-- ============================================================

BEGIN;
SET search_path TO inventario;

-- 1. Receta y cantidad de puertas de la OT
ALTER TABLE orden_trabajo ADD COLUMN IF NOT EXISTS producto_terminado_id_producto BIGINT;
ALTER TABLE orden_trabajo ADD COLUMN IF NOT EXISTS orden_trabajo_cantidad_puertas INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ot_producto') THEN
    ALTER TABLE orden_trabajo ADD CONSTRAINT fk_ot_producto
      FOREIGN KEY (producto_terminado_id_producto) REFERENCES producto_terminado(producto_terminado_id_producto);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ot_cantidad_puertas') THEN
    ALTER TABLE orden_trabajo ADD CONSTRAINT ck_ot_cantidad_puertas CHECK (orden_trabajo_cantidad_puertas > 0);
  END IF;
END $$;

COMMENT ON COLUMN orden_trabajo.producto_terminado_id_producto IS 'R1: receta cargada en la OT (el id es la version)';
COMMENT ON COLUMN orden_trabajo.orden_trabajo_cantidad_puertas IS 'R1: cantidad de puertas para la que se cargo la receta';

-- 2. Area obligatoria por insumo. Filas actuales sin area (acordado con el usuario):
--    ACR-001 y TUB-040 -> Corte y habilitacion; PIN-BLA -> Pintura.
UPDATE material_producto_terminado mpt SET area_trabajo_id_area = a.area_trabajo_id_area
FROM area_trabajo a
WHERE mpt.area_trabajo_id_area IS NULL
  AND ((mpt.material_sku IN ('ACR-001', 'TUB-040') AND a.area_trabajo_nombre_area = 'Corte y habilitación')
    OR (mpt.material_sku = 'PIN-BLA' AND a.area_trabajo_nombre_area = 'Pintura'));

-- Si quedara alguna fila sin area, el NOT NULL falla y la migracion se revierte entera.
ALTER TABLE material_producto_terminado ALTER COLUMN area_trabajo_id_area SET NOT NULL;

COMMIT;
