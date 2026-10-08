-- ============================================================
-- Migracion 2026-09-24 — Incremento 3 + 4 (sesion 1)
-- Schema: inventario | Grupo 14
--
-- Se aplica sobre una BD existente. Es IDEMPOTENTE: se puede correr
-- dos veces sin error y la segunda no cambia nada.
-- Los mismos cambios estan replicados en ddl/ddl_inventario.sql.
-- Detalle y justificacion: docs/sprint/ddl-cambios.md
-- ============================================================

BEGIN;
SET search_path TO inventario;

-- ─── CU-19 · fecha de la ultima modificacion de la presentacion ──────────────
ALTER TABLE material ADD COLUMN IF NOT EXISTS material_presentacion_fecha_modificacion TIMESTAMPTZ;

-- ─── CU-30 · un codigo de barras lleva a un solo SKU + secuencia de codigos internos ──
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uk_mat_cod_bar_valor') THEN
    ALTER TABLE material_codigo_barras ADD CONSTRAINT uk_mat_cod_bar_valor UNIQUE (material_codigo_barras);
  END IF;
END $$;
CREATE SEQUENCE IF NOT EXISTS seq_codigo_barras_interno;
-- Formato generado en el backend: '2' || lpad(nextval('seq_codigo_barras_interno')::text, 11, '0')
-- Sin CHECK de formato en la tabla, a proposito: deja abierta la puerta a codigos de proveedor.

-- ─── CU-37 / CU-43 · conteo ciclico ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conteo_ciclico (
    conteo_ciclico_id_conteo            BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    conteo_ciclico_fecha_hora           TIMESTAMPTZ NOT NULL DEFAULT now(),
    conteo_ciclico_estado               VARCHAR(30) NOT NULL DEFAULT 'borrador',
    conteo_ciclico_justificacion        TEXT,          -- Excepcion 3: segundo conteo del dia
    conteo_ciclico_fecha_confirmacion   TIMESTAMPTZ,
    conteo_ciclico_fecha_procesamiento  TIMESTAMPTZ,
    conteo_ciclico_resultado            VARCHAR(30),   -- CU-43: 'conforme' | 'con_diferencias'
    bodega_id_bodega                    BIGINT NOT NULL,
    usuario_id_usuario                  BIGINT NOT NULL,   -- quien cuenta
    usuario_procesa_id                  BIGINT,            -- quien confirma las diferencias (CU-43)
    CONSTRAINT pk_conteo PRIMARY KEY (conteo_ciclico_id_conteo),
    CONSTRAINT ck_conteo_estado    CHECK (conteo_ciclico_estado IN ('borrador','confirmado','procesado')),
    CONSTRAINT ck_conteo_resultado CHECK (conteo_ciclico_resultado IS NULL OR conteo_ciclico_resultado IN ('conforme','con_diferencias')),
    CONSTRAINT ck_conteo_confirm   CHECK ((conteo_ciclico_estado = 'borrador') = (conteo_ciclico_fecha_confirmacion IS NULL))
);

CREATE TABLE IF NOT EXISTS conteo_ciclico_detalle (
    conteo_ciclico_id_conteo                BIGINT      NOT NULL,
    material_sku                            VARCHAR(16) NOT NULL,
    conteo_ciclico_detalle_cantidad_contada NUMERIC(12,4),              -- NULL = no contado (CU-43, Excepcion 1)
    conteo_ciclico_detalle_stock_teorico    NUMERIC(12,4),              -- se guarda AL CONFIRMAR
    conteo_ciclico_detalle_no_esperado      BOOLEAN NOT NULL DEFAULT FALSE,  -- CU-37, Excepcion 4
    conteo_ciclico_detalle_observacion      TEXT,
    CONSTRAINT pk_conteo_det PRIMARY KEY (conteo_ciclico_id_conteo, material_sku),
    CONSTRAINT ck_conteo_det_cant CHECK (conteo_ciclico_detalle_cantidad_contada IS NULL OR conteo_ciclico_detalle_cantidad_contada >= 0)
);

CREATE TABLE IF NOT EXISTS diferencia_inventario (
    diferencia_inventario_id                 BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    conteo_ciclico_id_conteo                 BIGINT        NOT NULL,
    material_sku                             VARCHAR(16)   NOT NULL,
    diferencia_inventario_stock_teorico      NUMERIC(12,4) NOT NULL,
    diferencia_inventario_cantidad_contada   NUMERIC(12,4) NOT NULL,
    diferencia_inventario_diferencia         NUMERIC(12,4) NOT NULL,   -- contada - teorico
    diferencia_inventario_diferencia_pct     NUMERIC(9,2),             -- NULL si el teorico es 0
    diferencia_inventario_clasificacion      VARCHAR(20)   NOT NULL,
    diferencia_inventario_supera_tolerancia  BOOLEAN       NOT NULL,
    diferencia_inventario_fecha              TIMESTAMPTZ   NOT NULL DEFAULT now(),
    usuario_id_usuario                       BIGINT        NOT NULL,   -- quien confirmo
    CONSTRAINT pk_dif_inv PRIMARY KEY (diferencia_inventario_id),
    CONSTRAINT uk_dif_inv_conteo_sku UNIQUE (conteo_ciclico_id_conteo, material_sku),
    CONSTRAINT ck_dif_inv_clasif CHECK (diferencia_inventario_clasificacion IN ('faltante','sobrante','sin_diferencia'))
);

-- ─── CU-57 · alertas por diferencia + CU-47 · cantidad sugerida ──────────────
ALTER TABLE alerta_inventario ADD COLUMN IF NOT EXISTS bodega_id_bodega                    BIGINT;
ALTER TABLE alerta_inventario ADD COLUMN IF NOT EXISTS conteo_ciclico_id_conteo            BIGINT;
ALTER TABLE alerta_inventario ADD COLUMN IF NOT EXISTS alerta_inventario_diferencia        NUMERIC(12,4);
ALTER TABLE alerta_inventario ADD COLUMN IF NOT EXISTS alerta_inventario_diferencia_pct    NUMERIC(9,2);
ALTER TABLE alerta_inventario ADD COLUMN IF NOT EXISTS alerta_inventario_cantidad_sugerida NUMERIC(12,4);
ALTER TABLE alerta_inventario ADD COLUMN IF NOT EXISTS usuario_id_usuario                  BIGINT;

-- ─── CU-55 · quien resolvio la alerta ───────────────────────────────────────
ALTER TABLE historial_alerta ADD COLUMN IF NOT EXISTS usuario_id_usuario BIGINT;

-- ─── CU-42 · intentos de reautenticacion (el bloqueo sobrevive a un reinicio) ─
CREATE TABLE IF NOT EXISTS reautenticacion_intento (
    reautenticacion_intento_id          BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    usuario_id_usuario                  BIGINT      NOT NULL,
    reautenticacion_intento_fecha_hora  TIMESTAMPTZ NOT NULL DEFAULT now(),
    reautenticacion_intento_exitoso     BOOLEAN     NOT NULL,
    reautenticacion_intento_accion      VARCHAR(50) NOT NULL DEFAULT 'revertir_movimiento',
    movimiento_inventario_id_movimiento BIGINT,
    CONSTRAINT pk_reauth PRIMARY KEY (reautenticacion_intento_id)
);

-- ─── CU-44 · el movimiento inverso apunta al original ───────────────────────
ALTER TABLE movimiento_inventario ADD COLUMN IF NOT EXISTS movimiento_inventario_id_revertido BIGINT;

-- ─── CU-107 · origen y referencia del movimiento ────────────────────────────
ALTER TABLE movimiento_inventario ADD COLUMN IF NOT EXISTS movimiento_inventario_modulo_origen     VARCHAR(30) NOT NULL DEFAULT 'inventario';
ALTER TABLE movimiento_inventario ADD COLUMN IF NOT EXISTS movimiento_inventario_referencia_origen VARCHAR(100);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_mov_inv_modulo') THEN
    ALTER TABLE movimiento_inventario ADD CONSTRAINT ck_mov_inv_modulo
      CHECK (movimiento_inventario_modulo_origen IN ('inventario','terreno','finanzas'));
  END IF;
END $$;

-- ─── CU-60 / CU-65 · cantidad minima de pedido ──────────────────────────────
ALTER TABLE material_proveedor ADD COLUMN IF NOT EXISTS material_proveedor_cantidad_minima NUMERIC(12,4);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_mat_prov_cant_min') THEN
    ALTER TABLE material_proveedor ADD CONSTRAINT ck_mat_prov_cant_min
      CHECK (material_proveedor_cantidad_minima IS NULL OR material_proveedor_cantidad_minima >= 1);
  END IF;
END $$;

-- ─── CU-102 · versiones de la plantilla por area ────────────────────────────
ALTER TABLE insumo_estandar_proceso ADD COLUMN IF NOT EXISTS insumo_estandar_proceso_version        INTEGER     NOT NULL DEFAULT 1;
ALTER TABLE insumo_estandar_proceso ADD COLUMN IF NOT EXISTS insumo_estandar_proceso_fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT now();

-- ─── CU-103 / CU-104 · historial de desviaciones ────────────────────────────
CREATE TABLE IF NOT EXISTS diferencial_consumo (
    diferencial_consumo_id                  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    orden_trabajo_id_orden                  BIGINT        NOT NULL,
    material_sku                            VARCHAR(16)   NOT NULL,
    diferencial_consumo_fecha               TIMESTAMPTZ   NOT NULL DEFAULT now(),
    diferencial_consumo_estimado            NUMERIC(12,4),
    diferencial_consumo_real                NUMERIC(12,4),
    diferencial_consumo_desviacion_abs      NUMERIC(12,4),
    diferencial_consumo_desviacion_pct      NUMERIC(9,2),     -- NULL cuando no hay base
    diferencial_consumo_tipo                VARCHAR(20)   NOT NULL,
    diferencial_consumo_impacto_clp         NUMERIC(14,2),    -- desviacion x precio, para ordenar en CU-104
    usuario_id_usuario                      BIGINT        NOT NULL,
    CONSTRAINT pk_dif_cons PRIMARY KEY (diferencial_consumo_id),
    CONSTRAINT uk_dif_cons_ot_sku UNIQUE (orden_trabajo_id_orden, material_sku),
    CONSTRAINT ck_dif_cons_tipo CHECK (diferencial_consumo_tipo IN ('sobre_gasto','ahorro','sin_desviacion','sin_base'))
);

-- ─── CU-122 / CU-123 / CU-124 · insumos especiales ──────────────────────────
-- "Especial / No Rotativo" YA EXISTE: material.material_es_rotativo = FALSE. No se agrega columna.
ALTER TABLE material ADD COLUMN IF NOT EXISTS material_descontinuado BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE alerta_faltante_pedido ADD COLUMN IF NOT EXISTS alerta_faltante_pedido_origen VARCHAR(30) NOT NULL DEFAULT 'faltante';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_afp_origen') THEN
    ALTER TABLE alerta_faltante_pedido ADD CONSTRAINT ck_afp_origen
      CHECK (alerta_faltante_pedido_origen IN ('faltante','insumo_especial'));
  END IF;
END $$;

-- ─── Pedido = finanzas.nota_venta (FK blandas) ──────────────────────────────
ALTER TABLE reserva_inventario     ADD COLUMN IF NOT EXISTS nota_venta_id_nota_venta BIGINT;
ALTER TABLE alerta_faltante_pedido ADD COLUMN IF NOT EXISTS nota_venta_id_nota_venta BIGINT;

-- ─── FK internas ────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_conteo_bodega') THEN
    ALTER TABLE conteo_ciclico
      ADD CONSTRAINT fk_conteo_bodega      FOREIGN KEY (bodega_id_bodega)   REFERENCES bodega(bodega_id_bodega),
      ADD CONSTRAINT fk_conteo_usr         FOREIGN KEY (usuario_id_usuario) REFERENCES usuario(usuario_id_usuario),
      ADD CONSTRAINT fk_conteo_usr_procesa FOREIGN KEY (usuario_procesa_id) REFERENCES usuario(usuario_id_usuario);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_conteo_det_conteo') THEN
    ALTER TABLE conteo_ciclico_detalle
      ADD CONSTRAINT fk_conteo_det_conteo FOREIGN KEY (conteo_ciclico_id_conteo) REFERENCES conteo_ciclico(conteo_ciclico_id_conteo),
      ADD CONSTRAINT fk_conteo_det_mat    FOREIGN KEY (material_sku)             REFERENCES material(material_sku);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_dif_inv_conteo') THEN
    ALTER TABLE diferencia_inventario
      ADD CONSTRAINT fk_dif_inv_conteo FOREIGN KEY (conteo_ciclico_id_conteo) REFERENCES conteo_ciclico(conteo_ciclico_id_conteo),
      ADD CONSTRAINT fk_dif_inv_mat    FOREIGN KEY (material_sku)             REFERENCES material(material_sku),
      ADD CONSTRAINT fk_dif_inv_usr    FOREIGN KEY (usuario_id_usuario)       REFERENCES usuario(usuario_id_usuario);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_alert_bodega') THEN
    ALTER TABLE alerta_inventario
      ADD CONSTRAINT fk_alert_bodega FOREIGN KEY (bodega_id_bodega)         REFERENCES bodega(bodega_id_bodega),
      ADD CONSTRAINT fk_alert_conteo FOREIGN KEY (conteo_ciclico_id_conteo) REFERENCES conteo_ciclico(conteo_ciclico_id_conteo),
      ADD CONSTRAINT fk_alert_usr    FOREIGN KEY (usuario_id_usuario)       REFERENCES usuario(usuario_id_usuario);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hist_alerta_usr') THEN
    ALTER TABLE historial_alerta
      ADD CONSTRAINT fk_hist_alerta_usr FOREIGN KEY (usuario_id_usuario) REFERENCES usuario(usuario_id_usuario);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_reauth_usr') THEN
    ALTER TABLE reautenticacion_intento
      ADD CONSTRAINT fk_reauth_usr FOREIGN KEY (usuario_id_usuario)                  REFERENCES usuario(usuario_id_usuario),
      ADD CONSTRAINT fk_reauth_mov FOREIGN KEY (movimiento_inventario_id_movimiento) REFERENCES movimiento_inventario(movimiento_inventario_id_movimiento);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_mov_revertido') THEN
    ALTER TABLE movimiento_inventario
      ADD CONSTRAINT fk_mov_revertido FOREIGN KEY (movimiento_inventario_id_revertido)
                                      REFERENCES movimiento_inventario(movimiento_inventario_id_movimiento);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_dif_cons_ot') THEN
    ALTER TABLE diferencial_consumo
      ADD CONSTRAINT fk_dif_cons_ot  FOREIGN KEY (orden_trabajo_id_orden) REFERENCES orden_trabajo(orden_trabajo_id_orden),
      ADD CONSTRAINT fk_dif_cons_mat FOREIGN KEY (material_sku)           REFERENCES material(material_sku),
      ADD CONSTRAINT fk_dif_cons_usr FOREIGN KEY (usuario_id_usuario)     REFERENCES usuario(usuario_id_usuario);
  END IF;
END $$;

-- ─── Indices ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_conteo_bodega_fecha ON conteo_ciclico(bodega_id_bodega, conteo_ciclico_fecha_hora DESC);
CREATE INDEX IF NOT EXISTS idx_dif_inv_conteo      ON diferencia_inventario(conteo_ciclico_id_conteo);
CREATE INDEX IF NOT EXISTS idx_alert_bodega        ON alerta_inventario(bodega_id_bodega) WHERE bodega_id_bodega IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reauth_usuario      ON reautenticacion_intento(usuario_id_usuario, reautenticacion_intento_fecha_hora DESC);
CREATE INDEX IF NOT EXISTS idx_mov_inv_revertido   ON movimiento_inventario(movimiento_inventario_id_revertido) WHERE movimiento_inventario_id_revertido IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dif_cons_fecha      ON diferencial_consumo(diferencial_consumo_fecha DESC);
CREATE INDEX IF NOT EXISTS idx_res_nota_venta      ON reserva_inventario(nota_venta_id_nota_venta)     WHERE nota_venta_id_nota_venta IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_afp_nota_venta      ON alerta_faltante_pedido(nota_venta_id_nota_venta) WHERE nota_venta_id_nota_venta IS NOT NULL;

-- ─── Comentarios ────────────────────────────────────────────────────────────
COMMENT ON COLUMN reserva_inventario.nota_venta_id_nota_venta     IS 'FK blanda hacia finanzas.nota_venta — el pedido o venta de la reserva';
COMMENT ON COLUMN alerta_faltante_pedido.nota_venta_id_nota_venta IS 'FK blanda hacia finanzas.nota_venta';
COMMENT ON COLUMN alerta_faltante_pedido.alerta_faltante_pedido_origen IS 'faltante = generador de OT (OPUS-2); insumo_especial = CU-122';
COMMENT ON COLUMN conteo_ciclico_detalle.conteo_ciclico_detalle_stock_teorico IS 'Stock físico del SKU en la bodega AL CONFIRMAR el conteo; CU-43 compara contra este valor, no contra el actual';
COMMENT ON COLUMN movimiento_inventario.movimiento_inventario_id_revertido IS 'CU-44: si no es NULL, este movimiento es el inverso de otro. Excluirlo de consumos y rotación';
COMMENT ON COLUMN material.material_descontinuado IS 'CU-122: no se vuelve a comprar; distinto de material_estado = inactivo';

-- ─── Datos: tipos de alerta de CU-57 ────────────────────────────────────────
-- La severidad se modela con DOS TIPOS (la prioridad es del tipo, no de la alerta).
-- La prioridad se busca por NOMBRE: sus ids no coinciden entre la BD real y la de test.
INSERT INTO alerta_inventario_tipo_alerta (alerta_inventario_tipo_alerta_nombre, alerta_inventario_nivel_prioridad_id)
SELECT 'diferencia inventario', p.alerta_inventario_nivel_prioridad_id_nivel_prioridad
FROM alerta_inventario_nivel_prioridad p
WHERE p.alerta_inventario_prioridad_nombre = 'alta'
  AND NOT EXISTS (SELECT 1 FROM alerta_inventario_tipo_alerta
                  WHERE alerta_inventario_tipo_alerta_nombre = 'diferencia inventario');

INSERT INTO alerta_inventario_tipo_alerta (alerta_inventario_tipo_alerta_nombre, alerta_inventario_nivel_prioridad_id)
SELECT 'diferencia inventario critica', p.alerta_inventario_nivel_prioridad_id_nivel_prioridad
FROM alerta_inventario_nivel_prioridad p
WHERE p.alerta_inventario_prioridad_nombre = 'urgente'
  AND NOT EXISTS (SELECT 1 FROM alerta_inventario_tipo_alerta
                  WHERE alerta_inventario_tipo_alerta_nombre = 'diferencia inventario critica');

COMMIT;
