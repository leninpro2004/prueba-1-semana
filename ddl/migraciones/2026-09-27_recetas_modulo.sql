-- ============================================================
-- Migracion 2026-09-27 — Modulo de recetas (sesion 9, CU-102, D37)
-- Schema: inventario | Grupo 14
--
-- Las plantillas de insumos son las recetas por tipo de puerta (producto_terminado
-- + material_producto_terminado). Se agregan:
--  - producto_terminado_fecha_creacion: regla de edicion (24 h libre; despues
--    solo gerencia, con motivo).
--  - producto_terminado_reemplazada_por: al duplicar como nueva version, la
--    original queda inactiva y apunta a la nueva.
--  - material_producto_terminado.area_trabajo_id_area: area donde se consume el
--    insumo. NULL = cualquier area; la OT carga los de su area mas los NULL.
-- Las recetas existentes son anteriores al modulo: se fechan ayer para que la
-- migracion no les abra el plazo de 24 h.
--
-- Es IDEMPOTENTE. Replicada en ddl/ddl_inventario.sql.
-- Respaldo previo: respaldo_antes_recetas_2026-09-27.dump (fuera del repo).
-- ============================================================

BEGIN;
SET search_path TO inventario;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'inventario' AND table_name = 'producto_terminado'
                   AND column_name = 'producto_terminado_fecha_creacion') THEN
    ALTER TABLE producto_terminado ADD COLUMN producto_terminado_fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT now();
    UPDATE producto_terminado SET producto_terminado_fecha_creacion = now() - INTERVAL '1 day';
  END IF;
END $$;

ALTER TABLE producto_terminado ADD COLUMN IF NOT EXISTS producto_terminado_reemplazada_por BIGINT;
ALTER TABLE material_producto_terminado ADD COLUMN IF NOT EXISTS area_trabajo_id_area BIGINT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_prod_term_reemplazo') THEN
    ALTER TABLE producto_terminado ADD CONSTRAINT fk_prod_term_reemplazo
      FOREIGN KEY (producto_terminado_reemplazada_por) REFERENCES producto_terminado(producto_terminado_id_producto);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_mat_prod_area') THEN
    ALTER TABLE material_producto_terminado ADD CONSTRAINT fk_mat_prod_area
      FOREIGN KEY (area_trabajo_id_area) REFERENCES area_trabajo(area_trabajo_id_area);
  END IF;
END $$;

COMMIT;
