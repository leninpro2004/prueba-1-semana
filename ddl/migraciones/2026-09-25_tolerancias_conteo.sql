-- ============================================================
-- Migracion 2026-09-25 — Tolerancias de conteo (sesion 4, CU-43 / CU-57)
-- Schema: inventario | Grupo 14
--
-- Reemplaza la decision D10 (tolerancias como constantes en el codigo): el
-- sistema queda para un cliente real, y Gerencia debe poder ajustar los
-- valores desde la aplicacion, sin un programador.
--
-- Es IDEMPOTENTE: se puede correr dos veces sin error y la segunda no cambia nada.
-- Los mismos cambios estan replicados en ddl/ddl_inventario.sql.
-- Respaldo previo: respaldo_antes_tolerancias_2026-09-25.dump (fuera del repo).
-- ============================================================

BEGIN;
SET search_path TO inventario;

-- ─── Tolerancias por tipo de producto, editables por Gerencia ────────────────
CREATE TABLE IF NOT EXISTS tolerancia_conteo (
    tolerancia_conteo_tipo                VARCHAR(20)  NOT NULL,
    tolerancia_conteo_tolerancia_pct      NUMERIC(6,2) NOT NULL,
    tolerancia_conteo_umbral_critico_pct  NUMERIC(6,2) NOT NULL,
    tolerancia_conteo_fecha_modificacion  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    usuario_id_usuario                    BIGINT,
    CONSTRAINT pk_tol_conteo      PRIMARY KEY (tolerancia_conteo_tipo),
    CONSTRAINT ck_tol_conteo_tipo CHECK (tolerancia_conteo_tipo IN ('critico','no_critico')),
    CONSTRAINT ck_tol_conteo_val  CHECK (tolerancia_conteo_tolerancia_pct >= 0
                                     AND tolerancia_conteo_umbral_critico_pct > tolerancia_conteo_tolerancia_pct
                                     AND tolerancia_conteo_umbral_critico_pct <= 1000)
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tol_conteo_usr') THEN
    ALTER TABLE tolerancia_conteo ADD CONSTRAINT fk_tol_conteo_usr
        FOREIGN KEY (usuario_id_usuario) REFERENCES usuario(usuario_id_usuario);
  END IF;
END $$;

COMMENT ON TABLE  tolerancia_conteo IS 'CU-43/CU-57: tolerancias del conteo ciclico por tipo de producto, editables por Gerencia';
COMMENT ON COLUMN tolerancia_conteo.tolerancia_conteo_tipo IS 'critico = material_material_critico TRUE; no_critico = el resto';
COMMENT ON COLUMN tolerancia_conteo.tolerancia_conteo_tolerancia_pct IS 'Diferencia porcentual hasta la que se considera ruido normal: se registra, sin alerta';
COMMENT ON COLUMN tolerancia_conteo.tolerancia_conteo_umbral_critico_pct IS 'Sobre este porcentaje la alerta de CU-57 es critica y se notifica a Gerencia';
COMMENT ON COLUMN tolerancia_conteo.usuario_id_usuario IS 'Quien hizo la ultima modificacion; NULL = valor inicial';

-- ─── Lo que se aplico a cada linea al procesar el conteo ─────────────────────
ALTER TABLE diferencia_inventario ADD COLUMN IF NOT EXISTS diferencia_inventario_tolerancia_pct     NUMERIC(6,2);
ALTER TABLE diferencia_inventario ADD COLUMN IF NOT EXISTS diferencia_inventario_umbral_critico_pct NUMERIC(6,2);

COMMENT ON COLUMN diferencia_inventario.diferencia_inventario_tolerancia_pct IS 'Tolerancia aplicada al procesar (copia de tolerancia_conteo en ese momento)';
COMMENT ON COLUMN diferencia_inventario.diferencia_inventario_umbral_critico_pct IS 'Umbral critico vigente al procesar; lo usa CU-57 para la severidad';

-- ─── Valores iniciales: a validar con el cliente ─────────────────────────────
INSERT INTO tolerancia_conteo (tolerancia_conteo_tipo, tolerancia_conteo_tolerancia_pct, tolerancia_conteo_umbral_critico_pct)
VALUES ('critico', 1, 5), ('no_critico', 5, 20)
ON CONFLICT (tolerancia_conteo_tipo) DO NOTHING;

COMMIT;
