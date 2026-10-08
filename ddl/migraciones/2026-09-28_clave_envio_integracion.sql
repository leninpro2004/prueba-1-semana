-- ============================================================
-- Migracion 2026-09-28 — Clave de envio de los movimientos de otros modulos (CU-107, sesion 10)
-- Schema: inventario | Grupo 14
--
-- Idempotencia de POST /api/integracion/movimientos: el modulo de origen asigna
-- una clave unica a cada envio. Si reintenta (timeout, corte de red), el mismo
-- envio no registra un segundo movimiento ni mueve el stock dos veces.
--
-- Unica POR MODULO (Terreno y Finanzas no chocan). Nullable: los movimientos
-- propios de Inventario no la usan y no cambian.
-- Es IDEMPOTENTE. Respaldo previo: respaldo_antes_clave_envio_2026-09-28.dump (fuera del repo).
-- ============================================================

BEGIN;
SET search_path TO inventario;

ALTER TABLE movimiento_inventario ADD COLUMN IF NOT EXISTS movimiento_inventario_clave_envio VARCHAR(100);

COMMENT ON COLUMN movimiento_inventario.movimiento_inventario_clave_envio IS
  'CU-107: clave unica que el modulo de origen asigna a cada envio. Un reenvio con la misma clave no registra otro movimiento.';

CREATE UNIQUE INDEX IF NOT EXISTS uk_mov_inv_clave_envio
  ON movimiento_inventario (movimiento_inventario_modulo_origen, movimiento_inventario_clave_envio)
  WHERE movimiento_inventario_clave_envio IS NOT NULL;

COMMIT;
