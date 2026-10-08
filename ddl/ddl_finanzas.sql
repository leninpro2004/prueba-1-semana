-- ============================================================
-- Sistema Puertas Blindadas — Módulo Finanzas
-- SQL CORREGIDO v2
-- Schema: finanzas
-- ============================================================

-- El archivo es UTF-8: sin esto, psql en Windows lo lee como WIN1252 y daña los acentos
SET client_encoding = 'UTF8';

BEGIN;

DROP SCHEMA IF EXISTS finanzas CASCADE;
CREATE SCHEMA finanzas;
SET search_path TO finanzas;

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 1 — TABLAS DE EMPLEADO (dueño: finanzas)
-- ══════════════════════════════════════════════════════════════

CREATE TABLE empleado_cargo (
    empleado_cargo_id_cargo    BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    empleado_cargo_nombre      VARCHAR(150) NOT NULL,
    empleado_cargo_sueldo_base NUMERIC(14,2),
    CONSTRAINT pk_empleado_cargo PRIMARY KEY (empleado_cargo_id_cargo),
    CONSTRAINT ck_emp_cargo_sueldo CHECK (empleado_cargo_sueldo_base >= 0)
);

CREATE TABLE empleado_tipo_vinculo_laboral (
    empleado_tipo_vinculo_laboral_id_tipo_vinculo  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    empleado_tipo_vinculo_laboral_nombre           VARCHAR(150) NOT NULL,
    empleado_tipo_vinculo_laboral_seguro_cesantia  BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT pk_empleado_tipo_vinculo PRIMARY KEY (empleado_tipo_vinculo_laboral_id_tipo_vinculo)
);

CREATE TABLE empleado (
    empleado_rut_empleado                              VARCHAR(12)  NOT NULL,
    empleado_nombre_empleado_primer_nombre_empleado    VARCHAR(100) NOT NULL,
    empleado_nombre_empleado_segundo_nombre_empleado   VARCHAR(100),
    empleado_nombre_empleado_primer_apellido_empleado  VARCHAR(100) NOT NULL,
    empleado_nombre_empleado_segundo_apellido_empleado VARCHAR(100),
    empleado_estado                                    VARCHAR(50)  NOT NULL,
    empleado_fecha_ingreso                             DATE,
    empleado_afp                                       VARCHAR(100),
    empleado_prevision_salud                           VARCHAR(100),
    empleado_fecha_nacimiento                          DATE,
    empleado_cargo_id_cargo                            BIGINT       NOT NULL,
    empleado_tipo_vinculo_laboral_id_tipo_vinculo      BIGINT       NOT NULL,
    CONSTRAINT pk_empleado PRIMARY KEY (empleado_rut_empleado)
);

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 2 — CLIENTE FINANCIERO
-- ══════════════════════════════════════════════════════════════

CREATE TABLE tipo_cliente (
    id_tipo_cliente      BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    nombre_tipo_cliente  VARCHAR(80) NOT NULL,
    descripcion          TEXT,
    activo               BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT pk_tipo_cliente PRIMARY KEY (id_tipo_cliente),
    CONSTRAINT uk_tipo_cliente_nombre UNIQUE (nombre_tipo_cliente)
);

-- PK surrogada id_cliente_financiero (parche aplicado)
-- rut_cliente se mantiene como columna con UNIQUE para búsquedas
CREATE TABLE cliente_financiero (
    id_cliente_financiero    BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    rut_cliente              VARCHAR(12)  NOT NULL,
    id_tipo_cliente          BIGINT       NOT NULL,
    nombre_razon_social      VARCHAR(150) NOT NULL,
    telefono_principal       VARCHAR(30),
    correo_principal         VARCHAR(120),
    estado_cliente           VARCHAR(30)  NOT NULL DEFAULT 'activo',
    fecha_creacion           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    fecha_actualizacion_datos TIMESTAMPTZ,
    CONSTRAINT pk_cliente_financiero PRIMARY KEY (id_cliente_financiero),
    CONSTRAINT uk_cliente_financiero_rut UNIQUE (rut_cliente)
    -- rut_cliente es FK blanda hacia terreno.cliente (sin constraint cross-schema)
);

CREATE TABLE ficha_cliente (
    id_cliente_financiero  BIGINT      NOT NULL,
    fecha_creacion         TIMESTAMPTZ NOT NULL DEFAULT now(),
    observaciones          TEXT,
    estado_revision        VARCHAR(30) NOT NULL DEFAULT 'pendiente',
    CONSTRAINT pk_ficha_cliente PRIMARY KEY (id_cliente_financiero)
);

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 3 — PROYECTO FINANCIERO Y COMERCIAL
-- ══════════════════════════════════════════════════════════════

CREATE TABLE proyecto_financiero (
    id_proyecto_financiero BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    id_cliente_financiero  BIGINT       NOT NULL,
    -- FK blandas hacia terreno
    id_obra                BIGINT,
    id_proyecto_terreno    BIGINT,
    codigo_proyecto        VARCHAR(50)  NOT NULL,
    nombre_referencia      VARCHAR(150),
    fecha_ingreso          DATE         NOT NULL,
    estado_financiero      VARCHAR(30)  NOT NULL DEFAULT 'activo',
    observacion            TEXT,
    CONSTRAINT pk_proyecto_financiero PRIMARY KEY (id_proyecto_financiero),
    CONSTRAINT uk_proyecto_financiero_codigo UNIQUE (codigo_proyecto)
);

CREATE TABLE cotizacion (
    id_cotizacion          BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    numero_cotizacion      VARCHAR(50)  NOT NULL,
    id_cliente_financiero  BIGINT       NOT NULL,
    id_proyecto_financiero BIGINT,
    -- FK blanda hacia inventario.usuario
    id_usuario_creador     BIGINT       NOT NULL,
    fecha_emision          DATE         NOT NULL,
    fecha_vigencia         DATE,
    moneda                 VARCHAR(10)  NOT NULL DEFAULT 'CLP',
    tipo_cambio            NUMERIC(14,4),
    margen_pct             NUMERIC(5,2),
    estado                 VARCHAR(30)  NOT NULL DEFAULT 'emitida',
    observacion            TEXT,
    CONSTRAINT pk_cotizacion PRIMARY KEY (id_cotizacion),
    CONSTRAINT uk_cotizacion_numero UNIQUE (numero_cotizacion)
);

CREATE TABLE detalle_cotizacion (
    id_detalle_cotizacion       BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    id_cotizacion               BIGINT        NOT NULL,
    -- FK blanda hacia inventario.material
    sku_material                VARCHAR(16),
    -- FK blanda hacia inventario.lote_fecha_pedido
    id_precio_material          BIGINT,
    descripcion_item            TEXT          NOT NULL,
    cantidad                    NUMERIC(12,2) NOT NULL,
    alto                        NUMERIC(10,2),
    ancho                       NUMERIC(10,2),
    espesor                     NUMERIC(10,2),
    costo_unitario_estimado     NUMERIC(14,2),
    precio_unitario_sugerido    NUMERIC(14,2),
    descuento                   NUMERIC(14,2) DEFAULT 0,
    observacion                 TEXT,
    CONSTRAINT pk_detalle_cotizacion PRIMARY KEY (id_detalle_cotizacion)
);

CREATE TABLE nota_venta (
    id_nota_venta          BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    numero_nota_venta      VARCHAR(50)  NOT NULL,
    id_cliente_financiero  BIGINT       NOT NULL,
    id_proyecto_financiero BIGINT,
    id_cotizacion_origen   BIGINT,
    fecha_emision          DATE         NOT NULL,
    fecha_max_entrega      DATE,
    tipo_nota_venta        VARCHAR(50),
    moneda                 VARCHAR(10)  NOT NULL DEFAULT 'CLP',
    tipo_cambio            NUMERIC(14,4),
    descuento              NUMERIC(14,2) DEFAULT 0,
    estado_pedido          VARCHAR(30)  NOT NULL DEFAULT 'pendiente',
    estado_pago            VARCHAR(30)  NOT NULL DEFAULT 'pendiente',
    observacion            TEXT,
    CONSTRAINT pk_nota_venta PRIMARY KEY (id_nota_venta),
    CONSTRAINT uk_nota_venta_numero UNIQUE (numero_nota_venta)
);

CREATE TABLE item_nota_venta (
    id_item_nota_venta     BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    id_nota_venta          BIGINT        NOT NULL,
    -- FK blanda hacia inventario.producto_terminado
    id_producto_terminado  BIGINT,
    -- FK blanda hacia inventario.material: material vendido suelto (agregada por Inventario, 2026-09-28)
    sku_material           VARCHAR(16),
    descripcion_item       TEXT          NOT NULL,
    cantidad               NUMERIC(12,2) NOT NULL,
    alto                   NUMERIC(10,2),
    ancho                  NUMERIC(10,2),
    espesor                NUMERIC(10,2),
    precio_unitario        NUMERIC(14,2) NOT NULL,
    descuento              NUMERIC(14,2) DEFAULT 0,
    requiere_produccion    BOOLEAN       NOT NULL DEFAULT FALSE,
    requiere_instalacion   BOOLEAN       NOT NULL DEFAULT FALSE,
    estado_item            VARCHAR(30)   NOT NULL DEFAULT 'pendiente',
    observacion            TEXT,
    CONSTRAINT pk_item_nota_venta PRIMARY KEY (id_item_nota_venta)
);

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 4 — DOCUMENTOS TRIBUTARIOS Y COBROS
-- ══════════════════════════════════════════════════════════════

CREATE TABLE tipo_documento_tributario (
    id_tipo_documento_tributario  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    nombre_tipo_documento         VARCHAR(80) NOT NULL,
    descripcion                   TEXT,
    afecta_iva                    BOOLEAN     NOT NULL DEFAULT TRUE,
    activo                        BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT pk_tipo_documento_tributario PRIMARY KEY (id_tipo_documento_tributario),
    CONSTRAINT uk_tipo_doc_trib_nombre UNIQUE (nombre_tipo_documento)
);

CREATE TABLE documento_tributario (
    id_documento_tributario       BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    id_tipo_documento_tributario  BIGINT      NOT NULL,
    numero_documento              VARCHAR(50) NOT NULL,
    id_nota_venta                 BIGINT      NOT NULL,
    fecha_emision                 DATE        NOT NULL,
    fecha_vencimiento             DATE,
    monto_neto                    NUMERIC(14,2) NOT NULL,
    tasa_iva_aplicada             NUMERIC(5,2),
    es_exento                     BOOLEAN     NOT NULL DEFAULT FALSE,
    estado_documento              VARCHAR(30) NOT NULL DEFAULT 'emitido',
    archivo_url                   TEXT,
    CONSTRAINT pk_documento_tributario PRIMARY KEY (id_documento_tributario),
    CONSTRAINT uk_doc_trib_tipo_numero UNIQUE (id_tipo_documento_tributario, numero_documento)
);

CREATE TABLE hito_cobro (
    id_hito_cobro          BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    id_proyecto_financiero BIGINT        NOT NULL,
    tipo_hito              VARCHAR(80)   NOT NULL,
    descripcion            TEXT,
    porcentaje_estimado    NUMERIC(5,2),
    monto_estimado         NUMERIC(14,2),
    fecha_comprometida     DATE,
    condicion_cobro        TEXT,
    condicion_liberacion   TEXT,
    estado_hito            VARCHAR(30)   NOT NULL DEFAULT 'pendiente',
    orden_hito             INTEGER       NOT NULL,
    CONSTRAINT pk_hito_cobro PRIMARY KEY (id_hito_cobro),
    CONSTRAINT uk_hito_cobro_proyecto_orden UNIQUE (id_proyecto_financiero, orden_hito)
);

CREATE TABLE medio_pago (
    id_medio_pago    BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    nombre_medio_pago VARCHAR(80) NOT NULL,
    descripcion      TEXT,
    activo           BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT pk_medio_pago PRIMARY KEY (id_medio_pago),
    CONSTRAINT uk_medio_pago_nombre UNIQUE (nombre_medio_pago)
);

CREATE TABLE pago_cliente (
    id_pago_cliente        BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    id_cliente_financiero  BIGINT        NOT NULL,
    -- FK blanda hacia inventario.usuario
    id_usuario_registra    BIGINT        NOT NULL,
    id_medio_pago          BIGINT        NOT NULL,
    fecha_pago             DATE          NOT NULL,
    monto_pago             NUMERIC(14,2) NOT NULL,
    tipo_pago              VARCHAR(50),
    requiere_fecha_cobro   BOOLEAN       NOT NULL DEFAULT FALSE,
    nro_cuotas             INTEGER,
    fecha_cobro            DATE,
    comprobante_url        TEXT,
    estado_pago            VARCHAR(30)   NOT NULL DEFAULT 'registrado',
    observacion            TEXT,
    CONSTRAINT pk_pago_cliente PRIMARY KEY (id_pago_cliente)
);

CREATE TABLE asignacion_pago_cliente (
    id_asignacion_pago_cliente  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    id_pago_cliente             BIGINT        NOT NULL,
    id_proyecto_financiero      BIGINT,
    id_nota_venta               BIGINT,
    id_documento_tributario     BIGINT,
    id_hito_cobro               BIGINT,
    monto_asignado              NUMERIC(14,2) NOT NULL,
    observacion                 TEXT,
    CONSTRAINT pk_asignacion_pago_cliente PRIMARY KEY (id_asignacion_pago_cliente)
);

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 5 — DOCUMENTOS COMPRA PROVEEDOR Y PAGOS
-- ══════════════════════════════════════════════════════════════

CREATE TABLE tipo_documento_compra_proveedor (
    id_tipo_documento_compra      BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    nombre_tipo_documento_compra  VARCHAR(100) NOT NULL,
    descripcion                   TEXT,
    es_preliminar                 BOOLEAN      NOT NULL DEFAULT FALSE,
    genera_obligacion_pago        BOOLEAN      NOT NULL DEFAULT TRUE,
    activo                        BOOLEAN      NOT NULL DEFAULT TRUE,
    CONSTRAINT pk_tipo_documento_compra PRIMARY KEY (id_tipo_documento_compra),
    CONSTRAINT uk_tipo_doc_compra_nombre UNIQUE (nombre_tipo_documento_compra)
);

CREATE TABLE categoria_gasto (
    id_categoria_gasto    BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    nombre_categoria_gasto VARCHAR(100) NOT NULL,
    descripcion           TEXT,
    activo                BOOLEAN      NOT NULL DEFAULT TRUE,
    CONSTRAINT pk_categoria_gasto PRIMARY KEY (id_categoria_gasto),
    CONSTRAINT uk_categoria_gasto_nombre UNIQUE (nombre_categoria_gasto)
);

CREATE TABLE documento_compra_proveedor (
    id_documento_compra_proveedor  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    -- FK blanda hacia inventario.proveedor
    id_proveedor                   BIGINT        NOT NULL,
    id_tipo_documento_compra       BIGINT        NOT NULL,
    id_categoria_gasto             BIGINT        NOT NULL,
    numero_documento               VARCHAR(80)   NOT NULL,
    fecha_emision                  DATE          NOT NULL,
    fecha_vencimiento              DATE,
    moneda                         VARCHAR(10)   NOT NULL DEFAULT 'CLP',
    tipo_cambio                    NUMERIC(14,4),
    monto_neto                     NUMERIC(14,2) NOT NULL,
    tasa_iva_aplicada              NUMERIC(5,2),
    tasa_retencion_aplicada        NUMERIC(5,2),
    estado_documento               VARCHAR(30)   NOT NULL DEFAULT 'registrado',
    archivo_url                    TEXT,
    observacion                    TEXT,
    CONSTRAINT pk_documento_compra_proveedor PRIMARY KEY (id_documento_compra_proveedor),
    CONSTRAINT uk_doc_compra_prov UNIQUE (id_proveedor, id_tipo_documento_compra, numero_documento)
);

CREATE TABLE pago_proveedor (
    id_pago_proveedor   BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    -- FK blanda hacia inventario.proveedor
    id_proveedor        BIGINT        NOT NULL,
    -- FK blanda hacia inventario.usuario
    id_usuario_registra BIGINT        NOT NULL,
    id_medio_pago       BIGINT        NOT NULL,
    fecha_pago          DATE          NOT NULL,
    monto_pago          NUMERIC(14,2) NOT NULL,
    comprobante_url     TEXT,
    estado_pago         VARCHAR(30)   NOT NULL DEFAULT 'registrado',
    observacion         TEXT,
    CONSTRAINT pk_pago_proveedor PRIMARY KEY (id_pago_proveedor)
);

CREATE TABLE asignacion_pago_proveedor (
    id_asignacion_pago_proveedor   BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    id_pago_proveedor              BIGINT        NOT NULL,
    id_documento_compra_proveedor  BIGINT        NOT NULL,
    monto_asignado                 NUMERIC(14,2) NOT NULL,
    observacion                    TEXT,
    CONSTRAINT pk_asignacion_pago_proveedor PRIMARY KEY (id_asignacion_pago_proveedor)
);

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 6 — GASTOS, MOVIMIENTOS Y CONCILIACIÓN
-- ══════════════════════════════════════════════════════════════

CREATE TABLE gasto_caja_chica (
    id_gasto_caja       BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    -- FK blandas hacia inventario.usuario
    id_usuario_registra BIGINT        NOT NULL,
    id_usuario_valida   BIGINT,
    id_categoria_gasto  BIGINT        NOT NULL,
    fecha_gasto         DATE          NOT NULL,
    descripcion         TEXT          NOT NULL,
    monto               NUMERIC(14,2) NOT NULL,
    respaldo_url        TEXT,
    rendido             BOOLEAN       NOT NULL DEFAULT FALSE,
    estado_validacion   VARCHAR(30)   NOT NULL DEFAULT 'pendiente',
    CONSTRAINT pk_gasto_caja_chica PRIMARY KEY (id_gasto_caja)
);

CREATE TABLE costo_proyecto (
    id_costo_proyecto             BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    id_proyecto_financiero        BIGINT        NOT NULL,
    id_documento_compra_proveedor BIGINT,
    id_gasto_caja                 BIGINT,
    id_tarea_remunerable          BIGINT,
    -- FK blandas hacia inventario
    id_movimiento_inventario      BIGINT,
    id_lote                       BIGINT,
    id_categoria_gasto            BIGINT        NOT NULL,
    monto_asignado                NUMERIC(14,2) NOT NULL,
    fecha_costo                   DATE          NOT NULL,
    descripcion                   TEXT,
    observacion                   TEXT,
    CONSTRAINT pk_costo_proyecto PRIMARY KEY (id_costo_proyecto)
);

CREATE TABLE movimiento_financiero (
    id_movimiento_financiero  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    id_pago_cliente           BIGINT,
    id_pago_proveedor         BIGINT,
    id_gasto_caja             BIGINT,
    id_liquidacion            BIGINT,
    -- FK blanda hacia inventario.usuario
    id_usuario_registra       BIGINT        NOT NULL,
    fecha_movimiento          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    naturaleza                VARCHAR(20)   NOT NULL,
    monto                     NUMERIC(14,2) NOT NULL,
    estado_conciliacion       VARCHAR(30)   NOT NULL DEFAULT 'pendiente',
    observacion               TEXT,
    CONSTRAINT pk_movimiento_financiero PRIMARY KEY (id_movimiento_financiero)
);

CREATE TABLE movimiento_bancario (
    id_movimiento_bancario  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    fecha_banco             DATE          NOT NULL,
    banco                   VARCHAR(100)  NOT NULL,
    cuenta                  VARCHAR(80),
    glosa                   TEXT,
    monto                   NUMERIC(14,2) NOT NULL,
    cargo_abono             VARCHAR(20)   NOT NULL,
    numero_operacion        VARCHAR(100),
    archivo_origen          TEXT,
    CONSTRAINT pk_movimiento_bancario PRIMARY KEY (id_movimiento_bancario)
);

CREATE TABLE conciliacion (
    id_conciliacion        BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    -- FK blanda hacia inventario.usuario
    id_usuario_responsable BIGINT      NOT NULL,
    fecha_conciliacion     TIMESTAMPTZ NOT NULL DEFAULT now(),
    estado_conciliacion    VARCHAR(30) NOT NULL DEFAULT 'pendiente',
    observacion            TEXT,
    CONSTRAINT pk_conciliacion PRIMARY KEY (id_conciliacion)
);

CREATE TABLE detalle_conciliacion (
    id_detalle_conciliacion  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    id_conciliacion          BIGINT        NOT NULL,
    id_movimiento_financiero BIGINT        NOT NULL,
    id_movimiento_bancario   BIGINT        NOT NULL,
    monto_conciliado         NUMERIC(14,2) NOT NULL,
    observacion              TEXT,
    CONSTRAINT pk_detalle_conciliacion PRIMARY KEY (id_detalle_conciliacion)
);

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 7 — CRÉDITO Y EVALUACIÓN
-- ══════════════════════════════════════════════════════════════

CREATE TABLE fondo_global_credito (
    id_fondo_credito                        BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    fecha_calculo                           DATE          NOT NULL,
    utilidad_neta_disponible                NUMERIC(14,2) NOT NULL,
    monto_gastos_operacionales_considerados NUMERIC(14,2) NOT NULL DEFAULT 0,
    reserva_emergencia                      NUMERIC(14,2) NOT NULL DEFAULT 0,
    monto_total_calculado                   NUMERIC(14,2) NOT NULL,
    monto_bloqueado                         NUMERIC(14,2) NOT NULL DEFAULT 0,
    monto_disponible                        NUMERIC(14,2) NOT NULL,
    limite_seguridad_pct                    NUMERIC(5,2),
    estado                                  VARCHAR(30)   NOT NULL DEFAULT 'vigente',
    CONSTRAINT pk_fondo_global_credito PRIMARY KEY (id_fondo_credito)
);

CREATE TABLE limite_credito_cliente (
    id_limite_credito_cliente  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    id_cliente_financiero      BIGINT        NOT NULL,
    monto_limite               NUMERIC(14,2) NOT NULL,
    plazo_dias                 INTEGER       NOT NULL,
    fecha_inicio_vigencia      DATE          NOT NULL,
    fecha_fin_vigencia         DATE,
    estado                     VARCHAR(30)   NOT NULL DEFAULT 'vigente',
    observacion                TEXT,
    CONSTRAINT pk_limite_credito_cliente PRIMARY KEY (id_limite_credito_cliente)
);

CREATE TABLE parametro_riesgo_financiero (
    id_parametro_riesgo    BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    nombre_parametro       VARCHAR(100) NOT NULL,
    descripcion            TEXT,
    tipo_parametro         VARCHAR(50),
    peso                   NUMERIC(5,2) NOT NULL DEFAULT 0,
    puntaje_maximo         NUMERIC(5,2),
    valor_referencia       VARCHAR(100),
    operador_evaluacion    VARCHAR(20),
    activo                 BOOLEAN      NOT NULL DEFAULT TRUE,
    CONSTRAINT pk_parametro_riesgo PRIMARY KEY (id_parametro_riesgo),
    CONSTRAINT uk_parametro_riesgo_nombre UNIQUE (nombre_parametro)
);

CREATE TABLE evaluacion_credito (
    id_evaluacion_credito  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    id_cliente_financiero  BIGINT      NOT NULL,
    -- FK blanda hacia inventario.usuario
    id_usuario_autorizador BIGINT      NOT NULL,
    fecha_evaluacion       TIMESTAMPTZ NOT NULL DEFAULT now(),
    score_confianza        NUMERIC(5,2),
    resultado              VARCHAR(30) NOT NULL,
    causa_rechazo          TEXT,
    aprobacion_excepcional BOOLEAN     NOT NULL DEFAULT FALSE,
    observacion            TEXT,
    CONSTRAINT pk_evaluacion_credito PRIMARY KEY (id_evaluacion_credito)
);

CREATE TABLE detalle_evaluacion_credito (
    id_detalle_evaluacion_credito  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    id_evaluacion_credito          BIGINT       NOT NULL,
    id_parametro_riesgo            BIGINT       NOT NULL,
    valor_obtenido                 VARCHAR(100),
    puntaje_obtenido               NUMERIC(5,2),
    cumple                         BOOLEAN,
    observacion                    TEXT,
    CONSTRAINT pk_detalle_evaluacion_credito PRIMARY KEY (id_detalle_evaluacion_credito),
    CONSTRAINT uk_det_eval_credito UNIQUE (id_evaluacion_credito, id_parametro_riesgo)
);

CREATE TABLE credito_proyecto (
    id_credito_proyecto        BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    id_proyecto_financiero     BIGINT        NOT NULL,
    id_limite_credito_cliente  BIGINT,
    id_fondo_credito           BIGINT        NOT NULL,
    id_evaluacion_credito      BIGINT        NOT NULL,
    -- FK blanda hacia inventario.usuario
    id_usuario_autorizador     BIGINT        NOT NULL,
    monto_credito_aprobado     NUMERIC(14,2) NOT NULL,
    monto_bloqueado            NUMERIC(14,2) NOT NULL DEFAULT 0,
    fecha_aprobacion           DATE          NOT NULL,
    estado_credito             VARCHAR(30)   NOT NULL DEFAULT 'aprobado',
    observacion                TEXT,
    CONSTRAINT pk_credito_proyecto PRIMARY KEY (id_credito_proyecto)
);

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 8 — REMUNERACIONES
-- ══════════════════════════════════════════════════════════════

CREATE TABLE tipo_tarea_catalogada (
    id_tipo_tarea    BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    nombre_tipo_tarea VARCHAR(100) NOT NULL,
    descripcion      TEXT,
    activo           BOOLEAN      NOT NULL DEFAULT TRUE,
    CONSTRAINT pk_tipo_tarea_catalogada PRIMARY KEY (id_tipo_tarea),
    CONSTRAINT uk_tipo_tarea_nombre UNIQUE (nombre_tipo_tarea)
);

CREATE TABLE tarea_catalogada (
    id_tarea_catalogada  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    id_tipo_tarea        BIGINT       NOT NULL,
    nombre_tarea         VARCHAR(150) NOT NULL,
    descripcion          TEXT,
    activo               BOOLEAN      NOT NULL DEFAULT TRUE,
    CONSTRAINT pk_tarea_catalogada PRIMARY KEY (id_tarea_catalogada),
    CONSTRAINT uk_tarea_catalogada_nombre UNIQUE (nombre_tarea)
);

CREATE TABLE tarifa_tarea (
    id_tarifa_tarea     BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    id_tarea_catalogada BIGINT        NOT NULL,
    valor_unitario      NUMERIC(14,2) NOT NULL,
    vigencia_desde      DATE          NOT NULL,
    vigencia_hasta      DATE,
    activo              BOOLEAN       NOT NULL DEFAULT TRUE,
    CONSTRAINT pk_tarifa_tarea PRIMARY KEY (id_tarifa_tarea)
);

CREATE TABLE tarea_remunerable (
    id_tarea_remunerable   BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    rut_empleado           VARCHAR(12)   NOT NULL,
    id_tarea_catalogada    BIGINT        NOT NULL,
    id_tarifa_tarea        BIGINT        NOT NULL,
    id_proyecto_financiero BIGINT,
    -- FK blandas hacia inventario
    id_producto_terminado  BIGINT,
    id_orden_trabajo       BIGINT,
    fecha                  DATE          NOT NULL,
    cantidad               NUMERIC(12,2),
    horas                  NUMERIC(10,2),
    estado_validacion      VARCHAR(30)   NOT NULL DEFAULT 'pendiente',
    observacion            TEXT,
    CONSTRAINT pk_tarea_remunerable PRIMARY KEY (id_tarea_remunerable)
);

CREATE TABLE liquidacion_remuneracion (
    id_liquidacion       BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    rut_empleado         VARCHAR(12) NOT NULL,
    -- FK blanda hacia inventario.usuario
    id_usuario_cierra    BIGINT      NOT NULL,
    periodo_inicio       DATE        NOT NULL,
    periodo_fin          DATE        NOT NULL,
    estado               VARCHAR(30) NOT NULL DEFAULT 'abierta',
    CONSTRAINT pk_liquidacion_remuneracion PRIMARY KEY (id_liquidacion),
    CONSTRAINT uk_liquidacion_emp_periodo UNIQUE (rut_empleado, periodo_inicio, periodo_fin)
);

CREATE TABLE concepto_remuneracion (
    id_concepto_remuneracion  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    id_liquidacion            BIGINT        NOT NULL,
    id_tarea_remunerable      BIGINT,
    tipo_concepto             VARCHAR(50)   NOT NULL,
    descripcion               TEXT          NOT NULL,
    monto                     NUMERIC(14,2) NOT NULL,
    es_imponible              BOOLEAN       NOT NULL DEFAULT TRUE,
    observacion               TEXT,
    CONSTRAINT pk_concepto_remuneracion PRIMARY KEY (id_concepto_remuneracion)
);

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 9 — AUDITORÍA Y ALERTAS
-- ══════════════════════════════════════════════════════════════

CREATE TABLE evento_auditoria (
    id_evento          BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    -- FK blanda hacia inventario.usuario
    id_usuario         BIGINT         NOT NULL,
    fecha_hora         TIMESTAMPTZ    NOT NULL DEFAULT now(),
    accion_realizada   VARCHAR(100)   NOT NULL,
    entidad_afectada   VARCHAR(100)   NOT NULL,
    registro_afectado  VARCHAR(100),
    ip_origen          VARCHAR(45),
    motivo             TEXT,
    observacion        TEXT,
    CONSTRAINT pk_evento_auditoria PRIMARY KEY (id_evento)
);

CREATE TABLE detalle_evento_auditoria (
    id_detalle_evento  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    id_evento          BIGINT       NOT NULL,
    campo_afectado     VARCHAR(100) NOT NULL,
    valor_anterior     TEXT,
    valor_nuevo        TEXT,
    CONSTRAINT pk_detalle_evento_auditoria PRIMARY KEY (id_detalle_evento)
);

CREATE TABLE alerta_financiera (
    id_alerta_financiera          BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    tipo_alerta                   VARCHAR(80)  NOT NULL,
    nivel_alerta                  VARCHAR(30),
    fecha_generacion              TIMESTAMPTZ  NOT NULL DEFAULT now(),
    prioridad                     VARCHAR(30),
    estado                        VARCHAR(30)  NOT NULL DEFAULT 'pendiente',
    mensaje                       TEXT         NOT NULL,
    id_cliente_financiero         BIGINT,
    id_proyecto_financiero        BIGINT,
    id_documento_tributario       BIGINT,
    id_documento_compra_proveedor BIGINT,
    id_costo_proyecto             BIGINT,
    id_credito_proyecto           BIGINT,
    CONSTRAINT pk_alerta_financiera PRIMARY KEY (id_alerta_financiera)
);

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 10 — FOREIGN KEYS INTERNAS
-- ══════════════════════════════════════════════════════════════

-- Empleado
ALTER TABLE empleado
    ADD CONSTRAINT fk_emp_cargo   FOREIGN KEY (empleado_cargo_id_cargo) REFERENCES empleado_cargo(empleado_cargo_id_cargo),
    ADD CONSTRAINT fk_emp_vinculo FOREIGN KEY (empleado_tipo_vinculo_laboral_id_tipo_vinculo)
                                  REFERENCES empleado_tipo_vinculo_laboral(empleado_tipo_vinculo_laboral_id_tipo_vinculo);

-- Cliente financiero
ALTER TABLE cliente_financiero
    ADD CONSTRAINT fk_cf_tipo_cliente FOREIGN KEY (id_tipo_cliente) REFERENCES tipo_cliente(id_tipo_cliente);
    -- rut_cliente: FK blanda hacia terreno.cliente (sin constraint)

ALTER TABLE ficha_cliente
    ADD CONSTRAINT fk_fc_cliente_financiero FOREIGN KEY (id_cliente_financiero) REFERENCES cliente_financiero(id_cliente_financiero);

-- Proyecto financiero
ALTER TABLE proyecto_financiero
    ADD CONSTRAINT fk_pf_cliente_financiero FOREIGN KEY (id_cliente_financiero) REFERENCES cliente_financiero(id_cliente_financiero);
    -- id_obra, id_proyecto_terreno: FK blandas hacia terreno

-- Cotización
ALTER TABLE cotizacion
    ADD CONSTRAINT fk_cot_cliente_financiero FOREIGN KEY (id_cliente_financiero) REFERENCES cliente_financiero(id_cliente_financiero),
    ADD CONSTRAINT fk_cot_proyecto_financiero FOREIGN KEY (id_proyecto_financiero) REFERENCES proyecto_financiero(id_proyecto_financiero);
    -- id_usuario_creador: FK blanda hacia inventario.usuario

-- Detalle cotización
ALTER TABLE detalle_cotizacion
    ADD CONSTRAINT fk_det_cot_cotizacion FOREIGN KEY (id_cotizacion) REFERENCES cotizacion(id_cotizacion);
    -- sku_material: FK blanda hacia inventario.material
    -- id_precio_material: FK blanda hacia inventario.lote_fecha_pedido

-- Nota de venta
ALTER TABLE nota_venta
    ADD CONSTRAINT fk_nv_cliente_financiero  FOREIGN KEY (id_cliente_financiero) REFERENCES cliente_financiero(id_cliente_financiero),
    ADD CONSTRAINT fk_nv_proyecto_financiero FOREIGN KEY (id_proyecto_financiero) REFERENCES proyecto_financiero(id_proyecto_financiero),
    ADD CONSTRAINT fk_nv_cotizacion_origen   FOREIGN KEY (id_cotizacion_origen) REFERENCES cotizacion(id_cotizacion);

-- Item nota venta
ALTER TABLE item_nota_venta
    ADD CONSTRAINT fk_inv_nota_venta FOREIGN KEY (id_nota_venta) REFERENCES nota_venta(id_nota_venta);
    -- id_producto_terminado: FK blanda hacia inventario.producto_terminado

-- Documento tributario
ALTER TABLE documento_tributario
    ADD CONSTRAINT fk_dt_tipo FOREIGN KEY (id_tipo_documento_tributario) REFERENCES tipo_documento_tributario(id_tipo_documento_tributario),
    ADD CONSTRAINT fk_dt_nota_venta FOREIGN KEY (id_nota_venta) REFERENCES nota_venta(id_nota_venta);

-- Hito cobro
ALTER TABLE hito_cobro
    ADD CONSTRAINT fk_hc_proyecto_financiero FOREIGN KEY (id_proyecto_financiero) REFERENCES proyecto_financiero(id_proyecto_financiero);

-- Pago cliente
ALTER TABLE pago_cliente
    ADD CONSTRAINT fk_pc_cliente_financiero FOREIGN KEY (id_cliente_financiero) REFERENCES cliente_financiero(id_cliente_financiero),
    ADD CONSTRAINT fk_pc_medio_pago         FOREIGN KEY (id_medio_pago) REFERENCES medio_pago(id_medio_pago);
    -- id_usuario_registra: FK blanda hacia inventario.usuario

-- Asignación pago cliente
ALTER TABLE asignacion_pago_cliente
    ADD CONSTRAINT fk_apc_pago_cliente    FOREIGN KEY (id_pago_cliente) REFERENCES pago_cliente(id_pago_cliente),
    ADD CONSTRAINT fk_apc_proyecto        FOREIGN KEY (id_proyecto_financiero) REFERENCES proyecto_financiero(id_proyecto_financiero),
    ADD CONSTRAINT fk_apc_nota_venta      FOREIGN KEY (id_nota_venta) REFERENCES nota_venta(id_nota_venta),
    ADD CONSTRAINT fk_apc_doc_tributario  FOREIGN KEY (id_documento_tributario) REFERENCES documento_tributario(id_documento_tributario),
    ADD CONSTRAINT fk_apc_hito_cobro      FOREIGN KEY (id_hito_cobro) REFERENCES hito_cobro(id_hito_cobro);

-- Documento compra proveedor
ALTER TABLE documento_compra_proveedor
    ADD CONSTRAINT fk_dcp_tipo_doc  FOREIGN KEY (id_tipo_documento_compra) REFERENCES tipo_documento_compra_proveedor(id_tipo_documento_compra),
    ADD CONSTRAINT fk_dcp_cat_gasto FOREIGN KEY (id_categoria_gasto) REFERENCES categoria_gasto(id_categoria_gasto);
    -- id_proveedor: FK blanda hacia inventario.proveedor

-- Pago proveedor
ALTER TABLE pago_proveedor
    ADD CONSTRAINT fk_pp_medio_pago FOREIGN KEY (id_medio_pago) REFERENCES medio_pago(id_medio_pago);
    -- id_proveedor: FK blanda hacia inventario.proveedor
    -- id_usuario_registra: FK blanda hacia inventario.usuario

-- Asignación pago proveedor
ALTER TABLE asignacion_pago_proveedor
    ADD CONSTRAINT fk_app_pago_proveedor FOREIGN KEY (id_pago_proveedor) REFERENCES pago_proveedor(id_pago_proveedor),
    ADD CONSTRAINT fk_app_doc_compra     FOREIGN KEY (id_documento_compra_proveedor) REFERENCES documento_compra_proveedor(id_documento_compra_proveedor);

-- Gasto caja chica
ALTER TABLE gasto_caja_chica
    ADD CONSTRAINT fk_gcc_cat_gasto FOREIGN KEY (id_categoria_gasto) REFERENCES categoria_gasto(id_categoria_gasto);
    -- id_usuario_registra, id_usuario_valida: FK blandas hacia inventario.usuario

-- Costo proyecto
ALTER TABLE costo_proyecto
    ADD CONSTRAINT fk_cp_proyecto_financiero FOREIGN KEY (id_proyecto_financiero) REFERENCES proyecto_financiero(id_proyecto_financiero),
    ADD CONSTRAINT fk_cp_doc_compra          FOREIGN KEY (id_documento_compra_proveedor) REFERENCES documento_compra_proveedor(id_documento_compra_proveedor),
    ADD CONSTRAINT fk_cp_gasto_caja          FOREIGN KEY (id_gasto_caja) REFERENCES gasto_caja_chica(id_gasto_caja),
    ADD CONSTRAINT fk_cp_tarea_remunerable   FOREIGN KEY (id_tarea_remunerable) REFERENCES tarea_remunerable(id_tarea_remunerable),
    ADD CONSTRAINT fk_cp_cat_gasto           FOREIGN KEY (id_categoria_gasto) REFERENCES categoria_gasto(id_categoria_gasto);
    -- id_movimiento_inventario, id_lote: FK blandas hacia inventario

-- Movimiento financiero
ALTER TABLE movimiento_financiero
    ADD CONSTRAINT fk_mf_pago_cliente   FOREIGN KEY (id_pago_cliente) REFERENCES pago_cliente(id_pago_cliente),
    ADD CONSTRAINT fk_mf_pago_proveedor FOREIGN KEY (id_pago_proveedor) REFERENCES pago_proveedor(id_pago_proveedor),
    ADD CONSTRAINT fk_mf_gasto_caja     FOREIGN KEY (id_gasto_caja) REFERENCES gasto_caja_chica(id_gasto_caja),
    ADD CONSTRAINT fk_mf_liquidacion    FOREIGN KEY (id_liquidacion) REFERENCES liquidacion_remuneracion(id_liquidacion);
    -- id_usuario_registra: FK blanda hacia inventario.usuario

-- Detalle conciliación
ALTER TABLE detalle_conciliacion
    ADD CONSTRAINT fk_dc_conciliacion         FOREIGN KEY (id_conciliacion) REFERENCES conciliacion(id_conciliacion),
    ADD CONSTRAINT fk_dc_movimiento_financiero FOREIGN KEY (id_movimiento_financiero) REFERENCES movimiento_financiero(id_movimiento_financiero),
    ADD CONSTRAINT fk_dc_movimiento_bancario   FOREIGN KEY (id_movimiento_bancario) REFERENCES movimiento_bancario(id_movimiento_bancario);

-- Límite crédito cliente
ALTER TABLE limite_credito_cliente
    ADD CONSTRAINT fk_lcc_cliente_financiero FOREIGN KEY (id_cliente_financiero) REFERENCES cliente_financiero(id_cliente_financiero);

-- Evaluación crédito
ALTER TABLE evaluacion_credito
    ADD CONSTRAINT fk_ec_cliente_financiero FOREIGN KEY (id_cliente_financiero) REFERENCES cliente_financiero(id_cliente_financiero);
    -- id_usuario_autorizador: FK blanda hacia inventario.usuario

-- Detalle evaluación crédito
ALTER TABLE detalle_evaluacion_credito
    ADD CONSTRAINT fk_dec_evaluacion_credito FOREIGN KEY (id_evaluacion_credito) REFERENCES evaluacion_credito(id_evaluacion_credito),
    ADD CONSTRAINT fk_dec_parametro_riesgo   FOREIGN KEY (id_parametro_riesgo) REFERENCES parametro_riesgo_financiero(id_parametro_riesgo);

-- Crédito proyecto
ALTER TABLE credito_proyecto
    ADD CONSTRAINT fk_crp_proyecto_financiero    FOREIGN KEY (id_proyecto_financiero) REFERENCES proyecto_financiero(id_proyecto_financiero),
    ADD CONSTRAINT fk_crp_limite_credito_cliente FOREIGN KEY (id_limite_credito_cliente) REFERENCES limite_credito_cliente(id_limite_credito_cliente),
    ADD CONSTRAINT fk_crp_fondo_credito          FOREIGN KEY (id_fondo_credito) REFERENCES fondo_global_credito(id_fondo_credito),
    ADD CONSTRAINT fk_crp_evaluacion_credito     FOREIGN KEY (id_evaluacion_credito) REFERENCES evaluacion_credito(id_evaluacion_credito);
    -- id_usuario_autorizador: FK blanda hacia inventario.usuario

-- Tarea catalogada
ALTER TABLE tarea_catalogada
    ADD CONSTRAINT fk_tc_tipo_tarea FOREIGN KEY (id_tipo_tarea) REFERENCES tipo_tarea_catalogada(id_tipo_tarea);

-- Tarifa tarea
ALTER TABLE tarifa_tarea
    ADD CONSTRAINT fk_tt_tarea_catalogada FOREIGN KEY (id_tarea_catalogada) REFERENCES tarea_catalogada(id_tarea_catalogada);

-- Tarea remunerable
ALTER TABLE tarea_remunerable
    ADD CONSTRAINT fk_tr_empleado         FOREIGN KEY (rut_empleado) REFERENCES empleado(empleado_rut_empleado),
    ADD CONSTRAINT fk_tr_tarea_catalogada FOREIGN KEY (id_tarea_catalogada) REFERENCES tarea_catalogada(id_tarea_catalogada),
    ADD CONSTRAINT fk_tr_tarifa_tarea     FOREIGN KEY (id_tarifa_tarea) REFERENCES tarifa_tarea(id_tarifa_tarea),
    ADD CONSTRAINT fk_tr_proyecto_fin     FOREIGN KEY (id_proyecto_financiero) REFERENCES proyecto_financiero(id_proyecto_financiero);
    -- id_producto_terminado, id_orden_trabajo: FK blandas hacia inventario

-- Liquidación remuneración
ALTER TABLE liquidacion_remuneracion
    ADD CONSTRAINT fk_lr_empleado FOREIGN KEY (rut_empleado) REFERENCES empleado(empleado_rut_empleado);
    -- id_usuario_cierra: FK blanda hacia inventario.usuario

-- Concepto remuneración
ALTER TABLE concepto_remuneracion
    ADD CONSTRAINT fk_cr_liquidacion       FOREIGN KEY (id_liquidacion) REFERENCES liquidacion_remuneracion(id_liquidacion),
    ADD CONSTRAINT fk_cr_tarea_remunerable FOREIGN KEY (id_tarea_remunerable) REFERENCES tarea_remunerable(id_tarea_remunerable);

-- Detalle evento auditoría
ALTER TABLE detalle_evento_auditoria
    ADD CONSTRAINT fk_dea_evento FOREIGN KEY (id_evento) REFERENCES evento_auditoria(id_evento);
    -- id_usuario en evento_auditoria: FK blanda hacia inventario.usuario

-- Alerta financiera
ALTER TABLE alerta_financiera
    ADD CONSTRAINT fk_af_cliente_financiero        FOREIGN KEY (id_cliente_financiero) REFERENCES cliente_financiero(id_cliente_financiero),
    ADD CONSTRAINT fk_af_proyecto_financiero       FOREIGN KEY (id_proyecto_financiero) REFERENCES proyecto_financiero(id_proyecto_financiero),
    ADD CONSTRAINT fk_af_documento_tributario      FOREIGN KEY (id_documento_tributario) REFERENCES documento_tributario(id_documento_tributario),
    ADD CONSTRAINT fk_af_documento_compra          FOREIGN KEY (id_documento_compra_proveedor) REFERENCES documento_compra_proveedor(id_documento_compra_proveedor),
    ADD CONSTRAINT fk_af_costo_proyecto            FOREIGN KEY (id_costo_proyecto) REFERENCES costo_proyecto(id_costo_proyecto),
    ADD CONSTRAINT fk_af_credito_proyecto          FOREIGN KEY (id_credito_proyecto) REFERENCES credito_proyecto(id_credito_proyecto);

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 11 — ÍNDICES
-- ══════════════════════════════════════════════════════════════

CREATE INDEX idx_emp_cargo         ON empleado(empleado_cargo_id_cargo);
CREATE INDEX idx_emp_vinculo       ON empleado(empleado_tipo_vinculo_laboral_id_tipo_vinculo);

CREATE INDEX idx_cf_rut            ON cliente_financiero(rut_cliente);
CREATE INDEX idx_cf_tipo           ON cliente_financiero(id_tipo_cliente);
CREATE INDEX idx_cf_estado         ON cliente_financiero(estado_cliente);

CREATE INDEX idx_pf_cliente        ON proyecto_financiero(id_cliente_financiero);
CREATE INDEX idx_pf_estado         ON proyecto_financiero(estado_financiero);

CREATE INDEX idx_cot_cliente       ON cotizacion(id_cliente_financiero);
CREATE INDEX idx_cot_proyecto      ON cotizacion(id_proyecto_financiero);
CREATE INDEX idx_cot_estado        ON cotizacion(estado);

CREATE INDEX idx_nv_cliente        ON nota_venta(id_cliente_financiero);
CREATE INDEX idx_nv_proyecto       ON nota_venta(id_proyecto_financiero);
CREATE INDEX idx_nv_estado_pedido  ON nota_venta(estado_pedido);
CREATE INDEX idx_inv_sku_material  ON item_nota_venta(sku_material);   -- Inventario, 2026-09-28

CREATE INDEX idx_pc_cliente        ON pago_cliente(id_cliente_financiero);
CREATE INDEX idx_pc_estado         ON pago_cliente(estado_pago);

CREATE INDEX idx_mf_estado         ON movimiento_financiero(estado_conciliacion);
CREATE INDEX idx_mf_fecha          ON movimiento_financiero(fecha_movimiento);

CREATE INDEX idx_ec_cliente        ON evaluacion_credito(id_cliente_financiero);
CREATE INDEX idx_lcc_cliente       ON limite_credito_cliente(id_cliente_financiero);

CREATE INDEX idx_tr_empleado       ON tarea_remunerable(rut_empleado);
CREATE INDEX idx_tr_proyecto       ON tarea_remunerable(id_proyecto_financiero);
CREATE INDEX idx_lr_empleado       ON liquidacion_remuneracion(rut_empleado);
CREATE INDEX idx_lr_periodo        ON liquidacion_remuneracion(periodo_inicio, periodo_fin);

CREATE INDEX idx_af_estado         ON alerta_financiera(estado);
CREATE INDEX idx_af_fecha          ON alerta_financiera(fecha_generacion);
CREATE INDEX idx_af_cliente        ON alerta_financiera(id_cliente_financiero);

CREATE INDEX idx_ea_fecha          ON evento_auditoria(fecha_hora);
CREATE INDEX idx_ea_usuario        ON evento_auditoria(id_usuario);

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 12 — COMENTARIOS
-- ══════════════════════════════════════════════════════════════

COMMENT ON SCHEMA finanzas IS 'Módulo Finanzas — Sistema Puertas Blindadas';
COMMENT ON TABLE empleado IS 'Dueño: finanzas. Inventario y Terreno referencian vía FK blanda.';
COMMENT ON TABLE cliente_financiero IS 'PK surrogada id_cliente_financiero (parche aplicado). rut_cliente es FK blanda hacia terreno.cliente.';
COMMENT ON TABLE ficha_cliente IS 'PK = id_cliente_financiero (1:1 con cliente_financiero).';

COMMENT ON COLUMN cliente_financiero.rut_cliente IS 'FK blanda hacia terreno.cliente — sin constraint cross-schema';
COMMENT ON COLUMN proyecto_financiero.id_obra IS 'FK blanda hacia terreno.obra — sin constraint cross-schema';
COMMENT ON COLUMN proyecto_financiero.id_proyecto_terreno IS 'FK blanda hacia terreno.proyecto — sin constraint cross-schema';
COMMENT ON COLUMN cotizacion.id_usuario_creador IS 'FK blanda hacia inventario.usuario — sin constraint cross-schema';
COMMENT ON COLUMN detalle_cotizacion.sku_material IS 'FK blanda hacia inventario.material — sin constraint cross-schema';
COMMENT ON COLUMN detalle_cotizacion.id_precio_material IS 'FK blanda hacia inventario.lote_fecha_pedido — sin constraint cross-schema';
COMMENT ON COLUMN item_nota_venta.id_producto_terminado IS 'FK blanda hacia inventario.producto_terminado — sin constraint cross-schema';
COMMENT ON COLUMN item_nota_venta.sku_material IS 'FK blanda hacia inventario.material — sin constraint cross-schema. Material vendido suelto; NULL en lineas de puerta (id_producto_terminado) o de servicio. Agregada por Inventario (Grupo 14) el 2026-09-28.';
COMMENT ON COLUMN documento_compra_proveedor.id_proveedor IS 'FK blanda hacia inventario.proveedor — sin constraint cross-schema';
COMMENT ON COLUMN pago_proveedor.id_proveedor IS 'FK blanda hacia inventario.proveedor — sin constraint cross-schema';
COMMENT ON COLUMN tarea_remunerable.id_producto_terminado IS 'FK blanda hacia inventario.producto_terminado — sin constraint cross-schema';
COMMENT ON COLUMN tarea_remunerable.id_orden_trabajo IS 'FK blanda hacia inventario.orden_trabajo — sin constraint cross-schema';
COMMENT ON COLUMN costo_proyecto.id_movimiento_inventario IS 'FK blanda hacia inventario.movimiento_inventario — sin constraint cross-schema';
COMMENT ON COLUMN costo_proyecto.id_lote IS 'FK blanda hacia inventario.lote — sin constraint cross-schema';

COMMIT;
