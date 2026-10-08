const { query } = require('../db/pool');
const { ErrorNegocio, conTransaccion, responderError } = require('../db/tx');
const { generarCodigoInterno } = require('../db/codigos');
const auditoria = require('./auditoriaController');

/**
 * GET /api/codigos/:valor
 * CU-30: resuelve lo que leyo el escaner (o lo que se escribio a mano).
 * Busca primero como codigo de barras y, si no esta, como SKU.
 * Devuelve el producto con su estado: el bloqueo de un inactivo (Exc 3) lo decide
 * la pantalla antes de pedir la cantidad, y el backend lo vuelve a rechazar al
 * registrar el movimiento.
 */
async function resolver(req, res) {
  const valor = String(req.params.valor || '').trim();
  if (!valor) {
    return res.status(400).json({ error: 'Ingrese un código de barras o un SKU.' });
  }
  try {
    const { rows: mat } = await query(
      `SELECT m.material_sku                  AS sku,
              m.material_nombre_material      AS nombre,
              m.material_estado               AS estado,
              u.material_unidad_medida_nombre AS unidad_medida,
              c.material_codigo_barras        AS codigo_barras,
              (c.material_codigo_barras = $1) AS por_codigo
       FROM material m
       LEFT JOIN material_unidad_medida u
              ON u.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
       LEFT JOIN material_codigo_barras c ON c.material_sku = m.material_sku
       WHERE c.material_codigo_barras = $1 OR UPPER(m.material_sku) = UPPER($1)
       -- si un valor coincidiera con un codigo Y con un SKU, gana el codigo
       ORDER BY (c.material_codigo_barras = $1) DESC NULLS LAST
       LIMIT 1`,
      [valor]
    );
    // Exc 1: codigo no registrado
    if (mat.length === 0) {
      return res.status(404).json({
        error: `El código "${valor}" no corresponde a ningún producto del catálogo. Ingrese el SKU manualmente.`,
      });
    }
    const { por_codigo, ...producto } = mat[0];

    const { rows: bodegas } = await query(
      `SELECT b.bodega_id_bodega                                   AS bodega_id,
              b.bodega_nombre_bodega                               AS bodega_nombre,
              SUM(ib.inventario_bodega_cantidad_fisica)            AS cantidad_fisica,
              SUM(ib.inventario_bodega_cantidad_fisica
                - ib.inventario_bodega_cantidad_reservada)         AS disponible
       FROM inventario_bodega ib
       JOIN bodega b ON b.bodega_id_bodega = ib.bodega_id_bodega
       WHERE ib.material_sku = $1
       GROUP BY b.bodega_id_bodega, b.bodega_nombre_bodega
       HAVING SUM(ib.inventario_bodega_cantidad_fisica) > 0
       ORDER BY b.bodega_nombre_bodega`,
      [producto.sku]
    );

    res.json({ ...producto, encontrado_por: por_codigo ? 'codigo' : 'sku', bodegas });
  } catch (err) {
    console.error('Error resolviendo codigo:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/codigos/:sku/generar
 * CU-30: genera el codigo interno de un producto que todavia no tiene (los creados
 * antes de CU-30). Un codigo por SKU: si ya tiene, 409.
 */
async function generar(req, res) {
  const { sku } = req.params;
  try {
    const r = await conTransaccion(async (client) => {
      // FOR UPDATE: dos clics simultaneos no pueden generar dos codigos
      const { rows: mat } = await client.query(
        `SELECT material_sku FROM material WHERE UPPER(material_sku) = UPPER($1) FOR UPDATE`, [sku]
      );
      if (mat.length === 0) {
        throw new ErrorNegocio(404, { error: 'Material no encontrado' });
      }
      const skuReal = mat[0].material_sku;
      const { rows: existente } = await client.query(
        `SELECT material_codigo_barras AS codigo FROM material_codigo_barras WHERE material_sku = $1`, [skuReal]
      );
      if (existente.length > 0) {
        throw new ErrorNegocio(409, {
          error: `El producto ya tiene el código ${existente[0].codigo}. Cada producto lleva un solo código.`,
          codigo_barras: existente[0].codigo,
        });
      }
      const codigo = await generarCodigoInterno(client, skuReal);
      return { sku: skuReal, codigo };
    });
    await auditoria.registrar(req.user?.id, 'Generar código de barras', `SKU ${r.sku}: ${r.codigo}`);
    res.status(201).json({ message: 'Código generado correctamente', sku: r.sku, codigo_barras: r.codigo });
  } catch (err) {
    responderError(res, err, 'Error generando codigo:');
  }
}

module.exports = { resolver, generar };
