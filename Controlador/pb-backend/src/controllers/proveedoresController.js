const { query, pool } = require('../db/pool');
const { ErrorNegocio, conTransaccion, responderError } = require('../db/tx');
const auditoria = require('./auditoriaController');
const { consultarEntregas, resumirEntregas } = require('../db/entregas');

/**
 * GET /api/proveedores
 * Lista proveedores con contacto principal y tiempo de entrega promedio
 */
async function listar(req, res) {
  const { buscar, estado } = req.query;
  try {
    const { rows } = await query(
      `SELECT
         p.proveedor_id_proveedor                           AS id,
         p.proveedor_razon_social                           AS nombre,
         p.proveedor_rubro                                  AS rubro,
         p.proveedor_tipo_proveedor                         AS tipo,
         p.proveedor_pais                                   AS pais,
         p.proveedor_estado                                 AS estado,
         p.proveedor_doc_identidad_rut_proveedor_opcional   AS rut,
         CONCAT_WS(' ',
           p.proveedor_contacto_primer_nombre,
           p.proveedor_contacto_primer_apellido)            AS contacto,
         -- Primer teléfono
         (SELECT pct.proveedor_contacto_telefono
          FROM proveedor_contacto_telefono pct
          WHERE pct.proveedor_id_proveedor = p.proveedor_id_proveedor
          LIMIT 1)                                          AS telefono,
         -- Primer correo
         (SELECT pcc.proveedor_contacto_correo
          FROM proveedor_contacto_correo pcc
          WHERE pcc.proveedor_id_proveedor = p.proveedor_id_proveedor
          LIMIT 1)                                          AS correo,
         -- Tiempo de reposición promedio entre todos sus materiales (FR-41)
         ROUND(AVG(mp.material_proveedor_tiempo_reposicion), 1) AS tiempo_entrega_promedio,
         COUNT(DISTINCT mp.material_sku)                    AS total_materiales
       FROM proveedor p
       LEFT JOIN material_proveedor mp ON mp.proveedor_id_proveedor = p.proveedor_id_proveedor
       WHERE ($1::text IS NULL OR
              p.proveedor_razon_social ILIKE '%' || $1 || '%' OR
              p.proveedor_doc_identidad_rut_proveedor_opcional ILIKE '%' || $1 || '%' OR
              p.proveedor_rubro ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR p.proveedor_estado = $2)
       GROUP BY p.proveedor_id_proveedor
       ORDER BY p.proveedor_razon_social`,
      [buscar || null, estado || null]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listando proveedores:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/proveedores/:id
 * Detalle de proveedor con materiales y tiempos de entrega
 */
async function obtener(req, res) {
  const { id } = req.params;
  try {
    // Datos del proveedor
    const { rows: prov } = await query(
      `SELECT
         proveedor_id_proveedor                            AS id,
         proveedor_razon_social                            AS nombre,
         proveedor_rubro                                   AS rubro,
         proveedor_tipo_proveedor                          AS tipo,
         proveedor_pais                                    AS pais,
         proveedor_estado                                  AS estado,
         proveedor_doc_identidad_rut_proveedor_opcional    AS rut,
         proveedor_doc_identidad_tipo_identificador        AS tipo_identificador,
         proveedor_doc_identidad_numero_identificador      AS numero_identificador,
         proveedor_contacto_primer_nombre                  AS contacto_nombre,
         proveedor_contacto_primer_apellido                AS contacto_apellido
       FROM proveedor WHERE proveedor_id_proveedor = $1`,
      [id]
    );

    if (prov.length === 0) {
      return res.status(404).json({ error: 'Proveedor no encontrado' });
    }

    // Teléfonos
    const { rows: telefonos } = await query(
      `SELECT proveedor_contacto_telefono AS telefono
       FROM proveedor_contacto_telefono
       WHERE proveedor_id_proveedor = $1`, [id]
    );

    // Correos
    const { rows: correos } = await query(
      `SELECT proveedor_contacto_correo AS correo
       FROM proveedor_contacto_correo
       WHERE proveedor_id_proveedor = $1`, [id]
    );

    // Materiales que provee con tiempos de entrega (FR-41)
    const { rows: materiales } = await query(
      `SELECT
         m.material_sku                                  AS sku,
         m.material_nombre_material                      AS nombre,
         mp.material_proveedor_tiempo_reposicion         AS tiempo_reposicion,
         mp.material_proveedor_precio_referencial        AS precio_referencial,
         mp.material_proveedor_proveedor_principal       AS es_principal
       FROM material_proveedor mp
       JOIN material m ON m.material_sku = mp.material_sku
       WHERE mp.proveedor_id_proveedor = $1
       ORDER BY mp.material_proveedor_proveedor_principal DESC, m.material_nombre_material`,
      [id]
    );

    const esGerencia = req.user?.rol === 'gerencia';

    // FR-59: ocultar precio referencial para usuarios no gerencia
    const materialesFiltrados = materiales.map(m => {
      if (!esGerencia) {
        const { precio_referencial, ...sinPrecio } = m;
        return sinPrecio;
      }
      return m;
    });

    res.json({
      ...prov[0],
      telefonos: telefonos.map(t => t.telefono),
      correos:   correos.map(c => c.correo),
      materiales: materialesFiltrados
    });
  } catch (err) {
    console.error('Error obteniendo proveedor:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/proveedores
 * Crear nuevo proveedor (FR-22)
 */
async function crear(req, res) {
  const {
    nombre, rubro, tipo, pais, estado,
    rut, tipo_identificador, numero_identificador,
    contacto_nombre, contacto_apellido,
    telefonos = [], correos = []
  } = req.body;

  if (!nombre) {
    return res.status(400).json({ error: 'La razón social es requerida' });
  }

  try {
    // Verificar RUT único si se proporciona
    if (rut) {
      const { rows: rutExist } = await query(
        `SELECT proveedor_id_proveedor FROM proveedor
         WHERE proveedor_doc_identidad_rut_proveedor_opcional = $1`, [rut]
      );
      if (rutExist.length > 0) {
        return res.status(409).json({ error: 'El RUT ya está registrado en otro proveedor' });
      }
    }

    // Insertar proveedor
    const { rows } = await query(
      `INSERT INTO proveedor (
         proveedor_razon_social, proveedor_rubro, proveedor_tipo_proveedor,
         proveedor_pais, proveedor_estado,
         proveedor_doc_identidad_rut_proveedor_opcional,
         proveedor_doc_identidad_tipo_identificador,
         proveedor_doc_identidad_numero_identificador,
         proveedor_contacto_primer_nombre, proveedor_contacto_primer_apellido
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING proveedor_id_proveedor AS id`,
      [
        nombre, rubro || null, tipo || null, pais || null, estado || 'activo',
        rut || null, tipo_identificador || null, numero_identificador || null,
        contacto_nombre || null, contacto_apellido || null
      ]
    );

    const proveedorId = rows[0].id;

    // Insertar teléfonos
    for (const tel of telefonos) {
      if (tel?.trim()) {
        await query(
          `INSERT INTO proveedor_contacto_telefono VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [proveedorId, tel.trim()]
        );
      }
    }

    // Insertar correos
    for (const correo of correos) {
      if (correo?.trim()) {
        await query(
          `INSERT INTO proveedor_contacto_correo VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [proveedorId, correo.trim()]
        );
      }
    }

    await auditoria.registrar(req.user?.id, 'crear_proveedor', `Proveedor "${nombre}" (ID ${proveedorId})`);
    res.status(201).json({ message: 'Proveedor creado correctamente', id: proveedorId });
  } catch (err) {
    console.error('Error creando proveedor:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * PUT /api/proveedores/:id
 * Actualizar proveedor
 */
async function actualizar(req, res) {
  const { id } = req.params;
  const {
    nombre, rubro, tipo, pais, estado,
    rut, contacto_nombre, contacto_apellido,
    telefonos, correos
  } = req.body;

  try {
    // Los teléfonos y correos se reemplazan con DELETE + INSERT. Sin transacción,
    // un fallo entre el DELETE y los INSERT dejaba al proveedor SIN datos de
    // contacto y sin forma de recuperarlos.
    await conTransaccion(async (client) => {
      // Un campo OMITIDO se conserva; uno enviado vacio o null se limpia a proposito.
      // Antes rubro/tipo/pais/rut/contacto se asignaban directo, asi que cualquier
      // actualizacion parcial los BORRABA en silencio — el modal de edicion no manda
      // tipo, pais ni apellido, de modo que cada edicion desde la UI los perdia.
      const presente = (v) => v !== undefined;
      const limpio   = (v) => (v === undefined || v === null || v === '' ? null : v);

      const { rowCount } = await client.query(
        `UPDATE proveedor SET
           proveedor_razon_social                          = COALESCE($1, proveedor_razon_social),
           proveedor_rubro                                 = CASE WHEN $2::boolean  THEN $3  ELSE proveedor_rubro END,
           proveedor_tipo_proveedor                        = CASE WHEN $4::boolean  THEN $5  ELSE proveedor_tipo_proveedor END,
           proveedor_pais                                  = CASE WHEN $6::boolean  THEN $7  ELSE proveedor_pais END,
           proveedor_estado                                = COALESCE($8, proveedor_estado),
           proveedor_doc_identidad_rut_proveedor_opcional  = CASE WHEN $9::boolean  THEN $10 ELSE proveedor_doc_identidad_rut_proveedor_opcional END,
           proveedor_contacto_primer_nombre                = CASE WHEN $11::boolean THEN $12 ELSE proveedor_contacto_primer_nombre END,
           proveedor_contacto_primer_apellido              = CASE WHEN $13::boolean THEN $14 ELSE proveedor_contacto_primer_apellido END
         WHERE proveedor_id_proveedor = $15`,
        [nombre || null,
         presente(rubro),             limpio(rubro),
         presente(tipo),              limpio(tipo),
         presente(pais),              limpio(pais),
         estado || null,
         presente(rut),               limpio(rut),
         presente(contacto_nombre),   limpio(contacto_nombre),
         presente(contacto_apellido), limpio(contacto_apellido),
         id]
      );

      if (rowCount === 0) {
        throw new ErrorNegocio(404, { error: 'Proveedor no encontrado' });
      }

      // Actualizar teléfonos si se envían
      if (Array.isArray(telefonos)) {
        await client.query(`DELETE FROM proveedor_contacto_telefono WHERE proveedor_id_proveedor = $1`, [id]);
        for (const tel of telefonos) {
          if (tel?.trim()) {
            await client.query(
              `INSERT INTO proveedor_contacto_telefono VALUES ($1, $2) ON CONFLICT DO NOTHING`,
              [id, tel.trim()]
            );
          }
        }
      }

      // Actualizar correos si se envían
      if (Array.isArray(correos)) {
        await client.query(`DELETE FROM proveedor_contacto_correo WHERE proveedor_id_proveedor = $1`, [id]);
        for (const correo of correos) {
          if (correo?.trim()) {
            await client.query(
              `INSERT INTO proveedor_contacto_correo VALUES ($1, $2) ON CONFLICT DO NOTHING`,
              [id, correo.trim()]
            );
          }
        }
      }
    });

    await auditoria.registrar(req.user?.id, 'editar_proveedor', `Proveedor ID ${id}`);
    res.json({ message: 'Proveedor actualizado correctamente' });
  } catch (err) {
    responderError(res, err, 'Error actualizando proveedor:');
  }
}

/**
 * PUT /api/proveedores/:id/estado
 * Activar o desactivar un proveedor. Existe aparte de `actualizar` a proposito:
 * cambiar el estado no debe arrastrar el resto de los campos del formulario.
 *
 * Sin esto, un proveedor que `eliminar` desactivaba por tener materiales, facturas
 * o lotes asociados quedaba inactivo PARA SIEMPRE: no habia forma de reactivarlo.
 * Body: { estado: 'activo' | 'inactivo' }
 */
const ESTADOS_PROVEEDOR = ['activo', 'inactivo'];

async function cambiarEstado(req, res) {
  const { id } = req.params;
  const estado = String(req.body?.estado || '').trim().toLowerCase();

  if (!ESTADOS_PROVEEDOR.includes(estado)) {
    return res.status(400).json({
      error: `El estado debe ser ${ESTADOS_PROVEEDOR.map(e => `'${e}'`).join(' o ')}`,
    });
  }

  try {
    const { rows } = await query(
      `UPDATE proveedor SET proveedor_estado = $1
       WHERE proveedor_id_proveedor = $2
       RETURNING proveedor_razon_social AS nombre, proveedor_estado AS estado`,
      [estado, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Proveedor no encontrado' });
    }

    await auditoria.registrar(req.user?.id,
      estado === 'activo' ? 'activar_proveedor' : 'desactivar_proveedor',
      `Proveedor "${rows[0].nombre}" (ID ${id}) marcado como ${estado}`);

    res.json({
      message: `Proveedor "${rows[0].nombre}" ${estado === 'activo' ? 'activado' : 'desactivado'}.`,
      id: parseInt(id),
      estado: rows[0].estado,
    });
  } catch (err) {
    console.error('Error cambiando el estado del proveedor:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * DELETE /api/proveedores/:id
 * Eliminar proveedor (SONNET-4). Si tiene materiales, facturas o lotes asociados,
 * se desactiva en lugar de eliminar físicamente (mismo patrón que materialesController.eliminar).
 */
async function eliminar(req, res) {
  const { id } = req.params;
  try {
    const { rows: prov } = await query(
      `SELECT proveedor_razon_social FROM proveedor WHERE proveedor_id_proveedor = $1`, [id]
    );
    if (prov.length === 0) {
      return res.status(404).json({ error: 'Proveedor no encontrado' });
    }

    const { rows: assoc } = await query(
      `SELECT
         (SELECT COUNT(*) FROM material_proveedor WHERE proveedor_id_proveedor = $1) AS materiales,
         (SELECT COUNT(*) FROM factura_compra     WHERE proveedor_id_proveedor = $1) AS facturas,
         (SELECT COUNT(*) FROM lote               WHERE proveedor_id_proveedor = $1) AS lotes`,
      [id]
    );
    const a = assoc[0];
    const tieneAsociaciones = parseInt(a.materiales, 10) > 0 || parseInt(a.facturas, 10) > 0 || parseInt(a.lotes, 10) > 0;

    if (tieneAsociaciones) {
      await query(`UPDATE proveedor SET proveedor_estado = 'inactivo' WHERE proveedor_id_proveedor = $1`, [id]);
      await auditoria.registrar(req.user?.id, 'desactivar_proveedor', `Proveedor "${prov[0].proveedor_razon_social}" (ID ${id}) desactivado (tenía materiales, facturas o lotes asociados)`);
      return res.json({
        eliminado: false,
        desactivado: true,
        message: 'El proveedor tiene materiales, facturas o lotes asociados. Fue desactivado en lugar de eliminado.'
      });
    }

    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${process.env.DB_SCHEMA || 'inventario'}`);
      await client.query('BEGIN');
      await client.query(`DELETE FROM proveedor_contacto_telefono WHERE proveedor_id_proveedor = $1`, [id]);
      await client.query(`DELETE FROM proveedor_contacto_correo WHERE proveedor_id_proveedor = $1`, [id]);
      await client.query(`DELETE FROM proveedor WHERE proveedor_id_proveedor = $1`, [id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    await auditoria.registrar(req.user?.id, 'eliminar_proveedor', `Proveedor "${prov[0].proveedor_razon_social}" (ID ${id}) eliminado permanentemente`);
    return res.json({ eliminado: true, desactivado: false, message: 'Proveedor eliminado correctamente.' });
  } catch (err) {
    console.error('Error eliminando proveedor:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/proveedores/:id/precios   (solo gerencia)
 * CU-61: historial de precios de un proveedor, en orden cronologico (del mas
 * antiguo al mas reciente). Query params: ?desde=&hasta=&sku=
 *
 * Responde { precios, productos, total_proveedor }. total_proveedor es el total
 * SIN filtros: distingue "el proveedor no tiene historial" (Exc 1) de "el filtro
 * no trae datos" (Exc 2).
 */
async function precios(req, res) {
  const id = parseInt(req.params.id);
  const { desde, hasta, sku } = req.query;

  if (!id) return res.status(400).json({ error: 'Proveedor inválido.' });
  if ((desde && !FECHA_ISO.test(desde)) || (hasta && !FECHA_ISO.test(hasta))) {
    return res.status(400).json({ error: 'Las fechas deben tener el formato AAAA-MM-DD.' });
  }
  if (desde && hasta && desde > hasta) {
    return res.status(400).json({ error: 'La fecha de inicio es posterior a la fecha de fin. Corrija el rango.' });
  }

  try {
    const { rows: prov } = await query(
      `SELECT 1 FROM proveedor WHERE proveedor_id_proveedor = $1`, [id]
    );
    if (prov.length === 0) return res.status(404).json({ error: 'Proveedor no encontrado' });

    // CU-64: la variacion se calcula sobre el historial COMPLETO del proveedor y
    // despues se filtra, para que el primer registro de un rango de fechas se compare
    // igual con su precio anterior aunque ese precio quede fuera del rango.
    const { rows } = await query(
      `WITH h AS (
         SELECT hpm.*,
                LAG(hpm.precio_unitario) OVER (PARTITION BY hpm.material_sku
                  ORDER BY hpm.fecha_vigencia_desde, hpm.historial_precio_id) AS precio_anterior,
                COUNT(*) OVER (PARTITION BY hpm.material_sku)::int              AS registros_producto
         FROM historial_precio_material hpm
         WHERE hpm.proveedor_id_proveedor = $1
       )
       SELECT
         h.historial_precio_id                AS id,
         h.fecha_vigencia_desde               AS fecha,
         h.fecha_vigencia_hasta               AS fecha_hasta,
         h.material_sku                       AS sku,
         m.material_nombre_material           AS material,
         h.precio_unitario                    AS precio_unitario,
         h.precio_anterior                    AS precio_anterior,
         h.precio_unitario - h.precio_anterior AS variacion_abs,
         CASE WHEN h.precio_anterior > 0
              THEN round((h.precio_unitario - h.precio_anterior) / h.precio_anterior * 100, 2) END AS variacion_pct,
         h.registros_producto                 AS registros_producto,
         h.moneda                             AS moneda,
         h.fuente                             AS fuente,
         fc.factura_compra_numero_factura     AS factura,
         u.usuario_username                   AS usuario
       FROM h
       JOIN material m ON m.material_sku = h.material_sku
       LEFT JOIN factura_compra fc ON fc.factura_compra_id_factura = h.factura_compra_id
       LEFT JOIN usuario u ON u.usuario_id_usuario = h.usuario_id_usuario
       WHERE ($2::date IS NULL OR h.fecha_vigencia_desde >= $2::date)
         AND ($3::date IS NULL OR h.fecha_vigencia_desde <= $3::date)
         AND ($4::text IS NULL OR h.material_sku = $4)
       ORDER BY h.fecha_vigencia_desde ASC, h.historial_precio_id ASC`,
      [id, desde || null, hasta || null, sku || null]
    );

    // Productos con historial para este proveedor (filtro "producto" de la vista)
    const { rows: productos } = await query(
      `SELECT DISTINCT hpm.material_sku AS sku, m.material_nombre_material AS nombre
       FROM historial_precio_material hpm
       JOIN material m ON m.material_sku = hpm.material_sku
       WHERE hpm.proveedor_id_proveedor = $1
       ORDER BY m.material_nombre_material`,
      [id]
    );
    const { rows: total } = await query(
      `SELECT count(*)::int AS n FROM historial_precio_material WHERE proveedor_id_proveedor = $1`, [id]
    );

    res.json({ precios: rows, productos, total_proveedor: total[0].n });
  } catch (err) {
    console.error('Error obteniendo historial de precios del proveedor:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/proveedores/:id/cumplimiento — CU-62.
 * Plazo real de entrega del proveedor (días hábiles entre pedido y recepción de
 * cada lote) contra el plazo prometido, con promedio, mediana, mínimo, máximo y %
 * de cumplimiento. Exc 1: sin entregas recibidas → resumen.disponible = false.
 * Exc 2: los pedidos sin recepción se cuentan aparte. Sin montos.
 */
async function cumplimiento(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ error: 'Proveedor no encontrado' });
  }
  try {
    const { rowCount } = await query(`SELECT 1 FROM proveedor WHERE proveedor_id_proveedor = $1`, [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Proveedor no encontrado' });

    const entregas = await consultarEntregas({ proveedorId: id });
    res.json({ proveedor_id: id, resumen: resumirEntregas(entregas), entregas });
  } catch (err) {
    console.error('Error calculando cumplimiento del proveedor:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/proveedores/metricas?proveedor_id=&desde=&hasta= — CU-63.
 * Métricas comparativas de cumplimiento por proveedor, sobre la misma consulta
 * base de CU-62. "Pedidos completados" = entregas CON recepción; el rango de
 * fechas se aplica a la recepción y las pendientes no entran a los indicadores.
 * `total_sistema` (entregas recibidas sin filtros) separa la Exc 1 (no hay
 * ninguna) de la Exc 2 (el período no tiene datos). `sin_datos` = proveedores
 * activos sin entregas en el período. Sin montos: lo ven todos los roles.
 */
async function metricas(req, res) {
  const proveedorId = req.query.proveedor_id ? Number(req.query.proveedor_id) : null;
  const desde = req.query.desde || null;
  const hasta = req.query.hasta || null;

  if (proveedorId !== null && (!Number.isInteger(proveedorId) || proveedorId <= 0)) {
    return res.status(400).json({ error: 'Proveedor inválido.' });
  }
  if ((desde && !FECHA_ISO.test(desde)) || (hasta && !FECHA_ISO.test(hasta))) {
    return res.status(400).json({ error: 'Las fechas deben tener el formato AAAA-MM-DD.' });
  }
  if (desde && hasta && desde > hasta) {
    return res.status(400).json({ error: 'La fecha de inicio es posterior a la fecha de fin. Corrija el rango.' });
  }

  try {
    const recibidas = (await consultarEntregas({ proveedorId, desde, hasta })).filter(e => e.fecha_recepcion != null);
    const totalSistema = (await consultarEntregas({})).filter(e => e.fecha_recepcion != null).length;

    const porProveedor = new Map();
    for (const e of recibidas) {
      const clave = String(e.proveedor_id);
      if (!porProveedor.has(clave)) porProveedor.set(clave, { proveedor_id: e.proveedor_id, proveedor: e.proveedor, entregas: [] });
      porProveedor.get(clave).entregas.push(e);
    }
    const proveedores = [...porProveedor.values()]
      .map(p => ({ proveedor_id: p.proveedor_id, proveedor: p.proveedor, ...resumirEntregas(p.entregas) }))
      .sort((a, b) => (b.cumplimiento_pct ?? -1) - (a.cumplimiento_pct ?? -1) || a.promedio_dias - b.promedio_dias);

    // Proveedores activos (o el filtrado) sin entregas en el período
    const { rows: activos } = await query(
      `SELECT count(*)::int AS n FROM proveedor
       WHERE proveedor_estado = 'activo' AND ($1::bigint IS NULL OR proveedor_id_proveedor = $1::bigint)`,
      [proveedorId]
    );
    const sinDatos = Math.max(activos[0].n - proveedores.filter(p => p.proveedor_id != null).length, 0);

    res.json({ global: resumirEntregas(recibidas), proveedores, sin_datos: sinDatos, total_sistema: totalSistema });
  } catch (err) {
    console.error('Error calculando métricas de proveedores:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = { listar, obtener, crear, actualizar, cambiarEstado, eliminar, precios, cumplimiento, metricas };
