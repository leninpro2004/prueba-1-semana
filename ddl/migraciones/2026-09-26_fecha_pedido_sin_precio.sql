-- ============================================================
-- Migracion 2026-09-26 — Fecha de pedido sin precio obligatorio (sesion 7, CU-62)
-- Schema: inventario | Grupo 14
--
-- CU-62 mide el plazo real de entrega con la fecha de pedido del lote
-- (lote_fecha_pedido) contra su fecha de recepcion. La entrada de mercaderia
-- pedia la fecha de pedido pero la descartaba; ahora se guarda. El precio de
-- compra es opcional en la entrada, asi que deja de ser obligatorio aqui (un 0
-- seria un precio falso). El CHECK >= 0 se mantiene: NULL lo cumple.
--
-- Es IDEMPOTENTE: DROP NOT NULL sobre una columna que ya admite NULL no hace nada.
-- Los mismos cambios estan replicados en ddl/ddl_inventario.sql.
-- Respaldo previo: respaldo_antes_fecha_pedido_2026-09-26.dump (fuera del repo).
-- ============================================================

BEGIN;
SET search_path TO inventario;

ALTER TABLE lote_fecha_pedido ALTER COLUMN lote_fecha_pedido_precio_unitario DROP NOT NULL;

COMMENT ON COLUMN lote_fecha_pedido.lote_fecha_pedido_precio_unitario IS
  'Precio de compra informado al registrar el pedido; NULL si la entrada no lo informó. El historial de precios vive en historial_precio_material';
COMMENT ON COLUMN lote_fecha_pedido.lote_fecha_pedido_fecha_pedido IS
  'CU-62: fecha en que se hizo el pedido al proveedor; el plazo real usa la primera que no sea posterior a lote.lote_fecha_recepcion';

COMMIT;
