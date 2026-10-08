-- ============================================================
-- Migracion 2026-09-29 — Usuario y motivo de las reservas (CU-131 y CU-132, sesion 14)
-- Schema: inventario | Grupo 14
--
-- D48. CU-131 pide registrar el usuario que crea la reserva; CU-132 muestra quien la creo y,
-- al liberar, registra el usuario y el motivo. reserva_inventario no tenia donde guardarlos
-- (solo la auditoria, que vive en finanzas y se corta a 100). 3 columnas NULLABLE: las
-- reservas anteriores quedan en NULL.
--
-- Es IDEMPOTENTE. Respaldo previo: respaldo_antes_cu131_2026-09-29.dump (fuera del repo).
-- ============================================================

BEGIN;
SET search_path TO inventario;

ALTER TABLE reserva_inventario ADD COLUMN IF NOT EXISTS usuario_id_usuario                   BIGINT;
ALTER TABLE reserva_inventario ADD COLUMN IF NOT EXISTS usuario_id_liberacion                BIGINT;
ALTER TABLE reserva_inventario ADD COLUMN IF NOT EXISTS reserva_inventario_motivo_liberacion TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_res_usr') THEN
    ALTER TABLE reserva_inventario ADD CONSTRAINT fk_res_usr
      FOREIGN KEY (usuario_id_usuario) REFERENCES usuario(usuario_id_usuario);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_res_usr_lib') THEN
    ALTER TABLE reserva_inventario ADD CONSTRAINT fk_res_usr_lib
      FOREIGN KEY (usuario_id_liberacion) REFERENCES usuario(usuario_id_usuario);
  END IF;
END $$;

COMMENT ON COLUMN reserva_inventario.usuario_id_usuario IS 'CU-131 (D48): usuario que creo la reserva. NULL en las anteriores a la sesion 14';
COMMENT ON COLUMN reserva_inventario.usuario_id_liberacion IS 'CU-132 (D48): usuario que la libero o anulo';
COMMENT ON COLUMN reserva_inventario.reserva_inventario_motivo_liberacion IS 'CU-132 (D48): motivo opcional de la liberacion o anulacion';

COMMIT;
