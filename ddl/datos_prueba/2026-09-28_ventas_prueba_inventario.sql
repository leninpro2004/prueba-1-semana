-- ============================================================
-- Datos de prueba 2026-09-28 — Ventas para los CU de Inventario (D40)
-- Schema: finanzas (de OTRO grupo) | Insertadas por Grupo 14 (Inventario)
--
-- EXCEPCION a la regla 7, autorizada por el usuario el 2026-09-28. Finanzas no
-- tenia ventas con puertas (id_producto_terminado) ni con materiales sueltos
-- (sku_material), y sin ellas no se pueden probar CU-122, CU-124 ni CU-131.
-- Requiere la migracion 2026-09-28_finanzas_sku_material.sql.
--
-- Todas se reconocen por numero_nota_venta 'NV-PRUEBA-INV-%' y por la observacion.
-- Usa los clientes, proyectos, recetas y materiales que YA existen en la BD real
-- (se buscan por RUT, codigo y SKU, no por id).
--
--   01 aprobada  · Constructora Andes   · acero cal.14, pintura custom (sin proveedor),
--                                          puerta estandar (receta con pintura esmalte blanco), instalacion
--   02 aprobada  · Inmobiliaria del Sur · pintura custom (misma que 01, fecha limite anterior),
--                                          acero cal.16 (mas de lo que hay en stock), tabla pino
--   03 pendiente · Roberto Figueroa     · pintura anticorrosiva gris, puerta doble hoja (receta sin especiales)
--   04 cancelada · Constructora Andes   · pintura anticorrosiva gris (no debe alertar ni reservar)
--   05 aprobada  · Inmobiliaria del Sur · pintura esmalte blanco, emitida hace mas de 60 dias
--
-- OJO: CU-122 revisa las ventas de los ULTIMOS 60 DIAS. Las fechas son fijas: a
-- partir de mediados de noviembre de 2026 las 01 a 04 salen de esa ventana.
--
-- Es IDEMPOTENTE: una venta que ya existe (mismo numero) no se inserta de nuevo
-- ni se le agregan lineas.
-- ============================================================

BEGIN;
SET search_path TO finanzas;

-- Venta + sus lineas: si la venta ya existe, el CTE no devuelve filas y no se inserta nada
CREATE TEMP TABLE _venta_prueba (
  numero TEXT, rut TEXT, proyecto TEXT, emision DATE, entrega DATE, estado TEXT
) ON COMMIT DROP;
CREATE TEMP TABLE _linea_prueba (
  numero TEXT, orden INT, sku TEXT, receta TEXT, descripcion TEXT, cantidad NUMERIC,
  precio NUMERIC, produccion BOOLEAN, instalacion BOOLEAN
) ON COMMIT DROP;

INSERT INTO _venta_prueba VALUES
  ('NV-PRUEBA-INV-01', '76543210-1', 'PRY-2024-001', '2026-09-15', '2026-10-30', 'aprobada'),
  ('NV-PRUEBA-INV-02', '87654321-2', 'PRY-2024-002', '2026-09-20', '2026-10-15', 'aprobada'),
  ('NV-PRUEBA-INV-03', '98765432-3', 'PRY-2024-003', '2026-09-25', '2026-11-10', 'pendiente'),
  ('NV-PRUEBA-INV-04', '76543210-1', 'PRY-2024-001', '2026-09-10', '2026-10-20', 'cancelada'),
  ('NV-PRUEBA-INV-05', '87654321-2', 'PRY-2024-002', '2026-06-15', '2026-07-30', 'aprobada');

-- sku = material suelto (sku_material); receta = puerta (codigo de producto_terminado); ninguno = servicio
INSERT INTO _linea_prueba VALUES
  ('NV-PRUEBA-INV-01', 1, 'ACR-001', NULL,         'Acero galvanizado cal.14 (plancha)',       5,    29000, FALSE, FALSE),
  ('NV-PRUEBA-INV-01', 2, 'PIN-CUS', NULL,         'Pintura verde oliva custom (kg)',          4,    18000, FALSE, FALSE),
  ('NV-PRUEBA-INV-01', 3, NULL,      'PB-STD-001', 'Puerta blindada estándar',                 2,  1250000, TRUE,  TRUE),
  ('NV-PRUEBA-INV-01', 4, NULL,      NULL,         'Instalación puerta estándar',              2,   180000, FALSE, FALSE),
  ('NV-PRUEBA-INV-02', 1, 'PIN-CUS', NULL,         'Pintura verde oliva custom (kg)',          3,    18000, FALSE, FALSE),
  ('NV-PRUEBA-INV-02', 2, 'ACR-016', NULL,         'Acero galvanizado cal.16 (plancha)',       5,    25000, FALSE, FALSE),
  ('NV-PRUEBA-INV-02', 3, 'MAD-PIN', NULL,         'Tabla pino radiata 1x6 (metro)',           4,     4500, FALSE, FALSE),
  ('NV-PRUEBA-INV-03', 1, 'PIN-GRS', NULL,         'Pintura anticorrosiva gris (kg)',          2,    14000, FALSE, FALSE),
  ('NV-PRUEBA-INV-03', 2, NULL,      'PB-DBL-001', 'Puerta blindada doble hoja',               1,  2100000, TRUE,  TRUE),
  ('NV-PRUEBA-INV-04', 1, 'PIN-GRS', NULL,         'Pintura anticorrosiva gris (kg)',          5,    14000, FALSE, FALSE),
  ('NV-PRUEBA-INV-05', 1, 'PIN-BLA', NULL,         'Pintura esmalte blanco (kg)',              2,    13500, FALSE, FALSE);

WITH nuevas AS (
  INSERT INTO nota_venta (numero_nota_venta, id_cliente_financiero, id_proyecto_financiero, fecha_emision,
                          fecha_max_entrega, tipo_nota_venta, estado_pedido, estado_pago, observacion)
  SELECT v.numero, c.id_cliente_financiero, p.id_proyecto_financiero, v.emision, v.entrega, 'producto',
         v.estado, 'pendiente', 'DATOS DE PRUEBA — Inventario G14 (2026-09-28). Ver docs/sprint/reporte-finanzas.md'
  FROM _venta_prueba v
  JOIN cliente_financiero c  ON c.rut_cliente = v.rut
  JOIN proyecto_financiero p ON p.codigo_proyecto = v.proyecto
  ON CONFLICT (numero_nota_venta) DO NOTHING
  RETURNING id_nota_venta, numero_nota_venta
)
INSERT INTO item_nota_venta (id_nota_venta, id_producto_terminado, sku_material, descripcion_item, cantidad,
                             precio_unitario, requiere_produccion, requiere_instalacion, estado_item)
SELECT n.id_nota_venta, pt.producto_terminado_id_producto, l.sku, l.descripcion, l.cantidad,
       l.precio, l.produccion, l.instalacion, 'pendiente'
FROM nuevas n
JOIN _linea_prueba l ON l.numero = n.numero_nota_venta
LEFT JOIN inventario.producto_terminado pt ON pt.producto_terminado_codigo_producto = l.receta
ORDER BY n.numero_nota_venta, l.orden;

COMMIT;

-- ── Para borrarlas (primero las lineas, por la FK) ──────────────────────
-- BEGIN;
-- DELETE FROM finanzas.item_nota_venta WHERE id_nota_venta IN
--   (SELECT id_nota_venta FROM finanzas.nota_venta WHERE numero_nota_venta LIKE 'NV-PRUEBA-INV-%');
-- DELETE FROM finanzas.nota_venta WHERE numero_nota_venta LIKE 'NV-PRUEBA-INV-%';
-- COMMIT;
-- Si Inventario ya genero alertas o reservas con estas ventas, revisarlas antes
-- (alerta_faltante_pedido, reserva_inventario y preparacion_pedido tienen FK blanda a nota_venta).
