-- ============================================================
-- Migracion 2026-09-29 — Tipos de alerta del retiro de insumos (CU-126, sesion 13)
-- Schema: inventario | Grupo 14
--
-- D46 (corregida al implementar CU-126): las dos excepciones del picking van a
-- alerta_inventario con tipos propios, no a alerta_faltante_pedido (su generador de OT
-- las pisaria). El evaluador de stock no cierra ni cuenta estos tipos.
--   'ubicacion incorrecta' (Exc 1) → prioridad media
--   'faltante en retiro'   (Exc 3) → prioridad alta: bloquea el despacho
--
-- Solo agrega filas de catalogo: no cambia la estructura (el DDL no trae los catalogos
-- base; ver el hallazgo en docs/sprint/ddl-cambios.md). La prioridad se busca por nombre:
-- sus ids no coinciden entre la BD real y la de tests.
-- Es IDEMPOTENTE. Respaldo previo: respaldo_antes_cu126_2026-09-29.dump (fuera del repo).
-- ============================================================

BEGIN;
SET search_path TO inventario;

INSERT INTO alerta_inventario_tipo_alerta (alerta_inventario_tipo_alerta_nombre, alerta_inventario_nivel_prioridad_id)
SELECT t.nombre, p.alerta_inventario_nivel_prioridad_id_nivel_prioridad
FROM (VALUES ('ubicacion incorrecta', 'media'), ('faltante en retiro', 'alta')) AS t(nombre, prioridad)
JOIN alerta_inventario_nivel_prioridad p ON p.alerta_inventario_prioridad_nombre = t.prioridad
WHERE NOT EXISTS (
  SELECT 1 FROM alerta_inventario_tipo_alerta ta WHERE ta.alerta_inventario_tipo_alerta_nombre = t.nombre
);

COMMIT;
