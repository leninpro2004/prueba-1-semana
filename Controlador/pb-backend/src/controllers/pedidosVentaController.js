const { query } = require('../db/pool');
const { ErrorNegocio, conTransaccion, responderError } = require('../db/tx');
const auditoria = require('./auditoriaController');
const { TIPO_UBICACION_INCORRECTA, TIPO_FALTANTE_RETIRO, TIPOS_RETIRO, resolverAlertas } = require('./alertasController');
const { notificarPorRol } = require('./notificacionesController');
const { generarAlertasAutomaticas } = require('./alertasController');
const { tipoMovimientoId, motivoMovimientoId } = require('../db/stock');

/**
 * Pedidos de instalación: la cadena de despacho de una venta (CU-120 → 119 → 126 → 125 → 127).
 *
 *  - Pedido = finanzas.nota_venta (D12), solo lectura. Nuestro estado de despacho vive en
 *    preparacion_pedido (una por venta) y su historial en preparacion_pedido_estado (D13).
 *  - D44: se vinculan los insumos del ÁREA "Instalación" de las recetas de las puertas que
 *    requieren instalación (los que viajan a terreno), no la receta completa: la producción
 *    la consumen las OT (R1). Cada insumo tiene una sola salida.
 *  - Vincular = reservar por FIFO en la bodega de CADA insumo (D45: bodega por ítem), una
 *    reserva por lote, cada una apuntando a su ítem (preparacion_pedido_detalle). El detalle
 *    guarda lo pedido y la bodega; lo reservado se suma de las reservas activas. Una
 *    vinculación puede quedar parcial (Exc 2).
 */

// Ventas en las que se puede vincular (D14 + sesión 12). Si Finanzas usa otros nombres, se cambia aquí.
const ESTADOS_VINCULABLES = ['aprobada', 'en_proceso'];
// Estados de despacho, en orden (D13). CU-120 solo modifica mientras está 'vinculado'.
// D51: 'cancelado' es final (venta cancelada, reservas liberadas); desde 'preparado' o 'en_carga' se puede volver a 'vinculado'.
const ESTADOS_DESPACHO = ['vinculado', 'preparado', 'en_carga', 'en_transito', 'cancelado'];
// D51: Finanzas no fijó el valor de una venta cancelada: las mismas variantes que CU-122 (D17)
const ESTADOS_VENTA_CANCELADA = ['cancelada', 'cancelado', 'anulada', 'anulado'];

/**
 * D51: el pedido puede volver a 'vinculado', así que el historial repite estados. Lo VIGENTE (responsables de la
 * carga, etapas de la trazabilidad) es lo registrado desde la última vez que quedó 'vinculado'. `e` es el alias de
 * preparacion_pedido_estado. Por id y no por fecha: dos estados del mismo instante se ordenan igual.
 */
const DESDE_ULTIMA_VINCULACION = (e) => `
  ${e}.preparacion_pedido_estado_id_estado_preparacion >= (
    SELECT MAX(v.preparacion_pedido_estado_id_estado_preparacion) FROM preparacion_pedido_estado v
    WHERE v.preparacion_pedido_id_preparacion = ${e}.preparacion_pedido_id_preparacion
      AND v.preparacion_pedido_estado_nombre_estado = 'vinculado')`;
const CANTIDAD_RE = /^\d+(\.\d{1,4})?$/;
const MAX_CANTIDAD = 1e8;
/** ['A', 'B', 'C'] → 'A, B y C' */
const enumerar = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}` : xs.join(''));

const reservadoSQL = (det) => `
  COALESCE((SELECT SUM(ri.reserva_inventario_cantidad_reservada) FROM reserva_inventario ri
            WHERE ri.preparacion_pedido_detalle_id = ${det}.preparacion_pedido_detalle_id
              AND ri.reserva_inventario_estado_reserva = 'activa'), 0)`;

/** Último estado de despacho de una preparación (o null). */
const ULTIMO_ESTADO_SQL = `
  LEFT JOIN LATERAL (
    SELECT e.preparacion_pedido_estado_nombre_estado AS estado,
           e.preparacion_pedido_estado_timestamp_accion AS fecha
    FROM preparacion_pedido_estado e
    WHERE e.preparacion_pedido_id_preparacion = pp.preparacion_pedido_id_preparacion
    ORDER BY e.preparacion_pedido_estado_timestamp_accion DESC, e.preparacion_pedido_estado_id_estado_preparacion DESC
    LIMIT 1) est ON TRUE`;

/**
 * GET /api/pedidos-venta   (gerencia y jop)
 * Ventas en las que se puede vincular + las que ya tienen vinculación (cualquiera sea su
 * estado ahora: no se pierde el rastro de sus reservas).
 */
async function listar(req, res) {
  try {
    const { rows } = await query(
      `SELECT nv.id_nota_venta AS id, nv.numero_nota_venta AS numero, nv.estado_pedido,
              nv.fecha_emision, nv.fecha_max_entrega, cf.nombre_razon_social AS cliente,
              (SELECT COALESCE(SUM(i.cantidad), 0) FROM finanzas.item_nota_venta i
               WHERE i.id_nota_venta = nv.id_nota_venta AND i.id_producto_terminado IS NOT NULL
                 AND i.requiere_instalacion)::float AS puertas_instalacion,
              pp.preparacion_pedido_id_preparacion AS preparacion_id,
              COALESCE(est.estado, 'sin_vincular') AS estado_despacho, est.fecha AS fecha_estado,
              det.items, det.faltantes,
              nv.estado_pedido = ANY($1) AS vinculable
       FROM finanzas.nota_venta nv
       LEFT JOIN finanzas.cliente_financiero cf ON cf.id_cliente_financiero = nv.id_cliente_financiero
       LEFT JOIN preparacion_pedido pp ON pp.nota_venta_id_nota_venta = nv.id_nota_venta
       ${ULTIMO_ESTADO_SQL}
       LEFT JOIN LATERAL (
         -- CU-127: despachado, las reservas ya se liberaron (salió el stock): no hay faltantes. D51: cancelado, tampoco
         SELECT COUNT(*)::int AS items,
                COUNT(*) FILTER (WHERE COALESCE(est.estado, '') NOT IN ('en_transito', 'cancelado')
                                   AND d.preparacion_pedido_detalle_cantidad_requerida > ${reservadoSQL('d')})::int AS faltantes
         FROM preparacion_pedido_detalle d
         WHERE d.preparacion_pedido_id_preparacion = pp.preparacion_pedido_id_preparacion) det ON TRUE
       WHERE nv.estado_pedido = ANY($1) OR pp.preparacion_pedido_id_preparacion IS NOT NULL
       ORDER BY nv.fecha_max_entrega NULLS LAST, nv.numero_nota_venta`,
      [ESTADOS_VINCULABLES]
    );
    res.json(rows.map(r => ({ ...r, id: Number(r.id), preparacion_id: r.preparacion_id && Number(r.preparacion_id) })));
  } catch (err) {
    responderError(res, err, 'Error listando pedidos de instalación:');
  }
}

/** Cabecera de la venta y su preparación (si existe). */
async function cabecera(db, id) {
  const { rows } = await db.query(
    `SELECT nv.id_nota_venta AS id, nv.numero_nota_venta AS numero, nv.estado_pedido,
            nv.fecha_emision, nv.fecha_max_entrega, cf.nombre_razon_social AS cliente,
            nv.estado_pedido = ANY($2) AS vinculable,
            pp.preparacion_pedido_id_preparacion AS preparacion_id,
            pp.preparacion_pedido_fecha_creacion AS fecha_vinculacion,
            u.usuario_username AS vinculado_por, est.estado AS estado_despacho
     FROM finanzas.nota_venta nv
     LEFT JOIN finanzas.cliente_financiero cf ON cf.id_cliente_financiero = nv.id_cliente_financiero
     LEFT JOIN preparacion_pedido pp ON pp.nota_venta_id_nota_venta = nv.id_nota_venta
     LEFT JOIN usuario u ON u.usuario_id_usuario = pp.usuario_id_usuario
     ${ULTIMO_ESTADO_SQL}
     WHERE nv.id_nota_venta = $1`,
    [id, ESTADOS_VINCULABLES]
  );
  return rows[0] || null;
}

/** Insumos de instalación sugeridos: receta (área Instalación) × puertas que requieren instalación. */
async function sugerencia(db, id) {
  const { rows } = await db.query(
    `SELECT mpt.material_sku AS sku, m.material_nombre_material AS nombre, um.material_unidad_medida_nombre AS unidad,
            m.material_estado AS estado_material,
            ROUND(SUM(mpt.material_producto_terminado_cantidad_estimada
                      * (1 + COALESCE(mpt.material_producto_terminado_merma_estimada, 0)) * i.cantidad), 4)::float AS cantidad,
            string_agg(DISTINCT pt.producto_terminado_codigo_producto, ', ') AS recetas
     FROM finanzas.item_nota_venta i
     JOIN producto_terminado pt ON pt.producto_terminado_id_producto = i.id_producto_terminado
     JOIN material_producto_terminado mpt ON mpt.producto_terminado_id_producto = i.id_producto_terminado
     JOIN area_trabajo a ON a.area_trabajo_id_area = mpt.area_trabajo_id_area AND a.area_trabajo_clasificacion = 'instalacion'
     JOIN material m ON m.material_sku = mpt.material_sku
     LEFT JOIN material_unidad_medida um ON um.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
     WHERE i.id_nota_venta = $1 AND i.requiere_instalacion
     GROUP BY mpt.material_sku, m.material_nombre_material, um.material_unidad_medida_nombre, m.material_estado
     ORDER BY m.material_nombre_material`,
    [id]
  );
  return rows;
}

/**
 * GET /api/pedidos-venta/:id   (gerencia y jop)
 * La venta, sus puertas, la sugerencia de insumos de instalación, la vinculación vigente
 * (Exc 3) con lo reservado por lote, y el disponible por bodega de cada insumo.
 */
async function obtener(req, res) {
  const { id } = req.params;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la venta debe ser numérico' });
  try {
    const venta = await cabecera({ query }, id);
    if (!venta) return res.status(404).json({ error: 'Venta no encontrada' });

    const { rows: items } = await query(
      `SELECT i.id_item_nota_venta AS id, i.descripcion_item AS descripcion, i.cantidad::float AS cantidad,
              i.requiere_instalacion, i.sku_material AS sku, pt.producto_terminado_codigo_producto AS receta
       FROM finanzas.item_nota_venta i
       LEFT JOIN producto_terminado pt ON pt.producto_terminado_id_producto = i.id_producto_terminado
       WHERE i.id_nota_venta = $1 ORDER BY i.id_item_nota_venta`, [id]
    );
    const sugeridos = await sugerencia({ query }, id);

    let detalle = [];
    let historial = [];
    let responsables = [];
    let despacho = null;
    if (venta.preparacion_id) {
      ({ rows: detalle } = await query(
        `SELECT d.material_sku AS sku, m.material_nombre_material AS nombre, um.material_unidad_medida_nombre AS unidad,
                m.material_estado AS estado_material, d.preparacion_pedido_detalle_origen AS origen,
                d.bodega_id_bodega::int AS bodega_id, b.bodega_nombre_bodega AS bodega,
                d.preparacion_pedido_detalle_cantidad_requerida::float AS requerida,
                ${reservadoSQL('d')}::float AS reservado,
                -- CU-126: la ubicación de cada lote reservado (el anaquel es informativo, OPUS-5).
                -- D58: un insumo puede estar reservado en varias bodegas; cada lote dice la suya.
                (SELECT json_agg(json_build_object('lote', l.lote_numero_lote, 'cantidad', ri.reserva_inventario_cantidad_reservada::float,
                                                   'anaquel', an.anaquel_descripcion,
                                                   'bodega_id', ri.bodega_id_bodega::int, 'bodega', bl.bodega_nombre_bodega)
                                 ORDER BY (ri.bodega_id_bodega <> d.bodega_id_bodega), bl.bodega_nombre_bodega, l.lote_fecha_ingreso)
                 FROM reserva_inventario ri JOIN lote l ON l.lote_id_lote = ri.lote_id_lote
                 JOIN bodega bl ON bl.bodega_id_bodega = ri.bodega_id_bodega
                 LEFT JOIN inventario_bodega ib ON ib.material_sku = ri.material_sku AND ib.lote_id_lote = ri.lote_id_lote
                                               AND ib.bodega_id_bodega = ri.bodega_id_bodega
                 LEFT JOIN anaquel an ON an.anaquel_id_anaquel = ib.anaquel_id_anaquel
                 WHERE ri.preparacion_pedido_detalle_id = d.preparacion_pedido_detalle_id
                   AND ri.reserva_inventario_estado_reserva = 'activa') AS lotes,
                -- CU-126 (D46): retiro por insumo
                COALESCE(d.preparacion_pedido_detalle_cantidad_retirada, 0)::float AS retirada,
                d.preparacion_pedido_detalle_fecha_retiro AS fecha_retiro, ur.usuario_username AS retirado_por
         FROM preparacion_pedido_detalle d
         JOIN material m ON m.material_sku = d.material_sku
         JOIN bodega b ON b.bodega_id_bodega = d.bodega_id_bodega
         LEFT JOIN usuario ur ON ur.usuario_id_usuario = d.usuario_id_retiro
         LEFT JOIN material_unidad_medida um ON um.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
         WHERE d.preparacion_pedido_id_preparacion = $1
         ORDER BY m.material_nombre_material`, [venta.preparacion_id]
      ));
      ({ rows: historial } = await query(
        `SELECT e.preparacion_pedido_estado_nombre_estado AS estado, e.preparacion_pedido_estado_timestamp_accion AS fecha,
                u.usuario_username AS usuario
         FROM preparacion_pedido_estado e LEFT JOIN usuario u ON u.usuario_id_usuario = e.usuario_id_usuario
         WHERE e.preparacion_pedido_id_preparacion = $1
         ORDER BY e.preparacion_pedido_estado_timestamp_accion, e.preparacion_pedido_estado_id_estado_preparacion`,
        [venta.preparacion_id]
      ));
      responsables = await responsablesDeCarga({ query }, venta.preparacion_id);
      despacho = await datosDespacho({ query }, venta.preparacion_id, venta.numero);
    }

    // Disponible (físico − reservado) por bodega de cada insumo que aparece en pantalla
    const skus = [...new Set([...sugeridos.map(s => s.sku), ...detalle.map(d => d.sku)])];
    const { rows: stock } = skus.length ? await query(
      `SELECT material_sku AS sku, bodega_id_bodega AS bodega_id,
              SUM(inventario_bodega_cantidad_fisica - inventario_bodega_cantidad_reservada)::float AS disponible
       FROM inventario_bodega WHERE material_sku = ANY($1::text[])
       GROUP BY 1, 2`, [skus]
    ) : { rows: [] };

    const puertas = items.filter(i => i.receta && i.requiere_instalacion).reduce((s, i) => s + i.cantidad, 0);
    const editable = venta.vinculable && (!venta.estado_despacho || venta.estado_despacho === 'vinculado');
    res.json({
      venta: { ...venta, id: Number(venta.id), estado_despacho: venta.estado_despacho || 'sin_vincular' },
      items, sugerencia: sugeridos, detalle, historial, responsables_carga: responsables, despacho,
      stock: stock.map(s => ({ ...s, bodega_id: Number(s.bodega_id) })),
      editable,
      // Exc 1: sin plantilla ni lista
      motivo_sin_plantilla: sugeridos.length || detalle.length ? null
        : puertas === 0
          ? 'La venta no tiene puertas que requieran instalación. Si hay insumos que despachar, cárguelos a mano.'
          : 'Las recetas de las puertas de esta venta no tienen insumos del área Instalación. Cargue los insumos a mano.',
      aviso: !editable && venta.preparacion_id
        ? (!venta.vinculable
            ? `La venta está "${venta.estado_pedido}": la vinculación ya no se puede modificar.`
            : `El pedido ya está "${venta.estado_despacho}": la vinculación ya no se puede modificar.`)
        : null,
    });
  } catch (err) {
    responderError(res, err, 'Error obteniendo el pedido de instalación:');
  }
}

/** Reserva hasta `cantidad` de un SKU en una bodega, por FIFO, una reserva por lote. Devuelve lo reservado. */
async function reservarEnBodega(client, { detId, ventaId, sku, bodegaId, cantidad }) {
  const { rows: lotes } = await client.query(
    `SELECT ib.lote_id_lote,
            ib.inventario_bodega_cantidad_fisica - ib.inventario_bodega_cantidad_reservada AS disponible
     FROM inventario_bodega ib
     JOIN lote l ON l.lote_id_lote = ib.lote_id_lote
     WHERE ib.material_sku = $1 AND ib.bodega_id_bodega = $2
       AND ib.inventario_bodega_cantidad_fisica > ib.inventario_bodega_cantidad_reservada
     ORDER BY l.lote_fecha_ingreso ASC NULLS LAST
     FOR UPDATE OF ib`,
    [sku, bodegaId]
  );
  let restante = cantidad;
  for (const l of lotes) {
    if (restante <= 1e-9) break;
    const r = Math.min(restante, parseFloat(l.disponible));
    await client.query(
      `UPDATE inventario_bodega SET inventario_bodega_cantidad_reservada = inventario_bodega_cantidad_reservada + $1
       WHERE material_sku = $2 AND lote_id_lote = $3 AND bodega_id_bodega = $4`,
      [r, sku, l.lote_id_lote, bodegaId]
    );
    // Si el ítem ya tiene una reserva activa en ese lote, se suma a ella
    const { rowCount } = await client.query(
      `UPDATE reserva_inventario SET reserva_inventario_cantidad_reservada = reserva_inventario_cantidad_reservada + $1
       WHERE preparacion_pedido_detalle_id = $2 AND lote_id_lote = $3 AND bodega_id_bodega = $4
         AND reserva_inventario_estado_reserva = 'activa'`,
      [r, detId, l.lote_id_lote, bodegaId]
    );
    if (rowCount === 0) {
      await client.query(
        `INSERT INTO reserva_inventario (reserva_inventario_cantidad_reservada, reserva_inventario_estado_reserva,
           material_sku, nota_venta_id_nota_venta, lote_id_lote, bodega_id_bodega, preparacion_pedido_detalle_id)
         VALUES ($1, 'activa', $2, $3, $4, $5, $6)`,
        [r, sku, ventaId, l.lote_id_lote, bodegaId, detId]
      );
    }
    restante -= r;
  }
  return cantidad - restante;
}

/**
 * D58: reserva hasta `cantidad` empezando por la bodega principal del insumo; lo que no
 * alcanza se completa desde las demás bodegas activas, la de más disponible primero.
 * Devuelve lo reservado.
 */
async function reservarConReparto(client, { detId, ventaId, sku, bodegaId, cantidad }) {
  let reservado = await reservarEnBodega(client, { detId, ventaId, sku, bodegaId, cantidad });
  if (cantidad - reservado <= 1e-9) return reservado;
  const { rows: otras } = await client.query(
    `SELECT ib.bodega_id_bodega AS id
     FROM inventario_bodega ib JOIN bodega b ON b.bodega_id_bodega = ib.bodega_id_bodega
     WHERE ib.material_sku = $1 AND ib.bodega_id_bodega <> $2 AND b.bodega_estado IN ('activo', 'activa')
     GROUP BY ib.bodega_id_bodega
     HAVING SUM(ib.inventario_bodega_cantidad_fisica - ib.inventario_bodega_cantidad_reservada) > 0
     ORDER BY SUM(ib.inventario_bodega_cantidad_fisica - ib.inventario_bodega_cantidad_reservada) DESC, ib.bodega_id_bodega`,
    [sku, bodegaId]
  );
  for (const o of otras) {
    if (cantidad - reservado <= 1e-9) break;
    reservado += await reservarEnBodega(client, { detId, ventaId, sku, bodegaId: o.id, cantidad: cantidad - reservado });
  }
  return reservado;
}

/**
 * Libera `cantidad` de las reservas activas de un ítem: primero lo de otras bodegas que la
 * principal (D58) y, dentro de cada una, el lote más nuevo primero.
 */
async function liberarDeItem(client, detId, cantidad) {
  const { rows: reservas } = await client.query(
    `SELECT ri.reserva_inventario_id_reserva AS id, ri.reserva_inventario_cantidad_reservada AS cantidad,
            ri.material_sku AS sku, ri.lote_id_lote AS lote_id, ri.bodega_id_bodega AS bodega_id
     FROM reserva_inventario ri JOIN lote l ON l.lote_id_lote = ri.lote_id_lote
     JOIN preparacion_pedido_detalle d ON d.preparacion_pedido_detalle_id = ri.preparacion_pedido_detalle_id
     WHERE ri.preparacion_pedido_detalle_id = $1 AND ri.reserva_inventario_estado_reserva = 'activa'
     ORDER BY (ri.bodega_id_bodega = d.bodega_id_bodega), l.lote_fecha_ingreso DESC NULLS LAST, ri.reserva_inventario_id_reserva DESC
     FOR UPDATE OF ri`,
    [detId]
  );
  let restante = cantidad;
  for (const r of reservas) {
    if (restante <= 1e-9) break;
    const x = Math.min(restante, parseFloat(r.cantidad));
    await client.query(
      `UPDATE inventario_bodega SET inventario_bodega_cantidad_reservada = inventario_bodega_cantidad_reservada - $1
       WHERE material_sku = $2 AND lote_id_lote = $3 AND bodega_id_bodega = $4`,
      [x, r.sku, r.lote_id, r.bodega_id]
    );
    if (Math.abs(x - parseFloat(r.cantidad)) < 1e-9) {
      await client.query(
        `UPDATE reserva_inventario SET reserva_inventario_estado_reserva = 'liberada', reserva_inventario_fecha_liberacion = now()
         WHERE reserva_inventario_id_reserva = $1`, [r.id]
      );
    } else {
      await client.query(
        `UPDATE reserva_inventario SET reserva_inventario_cantidad_reservada = reserva_inventario_cantidad_reservada - $1
         WHERE reserva_inventario_id_reserva = $2`, [x, r.id]
      );
    }
    restante -= x;
  }
}

async function reservadoDe(client, detId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(reserva_inventario_cantidad_reservada), 0)::float AS r FROM reserva_inventario
     WHERE preparacion_pedido_detalle_id = $1 AND reserva_inventario_estado_reserva = 'activa'`, [detId]
  );
  return rows[0].r;
}

/**
 * PUT /api/pedidos-venta/:id/vinculacion   (gerencia y jop)
 * Body: { lineas: [{ sku, cantidad, bodega_id, origen?: 'receta'|'manual' }] }
 *
 * Crea la vinculación o la modifica (Exc 3). `lineas` es el estado completo deseado:
 * las reservas se ajustan por la DIFERENCIA (más → FIFO en la bodega principal del insumo y, si
 * no alcanza, en las demás (D58); menos → se libera primero lo de otras bodegas y el lote más
 * nuevo); un insumo que no viene se libera y sale del pedido. Si falta stock se reserva lo que
 * hay (Exc 2) y el faltante queda a la vista. Cambiar la bodega principal de un insumo libera lo
 * suyo y lo vuelve a reservar empezando por la nueva. Todo en una transacción.
 */
async function vincular(req, res) {
  const { id } = req.params;
  const b = req.body || {};
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la venta debe ser numérico' });

  try {
    const r = await conTransaccion(async (client) => {
      const venta = await cabecera(client, id);
      if (!venta) throw new ErrorNegocio(404, { error: 'Venta no encontrada' });
      if (!venta.vinculable) {
        throw new ErrorNegocio(400, {
          error: `La venta ${venta.numero} está "${venta.estado_pedido}": solo se vinculan insumos a ventas ${ESTADOS_VINCULABLES.join(' o ')}.`,
        });
      }
      if (venta.preparacion_id) {
        await client.query(`SELECT 1 FROM preparacion_pedido WHERE preparacion_pedido_id_preparacion = $1 FOR UPDATE`, [venta.preparacion_id]);
      }
      if (venta.estado_despacho && venta.estado_despacho !== 'vinculado') {
        throw new ErrorNegocio(409, {
          error: `El pedido ${venta.numero} ya está "${venta.estado_despacho}": la vinculación ya no se puede modificar.`,
          codigo: 'PEDIDO_AVANZADO',
        });
      }

      /* ── Validar todo antes de tocar stock ── */
      const errores = [];
      if (!Array.isArray(b.lineas) || b.lineas.length === 0) {
        errores.push({ sku: null, error: 'Agregue al menos un insumo al pedido.' });   // Exc 1
      }
      const lineas = [];
      const vistos = new Set();
      for (const l of Array.isArray(b.lineas) ? b.lineas : []) {
        const sku = String(l?.sku ?? '').trim();
        if (!sku) { errores.push({ sku: null, error: 'Una fila no tiene insumo.' }); continue; }
        if (vistos.has(sku)) { errores.push({ sku, error: 'El insumo viene repetido.' }); continue; }
        vistos.add(sku);
        const txt = String(l?.cantidad ?? '').trim().replace(',', '.');
        if (!CANTIDAD_RE.test(txt) || Number(txt) <= 0 || Number(txt) >= MAX_CANTIDAD) {
          errores.push({ sku, error: 'La cantidad debe ser un número mayor que 0, con hasta 4 decimales.' });
          continue;
        }
        const bodegaId = String(l?.bodega_id ?? '').trim();
        if (!/^\d+$/.test(bodegaId)) { errores.push({ sku, error: 'Seleccione la bodega de la que se reserva.' }); continue; }
        lineas.push({ sku, cantidad: Number(txt), bodegaId, origen: l?.origen === 'receta' ? 'receta' : 'manual' });
      }
      // Bodegas: existen y están activas (D45/D58: la principal de cada insumo)
      const bodegasPedidas = [...new Set(lineas.map(l => l.bodegaId))];
      if (bodegasPedidas.length) {
        const { rows: bods } = await client.query(
          `SELECT bodega_id_bodega::text AS id, bodega_estado AS estado FROM bodega WHERE bodega_id_bodega = ANY($1::bigint[])`,
          [bodegasPedidas]
        );
        const estadoBodega = new Map(bods.map(x => [x.id, x.estado]));
        for (const l of lineas) {
          if (!estadoBodega.has(l.bodegaId)) errores.push({ sku: l.sku, error: 'La bodega no existe.' });
          else if (!['activo', 'activa'].includes(estadoBodega.get(l.bodegaId))) errores.push({ sku: l.sku, error: 'La bodega no está activa.' });
        }
      }
      if (lineas.length) {
        const { rows: mats } = await client.query(
          `SELECT material_sku AS sku, material_estado AS estado, material_es_herramienta AS herramienta
           FROM material WHERE material_sku = ANY($1::text[])`, [lineas.map(l => l.sku)]
        );
        const porSku = new Map(mats.map(m => [m.sku, m]));
        for (const l of lineas) {
          const m = porSku.get(l.sku);
          if (!m) errores.push({ sku: l.sku, error: 'No existe en el catálogo.' });
          else if (m.herramienta) errores.push({ sku: l.sku, error: 'Es una herramienta: no se despacha como insumo.' });
          else if (m.estado !== 'activo') errores.push({ sku: l.sku, error: 'El insumo está inactivo.' });
        }
      }
      if (errores.length) {
        throw new ErrorNegocio(400, {
          error: errores.length === 1
            ? `No se guardó nada: ${errores[0].sku ? errores[0].sku + ' — ' : ''}${errores[0].error}`
            : `No se guardó nada: ${errores.length} problema(s).`,
          errores,
        });
      }

      /* ── Preparación (una por venta) ── */
      let prepId = venta.preparacion_id;
      const nueva = !prepId;
      if (nueva) {
        const { rows } = await client.query(
          `INSERT INTO preparacion_pedido (nota_venta_id_nota_venta, usuario_id_usuario)
           VALUES ($1, $2) RETURNING preparacion_pedido_id_preparacion AS id`, [id, req.user.id]
        );
        prepId = rows[0].id;
        await client.query(
          `INSERT INTO preparacion_pedido_estado (preparacion_pedido_estado_nombre_estado, preparacion_pedido_id_preparacion, usuario_id_usuario)
           VALUES ('vinculado', $1, $2)`, [prepId, req.user.id]
        );
      }

      const { rows: actuales } = await client.query(
        `SELECT preparacion_pedido_detalle_id AS id, material_sku AS sku, bodega_id_bodega::text AS bodega_id
         FROM preparacion_pedido_detalle WHERE preparacion_pedido_id_preparacion = $1`, [prepId]
      );

      // Un insumo que cambia de bodega: se libera lo suyo y se vuelve a reservar en la nueva
      const cambios = [];
      for (const d of actuales) {
        const l = lineas.find(x => x.sku === d.sku);
        if (l && l.bodegaId !== d.bodega_id) {
          await liberarDeItem(client, d.id, await reservadoDe(client, d.id));
          cambios.push(d.sku);
        }
      }

      // Insumos que salen del pedido: se liberan y se quitan
      const quitados = actuales.filter(d => !vistos.has(d.sku));
      for (const d of quitados) {
        await liberarDeItem(client, d.id, await reservadoDe(client, d.id));
        await client.query(`DELETE FROM preparacion_pedido_detalle WHERE preparacion_pedido_detalle_id = $1`, [d.id]);
      }

      // Primero lo que se libera, después lo que se reserva (lo liberado queda disponible)
      const resultado = [];
      const porAjustar = [];
      for (const l of lineas) {
        const { rows } = await client.query(
          `INSERT INTO preparacion_pedido_detalle (preparacion_pedido_id_preparacion, material_sku,
             preparacion_pedido_detalle_cantidad_requerida, preparacion_pedido_detalle_origen, bodega_id_bodega)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (preparacion_pedido_id_preparacion, material_sku)
           DO UPDATE SET preparacion_pedido_detalle_cantidad_requerida = EXCLUDED.preparacion_pedido_detalle_cantidad_requerida,
                         preparacion_pedido_detalle_origen = EXCLUDED.preparacion_pedido_detalle_origen,
                         bodega_id_bodega = EXCLUDED.bodega_id_bodega
           RETURNING preparacion_pedido_detalle_id AS id`, [prepId, l.sku, l.cantidad, l.origen, l.bodegaId]
        );
        porAjustar.push({ ...l, detId: rows[0].id, reservado: await reservadoDe(client, rows[0].id) });
      }
      for (const l of porAjustar.filter(x => x.reservado > x.cantidad + 1e-9)) {
        await liberarDeItem(client, l.detId, l.reservado - l.cantidad);
        l.reservado = l.cantidad;
      }
      for (const l of porAjustar.filter(x => x.reservado < x.cantidad - 1e-9)) {
        l.reservado += await reservarConReparto(client, {
          detId: l.detId, ventaId: id, sku: l.sku, bodegaId: l.bodegaId, cantidad: l.cantidad - l.reservado,
        });
      }
      for (const l of porAjustar) {
        const reservado = Math.round(l.reservado * 10000) / 10000;
        resultado.push({ sku: l.sku, bodega_id: Number(l.bodegaId), requerida: l.cantidad, reservado, faltante: Math.max(0, Math.round((l.cantidad - reservado) * 10000) / 10000) });
      }
      return { venta, nueva, resultado, quitados: quitados.map(q => q.sku), cambios };
    });

    const faltan = r.resultado.filter(x => x.faltante > 0);
    await auditoria.registrar(req.user.id, 'Vincular insumos a pedido',
      `${r.venta.numero}${r.nueva ? '' : ' (modificación)'}: ` +
      r.resultado.map(x => `${x.sku} ${x.reservado}/${x.requerida}`).join(', ') +
      (r.quitados.length ? ` · quitados: ${r.quitados.join(', ')}` : ''));

    res.json({
      message: (r.nueva ? `Insumos vinculados a la venta ${r.venta.numero}.` : `Vinculación de la venta ${r.venta.numero} actualizada.`) +
        (faltan.length ? ` ${faltan.length} insumo(s) quedaron con faltante: la vinculación es parcial.` : ''),
      parcial: faltan.length > 0,
      lineas: r.resultado,
      quitados: r.quitados,
    });
  } catch (err) {
    // Dos vinculaciones simultáneas de la misma venta: el índice único deja pasar una
    if (err.code === '23505' && err.constraint === 'uk_prep_ped_venta') {
      return res.status(409).json({ error: 'Otra persona acaba de vincular esta venta. Recargue para ver la vinculación vigente.', codigo: 'VINCULACION_SIMULTANEA' });
    }
    responderError(res, err, 'Error vinculando insumos al pedido:');
  }
}

/**
 * PUT /api/pedidos-venta/:id/preparado   (gerencia y jop) — CU-119
 * Marca el pedido "Preparado para despacho". El checklist es el de sus insumos de
 * instalación: cada uno reservado completo (sesión 12). Valida todo antes de escribir:
 *   Exc 1: sin insumos vinculados → 400.   Exc 3: ya preparado o posterior → 409 con la fecha.
 *   Exc 2: algún insumo con faltante, o un lote reservado con menos físico que lo reservado → 400.
 * "Bloquea los lotes": las reservas de CU-120 ya los bloquean; desde aquí CU-120 no modifica
 * la vinculación y Reservas no libera ni anula sus reservas.
 */
async function marcarPreparado(req, res) {
  const { id } = req.params;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la venta debe ser numérico' });
  try {
    const r = await conTransaccion(async (client) => {
      const venta = await cabecera(client, id);
      if (!venta) throw new ErrorNegocio(404, { error: 'Venta no encontrada' });
      if (!venta.preparacion_id) {
        throw new ErrorNegocio(400, {
          error: `La venta ${venta.numero} no tiene insumos vinculados. Vincule los insumos antes de marcar el pedido como preparado.`,
          codigo: 'SIN_VINCULAR',
        });
      }
      await client.query(`SELECT 1 FROM preparacion_pedido WHERE preparacion_pedido_id_preparacion = $1 FOR UPDATE`, [venta.preparacion_id]);

      // Exc 3: ya preparado o posterior
      const { rows: prep } = await client.query(
        `SELECT e.preparacion_pedido_estado_timestamp_accion AS fecha, u.usuario_username AS usuario
         FROM preparacion_pedido_estado e LEFT JOIN usuario u ON u.usuario_id_usuario = e.usuario_id_usuario
         WHERE e.preparacion_pedido_id_preparacion = $1 AND e.preparacion_pedido_estado_nombre_estado = 'preparado'
         ORDER BY e.preparacion_pedido_estado_timestamp_accion DESC LIMIT 1`, [venta.preparacion_id]
      );
      if (venta.estado_despacho && venta.estado_despacho !== 'vinculado') {
        throw new ErrorNegocio(409, {
          error: `El pedido ${venta.numero} ya está "${venta.estado_despacho}".`,
          codigo: 'YA_PREPARADO',
          fecha_preparado: prep[0]?.fecha ?? null,
          preparado_por: prep[0]?.usuario ?? null,
        });
      }
      if (!venta.vinculable) {
        throw new ErrorNegocio(400, { error: `La venta ${venta.numero} está "${venta.estado_pedido}": no se prepara para despacho.` });
      }

      // Exc 1 (sin ítems) y Exc 2 (faltantes por ítem)
      const { rows: items } = await client.query(
        `SELECT d.material_sku AS sku, d.preparacion_pedido_detalle_cantidad_requerida::float AS requerida,
                ${reservadoSQL('d')}::float AS reservado
         FROM preparacion_pedido_detalle d WHERE d.preparacion_pedido_id_preparacion = $1 ORDER BY 1`,
        [venta.preparacion_id]
      );
      if (!items.length) {
        throw new ErrorNegocio(400, {
          error: `La venta ${venta.numero} no tiene insumos vinculados. Vincule los insumos antes de marcar el pedido como preparado.`,
          codigo: 'SIN_VINCULAR',
        });
      }
      const faltantes = items.filter(i => i.reservado < i.requerida - 1e-9)
        .map(i => ({ sku: i.sku, faltante: Math.round((i.requerida - i.reservado) * 10000) / 10000,
                     motivo: 'lo reservado no cubre lo pedido' }));
      // Un lote reservado cuyo físico bajó por debajo de lo reservado (ajuste, conteo...)
      const { rows: lotes } = await client.query(
        `SELECT DISTINCT ri.material_sku AS sku, l.lote_numero_lote AS lote,
                (ib.inventario_bodega_cantidad_reservada - ib.inventario_bodega_cantidad_fisica)::float AS faltante
         FROM preparacion_pedido_detalle d
         JOIN reserva_inventario ri ON ri.preparacion_pedido_detalle_id = d.preparacion_pedido_detalle_id
                                   AND ri.reserva_inventario_estado_reserva = 'activa'
         JOIN inventario_bodega ib ON ib.material_sku = ri.material_sku AND ib.lote_id_lote = ri.lote_id_lote
                                  AND ib.bodega_id_bodega = ri.bodega_id_bodega
         JOIN lote l ON l.lote_id_lote = ri.lote_id_lote
         WHERE d.preparacion_pedido_id_preparacion = $1
           AND ib.inventario_bodega_cantidad_fisica < ib.inventario_bodega_cantidad_reservada`,
        [venta.preparacion_id]
      );
      for (const l of lotes) faltantes.push({ sku: l.sku, faltante: l.faltante, motivo: `el lote ${l.lote} tiene menos stock físico que lo reservado` });
      if (faltantes.length) {
        throw new ErrorNegocio(400, {
          error: `No se puede marcar como preparado: ${faltantes.map(f => `${f.sku} (faltan ${f.faltante}: ${f.motivo})`).join('; ')}. ` +
                 'Resuelva los faltantes (ajuste la vinculación o reponga stock) y vuelva a intentarlo.',
          codigo: 'FALTANTES',
          faltantes,
        });
      }

      await client.query(
        `INSERT INTO preparacion_pedido_estado (preparacion_pedido_estado_nombre_estado, preparacion_pedido_id_preparacion, usuario_id_usuario)
         VALUES ('preparado', $1, $2)`, [venta.preparacion_id, req.user.id]
      );
      return { venta, items: items.length };
    });

    await auditoria.registrar(req.user.id, 'Pedido preparado para despacho', `${r.venta.numero}: ${r.items} insumo(s)`);
    res.json({ message: `Pedido ${r.venta.numero} marcado como preparado para despacho.` });
  } catch (err) {
    responderError(res, err, 'Error marcando el pedido como preparado:');
  }
}

const r4 = (x) => Math.round(x * 10000) / 10000;

/** Bloquea el pedido (FOR UPDATE) y lee su estado de despacho vigente, ya con el bloqueo. */
async function bloquearYLeerEstado(client, prepId) {
  await client.query(`SELECT 1 FROM preparacion_pedido WHERE preparacion_pedido_id_preparacion = $1 FOR UPDATE`, [prepId]);
  const { rows } = await client.query(
    `SELECT preparacion_pedido_estado_nombre_estado AS estado FROM preparacion_pedido_estado
     WHERE preparacion_pedido_id_preparacion = $1
     ORDER BY preparacion_pedido_estado_timestamp_accion DESC, preparacion_pedido_estado_id_estado_preparacion DESC LIMIT 1`,
    [prepId]
  );
  return rows[0]?.estado || 'vinculado';
}

/**
 * CU-126: valida la venta, el estado del pedido y el ítem, con el pedido y el ítem
 * bloqueados (FOR UPDATE). Solo se retira en un pedido "preparado".
 */
async function itemParaRetiro(client, id, sku) {
  const venta = await cabecera(client, id);
  if (!venta) throw new ErrorNegocio(404, { error: 'Venta no encontrada' });
  if (!venta.preparacion_id) {
    throw new ErrorNegocio(400, { error: `La venta ${venta.numero} no tiene insumos vinculados.`, codigo: 'SIN_VINCULAR' });
  }
  const estado = await bloquearYLeerEstado(client, venta.preparacion_id);
  if (estado === 'vinculado') {
    throw new ErrorNegocio(400, {
      error: `El pedido ${venta.numero} todavía no está preparado para despacho: márquelo como preparado antes de retirar sus insumos.`,
      codigo: 'NO_PREPARADO',
    });
  }
  if (estado !== 'preparado') {
    throw new ErrorNegocio(409, { error: `El pedido ${venta.numero} ya está "${estado}": el retiro está cerrado.`, codigo: 'PEDIDO_AVANZADO' });
  }

  const { rows } = await client.query(
    `SELECT d.preparacion_pedido_detalle_id AS id, d.material_sku AS sku, m.material_nombre_material AS nombre,
            d.bodega_id_bodega AS bodega_id, b.bodega_nombre_bodega AS bodega,
            d.preparacion_pedido_detalle_cantidad_requerida::float AS requerida,
            COALESCE(d.preparacion_pedido_detalle_cantidad_retirada, 0)::float AS retirada,
            d.preparacion_pedido_detalle_fecha_retiro AS fecha_retiro, d.usuario_id_retiro AS usuario_retiro
     FROM preparacion_pedido_detalle d
     JOIN material m ON m.material_sku = d.material_sku
     JOIN bodega b ON b.bodega_id_bodega = d.bodega_id_bodega
     WHERE d.preparacion_pedido_id_preparacion = $1 AND d.material_sku = $2
     FOR UPDATE OF d`,
    [venta.preparacion_id, sku]
  );
  if (!rows.length) throw new ErrorNegocio(404, { error: `El insumo ${sku} no pertenece al pedido ${venta.numero}.` });
  const item = rows[0];
  // D58: las bodegas donde está reservado (la principal primero), para los mensajes y alertas
  const { rows: bods } = await client.query(
    `SELECT b.bodega_nombre_bodega AS nombre
     FROM reserva_inventario ri JOIN bodega b ON b.bodega_id_bodega = ri.bodega_id_bodega
     WHERE ri.preparacion_pedido_detalle_id = $1 AND ri.reserva_inventario_estado_reserva = 'activa'
     GROUP BY b.bodega_id_bodega, b.bodega_nombre_bodega
     ORDER BY (b.bodega_id_bodega <> $2), b.bodega_nombre_bodega`, [item.id, item.bodega_id]
  );
  if (bods.length) item.bodega = enumerar(bods.map(x => x.nombre));

  // Exc 2: ya retirado completo (por otro operador, o por el mismo en otra pestaña)
  if (item.retirada >= item.requerida - 1e-9) {
    const { rows: u } = await client.query(`SELECT usuario_username AS u FROM usuario WHERE usuario_id_usuario = $1`, [item.usuario_retiro]);
    throw new ErrorNegocio(409, {
      error: `${item.nombre} (${sku}) ya fue retirado.`,
      codigo: 'YA_RETIRADO',
      retirado_por: u[0]?.u ?? null,
      fecha_retiro: item.fecha_retiro,
    });
  }
  return { venta, item };
}

/**
 * Sesión 15: las alertas del retiro no guardan la venta; su mensaje SIEMPRE empieza con
 * este prefijo, que es lo que permite cerrarlas al completar el retiro (cerrarAlertasRetiro).
 * Crear y cerrar usan esta misma función: no escribir el prefijo a mano.
 */
const prefijoAlertaRetiro = (numeroVenta) => `Venta ${numeroVenta}:`;

/**
 * Sesión 15: al completarse el retiro de un insumo se resuelven sus alertas activas de
 * faltante en retiro y de ubicación incorrecta (esa venta y ese SKU). Devuelve cuántas.
 */
async function cerrarAlertasRetiro(client, numeroVenta, sku) {
  const prefijo = prefijoAlertaRetiro(numeroVenta);
  const { rows } = await client.query(
    `SELECT a.alerta_inventario_id_alerta AS id
     FROM alerta_inventario a
     JOIN alerta_inventario_tipo_alerta t ON t.alerta_inventario_tipo_alerta_id_tipo_alerta = a.alerta_inventario_tipo_alerta_id_tipo_alerta
     WHERE a.material_sku = $1 AND a.alerta_inventario_estado = 'activa'
       AND LOWER(REPLACE(t.alerta_inventario_tipo_alerta_nombre, '_', ' ')) = ANY($2::text[])
       AND LEFT(a.alerta_inventario_mensaje, LENGTH($3)) = $3
     FOR UPDATE OF a`,
    [sku, TIPOS_RETIRO, prefijo]
  );
  await resolverAlertas(client, rows.map(x => x.id));
  return rows.length;
}

/** Alerta del retiro (CU-126) en alerta_inventario, con su historial. Devuelve el id. */
async function crearAlertaRetiro(client, { tipo, sku, bodegaId, mensaje, diferencia, usuarioId }) {
  const { rows: t } = await client.query(
    `SELECT alerta_inventario_tipo_alerta_id_tipo_alerta AS id FROM alerta_inventario_tipo_alerta
     WHERE LOWER(REPLACE(alerta_inventario_tipo_alerta_nombre, '_', ' ')) = $1`, [tipo]
  );
  if (!t.length) throw new Error(`Falta el tipo de alerta "${tipo}" en el catálogo`);
  const { rows: hist } = await client.query(`INSERT INTO historial_alerta DEFAULT VALUES RETURNING historial_alerta_id_historial AS id`);
  const { rows } = await client.query(
    `INSERT INTO alerta_inventario (alerta_inventario_mensaje, alerta_inventario_estado, material_sku,
       alerta_inventario_tipo_alerta_id_tipo_alerta, historial_alerta_id_historial, bodega_id_bodega,
       alerta_inventario_diferencia, usuario_id_usuario)
     VALUES ($1, 'activa', $2, $3, $4, $5, $6, $7) RETURNING alerta_inventario_id_alerta AS id`,
    [mensaje, sku, t[0].id, hist[0].id, bodegaId, diferencia, usuarioId]
  );
  return rows[0].id;
}

/**
 * PUT /api/pedidos-venta/:id/retiro/:sku   (gerencia y jop) — CU-126
 * Body: { cantidad }. Registra lo que se sacó del anaquel (D46: por insumo). La cantidad se
 * acumula; la hora y el usuario quedan con el último retiro. NO mueve stock: la reserva
 * sigue activa hasta la salida (CU-127, D20).
 *   Exc 2: ya retirado completo → 409 con quién y cuándo.
 *   Exc 3: menos que lo pendiente → retiro parcial + alerta "faltante en retiro" + aviso a gerencia.
 */
async function registrarRetiro(req, res) {
  const { id, sku } = req.params;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la venta debe ser numérico' });
  const txt = String(req.body?.cantidad ?? '').trim().replace(',', '.');
  if (!CANTIDAD_RE.test(txt) || Number(txt) <= 0 || Number(txt) >= MAX_CANTIDAD) {
    return res.status(400).json({ error: 'La cantidad retirada debe ser un número mayor que 0, con hasta 4 decimales.' });
  }
  const cantidad = Number(txt);

  try {
    const r = await conTransaccion(async (client) => {
      const { venta, item } = await itemParaRetiro(client, id, sku);
      const pendiente = r4(item.requerida - item.retirada);
      if (cantidad > pendiente + 1e-9) {
        throw new ErrorNegocio(400, { error: `No se puede retirar más de lo pendiente: quedan ${pendiente} de ${item.nombre}.` });
      }
      const retirada = r4(item.retirada + cantidad);
      await client.query(
        `UPDATE preparacion_pedido_detalle
         SET preparacion_pedido_detalle_cantidad_retirada = $2, preparacion_pedido_detalle_fecha_retiro = now(), usuario_id_retiro = $3
         WHERE preparacion_pedido_detalle_id = $1`,
        [item.id, retirada, req.user.id]
      );
      const faltante = r4(item.requerida - retirada);
      let alertaId = null;
      if (faltante > 0) {
        alertaId = await crearAlertaRetiro(client, {
          tipo: TIPO_FALTANTE_RETIRO, sku, bodegaId: item.bodega_id, diferencia: -faltante, usuarioId: req.user.id,
          mensaje: `${prefijoAlertaRetiro(venta.numero)} retiro parcial de ${item.nombre} en ${item.bodega}. Se retiraron ${retirada} de ` +
                   `${item.requerida}; faltan ${faltante}. Reponga o ubique el material: el pedido no se puede cargar hasta completarlo.`,
        });
      }
      // Sesión 15: completo el retiro, sus alertas (faltante, ubicación) ya no aplican
      const cerradas = faltante > 0 ? 0 : await cerrarAlertasRetiro(client, venta.numero, sku);
      return { venta, item, retirada, faltante, alertaId, cerradas };
    });

    await auditoria.registrar(req.user.id, 'Retiro de insumo (picking)',
      `${r.venta.numero}: ${sku} ${r.retirada}/${r.item.requerida}${r.faltante > 0 ? ` (parcial, alerta #${r.alertaId})` : ''}` +
      (r.cerradas ? ` · ${r.cerradas} alerta(s) del retiro resuelta(s)` : ''));
    if (r.alertaId) {
      await notificarPorRol({
        tipo: 'faltante_retiro', origen: 'pedidos_instalacion', alertaId: r.alertaId, rol: 'gerencia',
        mensaje: `Retiro parcial en la venta ${r.venta.numero}: faltan ${r.faltante} de ${r.item.nombre} en ${r.item.bodega}.`,
      });
    }
    res.json({
      message: r.faltante > 0
        ? `Retiro parcial de ${r.item.nombre}: ${r.retirada} de ${r.item.requerida}. Faltan ${r.faltante}; se generó una alerta para su reposición.`
        : `${r.item.nombre} retirado (${r.retirada}).` + (r.cerradas ? ` Se resolvieron ${r.cerradas} alerta(s) de su retiro.` : ''),
      parcial: r.faltante > 0,
      retirada: r.retirada,
      faltante: r.faltante,
    });
  } catch (err) {
    responderError(res, err, 'Error registrando el retiro:');
  }
}

/**
 * POST /api/pedidos-venta/:id/retiro/:sku/ubicacion   (gerencia y jop) — CU-126 Exc 1
 * Body: { observacion? }. El insumo no está donde indica el sistema: alerta "ubicacion
 * incorrecta" con la bodega y los anaqueles indicados, y aviso a gerencia. El ítem sigue pendiente.
 */
async function reportarUbicacion(req, res) {
  const { id, sku } = req.params;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la venta debe ser numérico' });
  const observacion = String(req.body?.observacion ?? '').trim();
  if (observacion.length > 500) return res.status(400).json({ error: 'La observación admite hasta 500 caracteres.' });

  try {
    const r = await conTransaccion(async (client) => {
      const { venta, item } = await itemParaRetiro(client, id, sku);
      const { rows: ubic } = await client.query(
        `SELECT DISTINCT bu.bodega_nombre_bodega || ': ' || COALESCE(an.anaquel_descripcion, 'sin anaquel')
                         || ' (lote ' || COALESCE(l.lote_numero_lote, '—') || ')' AS u
         FROM reserva_inventario ri
         JOIN lote l ON l.lote_id_lote = ri.lote_id_lote
         JOIN bodega bu ON bu.bodega_id_bodega = ri.bodega_id_bodega
         LEFT JOIN inventario_bodega ib ON ib.material_sku = ri.material_sku AND ib.lote_id_lote = ri.lote_id_lote
                                       AND ib.bodega_id_bodega = ri.bodega_id_bodega
         LEFT JOIN anaquel an ON an.anaquel_id_anaquel = ib.anaquel_id_anaquel
         WHERE ri.preparacion_pedido_detalle_id = $1 AND ri.reserva_inventario_estado_reserva = 'activa'
         ORDER BY 1`, [item.id]
      );
      const donde = ubic.length ? ubic.map(x => x.u).join(', ') : `${item.bodega}: sin ubicación registrada`;
      const alertaId = await crearAlertaRetiro(client, {
        tipo: TIPO_UBICACION_INCORRECTA, sku, bodegaId: item.bodega_id, diferencia: null, usuarioId: req.user.id,
        mensaje: `${prefijoAlertaRetiro(venta.numero)} ${item.nombre} no está en la ubicación indicada (${donde}).` +
                 (observacion ? ` Observación: ${observacion}` : ''),
      });
      return { venta, item, alertaId };
    });

    await auditoria.registrar(req.user.id, 'Ubicación incorrecta (picking)', `${r.venta.numero}: ${sku}, alerta #${r.alertaId}`);
    await notificarPorRol({
      tipo: 'ubicacion_incorrecta', origen: 'pedidos_instalacion', alertaId: r.alertaId, rol: 'gerencia',
      mensaje: `Venta ${r.venta.numero}: ${r.item.nombre} no está en la ubicación indicada en ${r.item.bodega}. Revise el panel de alertas.`,
    });
    res.status(201).json({
      message: `Se reportó la ubicación incorrecta de ${r.item.nombre} (alerta #${r.alertaId}). El insumo sigue pendiente de retiro.`,
      alerta_id: r.alertaId,
    });
  } catch (err) {
    responderError(res, err, 'Error reportando la ubicación:');
  }
}

/* ── CU-125: carga en transporte (D47: el responsable es un empleado; se muestra su nombre, nunca el RUT) ── */

const NOMBRE_EMPLEADO_SQL = (e) => `NULLIF(TRIM(CONCAT_WS(' ', ${e}.empleado_nombre_empleado_primer_nombre_empleado,
                                                        ${e}.empleado_nombre_empleado_primer_apellido_empleado)), '')`;

/** Responsables de la carga vigente del pedido, en orden (una fila 'en_carga' por responsable). Sin RUT. */
async function responsablesDeCarga(db, prepId) {
  const { rows } = await db.query(
    `SELECT COALESCE(${NOMBRE_EMPLEADO_SQL('emp')}, 'Empleado no encontrado') AS nombre, c.empleado_cargo_nombre AS cargo,
            e.preparacion_pedido_estado_timestamp_accion AS fecha, u.usuario_username AS registrado_por
     FROM preparacion_pedido_estado e
     LEFT JOIN finanzas.empleado emp ON emp.empleado_rut_empleado = e.empleado_rut
     LEFT JOIN finanzas.empleado_cargo c ON c.empleado_cargo_id_cargo = emp.empleado_cargo_id_cargo
     LEFT JOIN usuario u ON u.usuario_id_usuario = e.usuario_id_usuario
     WHERE e.preparacion_pedido_id_preparacion = $1 AND e.preparacion_pedido_estado_nombre_estado = 'en_carga'
       AND ${DESDE_ULTIMA_VINCULACION('e')}
     ORDER BY e.preparacion_pedido_estado_timestamp_accion, e.preparacion_pedido_estado_id_estado_preparacion`,
    [prepId]
  );
  return rows;
}

/**
 * GET /api/pedidos-venta/empleados   (gerencia y jop) — CU-125
 * Empleados activos (finanzas.empleado, solo lectura) para elegir al responsable de la carga.
 * El RUT viaja solo como valor del selector: la pantalla muestra el nombre (y el cargo).
 */
async function empleados(req, res) {
  try {
    const { rows } = await query(
      `SELECT e.empleado_rut_empleado AS rut, ${NOMBRE_EMPLEADO_SQL('e')} AS nombre, c.empleado_cargo_nombre AS cargo
       FROM finanzas.empleado e
       LEFT JOIN finanzas.empleado_cargo c ON c.empleado_cargo_id_cargo = e.empleado_cargo_id_cargo
       WHERE e.empleado_estado = 'activo'
       ORDER BY e.empleado_nombre_empleado_primer_nombre_empleado, e.empleado_nombre_empleado_primer_apellido_empleado`
    );
    res.json(rows);
  } catch (err) {
    responderError(res, err, 'Error listando empleados:');
  }
}

/**
 * POST /api/pedidos-venta/:id/carga   (gerencia y jop) — CU-125
 * Body: { empleado_rut, sumar? }. Registra el inicio de la carga: una fila 'en_carga' con el
 * trabajador, la hora y el usuario que lo registra. Valida todo antes de escribir:
 *   Exc 3: insumos sin retirar (CU-126) → 400 con la lista.
 *   Exc 1: empleado inexistente o no activo → 400.
 *   Exc 2: carga ya iniciada → 409 con los responsables; con `sumar` se agrega otro (nunca se reemplaza).
 */
async function iniciarCarga(req, res) {
  const { id } = req.params;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la venta debe ser numérico' });
  const rut = String(req.body?.empleado_rut ?? '').trim();
  const sumar = req.body?.sumar === true;
  if (!rut) return res.status(400).json({ error: 'Seleccione el trabajador responsable de la carga.' });

  try {
    const r = await conTransaccion(async (client) => {
      const venta = await cabecera(client, id);
      if (!venta) throw new ErrorNegocio(404, { error: 'Venta no encontrada' });
      if (!venta.preparacion_id) {
        throw new ErrorNegocio(400, { error: `La venta ${venta.numero} no tiene insumos vinculados.`, codigo: 'SIN_VINCULAR' });
      }
      const estado = await bloquearYLeerEstado(client, venta.preparacion_id);
      if (estado === 'vinculado') {
        throw new ErrorNegocio(400, {
          error: `El pedido ${venta.numero} todavía no está preparado para despacho ni retirado de bodega.`, codigo: 'NO_PREPARADO',
        });
      }
      if (!['preparado', 'en_carga'].includes(estado)) {
        throw new ErrorNegocio(409, { error: `El pedido ${venta.numero} ya está "${estado}": la carga está cerrada.`, codigo: 'PEDIDO_AVANZADO' });
      }
      if (!venta.vinculable) {
        throw new ErrorNegocio(400, { error: `La venta ${venta.numero} está "${venta.estado_pedido}": no se despacha.` });
      }

      // Exc 3: todos los insumos retirados completos (CU-126)
      const { rows: pendientes } = await client.query(
        `SELECT d.material_sku AS sku, m.material_nombre_material AS nombre,
                (d.preparacion_pedido_detalle_cantidad_requerida - COALESCE(d.preparacion_pedido_detalle_cantidad_retirada, 0))::float AS pendiente
         FROM preparacion_pedido_detalle d JOIN material m ON m.material_sku = d.material_sku
         WHERE d.preparacion_pedido_id_preparacion = $1
           AND COALESCE(d.preparacion_pedido_detalle_cantidad_retirada, 0) < d.preparacion_pedido_detalle_cantidad_requerida
         ORDER BY m.material_nombre_material`, [venta.preparacion_id]
      );
      if (pendientes.length) {
        throw new ErrorNegocio(400, {
          error: `No se puede iniciar la carga: faltan por retirar ${pendientes.map(p => `${p.nombre} (${r4(p.pendiente)})`).join(', ')}.`,
          codigo: 'RETIRO_PENDIENTE',
          pendientes: pendientes.map(p => ({ ...p, pendiente: r4(p.pendiente) })),
        });
      }

      // Exc 1: empleado registrado y activo
      const { rows: emp } = await client.query(
        `SELECT ${NOMBRE_EMPLEADO_SQL('e')} AS nombre, e.empleado_estado AS estado
         FROM finanzas.empleado e WHERE e.empleado_rut_empleado = $1`, [rut]
      );
      if (!emp.length || emp[0].estado !== 'activo') {
        throw new ErrorNegocio(400, {
          error: 'El trabajador no corresponde a un empleado registrado y activo. Seleccione un trabajador válido.', codigo: 'EMPLEADO_INVALIDO',
        });
      }

      // Exc 2: carga ya iniciada → se muestra y se permite sumar
      if (estado === 'en_carga') {
        const responsables = await responsablesDeCarga(client, venta.preparacion_id);
        const { rowCount: yaEs } = await client.query(
          `SELECT 1 FROM preparacion_pedido_estado e
           WHERE e.preparacion_pedido_id_preparacion = $1 AND e.preparacion_pedido_estado_nombre_estado = 'en_carga'
             AND e.empleado_rut = $2 AND ${DESDE_ULTIMA_VINCULACION('e')}`,
          [venta.preparacion_id, rut]
        );
        if (yaEs) {
          throw new ErrorNegocio(409, { error: `${emp[0].nombre} ya es responsable de esta carga.`, codigo: 'YA_RESPONSABLE', responsables });
        }
        if (!sumar) {
          throw new ErrorNegocio(409, {
            error: `La carga del pedido ${venta.numero} ya está iniciada. Puede sumar a ${emp[0].nombre} como otro responsable.`,
            codigo: 'CARGA_INICIADA', responsables,
          });
        }
      }

      await client.query(
        `INSERT INTO preparacion_pedido_estado (preparacion_pedido_estado_nombre_estado, preparacion_pedido_id_preparacion,
           usuario_id_usuario, empleado_rut) VALUES ('en_carga', $1, $2, $3)`,
        [venta.preparacion_id, req.user.id, rut]
      );
      return { venta, nombre: emp[0].nombre, sumado: estado === 'en_carga' };
    });

    await auditoria.registrar(req.user.id, r.sumado ? 'Responsable de carga sumado' : 'Inicio de carga',
      `${r.venta.numero}: ${r.nombre}`);
    res.status(201).json({
      message: r.sumado
        ? `${r.nombre} se sumó como responsable de la carga del pedido ${r.venta.numero}.`
        : `Carga del pedido ${r.venta.numero} iniciada. Responsable: ${r.nombre}.`,
    });
  } catch (err) {
    responderError(res, err, 'Error registrando la carga:');
  }
}

/* ── CU-127: confirmación de carga y salida del transporte ── */

const MOTIVO_DESPACHO = 'despacho_venta';

/** Despacho registrado (o null): fecha, usuario, observación y las salidas que generó. */
async function datosDespacho(db, prepId, numeroVenta) {
  const { rows: est } = await db.query(
    `SELECT e.preparacion_pedido_estado_timestamp_accion AS fecha, u.usuario_username AS usuario, pp.preparacion_pedido_observacion AS observacion
     FROM preparacion_pedido_estado e
     JOIN preparacion_pedido pp ON pp.preparacion_pedido_id_preparacion = e.preparacion_pedido_id_preparacion
     LEFT JOIN usuario u ON u.usuario_id_usuario = e.usuario_id_usuario
     WHERE e.preparacion_pedido_id_preparacion = $1 AND e.preparacion_pedido_estado_nombre_estado = 'en_transito'
     ORDER BY e.preparacion_pedido_estado_timestamp_accion LIMIT 1`, [prepId]
  );
  if (!est.length) return null;
  const { rows: movimientos } = await db.query(
    `SELECT mi.movimiento_inventario_id_movimiento::int AS id, mi.material_sku AS sku, m.material_nombre_material AS nombre,
            l.lote_numero_lote AS lote, b.bodega_nombre_bodega AS bodega, mi.movimiento_inventario_cantidad::float AS cantidad,
            mi.movimiento_inventario_estado AS estado
     FROM movimiento_inventario mi
     JOIN movimiento_inventario_motivo_movimiento mot
          ON mot.movimiento_inventario_motivo_movimiento_id_motivo_movimiento = mi.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
     JOIN material m ON m.material_sku = mi.material_sku
     LEFT JOIN lote l ON l.lote_id_lote = mi.lote_id_lote
     LEFT JOIN bodega b ON b.bodega_id_bodega = mi.bodega_id_bodega
     WHERE mot.movimiento_inventario_motivo_movimiento_nombre = $1 AND mi.movimiento_inventario_referencia_origen = $2
       AND mi.movimiento_inventario_id_revertido IS NULL
     ORDER BY m.material_nombre_material, mi.movimiento_inventario_id_movimiento`, [MOTIVO_DESPACHO, numeroVenta]
  );
  return { ...est[0], movimientos };
}

/**
 * PUT /api/pedidos-venta/:id/salida   (gerencia y jop) — CU-127
 * Body: { observacion? }. El pedido sale hacia el cliente: estado 'en_transito' y la salida
 * DEFINITIVA de inventario. Por cada reserva activa del pedido (lote y bodega exactos: la
 * reserva ya eligió el lote), en UNA transacción:
 *   inventario_bodega: físico − cantidad y reservado − cantidad; movimiento de salida con el
 *   motivo 'despacho_venta' (cuenta como consumo); la reserva queda 'liberada' (D20).
 * Todo se valida antes de tocar stock:
 *   Exc 1: sin carga iniciada (CU-125) → 400.   Exc 2: ya despachado → 409 con la fecha.
 *   Retiro incompleto, reservas que no cubren lo pedido o un lote con menos físico que lo
 *   reservado → 400 con el detalle.
 */
async function confirmarSalida(req, res) {
  const { id } = req.params;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la venta debe ser numérico' });
  const observacion = String(req.body?.observacion ?? '').trim();
  if (observacion.length > 1000) return res.status(400).json({ error: 'La observación admite hasta 1000 caracteres.' });

  try {
    const r = await conTransaccion(async (client) => {
      const venta = await cabecera(client, id);
      if (!venta) throw new ErrorNegocio(404, { error: 'Venta no encontrada' });
      if (!venta.preparacion_id) {
        throw new ErrorNegocio(400, { error: `La venta ${venta.numero} no tiene insumos vinculados.`, codigo: 'SIN_VINCULAR' });
      }
      const estado = await bloquearYLeerEstado(client, venta.preparacion_id);

      // Exc 2: ya despachado
      if (estado === 'en_transito') {
        const d = await datosDespacho(client, venta.preparacion_id, venta.numero);
        throw new ErrorNegocio(409, {
          error: `El pedido ${venta.numero} ya fue despachado: la salida ya está registrada.`,
          codigo: 'YA_DESPACHADO', fecha_despacho: d?.fecha ?? null, despachado_por: d?.usuario ?? null,
        });
      }
      // Exc 1: sin carga iniciada
      if (estado !== 'en_carga') {
        throw new ErrorNegocio(400, {
          error: `El pedido ${venta.numero} no tiene la carga iniciada: registre primero el responsable de la carga.`,
          codigo: 'SIN_CARGA',
        });
      }
      if (!venta.vinculable) {
        throw new ErrorNegocio(400, { error: `La venta ${venta.numero} está "${venta.estado_pedido}": no se despacha.` });
      }

      /* ── Validar todo antes de tocar stock ── */
      const { rows: items } = await client.query(
        `SELECT d.preparacion_pedido_detalle_id AS id, d.material_sku AS sku, m.material_nombre_material AS nombre,
                d.preparacion_pedido_detalle_cantidad_requerida::float AS requerida,
                COALESCE(d.preparacion_pedido_detalle_cantidad_retirada, 0)::float AS retirada,
                ${reservadoSQL('d')}::float AS reservado
         FROM preparacion_pedido_detalle d JOIN material m ON m.material_sku = d.material_sku
         WHERE d.preparacion_pedido_id_preparacion = $1 ORDER BY m.material_nombre_material`, [venta.preparacion_id]
      );
      const problemas = [];
      for (const i of items) {
        if (i.retirada < i.requerida - 1e-9) problemas.push(`${i.nombre}: retiro incompleto (${r4(i.retirada)} de ${i.requerida})`);
        if (Math.abs(i.reservado - i.requerida) > 1e-9) problemas.push(`${i.nombre}: reservado ${r4(i.reservado)} de ${i.requerida}`);
      }
      const { rows: reservas } = await client.query(
        `SELECT ri.reserva_inventario_id_reserva AS id, ri.material_sku AS sku, ri.lote_id_lote AS lote_id, ri.bodega_id_bodega AS bodega_id,
                ri.reserva_inventario_cantidad_reservada::float AS cantidad, l.lote_numero_lote AS lote,
                ib.inventario_bodega_cantidad_fisica::float AS fisica, ib.inventario_bodega_cantidad_reservada::float AS reservada_lote
         FROM reserva_inventario ri
         JOIN preparacion_pedido_detalle d ON d.preparacion_pedido_detalle_id = ri.preparacion_pedido_detalle_id
         JOIN lote l ON l.lote_id_lote = ri.lote_id_lote
         JOIN inventario_bodega ib ON ib.material_sku = ri.material_sku AND ib.lote_id_lote = ri.lote_id_lote
                                  AND ib.bodega_id_bodega = ri.bodega_id_bodega
         WHERE d.preparacion_pedido_id_preparacion = $1 AND ri.reserva_inventario_estado_reserva = 'activa'
         ORDER BY ri.material_sku, l.lote_fecha_ingreso, ri.reserva_inventario_id_reserva
         FOR UPDATE OF ri, ib`, [venta.preparacion_id]
      );
      // Una reserva cuyo lote ya no está en inventario_bodega quedaría fuera del JOIN: se detecta aquí
      const { rows: total } = await client.query(
        `SELECT COUNT(*)::int AS n FROM reserva_inventario ri
         JOIN preparacion_pedido_detalle d ON d.preparacion_pedido_detalle_id = ri.preparacion_pedido_detalle_id
         WHERE d.preparacion_pedido_id_preparacion = $1 AND ri.reserva_inventario_estado_reserva = 'activa'`, [venta.preparacion_id]
      );
      if (total[0].n !== reservas.length) problemas.push('hay reservas cuyo lote ya no tiene registro de stock en su bodega');
      // Por lote: lo que sale de este pedido no puede superar el físico ni lo reservado del lote
      const porLote = new Map();
      for (const x of reservas) {
        const k = `${x.sku}|${x.lote_id}|${x.bodega_id}`;
        const acc = porLote.get(k) || { ...x, total: 0 };
        acc.total += x.cantidad;
        porLote.set(k, acc);
      }
      for (const x of porLote.values()) {
        if (x.fisica < x.total - 1e-9) {
          problemas.push(`${x.sku}: el lote ${x.lote} tiene ${r4(x.fisica)} en stock y el pedido saca ${r4(x.total)}`);
        } else if (x.reservada_lote < x.total - 1e-9) {
          problemas.push(`${x.sku}: el lote ${x.lote} tiene ${r4(x.reservada_lote)} reservado y el pedido saca ${r4(x.total)}`);
        }
      }
      if (!items.length || !reservas.length) problemas.push('el pedido no tiene insumos reservados');
      if (problemas.length) {
        throw new ErrorNegocio(400, {
          error: `No se puede confirmar la salida: ${problemas.join('; ')}. Revise el pedido antes de despachar.`,
          codigo: 'INCONSISTENTE', problemas,
        });
      }

      const tipoSalida = await tipoMovimientoId(client, 'salida');
      const motivo = await motivoMovimientoId(client, MOTIVO_DESPACHO);
      if (!tipoSalida || !motivo) {
        throw new ErrorNegocio(500, { error: 'Falta el tipo "salida" o el motivo "despacho_venta" en el catálogo. Avise al administrador del sistema.' });
      }

      /* ── Salida definitiva: por reserva ── */
      for (const x of reservas) {
        await client.query(
          `UPDATE inventario_bodega
           SET inventario_bodega_cantidad_fisica = inventario_bodega_cantidad_fisica - $1,
               inventario_bodega_cantidad_reservada = inventario_bodega_cantidad_reservada - $1
           WHERE material_sku = $2 AND lote_id_lote = $3 AND bodega_id_bodega = $4`,
          [x.cantidad, x.sku, x.lote_id, x.bodega_id]
        );
        await client.query(
          `INSERT INTO movimiento_inventario (movimiento_inventario_cantidad, movimiento_inventario_estado, material_sku,
             bodega_id_bodega, lote_id_lote, usuario_id_usuario, movimiento_inventario_tipo_movimiento_id_tipo_movimiento,
             movimiento_inventario_motivo_movimiento_id_motivo_movimiento, movimiento_inventario_descripcion_motivo,
             movimiento_inventario_referencia_origen)
           VALUES ($1, 'completado', $2, $3, $4, $5, $6, $7, $8, $9)`,
          [x.cantidad, x.sku, x.bodega_id, x.lote_id, req.user.id, tipoSalida, motivo,
           `Despacho de la venta ${venta.numero} (pedido de instalación)`, venta.numero]
        );
        await client.query(
          `UPDATE reserva_inventario SET reserva_inventario_estado_reserva = 'liberada', reserva_inventario_fecha_liberacion = now()
           WHERE reserva_inventario_id_reserva = $1`, [x.id]
        );
      }

      if (observacion) {
        await client.query(
          `UPDATE preparacion_pedido SET preparacion_pedido_observacion = $2 WHERE preparacion_pedido_id_preparacion = $1`,
          [venta.preparacion_id, observacion]
        );
      }
      await client.query(
        `INSERT INTO preparacion_pedido_estado (preparacion_pedido_estado_nombre_estado, preparacion_pedido_id_preparacion, usuario_id_usuario)
         VALUES ('en_transito', $1, $2)`, [venta.preparacion_id, req.user.id]
      );
      return { venta, movimientos: reservas.length, items: items.length };
    });

    await auditoria.registrar(req.user.id, 'Salida de pedido de instalación',
      `${r.venta.numero}: ${r.items} insumo(s), ${r.movimientos} movimiento(s) de salida`);
    generarAlertasAutomaticas().catch(e => console.warn('Alertas:', e.message));
    res.json({
      message: `Pedido ${r.venta.numero} despachado: quedó "En tránsito" y se descontó el stock (${r.movimientos} movimiento(s) de salida).`,
    });
  } catch (err) {
    responderError(res, err, 'Error confirmando la salida del pedido:');
  }
}

/* ── D51: devolver lo retirado, deshacer el preparado y cancelar ── */

const MAX_MOTIVO = 500;

/** Venta con preparación y su estado vigente, ya bloqueada (FOR UPDATE). Lanza 404/400 si no corresponde. */
async function pedidoBloqueado(client, id) {
  const venta = await cabecera(client, id);
  if (!venta) throw new ErrorNegocio(404, { error: 'Venta no encontrada' });
  if (!venta.preparacion_id) {
    throw new ErrorNegocio(400, { error: `La venta ${venta.numero} no tiene insumos vinculados.`, codigo: 'SIN_VINCULAR' });
  }
  return { venta, estado: await bloquearYLeerEstado(client, venta.preparacion_id) };
}

/** 409 de un pedido que ya salió (D63: no se deshace un despacho) o que ya se canceló. */
function rechazarCerrado(venta, estado) {
  if (estado === 'en_transito') {
    throw new ErrorNegocio(409, {
      error: `El pedido ${venta.numero} ya salió ("En tránsito"): no se puede deshacer. Si el material vuelve de la obra, ` +
             'regístrelo como una entrada por devolución.',
      codigo: 'PEDIDO_DESPACHADO',
    });
  }
  if (estado === 'cancelado') {
    throw new ErrorNegocio(409, { error: `El pedido ${venta.numero} ya está cancelado.`, codigo: 'PEDIDO_CANCELADO' });
  }
}

/**
 * PUT /api/pedidos-venta/:id/devolucion/:sku   (gerencia y jop) — D51
 * Lo retirado de un insumo (CU-126) vuelve a su anaquel: el retiro queda en 0 y el insumo, pendiente de retiro. No mueve
 * stock: el retiro tampoco lo movía (la reserva sigue activa hasta la salida, D20). Solo en "preparado" o "en carga";
 * es el paso previo a volver el pedido a "vinculado".
 */
async function devolverABodega(req, res) {
  const { id, sku } = req.params;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la venta debe ser numérico' });
  try {
    const r = await conTransaccion(async (client) => {
      const { venta, estado } = await pedidoBloqueado(client, id);
      rechazarCerrado(venta, estado);
      if (!['preparado', 'en_carga'].includes(estado)) {
        throw new ErrorNegocio(400, { error: `El pedido ${venta.numero} está "${estado}": no tiene material retirado que devolver.` });
      }
      const { rows } = await client.query(
        `SELECT d.preparacion_pedido_detalle_id AS id, m.material_nombre_material AS nombre,
                COALESCE(d.preparacion_pedido_detalle_cantidad_retirada, 0)::float AS retirada
         FROM preparacion_pedido_detalle d JOIN material m ON m.material_sku = d.material_sku
         WHERE d.preparacion_pedido_id_preparacion = $1 AND d.material_sku = $2
         FOR UPDATE OF d`,
        [venta.preparacion_id, sku]
      );
      if (!rows.length) throw new ErrorNegocio(404, { error: `El insumo ${sku} no pertenece al pedido ${venta.numero}.` });
      if (rows[0].retirada <= 0) throw new ErrorNegocio(400, { error: `${rows[0].nombre} no tiene material retirado que devolver.` });
      await client.query(
        `UPDATE preparacion_pedido_detalle
         SET preparacion_pedido_detalle_cantidad_retirada = NULL, preparacion_pedido_detalle_fecha_retiro = NULL, usuario_id_retiro = NULL
         WHERE preparacion_pedido_detalle_id = $1`,
        [rows[0].id]
      );
      return { venta, nombre: rows[0].nombre, devuelta: rows[0].retirada };
    });

    await auditoria.registrar(req.user.id, 'Devolución a bodega (picking)', `${r.venta.numero}: ${sku} ${r4(r.devuelta)} devuelto(s) al anaquel`);
    res.json({ message: `${r.nombre}: ${r4(r.devuelta)} devuelto(s) a bodega. Queda pendiente de retiro.` });
  } catch (err) {
    responderError(res, err, 'Error registrando la devolución a bodega:');
  }
}

/**
 * PUT /api/pedidos-venta/:id/deshacer-preparado   (solo gerencia) — D51
 * Body: { motivo }. Vuelve el pedido de "preparado" o "en carga" a "vinculado": se puede modificar la vinculación
 * (CU-120) y liberar sus reservas (CU-132). Exige que no quede nada retirado (primero se devuelve a bodega). Las
 * reservas no cambian. El historial conserva todo; el motivo queda en la auditoría.
 */
async function deshacerPreparado(req, res) {
  const { id } = req.params;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la venta debe ser numérico' });
  const motivo = String(req.body?.motivo ?? '').trim();
  if (!motivo) return res.status(400).json({ error: 'Indique el motivo por el que el pedido vuelve a "Vinculado".' });
  if (motivo.length > MAX_MOTIVO) return res.status(400).json({ error: `El motivo admite hasta ${MAX_MOTIVO} caracteres.` });

  try {
    const r = await conTransaccion(async (client) => {
      const { venta, estado } = await pedidoBloqueado(client, id);
      rechazarCerrado(venta, estado);
      if (!['preparado', 'en_carga'].includes(estado)) {
        throw new ErrorNegocio(409, { error: `El pedido ${venta.numero} ya está "${estado}".`, codigo: 'YA_VINCULADO' });
      }
      const { rows: retirados } = await client.query(
        `SELECT m.material_nombre_material AS nombre, d.preparacion_pedido_detalle_cantidad_retirada::float AS retirada
         FROM preparacion_pedido_detalle d JOIN material m ON m.material_sku = d.material_sku
         WHERE d.preparacion_pedido_id_preparacion = $1 AND COALESCE(d.preparacion_pedido_detalle_cantidad_retirada, 0) > 0
         ORDER BY m.material_nombre_material`,
        [venta.preparacion_id]
      );
      if (retirados.length) {
        throw new ErrorNegocio(400, {
          error: `Hay material retirado del anaquel: ${retirados.map(x => `${x.nombre} (${r4(x.retirada)})`).join(', ')}. ` +
                 'Devuélvalo a bodega antes de volver el pedido a "Vinculado".',
          codigo: 'RETIRO_SIN_DEVOLVER',
          retirados,
        });
      }
      await client.query(
        `INSERT INTO preparacion_pedido_estado (preparacion_pedido_estado_nombre_estado, preparacion_pedido_id_preparacion, usuario_id_usuario)
         VALUES ('vinculado', $1, $2)`, [venta.preparacion_id, req.user.id]
      );
      return { venta, desde: estado };
    });

    await auditoria.registrar(req.user.id, 'Pedido vuelto a vinculado', `${r.venta.numero} (desde "${r.desde}"): ${motivo}`);
    res.json({ message: `Pedido ${r.venta.numero} vuelto a "Vinculado". Ya se puede modificar la vinculación o liberar sus reservas.` });
  } catch (err) {
    responderError(res, err, 'Error deshaciendo el preparado:');
  }
}

/**
 * PUT /api/pedidos-venta/:id/cancelar   (solo gerencia) — D51
 * Body: { motivo? }. La venta se canceló en Finanzas: se liberan TODAS sus reservas activas (las del pedido de
 * instalación y las de CU-131 / CU-124), con usuario y motivo (D48), se cierran las alertas de su retiro y el pedido
 * queda "cancelado" (final). Solo desde "vinculado": un pedido más avanzado primero se devuelve a bodega y se deshace.
 */
async function cancelarPedido(req, res) {
  const { id } = req.params;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la venta debe ser numérico' });
  const motivo = String(req.body?.motivo ?? '').trim() || 'Venta cancelada';
  if (motivo.length > MAX_MOTIVO) return res.status(400).json({ error: `El motivo admite hasta ${MAX_MOTIVO} caracteres.` });

  try {
    const r = await conTransaccion(async (client) => {
      const { venta, estado } = await pedidoBloqueado(client, id);
      if (!ESTADOS_VENTA_CANCELADA.includes(String(venta.estado_pedido).toLowerCase())) {
        throw new ErrorNegocio(400, {
          error: `La venta ${venta.numero} está "${venta.estado_pedido}": solo se liberan las reservas de una venta cancelada.`,
          codigo: 'VENTA_NO_CANCELADA',
        });
      }
      rechazarCerrado(venta, estado);
      if (estado !== 'vinculado') {
        throw new ErrorNegocio(409, {
          error: `El pedido ${venta.numero} está "${estado}": primero devuelva a bodega lo retirado y vuelva el pedido a "Vinculado".`,
          codigo: 'PEDIDO_AVANZADO',
        });
      }

      const { rows: reservas } = await client.query(
        `SELECT reserva_inventario_id_reserva AS id, material_sku AS sku, lote_id_lote AS lote_id, bodega_id_bodega AS bodega_id,
                reserva_inventario_cantidad_reservada AS cantidad
         FROM reserva_inventario
         WHERE nota_venta_id_nota_venta = $1 AND reserva_inventario_estado_reserva = 'activa'
         ORDER BY reserva_inventario_id_reserva
         FOR UPDATE`, [id]
      );
      for (const x of reservas) {
        // Las reservas de una venta siempre guardan su lote y bodega (CU-120, CU-124, CU-131)
        const { rowCount } = await client.query(
          `UPDATE inventario_bodega SET inventario_bodega_cantidad_reservada = inventario_bodega_cantidad_reservada - $1
           WHERE material_sku = $2 AND lote_id_lote = $3 AND bodega_id_bodega = $4`,
          [x.cantidad, x.sku, x.lote_id, x.bodega_id]
        );
        if (rowCount !== 1) throw new Error(`La reserva #${x.id} no tiene su fila de stock`);
      }
      if (reservas.length) {
        await client.query(
          `UPDATE reserva_inventario
           SET reserva_inventario_estado_reserva = 'liberada', reserva_inventario_fecha_liberacion = now(),
               usuario_id_liberacion = $2, reserva_inventario_motivo_liberacion = $3
           WHERE reserva_inventario_id_reserva = ANY($1::bigint[])`,
          [reservas.map(x => x.id), req.user.id, motivo]
        );
      }
      // Las alertas de su retiro (faltante, ubicación) ya no aplican
      const { rows: skus } = await client.query(
        `SELECT material_sku AS sku FROM preparacion_pedido_detalle WHERE preparacion_pedido_id_preparacion = $1`, [venta.preparacion_id]
      );
      let alertas = 0;
      for (const s of skus) alertas += await cerrarAlertasRetiro(client, venta.numero, s.sku);

      await client.query(
        `INSERT INTO preparacion_pedido_estado (preparacion_pedido_estado_nombre_estado, preparacion_pedido_id_preparacion, usuario_id_usuario)
         VALUES ('cancelado', $1, $2)`, [venta.preparacion_id, req.user.id]
      );
      return { venta, liberadas: reservas.length, alertas };
    });

    await auditoria.registrar(req.user.id, 'Pedido cancelado',
      `${r.venta.numero}: ${r.liberadas} reserva(s) liberada(s)${r.alertas ? `, ${r.alertas} alerta(s) del retiro resuelta(s)` : ''} · ${motivo}`);
    generarAlertasAutomaticas().catch(e => console.warn('Alertas:', e.message));
    res.json({
      message: `Pedido ${r.venta.numero} cancelado: se liberaron ${r.liberadas} reserva(s) y el stock quedó disponible.`,
      liberadas: r.liberadas,
    });
  } catch (err) {
    responderError(res, err, 'Error cancelando el pedido:');
  }
}

/* ── CU-121: trazabilidad de los insumos del pedido ── */

const ETAPAS = [
  ['ingreso', 'Ingreso a bodega'], ['bodega', 'Bodega de almacenamiento'], ['vinculacion', 'Vinculación al pedido'],
  ['preparacion', 'Preparación'], ['retiro', 'Retiro de bodega'], ['carga', 'Carga al transporte'], ['despacho', 'Despacho'],
];

/**
 * Línea de tiempo de los insumos de una preparación (todos, o solo `skuFiltro`). Cada insumo
 * trae sus 7 etapas: 'completada' con fecha y detalle, 'parcial' (retiro incompleto) o 'pendiente'.
 * Los lotes son los reservados o, si el pedido ya salió, los de sus salidas de despacho (CU-127).
 * Las fechas DATE se devuelven como texto 'YYYY-MM-DD' (sin pasar por UTC).
 */
async function lineaDeTiempo(db, venta, skuFiltro = null) {
  const prepId = venta.preparacion_id;
  const { rows: estados } = await db.query(
    `SELECT DISTINCT ON (e.preparacion_pedido_estado_nombre_estado)
            e.preparacion_pedido_estado_nombre_estado AS estado, e.preparacion_pedido_estado_timestamp_accion AS fecha,
            u.usuario_username AS usuario
     FROM preparacion_pedido_estado e LEFT JOIN usuario u ON u.usuario_id_usuario = e.usuario_id_usuario
     WHERE e.preparacion_pedido_id_preparacion = $1 AND ${DESDE_ULTIMA_VINCULACION('e')}
     ORDER BY e.preparacion_pedido_estado_nombre_estado, e.preparacion_pedido_estado_timestamp_accion,
              e.preparacion_pedido_estado_id_estado_preparacion`, [prepId]
  );
  const primero = Object.fromEntries(estados.map(e => [e.estado, e]));
  const despachado = !!primero.en_transito;
  const responsables = await responsablesDeCarga(db, prepId);

  const { rows: items } = await db.query(
    `SELECT d.preparacion_pedido_detalle_id AS id, d.material_sku AS sku, m.material_nombre_material AS nombre,
            um.material_unidad_medida_nombre AS unidad, b.bodega_nombre_bodega AS bodega,
            d.preparacion_pedido_detalle_cantidad_requerida::float AS requerida,
            COALESCE(d.preparacion_pedido_detalle_cantidad_retirada, 0)::float AS retirada,
            d.preparacion_pedido_detalle_fecha_retiro AS fecha_retiro, ur.usuario_username AS retirado_por,
            COALESCE((SELECT MIN(ri.reserva_inventario_fecha_reserva) FROM reserva_inventario ri
                      WHERE ri.preparacion_pedido_detalle_id = d.preparacion_pedido_detalle_id),
                     pp.preparacion_pedido_fecha_creacion) AS fecha_vinculacion,
            uv.usuario_username AS vinculado_por
     FROM preparacion_pedido_detalle d
     JOIN preparacion_pedido pp ON pp.preparacion_pedido_id_preparacion = d.preparacion_pedido_id_preparacion
     JOIN material m ON m.material_sku = d.material_sku
     JOIN bodega b ON b.bodega_id_bodega = d.bodega_id_bodega
     LEFT JOIN material_unidad_medida um ON um.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
     LEFT JOIN usuario ur ON ur.usuario_id_usuario = d.usuario_id_retiro
     LEFT JOIN usuario uv ON uv.usuario_id_usuario = pp.usuario_id_usuario
     WHERE d.preparacion_pedido_id_preparacion = $1 AND ($2::text IS NULL OR d.material_sku = $2)
     ORDER BY m.material_nombre_material`, [prepId, skuFiltro]
  );

  const { rows: lotes } = despachado
    ? await db.query(
      `SELECT mi.material_sku AS sku, l.lote_numero_lote AS lote, to_char(l.lote_fecha_ingreso, 'YYYY-MM-DD') AS ingreso,
              mi.movimiento_inventario_cantidad::float AS cantidad, bt.bodega_nombre_bodega AS bodega
       FROM movimiento_inventario mi
       JOIN movimiento_inventario_motivo_movimiento mot
            ON mot.movimiento_inventario_motivo_movimiento_id_motivo_movimiento = mi.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
       LEFT JOIN lote l ON l.lote_id_lote = mi.lote_id_lote
       LEFT JOIN bodega bt ON bt.bodega_id_bodega = mi.bodega_id_bodega
       WHERE mot.movimiento_inventario_motivo_movimiento_nombre = $1 AND mi.movimiento_inventario_referencia_origen = $2
         AND mi.movimiento_inventario_id_revertido IS NULL
       ORDER BY l.lote_fecha_ingreso NULLS LAST`, [MOTIVO_DESPACHO, venta.numero])
    : await db.query(
      `SELECT ri.material_sku AS sku, l.lote_numero_lote AS lote, to_char(l.lote_fecha_ingreso, 'YYYY-MM-DD') AS ingreso,
              ri.reserva_inventario_cantidad_reservada::float AS cantidad, bt.bodega_nombre_bodega AS bodega
       FROM reserva_inventario ri
       JOIN preparacion_pedido_detalle d ON d.preparacion_pedido_detalle_id = ri.preparacion_pedido_detalle_id
       LEFT JOIN lote l ON l.lote_id_lote = ri.lote_id_lote
       LEFT JOIN bodega bt ON bt.bodega_id_bodega = ri.bodega_id_bodega
       WHERE d.preparacion_pedido_id_preparacion = $1 AND ri.reserva_inventario_estado_reserva = 'activa'
       ORDER BY l.lote_fecha_ingreso NULLS LAST`, [prepId]);

  const etapa = (clave, estado, fecha = null, detalle = null) =>
    ({ clave, titulo: ETAPAS.find(e => e[0] === clave)[1], estado, fecha, detalle });
  const hecho = (e) => (e ? 'completada' : 'pendiente');

  return items.map(i => {
    const susLotes = lotes.filter(l => l.sku === i.sku);
    const ingresos = susLotes.map(l => l.ingreso).filter(Boolean).sort();
    const retiroCompleto = i.retirada >= i.requerida - 1e-9;
    // D58: las bodegas de sus lotes (reservados o despachados), la principal primero
    const deLotes = [...new Set(susLotes.map(l => l.bodega).filter(Boolean))]
      .sort((a, b) => (a !== i.bodega) - (b !== i.bodega));
    const bodegas = deLotes.length ? deLotes : [i.bodega];
    return {
      sku: i.sku, nombre: i.nombre, unidad: i.unidad, requerida: i.requerida,
      etapas: [
        etapa('ingreso', susLotes.length ? 'completada' : 'pendiente', ingresos[0] ?? null,
          susLotes.length
            ? susLotes.map(l => `Lote ${l.lote || '—'} (${r4(l.cantidad)})${bodegas.length > 1 ? ` · ${l.bodega}` : ''}`).join(', ')
            : 'Sin lotes reservados'),
        etapa('bodega', 'completada', null, enumerar(bodegas)),
        etapa('vinculacion', 'completada', i.fecha_vinculacion, i.vinculado_por ? `Vinculado por ${i.vinculado_por}` : null),
        etapa('preparacion', hecho(primero.preparado), primero.preparado?.fecha ?? null,
          primero.preparado ? `Por ${primero.preparado.usuario || '—'}` : null),
        retiroCompleto
          ? etapa('retiro', 'completada', i.fecha_retiro, `Retirado ${r4(i.retirada)} por ${i.retirado_por || '—'}`)
          : i.retirada > 0
            ? etapa('retiro', 'parcial', i.fecha_retiro, `Parcial: ${r4(i.retirada)} de ${i.requerida}`)
            : etapa('retiro', 'pendiente'),
        etapa('carga', hecho(primero.en_carga), primero.en_carga?.fecha ?? null,
          primero.en_carga ? `Responsable(s): ${responsables.map(x => x.nombre).join(', ')}` : null),
        etapa('despacho', hecho(primero.en_transito), primero.en_transito?.fecha ?? null,
          primero.en_transito ? `Por ${primero.en_transito.usuario || '—'}` : null),
      ],
    };
  });
}

const resumenVenta = (v) => ({ id: Number(v.id), numero: v.numero, cliente: v.cliente, estado_pedido: v.estado_pedido,
                               estado_despacho: v.estado_despacho || 'sin_vincular' });

/**
 * GET /api/pedidos-venta/trazabilidad?q=   (gerencia y jop) — CU-121, solo lectura
 * `q` = número de venta (exacto, sin distinguir mayúsculas) o, si no hay venta con ese número, un SKU.
 *   Venta → la línea de tiempo de cada insumo de su pedido de instalación.
 *   SKU   → un bloque por pedido de instalación que incluye ese insumo, con su línea de tiempo.
 *   Exc 2: ni venta ni SKU → 404.   Exc 1: existe pero sin vinculación → 200 con sin_datos.
 */
async function trazabilidad(req, res) {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.status(400).json({ error: 'Ingrese el número de venta o el SKU a consultar.' });
  try {
    const { rows: nv } = await query(
      `SELECT id_nota_venta AS id FROM finanzas.nota_venta WHERE LOWER(numero_nota_venta) = LOWER($1) ORDER BY 1 LIMIT 1`, [q]);
    if (nv.length) {
      const venta = await cabecera({ query }, nv[0].id);
      const insumos = venta.preparacion_id ? await lineaDeTiempo({ query }, venta) : [];
      return res.json({
        tipo: 'venta', consulta: q,
        pedidos: insumos.length ? [{ venta: resumenVenta(venta), insumos }] : [],
        sin_datos: insumos.length === 0,
        mensaje: insumos.length ? null
          : `La venta ${venta.numero} existe, pero no registra movimientos todavía: no tiene insumos vinculados, así que no hay datos de trazabilidad.`,
      });
    }

    const { rows: mat } = await query(
      `SELECT material_sku AS sku, material_nombre_material AS nombre FROM material WHERE UPPER(material_sku) = UPPER($1)`, [q]);
    if (!mat.length) {
      return res.status(404).json({ error: `No se encontró ninguna venta ni SKU "${q}". Verifique el dato ingresado.` });
    }
    const { rows: preps } = await query(
      `SELECT DISTINCT pp.nota_venta_id_nota_venta AS venta_id, pp.preparacion_pedido_fecha_creacion AS fecha
       FROM preparacion_pedido_detalle d
       JOIN preparacion_pedido pp ON pp.preparacion_pedido_id_preparacion = d.preparacion_pedido_id_preparacion
       WHERE d.material_sku = $1 AND pp.nota_venta_id_nota_venta IS NOT NULL
       ORDER BY pp.preparacion_pedido_fecha_creacion DESC`, [mat[0].sku]);
    const pedidos = [];
    for (const p of preps) {
      const venta = await cabecera({ query }, p.venta_id);
      if (!venta) continue;
      pedidos.push({ venta: resumenVenta(venta), insumos: await lineaDeTiempo({ query }, venta, mat[0].sku) });
    }
    res.json({
      tipo: 'sku', consulta: q, material: mat[0], pedidos,
      sin_datos: pedidos.length === 0,
      mensaje: pedidos.length ? null
        : `${mat[0].nombre} (${mat[0].sku}) no está vinculado a ningún pedido de instalación: no hay datos de trazabilidad.`,
    });
  } catch (err) {
    responderError(res, err, 'Error consultando la trazabilidad:');
  }
}

/** Estado de despacho del pedido al que pertenece un ítem (para Reservas). */
async function estadoDelItem(db, detId) {
  const { rows } = await db.query(
    `SELECT nv.numero_nota_venta AS numero, est.estado
     FROM preparacion_pedido_detalle d
     JOIN preparacion_pedido pp ON pp.preparacion_pedido_id_preparacion = d.preparacion_pedido_id_preparacion
     LEFT JOIN finanzas.nota_venta nv ON nv.id_nota_venta = pp.nota_venta_id_nota_venta
     ${ULTIMO_ESTADO_SQL}
     WHERE d.preparacion_pedido_detalle_id = $1`, [detId]
  );
  return rows[0] || null;
}

module.exports = { listar, obtener, vincular, marcarPreparado, registrarRetiro, reportarUbicacion, empleados, iniciarCarga, confirmarSalida, trazabilidad, estadoDelItem,
                   devolverABodega, deshacerPreparado, cancelarPedido,
                   ESTADOS_VINCULABLES, ESTADOS_DESPACHO };
