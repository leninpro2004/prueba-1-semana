-- ============================================================
-- Migracion de DATOS 2026-09-25 — CU-30 (sesion 3)
-- Schema: inventario | Grupo 14
--
-- No cambia la estructura: la tabla material_codigo_barras, su UNIQUE y la
-- secuencia seq_codigo_barras_interno ya existen desde la migracion del 2026-09-24.
--
-- Asigna el codigo de barras interno (decision D3: solo digitos, prefijo 2,
-- '2' + secuencia a 11 digitos) a cada material que todavia no tiene uno.
-- Los materiales creados desde CU-30 ya nacen con su codigo.
--
-- Es IDEMPOTENTE: la segunda vez no encuentra materiales sin codigo y no hace nada.
--
-- Antes de esta migracion se borraron a mano (con respaldo previo,
-- respaldo_antes_cu30_2026-09-25.dump) 4 codigos EAN de relleno que no eran
-- reales: 7891234560001 (ACR-001), 7891234560002 (ACR-016),
-- 7891234560010 (PIN-BLA) y 7891234560011 (PIN-GRS).
-- ============================================================

BEGIN;
SET search_path TO inventario;

INSERT INTO material_codigo_barras (material_sku, material_codigo_barras)
SELECT m.material_sku,
       '2' || lpad(nextval('seq_codigo_barras_interno')::text, 11, '0')
FROM (
  SELECT material_sku FROM material m
  WHERE NOT EXISTS (SELECT 1 FROM material_codigo_barras c WHERE c.material_sku = m.material_sku)
  ORDER BY material_sku
) m;

COMMIT;
