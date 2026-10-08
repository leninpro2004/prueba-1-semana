-- ============================================================
-- Sistema Puertas Blindadas — Módulo Inventario
-- SQL CORREGIDO v2
-- Schema: inventario | Grupo 14
-- ============================================================

-- El archivo es UTF-8: sin esto, psql en Windows lo lee como WIN1252 y daña los acentos
SET client_encoding = 'UTF8';

BEGIN;

DROP SCHEMA IF EXISTS inventario CASCADE;
CREATE SCHEMA inventario;
SET search_path TO inventario;

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 1 — CATÁLOGOS BASE
-- ══════════════════════════════════════════════════════════════

CREATE TABLE material_categoria_general (
    material_categoria_general_id_categoria_general  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    material_categoria_general_nombre                VARCHAR(150) NOT NULL,
    CONSTRAINT pk_mat_cat_gen PRIMARY KEY (material_categoria_general_id_categoria_general),
    CONSTRAINT uk_mat_cat_gen_nombre UNIQUE (material_categoria_general_nombre)
);

CREATE TABLE material_categoria_funcional (
    material_categoria_funcional_id_categoria_funcional  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    material_categoria_funcional_nombre                  VARCHAR(150) NOT NULL,
    CONSTRAINT pk_mat_cat_func PRIMARY KEY (material_categoria_funcional_id_categoria_funcional),
    CONSTRAINT uk_mat_cat_func_nombre UNIQUE (material_categoria_funcional_nombre)
);

CREATE TABLE material_clasificacion_categoria (
    material_clasificacion_categoria_id               BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    material_clasificacion_categoria_nombre_categoria VARCHAR(150) NOT NULL,
    CONSTRAINT pk_mat_clas_cat PRIMARY KEY (material_clasificacion_categoria_id)
);

CREATE TABLE material_clasificacion_subcategoria (
    material_clasificacion_subcategoria_id                   BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    material_clasificacion_subcategoria_nombre_subcategoria  VARCHAR(150) NOT NULL,
    material_clasificacion_subcategoria_es_color_custom      BOOLEAN NOT NULL DEFAULT FALSE,
    material_clasificacion_categoria_id                      BIGINT NOT NULL,
    CONSTRAINT pk_mat_clas_sub PRIMARY KEY (material_clasificacion_subcategoria_id)
);

CREATE TABLE material_clasificacion_nivel_especifico (
    material_clasificacion_nivel_especifico_id               BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    material_clasificacion_nivel_especifico_nombre_nivel_especifico VARCHAR(150) NOT NULL,
    material_clasificacion_subcategoria_id                   BIGINT NOT NULL,
    CONSTRAINT pk_mat_clas_niv PRIMARY KEY (material_clasificacion_nivel_especifico_id)
);

CREATE TABLE material_unidad_medida (
    material_unidad_medida_id_unidad_medida  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    material_unidad_medida_nombre            VARCHAR(100) NOT NULL,
    CONSTRAINT pk_mat_unidad PRIMARY KEY (material_unidad_medida_id_unidad_medida),
    CONSTRAINT uk_mat_unidad_nombre UNIQUE (material_unidad_medida_nombre)
);

CREATE TABLE historial_alerta (
    historial_alerta_id_historial          BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    historial_alerta_fecha_hora_resolucion TIMESTAMPTZ,
    usuario_id_usuario                     BIGINT,   -- CU-55: quien resolvio la alerta
    CONSTRAINT pk_hist_alerta PRIMARY KEY (historial_alerta_id_historial)
);

CREATE TABLE alerta_inventario_nivel_prioridad (
    alerta_inventario_nivel_prioridad_id_nivel_prioridad  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    alerta_inventario_prioridad_nombre                    VARCHAR(100) NOT NULL,
    CONSTRAINT pk_alert_niv PRIMARY KEY (alerta_inventario_nivel_prioridad_id_nivel_prioridad)
);

CREATE TABLE alerta_inventario_tipo_alerta (
    alerta_inventario_tipo_alerta_id_tipo_alerta  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    alerta_inventario_tipo_alerta_nombre          VARCHAR(150) NOT NULL,
    alerta_inventario_nivel_prioridad_id          BIGINT NOT NULL,
    CONSTRAINT pk_alert_tipo PRIMARY KEY (alerta_inventario_tipo_alerta_id_tipo_alerta)
);

CREATE TABLE movimiento_inventario_tipo_movimiento (
    movimiento_inventario_tipo_movimiento_id_tipo_movimiento  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    movimiento_inventario_tipo_movimiento_nombre              VARCHAR(150) NOT NULL,
    CONSTRAINT pk_mov_tipo PRIMARY KEY (movimiento_inventario_tipo_movimiento_id_tipo_movimiento),
    CONSTRAINT uk_mov_tipo_nombre UNIQUE (movimiento_inventario_tipo_movimiento_nombre)
);

CREATE TABLE movimiento_inventario_clasificacion_salida (
    movimiento_inventario_clasificacion_salida_id_clasificacion_salida  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    movimiento_inventario_clasificacion_salida_nombre                   VARCHAR(150) NOT NULL,
    CONSTRAINT pk_mov_clas PRIMARY KEY (movimiento_inventario_clasificacion_salida_id_clasificacion_salida),
    CONSTRAINT uk_mov_clas_nombre UNIQUE (movimiento_inventario_clasificacion_salida_nombre)
);

CREATE TABLE movimiento_inventario_motivo_movimiento (
    movimiento_inventario_motivo_movimiento_id_motivo_movimiento        BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    movimiento_inventario_motivo_movimiento_nombre                      VARCHAR(150) NOT NULL,
    movimiento_inventario_clasificacion_salida_id_clasificacion_salida  BIGINT,
    CONSTRAINT pk_mov_motivo PRIMARY KEY (movimiento_inventario_motivo_movimiento_id_motivo_movimiento)
);

CREATE TABLE factura_compra_tipo_cambio (
    factura_compra_tipo_cambio_id_tipo_cambio  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    factura_compra_tipo_cambio_moneda          VARCHAR(10) NOT NULL,
    factura_compra_tipo_cambio_valor           NUMERIC(14,4) NOT NULL,
    CONSTRAINT pk_tipo_cambio PRIMARY KEY (factura_compra_tipo_cambio_id_tipo_cambio),
    CONSTRAINT ck_tipo_cambio_valor CHECK (factura_compra_tipo_cambio_valor > 0)
);

CREATE TABLE perfil (
    perfil_id_perfil     BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    perfil_nombre_perfil VARCHAR(150) NOT NULL,
    perfil_descripcion   TEXT,
    CONSTRAINT pk_perfil PRIMARY KEY (perfil_id_perfil),
    CONSTRAINT uk_perfil_nombre UNIQUE (perfil_nombre_perfil)
);

CREATE TABLE permiso (
    permiso_id_permiso         BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    permiso_modulo             VARCHAR(150) NOT NULL,
    permiso_accion             VARCHAR(150) NOT NULL,
    permiso_descripcion        TEXT,
    permiso_nombre_del_permiso VARCHAR(150),
    CONSTRAINT pk_permiso PRIMARY KEY (permiso_id_permiso),
    CONSTRAINT uk_permiso_modulo_accion UNIQUE (permiso_modulo, permiso_accion)
);

CREATE TABLE area_trabajo (
    area_trabajo_id_area      BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    area_trabajo_clasificacion VARCHAR(150),
    area_trabajo_activo       BOOLEAN NOT NULL DEFAULT TRUE,
    area_trabajo_nombre_area  VARCHAR(150) NOT NULL,
    CONSTRAINT pk_area PRIMARY KEY (area_trabajo_id_area)
);

CREATE TABLE producto_terminado (
    producto_terminado_id_producto                   BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    producto_terminado_tipo_producto                 VARCHAR(150),
    producto_terminado_nombre_producto               VARCHAR(200) NOT NULL,
    -- CU-102 (D37): obligatorio; se guarda en mayúsculas; al duplicar se sugiere <codigo>-V<n>
    producto_terminado_codigo_producto               VARCHAR(80)  NOT NULL,
    producto_terminado_requerimientos_certificacion  TEXT,
    producto_terminado_requerimientos_medidas        TEXT,
    producto_terminado_requerimientos_produccion     TEXT,
    producto_terminado_requerimientos_instalacion    TEXT,
    producto_terminado_activo                        BOOLEAN NOT NULL DEFAULT TRUE,
    -- CU-102: la receta se edita libremente 24 h desde su creación; después solo gerencia (D37)
    producto_terminado_fecha_creacion                TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- CU-102: receta que la reemplazó al duplicarla como nueva versión (NULL = no reemplazada)
    producto_terminado_reemplazada_por               BIGINT,
    CONSTRAINT pk_prod_term PRIMARY KEY (producto_terminado_id_producto),
    CONSTRAINT uk_prod_term_codigo UNIQUE (producto_terminado_codigo_producto)
);

CREATE TABLE bodega (
    bodega_id_bodega     BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    bodega_nombre_bodega VARCHAR(150) NOT NULL,
    bodega_direccion     TEXT,
    bodega_estado        VARCHAR(50) NOT NULL,
    bodega_codigo        VARCHAR(50),
    CONSTRAINT pk_bodega PRIMARY KEY (bodega_id_bodega)
);

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 2 — ENTIDADES PRINCIPALES
-- ══════════════════════════════════════════════════════════════

CREATE TABLE material (
    material_sku                                          VARCHAR(16)  NOT NULL,
    material_nombre_material                              VARCHAR(200) NOT NULL,
    material_descripcion                                  TEXT,
    material_material_critico                             BOOLEAN NOT NULL DEFAULT FALSE,
    material_presentacion                                 VARCHAR(150),
    material_stock_critico                                NUMERIC(12,4),
    material_stock_maximo                                 NUMERIC(12,4),
    material_stock_minimo                                 NUMERIC(12,4),
    material_es_rotativo                                  BOOLEAN NOT NULL DEFAULT TRUE,
    material_estado                                       VARCHAR(50) NOT NULL,
    es_material_pintura_custom                            BOOLEAN,
    material_pintura_pintura_custom                       VARCHAR(100),
    es_material_pintura_no_custom                         BOOLEAN,
    material_pintura_no_custom                            VARCHAR(100),
    material_categoria_general_id_categoria_general       BIGINT,
    material_categoria_funcional_id_categoria_funcional   BIGINT,
    material_clasificacion_nivel_especifico_id            BIGINT,
    material_unidad_medida_id_unidad_medida               BIGINT NOT NULL,
    -- OPUS-10 (Req #5): clasificacion y valorizacion de herramientas
    material_es_herramienta                               BOOLEAN NOT NULL DEFAULT FALSE,
    material_valor_adquisicion                            NUMERIC(14,2),
    material_fecha_adquisicion                            DATE,
    -- CU-19: fecha de la ultima modificacion de la presentacion comercial
    material_presentacion_fecha_modificacion              TIMESTAMPTZ,
    -- CU-122: no se vuelve a comprar. "Especial / no rotativo" es material_es_rotativo = FALSE
    material_descontinuado                                BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT pk_material PRIMARY KEY (material_sku),
    CONSTRAINT ck_material_sku_len CHECK (length(material_sku) BETWEEN 4 AND 16),
    CONSTRAINT ck_mat_stock_min  CHECK (material_stock_minimo >= 0),
    CONSTRAINT ck_mat_stock_max  CHECK (material_stock_maximo >= 0),
    CONSTRAINT ck_mat_stock_crit CHECK (material_stock_critico >= 0),
    CONSTRAINT ck_material_valor_adq CHECK (material_valor_adquisicion IS NULL OR material_valor_adquisicion >= 0)
);

-- OPUS-10: indice parcial, las herramientas son una minoria de los materiales
CREATE INDEX idx_material_herramienta ON material(material_es_herramienta) WHERE material_es_herramienta = TRUE;

COMMENT ON COLUMN material.material_es_herramienta    IS 'OPUS-10: distingue herramientas (bien reutilizable) de consumibles';
COMMENT ON COLUMN material.material_valor_adquisicion IS 'OPUS-10: valor de compra de la herramienta; base de la valorizacion y de la depreciacion futura';

CREATE TABLE material_codigo_barras (
    material_sku           VARCHAR(16)  NOT NULL,
    material_codigo_barras VARCHAR(100) NOT NULL,
    CONSTRAINT pk_mat_cod_bar PRIMARY KEY (material_sku, material_codigo_barras),
    -- CU-30: un codigo de barras lleva a un solo SKU
    CONSTRAINT uk_mat_cod_bar_valor UNIQUE (material_codigo_barras)
    -- Sin CHECK de formato, a proposito: deja abierta la puerta a codigos de proveedor.
);

-- CU-30: codigos internos. Formato generado en el backend:
-- '2' || lpad(nextval('seq_codigo_barras_interno')::text, 11, '0')
CREATE SEQUENCE seq_codigo_barras_interno;

CREATE TABLE proveedor (
    proveedor_id_proveedor                              BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    proveedor_pais                                      VARCHAR(100),
    proveedor_tipo_proveedor                            VARCHAR(150),
    proveedor_rubro                                     TEXT,
    proveedor_razon_social                              VARCHAR(200) NOT NULL,
    proveedor_contacto_primer_nombre                    VARCHAR(100),
    proveedor_contacto_segundo_nombre                   VARCHAR(100),
    proveedor_contacto_primer_apellido                  VARCHAR(100),
    proveedor_contacto_segundo_apellido                 VARCHAR(100),
    proveedor_estado                                    VARCHAR(50) NOT NULL,
    proveedor_doc_identidad_tipo_identificador          VARCHAR(80),
    proveedor_doc_identidad_rut_proveedor_opcional      VARCHAR(20),
    proveedor_doc_identidad_pais_emision_identificador  VARCHAR(100),
    proveedor_doc_identidad_numero_identificador        VARCHAR(80),
    CONSTRAINT pk_proveedor PRIMARY KEY (proveedor_id_proveedor)
);

CREATE TABLE proveedor_contacto_telefono (
    proveedor_id_proveedor       BIGINT      NOT NULL,
    proveedor_contacto_telefono  VARCHAR(30) NOT NULL,
    CONSTRAINT pk_prov_tel PRIMARY KEY (proveedor_id_proveedor, proveedor_contacto_telefono)
);

CREATE TABLE proveedor_contacto_correo (
    proveedor_id_proveedor    BIGINT       NOT NULL,
    proveedor_contacto_correo VARCHAR(254) NOT NULL,
    CONSTRAINT pk_prov_correo PRIMARY KEY (proveedor_id_proveedor, proveedor_contacto_correo)
);

CREATE TABLE material_proveedor (
    material_sku                           VARCHAR(16)   NOT NULL,
    proveedor_id_proveedor                 BIGINT        NOT NULL,
    material_proveedor_tiempo_reposicion   INTEGER,
    material_proveedor_precio_referencial  NUMERIC(14,2),
    material_proveedor_proveedor_principal BOOLEAN NOT NULL DEFAULT FALSE,
    -- CU-60 / CU-65: cantidad minima de pedido
    material_proveedor_cantidad_minima     NUMERIC(12,4),
    CONSTRAINT pk_mat_prov PRIMARY KEY (material_sku, proveedor_id_proveedor),
    CONSTRAINT ck_mat_prov_precio CHECK (material_proveedor_precio_referencial >= 0),
    CONSTRAINT ck_mat_prov_tiempo CHECK (material_proveedor_tiempo_reposicion >= 0),
    CONSTRAINT ck_mat_prov_cant_min CHECK (material_proveedor_cantidad_minima IS NULL OR material_proveedor_cantidad_minima >= 1)
);

CREATE TABLE material_producto_terminado (
    material_sku                                   VARCHAR(16)   NOT NULL,
    producto_terminado_id_producto                 BIGINT        NOT NULL,
    material_producto_terminado_cantidad_estimada  NUMERIC(12,4),
    material_producto_terminado_merma_estimada     NUMERIC(12,4),
    -- CU-102 / R1: área donde se consume el insumo, obligatoria (la OT carga solo los de su área)
    area_trabajo_id_area                           BIGINT        NOT NULL,
    CONSTRAINT pk_mat_prod PRIMARY KEY (material_sku, producto_terminado_id_producto),
    CONSTRAINT ck_mat_prod_cant  CHECK (material_producto_terminado_cantidad_estimada >= 0),
    CONSTRAINT ck_mat_prod_merma CHECK (material_producto_terminado_merma_estimada >= 0)
);

CREATE TABLE anaquel (
    anaquel_id_anaquel  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    anaquel_descripcion TEXT,
    bodega_id_bodega    BIGINT NOT NULL,
    CONSTRAINT pk_anaquel PRIMARY KEY (anaquel_id_anaquel)
);

CREATE TABLE factura_compra (
    factura_compra_id_factura                 BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    factura_compra_numero_factura             VARCHAR(80)   NOT NULL,
    factura_compra_monto_neto                 NUMERIC(14,2),
    factura_compra_tipo_compra                VARCHAR(100),
    factura_compra_fecha_emision              DATE          NOT NULL,
    proveedor_id_proveedor                    BIGINT        NOT NULL,
    factura_compra_tipo_cambio_id_tipo_cambio BIGINT,
    CONSTRAINT pk_factura PRIMARY KEY (factura_compra_id_factura),
    CONSTRAINT uk_factura_numero UNIQUE (factura_compra_numero_factura),
    CONSTRAINT ck_factura_monto CHECK (factura_compra_monto_neto >= 0)
);

CREATE TABLE lote (
    lote_id_lote              BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    lote_numero_lote          VARCHAR(80),
    lote_fecha_ingreso        DATE,
    lote_fecha_vencimiento    DATE,
    lote_fecha_recepcion      DATE,
    lote_estado               VARCHAR(50) NOT NULL,
    proveedor_id_proveedor    BIGINT,
    factura_compra_id_factura BIGINT,
    -- FK blanda hacia terreno/produccion
    proyecto_id_proyecto      BIGINT,
    CONSTRAINT pk_lote PRIMARY KEY (lote_id_lote)
);

CREATE TABLE lote_fecha_pedido (
    lote_fecha_pedido_id              BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    lote_fecha_pedido_fecha_pedido    DATE          NOT NULL,
    -- CU-62: opcional (la entrada puede no informar precio); el historial de precios vive en historial_precio_material
    lote_fecha_pedido_precio_unitario NUMERIC(14,2),
    lote_id_lote                      BIGINT        NOT NULL,
    CONSTRAINT pk_lote_fecha_ped PRIMARY KEY (lote_fecha_pedido_id),
    CONSTRAINT ck_lote_fp_precio CHECK (lote_fecha_pedido_precio_unitario >= 0)
);

CREATE TABLE inventario_bodega (
    material_sku                         VARCHAR(16)   NOT NULL,
    lote_id_lote                         BIGINT        NOT NULL,
    bodega_id_bodega                     BIGINT        NOT NULL,
    inventario_bodega_cantidad_fisica    NUMERIC(12,4) NOT NULL DEFAULT 0,
    inventario_bodega_cantidad_reservada NUMERIC(12,4) NOT NULL DEFAULT 0,
    -- OPUS-5: anaquel donde esta fisicamente el stock. Informativo: NO forma parte
    -- del PK, la granularidad del stock sigue siendo sku + lote + bodega.
    anaquel_id_anaquel                   BIGINT,
    CONSTRAINT pk_inv_bodega PRIMARY KEY (material_sku, lote_id_lote, bodega_id_bodega),
    CONSTRAINT ck_inv_bod_fis CHECK (inventario_bodega_cantidad_fisica >= 0),
    CONSTRAINT ck_inv_bod_res CHECK (inventario_bodega_cantidad_reservada >= 0)
);

-- SONNET-9: historial de precios por material y proveedor (~3 anos)
CREATE TABLE historial_precio_material (
    historial_precio_id         BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    material_sku                VARCHAR(16) NOT NULL,
    proveedor_id_proveedor      BIGINT NOT NULL,
    precio_unitario             NUMERIC(14,2) NOT NULL,
    moneda                      VARCHAR(10) NOT NULL DEFAULT 'CLP',
    fecha_vigencia_desde        DATE NOT NULL,
    fecha_vigencia_hasta        DATE,
    fuente                      VARCHAR(50) NOT NULL DEFAULT 'manual',
    -- fuente: 'manual', 'factura', 'cotizacion', 'importacion'
    factura_compra_id           BIGINT,
    lote_fecha_pedido_id        BIGINT,
    usuario_id_usuario          BIGINT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pk_hist_precio PRIMARY KEY (historial_precio_id),
    -- Las FK van en el BLOQUE 3 y no aqui: `usuario` se crea mas abajo en este
    -- mismo archivo, asi que declararlas inline hacia que el DDL NO se pudiera
    -- ejecutar desde cero ("no existe la relacion usuario"). Detectado al montar
    -- la BD de test.
    CONSTRAINT ck_hist_precio CHECK (precio_unitario >= 0)
);

CREATE INDEX idx_hist_precio_sku  ON historial_precio_material(material_sku, fecha_vigencia_desde DESC);
CREATE INDEX idx_hist_precio_prov ON historial_precio_material(proveedor_id_proveedor);

CREATE TABLE movimiento_inventario (
    movimiento_inventario_id_movimiento                          BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    movimiento_inventario_fecha_hora                             TIMESTAMPTZ   NOT NULL DEFAULT now(),
    movimiento_inventario_cantidad                               NUMERIC(12,4) NOT NULL,
    movimiento_inventario_estado                                 VARCHAR(50)   NOT NULL,
    material_sku                                                 VARCHAR(16)   NOT NULL,
    bodega_id_bodega                                             BIGINT,
    lote_id_lote                                                 BIGINT,
    -- FK blanda hacia terreno/produccion
    proyecto_id_proyecto                                         BIGINT,
    factura_compra_id_factura_compra                             BIGINT,
    usuario_id_usuario                                           BIGINT        NOT NULL,
    movimiento_inventario_tipo_movimiento_id_tipo_movimiento     BIGINT        NOT NULL,
    movimiento_inventario_motivo_movimiento_id_motivo_movimiento BIGINT,
    movimiento_inventario_descripcion_motivo                     TEXT,
    movimiento_inventario_evidencia_url                          VARCHAR(500),
    -- FK blanda hacia orden_trabajo: vincula la salida por consumo con la OT que la genero (OPUS-1)
    orden_trabajo_id_orden                                       BIGINT,
    -- CU-44: el movimiento inverso apunta al original
    movimiento_inventario_id_revertido                           BIGINT,
    -- CU-107: origen y referencia del movimiento
    movimiento_inventario_modulo_origen                          VARCHAR(30)   NOT NULL DEFAULT 'inventario',
    movimiento_inventario_referencia_origen                      VARCHAR(100),
    movimiento_inventario_clave_envio                            VARCHAR(100),
    CONSTRAINT pk_mov_inv PRIMARY KEY (movimiento_inventario_id_movimiento),
    CONSTRAINT ck_mov_inv_cant CHECK (movimiento_inventario_cantidad >= 0),
    CONSTRAINT ck_mov_inv_modulo CHECK (movimiento_inventario_modulo_origen IN ('inventario','terreno','finanzas'))
);

CREATE TABLE reporte_movimiento_inventario (
    movimiento_inventario_id_movimiento  BIGINT NOT NULL,
    reporte_id_reporte                   BIGINT NOT NULL,
    CONSTRAINT pk_rep_mov PRIMARY KEY (movimiento_inventario_id_movimiento, reporte_id_reporte)
);

CREATE TABLE alerta_inventario (
    alerta_inventario_id_alerta                  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    alerta_inventario_mensaje                    TEXT,
    alerta_inventario_fecha_generacion           TIMESTAMPTZ NOT NULL DEFAULT now(),
    alerta_inventario_fecha_est_agotamiento      DATE,
    alerta_inventario_estado                     VARCHAR(50) NOT NULL,
    material_sku                                 VARCHAR(16) NOT NULL,
    proveedor_id_proveedor                       BIGINT,
    alerta_inventario_tipo_alerta_id_tipo_alerta BIGINT      NOT NULL,
    historial_alerta_id_historial                BIGINT,
    -- CU-57: alertas por diferencia de inventario
    bodega_id_bodega                             BIGINT,
    conteo_ciclico_id_conteo                     BIGINT,
    alerta_inventario_diferencia                 NUMERIC(12,4),
    alerta_inventario_diferencia_pct             NUMERIC(9,2),
    -- CU-47: cantidad sugerida de reposicion
    alerta_inventario_cantidad_sugerida          NUMERIC(12,4),
    usuario_id_usuario                           BIGINT,
    CONSTRAINT pk_alerta_inv PRIMARY KEY (alerta_inventario_id_alerta)
);

CREATE TABLE reserva_inventario (
    reserva_inventario_id_reserva         BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    reserva_inventario_cantidad_reservada NUMERIC(12,4) NOT NULL,
    reserva_inventario_fecha_reserva      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    reserva_inventario_fecha_liberacion   TIMESTAMPTZ,
    reserva_inventario_estado_reserva     VARCHAR(50)   NOT NULL,
    material_sku                          VARCHAR(16)   NOT NULL,
    -- FK blandas hacia terreno/produccion
    proyecto_id_proyecto                  BIGINT,
    orden_trabajo_id_orden                BIGINT,
    -- FK blanda hacia finanzas.nota_venta (el pedido)
    nota_venta_id_nota_venta              BIGINT,
    -- CU-124: lote y bodega reservados (NULL en reservas sin lote especifico)
    lote_id_lote                          BIGINT,
    bodega_id_bodega                      BIGINT,
    -- CU-120: item del pedido de instalacion al que pertenece (una reserva por lote)
    preparacion_pedido_detalle_id         BIGINT,
    -- CU-131/132 (D48): quien la creo; quien la libero o anulo y por que
    usuario_id_usuario                    BIGINT,
    usuario_id_liberacion                 BIGINT,
    reserva_inventario_motivo_liberacion  TEXT,
    CONSTRAINT pk_reserva_inv PRIMARY KEY (reserva_inventario_id_reserva),
    CONSTRAINT ck_res_cant CHECK (reserva_inventario_cantidad_reservada >= 0)
);

CREATE TABLE alerta_faltante_pedido (
    alerta_faltante_pedido_id_alerta_faltante  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    alerta_faltante_pedido_fecha_generacion    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    alerta_faltante_pedido_cantidad_disponible NUMERIC(12,4),
    alerta_faltante_pedido_cantidad_requerida  NUMERIC(12,4),
    alerta_faltante_pedido_horas_anticipacion  INTEGER,
    alerta_faltante_pedido_estado              VARCHAR(50)   NOT NULL,
    material_sku                               VARCHAR(16)   NOT NULL,
    proveedor_id_proveedor                     BIGINT,
    usuario_id_usuario                         BIGINT,
    -- FK blanda hacia terreno/produccion
    proyecto_id_proyecto                       BIGINT,
    -- CU-122: origen de la alerta
    alerta_faltante_pedido_origen              VARCHAR(30)   NOT NULL DEFAULT 'faltante',
    -- FK blanda hacia finanzas.nota_venta (el pedido)
    nota_venta_id_nota_venta                   BIGINT,
    CONSTRAINT pk_alert_falt PRIMARY KEY (alerta_faltante_pedido_id_alerta_faltante),
    CONSTRAINT ck_afp_disp CHECK (alerta_faltante_pedido_cantidad_disponible >= 0),
    CONSTRAINT ck_afp_req  CHECK (alerta_faltante_pedido_cantidad_requerida >= 0),
    CONSTRAINT ck_afp_hrs  CHECK (alerta_faltante_pedido_horas_anticipacion >= 0),
    CONSTRAINT ck_afp_origen CHECK (alerta_faltante_pedido_origen IN ('faltante','insumo_especial'))
);

CREATE TABLE notificacion (
    notificacion_id_notificacion   BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    notificacion_tipo_notificacion VARCHAR(150),
    notificacion_mensaje           TEXT,
    notificacion_fecha_generacion  TIMESTAMPTZ NOT NULL DEFAULT now(),
    notificacion_estado_lectura    VARCHAR(50) NOT NULL DEFAULT 'no_leida',
    notificacion_origen            VARCHAR(150),
    alerta_inventario_id_alerta    BIGINT,
    usuario_id_usuario             BIGINT      NOT NULL,
    CONSTRAINT pk_notif PRIMARY KEY (notificacion_id_notificacion)
);

CREATE TABLE preparacion_pedido (
    preparacion_pedido_id_preparacion  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    preparacion_pedido_observacion     TEXT,
    -- Filas antiguas (por reserva). CU-120: las nuevas son por venta y no la usan
    reserva_inventario_id_reserva      BIGINT,
    usuario_id_usuario                 BIGINT,
    -- CU-120 (D12): una preparacion por venta
    nota_venta_id_nota_venta           BIGINT,
    preparacion_pedido_fecha_creacion  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pk_prep_ped PRIMARY KEY (preparacion_pedido_id_preparacion)
);

CREATE TABLE preparacion_pedido_estado (
    preparacion_pedido_estado_id_estado_preparacion  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    preparacion_pedido_estado_nombre_estado          VARCHAR(100) NOT NULL,
    preparacion_pedido_estado_timestamp_accion       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    preparacion_pedido_id_preparacion                BIGINT       NOT NULL,
    -- CU-119/120: quien hizo el cambio de estado
    usuario_id_usuario                               BIGINT,
    -- CU-125 (D47): trabajador que carga, por RUT (FK blanda hacia finanzas.empleado)
    empleado_rut                                     VARCHAR(12),
    CONSTRAINT pk_prep_ped_est PRIMARY KEY (preparacion_pedido_estado_id_estado_preparacion)
);

-- CU-120: cantidad pedida por insumo y su bodega (D45). Lo reservado sale de reserva_inventario (una por lote).
CREATE TABLE preparacion_pedido_detalle (
    preparacion_pedido_detalle_id                 BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    preparacion_pedido_id_preparacion             BIGINT        NOT NULL,
    material_sku                                  VARCHAR(16)   NOT NULL,
    preparacion_pedido_detalle_cantidad_requerida NUMERIC(12,4) NOT NULL,
    preparacion_pedido_detalle_origen             VARCHAR(10)   NOT NULL,
    bodega_id_bodega                              BIGINT        NOT NULL,
    -- CU-126 (D46): retiro por insumo. NULL = pendiente de retiro
    preparacion_pedido_detalle_cantidad_retirada  NUMERIC(12,4),
    preparacion_pedido_detalle_fecha_retiro       TIMESTAMPTZ,
    usuario_id_retiro                             BIGINT,
    CONSTRAINT pk_prep_ped_det PRIMARY KEY (preparacion_pedido_detalle_id),
    CONSTRAINT uk_prep_ped_det UNIQUE (preparacion_pedido_id_preparacion, material_sku),
    CONSTRAINT ck_prep_ped_det_cant CHECK (preparacion_pedido_detalle_cantidad_requerida > 0),
    CONSTRAINT ck_prep_ped_det_origen CHECK (preparacion_pedido_detalle_origen IN ('receta', 'manual')),
    CONSTRAINT ck_prep_ped_det_retirada CHECK (preparacion_pedido_detalle_cantidad_retirada IS NULL OR preparacion_pedido_detalle_cantidad_retirada >= 0)
);

CREATE TABLE perfil_permiso (
    perfil_id_perfil      BIGINT  NOT NULL,
    permiso_id_permiso    BIGINT  NOT NULL,
    perfil_permiso_activo BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT pk_perfil_permiso PRIMARY KEY (perfil_id_perfil, permiso_id_permiso)
);

-- NOTA: usuario ya no referencia empleado con FK formal.
-- empleado_rut_empleado se mantiene como referencia blanda hacia finanzas.schema.
CREATE TABLE usuario (
    usuario_id_usuario                               BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    usuario_fecha_de_ultima_edicion                  TIMESTAMPTZ,
    usuario_rut_usuario                              VARCHAR(12),
    usuario_fecha_de_creacion                        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    usuario_correo                                   VARCHAR(254),
    usuario_username                                 VARCHAR(100) NOT NULL,
    usuario_estado_cuenta                            VARCHAR(50)  NOT NULL,
    usuario_fecha_ultima_conexion                    TIMESTAMPTZ,
    -- OPUS-8: desactivacion/activacion diferida de la cuenta. La ejecuta el
    -- middleware de auth en el siguiente request del usuario, o procesarProgramaciones.
    usuario_desactivacion_programada                 TIMESTAMPTZ,
    usuario_activacion_programada                    TIMESTAMPTZ,
    usuario_nombre_completo_primer_nombre_usuario    VARCHAR(100),
    usuario_nombre_completo_segundo_nombre_usuario   VARCHAR(100),
    usuario_nombre_completo_primer_apellido_usuario  VARCHAR(100),
    usuario_nombre_completo_segundo_apellido_usuario VARCHAR(100),
    usuario_es_gerencia                              BOOLEAN NOT NULL DEFAULT FALSE,
    gerencia                                         TEXT,
    usuario_es_tecnico                               BOOLEAN NOT NULL DEFAULT FALSE,
    tecnico                                          TEXT,
    usuario_es_jop                                   BOOLEAN NOT NULL DEFAULT FALSE,
    jop                                              TEXT,
    usuario_es_administrador                         BOOLEAN NOT NULL DEFAULT FALSE,
    administrador                                    TEXT,
    usuario_es_secretaria                            BOOLEAN NOT NULL DEFAULT FALSE,
    secretaria                                       TEXT,
    perfil_id_perfil                                 BIGINT,
    -- FK blanda hacia finanzas.empleado (sin constraint cross-schema)
    empleado_rut_empleado                            VARCHAR(12),
    CONSTRAINT pk_usuario PRIMARY KEY (usuario_id_usuario),
    CONSTRAINT uk_usuario_username UNIQUE (usuario_username),
    CONSTRAINT uk_usuario_correo   UNIQUE (usuario_correo),
    CONSTRAINT uk_usuario_rut      UNIQUE (usuario_rut_usuario)
);

CREATE TABLE usuario_contrasena (
    usuario_id_usuario BIGINT  NOT NULL,
    usuario_contrasena TEXT    NOT NULL,
    es_temporal        BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT pk_usr_pass PRIMARY KEY (usuario_id_usuario)
);

CREATE TABLE orden_trabajo (
    orden_trabajo_id_orden                           BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    orden_trabajo_fecha_hora                         TIMESTAMPTZ NOT NULL DEFAULT now(),
    orden_trabajo_estado                             VARCHAR(50) NOT NULL,
    -- FK blandas hacia terreno
    especificaciones_puerta_id_especificacion_puerta BIGINT,
    proyecto_id_proyecto                             BIGINT,
    area_trabajo_id_area                             BIGINT      NOT NULL,
    usuario_id_usuario                               BIGINT      NOT NULL,
    -- OPUS-7 (Req #9): empleado tentativo de la programacion, editable.
    -- Distinto de usuario_id_usuario, que es el responsable formal de la OT.
    empleado_tentativo_id                            BIGINT,
    -- R1: receta cargada (el id es la version) y cantidad de puertas
    producto_terminado_id_producto                   BIGINT,
    orden_trabajo_cantidad_puertas                   INTEGER,
    CONSTRAINT pk_orden_trab PRIMARY KEY (orden_trabajo_id_orden),
    CONSTRAINT ck_ot_cantidad_puertas CHECK (orden_trabajo_cantidad_puertas > 0)
);

CREATE TABLE material_orden_trabajo (
    material_sku                            VARCHAR(16)   NOT NULL,
    orden_trabajo_id_orden                  BIGINT        NOT NULL,
    material_orden_trabajo_consumo_estimado NUMERIC(12,4),
    material_orden_trabajo_consumo_real     NUMERIC(12,4),
    CONSTRAINT pk_mat_ot PRIMARY KEY (material_sku, orden_trabajo_id_orden),
    CONSTRAINT ck_mat_ot_est  CHECK (material_orden_trabajo_consumo_estimado >= 0),
    CONSTRAINT ck_mat_ot_real CHECK (material_orden_trabajo_consumo_real >= 0)
);

CREATE TABLE insumo_estandar_proceso (
    insumo_estandar_proceso_id_insumo_estandar BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    insumo_estandar_proceso_cantidad_estandar  NUMERIC(12,4) NOT NULL,
    insumo_estandar_proceso_observacion        TEXT,
    insumo_estandar_proceso_activo             BOOLEAN NOT NULL DEFAULT TRUE,
    material_sku                               VARCHAR(16) NOT NULL,
    area_trabajo_id_area                       BIGINT      NOT NULL,
    -- CU-102: versiones de la plantilla por area
    insumo_estandar_proceso_version            INTEGER     NOT NULL DEFAULT 1,
    insumo_estandar_proceso_fecha_creacion     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pk_ins_est PRIMARY KEY (insumo_estandar_proceso_id_insumo_estandar),
    CONSTRAINT ck_ins_est_cant CHECK (insumo_estandar_proceso_cantidad_estandar >= 0)
);

CREATE TABLE reporte (
    reporte_id_reporte          BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    reporte_periodo_fin         DATE         NOT NULL,
    reporte_fecha_generacion    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    reporte_formato_exportacion VARCHAR(50),
    reporte_estado              VARCHAR(50)  NOT NULL,
    reporte_tipo_reporte        VARCHAR(150) NOT NULL,
    reporte_periodo_inicio      DATE         NOT NULL,
    usuario_id_usuario          BIGINT       NOT NULL,
    CONSTRAINT pk_reporte PRIMARY KEY (reporte_id_reporte)
);

-- OPUS-11 (Req #3): seguimiento de pintura por peso de envase.
-- Cada fila es UN retiro de pintura: se pesa el envase al salir de bodega
-- (peso_entrada_gr) y al devolverlo (peso_salida_gr). Lo consumido es la resta.
-- peso_consumido_gr queda NULL mientras el envase no vuelve — a proposito: un
-- retiro abierto tiene consumo DESCONOCIDO, no "todo el envase".
CREATE TABLE seguimiento_pintura (
    seguimiento_pintura_id  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    material_sku            VARCHAR(16)   NOT NULL,
    orden_trabajo_id_orden  BIGINT,
    area_trabajo_id         BIGINT,
    fecha_uso               TIMESTAMPTZ   NOT NULL DEFAULT now(),
    fecha_devolucion        TIMESTAMPTZ,
    peso_entrada_gr         NUMERIC(10,2) NOT NULL,
    peso_salida_gr          NUMERIC(10,2),
    peso_consumido_gr       NUMERIC(10,2) GENERATED ALWAYS AS (peso_entrada_gr - peso_salida_gr) STORED,
    color_aplicado          VARCHAR(100),
    superficie_m2           NUMERIC(10,2),
    usuario_id_usuario      BIGINT,
    observacion             TEXT,
    -- OPUS-16: el consumo de pintura descuenta stock. Las pinturas se llevan en
    -- KILOGRAMOS, asi que el consumo medido en gramos se descuenta / 1000.
    bodega_id_bodega        BIGINT,
    estado                  VARCHAR(20)   NOT NULL DEFAULT 'abierto',
    movimiento_inventario_id_movimiento BIGINT,
    stock_descontado_kg     NUMERIC(12,4) NOT NULL DEFAULT 0,
    CONSTRAINT pk_seguimiento_pintura PRIMARY KEY (seguimiento_pintura_id),
    CONSTRAINT ck_seg_pint_estado CHECK (estado IN ('abierto','cerrado','anulado')),
    CONSTRAINT ck_peso_entrada CHECK (peso_entrada_gr > 0),
    CONSTRAINT ck_peso_salida  CHECK (peso_salida_gr IS NULL OR peso_salida_gr >= 0),
    CONSTRAINT ck_peso_logico  CHECK (peso_salida_gr IS NULL OR peso_salida_gr <= peso_entrada_gr),
    CONSTRAINT ck_superficie   CHECK (superficie_m2 IS NULL OR superficie_m2 > 0),
    -- el envase o esta devuelto (peso + fecha) o no lo esta; nunca a medias
    CONSTRAINT ck_devolucion   CHECK ((peso_salida_gr IS NULL) = (fecha_devolucion IS NULL))
);

-- OPUS-13 (Req #5): clasificacion y valorizacion completa de herramientas.
-- Configuracion de depreciacion: UNA fila por herramienta (es un parametro, no un log).
CREATE TABLE depreciacion_herramienta (
    depreciacion_id           BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    material_sku              VARCHAR(16)   NOT NULL,
    metodo_depreciacion       VARCHAR(50)   NOT NULL DEFAULT 'lineal',
    vida_util_meses           INTEGER,
    vida_util_usos            INTEGER,
    valor_residual            NUMERIC(14,2) NOT NULL DEFAULT 0,
    fecha_inicio_depreciacion DATE          NOT NULL,
    observacion               TEXT,
    CONSTRAINT pk_depreciacion_herramienta PRIMARY KEY (depreciacion_id),
    CONSTRAINT uq_dep_herr_material UNIQUE (material_sku),
    CONSTRAINT ck_dep_metodo   CHECK (metodo_depreciacion IN ('lineal','uso')),
    CONSTRAINT ck_vida_util    CHECK (vida_util_meses > 0 OR vida_util_usos > 0),
    CONSTRAINT ck_dep_residual CHECK (valor_residual >= 0),
    -- el metodo elegido necesita SU parametro, si no el calculo es imposible
    CONSTRAINT ck_dep_metodo_param CHECK (
      (metodo_depreciacion = 'lineal' AND vida_util_meses > 0) OR
      (metodo_depreciacion = 'uso'    AND vida_util_usos  > 0))
);

-- Quien tiene cada herramienta. REEMPLAZA en la practica a
-- terreno.prestamo_herramientas, que no sirve: su sku_material es BIGINT contra
-- un material_sku VARCHAR(16) y su fecha_devolucion es NOT NULL, con lo cual esa
-- tabla no puede representar un prestamo VIGENTE.
CREATE TABLE asignacion_herramienta (
    asignacion_id       BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    material_sku        VARCHAR(16)  NOT NULL,
    area_trabajo_id     BIGINT,
    empleado_rut        VARCHAR(12),   -- FK blanda hacia finanzas.empleado
    cantidad            INTEGER      NOT NULL DEFAULT 1,
    fecha_asignacion    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    fecha_devolucion    TIMESTAMPTZ,
    estado              VARCHAR(50)  NOT NULL DEFAULT 'asignada',
    observacion         TEXT,
    usuario_id_usuario  BIGINT,
    CONSTRAINT pk_asignacion_herramienta PRIMARY KEY (asignacion_id),
    CONSTRAINT ck_asig_estado   CHECK (estado IN ('asignada','devuelta','perdida','dada_de_baja')),
    CONSTRAINT ck_asig_cantidad CHECK (cantidad > 0),
    -- una asignacion abierta no tiene fecha de devolucion, y una cerrada si
    CONSTRAINT ck_asig_cierre   CHECK ((estado = 'asignada') = (fecha_devolucion IS NULL)),
    -- tiene que estar asignada A alguien: un empleado o un area
    CONSTRAINT ck_asig_destino  CHECK (empleado_rut IS NOT NULL OR area_trabajo_id IS NOT NULL)
);

CREATE TABLE mantenimiento_herramienta (
    mantenimiento_id      BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    material_sku          VARCHAR(16)  NOT NULL,
    fecha_mantenimiento   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    tipo                  VARCHAR(50)  NOT NULL,
    descripcion           TEXT,
    costo_mantenimiento   NUMERIC(14,2),
    proximo_mantenimiento DATE,
    usuario_id_usuario    BIGINT,
    CONSTRAINT pk_mantenimiento_herramienta PRIMARY KEY (mantenimiento_id),
    CONSTRAINT ck_mant_tipo  CHECK (tipo IN ('preventivo','correctivo','calibracion')),
    CONSTRAINT ck_mant_costo CHECK (costo_mantenimiento IS NULL OR costo_mantenimiento >= 0)
);

-- ── Incremento 3 + 4 ─────────────────────────────────────────

-- CU-37 / CU-43: conteo ciclico por bodega
CREATE TABLE conteo_ciclico (
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

CREATE TABLE conteo_ciclico_detalle (
    conteo_ciclico_id_conteo                BIGINT      NOT NULL,
    material_sku                            VARCHAR(16) NOT NULL,
    conteo_ciclico_detalle_cantidad_contada NUMERIC(12,4),              -- NULL = no contado (CU-43, Excepcion 1)
    conteo_ciclico_detalle_stock_teorico    NUMERIC(12,4),              -- se guarda AL CONFIRMAR
    conteo_ciclico_detalle_no_esperado      BOOLEAN NOT NULL DEFAULT FALSE,  -- CU-37, Excepcion 4
    conteo_ciclico_detalle_observacion      TEXT,
    CONSTRAINT pk_conteo_det PRIMARY KEY (conteo_ciclico_id_conteo, material_sku),
    CONSTRAINT ck_conteo_det_cant CHECK (conteo_ciclico_detalle_cantidad_contada IS NULL OR conteo_ciclico_detalle_cantidad_contada >= 0)
);

CREATE TABLE diferencia_inventario (
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
    diferencia_inventario_tolerancia_pct     NUMERIC(6,2),             -- tolerancia aplicada al procesar
    diferencia_inventario_umbral_critico_pct NUMERIC(6,2),             -- umbral critico vigente al procesar (CU-57)
    CONSTRAINT pk_dif_inv PRIMARY KEY (diferencia_inventario_id),
    CONSTRAINT uk_dif_inv_conteo_sku UNIQUE (conteo_ciclico_id_conteo, material_sku),
    CONSTRAINT ck_dif_inv_clasif CHECK (diferencia_inventario_clasificacion IN ('faltante','sobrante','sin_diferencia'))
);

-- CU-43 / CU-57: tolerancias del conteo por tipo de producto, editables por Gerencia
-- (reemplaza a D10, que las dejaba como constantes en el codigo)
CREATE TABLE tolerancia_conteo (
    tolerancia_conteo_tipo                VARCHAR(20)  NOT NULL,   -- 'critico' | 'no_critico'
    tolerancia_conteo_tolerancia_pct      NUMERIC(6,2) NOT NULL,   -- hasta aqui es ruido normal
    tolerancia_conteo_umbral_critico_pct  NUMERIC(6,2) NOT NULL,   -- sobre esto, alerta critica (CU-57)
    tolerancia_conteo_fecha_modificacion  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    usuario_id_usuario                    BIGINT,                  -- quien la cambio (NULL = valor inicial)
    CONSTRAINT pk_tol_conteo      PRIMARY KEY (tolerancia_conteo_tipo),
    CONSTRAINT ck_tol_conteo_tipo CHECK (tolerancia_conteo_tipo IN ('critico','no_critico')),
    CONSTRAINT ck_tol_conteo_val  CHECK (tolerancia_conteo_tolerancia_pct >= 0
                                     AND tolerancia_conteo_umbral_critico_pct > tolerancia_conteo_tolerancia_pct
                                     AND tolerancia_conteo_umbral_critico_pct <= 1000)
);

-- CU-42: intentos de reautenticacion (el bloqueo sobrevive a un reinicio)
CREATE TABLE reautenticacion_intento (
    reautenticacion_intento_id          BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    usuario_id_usuario                  BIGINT      NOT NULL,
    reautenticacion_intento_fecha_hora  TIMESTAMPTZ NOT NULL DEFAULT now(),
    reautenticacion_intento_exitoso     BOOLEAN     NOT NULL,
    reautenticacion_intento_accion      VARCHAR(50) NOT NULL DEFAULT 'revertir_movimiento',
    movimiento_inventario_id_movimiento BIGINT,
    CONSTRAINT pk_reauth PRIMARY KEY (reautenticacion_intento_id)
);

-- CU-103 / CU-104: historial de desviaciones de consumo por OT
CREATE TABLE diferencial_consumo (
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

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 3 — FOREIGN KEYS INTERNAS
-- ══════════════════════════════════════════════════════════════

-- SONNET-9: FK de historial_precio_material (ver la nota en su CREATE TABLE)
ALTER TABLE historial_precio_material
    ADD CONSTRAINT fk_hist_precio_material  FOREIGN KEY (material_sku)           REFERENCES material(material_sku),
    ADD CONSTRAINT fk_hist_precio_proveedor FOREIGN KEY (proveedor_id_proveedor) REFERENCES proveedor(proveedor_id_proveedor),
    ADD CONSTRAINT fk_hist_precio_factura   FOREIGN KEY (factura_compra_id)      REFERENCES factura_compra(factura_compra_id_factura),
    ADD CONSTRAINT fk_hist_precio_lote_fp   FOREIGN KEY (lote_fecha_pedido_id)   REFERENCES lote_fecha_pedido(lote_fecha_pedido_id),
    ADD CONSTRAINT fk_hist_precio_usuario   FOREIGN KEY (usuario_id_usuario)     REFERENCES usuario(usuario_id_usuario);

-- OPUS-13: FK reales salvo empleado_rut, que cruza a finanzas y queda blanda
ALTER TABLE depreciacion_herramienta
    ADD CONSTRAINT fk_dep_herr_material FOREIGN KEY (material_sku) REFERENCES material(material_sku);

ALTER TABLE asignacion_herramienta
    ADD CONSTRAINT fk_asig_herr_material FOREIGN KEY (material_sku)       REFERENCES material(material_sku),
    ADD CONSTRAINT fk_asig_herr_area     FOREIGN KEY (area_trabajo_id)    REFERENCES area_trabajo(area_trabajo_id_area),
    ADD CONSTRAINT fk_asig_herr_usuario  FOREIGN KEY (usuario_id_usuario) REFERENCES usuario(usuario_id_usuario);

ALTER TABLE mantenimiento_herramienta
    ADD CONSTRAINT fk_mant_herr_material FOREIGN KEY (material_sku)       REFERENCES material(material_sku),
    ADD CONSTRAINT fk_mant_herr_usuario  FOREIGN KEY (usuario_id_usuario) REFERENCES usuario(usuario_id_usuario);

-- OPUS-11: seguimiento_pintura vive en inventario, igual que material,
-- orden_trabajo, area_trabajo y usuario, asi que sus FK son REALES (no blandas)
ALTER TABLE seguimiento_pintura
    ADD CONSTRAINT fk_seg_pint_material FOREIGN KEY (material_sku)           REFERENCES material(material_sku),
    ADD CONSTRAINT fk_seg_pint_ot       FOREIGN KEY (orden_trabajo_id_orden) REFERENCES orden_trabajo(orden_trabajo_id_orden),
    ADD CONSTRAINT fk_seg_pint_area     FOREIGN KEY (area_trabajo_id)        REFERENCES area_trabajo(area_trabajo_id_area),
    ADD CONSTRAINT fk_seg_pint_usuario  FOREIGN KEY (usuario_id_usuario)     REFERENCES usuario(usuario_id_usuario),
    ADD CONSTRAINT fk_seg_pint_bodega   FOREIGN KEY (bodega_id_bodega)       REFERENCES bodega(bodega_id_bodega);

ALTER TABLE material_clasificacion_subcategoria
    ADD CONSTRAINT fk_sub_cat
        FOREIGN KEY (material_clasificacion_categoria_id)
        REFERENCES material_clasificacion_categoria(material_clasificacion_categoria_id);

ALTER TABLE material_clasificacion_nivel_especifico
    ADD CONSTRAINT fk_niv_sub
        FOREIGN KEY (material_clasificacion_subcategoria_id)
        REFERENCES material_clasificacion_subcategoria(material_clasificacion_subcategoria_id);

ALTER TABLE alerta_inventario_tipo_alerta
    ADD CONSTRAINT fk_tipo_alert_niv
        FOREIGN KEY (alerta_inventario_nivel_prioridad_id)
        REFERENCES alerta_inventario_nivel_prioridad(alerta_inventario_nivel_prioridad_id_nivel_prioridad);

ALTER TABLE movimiento_inventario_motivo_movimiento
    ADD CONSTRAINT fk_motivo_clas
        FOREIGN KEY (movimiento_inventario_clasificacion_salida_id_clasificacion_salida)
        REFERENCES movimiento_inventario_clasificacion_salida(movimiento_inventario_clasificacion_salida_id_clasificacion_salida);

ALTER TABLE material
    ADD CONSTRAINT fk_mat_cat_gen
        FOREIGN KEY (material_categoria_general_id_categoria_general)
        REFERENCES material_categoria_general(material_categoria_general_id_categoria_general),
    ADD CONSTRAINT fk_mat_cat_func
        FOREIGN KEY (material_categoria_funcional_id_categoria_funcional)
        REFERENCES material_categoria_funcional(material_categoria_funcional_id_categoria_funcional),
    ADD CONSTRAINT fk_mat_niv_esp
        FOREIGN KEY (material_clasificacion_nivel_especifico_id)
        REFERENCES material_clasificacion_nivel_especifico(material_clasificacion_nivel_especifico_id),
    ADD CONSTRAINT fk_mat_unidad
        FOREIGN KEY (material_unidad_medida_id_unidad_medida)
        REFERENCES material_unidad_medida(material_unidad_medida_id_unidad_medida);

ALTER TABLE material_codigo_barras
    ADD CONSTRAINT fk_cod_bar_mat
        FOREIGN KEY (material_sku) REFERENCES material(material_sku);

ALTER TABLE material_proveedor
    ADD CONSTRAINT fk_mat_prov_mat  FOREIGN KEY (material_sku) REFERENCES material(material_sku),
    ADD CONSTRAINT fk_mat_prov_prov FOREIGN KEY (proveedor_id_proveedor) REFERENCES proveedor(proveedor_id_proveedor);

ALTER TABLE material_producto_terminado
    ADD CONSTRAINT fk_mat_prod_mat  FOREIGN KEY (material_sku) REFERENCES material(material_sku),
    ADD CONSTRAINT fk_mat_prod_prod FOREIGN KEY (producto_terminado_id_producto) REFERENCES producto_terminado(producto_terminado_id_producto),
    ADD CONSTRAINT fk_mat_prod_area FOREIGN KEY (area_trabajo_id_area) REFERENCES area_trabajo(area_trabajo_id_area);

ALTER TABLE producto_terminado
    ADD CONSTRAINT fk_prod_term_reemplazo FOREIGN KEY (producto_terminado_reemplazada_por) REFERENCES producto_terminado(producto_terminado_id_producto);

ALTER TABLE proveedor_contacto_telefono
    ADD CONSTRAINT fk_prov_tel_prov FOREIGN KEY (proveedor_id_proveedor) REFERENCES proveedor(proveedor_id_proveedor);

ALTER TABLE proveedor_contacto_correo
    ADD CONSTRAINT fk_prov_cor_prov FOREIGN KEY (proveedor_id_proveedor) REFERENCES proveedor(proveedor_id_proveedor);

ALTER TABLE anaquel
    ADD CONSTRAINT fk_anaquel_bodega FOREIGN KEY (bodega_id_bodega) REFERENCES bodega(bodega_id_bodega);

ALTER TABLE factura_compra
    ADD CONSTRAINT fk_fact_prov       FOREIGN KEY (proveedor_id_proveedor) REFERENCES proveedor(proveedor_id_proveedor),
    ADD CONSTRAINT fk_fact_tipocambio FOREIGN KEY (factura_compra_tipo_cambio_id_tipo_cambio) REFERENCES factura_compra_tipo_cambio(factura_compra_tipo_cambio_id_tipo_cambio);

ALTER TABLE lote
    ADD CONSTRAINT fk_lote_prov FOREIGN KEY (proveedor_id_proveedor) REFERENCES proveedor(proveedor_id_proveedor),
    ADD CONSTRAINT fk_lote_fact FOREIGN KEY (factura_compra_id_factura) REFERENCES factura_compra(factura_compra_id_factura);
    -- proyecto_id_proyecto: FK blanda hacia terreno

ALTER TABLE lote_fecha_pedido
    ADD CONSTRAINT fk_lote_fp_lote FOREIGN KEY (lote_id_lote) REFERENCES lote(lote_id_lote);

ALTER TABLE inventario_bodega
    ADD CONSTRAINT fk_inv_bod_mat    FOREIGN KEY (material_sku) REFERENCES material(material_sku),
    ADD CONSTRAINT fk_inv_bod_lote   FOREIGN KEY (lote_id_lote) REFERENCES lote(lote_id_lote),
    ADD CONSTRAINT fk_inv_bod_bodega FOREIGN KEY (bodega_id_bodega) REFERENCES bodega(bodega_id_bodega),
    ADD CONSTRAINT fk_inv_bod_anaquel FOREIGN KEY (anaquel_id_anaquel) REFERENCES anaquel(anaquel_id_anaquel);

ALTER TABLE movimiento_inventario
    ADD CONSTRAINT fk_mov_mat    FOREIGN KEY (material_sku) REFERENCES material(material_sku),
    ADD CONSTRAINT fk_mov_bodega FOREIGN KEY (bodega_id_bodega) REFERENCES bodega(bodega_id_bodega),
    ADD CONSTRAINT fk_mov_lote   FOREIGN KEY (lote_id_lote) REFERENCES lote(lote_id_lote),
    ADD CONSTRAINT fk_mov_fact   FOREIGN KEY (factura_compra_id_factura_compra) REFERENCES factura_compra(factura_compra_id_factura),
    ADD CONSTRAINT fk_mov_tipo   FOREIGN KEY (movimiento_inventario_tipo_movimiento_id_tipo_movimiento)
                                 REFERENCES movimiento_inventario_tipo_movimiento(movimiento_inventario_tipo_movimiento_id_tipo_movimiento),
    ADD CONSTRAINT fk_mov_motivo FOREIGN KEY (movimiento_inventario_motivo_movimiento_id_motivo_movimiento)
                                 REFERENCES movimiento_inventario_motivo_movimiento(movimiento_inventario_motivo_movimiento_id_motivo_movimiento),
    ADD CONSTRAINT fk_mov_usr    FOREIGN KEY (usuario_id_usuario) REFERENCES usuario(usuario_id_usuario);
    -- proyecto_id_proyecto: FK blanda hacia terreno

ALTER TABLE reporte_movimiento_inventario
    ADD CONSTRAINT fk_rep_mov_mov FOREIGN KEY (movimiento_inventario_id_movimiento)
                                  REFERENCES movimiento_inventario(movimiento_inventario_id_movimiento),
    ADD CONSTRAINT fk_rep_mov_rep FOREIGN KEY (reporte_id_reporte) REFERENCES reporte(reporte_id_reporte);

ALTER TABLE alerta_inventario
    ADD CONSTRAINT fk_alert_mat      FOREIGN KEY (material_sku) REFERENCES material(material_sku),
    ADD CONSTRAINT fk_alert_prov     FOREIGN KEY (proveedor_id_proveedor) REFERENCES proveedor(proveedor_id_proveedor),
    ADD CONSTRAINT fk_alert_tipo     FOREIGN KEY (alerta_inventario_tipo_alerta_id_tipo_alerta)
                                     REFERENCES alerta_inventario_tipo_alerta(alerta_inventario_tipo_alerta_id_tipo_alerta),
    ADD CONSTRAINT fk_alert_historial FOREIGN KEY (historial_alerta_id_historial)
                                     REFERENCES historial_alerta(historial_alerta_id_historial);

ALTER TABLE reserva_inventario
    ADD CONSTRAINT fk_res_mat FOREIGN KEY (material_sku) REFERENCES material(material_sku),
    ADD CONSTRAINT fk_res_ot  FOREIGN KEY (orden_trabajo_id_orden) REFERENCES orden_trabajo(orden_trabajo_id_orden),
    ADD CONSTRAINT fk_res_lote   FOREIGN KEY (lote_id_lote) REFERENCES lote(lote_id_lote),          -- CU-124
    ADD CONSTRAINT fk_res_bodega FOREIGN KEY (bodega_id_bodega) REFERENCES bodega(bodega_id_bodega), -- CU-124
    ADD CONSTRAINT fk_res_prep_det FOREIGN KEY (preparacion_pedido_detalle_id)                       -- CU-120
                   REFERENCES preparacion_pedido_detalle(preparacion_pedido_detalle_id) ON DELETE SET NULL,
    ADD CONSTRAINT fk_res_usr     FOREIGN KEY (usuario_id_usuario)    REFERENCES usuario(usuario_id_usuario),   -- CU-131
    ADD CONSTRAINT fk_res_usr_lib FOREIGN KEY (usuario_id_liberacion) REFERENCES usuario(usuario_id_usuario);   -- CU-132
    -- proyecto_id_proyecto: FK blanda hacia terreno

ALTER TABLE alerta_faltante_pedido
    ADD CONSTRAINT fk_afp_mat  FOREIGN KEY (material_sku) REFERENCES material(material_sku),
    ADD CONSTRAINT fk_afp_prov FOREIGN KEY (proveedor_id_proveedor) REFERENCES proveedor(proveedor_id_proveedor),
    ADD CONSTRAINT fk_afp_usr  FOREIGN KEY (usuario_id_usuario) REFERENCES usuario(usuario_id_usuario);
    -- proyecto_id_proyecto: FK blanda hacia terreno

ALTER TABLE notificacion
    ADD CONSTRAINT fk_notif_alert FOREIGN KEY (alerta_inventario_id_alerta) REFERENCES alerta_inventario(alerta_inventario_id_alerta),
    ADD CONSTRAINT fk_notif_usr   FOREIGN KEY (usuario_id_usuario) REFERENCES usuario(usuario_id_usuario);

ALTER TABLE preparacion_pedido
    ADD CONSTRAINT fk_prep_res FOREIGN KEY (reserva_inventario_id_reserva) REFERENCES reserva_inventario(reserva_inventario_id_reserva),
    ADD CONSTRAINT fk_prep_usr FOREIGN KEY (usuario_id_usuario) REFERENCES usuario(usuario_id_usuario);
    -- nota_venta_id_nota_venta: FK blanda hacia finanzas.nota_venta
CREATE UNIQUE INDEX uk_prep_ped_venta ON preparacion_pedido (nota_venta_id_nota_venta)
    WHERE nota_venta_id_nota_venta IS NOT NULL;

ALTER TABLE preparacion_pedido_estado
    ADD CONSTRAINT fk_prep_est_prep FOREIGN KEY (preparacion_pedido_id_preparacion)
                                    REFERENCES preparacion_pedido(preparacion_pedido_id_preparacion),
    ADD CONSTRAINT fk_prep_ped_est_usr FOREIGN KEY (usuario_id_usuario) REFERENCES usuario(usuario_id_usuario);

ALTER TABLE preparacion_pedido_detalle
    ADD CONSTRAINT fk_prep_ped_det_prep FOREIGN KEY (preparacion_pedido_id_preparacion)
                                        REFERENCES preparacion_pedido(preparacion_pedido_id_preparacion),
    ADD CONSTRAINT fk_prep_ped_det_mat  FOREIGN KEY (material_sku) REFERENCES material(material_sku),
    ADD CONSTRAINT fk_prep_ped_det_bodega FOREIGN KEY (bodega_id_bodega) REFERENCES bodega(bodega_id_bodega),
    ADD CONSTRAINT fk_prep_ped_det_usr_retiro FOREIGN KEY (usuario_id_retiro) REFERENCES usuario(usuario_id_usuario);   -- CU-126
    -- preparacion_pedido_estado.empleado_rut: FK blanda hacia finanzas.empleado (CU-125)

ALTER TABLE perfil_permiso
    ADD CONSTRAINT fk_pp_perfil  FOREIGN KEY (perfil_id_perfil)  REFERENCES perfil(perfil_id_perfil),
    ADD CONSTRAINT fk_pp_permiso FOREIGN KEY (permiso_id_permiso) REFERENCES permiso(permiso_id_permiso);

-- usuario.perfil_id_perfil → perfil (interna)
-- usuario.empleado_rut_empleado → FK blanda hacia finanzas.empleado (sin constraint)
ALTER TABLE usuario
    ADD CONSTRAINT fk_usr_perfil FOREIGN KEY (perfil_id_perfil) REFERENCES perfil(perfil_id_perfil);

ALTER TABLE usuario_contrasena
    ADD CONSTRAINT fk_usr_pass FOREIGN KEY (usuario_id_usuario) REFERENCES usuario(usuario_id_usuario);

ALTER TABLE orden_trabajo
    ADD CONSTRAINT fk_ot_area FOREIGN KEY (area_trabajo_id_area) REFERENCES area_trabajo(area_trabajo_id_area),
    ADD CONSTRAINT fk_ot_usr  FOREIGN KEY (usuario_id_usuario) REFERENCES usuario(usuario_id_usuario),
    ADD CONSTRAINT fk_ot_empleado_tentativo FOREIGN KEY (empleado_tentativo_id) REFERENCES usuario(usuario_id_usuario),
    ADD CONSTRAINT fk_ot_producto FOREIGN KEY (producto_terminado_id_producto) REFERENCES producto_terminado(producto_terminado_id_producto);
    -- proyecto_id_proyecto, especificaciones_puerta: FK blandas hacia terreno

ALTER TABLE material_orden_trabajo
    ADD CONSTRAINT fk_mot_mat FOREIGN KEY (material_sku) REFERENCES material(material_sku),
    ADD CONSTRAINT fk_mot_ot  FOREIGN KEY (orden_trabajo_id_orden) REFERENCES orden_trabajo(orden_trabajo_id_orden);

ALTER TABLE insumo_estandar_proceso
    ADD CONSTRAINT fk_ins_mat  FOREIGN KEY (material_sku) REFERENCES material(material_sku),
    ADD CONSTRAINT fk_ins_area FOREIGN KEY (area_trabajo_id_area) REFERENCES area_trabajo(area_trabajo_id_area);

ALTER TABLE reporte
    ADD CONSTRAINT fk_rep_usr FOREIGN KEY (usuario_id_usuario) REFERENCES usuario(usuario_id_usuario);

-- Incremento 3 + 4
ALTER TABLE conteo_ciclico
    ADD CONSTRAINT fk_conteo_bodega      FOREIGN KEY (bodega_id_bodega)   REFERENCES bodega(bodega_id_bodega),
    ADD CONSTRAINT fk_conteo_usr         FOREIGN KEY (usuario_id_usuario) REFERENCES usuario(usuario_id_usuario),
    ADD CONSTRAINT fk_conteo_usr_procesa FOREIGN KEY (usuario_procesa_id) REFERENCES usuario(usuario_id_usuario);

ALTER TABLE conteo_ciclico_detalle
    ADD CONSTRAINT fk_conteo_det_conteo FOREIGN KEY (conteo_ciclico_id_conteo) REFERENCES conteo_ciclico(conteo_ciclico_id_conteo),
    ADD CONSTRAINT fk_conteo_det_mat    FOREIGN KEY (material_sku)             REFERENCES material(material_sku);

ALTER TABLE diferencia_inventario
    ADD CONSTRAINT fk_dif_inv_conteo FOREIGN KEY (conteo_ciclico_id_conteo) REFERENCES conteo_ciclico(conteo_ciclico_id_conteo),
    ADD CONSTRAINT fk_dif_inv_mat    FOREIGN KEY (material_sku)             REFERENCES material(material_sku),
    ADD CONSTRAINT fk_dif_inv_usr    FOREIGN KEY (usuario_id_usuario)       REFERENCES usuario(usuario_id_usuario);

ALTER TABLE tolerancia_conteo
    ADD CONSTRAINT fk_tol_conteo_usr FOREIGN KEY (usuario_id_usuario) REFERENCES usuario(usuario_id_usuario);

ALTER TABLE alerta_inventario
    ADD CONSTRAINT fk_alert_bodega FOREIGN KEY (bodega_id_bodega)         REFERENCES bodega(bodega_id_bodega),
    ADD CONSTRAINT fk_alert_conteo FOREIGN KEY (conteo_ciclico_id_conteo) REFERENCES conteo_ciclico(conteo_ciclico_id_conteo),
    ADD CONSTRAINT fk_alert_usr    FOREIGN KEY (usuario_id_usuario)       REFERENCES usuario(usuario_id_usuario);

ALTER TABLE historial_alerta
    ADD CONSTRAINT fk_hist_alerta_usr FOREIGN KEY (usuario_id_usuario) REFERENCES usuario(usuario_id_usuario);

ALTER TABLE reautenticacion_intento
    ADD CONSTRAINT fk_reauth_usr FOREIGN KEY (usuario_id_usuario)                  REFERENCES usuario(usuario_id_usuario),
    ADD CONSTRAINT fk_reauth_mov FOREIGN KEY (movimiento_inventario_id_movimiento) REFERENCES movimiento_inventario(movimiento_inventario_id_movimiento);

ALTER TABLE movimiento_inventario
    ADD CONSTRAINT fk_mov_revertido FOREIGN KEY (movimiento_inventario_id_revertido)
                                    REFERENCES movimiento_inventario(movimiento_inventario_id_movimiento);

ALTER TABLE diferencial_consumo
    ADD CONSTRAINT fk_dif_cons_ot  FOREIGN KEY (orden_trabajo_id_orden) REFERENCES orden_trabajo(orden_trabajo_id_orden),
    ADD CONSTRAINT fk_dif_cons_mat FOREIGN KEY (material_sku)           REFERENCES material(material_sku),
    ADD CONSTRAINT fk_dif_cons_usr FOREIGN KEY (usuario_id_usuario)     REFERENCES usuario(usuario_id_usuario);
    -- reserva_inventario / alerta_faltante_pedido.nota_venta_id_nota_venta: FK blandas hacia finanzas

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 4 — ÍNDICES
-- ══════════════════════════════════════════════════════════════

CREATE INDEX idx_material_estado      ON material(material_estado);
CREATE INDEX idx_material_cat_gen     ON material(material_categoria_general_id_categoria_general);
CREATE INDEX idx_material_unidad      ON material(material_unidad_medida_id_unidad_medida);
CREATE INDEX idx_material_niv_esp     ON material(material_clasificacion_nivel_especifico_id);
CREATE INDEX idx_material_rotativo    ON material(material_es_rotativo);

CREATE INDEX idx_mov_inv_sku          ON movimiento_inventario(material_sku);
CREATE INDEX idx_mov_inv_fecha        ON movimiento_inventario(movimiento_inventario_fecha_hora);
CREATE INDEX idx_mov_inv_proyecto     ON movimiento_inventario(proyecto_id_proyecto);
CREATE INDEX idx_mov_inv_lote         ON movimiento_inventario(lote_id_lote);
CREATE INDEX idx_mov_inv_usuario      ON movimiento_inventario(usuario_id_usuario);
CREATE INDEX idx_mov_inv_tipo         ON movimiento_inventario(movimiento_inventario_tipo_movimiento_id_tipo_movimiento);
CREATE INDEX idx_mov_inv_bodega       ON movimiento_inventario(bodega_id_bodega);
CREATE INDEX idx_mov_inv_ot           ON movimiento_inventario(orden_trabajo_id_orden);
-- CU-107: idempotencia de los envios de otros modulos (unica por modulo)
CREATE UNIQUE INDEX uk_mov_inv_clave_envio ON movimiento_inventario (movimiento_inventario_modulo_origen, movimiento_inventario_clave_envio)
    WHERE movimiento_inventario_clave_envio IS NOT NULL;

-- OPUS-11: seguimiento de pintura
CREATE INDEX idx_seg_pint_sku     ON seguimiento_pintura(material_sku);
CREATE INDEX idx_seg_pint_ot      ON seguimiento_pintura(orden_trabajo_id_orden);
CREATE INDEX idx_seg_pint_fecha   ON seguimiento_pintura(fecha_uso DESC);
CREATE INDEX idx_seg_pint_abierto ON seguimiento_pintura(material_sku) WHERE peso_salida_gr IS NULL;
CREATE INDEX idx_seg_pint_estado  ON seguimiento_pintura(estado);

-- OPUS-13: herramientas
CREATE INDEX idx_asig_herr_sku     ON asignacion_herramienta(material_sku);
CREATE INDEX idx_asig_herr_area    ON asignacion_herramienta(area_trabajo_id);
CREATE INDEX idx_asig_herr_emp     ON asignacion_herramienta(empleado_rut);
CREATE INDEX idx_asig_herr_abierta ON asignacion_herramienta(material_sku) WHERE estado = 'asignada';
CREATE INDEX idx_mant_herr_sku     ON mantenimiento_herramienta(material_sku, fecha_mantenimiento DESC);
CREATE INDEX idx_mant_herr_proximo ON mantenimiento_herramienta(proximo_mantenimiento) WHERE proximo_mantenimiento IS NOT NULL;

CREATE INDEX idx_lote_proveedor       ON lote(proveedor_id_proveedor);
CREATE INDEX idx_lote_factura         ON lote(factura_compra_id_factura);
CREATE INDEX idx_lote_proyecto        ON lote(proyecto_id_proyecto);
CREATE INDEX idx_lote_fp              ON lote_fecha_pedido(lote_id_lote);

CREATE INDEX idx_inv_bod_sku          ON inventario_bodega(material_sku);
CREATE INDEX idx_inv_bod_bodega       ON inventario_bodega(bodega_id_bodega);
CREATE INDEX idx_inv_bod_anaquel      ON inventario_bodega(anaquel_id_anaquel);

CREATE INDEX idx_reserva_sku          ON reserva_inventario(material_sku);
CREATE INDEX idx_reserva_proyecto     ON reserva_inventario(proyecto_id_proyecto);
CREATE INDEX idx_reserva_orden        ON reserva_inventario(orden_trabajo_id_orden);

CREATE INDEX idx_alerta_sku           ON alerta_inventario(material_sku);
CREATE INDEX idx_alerta_estado        ON alerta_inventario(alerta_inventario_estado);
CREATE INDEX idx_alerta_fecha         ON alerta_inventario(alerta_inventario_fecha_generacion);

CREATE INDEX idx_notif_usuario        ON notificacion(usuario_id_usuario);
CREATE INDEX idx_notif_alerta         ON notificacion(alerta_inventario_id_alerta);

CREATE INDEX idx_ot_area              ON orden_trabajo(area_trabajo_id_area);
CREATE INDEX idx_ot_proyecto          ON orden_trabajo(proyecto_id_proyecto);
CREATE INDEX idx_ot_usuario           ON orden_trabajo(usuario_id_usuario);

CREATE INDEX idx_afp_sku              ON alerta_faltante_pedido(material_sku);
CREATE INDEX idx_afp_proyecto         ON alerta_faltante_pedido(proyecto_id_proyecto);

CREATE INDEX idx_ins_mat              ON insumo_estandar_proceso(material_sku);
CREATE INDEX idx_ins_area             ON insumo_estandar_proceso(area_trabajo_id_area);

CREATE INDEX idx_usr_perfil           ON usuario(perfil_id_perfil);
CREATE INDEX idx_usr_emp              ON usuario(empleado_rut_empleado);
CREATE INDEX idx_usr_desact            ON usuario(usuario_desactivacion_programada) WHERE usuario_desactivacion_programada IS NOT NULL;
CREATE INDEX idx_usr_activ             ON usuario(usuario_activacion_programada)    WHERE usuario_activacion_programada IS NOT NULL;

CREATE INDEX idx_prep_reserva         ON preparacion_pedido(reserva_inventario_id_reserva);
CREATE INDEX idx_prep_est             ON preparacion_pedido_estado(preparacion_pedido_id_preparacion);

CREATE INDEX idx_rep_usuario          ON reporte(usuario_id_usuario);

-- Incremento 3 + 4
CREATE INDEX idx_conteo_bodega_fecha  ON conteo_ciclico(bodega_id_bodega, conteo_ciclico_fecha_hora DESC);
CREATE INDEX idx_dif_inv_conteo       ON diferencia_inventario(conteo_ciclico_id_conteo);
CREATE INDEX idx_alert_bodega         ON alerta_inventario(bodega_id_bodega) WHERE bodega_id_bodega IS NOT NULL;
CREATE INDEX idx_reauth_usuario       ON reautenticacion_intento(usuario_id_usuario, reautenticacion_intento_fecha_hora DESC);
CREATE INDEX idx_mov_inv_revertido    ON movimiento_inventario(movimiento_inventario_id_revertido) WHERE movimiento_inventario_id_revertido IS NOT NULL;
CREATE INDEX idx_dif_cons_fecha       ON diferencial_consumo(diferencial_consumo_fecha DESC);
CREATE INDEX idx_res_nota_venta       ON reserva_inventario(nota_venta_id_nota_venta)     WHERE nota_venta_id_nota_venta IS NOT NULL;
CREATE INDEX idx_res_lote             ON reserva_inventario(lote_id_lote)                 WHERE lote_id_lote IS NOT NULL;   -- CU-124
CREATE INDEX idx_res_prep_det         ON reserva_inventario(preparacion_pedido_detalle_id) WHERE preparacion_pedido_detalle_id IS NOT NULL;   -- CU-120
CREATE INDEX idx_afp_nota_venta       ON alerta_faltante_pedido(nota_venta_id_nota_venta) WHERE nota_venta_id_nota_venta IS NOT NULL;

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 5 — COMENTARIOS
-- ══════════════════════════════════════════════════════════════

COMMENT ON SCHEMA inventario IS 'Módulo Inventario — Sistema Puertas Blindadas — Grupo 14';
COMMENT ON TABLE material IS 'Entidad central. SKU alfanumérico 4-16 chars. RN-PB-056 a 062.';
COMMENT ON TABLE lote IS 'Trazabilidad FIFO. proyecto_id_proyecto = FK blanda hacia terreno.';
COMMENT ON TABLE inventario_bodega IS 'Tabla ternaria MATERIAL-LOTE-BODEGA. Stock físico con trazabilidad de lote.';
COMMENT ON TABLE movimiento_inventario IS 'Evento central de stock. RN-PB-067 a 073. FKs blandas: proyecto.';
COMMENT ON TABLE usuario IS 'Dueño del módulo seguridad/compartido. empleado_rut_empleado es FK blanda hacia finanzas.';
COMMENT ON TABLE reporte IS 'reporte_tipo_reporte mantiene VARCHAR(150).';

COMMENT ON COLUMN lote.proyecto_id_proyecto IS 'FK blanda hacia terreno.proyecto — sin constraint cross-schema';
COMMENT ON COLUMN movimiento_inventario.proyecto_id_proyecto IS 'FK blanda hacia terreno.proyecto';
COMMENT ON COLUMN orden_trabajo.proyecto_id_proyecto IS 'FK blanda hacia terreno.proyecto';
COMMENT ON COLUMN orden_trabajo.especificaciones_puerta_id_especificacion_puerta IS 'FK blanda hacia terreno.especificacion_puerta';
COMMENT ON COLUMN orden_trabajo.producto_terminado_id_producto IS 'R1: receta cargada en la OT (el id es la version)';
COMMENT ON COLUMN orden_trabajo.orden_trabajo_cantidad_puertas IS 'R1: cantidad de puertas para la que se cargo la receta';
COMMENT ON COLUMN reserva_inventario.proyecto_id_proyecto IS 'FK blanda hacia terreno.proyecto';
COMMENT ON COLUMN alerta_faltante_pedido.proyecto_id_proyecto IS 'FK blanda hacia terreno.proyecto';
COMMENT ON COLUMN usuario.empleado_rut_empleado IS 'FK blanda hacia finanzas.empleado — sin constraint cross-schema';

-- Incremento 3 + 4
COMMENT ON COLUMN reserva_inventario.nota_venta_id_nota_venta     IS 'FK blanda hacia finanzas.nota_venta — el pedido o venta de la reserva';
COMMENT ON COLUMN reserva_inventario.lote_id_lote IS 'CU-124: lote reservado (NULL en reservas sin lote especifico)';
COMMENT ON COLUMN reserva_inventario.bodega_id_bodega IS 'CU-124: bodega del lote reservado';
COMMENT ON COLUMN reserva_inventario.usuario_id_usuario IS 'CU-131 (D48): usuario que creo la reserva. NULL en las anteriores a la sesion 14';
COMMENT ON COLUMN reserva_inventario.usuario_id_liberacion IS 'CU-132 (D48): usuario que la libero o anulo';
COMMENT ON COLUMN reserva_inventario.reserva_inventario_motivo_liberacion IS 'CU-132 (D48): motivo opcional de la liberacion o anulacion';
COMMENT ON COLUMN alerta_faltante_pedido.nota_venta_id_nota_venta IS 'FK blanda hacia finanzas.nota_venta';
COMMENT ON COLUMN alerta_faltante_pedido.alerta_faltante_pedido_origen IS 'faltante = generador de OT (OPUS-2); insumo_especial = CU-122';
COMMENT ON COLUMN conteo_ciclico_detalle.conteo_ciclico_detalle_stock_teorico IS 'Stock físico del SKU en la bodega AL CONFIRMAR el conteo; CU-43 compara contra este valor, no contra el actual';
COMMENT ON COLUMN movimiento_inventario.movimiento_inventario_id_revertido IS 'CU-44: si no es NULL, este movimiento es el inverso de otro. Excluirlo de consumos y rotación';
COMMENT ON COLUMN movimiento_inventario.movimiento_inventario_clave_envio IS 'CU-107: clave unica que el modulo de origen asigna a cada envio. Un reenvio con la misma clave no registra otro movimiento.';
COMMENT ON COLUMN lote_fecha_pedido.lote_fecha_pedido_precio_unitario IS 'Precio de compra informado al registrar el pedido; NULL si la entrada no lo informó. El historial de precios vive en historial_precio_material';
COMMENT ON COLUMN lote_fecha_pedido.lote_fecha_pedido_fecha_pedido IS 'CU-62: fecha en que se hizo el pedido al proveedor; el plazo real usa la primera que no sea posterior a lote.lote_fecha_recepcion';
COMMENT ON COLUMN material.material_descontinuado IS 'CU-122: no se vuelve a comprar; distinto de material_estado = inactivo';
COMMENT ON TABLE  tolerancia_conteo IS 'CU-43/CU-57: tolerancias del conteo ciclico por tipo de producto, editables por Gerencia. Sin filas, el backend usa los valores iniciales de src/config/conteo.js';
COMMENT ON COLUMN tolerancia_conteo.tolerancia_conteo_tipo IS 'critico = material_material_critico TRUE; no_critico = el resto';
COMMENT ON COLUMN tolerancia_conteo.tolerancia_conteo_tolerancia_pct IS 'Diferencia porcentual hasta la que se considera ruido normal: se registra, sin alerta';
COMMENT ON COLUMN tolerancia_conteo.tolerancia_conteo_umbral_critico_pct IS 'Sobre este porcentaje la alerta de CU-57 es critica y se notifica a Gerencia';
COMMENT ON COLUMN tolerancia_conteo.usuario_id_usuario IS 'Quien hizo la ultima modificacion; NULL = valor inicial';
COMMENT ON COLUMN diferencia_inventario.diferencia_inventario_tolerancia_pct IS 'Tolerancia aplicada al procesar (copia de tolerancia_conteo en ese momento)';
COMMENT ON COLUMN diferencia_inventario.diferencia_inventario_umbral_critico_pct IS 'Umbral critico vigente al procesar; lo usa CU-57 para la severidad';
COMMENT ON COLUMN preparacion_pedido_detalle.preparacion_pedido_detalle_cantidad_retirada IS 'CU-126 (D46): cantidad retirada del anaquel; acumula los retiros parciales. NULL = pendiente';
COMMENT ON COLUMN preparacion_pedido_detalle.preparacion_pedido_detalle_fecha_retiro IS 'CU-126 (D46): hora del ultimo retiro de este insumo';
COMMENT ON COLUMN preparacion_pedido_detalle.usuario_id_retiro IS 'CU-126 (D46): usuario que hizo el ultimo retiro de este insumo';
COMMENT ON COLUMN preparacion_pedido_estado.empleado_rut IS 'CU-125 (D47): FK blanda hacia finanzas.empleado. Trabajador que carga (una fila en_carga por responsable)';

COMMIT;
