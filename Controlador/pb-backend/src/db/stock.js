const { ErrorNegocio } = require('./tx');

/**
 * Helpers de movimiento de stock, extraidos de ordenesTrabajoController (OPUS-1)
 * en OPUS-16 para que los use tambien seguimientoPinturasController.
 *
 * El motivo de extraerlos en vez de copiarlos: el descuento FIFO con FOR UPDATE es
 * el invariante mas delicado del sistema (dos bugs de OPUS-1 salieron de aqui). Dos
 * implementaciones distintas del mismo invariante es garantia de que una se va a
 * quedar atras. Mismo criterio que OPUS-3 con db/tx.js.
 *
 * TODAS estas funciones reciben el `client` de una transaccion abierta: no abren
 * la suya. Llamarlas fuera de conTransaccion() rompe la atomicidad.
 */

/** Id del tipo de movimiento por nombre ('salida', 'entrada', ...). */
async function tipoMovimientoId(client, nombre) {
  const { rows } = await client.query(
    `SELECT movimiento_inventario_tipo_movimiento_id_tipo_movimiento AS id
     FROM movimiento_inventario_tipo_movimiento
     WHERE movimiento_inventario_tipo_movimiento_nombre ILIKE $1
     LIMIT 1`,
    ['%' + nombre + '%']
  );
  return rows[0]?.id || null;
}

/** Id del motivo de movimiento por nombre ('consumo_produccion', 'ajuste_inventario', ...). */
async function motivoMovimientoId(client, nombre) {
  const { rows } = await client.query(
    `SELECT movimiento_inventario_motivo_movimiento_id_motivo_movimiento AS id
     FROM movimiento_inventario_motivo_movimiento
     WHERE movimiento_inventario_motivo_movimiento_nombre ILIKE $1
     LIMIT 1`,
    ['%' + nombre + '%']
  );
  return rows[0]?.id || null;
}

/**
 * Motivo de las entradas que devuelven consumo (corrección a la baja o anulación,
 * en OT y pinturas). Es lo que las hace restar del consumo en db/historico.js.
 * Si falta en el catálogo se falla: registrar la devolución sin motivo la haría
 * contar como un ingreso y inflaría el consumo sin que nadie lo notara.
 */
async function motivoDevolucionConsumo(client) {
  const id = await motivoMovimientoId(client, 'devolucion_consumo');
  if (!id) {
    throw new ErrorNegocio(500, {
      error: 'Falta el motivo de movimiento "devolucion_consumo" en el catálogo. Avise al administrador del sistema.',
    });
  }
  return id;
}

/**
 * Descuenta `cantidad` de un SKU en una bodega siguiendo FIFO (lote mas antiguo
 * primero). Bloquea las filas de inventario_bodega con FOR UPDATE, de modo que
 * dos consumos simultaneos del mismo material no puedan leer el mismo stock
 * disponible y sobre-descontar: el chequeo y el descuento son atomicos.
 */
async function descontarFifo(client, sku, bodegaId, cantidad) {
  const { rows: lotes } = await client.query(
    `SELECT ib.lote_id_lote,
            ib.inventario_bodega_cantidad_fisica - ib.inventario_bodega_cantidad_reservada AS disponible
     FROM inventario_bodega ib
     JOIN lote l ON l.lote_id_lote = ib.lote_id_lote
     WHERE ib.material_sku = $1
       AND ib.bodega_id_bodega = $2
       AND ib.inventario_bodega_cantidad_fisica > ib.inventario_bodega_cantidad_reservada
     ORDER BY l.lote_fecha_ingreso ASC NULLS LAST
     FOR UPDATE OF ib`,
    [sku, bodegaId]
  );

  const disponible = lotes.reduce((s, l) => s + parseFloat(l.disponible), 0);
  // CU-90 Exc 1
  if (cantidad > disponible + 1e-9) {
    throw new ErrorNegocio(400, {
      error: `Stock insuficiente. Disponible: ${disponible}`,
      stock_disponible: disponible,
      cantidad_maxima: disponible
    });
  }

  let restante = cantidad;
  const usados = [];
  for (const lote of lotes) {
    if (restante <= 1e-9) break;
    const descontar = Math.min(restante, parseFloat(lote.disponible));
    await client.query(
      `UPDATE inventario_bodega
       SET inventario_bodega_cantidad_fisica = inventario_bodega_cantidad_fisica - $1
       WHERE material_sku = $2 AND lote_id_lote = $3 AND bodega_id_bodega = $4`,
      [descontar, sku, lote.lote_id_lote, bodegaId]
    );
    usados.push({ lote_id: lote.lote_id_lote, cantidad: descontar });
    restante -= descontar;
  }

  return { lotes: usados, lote_principal: usados[0]?.lote_id || null, disponible_previo: disponible };
}

/**
 * Devuelve `cantidad` al stock. Intenta el lote sugerido (el del movimiento que se
 * esta revirtiendo); si no existe en esa bodega, cae al mas antiguo.
 *
 * LIMITACION CONOCIDA (heredada de OPUS-1): la devolucion va a UN lote, no se
 * reparte por los lotes de los que salio el descuento FIFO. El TOTAL de la bodega
 * queda correcto pero la distribucion por lote puede cambiar. Guardar el desglose
 * exigiria una tabla nueva: movimiento_inventario solo tiene un lote_id_lote.
 */
async function reponerFifo(client, sku, bodegaId, cantidad, loteSugerido) {
  let loteDestino = null;

  if (loteSugerido) {
    const { rows } = await client.query(
      `SELECT lote_id_lote FROM inventario_bodega
       WHERE material_sku = $1 AND lote_id_lote = $2 AND bodega_id_bodega = $3
       FOR UPDATE`,
      [sku, loteSugerido, bodegaId]
    );
    if (rows.length > 0) loteDestino = rows[0].lote_id_lote;
  }

  if (!loteDestino) {
    const { rows } = await client.query(
      `SELECT ib.lote_id_lote
       FROM inventario_bodega ib
       JOIN lote l ON l.lote_id_lote = ib.lote_id_lote
       WHERE ib.material_sku = $1 AND ib.bodega_id_bodega = $2
       ORDER BY l.lote_fecha_ingreso ASC NULLS LAST
       LIMIT 1
       FOR UPDATE OF ib`,
      [sku, bodegaId]
    );
    if (rows.length === 0) return null;
    loteDestino = rows[0].lote_id_lote;
  }

  await client.query(
    `UPDATE inventario_bodega
     SET inventario_bodega_cantidad_fisica = inventario_bodega_cantidad_fisica + $1
     WHERE material_sku = $2 AND lote_id_lote = $3 AND bodega_id_bodega = $4`,
    [cantidad, sku, loteDestino, bodegaId]
  );
  return loteDestino;
}

/** INSERT de movimiento_inventario vinculado a la OT (OPUS-1: orden_trabajo_id_orden). */
async function insertarMovimiento(client, m) {
  const { rows } = await client.query(
    `INSERT INTO movimiento_inventario (
       movimiento_inventario_cantidad, movimiento_inventario_estado,
       material_sku, bodega_id_bodega, lote_id_lote,
       usuario_id_usuario,
       movimiento_inventario_tipo_movimiento_id_tipo_movimiento,
       movimiento_inventario_motivo_movimiento_id_motivo_movimiento,
       movimiento_inventario_descripcion_motivo,
       proyecto_id_proyecto, orden_trabajo_id_orden
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING movimiento_inventario_id_movimiento AS id`,
    [m.cantidad, m.estado || 'completado', m.sku, m.bodegaId, m.loteId || null,
     m.usuarioId, m.tipoId, m.motivoId || null, m.descripcion || null,
     m.proyectoId || null, m.otId]
  );
  return rows[0].id;
}

/**
 * Bodega de origen: la que se informa, o la unica con stock disponible.
 * Con mas de una, se pide elegir y se devuelve la lista (CU-90 Exc 2).
 */
async function resolverBodega(client, sku, bodegaId) {
  if (bodegaId) return bodegaId;

  const { rows: bodegas } = await client.query(
    `SELECT ib.bodega_id_bodega, b.bodega_nombre_bodega AS nombre,
            SUM(inventario_bodega_cantidad_fisica) - SUM(inventario_bodega_cantidad_reservada) AS disponible
     FROM inventario_bodega ib JOIN bodega b ON b.bodega_id_bodega = ib.bodega_id_bodega
     WHERE material_sku = $1
       AND inventario_bodega_cantidad_fisica > inventario_bodega_cantidad_reservada
     GROUP BY ib.bodega_id_bodega, b.bodega_nombre_bodega
     HAVING SUM(inventario_bodega_cantidad_fisica) - SUM(inventario_bodega_cantidad_reservada) > 0`,
    [sku]
  );

  if (bodegas.length === 0) {
    throw new ErrorNegocio(400, { error: `Stock insuficiente para ${sku}. No hay disponible en ninguna bodega.` });
  }
  if (bodegas.length > 1) {
    throw new ErrorNegocio(400, {
      error: 'El producto existe en múltiples bodegas. Seleccione la bodega de origen.',
      bodegas: bodegas.map(b => ({ bodega_id: b.bodega_id_bodega, nombre: b.nombre, disponible: parseFloat(b.disponible) }))
    });
  }
  return bodegas[0].bodega_id_bodega;
}

module.exports = {
  tipoMovimientoId, motivoMovimientoId, motivoDevolucionConsumo,
  descontarFifo, reponerFifo, insertarMovimiento, resolverBodega,
};
