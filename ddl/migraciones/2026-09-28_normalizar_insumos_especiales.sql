-- ============================================================
-- Datos 2026-09-28 — Normalizar insumos especiales (CU-123, sesion 11)
-- Schema: inventario | Grupo 14
--
-- CU-123: un insumo especial / no rotativo (material_es_rotativo = FALSE) no
-- tiene umbrales de reposicion ni alertas de stock minimo. Desde este CU el
-- backend lo aplica al crear y editar; este script corrige lo que ya existia:
--   - umbrales (minimo, maximo y critico) en NULL. En la BD real al aplicarlo:
--     Pintura anticorrosiva gris (PIN-GRS) tenia 3 / 30 / 1.
--   - alertas activas de stock y reposicion de esos materiales → resueltas, con
--     la fecha de resolucion en su historial (se ven como "Sistema" en CU-55).
--     En la BD real: #49 (PIN-CUS) y #61 (PIN-BLA), ambas 'stock_critico'.
--     Las alertas por diferencia de conteo (CU-57) NO se tocan.
--
-- Sin cambios de estructura. Es IDEMPOTENTE: una segunda pasada no encuentra nada.
-- Respaldo previo: respaldo_antes_normalizar_especiales_2026-09-28.dump (fuera del repo).
-- ============================================================

BEGIN;
SET search_path TO inventario;

UPDATE material
SET material_stock_minimo = NULL, material_stock_maximo = NULL, material_stock_critico = NULL
WHERE material_es_rotativo = FALSE
  AND (material_stock_minimo IS NOT NULL OR material_stock_maximo IS NOT NULL OR material_stock_critico IS NOT NULL);

-- Primero el historial (usa el estado 'activa' para encontrarlas), luego la alerta
UPDATE historial_alerta ha SET historial_alerta_fecha_hora_resolucion = now()
FROM alerta_inventario a
JOIN material m ON m.material_sku = a.material_sku
WHERE ha.historial_alerta_id_historial = a.historial_alerta_id_historial
  AND m.material_es_rotativo = FALSE
  AND a.alerta_inventario_estado = 'activa'
  AND a.conteo_ciclico_id_conteo IS NULL
  AND ha.historial_alerta_fecha_hora_resolucion IS NULL;

UPDATE alerta_inventario a SET alerta_inventario_estado = 'resuelta'
FROM material m
WHERE m.material_sku = a.material_sku
  AND m.material_es_rotativo = FALSE
  AND a.alerta_inventario_estado = 'activa'
  AND a.conteo_ciclico_id_conteo IS NULL;

COMMIT;
