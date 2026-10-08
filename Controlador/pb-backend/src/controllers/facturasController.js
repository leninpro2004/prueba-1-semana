const { query } = require('../db/pool');
const { ocultaMontos, quitarCampos } = require('../middleware/auth');
const auditoria = require('./auditoriaController');

/**
 * GET /api/facturas
 * Lista facturas de compra con filtros
 * Query params: ?buscar=&proveedor_id=&desde=&hasta=
 */
async function listar(req, res) {
  const { buscar, proveedor_id, desde, hasta } = req.query;
  try {
    const { rows } = await query(
      `SELECT
         fc.factura_compra_id_factura          AS id,
         fc.factura_compra_numero_factura      AS numero_factura,
         fc.factura_compra_monto_neto          AS monto_neto,
         fc.factura_compra_tipo_compra         AS tipo_compra,
         fc.factura_compra_fecha_emision       AS fecha_emision,
         p.proveedor_id_proveedor              AS proveedor_id,
         p.proveedor_razon_social              AS proveedor_nombre,
         tc.factura_compra_tipo_cambio_moneda  AS moneda,
         tc.factura_compra_tipo_cambio_valor   AS tipo_cambio
       FROM factura_compra fc
       JOIN proveedor p ON p.proveedor_id_proveedor = fc.proveedor_id_proveedor
       LEFT JOIN factura_compra_tipo_cambio tc
            ON tc.factura_compra_tipo_cambio_id_tipo_cambio = fc.factura_compra_tipo_cambio_id_tipo_cambio
       WHERE ($1::text IS NULL OR
              fc.factura_compra_numero_factura ILIKE '%' || $1 || '%' OR
              p.proveedor_razon_social ILIKE '%' || $1 || '%')
         AND ($2::bigint IS NULL OR fc.proveedor_id_proveedor = $2)
         AND ($3::date IS NULL OR fc.factura_compra_fecha_emision >= $3)
         AND ($4::date IS NULL OR fc.factura_compra_fecha_emision <= $4)
       ORDER BY fc.factura_compra_fecha_emision DESC`,
      [buscar || null, proveedor_id || null, desde || null, hasta || null]
    );
    // Montos ocultos a jop en el backend
    if (ocultaMontos(req)) quitarCampos(rows, ['monto_neto']);
    res.json(rows);
  } catch (err) {
    console.error('Error listando facturas:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/facturas/:id
 * Detalle de una factura con sus movimientos asociados
 */
async function obtener(req, res) {
  const { id } = req.params;
  try {
    const { rows: fac } = await query(
      `SELECT
         fc.factura_compra_id_factura          AS id,
         fc.factura_compra_numero_factura      AS numero_factura,
         fc.factura_compra_monto_neto          AS monto_neto,
         fc.factura_compra_tipo_compra         AS tipo_compra,
         fc.factura_compra_fecha_emision       AS fecha_emision,
         p.proveedor_id_proveedor              AS proveedor_id,
         p.proveedor_razon_social              AS proveedor_nombre,
         tc.factura_compra_tipo_cambio_moneda  AS moneda,
         tc.factura_compra_tipo_cambio_valor   AS tipo_cambio
       FROM factura_compra fc
       JOIN proveedor p ON p.proveedor_id_proveedor = fc.proveedor_id_proveedor
       LEFT JOIN factura_compra_tipo_cambio tc
            ON tc.factura_compra_tipo_cambio_id_tipo_cambio = fc.factura_compra_tipo_cambio_id_tipo_cambio
       WHERE fc.factura_compra_id_factura = $1`,
      [id]
    );

    if (fac.length === 0) {
      return res.status(404).json({ error: 'Factura no encontrada' });
    }

    // Movimientos vinculados a esta factura
    const { rows: movimientos } = await query(
      `SELECT
         mi.movimiento_inventario_id_movimiento AS id,
         mi.movimiento_inventario_fecha_hora    AS fecha,
         mi.movimiento_inventario_cantidad      AS cantidad,
         mi.material_sku                        AS sku,
         m.material_nombre_material             AS material_nombre,
         b.bodega_nombre_bodega                 AS bodega
       FROM movimiento_inventario mi
       JOIN material m ON m.material_sku = mi.material_sku
       LEFT JOIN bodega b ON b.bodega_id_bodega = mi.bodega_id_bodega
       WHERE mi.factura_compra_id_factura_compra = $1
       ORDER BY mi.movimiento_inventario_fecha_hora DESC`,
      [id]
    );

    if (ocultaMontos(req)) quitarCampos(fac, ['monto_neto']);   // montos ocultos a jop
    res.json({ ...fac[0], movimientos });
  } catch (err) {
    console.error('Error obteniendo factura:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/facturas
 * Crear factura de compra (CU-28)
 * Body: { numero_factura, monto_neto, tipo_compra, fecha_emision, proveedor_id, moneda?, tipo_cambio? }
 */
async function crear(req, res) {
  const { numero_factura, monto_neto, tipo_compra, fecha_emision, proveedor_id, moneda, tipo_cambio } = req.body;

  if (!numero_factura || !fecha_emision || !proveedor_id) {
    return res.status(400).json({ error: 'Número de factura, fecha de emisión y proveedor son requeridos' });
  }

  try {
    // Validar formato: fecha válida
    if (isNaN(Date.parse(fecha_emision))) {
      return res.status(400).json({ error: 'El formato de fecha no es válido' });
    }

    // Verificar duplicado de número de factura (CU-28 Exc 3)
    const { rows: dup } = await query(
      `SELECT factura_compra_id_factura FROM factura_compra
       WHERE factura_compra_numero_factura = $1`,
      [numero_factura]
    );
    if (dup.length > 0) {
      return res.status(409).json({ error: 'El número de factura ya se encuentra registrado en otro movimiento' });
    }

    // Si hay tipo de cambio, crear registro
    let tipoCambioId = null;
    if (moneda && tipo_cambio) {
      const { rows: tc } = await query(
        `INSERT INTO factura_compra_tipo_cambio
           (factura_compra_tipo_cambio_moneda, factura_compra_tipo_cambio_valor)
         VALUES ($1, $2)
         RETURNING factura_compra_tipo_cambio_id_tipo_cambio AS id`,
        [moneda, tipo_cambio]
      );
      tipoCambioId = tc[0].id;
    }

    const { rows } = await query(
      `INSERT INTO factura_compra (
         factura_compra_numero_factura, factura_compra_monto_neto,
         factura_compra_tipo_compra, factura_compra_fecha_emision,
         proveedor_id_proveedor, factura_compra_tipo_cambio_id_tipo_cambio
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING factura_compra_id_factura AS id`,
      [numero_factura, monto_neto || null, tipo_compra || null, fecha_emision, proveedor_id, tipoCambioId]
    );

    await auditoria.registrar(req.user?.id, 'crear_factura', `Factura "${numero_factura}" (ID ${rows[0].id})`);
    res.status(201).json({ message: 'Factura registrada correctamente', id: rows[0].id });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'El número de factura ya se encuentra registrado' });
    }
    console.error('Error creando factura:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/facturas/buscar-numero/:numero
 * Busca factura por número exacto (para autocompletar en entrada)
 */
async function buscarPorNumero(req, res) {
  const { numero } = req.params;
  try {
    const { rows } = await query(
      `SELECT
         fc.factura_compra_id_factura     AS id,
         fc.factura_compra_numero_factura AS numero_factura,
         fc.factura_compra_fecha_emision  AS fecha_emision,
         p.proveedor_razon_social         AS proveedor_nombre
       FROM factura_compra fc
       JOIN proveedor p ON p.proveedor_id_proveedor = fc.proveedor_id_proveedor
       WHERE fc.factura_compra_numero_factura ILIKE $1
       LIMIT 10`,
      [`%${numero}%`]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error buscando factura:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = { listar, obtener, crear, buscarPorNumero };
