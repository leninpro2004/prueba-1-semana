-- ============================================================
-- Migracion 2026-09-29 — Retiro (CU-126) y carga (CU-125) del pedido de instalacion (sesion 13)
-- Schema: inventario | Grupo 14
--
-- Decisiones de la sesion 13 (docs/sprint/decisiones.md, D46 y D47). Se reutilizan las tablas
-- de la sesion 12: sin tablas nuevas, solo 4 columnas NULLABLE.
--
--  1. preparacion_pedido_detalle: el retiro (picking) POR INSUMO. Cantidad retirada (acumula
--     los retiros parciales), fecha y usuario del ultimo retiro. NULL = pendiente de retiro.
--  2. preparacion_pedido_estado: el trabajador que carga el transporte (CU-125), por RUT
--     (FK blanda hacia finanzas.empleado). Una fila 'en_carga' por responsable; el usuario
--     que lo registro queda en usuario_id_usuario. En pantalla se muestra el nombre, no el RUT.
--
-- Es IDEMPOTENTE. Respaldo previo: respaldo_antes_retiro_carga_2026-09-29.dump (fuera del repo).
-- ============================================================

BEGIN;
SET search_path TO inventario;

-- 1. Retiro por insumo
ALTER TABLE preparacion_pedido_detalle ADD COLUMN IF NOT EXISTS preparacion_pedido_detalle_cantidad_retirada NUMERIC(12,4);
ALTER TABLE preparacion_pedido_detalle ADD COLUMN IF NOT EXISTS preparacion_pedido_detalle_fecha_retiro      TIMESTAMPTZ;
ALTER TABLE preparacion_pedido_detalle ADD COLUMN IF NOT EXISTS usuario_id_retiro                            BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_prep_ped_det_retirada') THEN
    ALTER TABLE preparacion_pedido_detalle ADD CONSTRAINT ck_prep_ped_det_retirada
      CHECK (preparacion_pedido_detalle_cantidad_retirada IS NULL OR preparacion_pedido_detalle_cantidad_retirada >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_prep_ped_det_usr_retiro') THEN
    ALTER TABLE preparacion_pedido_detalle ADD CONSTRAINT fk_prep_ped_det_usr_retiro
      FOREIGN KEY (usuario_id_retiro) REFERENCES usuario(usuario_id_usuario);
  END IF;
END $$;

COMMENT ON COLUMN preparacion_pedido_detalle.preparacion_pedido_detalle_cantidad_retirada IS 'CU-126 (D46): cantidad retirada del anaquel; acumula los retiros parciales. NULL = pendiente';
COMMENT ON COLUMN preparacion_pedido_detalle.preparacion_pedido_detalle_fecha_retiro      IS 'CU-126 (D46): hora del ultimo retiro de este insumo';
COMMENT ON COLUMN preparacion_pedido_detalle.usuario_id_retiro                            IS 'CU-126 (D46): usuario que hizo el ultimo retiro de este insumo';

-- 2. Responsable de la carga
ALTER TABLE preparacion_pedido_estado ADD COLUMN IF NOT EXISTS empleado_rut VARCHAR(12);
COMMENT ON COLUMN preparacion_pedido_estado.empleado_rut IS 'CU-125 (D47): FK blanda hacia finanzas.empleado. Trabajador que carga (una fila en_carga por responsable)';

COMMIT;
