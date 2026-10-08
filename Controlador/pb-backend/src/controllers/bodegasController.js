const { query, pool } = require('../db/pool');
const auditoria = require('./auditoriaController');

/**
 * GET /api/bodegas
 * Lista todas las bodegas con stock total consolidado
 */
async function listar(req, res) {
  try {
    const { rows } = await query(
      `SELECT
         b.bodega_id_bodega                                  AS id,
         b.bodega_nombre_bodega                              AS nombre,
         b.bodega_direccion                                  AS direccion,
         b.bodega_estado                                     AS estado,
         COUNT(DISTINCT ib.material_sku)                     AS total_skus,
         COALESCE(SUM(ib.inventario_bodega_cantidad_fisica), 0) AS total_unidades
       FROM bodega b
       LEFT JOIN inventario_bodega ib ON ib.bodega_id_bodega = b.bodega_id_bodega
       GROUP BY b.bodega_id_bodega, b.bodega_nombre_bodega, b.bodega_direccion, b.bodega_estado
       ORDER BY b.bodega_nombre_bodega`
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listando bodegas:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/bodegas/:id
 * Detalle de bodega con stock de todos sus materiales
 */
async function obtener(req, res) {
  const { id } = req.params;
  try {
    // Datos de la bodega
    const { rows: bod } = await query(
      `SELECT
         bodega_id_bodega    AS id,
         bodega_nombre_bodega AS nombre,
         bodega_direccion    AS direccion,
         bodega_estado       AS estado
       FROM bodega
       WHERE bodega_id_bodega = $1`,
      [id]
    );

    if (bod.length === 0) {
      return res.status(404).json({ error: 'Bodega no encontrada' });
    }

    // Stock de materiales en esta bodega
    const { rows: stock } = await query(
      `SELECT
         m.material_sku                                       AS sku,
         m.material_nombre_material                           AS nombre,
         m.material_estado                                    AS estado_material,
         m.material_stock_minimo                              AS stock_minimo,
         m.material_stock_critico                             AS stock_critico,
         u.material_unidad_medida_nombre                      AS unidad_medida,
         SUM(ib.inventario_bodega_cantidad_fisica)            AS cantidad_fisica,
         SUM(ib.inventario_bodega_cantidad_reservada)         AS cantidad_reservada
       FROM inventario_bodega ib
       JOIN material m ON m.material_sku = ib.material_sku
       LEFT JOIN material_unidad_medida u
              ON u.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
       WHERE ib.bodega_id_bodega = $1
       GROUP BY m.material_sku, m.material_nombre_material, m.material_estado,
                m.material_stock_minimo, m.material_stock_critico,
                u.material_unidad_medida_nombre
       ORDER BY m.material_nombre_material`,
      [id]
    );

    // Anaqueles de la bodega, con los productos que hay en cada uno (OPUS-5)
    const { rows: anaqueles } = await query(
      `SELECT a.anaquel_id_anaquel  AS id,
              a.anaquel_descripcion AS descripcion,
              COALESCE(prod.productos, '[]'::json) AS productos
       FROM anaquel a
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
                  'sku',      x.sku,
                  'nombre',   x.nombre,
                  'cantidad', x.cantidad,
                  'unidad',   x.unidad
                ) ORDER BY x.nombre) AS productos
         FROM (
           SELECT ib.material_sku                            AS sku,
                  m.material_nombre_material                 AS nombre,
                  SUM(ib.inventario_bodega_cantidad_fisica)  AS cantidad,
                  u.material_unidad_medida_nombre            AS unidad
           FROM inventario_bodega ib
           JOIN material m ON m.material_sku = ib.material_sku
           LEFT JOIN material_unidad_medida u
                  ON u.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
           WHERE ib.anaquel_id_anaquel = a.anaquel_id_anaquel
           GROUP BY ib.material_sku, m.material_nombre_material, u.material_unidad_medida_nombre
         ) x
       ) prod ON TRUE
       WHERE a.bodega_id_bodega = $1
       ORDER BY a.anaquel_id_anaquel`,
      [id]
    );

    // OPUS-5: stock de la bodega que todavia no tiene anaquel asignado
    const { rows: sinAnaquel } = await query(
      `SELECT COUNT(DISTINCT ib.material_sku) AS materiales,
              COALESCE(SUM(ib.inventario_bodega_cantidad_fisica), 0) AS cantidad
       FROM inventario_bodega ib
       WHERE ib.bodega_id_bodega = $1 AND ib.anaquel_id_anaquel IS NULL
         AND ib.inventario_bodega_cantidad_fisica > 0`,
      [id]
    );

    res.json({
      ...bod[0],
      materiales: stock,
      anaqueles,
      sin_anaquel: {
        materiales: parseInt(sinAnaquel[0]?.materiales || 0),
        cantidad: parseFloat(sinAnaquel[0]?.cantidad || 0)
      }
    });
  } catch (err) {
    console.error('Error obteniendo bodega:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/bodegas
 * Crear nueva bodega
 */
async function crear(req, res) {
  const { nombre, codigo, direccion, estado } = req.body;

  if (!nombre) {
    return res.status(400).json({ error: 'El nombre de la bodega es requerido' });
  }
  if (!codigo) {
    return res.status(400).json({ error: 'El código de la bodega es requerido' });
  }

  try {
    // Verificar duplicado por nombre
    const { rows: dupNombre } = await query(
      `SELECT bodega_id_bodega FROM bodega WHERE bodega_nombre_bodega ILIKE $1`,
      [nombre]
    );
    if (dupNombre.length > 0) {
      return res.status(409).json({ error: 'Ya existe una bodega con ese nombre' });
    }

    // Verificar duplicado por código
    if (codigo) {
      const { rows: dupCodigo } = await query(
        `SELECT bodega_id_bodega FROM bodega WHERE bodega_codigo ILIKE $1`,
        [codigo]
      );
      if (dupCodigo.length > 0) {
        return res.status(409).json({ error: 'Ya existe una bodega con ese código' });
      }
    }

    // Antes, estas dos consultas iban envueltas en try/catch "por si la columna
    // bodega_codigo todavía no existía". Existe desde hace rato y está en el DDL,
    // así que ese respaldo solo servía para ocultar errores reales.
    const { rows } = await query(
      `INSERT INTO bodega (bodega_nombre_bodega, bodega_codigo, bodega_direccion, bodega_estado)
       VALUES ($1, $2, $3, $4)
       RETURNING bodega_id_bodega AS id`,
      [nombre, codigo || null, direccion || null, estado || 'activa']
    );
    await auditoria.registrar(req.user?.id, 'Crear bodega', `Bodega "${nombre}" creada (ID: ${rows[0].id}, código: ${codigo || '—'})`);
    res.status(201).json({ message: 'Bodega creada correctamente', id: rows[0].id });
  } catch (err) {
    console.error('Error creando bodega:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * PUT /api/bodegas/:id
 * Actualizar bodega (CU-XX UR 2.1: editar + desactivar)
 */
async function actualizar(req, res) {
  const { id } = req.params;
  const { nombre, direccion, estado } = req.body;

  try {
    // CU desactivar bodega: verificar stock antes de desactivar
    if (estado && ['inactiva', 'desactivada'].includes(estado.toLowerCase())) {
      const { rows: stockCheck } = await query(
        `SELECT COALESCE(SUM(inventario_bodega_cantidad_fisica), 0) AS total
         FROM inventario_bodega WHERE bodega_id_bodega = $1`,
        [id]
      );
      if (parseFloat(stockCheck[0]?.total || 0) > 0) {
        return res.status(400).json({
          error: 'La bodega tiene stock asignado. Debe trasladar el inventario antes de desactivarla.'
        });
      }
    }

    // CU editar bodega Exc 1: campos obligatorios
    if (nombre !== undefined && !nombre?.trim()) {
      return res.status(400).json({ error: 'El nombre de la bodega no puede quedar vacío' });
    }

    const { rowCount } = await query(
      `UPDATE bodega SET
         bodega_nombre_bodega = COALESCE($1, bodega_nombre_bodega),
         bodega_direccion     = $2,
         bodega_estado        = COALESCE($3, bodega_estado)
       WHERE bodega_id_bodega = $4`,
      [nombre || null, direccion || null, estado || null, id]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Bodega no encontrada' });
    }
    const campos = [nombre ? 'nombre' : null, direccion !== undefined ? 'dirección' : null, estado ? 'estado' : null].filter(Boolean).join(', ');
    await auditoria.registrar(req.user?.id, 'Editar bodega', `Bodega ID ${id} actualizada (${campos})`);
    res.json({ message: 'Bodega actualizada correctamente' });
  } catch (err) {
    console.error('Error actualizando bodega:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/bodegas/:id/stock-consolidado
 * Stock consolidado de la bodega (FR-16, FR-17)
 */
async function stockConsolidado(req, res) {
  const { id } = req.params;
  try {
    const { rows } = await query(
      `SELECT
         m.material_sku                                         AS sku,
         m.material_nombre_material                             AS nombre,
         u.material_unidad_medida_nombre                        AS unidad,
         SUM(ib.inventario_bodega_cantidad_fisica)              AS stock_fisico,
         SUM(ib.inventario_bodega_cantidad_reservada)           AS stock_reservado,
         SUM(ib.inventario_bodega_cantidad_fisica)
           - SUM(ib.inventario_bodega_cantidad_reservada)       AS stock_disponible,
         m.material_stock_minimo                                AS minimo,
         m.material_stock_critico                               AS critico,
         CASE
           WHEN SUM(ib.inventario_bodega_cantidad_fisica) <= m.material_stock_critico THEN 'critico'
           WHEN SUM(ib.inventario_bodega_cantidad_fisica) <= m.material_stock_minimo  THEN 'bajo'
           ELSE 'normal'
         END AS estado_stock
       FROM inventario_bodega ib
       JOIN material m ON m.material_sku = ib.material_sku
       LEFT JOIN material_unidad_medida u
              ON u.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
       WHERE ib.bodega_id_bodega = $1
       GROUP BY m.material_sku, m.material_nombre_material,
                u.material_unidad_medida_nombre,
                m.material_stock_minimo, m.material_stock_critico
       ORDER BY estado_stock DESC, m.material_nombre_material`,
      [id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error obteniendo stock consolidado:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/bodegas/:id/anaqueles
 * Crear anaquel dentro de una bodega (CU-21)
 * Body: { descripcion }
 */
async function crearAnaquel(req, res) {
  const { id } = req.params;
  const { descripcion } = req.body;

  // CU-21 Exc 3: verificar que la bodega existe
  try {
    const { rows: bod } = await query(
      `SELECT bodega_id_bodega FROM bodega WHERE bodega_id_bodega = $1`, [id]
    );
    if (bod.length === 0) {
      return res.status(404).json({ error: 'No se ha seleccionado una bodega válida' });
    }

    if (!descripcion || !descripcion.trim()) {
      return res.status(400).json({ error: 'La descripción del anaquel es requerida' });
    }

    // CU-21 Exc 1: descripción ≤ 255 caracteres
    if (descripcion.length > 255) {
      return res.status(400).json({ error: 'La descripción es demasiado extensa. Por favor, resuma la descripción a un máximo de 255 caracteres.' });
    }

    // CU-21 Exc 2: verificar unicidad de descripción en esa bodega
    const { rows: dup } = await query(
      `SELECT anaquel_id_anaquel FROM anaquel
       WHERE bodega_id_bodega = $1 AND anaquel_descripcion ILIKE $2`,
      [id, descripcion.trim()]
    );
    if (dup.length > 0) {
      return res.status(409).json({ error: 'Ya existe un anaquel con esa descripción en esta bodega. Ingrese un identificador distinto.' });
    }

    const { rows } = await query(
      `INSERT INTO anaquel (anaquel_descripcion, bodega_id_bodega)
       VALUES ($1, $2)
       RETURNING anaquel_id_anaquel AS id`,
      [descripcion.trim(), id]
    );

    await auditoria.registrar(req.user?.id, 'Crear anaquel', `Anaquel "${descripcion.trim()}" creado en bodega ID ${id}`);
    res.status(201).json({
      message: 'Anaquel creado correctamente',
      id: rows[0].id
    });
  } catch (err) {
    console.error('Error creando anaquel:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * DELETE /api/bodegas/:bodegaId/anaqueles/:anaquelId
 * Eliminar anaquel
 */
async function eliminarAnaquel(req, res) {
  const { id, anaquelId } = req.params;
  try {
    const { rowCount } = await query(
      `DELETE FROM anaquel WHERE anaquel_id_anaquel = $1 AND bodega_id_bodega = $2`,
      [anaquelId, id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Anaquel no encontrado en esta bodega' });
    }
    await auditoria.registrar(req.user?.id, 'Eliminar anaquel', `Anaquel ID ${anaquelId} eliminado de bodega ID ${id}`);
    res.json({ message: 'Anaquel eliminado correctamente' });
  } catch (err) {
    console.error('Error eliminando anaquel:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * PUT /api/bodegas/:id/anaqueles/:anaquelId
 * Editar descripción de un anaquel (SONNET-4)
 * Body: { descripcion }
 */
async function editarAnaquel(req, res) {
  const { id, anaquelId } = req.params;
  const { descripcion } = req.body;

  try {
    const { rows: bod } = await query(
      `SELECT bodega_id_bodega FROM bodega WHERE bodega_id_bodega = $1`, [id]
    );
    if (bod.length === 0) {
      return res.status(404).json({ error: 'Bodega no encontrada' });
    }

    const { rows: anaq } = await query(
      `SELECT anaquel_id_anaquel FROM anaquel WHERE anaquel_id_anaquel = $1 AND bodega_id_bodega = $2`,
      [anaquelId, id]
    );
    if (anaq.length === 0) {
      return res.status(404).json({ error: 'Anaquel no encontrado en esta bodega' });
    }

    if (!descripcion || !descripcion.trim()) {
      return res.status(400).json({ error: 'La descripción del anaquel es requerida' });
    }
    if (descripcion.length > 255) {
      return res.status(400).json({ error: 'La descripción es demasiado extensa. Por favor, resuma la descripción a un máximo de 255 caracteres.' });
    }

    const { rows: dup } = await query(
      `SELECT anaquel_id_anaquel FROM anaquel
       WHERE bodega_id_bodega = $1 AND anaquel_descripcion ILIKE $2 AND anaquel_id_anaquel != $3`,
      [id, descripcion.trim(), anaquelId]
    );
    if (dup.length > 0) {
      return res.status(409).json({ error: 'Ya existe un anaquel con esa descripción en esta bodega. Ingrese un identificador distinto.' });
    }

    await query(
      `UPDATE anaquel SET anaquel_descripcion = $1 WHERE anaquel_id_anaquel = $2 AND bodega_id_bodega = $3`,
      [descripcion.trim(), anaquelId, id]
    );
    await auditoria.registrar(req.user?.id, 'Editar anaquel', `Anaquel ID ${anaquelId} de bodega ID ${id} renombrado a "${descripcion.trim()}"`);
    res.json({ message: 'Anaquel actualizado correctamente' });
  } catch (err) {
    console.error('Error editando anaquel:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * DELETE /api/bodegas/:id
 * Eliminar bodega (SONNET-4). Requiere que no tenga stock físico asignado.
 * Transaccional: elimina anaqueles y luego la bodega.
 */
async function eliminar(req, res) {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${process.env.DB_SCHEMA || 'inventario'}`);

    const { rows: bod } = await client.query(
      `SELECT bodega_id_bodega, bodega_nombre_bodega FROM bodega WHERE bodega_id_bodega = $1`,
      [id]
    );
    if (bod.length === 0) {
      return res.status(404).json({ error: 'Bodega no encontrada' });
    }

    const { rows: stockCheck } = await client.query(
      `SELECT COALESCE(SUM(inventario_bodega_cantidad_fisica), 0) AS total
       FROM inventario_bodega WHERE bodega_id_bodega = $1`,
      [id]
    );
    if (parseFloat(stockCheck[0]?.total || 0) > 0) {
      return res.status(400).json({ error: 'La bodega tiene stock asignado. Debe trasladar el inventario antes de eliminarla.' });
    }

    await client.query('BEGIN');
    try {
      await client.query(`DELETE FROM anaquel WHERE bodega_id_bodega = $1`, [id]);
      await client.query(`DELETE FROM bodega WHERE bodega_id_bodega = $1`, [id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }

    await auditoria.registrar(req.user?.id, 'Eliminar bodega', `Bodega "${bod[0].bodega_nombre_bodega}" (ID ${id}) eliminada`);
    res.json({ message: 'Bodega eliminada correctamente' });
  } catch (err) {
    console.error('Error eliminando bodega:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  } finally {
    client.release();
  }
}

module.exports = { listar, obtener, crear, actualizar, stockConsolidado, crearAnaquel, eliminarAnaquel, editarAnaquel, eliminar };
