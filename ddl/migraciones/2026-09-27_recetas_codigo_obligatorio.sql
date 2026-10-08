-- ============================================================
-- Migracion 2026-09-27 — Codigo de receta obligatorio (sesion 9, CU-102, D37)
-- Schema: inventario | Grupo 14
--
-- El codigo identifica el tipo de puerta de forma estable (el nombre es
-- descriptivo y puede cambiar). Ya era UNIQUE; ahora tambien NOT NULL. El backend
-- lo guarda en mayusculas y al duplicar sugiere <codigo>-V<n>.
--
-- Precondicion: ninguna receta sin codigo (verificado en la BD real: 2 recetas,
-- PB-STD-001 y PB-DBL-001). Si alguna lo tuviera, el ALTER falla y no cambia nada.
-- Es IDEMPOTENTE: SET NOT NULL sobre una columna que ya lo es no hace nada.
-- Replicada en ddl/ddl_inventario.sql.
-- Respaldo previo: respaldo_antes_codigo_receta_2026-09-27.dump (fuera del repo).
-- ============================================================

BEGIN;
SET search_path TO inventario;

ALTER TABLE producto_terminado ALTER COLUMN producto_terminado_codigo_producto SET NOT NULL;

COMMIT;
