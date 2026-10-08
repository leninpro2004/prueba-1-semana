-- ============================================================
-- Migracion 2026-09-29 — Pedidos de instalacion (CU-120, sesion 12)
-- Schema: inventario | Grupo 14
--
-- Decision de la sesion 12 (docs/sprint/decisiones.md, D44): el pedido de instalacion
-- vincula los insumos del AREA "Instalacion" de la receta (los que viajan a terreno), no
-- la receta completa: la produccion la consumen las OT (R1). Cada insumo tiene una sola salida.
--
--  1. Area "Instalacion" (clasificacion 'instalacion'): dato nuevo.
--  2. preparacion_pedido pasa a ser POR VENTA (D12): nota_venta y fecha. La columna de
--     reserva deja de ser obligatoria; las 2 filas antiguas (por reserva) no cambian.
--  3. preparacion_pedido_estado guarda quien hizo cada cambio de estado (CU-119 lo pide).
--  4. preparacion_pedido_detalle: lo pedido por item y la BODEGA de la que se reserva
--     (bodega por insumo, D45). Lo reservado sale de reserva_inventario (una por lote);
--     la sesion 13 le agrega el retiro (CU-126).
--  5. Cada reserva de CU-120 apunta a su item.
--
-- Es IDEMPOTENTE, tambien sobre una base con la version anterior de esta migracion (que
-- guardaba una sola bodega en preparacion_pedido): la copia a cada item y la quita.
-- Respaldo previo: respaldo_antes_cu120_2026-09-29.dump (fuera del repo).
-- ============================================================

BEGIN;
SET search_path TO inventario;

-- 1. Area de instalacion
INSERT INTO area_trabajo (area_trabajo_nombre_area, area_trabajo_clasificacion, area_trabajo_activo)
SELECT 'Instalación', 'instalacion', TRUE
WHERE NOT EXISTS (SELECT 1 FROM area_trabajo WHERE area_trabajo_nombre_area = 'Instalación');

-- 2. Preparacion por venta
ALTER TABLE preparacion_pedido ADD COLUMN IF NOT EXISTS nota_venta_id_nota_venta BIGINT;
ALTER TABLE preparacion_pedido ADD COLUMN IF NOT EXISTS preparacion_pedido_fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE preparacion_pedido ALTER COLUMN reserva_inventario_id_reserva DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uk_prep_ped_venta ON preparacion_pedido (nota_venta_id_nota_venta)
  WHERE nota_venta_id_nota_venta IS NOT NULL;

COMMENT ON COLUMN preparacion_pedido.nota_venta_id_nota_venta IS 'CU-120: FK blanda hacia finanzas.nota_venta (una preparacion por venta)';

-- 3. Quien hizo cada cambio de estado
ALTER TABLE preparacion_pedido_estado ADD COLUMN IF NOT EXISTS usuario_id_usuario BIGINT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_prep_ped_est_usr') THEN
    ALTER TABLE preparacion_pedido_estado ADD CONSTRAINT fk_prep_ped_est_usr
      FOREIGN KEY (usuario_id_usuario) REFERENCES usuario(usuario_id_usuario);
  END IF;
END $$;

-- 4. Detalle por item, con su bodega
CREATE TABLE IF NOT EXISTS preparacion_pedido_detalle (
    preparacion_pedido_detalle_id                 BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    preparacion_pedido_id_preparacion             BIGINT        NOT NULL,
    material_sku                                  VARCHAR(16)   NOT NULL,
    preparacion_pedido_detalle_cantidad_requerida NUMERIC(12,4) NOT NULL,
    preparacion_pedido_detalle_origen             VARCHAR(10)   NOT NULL,
    CONSTRAINT pk_prep_ped_det PRIMARY KEY (preparacion_pedido_detalle_id),
    CONSTRAINT uk_prep_ped_det UNIQUE (preparacion_pedido_id_preparacion, material_sku),
    CONSTRAINT ck_prep_ped_det_cant CHECK (preparacion_pedido_detalle_cantidad_requerida > 0),
    CONSTRAINT ck_prep_ped_det_origen CHECK (preparacion_pedido_detalle_origen IN ('receta', 'manual')),
    CONSTRAINT fk_prep_ped_det_prep FOREIGN KEY (preparacion_pedido_id_preparacion)
      REFERENCES preparacion_pedido(preparacion_pedido_id_preparacion),
    CONSTRAINT fk_prep_ped_det_mat FOREIGN KEY (material_sku) REFERENCES material(material_sku)
);
COMMENT ON TABLE preparacion_pedido_detalle IS 'CU-120: cantidad pedida por insumo y su bodega; lo reservado sale de reserva_inventario (una por lote)';

ALTER TABLE preparacion_pedido_detalle ADD COLUMN IF NOT EXISTS bodega_id_bodega BIGINT;

-- Version anterior (una bodega por preparacion): se copia a cada item y se quita
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'inventario' AND table_name = 'preparacion_pedido' AND column_name = 'bodega_id_bodega') THEN
    UPDATE preparacion_pedido_detalle d SET bodega_id_bodega = p.bodega_id_bodega
    FROM preparacion_pedido p
    WHERE p.preparacion_pedido_id_preparacion = d.preparacion_pedido_id_preparacion AND d.bodega_id_bodega IS NULL;
    ALTER TABLE preparacion_pedido DROP CONSTRAINT IF EXISTS fk_prep_ped_bodega;
    ALTER TABLE preparacion_pedido DROP COLUMN bodega_id_bodega;
  END IF;
END $$;

ALTER TABLE preparacion_pedido_detalle ALTER COLUMN bodega_id_bodega SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_prep_ped_det_bodega') THEN
    ALTER TABLE preparacion_pedido_detalle ADD CONSTRAINT fk_prep_ped_det_bodega
      FOREIGN KEY (bodega_id_bodega) REFERENCES bodega(bodega_id_bodega);
  END IF;
END $$;
COMMENT ON COLUMN preparacion_pedido_detalle.bodega_id_bodega IS 'CU-120 (D45): bodega de la que se reserva y se retira este insumo';

-- 5. Cada reserva de CU-120 apunta a su item: el vinculo pedido <-> lotes. Distingue estas
--    reservas de las de CU-124 (insumos especiales), que tambien llevan la venta.
ALTER TABLE reserva_inventario ADD COLUMN IF NOT EXISTS preparacion_pedido_detalle_id BIGINT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_res_prep_det') THEN
    ALTER TABLE reserva_inventario ADD CONSTRAINT fk_res_prep_det
      FOREIGN KEY (preparacion_pedido_detalle_id) REFERENCES preparacion_pedido_detalle(preparacion_pedido_detalle_id)
      ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_res_prep_det ON reserva_inventario(preparacion_pedido_detalle_id)
  WHERE preparacion_pedido_detalle_id IS NOT NULL;
COMMENT ON COLUMN reserva_inventario.preparacion_pedido_detalle_id IS 'CU-120: item del pedido de instalacion al que pertenece esta reserva (una por lote)';

COMMIT;
