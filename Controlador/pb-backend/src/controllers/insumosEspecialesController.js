const { query } = require('../db/pool');
const { conTransaccion, ErrorNegocio, responderError } = require('../db/tx');
const { notificarPorRol } = require('./notificacionesController');
const auditoria = require('./auditoriaController');

/* ══════════════════════════════════════════════════════════════════════
   CU-122 — Controlando insumos especiales (D17, D18, D19, D40)

   Revisión periódica de las ventas de Finanzas (solo se LEEN) que genera alertas
   de compra para Gerencia en alerta_faltante_pedido con origen 'insumo_especial'.
   Corre al arrancar el servidor, cada 5 minutos (index.js) y al abrir el panel.
   ══════════════════════════════════════════════════════════════════════ */

const ORIGEN = 'insumo_especial';
/** Ventas que se revisan: emitidas en los últimos N días (D17). */
const DIAS_VENTANA = 60;
/** Finanzas no fijó el valor de una venta cancelada: se aceptan estas variantes (D17). */
const ESTADOS_VENTA_CANCELADA = ['cancelada', 'cancelado', 'anulada', 'anulado'];
/** Estados de una alerta que todavía se gestiona (los mismos que usan los faltantes de OT). */
const ESTADOS_ABIERTOS = ['activa', 'en_gestion', 'solicitud_emitida'];
/** CU-124: todo lo pedido ya está reservado para la venta (estado cerrado). */
const ESTADO_DISPONIBLE = 'disponible';
/** CU-124: cantidad ya reservada para el SKU y la venta de la alerta `afp` (reservas no liberadas ni anuladas). */
const SQL_VINCULADO = `COALESCE((SELECT SUM(ri.reserva_inventario_cantidad_reservada) FROM reserva_inventario ri
      WHERE ri.material_sku = afp.material_sku AND ri.nota_venta_id_nota_venta = afp.nota_venta_id_nota_venta
        AND ri.reserva_inventario_estado_reserva NOT IN ('liberada', 'anulada')), 0)::float`;

/** 'YYYY-MM-DD' de una fecha LOCAL (nunca toISOString, que es UTC). */
function fechaLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Fecha límite de compra: la entrega máxima menos el plazo del proveedor en días
 * hábiles (lunes a viernes, sin feriados, igual que V2). null si falta alguno.
 */
function restarDiasHabiles(fechaIso, habiles) {
  if (!fechaIso || habiles == null) return null;
  const [a, m, d] = fechaIso.split('-').map(Number);
  const f = new Date(a, m - 1, d);
  let quedan = Number(habiles);
  while (quedan > 0) {
    f.setDate(f.getDate() - 1);
    const dia = f.getDay();
    if (dia !== 0 && dia !== 6) quedan--;
  }
  return fechaLocal(f);
}

/**
 * Lo requerido de cada insumo especial por venta: líneas con sku_material (material
 * suelto, D15) más las puertas (id_producto_terminado → receta, con la merma como
 * fracción). Solo ventas no canceladas de los últimos DIAS_VENTANA días.
 */
async function requeridoPorVenta(client) {
  const { rows } = await client.query(
    `WITH ventas AS (
       SELECT id_nota_venta FROM finanzas.nota_venta
       WHERE fecha_emision >= CURRENT_DATE - $1::int
         AND NOT (LOWER(estado_pedido) = ANY($2::text[]))
     ),
     lineas AS (
       SELECT i.id_nota_venta AS venta, i.sku_material AS sku, i.cantidad::numeric AS cantidad
       FROM finanzas.item_nota_venta i JOIN ventas v ON v.id_nota_venta = i.id_nota_venta
       WHERE i.sku_material IS NOT NULL
       UNION ALL
       SELECT i.id_nota_venta, mpt.material_sku,
              i.cantidad * mpt.material_producto_terminado_cantidad_estimada
                         * (1 + COALESCE(mpt.material_producto_terminado_merma_estimada, 0))
       FROM finanzas.item_nota_venta i JOIN ventas v ON v.id_nota_venta = i.id_nota_venta
       JOIN material_producto_terminado mpt ON mpt.producto_terminado_id_producto = i.id_producto_terminado
     )
     SELECT l.venta::bigint AS venta, m.material_sku AS sku, ROUND(SUM(l.cantidad), 4)::float AS requerido
     FROM lineas l
     JOIN material m ON UPPER(m.material_sku) = UPPER(l.sku)
     WHERE m.material_es_rotativo = FALSE
     GROUP BY l.venta, m.material_sku
     ORDER BY l.venta, m.material_sku`,
    [DIAS_VENTANA, ESTADOS_VENTA_CANCELADA]
  );
  return rows;
}

/** Stock disponible (físico − reservado) y proveedor principal de cada SKU. */
async function stockYProveedor(client, skus) {
  const { rows } = await client.query(
    `SELECT m.material_sku AS sku,
            COALESCE((SELECT SUM(ib.inventario_bodega_cantidad_fisica - ib.inventario_bodega_cantidad_reservada)
                      FROM inventario_bodega ib WHERE ib.material_sku = m.material_sku), 0)::float AS disponible,
            (SELECT mp.proveedor_id_proveedor FROM material_proveedor mp
             WHERE mp.material_sku = m.material_sku AND mp.material_proveedor_proveedor_principal = TRUE
             LIMIT 1) AS proveedor_id
     FROM material m WHERE m.material_sku = ANY($1::text[])`,
    [skus]
  );
  return new Map(rows.map(r => [r.sku, r]));
}

/**
 * Revisa las ventas y deja las alertas al día. Idempotente:
 *  - crea una alerta solo si ese SKU y esa venta NUNCA tuvieron una. Una alerta
 *    cerrada por Gerencia (resuelta, descartada o reemplazada) no se reabre;
 *  - Exc 3: si hay una abierta, actualiza la cantidad requerida (sin duplicar);
 *  - las abiertas de ventas que se cancelaron pasan a 'descartada'.
 * Proveedor sugerido = el principal (Exc 2: sin proveedor, la alerta se crea igual).
 * Todo en una transacción, con un candado para que el timer y el panel no se pisen.
 * La notificación y la auditoría van después del COMMIT. La revisión del panel se audita
 * a nombre de quien lo abrió; la del timer, a nombre del sistema (D59).
 */
async function revisarVentas(usuarioId = null) {
  const r = await conTransaccion(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('cu122_revisar_ventas'))`);

    const requeridos = await requeridoPorVenta(client);
    const { rows: previas } = await client.query(
      `SELECT alerta_faltante_pedido_id_alerta_faltante AS id, material_sku AS sku,
              nota_venta_id_nota_venta AS venta, alerta_faltante_pedido_estado AS estado,
              alerta_faltante_pedido_cantidad_requerida::float AS requerido
       FROM alerta_faltante_pedido
       WHERE alerta_faltante_pedido_origen = $1 AND nota_venta_id_nota_venta IS NOT NULL
       FOR UPDATE`,
      [ORIGEN]
    );
    const porPar = new Map();
    for (const a of previas) {
      const k = `${a.venta}|${a.sku}`;
      porPar.set(k, [...(porPar.get(k) || []), a]);
    }
    const datos = await stockYProveedor(client, [...new Set(requeridos.map(x => x.sku))]);

    const salida = { revisados: requeridos.length, nuevas: [], actualizadas: 0, descartadas: [] };
    for (const q of requeridos) {
      const alertas = porPar.get(`${q.venta}|${q.sku}`) || [];
      const d = datos.get(q.sku) || { disponible: 0, proveedor_id: null };
      if (alertas.length === 0) {
        const { rows } = await client.query(
          `INSERT INTO alerta_faltante_pedido (alerta_faltante_pedido_cantidad_disponible,
             alerta_faltante_pedido_cantidad_requerida, alerta_faltante_pedido_estado, material_sku,
             proveedor_id_proveedor, alerta_faltante_pedido_origen, nota_venta_id_nota_venta)
           VALUES ($1, $2, 'activa', $3, $4, $5, $6)
           RETURNING alerta_faltante_pedido_id_alerta_faltante AS id`,
          [Math.max(d.disponible, 0), q.requerido, q.sku, d.proveedor_id, ORIGEN, q.venta]
        );
        salida.nuevas.push({ id: rows[0].id, sku: q.sku, venta: q.venta });
        continue;
      }
      // Exc 3: la abierta se actualiza; las cerradas se respetan
      const abierta = alertas.find(a => ESTADOS_ABIERTOS.includes(a.estado));
      if (abierta && Math.abs(abierta.requerido - q.requerido) > 1e-9) {
        await client.query(
          `UPDATE alerta_faltante_pedido
           SET alerta_faltante_pedido_cantidad_requerida = $2, alerta_faltante_pedido_cantidad_disponible = $3
           WHERE alerta_faltante_pedido_id_alerta_faltante = $1`,
          [abierta.id, q.requerido, Math.max(d.disponible, 0)]
        );
        salida.actualizadas++;
      }
    }

    // Ventas canceladas: sus alertas abiertas ya no tienen a quién entregar
    const { rows: descartadas } = await client.query(
      `UPDATE alerta_faltante_pedido afp SET alerta_faltante_pedido_estado = 'descartada'
       FROM finanzas.nota_venta nv
       WHERE nv.id_nota_venta = afp.nota_venta_id_nota_venta
         AND afp.alerta_faltante_pedido_origen = $1
         AND afp.alerta_faltante_pedido_estado = ANY($2::text[])
         AND LOWER(nv.estado_pedido) = ANY($3::text[])
       RETURNING afp.alerta_faltante_pedido_id_alerta_faltante AS id, afp.material_sku AS sku, nv.numero_nota_venta AS venta`,
      [ORIGEN, ESTADOS_ABIERTOS, ESTADOS_VENTA_CANCELADA]
    );
    salida.descartadas = descartadas;
    return salida;
  });

  if (r.nuevas.length > 0) {
    await notificarPorRol({
      tipo: 'insumo_especial',
      mensaje: `Se vendieron ${r.nuevas.length} insumo(s) especial(es) que hay que comprar. Revise Alertas → Faltantes → Insumos especiales.`,
      origen: 'alertas_faltantes',
      rol: 'gerencia',
    });
  }
  const eventos = [
    ...r.nuevas.map(n => ['alerta_insumo_especial', `Alerta #${n.id} (${n.sku}) por venta #${n.venta}`]),
    ...r.descartadas.map(d => ['descartar_alerta_insumo_especial', `Alerta #${d.id} (${d.sku}): venta ${d.venta} cancelada`]),
  ];
  // D59: sin usuario (timer) se audita a nombre del sistema. Solo los cambios: una
  // revisión que no crea ni descarta nada no escribe.
  for (const [accion, detalle] of eventos) await auditoria.registrar(usuarioId, accion, detalle);
  return { revisados: r.revisados, nuevas: r.nuevas.length, actualizadas: r.actualizadas, descartadas: r.descartadas.length };
}

/** Alertas de insumos especiales con lo que Gerencia necesita para comprar. */
async function consultarAlertas({ estados }) {
  const { rows } = await query(
    `SELECT afp.alerta_faltante_pedido_id_alerta_faltante AS id,
            afp.alerta_faltante_pedido_fecha_generacion   AS fecha,
            afp.alerta_faltante_pedido_estado             AS estado,
            afp.material_sku                              AS sku,
            m.material_nombre_material                    AS material,
            u.material_unidad_medida_nombre               AS unidad,
            m.material_descontinuado                      AS descontinuado,
            m.material_es_rotativo                        AS es_rotativo,
            afp.alerta_faltante_pedido_cantidad_requerida::float AS requerido,
            ${SQL_VINCULADO} AS vinculado,
            COALESCE((SELECT SUM(ib.inventario_bodega_cantidad_fisica - ib.inventario_bodega_cantidad_reservada)
                      FROM inventario_bodega ib WHERE ib.material_sku = afp.material_sku), 0)::float AS disponible,
            afp.proveedor_id_proveedor                    AS proveedor_id,
            p.proveedor_razon_social                      AS proveedor,
            mp.material_proveedor_tiempo_reposicion       AS plazo_dias_habiles,
            nv.id_nota_venta                              AS venta_id,
            nv.numero_nota_venta                          AS venta,
            nv.estado_pedido                              AS venta_estado,
            TO_CHAR(nv.fecha_max_entrega, 'YYYY-MM-DD')   AS entrega_maxima,
            c.nombre_razon_social                         AS cliente
     FROM alerta_faltante_pedido afp
     JOIN material m ON m.material_sku = afp.material_sku
     LEFT JOIN material_unidad_medida u ON u.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
     LEFT JOIN proveedor p ON p.proveedor_id_proveedor = afp.proveedor_id_proveedor
     LEFT JOIN material_proveedor mp ON mp.material_sku = afp.material_sku AND mp.proveedor_id_proveedor = afp.proveedor_id_proveedor
     LEFT JOIN finanzas.nota_venta nv ON nv.id_nota_venta = afp.nota_venta_id_nota_venta
     LEFT JOIN finanzas.cliente_financiero c ON c.id_cliente_financiero = nv.id_cliente_financiero
     WHERE afp.alerta_faltante_pedido_origen = $1
       AND ($2::text[] IS NULL OR afp.alerta_faltante_pedido_estado = ANY($2::text[]))
     ORDER BY (afp.alerta_faltante_pedido_estado = ANY($3::text[])) DESC,
              nv.fecha_max_entrega ASC NULLS LAST, afp.alerta_faltante_pedido_id_alerta_faltante`,
    [ORIGEN, estados, ESTADOS_ABIERTOS]
  );
  const hoy = fechaLocal(new Date());
  return rows.map(a => {
    const comprarAntes = restarDiasHabiles(a.entrega_maxima, a.plazo_dias_habiles);
    const pendiente = Math.max(Math.round((a.requerido - a.vinculado) * 1e4) / 1e4, 0);   // CU-124
    return {
      ...a,
      pendiente,
      en_espera_recepcion: a.vinculado > 0 && pendiente > 0,   // CU-124 Exc 2
      abierta: ESTADOS_ABIERTOS.includes(a.estado),
      sin_proveedor: a.proveedor_id == null,                 // Exc 2
      cubierto_con_stock: pendiente > 0 && a.disponible >= pendiente,
      comprar_antes: comprarAntes,
      compra_atrasada: comprarAntes != null && comprarAntes < hoy,
    };
  });
}

/**
 * Filtro de la pestaña. Coincide con los badges: pendientes (activa, en gestión,
 * solicitud emitida), disponibles (CU-124: todo vinculado a la venta), cerradas
 * (resuelta o descartada) y todas. 'abiertas' se mantiene como alias de pendientes.
 */
const FILTROS_ESTADO = {
  pendientes: ESTADOS_ABIERTOS,
  abiertas: ESTADOS_ABIERTOS,
  disponibles: [ESTADO_DISPONIBLE],
  cerradas: ['resuelta', 'descartada'],
  todas: null,
};

/**
 * GET /api/alertas-faltantes/insumos-especiales?estado=pendientes|disponibles|cerradas|todas
 * (gerencia y jop). Al abrir el panel se revisa primero (D17). Si la revisión
 * falla, se lista igual lo que hay y se avisa.
 */
async function listar(req, res) {
  const estado = req.query.estado || 'pendientes';
  if (!(estado in FILTROS_ESTADO)) return res.status(400).json({ error: 'Filtro de estado no válido.' });
  try {
    let revision = null, aviso = null;
    try { revision = await revisarVentas(req.user?.id); }
    catch (e) {
      console.error('Revisión de insumos especiales:', e);
      aviso = 'No se pudieron revisar las ventas ahora; se muestran las alertas registradas.';
    }
    res.json({ revision, aviso, ventana_dias: DIAS_VENTANA, alertas: await consultarAlertas({ estados: FILTROS_ESTADO[estado] }) });
  } catch (err) {
    responderError(res, err, 'Error listando alertas de insumos especiales:');
  }
}

/** POST /api/alertas-faltantes/insumos-especiales/revisar — gerencia. */
async function revisar(req, res) {
  try {
    const r = await revisarVentas(req.user?.id);
    res.json({
      ...r,
      message: r.nuevas + r.actualizadas + r.descartadas === 0
        ? `Sin cambios: ${r.revisados} insumo(s) especial(es) vendido(s) ya tienen su alerta.`
        : `${r.nuevas} alerta(s) nueva(s), ${r.actualizadas} actualizada(s) y ${r.descartadas} descartada(s) por venta cancelada.`,
    });
  } catch (err) {
    responderError(res, err, 'Error revisando ventas con insumos especiales:');
  }
}

/**
 * POST /api/alertas-faltantes/insumos-especiales/:id/reemplazar — gerencia. Exc 1.
 * Body: { sku_reemplazo, motivo }. Cierra la alerta (descartada) y crea una para el
 * material de reemplazo, con la misma venta y cantidad. La venta de Finanzas no se toca.
 */
async function reemplazar(req, res) {
  const { id } = req.params;
  const skuReemplazo = String(req.body.sku_reemplazo || '').trim().toUpperCase();
  const motivo = String(req.body.motivo || '').trim();
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la alerta debe ser numérico' });
  if (!skuReemplazo) return res.status(400).json({ error: 'Seleccione el material de reemplazo.' });
  if (!motivo) return res.status(400).json({ error: 'Ingrese el motivo del reemplazo.' });

  try {
    const r = await conTransaccion(async (client) => {
      const { rows: al } = await client.query(
        `SELECT material_sku AS sku, alerta_faltante_pedido_estado AS estado, alerta_faltante_pedido_origen AS origen,
                alerta_faltante_pedido_cantidad_requerida AS requerido, nota_venta_id_nota_venta AS venta
         FROM alerta_faltante_pedido WHERE alerta_faltante_pedido_id_alerta_faltante = $1 FOR UPDATE`,
        [id]
      );
      if (al.length === 0 || al[0].origen !== ORIGEN) throw new ErrorNegocio(404, { error: 'Alerta de insumo especial no encontrada' });
      const a = al[0];
      if (!ESTADOS_ABIERTOS.includes(a.estado)) {
        throw new ErrorNegocio(400, { error: `La alerta ya está cerrada (${a.estado}).` });
      }
      if (skuReemplazo === a.sku) throw new ErrorNegocio(400, { error: 'El reemplazo debe ser un material distinto.' });

      const { rows: mat } = await client.query(
        `SELECT material_sku AS sku, material_nombre_material AS nombre, material_estado AS estado,
                material_es_herramienta AS herramienta, material_descontinuado AS descontinuado
         FROM material WHERE UPPER(material_sku) = $1`,
        [skuReemplazo]
      );
      const m = mat[0];
      if (!m) throw new ErrorNegocio(400, { error: `El material ${skuReemplazo} no existe en el catálogo.` });
      if (m.estado !== 'activo' || m.herramienta || m.descontinuado) {
        throw new ErrorNegocio(400, { error: `${m.nombre} no sirve como reemplazo: está inactivo, descontinuado o es una herramienta.` });
      }
      const { rows: dup } = await client.query(
        `SELECT alerta_faltante_pedido_id_alerta_faltante AS id FROM alerta_faltante_pedido
         WHERE material_sku = $1 AND nota_venta_id_nota_venta IS NOT DISTINCT FROM $2
           AND alerta_faltante_pedido_estado = ANY($3::text[])`,
        [m.sku, a.venta, ESTADOS_ABIERTOS]
      );
      if (dup.length > 0) {
        throw new ErrorNegocio(409, { error: `Ya hay una alerta abierta (#${dup[0].id}) para ${m.nombre} en esta venta.` });
      }

      await client.query(
        `UPDATE alerta_faltante_pedido SET alerta_faltante_pedido_estado = 'descartada', usuario_id_usuario = $2
         WHERE alerta_faltante_pedido_id_alerta_faltante = $1`,
        [id, req.user.id]
      );
      const d = (await stockYProveedor(client, [m.sku])).get(m.sku);
      const { rows: nueva } = await client.query(
        `INSERT INTO alerta_faltante_pedido (alerta_faltante_pedido_cantidad_disponible,
           alerta_faltante_pedido_cantidad_requerida, alerta_faltante_pedido_estado, material_sku,
           proveedor_id_proveedor, alerta_faltante_pedido_origen, nota_venta_id_nota_venta)
         VALUES ($1, $2, 'activa', $3, $4, $5, $6)
         RETURNING alerta_faltante_pedido_id_alerta_faltante AS id`,
        [Math.max(d.disponible, 0), a.requerido, m.sku, d.proveedor_id, ORIGEN, a.venta]
      );
      return { original: a.sku, reemplazo: m, nueva: nueva[0].id };
    });

    await auditoria.registrar(req.user?.id, 'reemplazar_insumo_especial',
      `Alerta #${id} (${r.original}) reemplazada por #${r.nueva} (${r.reemplazo.sku}): ${motivo}`);
    res.json({
      message: `Reemplazo autorizado: la alerta #${id} se cerró y se creó la #${r.nueva} para ${r.reemplazo.nombre}.`,
      alerta_nueva: r.nueva,
    });
  } catch (err) {
    responderError(res, err, 'Error reemplazando insumo especial:');
  }
}

/* ══════════════════════════════════════════════════════════════════════
   CU-124 — Vinculando la recepción de un insumo especial a su pedido (venta)

   El lote recibido se RESERVA para la venta elegida: sube la cantidad reservada de
   esa fila de inventario_bodega (SKU + lote + bodega) y nace una reserva_inventario
   con la venta, el lote y la bodega. Invariante: reservas activas == reservado.
   Venta cubierta → la alerta pasa a 'disponible'; parcial (Exc 2) → sigue abierta
   con el saldo "en espera de recepción".
   ══════════════════════════════════════════════════════════════════════ */

/** Ventas que esperan un insumo especial: alertas abiertas con saldo, por fecha límite. */
async function ventasPendientes(db, sku) {
  const { rows } = await db.query(
    `SELECT afp.alerta_faltante_pedido_id_alerta_faltante AS alerta_id,
            afp.alerta_faltante_pedido_cantidad_requerida::float AS requerido,
            ${SQL_VINCULADO} AS vinculado,
            nv.numero_nota_venta AS venta, nv.estado_pedido AS venta_estado,
            TO_CHAR(nv.fecha_max_entrega, 'YYYY-MM-DD') AS entrega_maxima,
            c.nombre_razon_social AS cliente
     FROM alerta_faltante_pedido afp
     LEFT JOIN finanzas.nota_venta nv ON nv.id_nota_venta = afp.nota_venta_id_nota_venta
     LEFT JOIN finanzas.cliente_financiero c ON c.id_cliente_financiero = nv.id_cliente_financiero
     WHERE afp.alerta_faltante_pedido_origen = $1 AND afp.material_sku = $2
       AND afp.alerta_faltante_pedido_estado = ANY($3::text[])
     ORDER BY nv.fecha_max_entrega ASC NULLS LAST, afp.alerta_faltante_pedido_id_alerta_faltante`,
    [ORIGEN, sku, ESTADOS_ABIERTOS]
  );
  return rows
    .map(r => ({ ...r, pendiente: Math.max(Math.round((r.requerido - r.vinculado) * 1e4) / 1e4, 0) }))
    .filter(r => r.pendiente > 0);
}

/**
 * Llamada por registrarEntrada después del COMMIT: si el material es especial,
 * devuelve las ventas que lo esperan para vincular la recepción. Exc 1: si no hay
 * ninguna, avisa a Gerencia que queda en stock transitorio. null si no es especial.
 */
async function alRecibir({ sku, cantidad, movimientoId, loteId, bodegaId }) {
  const { rows } = await query(
    `SELECT material_nombre_material AS nombre, material_es_rotativo AS rotativo FROM material WHERE material_sku = $1`, [sku]
  );
  if (!rows[0] || rows[0].rotativo !== false) return null;
  const pendientes = await ventasPendientes({ query }, sku);
  if (pendientes.length === 0) {
    await notificarPorRol({
      tipo: 'insumo_especial',
      mensaje: `Se recibieron ${cantidad} de ${rows[0].nombre} (insumo especial) y ninguna venta lo espera: queda en ` +
               'stock transitorio. Indique qué hacer con él.',
      origen: 'movimientos',
      rol: 'gerencia',
    });
  }
  return {
    material: rows[0].nombre, cantidad: parseFloat(cantidad),
    movimiento_id: movimientoId, lote_id: loteId, bodega_id: bodegaId,
    pendientes,
    mensaje: pendientes.length === 0
      ? 'Ninguna venta pendiente requiere este insumo especial: queda en stock transitorio y se avisó a Gerencia.'
      : `${pendientes.length} venta(s) esperan este insumo especial: vincule la recepción.`,
  };
}

/**
 * POST /api/alertas-faltantes/insumos-especiales/vincular — gerencia y jop.
 * Body: { movimiento_id } (la entrada recién registrada) o { lote_id, bodega_id }
 * ("Vincular stock" después), y asignaciones: [{ alerta_id, cantidad }] (Exc 3:
 * el usuario reparte y prioriza). Todo se valida ANTES de tocar stock.
 */
async function vincular(req, res) {
  const { movimiento_id, lote_id, bodega_id } = req.body;
  const asignaciones = Array.isArray(req.body.asignaciones) ? req.body.asignaciones : [];
  const lista = asignaciones.map(a => ({ alerta_id: String(a.alerta_id), cantidad: Number(a.cantidad) }))
    .filter(a => a.cantidad !== 0);
  if (lista.length === 0) return res.status(400).json({ error: 'Indique a qué venta(s) asignar y cuánto.' });
  if (lista.some(a => !/^\d+$/.test(a.alerta_id) || !Number.isFinite(a.cantidad) || a.cantidad < 0)) {
    return res.status(400).json({ error: 'Las cantidades a asignar deben ser números mayores a cero.' });
  }
  if (new Set(lista.map(a => a.alerta_id)).size !== lista.length) {
    return res.status(400).json({ error: 'Cada venta se asigna una sola vez.' });
  }
  if (!movimiento_id && !(lote_id && bodega_id)) {
    return res.status(400).json({ error: 'Indique la entrada o el lote y la bodega a vincular.' });
  }

  try {
    const r = await conTransaccion(async (client) => {
      // Origen del stock: la entrada registrada, o un lote y bodega elegidos después
      let origen;
      if (movimiento_id) {
        const { rows } = await client.query(
          `SELECT mi.material_sku AS sku, mi.lote_id_lote AS lote_id, mi.bodega_id_bodega AS bodega_id,
                  mi.movimiento_inventario_estado AS estado, tm.movimiento_inventario_tipo_movimiento_nombre AS tipo
           FROM movimiento_inventario mi
           JOIN movimiento_inventario_tipo_movimiento tm
             ON tm.movimiento_inventario_tipo_movimiento_id_tipo_movimiento = mi.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
           WHERE mi.movimiento_inventario_id_movimiento = $1`,
          [movimiento_id]
        );
        if (rows.length === 0 || !/entrada/i.test(rows[0].tipo) || rows[0].estado !== 'completado') {
          throw new ErrorNegocio(400, { error: 'El movimiento indicado no es una entrada vigente.' });
        }
        origen = rows[0];
      } else {
        origen = { sku: null, lote_id: lote_id, bodega_id: bodega_id };
      }

      const { rows: alertas } = await client.query(
        `SELECT afp.alerta_faltante_pedido_id_alerta_faltante::text AS id, afp.material_sku AS sku,
                afp.alerta_faltante_pedido_estado AS estado, afp.alerta_faltante_pedido_origen AS origen,
                afp.nota_venta_id_nota_venta AS venta_id, nv.numero_nota_venta AS venta,
                afp.alerta_faltante_pedido_cantidad_requerida::float AS requerido
         FROM alerta_faltante_pedido afp
         LEFT JOIN finanzas.nota_venta nv ON nv.id_nota_venta = afp.nota_venta_id_nota_venta
         WHERE afp.alerta_faltante_pedido_id_alerta_faltante = ANY($1::bigint[])
         FOR UPDATE OF afp`,
        [lista.map(a => a.alerta_id)]
      );
      const porId = new Map(alertas.map(a => [a.id, a]));
      const sku = origen.sku || alertas[0]?.sku;
      for (const a of lista) {
        const al = porId.get(a.alerta_id);
        if (!al || al.origen !== ORIGEN) throw new ErrorNegocio(404, { error: `La alerta #${a.alerta_id} no es de un insumo especial.` });
        if (!ESTADOS_ABIERTOS.includes(al.estado)) throw new ErrorNegocio(400, { error: `La alerta de la venta ${al.venta} ya está cerrada (${al.estado}).` });
        if (al.sku !== sku) throw new ErrorNegocio(400, { error: `La venta ${al.venta} espera otro material (${al.sku}), no ${sku}.` });
      }

      // Saldo pendiente de cada venta y stock libre del lote, con candado
      const { rows: vinc } = await client.query(
        `SELECT afp.alerta_faltante_pedido_id_alerta_faltante::text AS id, ${SQL_VINCULADO} AS vinculado
         FROM alerta_faltante_pedido afp WHERE afp.alerta_faltante_pedido_id_alerta_faltante = ANY($1::bigint[])`,
        [lista.map(a => a.alerta_id)]
      );
      const vinculado = new Map(vinc.map(v => [v.id, v.vinculado]));
      const { rows: fila } = await client.query(
        `SELECT (inventario_bodega_cantidad_fisica - inventario_bodega_cantidad_reservada)::float AS libre
         FROM inventario_bodega WHERE material_sku = $1 AND lote_id_lote = $2 AND bodega_id_bodega = $3
         FOR UPDATE`,
        [sku, origen.lote_id, origen.bodega_id]
      );
      if (fila.length === 0) throw new ErrorNegocio(400, { error: 'Ese lote no tiene stock del insumo en la bodega indicada.' });

      const total = lista.reduce((s, a) => s + a.cantidad, 0);
      if (total > fila[0].libre + 1e-9) {
        throw new ErrorNegocio(409, {
          error: `El lote tiene ${fila[0].libre} libre(s) y se intenta asignar ${total}. Reparta como máximo lo disponible.`,
          libre: fila[0].libre,
        });
      }
      const detalle = lista.map(a => {
        const al = porId.get(a.alerta_id);
        const pendiente = Math.max(al.requerido - (vinculado.get(a.alerta_id) || 0), 0);
        if (a.cantidad > pendiente + 1e-9) {
          throw new ErrorNegocio(400, { error: `A la venta ${al.venta} le faltan ${pendiente}; no se le pueden asignar ${a.cantidad}.` });
        }
        return { ...a, al, pendiente };
      });

      // Recién ahora se escribe: stock reservado, reservas y estado de las alertas
      await client.query(
        `UPDATE inventario_bodega SET inventario_bodega_cantidad_reservada = inventario_bodega_cantidad_reservada + $4
         WHERE material_sku = $1 AND lote_id_lote = $2 AND bodega_id_bodega = $3`,
        [sku, origen.lote_id, origen.bodega_id, total]
      );
      const resultado = [];
      for (const d of detalle) {
        const { rows: res_ } = await client.query(
          `INSERT INTO reserva_inventario (reserva_inventario_cantidad_reservada, reserva_inventario_estado_reserva,
             material_sku, nota_venta_id_nota_venta, lote_id_lote, bodega_id_bodega)
           VALUES ($1, 'activa', $2, $3, $4, $5)
           RETURNING reserva_inventario_id_reserva AS id`,
          [d.cantidad, sku, d.al.venta_id, origen.lote_id, origen.bodega_id]
        );
        const saldo = Math.max(Math.round((d.pendiente - d.cantidad) * 1e4) / 1e4, 0);
        if (saldo === 0) {
          await client.query(
            `UPDATE alerta_faltante_pedido SET alerta_faltante_pedido_estado = $2, usuario_id_usuario = $3
             WHERE alerta_faltante_pedido_id_alerta_faltante = $1`,
            [d.alerta_id, ESTADO_DISPONIBLE, req.user.id]
          );
        }
        resultado.push({ alerta_id: d.alerta_id, venta: d.al.venta, reserva_id: res_[0].id, cantidad: d.cantidad, saldo });
      }
      // Para la auditoría: el número de lote que se ve en pantalla, no el id interno
      const { rows: lt } = await client.query(`SELECT lote_numero_lote AS n FROM lote WHERE lote_id_lote = $1`, [origen.lote_id]);
      return { sku, lote_id: origen.lote_id, lote: lt[0]?.n || `#${origen.lote_id}`, bodega_id: origen.bodega_id, resultado };
    });

    for (const x of r.resultado) {
      await auditoria.registrar(req.user?.id, 'vincular_insumo_especial',
        `Reserva #${x.reserva_id}: ${x.cantidad} ${r.sku} lote ${r.lote} → ${x.venta}` + (x.saldo > 0 ? ` (faltan ${x.saldo})` : ''));
    }
    const completas = r.resultado.filter(x => x.saldo === 0).map(x => x.venta);
    const parciales = r.resultado.filter(x => x.saldo > 0);
    res.json({
      message: 'Recepción vinculada. ' +
        (completas.length ? `Disponible para: ${completas.join(', ')}. ` : '') +
        (parciales.length ? 'En espera de recepción: ' + parciales.map(x => `${x.venta} (faltan ${x.saldo})`).join(', ') + '.' : ''),
      ...r,
    });
  } catch (err) {
    responderError(res, err, 'Error vinculando la recepción del insumo especial:');
  }
}

/**
 * GET /api/alertas-faltantes/insumos-especiales/:id/lotes — gerencia y jop.
 * "Vincular stock" después de la entrada: lotes del insumo con stock libre.
 */
async function lotesLibres(req, res) {
  const { id } = req.params;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id de la alerta debe ser numérico' });
  try {
    const pend = await query(
      `SELECT afp.material_sku AS sku, afp.alerta_faltante_pedido_origen AS origen, afp.alerta_faltante_pedido_estado AS estado
       FROM alerta_faltante_pedido afp WHERE afp.alerta_faltante_pedido_id_alerta_faltante = $1`, [id]
    );
    const a = pend.rows[0];
    if (!a || a.origen !== ORIGEN) return res.status(404).json({ error: 'Alerta de insumo especial no encontrada' });
    const venta = (await ventasPendientes({ query }, a.sku)).find(v => String(v.alerta_id) === String(id)) || null;
    const { rows } = await query(
      `SELECT ib.lote_id_lote AS lote_id, l.lote_numero_lote AS lote, ib.bodega_id_bodega AS bodega_id,
              b.bodega_nombre_bodega AS bodega, TO_CHAR(l.lote_fecha_ingreso, 'YYYY-MM-DD') AS ingreso,
              (ib.inventario_bodega_cantidad_fisica - ib.inventario_bodega_cantidad_reservada)::float AS libre
       FROM inventario_bodega ib
       JOIN lote l ON l.lote_id_lote = ib.lote_id_lote
       JOIN bodega b ON b.bodega_id_bodega = ib.bodega_id_bodega
       WHERE ib.material_sku = $1 AND ib.inventario_bodega_cantidad_fisica - ib.inventario_bodega_cantidad_reservada > 0
       ORDER BY l.lote_fecha_ingreso DESC NULLS LAST, ib.lote_id_lote DESC`,
      [a.sku]
    );
    res.json({ sku: a.sku, venta, lotes: rows });
  } catch (err) {
    responderError(res, err, 'Error listando lotes del insumo especial:');
  }
}

module.exports = {
  revisarVentas, listar, revisar, reemplazar, restarDiasHabiles, ORIGEN,
  alRecibir, vincular, lotesLibres,   // CU-124
};
