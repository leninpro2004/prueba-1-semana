const { query } = require('../db/pool');
const auditoria = require('./auditoriaController');
const { ocultaMontos } = require('../middleware/auth');
const { ErrorNegocio, conTransaccion, responderError } = require('../db/tx');
const { tipoMovimientoId, motivoMovimientoId, descontarFifo, insertarMovimiento, resolverBodega } = require('../db/stock');
const { generarAlertasAutomaticas } = require('./alertasController');

// D52: motivos de la salida al cerrar una asignación como perdida o dada de baja (clasificación merma)
const MOTIVO_PERDIDA = 'perdida_herramienta';
const MOTIVO_BAJA = 'baja_herramienta';

/* ======================================================================
   OPUS-10 (Req #5) — Herramientas: listado y valorizacion.

   Una herramienta es un material con material_es_herramienta = TRUE: un bien
   reutilizable, no un consumible. El valor unitario sale de
   material_valor_adquisicion y, si no se informo, cae al precio referencial
   del proveedor principal.

   OPUS-13 extendera este controller con depreciacion, asignaciones y
   mantenimiento; por eso vive en su propio archivo y no dentro de
   materialesController.
   ====================================================================== */

/** Los montos solo los ve quien puede ver precios (mismo criterio que reporteMermas / FR-59). */
const puedeVerValores = (req) => !ocultaMontos(req);   // D50: jop y técnico no ven valores

/**
 * Asignaciones abiertas de una herramienta (se usa como LATERAL sobre `m`).
 * Devuelve cuantas unidades estan entregadas y a quien.
 */
const LATERAL_ASIGNACIONES = `
  SELECT COALESCE(SUM(a.cantidad), 0) AS prestados,
         json_agg(json_build_object(
           'asignacion_id',    a.asignacion_id,
           'empleado_rut',     a.empleado_rut,
           'empleado',         NULLIF(TRIM(CONCAT_WS(' ',
                                 e.empleado_nombre_empleado_primer_nombre_empleado,
                                 e.empleado_nombre_empleado_primer_apellido_empleado)), ''),
           'area_id',          a.area_trabajo_id,
           'area',             at.area_trabajo_nombre_area,
           'cantidad',         a.cantidad,
           'fecha_asignacion', a.fecha_asignacion)) AS detalle
  FROM asignacion_herramienta a
  LEFT JOIN finanzas.empleado e ON e.empleado_rut_empleado = a.empleado_rut
  LEFT JOIN area_trabajo at      ON at.area_trabajo_id_area = a.area_trabajo_id
  WHERE a.material_sku = m.material_sku
    AND a.estado = 'asignada'`;

/**
 * Meses transcurridos desde el inicio de la depreciacion. AGE() cuenta meses
 * completos, que es lo que corresponde para una cuota mensual.
 */
const SQL_MESES_DEPRECIADOS = `
  GREATEST(0, DATE_PART('year',  AGE(CURRENT_DATE, d.fecha_inicio_depreciacion)) * 12
            + DATE_PART('month', AGE(CURRENT_DATE, d.fecha_inicio_depreciacion)))`;

/**
 * Depreciacion acumulada POR UNIDAD.
 *   lineal: (valor - residual) x meses_transcurridos / vida_util_meses
 *   uso:    (valor - residual) x usos_completados   / vida_util_usos
 * El LEAST(..., 1) es el tope: una herramienta nunca se deprecia por debajo de
 * su valor residual, por mas anios o usos que pasen.
 * NULL cuando no hay configuracion o no hay valor de adquisicion: sin esos dos
 * datos la depreciacion no se puede calcular, y 0 seria mentir.
 */
const SQL_DEPRECIACION_UNITARIA = `
  CASE
    WHEN d.depreciacion_id IS NULL OR m.material_valor_adquisicion IS NULL THEN NULL
    WHEN d.metodo_depreciacion = 'lineal' THEN
      GREATEST(m.material_valor_adquisicion - d.valor_residual, 0)
        * LEAST(${SQL_MESES_DEPRECIADOS} / NULLIF(d.vida_util_meses, 0), 1)
    ELSE
      GREATEST(m.material_valor_adquisicion - d.valor_residual, 0)
        * LEAST(COALESCE(usos.usos, 0)::numeric / NULLIF(d.vida_util_usos, 0), 1)
  END`;

/** Usos completados = asignaciones ya devueltas (se usa como LATERAL sobre `m`). */
const LATERAL_USOS = `
  SELECT COUNT(*) AS usos FROM asignacion_herramienta a2
  WHERE a2.material_sku = m.material_sku AND a2.estado = 'devuelta'`;

/**
 * GET /api/herramientas
 * Listado de herramientas con stock, valor unitario y valor total.
 * Query params: ?buscar=&categoria=&bodega_id=&estado=   (estado por defecto: activo)
 */
async function listar(req, res) {
  const { buscar, categoria, bodega_id, estado } = req.query;

  if (bodega_id !== undefined && bodega_id !== '' && isNaN(parseInt(bodega_id))) {
    return res.status(400).json({ error: 'bodega_id debe ser numérico' });
  }

  // 'todos' permite ver tambien las herramientas dadas de baja
  const filtroEstado = !estado || estado === 'todos' ? null : estado;

  try {
    const { rows } = await query(
      `SELECT
         m.material_sku                            AS sku,
         m.material_nombre_material                AS nombre,
         m.material_descripcion                    AS descripcion,
         m.material_estado                         AS estado,
         m.material_material_critico               AS es_critico,
         m.material_valor_adquisicion              AS valor_adquisicion,
         TO_CHAR(m.material_fecha_adquisicion, 'YYYY-MM-DD') AS fecha_adquisicion,
         cg.material_categoria_general_nombre      AS categoria_general,
         cf.material_categoria_funcional_nombre    AS categoria_funcional,
         um.material_unidad_medida_nombre          AS unidad,
         COALESCE(stk.stock_total, 0)              AS stock_total,
         COALESCE(stk.stock_reservado, 0)          AS stock_reservado,
         stk.bodegas                               AS bodegas,
         -- El valor de adquisicion manda; si no se informo, el precio del proveedor principal
         COALESCE(m.material_valor_adquisicion, prov.precio) AS valor_unitario,
         CASE
           WHEN m.material_valor_adquisicion IS NOT NULL THEN 'adquisicion'
           WHEN prov.precio IS NOT NULL                  THEN 'referencial'
           ELSE NULL
         END                                       AS origen_valor,
         COALESCE(m.material_valor_adquisicion, prov.precio, 0) * COALESCE(stk.stock_total, 0) AS valor_total,
         COALESCE(prest.prestados, 0)              AS prestados,
         prest.detalle                             AS prestamos
       FROM material m
       LEFT JOIN material_categoria_general cg
              ON cg.material_categoria_general_id_categoria_general
               = m.material_categoria_general_id_categoria_general
       LEFT JOIN material_categoria_funcional cf
              ON cf.material_categoria_funcional_id_categoria_funcional
               = m.material_categoria_funcional_id_categoria_funcional
       LEFT JOIN material_unidad_medida um
              ON um.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
       -- Stock agregado por bodega. Va en un LATERAL y no en un JOIN directo para
       -- evitar el fan-out que multiplicaria las filas (mismo bug que OPUS-6).
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(t.cant), 0) AS stock_total,
                COALESCE(SUM(t.res), 0)  AS stock_reservado,
                json_agg(json_build_object('bodega_id', t.bodega_id, 'bodega', t.bodega, 'cantidad', t.cant)
                         ORDER BY t.bodega) FILTER (WHERE t.cant > 0) AS bodegas
         FROM (
           SELECT ib.bodega_id_bodega AS bodega_id,
                  b.bodega_nombre_bodega AS bodega,
                  SUM(ib.inventario_bodega_cantidad_fisica)   AS cant,
                  SUM(ib.inventario_bodega_cantidad_reservada) AS res
           FROM inventario_bodega ib
           LEFT JOIN bodega b ON b.bodega_id_bodega = ib.bodega_id_bodega
           WHERE ib.material_sku = m.material_sku
           GROUP BY ib.bodega_id_bodega, b.bodega_nombre_bodega
         ) t
       ) stk ON TRUE
       -- Precio referencial: UNA fila (el del proveedor principal), no una por proveedor
       LEFT JOIN LATERAL (
         SELECT mp.material_proveedor_precio_referencial AS precio
         FROM material_proveedor mp
         WHERE mp.material_sku = m.material_sku
           AND mp.material_proveedor_precio_referencial IS NOT NULL
         ORDER BY mp.material_proveedor_proveedor_principal DESC NULLS LAST
         LIMIT 1
       ) prov ON TRUE
       -- Asignaciones vigentes (OPUS-13). En OPUS-10 esto leia
       -- terreno.prestamo_herramientas, que se ELIMINO el 2026-09-19: su sku_material
       -- era BIGINT contra un material_sku VARCHAR(16) y su fecha_devolucion era NOT
       -- NULL, asi que no podia representar un prestamo vigente.
       LEFT JOIN LATERAL (${LATERAL_ASIGNACIONES}) prest ON TRUE
       WHERE m.material_es_herramienta = TRUE
         AND ($1::text IS NULL OR
              m.material_sku ILIKE '%' || $1 || '%' OR
              m.material_nombre_material ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR
              cg.material_categoria_general_nombre ILIKE '%' || $2 || '%' OR
              cf.material_categoria_funcional_nombre ILIKE '%' || $2 || '%')
         AND ($3::bigint IS NULL OR EXISTS (
               SELECT 1 FROM inventario_bodega ib2
               WHERE ib2.material_sku = m.material_sku
                 AND ib2.bodega_id_bodega = $3::bigint
                 AND ib2.inventario_bodega_cantidad_fisica > 0))
         AND ($4::text IS NULL OR m.material_estado = $4)
       ORDER BY COALESCE(m.material_valor_adquisicion, prov.precio, 0) * COALESCE(stk.stock_total, 0) DESC,
                m.material_nombre_material`,
      [buscar || null, categoria || null, bodega_id || null, filtroEstado]
    );

    const verValores = puedeVerValores(req);

    const herramientas = rows.map(r => {
      const fila = {
        sku: r.sku,
        nombre: r.nombre,
        descripcion: r.descripcion,
        estado: r.estado,
        es_critico: r.es_critico,
        categoria_general: r.categoria_general,
        categoria_funcional: r.categoria_funcional,
        unidad: r.unidad,
        stock_total: parseFloat(r.stock_total),
        stock_reservado: parseFloat(r.stock_reservado),
        bodegas: r.bodegas || [],
        fecha_adquisicion: r.fecha_adquisicion,
        prestados: parseInt(r.prestados),
        prestamos: r.prestamos || [],
      };
      if (verValores) {
        fila.valor_adquisicion = r.valor_adquisicion != null ? parseFloat(r.valor_adquisicion) : null;
        fila.valor_unitario    = r.valor_unitario != null ? parseFloat(r.valor_unitario) : null;
        fila.valor_total       = parseFloat(r.valor_total);
        fila.origen_valor      = r.origen_valor;
      }
      return fila;
    });

    const resumen = {
      total_herramientas: herramientas.length,
      stock_total: herramientas.reduce((a, h) => a + h.stock_total, 0),
      prestadas: herramientas.reduce((a, h) => a + h.prestados, 0),
      sin_stock: herramientas.filter(h => h.stock_total <= 0).length,
      ...(verValores && {
        valor_total: rows.reduce((a, r) => a + parseFloat(r.valor_total || 0), 0),
        // Cuantas no tienen ningun valor con el que calcular: la valorizacion es parcial
        sin_valor: rows.filter(r => r.valor_unitario == null).length,
      }),
    };

    res.json({ resumen, herramientas, muestra_valores: verValores });
  } catch (err) {
    console.error('Error listando herramientas:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * PUT /api/herramientas/:sku
 * Datos de valorizacion de una herramienta. Sirve tambien para marcar o
 * desmarcar un material como herramienta.
 * Body: { es_herramienta?, valor_adquisicion?, fecha_adquisicion? }
 * Los campos omitidos no se tocan; enviar null en un valor lo limpia.
 */
async function actualizar(req, res) {
  const { sku } = req.params;
  const { es_herramienta, valor_adquisicion, fecha_adquisicion } = req.body;

  if (es_herramienta === undefined && valor_adquisicion === undefined && fecha_adquisicion === undefined) {
    return res.status(400).json({ error: 'No se envió ningún campo para actualizar' });
  }
  if (valor_adquisicion !== undefined && valor_adquisicion !== null) {
    const v = parseFloat(valor_adquisicion);
    if (isNaN(v) || v < 0) {
      return res.status(400).json({ error: 'El valor de adquisición debe ser un número mayor o igual a 0' });
    }
  }
  if (fecha_adquisicion !== undefined && fecha_adquisicion !== null && fecha_adquisicion !== '') {
    const f = new Date(fecha_adquisicion);
    if (isNaN(f.getTime())) {
      return res.status(400).json({ error: 'La fecha de adquisición no es válida' });
    }
    if (f > new Date()) {
      return res.status(400).json({ error: 'La fecha de adquisición no puede ser futura' });
    }
  }

  try {
    const { rows } = await query(
      `UPDATE material SET
         material_es_herramienta    = COALESCE($1, material_es_herramienta),
         material_valor_adquisicion = CASE WHEN $2::boolean THEN $3::numeric ELSE material_valor_adquisicion END,
         material_fecha_adquisicion = CASE WHEN $4::boolean THEN $5::date    ELSE material_fecha_adquisicion END
       WHERE material_sku ILIKE $6
       RETURNING material_sku AS sku, material_es_herramienta AS es_herramienta,
                 material_valor_adquisicion AS valor_adquisicion,
                 TO_CHAR(material_fecha_adquisicion, 'YYYY-MM-DD') AS fecha_adquisicion`,
      [
        es_herramienta != null ? Boolean(es_herramienta) : null,
        valor_adquisicion !== undefined,
        valor_adquisicion === null || valor_adquisicion === '' ? null : parseFloat(valor_adquisicion),
        fecha_adquisicion !== undefined,
        fecha_adquisicion === null || fecha_adquisicion === '' ? null : fecha_adquisicion,
        sku,
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Material no encontrado' });
    }

    await auditoria.registrar(req.user?.id, 'Actualizar herramienta',
      `SKU ${sku}: es_herramienta=${rows[0].es_herramienta}, valor=${rows[0].valor_adquisicion ?? '—'}, ` +
      `fecha=${rows[0].fecha_adquisicion ?? '—'}`);

    res.json({ message: 'Herramienta actualizada', herramienta: rows[0] });
  } catch (err) {
    console.error('Error actualizando herramienta:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/* ══════════════════════════════════════════════════════════════════════
   OPUS-13 (Req #5, completo) — Depreciacion, asignaciones y mantenimiento
   ══════════════════════════════════════════════════════════════════════ */

/** Valida que el SKU exista y sea herramienta. Devuelve la fila o null. */
async function cargarHerramienta(sku) {
  const { rows } = await query(
    `SELECT material_sku AS sku, material_nombre_material AS nombre,
            material_es_herramienta AS es_herramienta,
            material_valor_adquisicion AS valor_adquisicion,
            TO_CHAR(material_fecha_adquisicion, 'YYYY-MM-DD') AS fecha_adquisicion
     FROM material WHERE material_sku ILIKE $1`,
    [sku]
  );
  return rows[0] || null;
}

/**
 * GET /api/herramientas/:sku/depreciacion
 * Valor contable actual de una herramienta segun su configuracion.
 */
async function calcularDepreciacion(req, res) {
  const { sku } = req.params;
  try {
    const { rows } = await query(
      `SELECT m.material_sku AS sku, m.material_nombre_material AS nombre,
              m.material_valor_adquisicion AS valor_adquisicion,
              TO_CHAR(m.material_fecha_adquisicion, 'YYYY-MM-DD') AS fecha_adquisicion,
              d.depreciacion_id, d.metodo_depreciacion AS metodo,
              d.vida_util_meses, d.vida_util_usos, d.valor_residual,
              TO_CHAR(d.fecha_inicio_depreciacion, 'YYYY-MM-DD') AS fecha_inicio,
              d.observacion,
              ${SQL_MESES_DEPRECIADOS}   AS meses_transcurridos,
              COALESCE(usos.usos, 0)     AS usos_completados,
              ${SQL_DEPRECIACION_UNITARIA} AS depreciacion_unitaria,
              m.material_es_herramienta  AS es_herramienta
       FROM material m
       LEFT JOIN depreciacion_herramienta d ON d.material_sku = m.material_sku
       LEFT JOIN LATERAL (${LATERAL_USOS}) usos ON TRUE
       WHERE m.material_sku ILIKE $1`,
      [sku]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Material no encontrado' });
    const r = rows[0];

    const valorAdq = r.valor_adquisicion != null ? parseFloat(r.valor_adquisicion) : null;
    const acumulada = r.depreciacion_unitaria != null ? Math.round(parseFloat(r.depreciacion_unitaria) * 100) / 100 : null;

    res.json({
      sku: r.sku,
      nombre: r.nombre,
      es_herramienta: r.es_herramienta,
      configurada: r.depreciacion_id != null,
      valor_adquisicion: valorAdq,
      fecha_adquisicion: r.fecha_adquisicion,
      metodo: r.metodo,
      vida_util_meses: r.vida_util_meses,
      vida_util_usos: r.vida_util_usos,
      valor_residual: r.valor_residual != null ? parseFloat(r.valor_residual) : null,
      fecha_inicio: r.fecha_inicio,
      observacion: r.observacion,
      meses_transcurridos: parseInt(r.meses_transcurridos) || 0,
      usos_completados: parseInt(r.usos_completados) || 0,
      depreciacion_acumulada: acumulada,
      valor_actual: acumulada != null && valorAdq != null ? Math.round((valorAdq - acumulada) * 100) / 100 : null,
      // Sin config o sin valor de compra no hay nada que calcular: se dice, no se devuelve 0
      motivo_sin_calculo: r.depreciacion_id == null ? 'sin_configuracion'
                        : valorAdq == null ? 'sin_valor_adquisicion' : null,
    });
  } catch (err) {
    console.error('Error calculando depreciación:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * PUT /api/herramientas/:sku/depreciacion
 * Configura (o reconfigura) la depreciacion. Una fila por herramienta.
 * Body: { metodo, vida_util_meses?, vida_util_usos?, valor_residual?, fecha_inicio?, observacion? }
 */
async function configurarDepreciacion(req, res) {
  const { sku } = req.params;
  const { metodo, vida_util_meses, vida_util_usos, valor_residual, fecha_inicio, observacion } = req.body;

  const met = metodo || 'lineal';
  if (!['lineal', 'uso'].includes(met)) {
    return res.status(400).json({ error: "El método debe ser 'lineal' o 'uso'" });
  }
  const meses = vida_util_meses != null && vida_util_meses !== '' ? parseInt(vida_util_meses) : null;
  const usos  = vida_util_usos  != null && vida_util_usos  !== '' ? parseInt(vida_util_usos)  : null;

  if (met === 'lineal' && !(meses > 0)) {
    return res.status(400).json({ error: 'La depreciación lineal necesita una vida útil en meses mayor a 0' });
  }
  if (met === 'uso' && !(usos > 0)) {
    return res.status(400).json({ error: 'La depreciación por uso necesita una vida útil en usos mayor a 0' });
  }

  const residual = valor_residual != null && valor_residual !== '' ? parseFloat(valor_residual) : 0;
  if (isNaN(residual) || residual < 0) {
    return res.status(400).json({ error: 'El valor residual debe ser mayor o igual a 0' });
  }

  try {
    const herr = await cargarHerramienta(sku);
    if (!herr) return res.status(404).json({ error: 'Material no encontrado' });
    if (!herr.es_herramienta) {
      return res.status(400).json({ error: `${herr.nombre} no está marcado como herramienta.` });
    }
    if (herr.valor_adquisicion != null && residual > parseFloat(herr.valor_adquisicion)) {
      return res.status(400).json({
        error: `El valor residual (${residual}) no puede superar el valor de adquisición (${herr.valor_adquisicion}).`,
      });
    }

    // La fecha de inicio se resuelve en JS: usar $1 a la vez como valor de la
    // columna VARCHAR y dentro de un subquery hacía que Postgres dedujera tipos
    // inconsistentes para el mismo parámetro (42P08).
    const inicio = fecha_inicio || herr.fecha_adquisicion || new Date().toISOString().slice(0, 10);

    const { rows } = await query(
      `INSERT INTO depreciacion_herramienta
         (material_sku, metodo_depreciacion, vida_util_meses, vida_util_usos,
          valor_residual, fecha_inicio_depreciacion, observacion)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7)
       ON CONFLICT (material_sku) DO UPDATE SET
         metodo_depreciacion       = EXCLUDED.metodo_depreciacion,
         vida_util_meses           = EXCLUDED.vida_util_meses,
         vida_util_usos            = EXCLUDED.vida_util_usos,
         valor_residual            = EXCLUDED.valor_residual,
         fecha_inicio_depreciacion = EXCLUDED.fecha_inicio_depreciacion,
         observacion               = EXCLUDED.observacion
       RETURNING depreciacion_id, metodo_depreciacion AS metodo,
                 TO_CHAR(fecha_inicio_depreciacion, 'YYYY-MM-DD') AS fecha_inicio`,
      [herr.sku, met, met === 'lineal' ? meses : null, met === 'uso' ? usos : null,
       residual, inicio, observacion || null]
    );

    await auditoria.registrar(req.user?.id, 'Configurar depreciación de herramienta',
      `SKU ${herr.sku}: método ${met}, vida útil ${met === 'lineal' ? meses + ' meses' : usos + ' usos'}, residual ${residual}`);

    res.json({ message: 'Depreciación configurada', depreciacion: rows[0] });
  } catch (err) {
    console.error('Error configurando depreciación:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/herramientas/:sku/asignar
 * Entrega una herramienta a un empleado y/o a un area.
 * Body: { empleado_rut?, area_trabajo_id?, cantidad?, observacion? }
 */
async function asignar(req, res) {
  const { sku } = req.params;
  const { empleado_rut, area_trabajo_id, cantidad, observacion } = req.body;

  const cant = cantidad != null && cantidad !== '' ? parseInt(cantidad) : 1;
  if (isNaN(cant) || cant <= 0) {
    return res.status(400).json({ error: 'La cantidad debe ser un entero mayor a 0' });
  }
  if (!empleado_rut && !area_trabajo_id) {
    return res.status(400).json({ error: 'Indique a qué empleado o a qué área se asigna la herramienta' });
  }

  try {
    const herr = await cargarHerramienta(sku);
    if (!herr) return res.status(404).json({ error: 'Material no encontrado' });
    if (!herr.es_herramienta) {
      return res.status(400).json({ error: `${herr.nombre} no está marcado como herramienta.` });
    }

    let nombreEmpleado = null;
    if (empleado_rut) {
      const { rows: emp } = await query(
        `SELECT NULLIF(TRIM(CONCAT_WS(' ', empleado_nombre_empleado_primer_nombre_empleado,
                                           empleado_nombre_empleado_primer_apellido_empleado)), '') AS nombre
         FROM finanzas.empleado WHERE empleado_rut_empleado = $1`,
        [empleado_rut]
      );
      if (emp.length === 0) return res.status(404).json({ error: 'Empleado no encontrado' });
      nombreEmpleado = emp[0].nombre || 'Empleado sin nombre';   // D47: el RUT nunca se muestra
    }
    if (area_trabajo_id) {
      const { rows: area } = await query(
        `SELECT area_trabajo_id_area FROM area_trabajo WHERE area_trabajo_id_area = $1`,
        [area_trabajo_id]
      );
      if (area.length === 0) return res.status(404).json({ error: 'Área de trabajo no encontrada' });
    }

    // No se puede entregar mas de lo que hay fisicamente
    const { rows: disp } = await query(
      `SELECT COALESCE((SELECT SUM(inventario_bodega_cantidad_fisica)
                        FROM inventario_bodega WHERE material_sku = $1), 0) AS stock,
              COALESCE((SELECT SUM(cantidad) FROM asignacion_herramienta
                        WHERE material_sku = $1 AND estado = 'asignada'), 0) AS asignadas`,
      [herr.sku]
    );
    const libres = parseFloat(disp[0].stock) - parseFloat(disp[0].asignadas);
    if (cant > libres) {
      return res.status(400).json({
        error: `No hay unidades libres suficientes: ${libres} disponible(s) de ${disp[0].stock} en stock (${disp[0].asignadas} ya asignada(s)).`,
        stock: parseFloat(disp[0].stock),
        asignadas: parseFloat(disp[0].asignadas),
        libres,
      });
    }

    const { rows } = await query(
      `INSERT INTO asignacion_herramienta
         (material_sku, area_trabajo_id, empleado_rut, cantidad, observacion, usuario_id_usuario)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING asignacion_id AS id, fecha_asignacion`,
      [herr.sku, area_trabajo_id || null, empleado_rut || null, cant, observacion || null, req.user?.id || null]
    );

    await auditoria.registrar(req.user?.id, 'Asignar herramienta',
      `SKU ${herr.sku} x${cant} → ${nombreEmpleado ? 'empleado ' + nombreEmpleado : ''}${nombreEmpleado && area_trabajo_id ? ' / ' : ''}${area_trabajo_id ? 'área #' + area_trabajo_id : ''}`);

    res.status(201).json({ message: `Herramienta asignada (${cant} unidad(es))`, asignacion: rows[0] });
  } catch (err) {
    console.error('Error asignando herramienta:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * PUT /api/herramientas/asignaciones/:id/devolver
 * Cierra una asignacion. Body: { estado?, observacion? }
 * estado: 'devuelta' (default) | 'perdida' | 'dada_de_baja'
 */
async function devolverAsignacion(req, res) {
  const { id } = req.params;
  const estado = req.body?.estado || 'devuelta';
  const { observacion, bodega_id } = req.body || {};
  const evidencia = String(req.body?.evidencia_url ?? '').trim();

  if (!['devuelta', 'perdida', 'dada_de_baja'].includes(estado)) {
    return res.status(400).json({ error: "El estado debe ser 'devuelta', 'perdida' o 'dada_de_baja'" });
  }
  // D52: perdida y dada de baja SACAN la herramienta del inventario (salida por merma),
  // con evidencia como toda merma. Sin aprobación de gerencia (decisión del usuario).
  const descuenta = estado !== 'devuelta';
  if (descuenta) {
    if (!evidencia) return res.status(400).json({ error: 'Adjunte un enlace a la evidencia (foto o acta) de la pérdida o baja.' });
    if (!/^https?:\/\//i.test(evidencia)) {
      return res.status(400).json({ error: 'El enlace de evidencia debe ser una URL válida (debe comenzar con http:// o https://).' });
    }
  }

  try {
    const r = await conTransaccion(async (client) => {
      const { rows: previo } = await client.query(
        `SELECT estado, material_sku, cantidad FROM asignacion_herramienta WHERE asignacion_id = $1 FOR UPDATE`, [id]
      );
      if (previo.length === 0) throw new ErrorNegocio(404, { error: 'Asignación no encontrada' });
      if (previo[0].estado !== 'asignada') {
        throw new ErrorNegocio(400, { error: `Esta asignación ya está cerrada (${previo[0].estado}).` });
      }
      const { material_sku: sku } = previo[0];
      const cantidad = parseFloat(previo[0].cantidad);

      let movimientoId = null;
      if (descuenta) {
        const motivo = await motivoMovimientoId(client, estado === 'perdida' ? MOTIVO_PERDIDA : MOTIVO_BAJA);
        const tipoSalida = await tipoMovimientoId(client, 'salida');
        if (!motivo || !tipoSalida) {
          throw new ErrorNegocio(500, { error: 'Faltan los motivos de pérdida o baja de herramienta en el catálogo. Avise al administrador del sistema.' });
        }
        // La asignación no guarda la bodega: la informada, o la única con stock (si hay varias, se pide elegir)
        const bodega = await resolverBodega(client, sku, bodega_id);
        const { lotes } = await descontarFifo(client, sku, bodega, cantidad);
        movimientoId = await insertarMovimiento(client, {
          cantidad, sku, bodegaId: bodega, loteId: lotes[0]?.lote_id || null, usuarioId: req.user.id,
          tipoId: tipoSalida, motivoId: motivo, otId: null,
          descripcion: `Herramienta ${estado === 'perdida' ? 'perdida' : 'dada de baja'} (asignación #${id})` +
                       (observacion ? `: ${observacion}` : ''),
        });
        await client.query(
          `UPDATE movimiento_inventario SET movimiento_inventario_evidencia_url = $1, movimiento_inventario_referencia_origen = $2
           WHERE movimiento_inventario_id_movimiento = $3`, [evidencia, `ASIG-${id}`, movimientoId]
        );
      }

      const { rows } = await client.query(
        `UPDATE asignacion_herramienta
         SET estado = $1, fecha_devolucion = now(), observacion = COALESCE($2, observacion)
         WHERE asignacion_id = $3
         RETURNING asignacion_id AS id, estado, fecha_devolucion`,
        [estado, observacion || null, id]
      );
      return { asignacion: rows[0], previo: previo[0], movimientoId };
    });

    await auditoria.registrar(req.user?.id, 'Cerrar asignación de herramienta',
      `Asignación #${id} (${r.previo.material_sku} x${r.previo.cantidad}) → ${estado}` +
      (r.movimientoId ? ` · salida #${r.movimientoId}` : ''));
    if (r.movimientoId) generarAlertasAutomaticas().catch(e => console.warn('Alertas:', e.message));

    res.json({
      message: r.movimientoId
        ? `Asignación registrada como ${estado === 'perdida' ? 'perdida' : 'dada de baja'}: se descontaron ${r.previo.cantidad} unidad(es) del stock.`
        : `Asignación registrada como ${estado}`,
      asignacion: r.asignacion,
      movimiento_id: r.movimientoId,
    });
  } catch (err) {
    responderError(res, err, 'Error cerrando asignación:');
  }
}

/**
 * GET /api/herramientas/asignaciones?sku=&empleado_rut=&area_trabajo_id=&estado=
 * Por defecto lista solo las vigentes.
 */
async function listarAsignaciones(req, res) {
  const { sku, empleado_rut, area_trabajo_id, estado } = req.query;
  const filtroEstado = !estado || estado === 'todos' ? null : estado;

  try {
    const { rows } = await query(
      `SELECT a.asignacion_id AS id, a.material_sku AS sku,
              m.material_nombre_material AS herramienta,
              a.cantidad, a.estado,
              a.fecha_asignacion, a.fecha_devolucion, a.observacion,
              a.empleado_rut,
              NULLIF(TRIM(CONCAT_WS(' ',
                e.empleado_nombre_empleado_primer_nombre_empleado,
                e.empleado_nombre_empleado_primer_apellido_empleado)), '') AS empleado,
              a.area_trabajo_id AS area_id,
              at.area_trabajo_nombre_area AS area,
              u.usuario_username AS registrado_por
       FROM asignacion_herramienta a
       JOIN material m ON m.material_sku = a.material_sku
       LEFT JOIN finanzas.empleado e ON e.empleado_rut_empleado = a.empleado_rut
       LEFT JOIN area_trabajo at      ON at.area_trabajo_id_area = a.area_trabajo_id
       LEFT JOIN usuario u            ON u.usuario_id_usuario = a.usuario_id_usuario
       WHERE ($1::text   IS NULL OR a.material_sku ILIKE $1)
         AND ($2::text   IS NULL OR a.empleado_rut = $2)
         AND ($3::bigint IS NULL OR a.area_trabajo_id = $3::bigint)
         AND ($4::text   IS NULL OR a.estado = $4)
       ORDER BY a.estado = 'asignada' DESC, a.fecha_asignacion DESC`,
      [sku || null, empleado_rut || null, area_trabajo_id || null,
       filtroEstado === null && !estado ? 'asignada' : filtroEstado]
    );

    const asignaciones = rows.map(r => ({ ...r, cantidad: parseInt(r.cantidad) }));
    res.json({
      resumen: {
        total: asignaciones.length,
        vigentes: asignaciones.filter(a => a.estado === 'asignada').length,
        unidades_asignadas: asignaciones.filter(a => a.estado === 'asignada').reduce((s, a) => s + a.cantidad, 0),
        perdidas: asignaciones.filter(a => a.estado === 'perdida').length,
      },
      asignaciones,
    });
  } catch (err) {
    console.error('Error listando asignaciones:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/herramientas/:sku/mantenimiento
 * Body: { tipo, descripcion?, costo_mantenimiento?, proximo_mantenimiento?, fecha_mantenimiento? }
 */
async function registrarMantenimiento(req, res) {
  const { sku } = req.params;
  const { tipo, descripcion, costo_mantenimiento, proximo_mantenimiento, fecha_mantenimiento } = req.body;

  if (!['preventivo', 'correctivo', 'calibracion'].includes(tipo)) {
    return res.status(400).json({ error: "El tipo debe ser 'preventivo', 'correctivo' o 'calibracion'" });
  }
  let costo = null;
  if (costo_mantenimiento != null && costo_mantenimiento !== '') {
    costo = parseFloat(costo_mantenimiento);
    if (isNaN(costo) || costo < 0) {
      return res.status(400).json({ error: 'El costo debe ser un número mayor o igual a 0' });
    }
  }
  if (fecha_mantenimiento && isNaN(new Date(fecha_mantenimiento).getTime())) {
    return res.status(400).json({ error: 'La fecha de mantenimiento no es válida' });
  }
  if (proximo_mantenimiento && isNaN(new Date(proximo_mantenimiento).getTime())) {
    return res.status(400).json({ error: 'La fecha del próximo mantenimiento no es válida' });
  }

  try {
    const herr = await cargarHerramienta(sku);
    if (!herr) return res.status(404).json({ error: 'Material no encontrado' });
    if (!herr.es_herramienta) {
      return res.status(400).json({ error: `${herr.nombre} no está marcado como herramienta.` });
    }

    const { rows } = await query(
      `INSERT INTO mantenimiento_herramienta
         (material_sku, fecha_mantenimiento, tipo, descripcion, costo_mantenimiento,
          proximo_mantenimiento, usuario_id_usuario)
       VALUES ($1, COALESCE($2::timestamptz, now()), $3, $4, $5, $6, $7)
       RETURNING mantenimiento_id AS id, fecha_mantenimiento`,
      [herr.sku, fecha_mantenimiento || null, tipo, descripcion || null, costo,
       proximo_mantenimiento || null, req.user?.id || null]
    );

    await auditoria.registrar(req.user?.id, 'Registrar mantenimiento de herramienta',
      `SKU ${herr.sku}: ${tipo}${costo != null ? ', costo ' + costo : ''}${proximo_mantenimiento ? ', próximo ' + proximo_mantenimiento : ''}`);

    res.status(201).json({ message: 'Mantenimiento registrado', mantenimiento: rows[0] });
  } catch (err) {
    console.error('Error registrando mantenimiento:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/herramientas/mantenimientos?sku=&tipo=&vencidos=true
 */
async function listarMantenimientos(req, res) {
  const { sku, tipo } = req.query;
  const soloVencidos = String(req.query.vencidos || '').toLowerCase() === 'true';

  try {
    const { rows } = await query(
      `SELECT mh.mantenimiento_id AS id, mh.material_sku AS sku,
              m.material_nombre_material AS herramienta,
              mh.fecha_mantenimiento, mh.tipo, mh.descripcion,
              mh.costo_mantenimiento AS costo,
              TO_CHAR(mh.proximo_mantenimiento, 'YYYY-MM-DD') AS proximo_mantenimiento,
              (mh.proximo_mantenimiento IS NOT NULL AND mh.proximo_mantenimiento < CURRENT_DATE) AS vencido,
              u.usuario_username AS usuario
       FROM mantenimiento_herramienta mh
       JOIN material m ON m.material_sku = mh.material_sku
       LEFT JOIN usuario u ON u.usuario_id_usuario = mh.usuario_id_usuario
       WHERE ($1::text IS NULL OR mh.material_sku ILIKE $1)
         AND ($2::text IS NULL OR mh.tipo = $2)
         AND ($3::boolean IS NOT TRUE OR
              (mh.proximo_mantenimiento IS NOT NULL AND mh.proximo_mantenimiento < CURRENT_DATE))
       ORDER BY mh.fecha_mantenimiento DESC`,
      [sku || null, tipo || null, soloVencidos]
    );

    const mantenimientos = rows.map(r => ({
      ...r,
      costo: r.costo != null ? parseFloat(r.costo) : null,
    }));

    res.json({
      resumen: {
        total: mantenimientos.length,
        vencidos: mantenimientos.filter(m => m.vencido).length,
        costo_total: mantenimientos.reduce((s, m) => s + (m.costo || 0), 0),
      },
      mantenimientos,
    });
  } catch (err) {
    console.error('Error listando mantenimientos:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/herramientas/catalogo
 * Lo que necesitan los formularios de asignacion: empleados activos y areas.
 * D47: el RUT viaja solo como valor del selector; la pantalla muestra el nombre y, si
 * hay homónimos, el cargo.
 */
async function catalogo(req, res) {
  try {
    const [empleados, areas] = await Promise.all([
      query(
        `SELECT e.empleado_rut_empleado AS rut,
                NULLIF(TRIM(CONCAT_WS(' ',
                  e.empleado_nombre_empleado_primer_nombre_empleado,
                  e.empleado_nombre_empleado_primer_apellido_empleado)), '') AS nombre,
                c.empleado_cargo_nombre AS cargo
         FROM finanzas.empleado e
         LEFT JOIN finanzas.empleado_cargo c ON c.empleado_cargo_id_cargo = e.empleado_cargo_id_cargo
         WHERE e.empleado_estado = 'activo'
         ORDER BY e.empleado_nombre_empleado_primer_apellido_empleado`
      ),
      query(
        `SELECT area_trabajo_id_area AS id, area_trabajo_nombre_area AS nombre
         FROM area_trabajo WHERE area_trabajo_activo = TRUE
         ORDER BY area_trabajo_nombre_area`
      ),
    ]);
    res.json({ empleados: empleados.rows, areas: areas.rows });
  } catch (err) {
    console.error('Error obteniendo catálogo de herramientas:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/herramientas/reporte
 * Valorizacion contable: adquisicion, depreciacion acumulada y valor actual,
 * con el desglose por area segun donde este asignada cada unidad.
 */
async function reporteValorizacion(req, res) {
  if (!puedeVerValores(req)) {
    return res.status(403).json({ error: 'No tiene permisos para ver la valorización de herramientas' });
  }

  try {
    const { rows } = await query(
      `SELECT m.material_sku AS sku, m.material_nombre_material AS nombre,
              m.material_valor_adquisicion AS valor_adquisicion,
              COALESCE(stk.stock, 0) AS stock,
              d.depreciacion_id IS NOT NULL AS depreciacion_configurada,
              d.metodo_depreciacion AS metodo,
              ${SQL_DEPRECIACION_UNITARIA} AS depreciacion_unitaria
       FROM material m
       LEFT JOIN depreciacion_herramienta d ON d.material_sku = m.material_sku
       LEFT JOIN LATERAL (${LATERAL_USOS}) usos ON TRUE
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(ib.inventario_bodega_cantidad_fisica), 0) AS stock
         FROM inventario_bodega ib WHERE ib.material_sku = m.material_sku
       ) stk ON TRUE
       WHERE m.material_es_herramienta = TRUE AND m.material_estado = 'activo'
       ORDER BY m.material_nombre_material`
    );

    // Unidades asignadas por (herramienta, area) para repartir el valor
    const { rows: asigs } = await query(
      `SELECT a.material_sku AS sku, a.area_trabajo_id AS area_id,
              COALESCE(at.area_trabajo_nombre_area, 'Sin área') AS area,
              SUM(a.cantidad) AS unidades
       FROM asignacion_herramienta a
       LEFT JOIN area_trabajo at ON at.area_trabajo_id_area = a.area_trabajo_id
       WHERE a.estado = 'asignada'
       GROUP BY a.material_sku, a.area_trabajo_id, at.area_trabajo_nombre_area`
    );

    const herramientas = rows.map(r => {
      const stock = parseFloat(r.stock);
      const valorUnit = r.valor_adquisicion != null ? parseFloat(r.valor_adquisicion) : null;
      const depUnit = r.depreciacion_unitaria != null ? parseFloat(r.depreciacion_unitaria) : null;
      const actualUnit = valorUnit != null ? valorUnit - (depUnit || 0) : null;
      return {
        sku: r.sku,
        nombre: r.nombre,
        stock,
        valor_unitario: valorUnit,
        depreciacion_configurada: r.depreciacion_configurada,
        metodo: r.metodo,
        depreciacion_unitaria: depUnit != null ? Math.round(depUnit * 100) / 100 : null,
        valor_actual_unitario: actualUnit != null ? Math.round(actualUnit * 100) / 100 : null,
        valor_adquisicion_total: valorUnit != null ? Math.round(valorUnit * stock * 100) / 100 : 0,
        depreciacion_total: depUnit != null ? Math.round(depUnit * stock * 100) / 100 : 0,
        valor_actual_total: actualUnit != null ? Math.round(actualUnit * stock * 100) / 100 : 0,
      };
    });

    // Desglose por area: cada unidad asignada lleva su valor contable a esa area;
    // las unidades sin asignar quedan en "Sin asignar".
    const porArea = {};
    const sumar = (clave, area, unidades, h) => {
      if (!porArea[clave]) porArea[clave] = { area, unidades: 0, valor_adquisicion: 0, depreciacion: 0, valor_actual: 0 };
      porArea[clave].unidades += unidades;
      porArea[clave].valor_adquisicion += (h.valor_unitario || 0) * unidades;
      porArea[clave].depreciacion      += (h.depreciacion_unitaria || 0) * unidades;
      porArea[clave].valor_actual      += (h.valor_actual_unitario || 0) * unidades;
    };

    herramientas.forEach(h => {
      const deEsta = asigs.filter(a => a.sku === h.sku);
      let asignadas = 0;
      deEsta.forEach(a => {
        const u = parseInt(a.unidades);
        asignadas += u;
        sumar(a.area_id ?? 'sin_area', a.area, u, h);
      });
      const libres = Math.max(h.stock - asignadas, 0);
      if (libres > 0) sumar('sin_asignar', 'Sin asignar', libres, h);
    });

    const redondear = (n) => Math.round(n * 100) / 100;
    const areas = Object.values(porArea).map(a => ({
      area: a.area,
      unidades: a.unidades,
      valor_adquisicion: redondear(a.valor_adquisicion),
      depreciacion: redondear(a.depreciacion),
      valor_actual: redondear(a.valor_actual),
    })).sort((x, y) => y.valor_actual - x.valor_actual);

    res.json({
      resumen: {
        herramientas: herramientas.length,
        unidades: herramientas.reduce((s, h) => s + h.stock, 0),
        valor_adquisicion_total: redondear(herramientas.reduce((s, h) => s + h.valor_adquisicion_total, 0)),
        depreciacion_acumulada_total: redondear(herramientas.reduce((s, h) => s + h.depreciacion_total, 0)),
        valor_contable_total: redondear(herramientas.reduce((s, h) => s + h.valor_actual_total, 0)),
        // Sin estos dos datos la cifra de arriba es parcial, y hay que decirlo
        sin_valor: herramientas.filter(h => h.valor_unitario == null).length,
        sin_depreciacion: herramientas.filter(h => !h.depreciacion_configurada).length,
      },
      herramientas,
      areas,
    });
  } catch (err) {
    console.error('Error generando reporte de valorización:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = {
  listar, actualizar,
  // OPUS-13
  catalogo, calcularDepreciacion, configurarDepreciacion,
  asignar, devolverAsignacion, listarAsignaciones,
  registrarMantenimiento, listarMantenimientos,
  reporteValorizacion,
};
