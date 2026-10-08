-- ============================================================
-- Migracion 2026-09-28 — Lote y bodega de una reserva (CU-124, sesion 11)
-- Schema: inventario | Grupo 14
--
-- CU-124 reserva el LOTE recibido de un insumo especial para la venta que lo
-- esperaba. Hasta ahora reserva_inventario no guardaba lote ni bodega, y al
-- liberar se descontaba del lote mas nuevo con algo reservado: el total cuadraba,
-- pero el lote recibido podia quedar "reservado" para nadie. Con estas columnas,
-- liberar o anular devuelve primero el lote de la reserva.
--
-- Nullable: las reservas existentes (de OT, sin lote) siguen igual.
-- Es IDEMPOTENTE. Respaldo previo: respaldo_antes_reserva_lote_2026-09-28.dump (fuera del repo).
-- ============================================================

BEGIN;
SET search_path TO inventario;

ALTER TABLE reserva_inventario ADD COLUMN IF NOT EXISTS lote_id_lote     BIGINT;
ALTER TABLE reserva_inventario ADD COLUMN IF NOT EXISTS bodega_id_bodega BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_res_lote') THEN
    ALTER TABLE reserva_inventario ADD CONSTRAINT fk_res_lote FOREIGN KEY (lote_id_lote) REFERENCES lote(lote_id_lote);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_res_bodega') THEN
    ALTER TABLE reserva_inventario ADD CONSTRAINT fk_res_bodega FOREIGN KEY (bodega_id_bodega) REFERENCES bodega(bodega_id_bodega);
  END IF;
END $$;

COMMENT ON COLUMN reserva_inventario.lote_id_lote IS 'CU-124: lote reservado (NULL en reservas sin lote especifico)';
COMMENT ON COLUMN reserva_inventario.bodega_id_bodega IS 'CU-124: bodega del lote reservado';

CREATE INDEX IF NOT EXISTS idx_res_lote ON reserva_inventario(lote_id_lote) WHERE lote_id_lote IS NOT NULL;

COMMIT;
