-- ============================================================
-- Sistema Puertas Blindadas — Módulo Terreno
-- SQL CORREGIDO v2
-- Schema: terreno
-- ============================================================

-- El archivo es UTF-8: sin esto, psql en Windows lo lee como WIN1252 y daña los acentos
SET client_encoding = 'UTF8';

BEGIN;

DROP SCHEMA IF EXISTS terreno CASCADE;
CREATE SCHEMA terreno;
SET search_path TO terreno;

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 1 — CLIENTE (dueño: terreno)
-- ══════════════════════════════════════════════════════════════

CREATE TABLE cliente (
    rut_cliente                                      VARCHAR(12) NOT NULL,
    razon_social                                     TEXT        NOT NULL,
    contacto_principal                               TEXT        NOT NULL,
    correo                                           TEXT        NOT NULL,
    telefono                                         TEXT        NOT NULL,
    es_cliente_b2c                                   BOOLEAN     NOT NULL,
    cliente_b2c_rut                                  VARCHAR(12),
    cliente_b2c_correo                               TEXT,
    cliente_b2c_primer_nombre                        TEXT,
    cliente_b2c_segundo_nombre                       TEXT,
    cliente_b2c_primer_apellido                      TEXT,
    cliente_b2c_segundo_apellido                     TEXT,
    cliente_b2c_telefono_contacto                    TEXT,
    cliente_b2c_fecha_registro                       DATE,
    cliente_b2c_telefono_contacto_adicional          TEXT,
    cliente_b2c_fecha_ultima_edicion                 DATE,
    es_cliente_b2b                                   BOOLEAN     NOT NULL,
    cliente_b2b_fecha_ultima_edicion                 DATE,
    cliente_b2b_correo_institucional                 TEXT,
    cliente_b2b_fecha_registro                       DATE,
    cliente_b2b_telefono_corporativo                 TEXT,
    cliente_b2b_razon_social                         TEXT,
    cliente_b2b_rut_empresa                          VARCHAR(12),
    cliente_b2b_telefono_corp_adicional              TEXT,
    cliente_b2b_representante_legal_primer_nombre    TEXT,
    cliente_b2b_representante_legal_segundo_nombre   TEXT,
    cliente_b2b_representante_legal_primer_apellido  TEXT,
    cliente_b2b_representante_legal_segundo_apellido TEXT,
    CONSTRAINT pk_cliente PRIMARY KEY (rut_cliente)
);

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 2 — ESPECIFICACIÓN DE PUERTA
-- ══════════════════════════════════════════════════════════════

CREATE TABLE medidas_puerta (
    id_medidas                                BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    medidas_marco_ancho                       NUMERIC(12,4) NOT NULL,
    medidas_marco_alto                        NUMERIC(12,4) NOT NULL,
    medidas_marco_espesor                     NUMERIC(12,4) NOT NULL,
    medidas_vano_vertical_ancho               NUMERIC(12,4) NOT NULL,
    medidas_vano_vertical_alto                NUMERIC(12,4) NOT NULL,
    medidas_vano_vertical_espesor             NUMERIC(12,4) NOT NULL,
    medidas_vano_horizontal_ancho             NUMERIC(12,4) NOT NULL,
    medidas_vano_horizontal_alto              NUMERIC(12,4) NOT NULL,
    medidas_vano_horizontal_espesor           NUMERIC(12,4) NOT NULL,
    medidas_alojamiento_vertical_alto         NUMERIC(12,4) NOT NULL,
    medidas_alojamiento_vertical_ancho        NUMERIC(12,4) NOT NULL,
    medidas_alojamiento_vertical_espesor      NUMERIC(12,4) NOT NULL,
    medidas_alojamiento_horizontal_alto       NUMERIC(12,4) NOT NULL,
    medidas_alojamiento_horizontal_ancho      NUMERIC(12,4) NOT NULL,
    medidas_alojamiento_horizontal_espesor    NUMERIC(12,4) NOT NULL,
    alojamiento_vertical                      NUMERIC(12,4) NOT NULL,
    medidas_de_marco_ancho                    NUMERIC(12,4) NOT NULL,
    medidas_de_marco_alto                     NUMERIC(12,4) NOT NULL,
    medidas_de_marco_espesor                  NUMERIC(12,4) NOT NULL,
    CONSTRAINT pk_medidas_puerta PRIMARY KEY (id_medidas)
);

CREATE TABLE especificacion_puerta (
    id_especificacion_puerta    BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    modelo_puerta               TEXT    NOT NULL,
    zona                        TEXT    NOT NULL,
    sentido_apertura            TEXT    NOT NULL,
    materialidad_vano           TEXT    NOT NULL,
    materialidad_marco_actual   TEXT    NOT NULL,
    solucion_marco              TEXT    NOT NULL,
    hoja_pasiva                 TEXT    NOT NULL,
    hoja_activa                 TEXT    NOT NULL,
    diseno_puerta               TEXT    NOT NULL,
    observaciones_de_diseno     TEXT,
    cubrejuntas                 BOOLEAN NOT NULL,
    bisagras                    TEXT    NOT NULL,
    observaciones               TEXT,
    id_medidas                  BIGINT  NOT NULL,
    producto_terminado_id       BIGINT,
    CONSTRAINT pk_especificacion_puerta PRIMARY KEY (id_especificacion_puerta),
    CONSTRAINT uk_esp_puerta_medidas UNIQUE (id_medidas)
);

CREATE TABLE hoja_simple (
    id_especificacion_puerta         BIGINT        NOT NULL,
    medidas_vertical_alto            NUMERIC(12,4) NOT NULL,
    medidas_vertical_ancho           NUMERIC(12,4) NOT NULL,
    medidas_vertical_espesor         NUMERIC(12,4) NOT NULL,
    medidas_horizontal_alto          NUMERIC(12,4) NOT NULL,
    medidas_horizontal_ancho         NUMERIC(12,4) NOT NULL,
    medidas_horizontal_espesor       NUMERIC(12,4) NOT NULL,
    CONSTRAINT pk_hoja_simple PRIMARY KEY (id_especificacion_puerta)
);

CREATE TABLE hoja_doble (
    id_especificacion_puerta             BIGINT        NOT NULL,
    medidas_derecha                      TEXT          NOT NULL,
    medidas_derecha_vertical_alto        NUMERIC(12,4) NOT NULL,
    medidas_derecha_vertical_ancho       NUMERIC(12,4) NOT NULL,
    medidas_derecha_vertical_espesor     NUMERIC(12,4) NOT NULL,
    medidas_derecha_horizontal_alto      NUMERIC(12,4) NOT NULL,
    medidas_derecha_horizontal_ancho     NUMERIC(12,4) NOT NULL,
    medidas_derecha_horizontal_espesor   NUMERIC(12,4) NOT NULL,
    actividad_izquierda                  TEXT          NOT NULL,
    medidas_izquierda_vertical_alto      NUMERIC(12,4) NOT NULL,
    medidas_izquierda_vertical_ancho     NUMERIC(12,4) NOT NULL,
    medidas_izquierda_vertical_espesor   NUMERIC(12,4) NOT NULL,
    medidas_izquierda_horizontal_alto    NUMERIC(12,4) NOT NULL,
    medidas_izquierda_horizontal_ancho   NUMERIC(12,4) NOT NULL,
    medidas_izquierda_horizontal_espesor NUMERIC(12,4) NOT NULL,
    CONSTRAINT pk_hoja_doble PRIMARY KEY (id_especificacion_puerta)
);

CREATE TABLE especificacion_metalmecanica (
    id_metalmecanica         BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    bastidor                 TEXT NOT NULL,
    cerradura                TEXT NOT NULL,
    manillon                 TEXT NOT NULL,
    pernos_fijos             TEXT NOT NULL,
    manilla                  TEXT NOT NULL,
    herraje                  TEXT NOT NULL,
    cerrojo                  TEXT NOT NULL,
    ojo                      TEXT NOT NULL,
    otros                    TEXT NOT NULL,
    id_especificacion_puerta BIGINT NOT NULL,
    CONSTRAINT pk_esp_metalmecanica PRIMARY KEY (id_metalmecanica),
    CONSTRAINT uk_esp_metal_puerta UNIQUE (id_especificacion_puerta)
);

CREATE TABLE especificacion_terminaciones (
    id_terminacion           BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    herrajes                 TEXT          NOT NULL,
    pletina                  NUMERIC(12,4) NOT NULL,
    funda                    NUMERIC(12,4) NOT NULL,
    medida_final             NUMERIC(12,4) NOT NULL,
    manilla                  NUMERIC(12,4) NOT NULL,
    marco_metalico           NUMERIC(12,4) NOT NULL,
    bisagras                 NUMERIC(12,4) NOT NULL,
    molduras                 TEXT          NOT NULL,
    rebaje                   TEXT          NOT NULL,
    canterias                TEXT          NOT NULL,
    enchape                  TEXT          NOT NULL,
    id_especificacion_puerta BIGINT        NOT NULL,
    CONSTRAINT pk_esp_terminaciones PRIMARY KEY (id_terminacion),
    CONSTRAINT uk_esp_term_puerta UNIQUE (id_especificacion_puerta)
);

-- FK blanda: sku_material → inventario.material
CREATE TABLE detalles_herraje (
    id_detalles_herraje      BIGINT  NOT NULL,
    ubicacion                TEXT    NOT NULL,
    color                    TEXT    NOT NULL,
    cantidad                 INTEGER NOT NULL,
    observacion              TEXT,
    -- FK blanda hacia inventario.material
    sku_material             BIGINT,
    id_especificacion_puerta BIGINT  NOT NULL,
    CONSTRAINT pk_detalles_herraje PRIMARY KEY (id_detalles_herraje)
);

CREATE TABLE adicionales_pagados (
    id_adicionales           BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    retiro_escombros         BOOLEAN       NOT NULL,
    retiro_puerta_actual     BOOLEAN       NOT NULL,
    alarma                   BOOLEAN       NOT NULL,
    subida_escalera          TEXT          NOT NULL,
    endolados                BOOLEAN       NOT NULL,
    pilastras_alto           NUMERIC(12,4) NOT NULL,
    pilastras_ancho          NUMERIC(12,4) NOT NULL,
    pilastras_espesor        NUMERIC(12,4) NOT NULL,
    observaciones            TEXT,
    id_especificacion_puerta BIGINT        NOT NULL,
    CONSTRAINT pk_adicionales_pagados PRIMARY KEY (id_adicionales),
    CONSTRAINT uk_adicionales_puerta UNIQUE (id_especificacion_puerta)
);

CREATE TABLE historial_cambio_orden_trabajo (
    id_cambio                BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    version_nueva            TEXT      NOT NULL,
    version_antigua          TEXT      NOT NULL,
    fecha_hora               TIMESTAMP NOT NULL,
    descripcion              TEXT      NOT NULL,
    id_especificacion_puerta BIGINT    NOT NULL,
    CONSTRAINT pk_historial_cambio PRIMARY KEY (id_cambio)
);

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 3 — PROYECTO Y OBRA
-- ══════════════════════════════════════════════════════════════

CREATE TABLE proyecto (
    id_proyecto          BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    codigo_proyecto      TEXT    NOT NULL,
    nombre_referencia    TEXT    NOT NULL,
    fecha_instalacion    DATE    NOT NULL,
    fecha_ingreso        DATE    NOT NULL,
    estado_operacional   TEXT    NOT NULL,
    estado_produccion    TEXT    NOT NULL,
    rut_cliente          VARCHAR(12) NOT NULL,
    CONSTRAINT pk_proyecto PRIMARY KEY (id_proyecto)
);

CREATE TABLE obra (
    id_obra                  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    nombre_obra              TEXT    NOT NULL,
    direccion_obra           TEXT    NOT NULL,
    comuna                   TEXT    NOT NULL,
    region                   TEXT    NOT NULL,
    tipo_obra                TEXT    NOT NULL,
    fecha_de_creacion        DATE    NOT NULL,
    fecha_de_ultima_edicion  DATE    NOT NULL,
    estado                   TEXT    NOT NULL,
    cantidad_puerta          INTEGER NOT NULL,
    referencia               TEXT    NOT NULL,
    observaciones            TEXT,
    rut_cliente              VARCHAR(12) NOT NULL,
    id_especificacion_puerta BIGINT      NOT NULL,
    CONSTRAINT pk_obra PRIMARY KEY (id_obra)
);

CREATE TABLE especificacion_proyecto_terreno (
    id_especificacion_proyecto_terreno  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    estado_operacional                  TEXT NOT NULL,
    estado_produccion                   TEXT NOT NULL,
    estado_instalacion                  TEXT NOT NULL,
    fecha_inicio                        DATE NOT NULL,
    fecha_cierre_operativo              DATE NOT NULL,
    observacion_estado                  TEXT,
    conformidad_cliente                 TEXT NOT NULL,
    id_especificacion_puerta            BIGINT NOT NULL,
    CONSTRAINT pk_esp_proyecto_terreno PRIMARY KEY (id_especificacion_proyecto_terreno),
    CONSTRAINT uk_esp_proy_ter_puerta UNIQUE (id_especificacion_puerta)
);

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 4 — SERVICIOS DE TERRENO
-- ══════════════════════════════════════════════════════════════

CREATE TABLE checklist_de_materiales (
    id_checklist_de_materiales  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    tipo_inicio_tarea           TEXT    NOT NULL,
    tipo_cierre_tarea           TEXT    NOT NULL,
    item                        TEXT    NOT NULL,
    es_marcado                  BOOLEAN NOT NULL,
    marcado                     TEXT,
    es_no_marcado               BOOLEAN NOT NULL,
    no_marcado                  TEXT,
    CONSTRAINT pk_checklist PRIMARY KEY (id_checklist_de_materiales)
);

CREATE TABLE servicio_terreno (
    id_servicio_terreno        BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    tipo_servicio              TEXT    NOT NULL,
    fecha_real                 DATE    NOT NULL,
    bloque_horario             TIME    NOT NULL,
    prioridad                  TEXT    NOT NULL,
    fecha_programada           TIME    NOT NULL,
    estado                     TEXT    NOT NULL,
    observaciones              TEXT,
    -- FK blanda hacia inventario.usuario
    id_usuario                 BIGINT  NOT NULL,
    id_checklist_de_materiales BIGINT  NOT NULL,
    CONSTRAINT pk_servicio_terreno PRIMARY KEY (id_servicio_terreno)
);

-- Tabla de relación N:M entre servicio_terreno y herramientas/materiales
-- FK blanda: los materiales/herramientas viven en inventario
CREATE TABLE servicio_terreno_herramientas_materiales (
    id_servicio_terreno_herramientas_materiales  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    id_servicio_terreno                          BIGINT NOT NULL,
    CONSTRAINT pk_st_herramientas PRIMARY KEY (id_servicio_terreno_herramientas_materiales)
);

CREATE TABLE especificacion_servicio_terreno (
    id_servicio_terreno      BIGINT NOT NULL,
    id_especificacion_puerta BIGINT NOT NULL,
    CONSTRAINT pk_esp_servicio PRIMARY KEY (id_servicio_terreno, id_especificacion_puerta)
);

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 5 — TAREAS
-- ══════════════════════════════════════════════════════════════

CREATE TABLE tarea (
    id_tarea                        BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    descripcion                     TEXT      NOT NULL,
    fecha_de_visita                 DATE      NOT NULL,
    fecha_de_termino                DATE      NOT NULL,
    bloque_horario                  TIMESTAMP NOT NULL,
    fecha_de_creacion               DATE      NOT NULL,
    fecha_de_ultima_actualizacion   DATE      NOT NULL,
    fecha_de_inicio                 DATE      NOT NULL,
    fecha_de_inicio_en_terreno      DATE      NOT NULL,
    titulo                          TEXT      NOT NULL,
    horario_limite                  TIMESTAMP NOT NULL,
    instrucciones_de_oficina        TEXT,
    urgencia                        TEXT      NOT NULL,
    estado_de_tarea                 TEXT      NOT NULL,
    -- FK blanda hacia inventario.usuario
    id_usuario                      BIGINT    NOT NULL,
    id_servicio_terreno             BIGINT    NOT NULL,
    id_especificacion_puerta        BIGINT    NOT NULL,
    CONSTRAINT pk_tarea PRIMARY KEY (id_tarea)
);

CREATE TABLE tarea_tipo (
    id_tarea_tipo          BIGINT    GENERATED ALWAYS AS IDENTITY NOT NULL,
    tiempo_estimado_tarea  TIMESTAMP NOT NULL,
    remuneracion_tarea     INTEGER   NOT NULL,
    id_tarea               BIGINT    NOT NULL,
    CONSTRAINT pk_tarea_tipo PRIMARY KEY (id_tarea_tipo)
);

CREATE TABLE tarea_usuario (
    id_tarea   BIGINT NOT NULL,
    -- FK blanda hacia inventario.usuario
    id_usuario BIGINT NOT NULL,
    CONSTRAINT pk_tarea_usuario PRIMARY KEY (id_tarea, id_usuario)
);

CREATE TABLE receptor (
    id_receptor           BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    primer_nombre_receptor TEXT   NOT NULL,
    segundo_nombre_receptor TEXT,
    primer_apellido_receptor TEXT  NOT NULL,
    segundo_apellido_receptor TEXT,
    rut_receptor          TEXT   NOT NULL,
    id_tarea              BIGINT NOT NULL,
    CONSTRAINT pk_receptor PRIMARY KEY (id_receptor)
);

CREATE TABLE formulario_de_cierre (
    id_formulario_de_cierre         BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    detalle_de_observaciones        TEXT,
    sentido_de_apertura_correcto    BOOLEAN NOT NULL,
    pilastras_incluidas_y_ajustadas BOOLEAN NOT NULL,
    resultado_finalizado            TEXT    NOT NULL,
    cilindro_correcto               BOOLEAN NOT NULL,
    ausencia_de_rayones_o_danos     BOOLEAN NOT NULL,
    id_tarea                        BIGINT  NOT NULL,
    CONSTRAINT pk_formulario_cierre PRIMARY KEY (id_formulario_de_cierre),
    CONSTRAINT uk_formulario_tarea UNIQUE (id_tarea)
);

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 6 — PRÉSTAMOS Y NOTIFICACIONES
-- ══════════════════════════════════════════════════════════════

-- FK blanda: rut_empleado → finanzas.empleado, sku_material → inventario.material
-- prestamo_herramientas ELIMINADA el 2026-09-19.
-- La reemplaza inventario.asignacion_herramienta (OPUS-13), que sí puede
-- representar un préstamo vigente y referencia material_sku con el tipo correcto.
-- Sus 2 filas y el motivo completo quedaron en historico_prestamo_herramientas.sql.

CREATE TABLE notificacion_tecnico (
    id_notificacion_tecnico  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    fecha_emision            TIMESTAMPTZ NOT NULL,
    mensaje                  TEXT        NOT NULL,
    -- FK blanda hacia inventario.usuario
    id_usuario               BIGINT      NOT NULL,
    id_servicio_terreno      BIGINT      NOT NULL,
    CONSTRAINT pk_notificacion_tecnico PRIMARY KEY (id_notificacion_tecnico)
);

CREATE TABLE notificacion_terreno (
    id_notificacion_terreno  BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    mensaje                  TEXT   NOT NULL,
    -- FK blanda hacia inventario.usuario
    id_usuario               BIGINT NOT NULL,
    id_tarea                 BIGINT NOT NULL,
    CONSTRAINT pk_notificacion_terreno PRIMARY KEY (id_notificacion_terreno)
);

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 7 — FOREIGN KEYS INTERNAS
-- ══════════════════════════════════════════════════════════════

-- medidas_puerta no tiene FKs internas

ALTER TABLE especificacion_puerta
    ADD CONSTRAINT fk_ep_medidas FOREIGN KEY (id_medidas) REFERENCES medidas_puerta(id_medidas);

ALTER TABLE hoja_simple
    ADD CONSTRAINT fk_hs_ep FOREIGN KEY (id_especificacion_puerta) REFERENCES especificacion_puerta(id_especificacion_puerta);

ALTER TABLE hoja_doble
    ADD CONSTRAINT fk_hd_ep FOREIGN KEY (id_especificacion_puerta) REFERENCES especificacion_puerta(id_especificacion_puerta);

ALTER TABLE especificacion_metalmecanica
    ADD CONSTRAINT fk_em_ep FOREIGN KEY (id_especificacion_puerta) REFERENCES especificacion_puerta(id_especificacion_puerta);

ALTER TABLE especificacion_terminaciones
    ADD CONSTRAINT fk_et_ep FOREIGN KEY (id_especificacion_puerta) REFERENCES especificacion_puerta(id_especificacion_puerta);

ALTER TABLE detalles_herraje
    ADD CONSTRAINT fk_dh_ep FOREIGN KEY (id_especificacion_puerta) REFERENCES especificacion_puerta(id_especificacion_puerta);
    -- sku_material: FK blanda hacia inventario.material

ALTER TABLE adicionales_pagados
    ADD CONSTRAINT fk_ap_ep FOREIGN KEY (id_especificacion_puerta) REFERENCES especificacion_puerta(id_especificacion_puerta);

ALTER TABLE historial_cambio_orden_trabajo
    ADD CONSTRAINT fk_hcot_ep FOREIGN KEY (id_especificacion_puerta) REFERENCES especificacion_puerta(id_especificacion_puerta);

ALTER TABLE proyecto
    ADD CONSTRAINT fk_proy_cliente FOREIGN KEY (rut_cliente) REFERENCES cliente(rut_cliente);

ALTER TABLE obra
    ADD CONSTRAINT fk_obra_cliente FOREIGN KEY (rut_cliente) REFERENCES cliente(rut_cliente),
    ADD CONSTRAINT fk_obra_ep      FOREIGN KEY (id_especificacion_puerta) REFERENCES especificacion_puerta(id_especificacion_puerta);

ALTER TABLE especificacion_proyecto_terreno
    ADD CONSTRAINT fk_ept_ep FOREIGN KEY (id_especificacion_puerta) REFERENCES especificacion_puerta(id_especificacion_puerta);

ALTER TABLE servicio_terreno
    ADD CONSTRAINT fk_st_checklist FOREIGN KEY (id_checklist_de_materiales) REFERENCES checklist_de_materiales(id_checklist_de_materiales);
    -- id_usuario: FK blanda hacia inventario.usuario

ALTER TABLE servicio_terreno_herramientas_materiales
    ADD CONSTRAINT fk_sthm_st FOREIGN KEY (id_servicio_terreno) REFERENCES servicio_terreno(id_servicio_terreno);

ALTER TABLE especificacion_servicio_terreno
    ADD CONSTRAINT fk_est_st FOREIGN KEY (id_servicio_terreno) REFERENCES servicio_terreno(id_servicio_terreno),
    ADD CONSTRAINT fk_est_ep FOREIGN KEY (id_especificacion_puerta) REFERENCES especificacion_puerta(id_especificacion_puerta);

ALTER TABLE tarea
    ADD CONSTRAINT fk_t_st FOREIGN KEY (id_servicio_terreno) REFERENCES servicio_terreno(id_servicio_terreno),
    ADD CONSTRAINT fk_t_ep FOREIGN KEY (id_especificacion_puerta) REFERENCES especificacion_puerta(id_especificacion_puerta);
    -- id_usuario: FK blanda hacia inventario.usuario

ALTER TABLE tarea_tipo
    ADD CONSTRAINT fk_tt_tarea FOREIGN KEY (id_tarea) REFERENCES tarea(id_tarea);

ALTER TABLE tarea_usuario
    ADD CONSTRAINT fk_tu_tarea FOREIGN KEY (id_tarea) REFERENCES tarea(id_tarea);
    -- id_usuario: FK blanda hacia inventario.usuario

ALTER TABLE receptor
    ADD CONSTRAINT fk_rec_tarea FOREIGN KEY (id_tarea) REFERENCES tarea(id_tarea);

ALTER TABLE formulario_de_cierre
    ADD CONSTRAINT fk_fc_tarea FOREIGN KEY (id_tarea) REFERENCES tarea(id_tarea);

ALTER TABLE notificacion_tecnico
    ADD CONSTRAINT fk_nt_st FOREIGN KEY (id_servicio_terreno) REFERENCES servicio_terreno(id_servicio_terreno);
    -- id_usuario: FK blanda hacia inventario.usuario

ALTER TABLE notificacion_terreno
    ADD CONSTRAINT fk_nter_tarea FOREIGN KEY (id_tarea) REFERENCES tarea(id_tarea);
    -- id_usuario: FK blanda hacia inventario.usuario

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 8 — ÍNDICES
-- ══════════════════════════════════════════════════════════════

CREATE INDEX idx_ep_modelo      ON especificacion_puerta(modelo_puerta);
CREATE INDEX idx_ep_medidas     ON especificacion_puerta(id_medidas);

CREATE INDEX idx_proy_cliente   ON proyecto(rut_cliente);
CREATE INDEX idx_proy_estado    ON proyecto(estado_operacional);

CREATE INDEX idx_obra_cliente   ON obra(rut_cliente);
CREATE INDEX idx_obra_ep        ON obra(id_especificacion_puerta);

CREATE INDEX idx_st_usuario     ON servicio_terreno(id_usuario);
CREATE INDEX idx_st_estado      ON servicio_terreno(estado);

CREATE INDEX idx_tarea_st       ON tarea(id_servicio_terreno);
CREATE INDEX idx_tarea_ep       ON tarea(id_especificacion_puerta);
CREATE INDEX idx_tarea_usuario  ON tarea(id_usuario);
CREATE INDEX idx_tarea_estado   ON tarea(estado_de_tarea);

CREATE INDEX idx_nt_st          ON notificacion_tecnico(id_servicio_terreno);
CREATE INDEX idx_nter_tarea     ON notificacion_terreno(id_tarea);


CREATE INDEX idx_receptor_tarea ON receptor(id_tarea);

-- OPUS-19: de aqui sale la receta de la OT
CREATE INDEX idx_esp_puerta_producto ON especificacion_puerta(producto_terminado_id)
    WHERE producto_terminado_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════
-- BLOQUE 9 — COMENTARIOS
-- ══════════════════════════════════════════════════════════════

COMMENT ON SCHEMA terreno IS 'Módulo Terreno — Sistema Puertas Blindadas';
COMMENT ON TABLE cliente IS 'Dueño: terreno. Finanzas referencia rut_cliente como FK blanda.';
COMMENT ON TABLE especificacion_puerta IS 'Entidad central del módulo. Nombre alineado con convención snake_case.';
COMMENT ON TABLE servicio_terreno_herramientas_materiales IS 'Relación N:M con herramientas/materiales de inventario. Nombre corregido (sin doble "t").';
COMMENT ON TABLE notificacion_terreno IS 'Tabla propia del grupo Terreno, no presente en el conjunto original. Aprobada como extensión.';

COMMENT ON COLUMN servicio_terreno.id_usuario IS 'FK blanda hacia inventario.usuario — sin constraint cross-schema';
COMMENT ON COLUMN tarea.id_usuario IS 'FK blanda hacia inventario.usuario — sin constraint cross-schema';
COMMENT ON COLUMN tarea_usuario.id_usuario IS 'FK blanda hacia inventario.usuario — sin constraint cross-schema';
COMMENT ON COLUMN notificacion_tecnico.id_usuario IS 'FK blanda hacia inventario.usuario — sin constraint cross-schema';
COMMENT ON COLUMN notificacion_terreno.id_usuario IS 'FK blanda hacia inventario.usuario — sin constraint cross-schema';
COMMENT ON COLUMN detalles_herraje.sku_material IS 'FK blanda hacia inventario.material — sin constraint cross-schema';
COMMENT ON COLUMN especificacion_puerta.producto_terminado_id IS 'FK blanda hacia inventario.producto_terminado — de aqui sale la receta de la OT (OPUS-19)';


COMMIT;
