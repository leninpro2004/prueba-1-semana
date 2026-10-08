const { query } = require('../db/pool');
const { ErrorNegocio, conTransaccion, responderError } = require('../db/tx');
const auditoria = require('./auditoriaController');
const { estadoDelItem } = require('./pedidosVentaController');
const { reservarStockFifo } = require('./pedidosController');


/**
 * OPUS-3: devuelve al inventario la cantidad reservada de un material.
 * liberar() y anular() tenian ~30 lineas identicas de esta logica, cada una sin
 * transaccion; ahora comparten este helper y ambas corren dentro de un
 * BEGIN/COMMIT.
 *
 * Se libera recorriendo los lotes con reserva en orden inverso al de asignacion
 * (el mas nuevo primero: se deshace lo ultimo que se reservo). CU-124: si la
 * reserva guarda su lote y bodega, ESE lote va primero; las reservas antiguas
 * (sin lote) siguen como antes.
 */
async function devolverStockReservado(client, sku, cantidad, loteId = null, bodegaId = null) {
  const { rows: lotes } = await client.query(
    `SELECT ib.lote_id_lote, ib.bodega_id_bodega,
            ib.inventario_bodega_cantidad_reservada AS reservado
     FROM inventario_bodega ib
     JOIN lote l ON l.lote_id_lote = ib.lote_id_lote
     WHERE ib.material_sku = $1
       AND ib.inventario_bodega_cantidad_reservada > 0
     ORDER BY (ib.lote_id_lote = $2 AND ib.bodega_id_bodega = $3) IS TRUE DESC,
              l.lote_fecha_ingreso DESC NULLS LAST
     FOR UPDATE OF ib`,
    [sku, loteId, bodegaId]
  );

  let restante = parseFloat(cantidad);
  const liberados = [];
  for (const lote of lotes) {
    if (restante <= 1e-9) break;
    const liberar = Math.min(restante, parseFloat(lote.reservado));
    await client.query(
      `UPDATE inventario_bodega
       SET inventario_bodega_cantidad_reservada = inventario_bodega_cantidad_reservada - $1
       WHERE material_sku = $2 AND lote_id_lote = $3 AND bodega_id_bodega = $4`,
      [liberar, sku, lote.lote_id_lote, lote.bodega_id_bodega]
    );
    liberados.push({ lote_id: lote.lote_id_lote, bodega_id: lote.bodega_id_bodega, cantidad: liberar });
    restante -= liberar;
  }
  // restante > 0 significa que la reserva estaba descuadrada respecto del stock
  // reservado real; se informa para poder detectarlo, no se aborta.
  return { liberados, no_liberado: restante > 1e-9 ? restante : 0 };
}

/**
 * Cierra una reserva activa (liberada o anulada) devolviendo el stock reservado.
 * Todo el cierre (stock + estado de la reserva) va en una sola transaccion.
 */
async function cerrarReserva(client, id, nuevoEstado, { usuarioId = null, motivo = null } = {}) {
  const { rows: reserva } = await client.query(
    `SELECT reserva_inventario_id_reserva          AS id,
            reserva_inventario_cantidad_reservada  AS cantidad,
            reserva_inventario_estado_reserva      AS estado,
            material_sku                           AS sku,
            orden_trabajo_id_orden                 AS orden_id,
            lote_id_lote                           AS lote_id,     -- CU-124
            bodega_id_bodega                       AS bodega_id,
            preparacion_pedido_detalle_id          AS det_id       -- CU-119
     FROM reserva_inventario
     WHERE reserva_inventario_id_reserva = $1
     FOR UPDATE`,
    [id]
  );

  if (reserva.length === 0) {
    throw new ErrorNegocio(404, { error: 'Reserva no encontrada' });
  }

  const r = reserva[0];

  // CU-124 Exc 1: ya liberada o anulada
  if (r.estado !== 'activa') {
    throw new ErrorNegocio(400, {
      error: nuevoEstado === 'anulada'
        ? 'Solo se pueden anular reservas activas'
        : 'La reserva ya se encuentra liberada o anulada. No puede gestionarse.'
    });
  }

  // CU-124 Exc 2: la OT asociada fue cancelada
  if (r.orden_id) {
    const { rows: ot } = await client.query(
      `SELECT orden_trabajo_estado AS estado
       FROM orden_trabajo WHERE orden_trabajo_id_orden = $1`,
      [r.orden_id]
    );
    if (ot.length > 0 && String(ot[0].estado).toLowerCase() === 'cancelada') {
      throw new ErrorNegocio(400, {
        error: 'La reserva está asociada a un pedido cancelado y no puede gestionarse.'
      });
    }
  }

  // CU-119: los lotes de un pedido preparado para despacho quedan bloqueados para su salida
  if (r.det_id) {
    const pedido = await estadoDelItem(client, r.det_id);
    if (pedido?.estado && pedido.estado !== 'vinculado') {
      throw new ErrorNegocio(400, {
        error: `La reserva pertenece al pedido ${pedido.numero}, que ya está "${pedido.estado}" para despacho: no se puede liberar ni anular.`,
      });
    }
  }

  const devolucion = await devolverStockReservado(client, r.sku, r.cantidad, r.lote_id, r.bodega_id);

  // CU-132 (D48): quién la cerró y por qué
  await client.query(
    `UPDATE reserva_inventario
     SET reserva_inventario_estado_reserva = $2,
         reserva_inventario_fecha_liberacion = now(),
         usuario_id_liberacion = $3,
         reserva_inventario_motivo_liberacion = $4
     WHERE reserva_inventario_id_reserva = $1`,
    [id, nuevoEstado, usuarioId, motivo]
  );

  return { reserva: r, devolucion };
}

/**
 * GET /api/reservas
 * Lista reservas de stock con filtros (CU-124)
 * Query params: ?estado=&buscar=&orden_id=
 */
async function listar(req, res) {
  const { estado, buscar, orden_id, venta } = req.query;
  try {
    const { rows } = await query(
      `SELECT
         ri.reserva_inventario_id_reserva         AS id,
         ri.reserva_inventario_cantidad_reservada  AS cantidad,
         ri.reserva_inventario_fecha_reserva       AS fecha_reserva,
         ri.reserva_inventario_fecha_liberacion    AS fecha_liberacion,
         ri.reserva_inventario_estado_reserva      AS estado,
         ri.material_sku                           AS sku,
         m.material_nombre_material                AS material_nombre,
         m.material_material_critico               AS es_critico,
         u.material_unidad_medida_nombre           AS unidad,
         ri.orden_trabajo_id_orden                 AS orden_id,
         ri.proyecto_id_proyecto                   AS proyecto_id,
         p.codigo_proyecto                         AS proyecto_codigo,
         p.nombre_referencia                       AS proyecto_nombre,
         -- CU-124: reserva de un insumo especial para una venta, en un lote específico
         nv.numero_nota_venta                      AS venta,
         lo.lote_numero_lote                       AS lote,
         -- CU-132: estado de la venta (marca "venta cancelada"), quién creó y quién cerró la reserva (D48)
         nv.estado_pedido                          AS venta_estado,
         LOWER(COALESCE(nv.estado_pedido, '')) IN ('cancelada', 'cancelado', 'anulada', 'anulado') AS venta_cancelada,
         uc.usuario_username                       AS creada_por,
         ul.usuario_username                       AS cerrada_por,
         ri.reserva_inventario_motivo_liberacion   AS motivo,
         -- CU-132 Exc 3: reserva de un pedido de instalación en preparado o después
         desp.estado                               AS estado_despacho,
         (desp.estado IS NOT NULL AND desp.estado <> 'vinculado') AS comprometida,
         -- Consumo ya registrado por la OT para ESE material. Sirve para avisar
         -- cuando la reserva ya cumplio su funcion: registrar el consumo NO libera
         -- la reserva, asi que sin este aviso el stock queda apartado para siempre.
         mot.material_orden_trabajo_consumo_real   AS consumo_real,
         (ri.reserva_inventario_estado_reserva = 'activa'
          AND mot.material_orden_trabajo_consumo_real IS NOT NULL
          AND mot.material_orden_trabajo_consumo_real >= ri.reserva_inventario_cantidad_reservada)
                                                   AS cumplida
       FROM reserva_inventario ri
       JOIN material m ON m.material_sku = ri.material_sku
       LEFT JOIN material_orden_trabajo mot
              ON mot.orden_trabajo_id_orden = ri.orden_trabajo_id_orden
             AND mot.material_sku = ri.material_sku
       LEFT JOIN material_unidad_medida u
              ON u.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
       LEFT JOIN terreno.proyecto p ON p.id_proyecto = ri.proyecto_id_proyecto
       LEFT JOIN finanzas.nota_venta nv ON nv.id_nota_venta = ri.nota_venta_id_nota_venta
       LEFT JOIN lote lo ON lo.lote_id_lote = ri.lote_id_lote
       LEFT JOIN usuario uc ON uc.usuario_id_usuario = ri.usuario_id_usuario
       LEFT JOIN usuario ul ON ul.usuario_id_usuario = ri.usuario_id_liberacion
       LEFT JOIN LATERAL (
         SELECT e.preparacion_pedido_estado_nombre_estado AS estado
         FROM preparacion_pedido_detalle d
         JOIN preparacion_pedido_estado e ON e.preparacion_pedido_id_preparacion = d.preparacion_pedido_id_preparacion
         WHERE d.preparacion_pedido_detalle_id = ri.preparacion_pedido_detalle_id
         ORDER BY e.preparacion_pedido_estado_timestamp_accion DESC, e.preparacion_pedido_estado_id_estado_preparacion DESC
         LIMIT 1) desp ON TRUE
       WHERE ($1::text IS NULL OR ri.reserva_inventario_estado_reserva = $1)
         AND ($2::text IS NULL OR
              ri.material_sku ILIKE '%' || $2 || '%' OR
              m.material_nombre_material ILIKE '%' || $2 || '%')
         AND ($3::bigint IS NULL OR ri.orden_trabajo_id_orden = $3)
         AND ($4::text IS NULL OR nv.numero_nota_venta ILIKE '%' || $4 || '%')
       ORDER BY ri.reserva_inventario_fecha_reserva DESC`,
      [estado || null, buscar || null, orden_id || null, String(venta ?? '').trim() || null]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listando reservas:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/** CU-132: motivo opcional del cierre. null si no viene; false si es demasiado largo. */
function motivoDe(req) {
  const m = String(req.body?.motivo ?? '').trim();
  if (m.length > 500) return false;
  return m || null;
}

/**
 * PUT /api/reservas/:id/liberar
 * Libera una reserva activa y devuelve el stock reservado (CU-124)
 */
async function liberar(req, res) {
  const { id } = req.params;
  const motivo = motivoDe(req);
  if (motivo === false) return res.status(400).json({ error: 'El motivo admite hasta 500 caracteres.' });
  try {
    const r = await conTransaccion(client => cerrarReserva(client, id, 'liberada', { usuarioId: req.user?.id, motivo }));

    await auditoria.registrar(req.user?.id, 'liberar_reserva',
      `Reserva ID ${id} liberada (SKU ${r.reserva.sku}, cantidad ${r.reserva.cantidad})${motivo ? ` · motivo: ${motivo}` : ''}`);

    res.json({
      message: 'Reserva liberada correctamente. Stock disponible actualizado.',
      sku: r.reserva.sku,
      cantidad: parseFloat(r.reserva.cantidad),
      ...(r.devolucion.no_liberado > 0 && {
        advertencia: `Quedaron ${r.devolucion.no_liberado} unidad(es) sin liberar: el stock reservado del material era menor que la reserva.`
      })
    });
  } catch (err) {
    responderError(res, err, 'Error liberando reserva:');
  }
}

/**
 * PUT /api/reservas/:id/anular
 * Anula una reserva (distinto de liberar — marca error administrativo)
 */
async function anular(req, res) {
  const { id } = req.params;
  const motivo = motivoDe(req);
  if (motivo === false) return res.status(400).json({ error: 'El motivo admite hasta 500 caracteres.' });
  try {
    const r = await conTransaccion(client => cerrarReserva(client, id, 'anulada', { usuarioId: req.user?.id, motivo }));

    await auditoria.registrar(req.user?.id, 'anular_reserva',
      `Reserva ID ${id} anulada (SKU ${r.reserva.sku}, cantidad ${r.reserva.cantidad})${motivo ? ` · motivo: ${motivo}` : ''}`);

    res.json({
      message: 'Reserva anulada correctamente',
      sku: r.reserva.sku,
      cantidad: parseFloat(r.reserva.cantidad),
      ...(r.devolucion.no_liberado > 0 && {
        advertencia: `Quedaron ${r.devolucion.no_liberado} unidad(es) sin liberar: el stock reservado del material era menor que la reserva.`
      })
    });
  } catch (err) {
    responderError(res, err, 'Error anulando reserva:');
  }
}

/* ══════════════════════════════════════════════════════════════════════
   CU-131: reservar stock para ventas aprobadas (D16, D49)
   Solo las líneas con sku_material (material suelto); las puertas van por OT y CU-120.
   ══════════════════════════════════════════════════════════════════════ */

const ESTADO_APROBADA = 'aprobada';   // D14
const r4 = (x) => Math.round(x * 10000) / 10000;

/**
 * Líneas con SKU de una venta, agrupadas por SKU, con lo ya reservado para esa venta y SKU
 * fuera de CU-120 (reservas de CU-124 y de CU-131; D49), lo pendiente y el disponible actual
 * (físico − reservado: descuenta lo que ya tienen otras ventas y OT).
 */
async function lineasDeVenta(db, ventaId) {
  const { rows } = await db.query(
    `SELECT i.sku_material AS sku, m.material_nombre_material AS nombre, um.material_unidad_medida_nombre AS unidad,
            m.material_estado AS estado_material, m.material_es_herramienta AS herramienta, (m.material_sku IS NOT NULL) AS existe,
            SUM(i.cantidad)::float AS pedida,
            COALESCE((SELECT SUM(ri.reserva_inventario_cantidad_reservada) FROM reserva_inventario ri
                      WHERE ri.nota_venta_id_nota_venta = $1 AND ri.material_sku = i.sku_material
                        AND ri.preparacion_pedido_detalle_id IS NULL AND ri.reserva_inventario_estado_reserva = 'activa'), 0)::float AS reservada,
            COALESCE((SELECT SUM(ib.inventario_bodega_cantidad_fisica - ib.inventario_bodega_cantidad_reservada)
                      FROM inventario_bodega ib WHERE ib.material_sku = i.sku_material), 0)::float AS disponible
     FROM finanzas.item_nota_venta i
     LEFT JOIN material m ON m.material_sku = i.sku_material
     LEFT JOIN material_unidad_medida um ON um.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
     WHERE i.id_nota_venta = $1 AND i.sku_material IS NOT NULL
     GROUP BY i.sku_material, m.material_sku, m.material_nombre_material, um.material_unidad_medida_nombre,
              m.material_estado, m.material_es_herramienta
     ORDER BY COALESCE(m.material_nombre_material, i.sku_material)`,
    [ventaId]
  );
  return rows.map(l => {
    const pendiente = Math.max(0, r4(l.pedida - l.reservada));
    // Exc 1: no existe, inactivo o herramienta → no se reserva
    const problema = !l.existe ? 'No existe en el catálogo.'
      : l.herramienta ? 'Es una herramienta: no se reserva para una venta.'
        : l.estado_material !== 'activo' ? 'El material está inactivo.' : null;
    return { ...l, pendiente, disponible: Math.max(0, r4(l.disponible)), problema,
             faltante: problema ? 0 : Math.max(0, r4(pendiente - Math.max(0, l.disponible))) };
  });
}

const resumenVenta = `
  SELECT nv.id_nota_venta::int AS id, nv.numero_nota_venta AS numero, nv.estado_pedido, nv.fecha_emision,
         nv.fecha_max_entrega, cf.nombre_razon_social AS cliente
  FROM finanzas.nota_venta nv
  LEFT JOIN finanzas.cliente_financiero cf ON cf.id_cliente_financiero = nv.id_cliente_financiero`;

/**
 * GET /api/reservas/ventas   (gerencia y jop) — CU-131
 * Ventas aprobadas con líneas de material suelto, con cuánto falta reservar.
 */
async function ventasReservables(req, res) {
  try {
    const { rows: ventas } = await query(
      `${resumenVenta}
       WHERE LOWER(nv.estado_pedido) = $1
         AND EXISTS (SELECT 1 FROM finanzas.item_nota_venta i WHERE i.id_nota_venta = nv.id_nota_venta AND i.sku_material IS NOT NULL)
       ORDER BY nv.fecha_max_entrega NULLS LAST, nv.numero_nota_venta`, [ESTADO_APROBADA]
    );
    const salida = [];
    for (const v of ventas) {
      const lineas = await lineasDeVenta({ query }, v.id);
      salida.push({ ...v, lineas: lineas.length,
                    pendientes: lineas.filter(l => !l.problema && l.pendiente > 0).length,
                    reservada_completa: lineas.every(l => l.problema || l.pendiente <= 0) });
    }
    res.json(salida);
  } catch (err) {
    responderError(res, err, 'Error listando ventas para reservar:');
  }
}

/** GET /api/reservas/ventas/:id — vista previa de la reserva de una venta (CU-131). */
async function vistaReservaVenta(req, res) {
  const { id } = req.params;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la venta debe ser numérico' });
  try {
    const { rows } = await query(`${resumenVenta} WHERE nv.id_nota_venta = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Venta no encontrada' });
    const lineas = await lineasDeVenta({ query }, id);
    const aprobada = String(rows[0].estado_pedido).toLowerCase() === ESTADO_APROBADA;
    res.json({ venta: rows[0], lineas, aprobada,
               reservada_completa: lineas.length > 0 && lineas.every(l => l.problema || l.pendiente <= 0) });
  } catch (err) {
    responderError(res, err, 'Error obteniendo la venta:');
  }
}

/**
 * POST /api/reservas/ventas/:id   (gerencia y jop) — CU-131
 * Body: { parcial? }. Reserva lo pendiente de cada línea con SKU (D49), FIFO en todas las
 * bodegas, una reserva por lote, con la venta, el lote, la bodega y el usuario (D48).
 * Todo se decide antes de tocar stock:
 *   Exc 3: venta no aprobada → 400; ya reservada completa → 409.
 *   Exc 1: material inexistente, inactivo o herramienta → esa línea se salta y se informa.
 *   Exc 2: alguna línea sin stock suficiente y sin `parcial` → 409 con el disponible real (nada
 *          se mueve); con `parcial` se reserva lo disponible.
 */
async function reservarVenta(req, res) {
  const { id } = req.params;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la venta debe ser numérico' });
  const parcial = req.body?.parcial === true;

  try {
    const r = await conTransaccion(async (client) => {
      const { rows } = await client.query(`${resumenVenta} WHERE nv.id_nota_venta = $1`, [id]);
      if (!rows.length) throw new ErrorNegocio(404, { error: 'Venta no encontrada' });
      const venta = rows[0];
      // Exc 3: no aprobada
      if (String(venta.estado_pedido).toLowerCase() !== ESTADO_APROBADA) {
        throw new ErrorNegocio(400, {
          error: `La venta ${venta.numero} está "${venta.estado_pedido}": solo se reservan ventas aprobadas.`, codigo: 'NO_APROBADA',
        });
      }
      // Dos reservas simultáneas de la misma venta se serializan
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('cu131_venta_' || $1::text))`, [id]);

      const lineas = await lineasDeVenta(client, id);
      if (!lineas.length) {
        throw new ErrorNegocio(400, { error: `La venta ${venta.numero} no tiene materiales sueltos que reservar.`, codigo: 'SIN_LINEAS' });
      }
      const omitidas = lineas.filter(l => l.problema);
      const aReservar = lineas.filter(l => !l.problema && l.pendiente > 0);
      // Exc 3: ya reservada
      if (!aReservar.length) {
        throw new ErrorNegocio(409, {
          error: omitidas.length && omitidas.length === lineas.length
            ? `Ningún material de la venta ${venta.numero} se puede reservar: ${omitidas.map(l => `${l.sku} (${l.problema})`).join('; ')}`
            : `La venta ${venta.numero} ya está reservada: todas sus líneas tienen su reserva activa.`,
          codigo: omitidas.length === lineas.length ? 'SIN_RESERVABLES' : 'YA_RESERVADA',
          omitidas,
        });
      }

      // Exc 2: con los lotes bloqueados, cuánto alcanza por línea
      const plan = [];
      for (const l of aReservar) {
        const intento = await reservarStockFifo(client, l.sku, 0);   // solo bloquea y mide (no reserva nada)
        plan.push({ ...l, disponible: Math.max(0, r4(intento.disponible)), cantidad: Math.min(l.pendiente, Math.max(0, r4(intento.disponible))) });
      }
      const insuficientes = plan.filter(p => p.cantidad < p.pendiente - 1e-9);
      if (insuficientes.length && !parcial) {
        throw new ErrorNegocio(409, {
          error: `Stock insuficiente: ${insuficientes.map(p => `${p.nombre} (pendiente ${p.pendiente}, disponible ${p.disponible})`).join('; ')}. ` +
                 'Puede reservar lo disponible (reserva parcial) o cancelar.',
          codigo: 'STOCK_INSUFICIENTE',
          insuficientes: insuficientes.map(p => ({ sku: p.sku, nombre: p.nombre, pendiente: p.pendiente, disponible: p.disponible })),
        });
      }

      const resultado = [];
      for (const p of plan) {
        if (p.cantidad <= 1e-9) { resultado.push({ sku: p.sku, reservada: 0, faltante: p.pendiente }); continue; }
        const fifo = await reservarStockFifo(client, p.sku, p.cantidad);
        if (!fifo.ok) throw new Error(`El stock de ${p.sku} cambió durante la reserva`);   // no debería: los lotes están bloqueados
        for (const u of fifo.lotes) {
          await client.query(
            `INSERT INTO reserva_inventario (reserva_inventario_cantidad_reservada, reserva_inventario_estado_reserva,
               material_sku, nota_venta_id_nota_venta, lote_id_lote, bodega_id_bodega, usuario_id_usuario)
             VALUES ($1, 'activa', $2, $3, $4, $5, $6)`,
            [u.cantidad, p.sku, id, u.lote_id, u.bodega_id, req.user.id]
          );
        }
        resultado.push({ sku: p.sku, reservada: r4(p.cantidad), faltante: r4(p.pendiente - p.cantidad), lotes: fifo.lotes.length });
      }
      return { venta, resultado, omitidas };
    });

    const reservadas = r.resultado.filter(x => x.reservada > 0);
    const conFaltante = r.resultado.filter(x => x.faltante > 0);
    await auditoria.registrar(req.user.id, 'Reservar stock para venta',
      `${r.venta.numero}: ${r.resultado.map(x => `${x.sku} ${x.reservada}${x.faltante > 0 ? ` (faltan ${x.faltante})` : ''}`).join(', ')}` +
      (r.omitidas.length ? ` · omitidas: ${r.omitidas.map(o => o.sku).join(', ')}` : ''));
    res.status(201).json({
      message: `Reserva de la venta ${r.venta.numero}: ${reservadas.length} material(es) reservado(s)` +
        (conFaltante.length ? `, ${conFaltante.length} con faltante (reserva parcial)` : '') +
        (r.omitidas.length ? `. No se reservaron: ${r.omitidas.map(o => `${o.sku} (${o.problema})`).join('; ')}` : '') + '.',
      parcial: conFaltante.length > 0,
      lineas: r.resultado,
      omitidas: r.omitidas.map(o => ({ sku: o.sku, problema: o.problema })),
    });
  } catch (err) {
    responderError(res, err, 'Error reservando stock para la venta:');
  }
}

module.exports = { listar, liberar, anular, ventasReservables, vistaReservaVenta, reservarVenta };
