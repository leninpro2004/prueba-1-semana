const jwt = require('jsonwebtoken');
const { query } = require('../db/pool');
const { ErrorNegocio, conTransaccion, responderError } = require('../db/tx');
const { tipoMovimientoId, motivoMovimientoId, motivoDevolucionConsumo, descontarFifo } = require('../db/stock');
const auditoria = require('./auditoriaController');
const { generarAlertasAutomaticas } = require('./alertasController');
const insumosEspeciales = require('./insumosEspecialesController');   // CU-124

// CU-106 CP2: el reintento por errores de concurrencia (serialization failure /
// deadlock) lo hace ahora conTransaccion() en db/tx.js, reintentando la
// transaccion COMPLETA. El helper queryConReintento() que vivia aqui quedo sin
// uso al pasar registrarEntrada y registrarSalida a transacciones y se elimino:
// reintentar UNA query dentro de una transaccion ya abortada no sirve de nada.

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Fecha local YYYY-MM-DD de hoy (nunca desde toISOString(), que es UTC). */
function hoyLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// CU-30 Exc 3: mismo mensaje en entrada y salida
const mensajeInactivo = (sku) =>
  `El producto ${sku} está inactivo o dado de baja y no admite movimientos. Reactívelo desde su ficha para continuar.`;

// CU-31: FROM y WHERE compartidos por la pagina y el conteo del historial.
// movimiento_inventario guarda UNA bodega: es el origen en una salida y el destino
// en una entrada. En los demas tipos (ajuste, reverso, transferencia) no se sabe
// el sentido, asi que la misma bodega aparece como origen y destino.
const HISTORIAL_FROM = `
       FROM movimiento_inventario mi
       JOIN material m   ON m.material_sku = mi.material_sku
       JOIN movimiento_inventario_tipo_movimiento tm
            ON tm.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
             = mi.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
       LEFT JOIN bodega b ON b.bodega_id_bodega = mi.bodega_id_bodega
       LEFT JOIN movimiento_inventario_motivo_movimiento mot
            ON mot.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
             = mi.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
       LEFT JOIN movimiento_inventario_clasificacion_salida cs
            ON cs.movimiento_inventario_clasificacion_salida_id_clasificacion_salida
             = mot.movimiento_inventario_clasificacion_salida_id_clasificacion_salida
       LEFT JOIN usuario u ON u.usuario_id_usuario = mi.usuario_id_usuario
       LEFT JOIN lote l    ON l.lote_id_lote = mi.lote_id_lote
       LEFT JOIN terreno.proyecto p ON p.id_proyecto = mi.proyecto_id_proyecto
       LEFT JOIN proveedor prov ON prov.proveedor_id_proveedor = l.proveedor_id_proveedor
       -- CU-31: documento asociado. La factura del movimiento, o la del lote si es la entrada
       -- que lo trajo (en una salida, la factura del lote consumido no es SU documento).
       -- CU-107: una devolucion (motivo devolucion_consumo, o entrada con OT anterior a ese
       -- motivo), un inverso de CU-44 o una entrada de otro modulo vuelven a un lote que
       -- ya existia: la factura de ese lote tampoco es su documento.
       LEFT JOIN factura_compra fmi ON fmi.factura_compra_id_factura = mi.factura_compra_id_factura_compra
       LEFT JOIN factura_compra fl  ON fl.factura_compra_id_factura  = l.factura_compra_id_factura
       CROSS JOIN LATERAL (
         SELECT lower(tm.movimiento_inventario_tipo_movimiento_nombre) AS tipo_norm,
                COALESCE(fmi.factura_compra_numero_factura,
                         CASE WHEN lower(tm.movimiento_inventario_tipo_movimiento_nombre) LIKE '%entrada%'
                               AND COALESCE(lower(mot.movimiento_inventario_motivo_movimiento_nombre), '') <> 'devolucion_consumo'
                               AND mi.orden_trabajo_id_orden IS NULL
                               AND mi.movimiento_inventario_id_revertido IS NULL
                               AND mi.movimiento_inventario_modulo_origen = 'inventario'
                              THEN fl.factura_compra_numero_factura END) AS factura_numero
       ) x
       WHERE ($1::text IS NULL OR
              mi.material_sku ILIKE '%' || $1 || '%' OR
              m.material_nombre_material ILIKE '%' || $1 || '%' OR
              u.usuario_username ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR tm.movimiento_inventario_tipo_movimiento_nombre ILIKE '%' || $2 || '%')
         AND ($3::date IS NULL OR mi.movimiento_inventario_fecha_hora >= $3::date)
         AND ($4::date IS NULL OR mi.movimiento_inventario_fecha_hora < ($4::date + INTERVAL '1 day'))
         AND ($5::bigint IS NULL OR mi.orden_trabajo_id_orden = $5::bigint)
         AND ($6::bigint IS NULL OR mi.bodega_id_bodega = $6::bigint)
         AND ($7::text IS NULL
              OR ($7 = 'activo' AND mi.movimiento_inventario_estado NOT IN ('revertido','pendiente_aprobacion','rechazado'))
              OR ($7 <> 'activo' AND mi.movimiento_inventario_estado = $7))`;

const LIMITE_EXPORTACION = 10000;

/**
 * GET /api/movimientos
 * Historial de movimientos con filtros
 * Query params: ?buscar=&tipo=&desde=&hasta=&page=&limit=&orden_trabajo_id=&bodega_id=&estado=&paginado=
 *
 * CU-31: con ?paginado=1 responde { movimientos, total, page, limit }. Sin el
 * parametro responde el array de siempre (lo usan el Dashboard y la ficha de producto).
 */
async function listar(req, res) {
  // OPUS-9 (Req #1): orden_trabajo_id acota el historial a una OT concreta
  const { buscar, tipo, desde, hasta, orden_trabajo_id, bodega_id, estado, paginado } = req.query;
  // CU-76: con ?exportar=1 trae todo lo filtrado hasta el límite del CSV, más una
  // fila para que la vista sepa que se pasó (Exc 1). La vista pagina de a 50.
  const exportar = req.query.exportar === '1';
  const page  = exportar ? 1 : Math.max(parseInt(req.query.page) || 1, 1);
  const limit = exportar ? LIMITE_EXPORTACION + 1 : Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 500);
  const offset = (page - 1) * limit;

  // CU-31 Exc 3: rango de fechas coherente, antes de consultar
  if ((desde && !FECHA_ISO.test(desde)) || (hasta && !FECHA_ISO.test(hasta))) {
    return res.status(400).json({ error: 'Las fechas deben tener el formato AAAA-MM-DD.' });
  }
  if (desde && hasta && desde > hasta) {
    return res.status(400).json({ error: 'La fecha de inicio es posterior a la fecha de fin. Corrija el rango antes de consultar.' });
  }

  const filtros = [buscar || null, tipo || null, desde || null, hasta || null,
                   orden_trabajo_id || null, bodega_id || null, estado || null];

  try {
    const { rows } = await query(
      `SELECT
         mi.movimiento_inventario_id_movimiento          AS id,
         mi.movimiento_inventario_fecha_hora             AS fecha_hora,
         mi.movimiento_inventario_cantidad               AS cantidad,
         mi.movimiento_inventario_estado                 AS estado,
         mi.material_sku                                 AS sku,
         m.material_nombre_material                      AS material_nombre,
         b.bodega_nombre_bodega                          AS bodega,
         tm.movimiento_inventario_tipo_movimiento_nombre AS tipo,
         mot.movimiento_inventario_motivo_movimiento_nombre AS motivo,
         cs.movimiento_inventario_clasificacion_salida_nombre AS clasificacion_salida,
         u.usuario_username                              AS usuario,
         l.lote_numero_lote                              AS lote,
         p.nombre_referencia                             AS proyecto_nombre,
         p.codigo_proyecto                               AS proyecto_codigo,
         prov.proveedor_razon_social                     AS proveedor,
         mi.orden_trabajo_id_orden                       AS orden_trabajo_id,
         mi.movimiento_inventario_descripcion_motivo     AS descripcion_motivo,
         mi.movimiento_inventario_evidencia_url          AS evidencia_url,
         -- CU-44: el inverso apunta al original; el original sabe qué inverso lo anuló
         mi.movimiento_inventario_id_revertido           AS revierte_a,
         (SELECT inv.movimiento_inventario_id_movimiento FROM movimiento_inventario inv
          WHERE inv.movimiento_inventario_id_revertido = mi.movimiento_inventario_id_movimiento
          ORDER BY 1 LIMIT 1)                            AS revertido_por,
         -- CU-31: origen y destino derivados del tipo (ver HISTORIAL_FROM)
         CASE WHEN x.tipo_norm LIKE '%entrada%' THEN NULL ELSE b.bodega_nombre_bodega END AS bodega_origen,
         CASE WHEN x.tipo_norm LIKE '%salida%'  THEN NULL ELSE b.bodega_nombre_bodega END AS bodega_destino,
         -- CU-31: documento asociado, por prioridad: factura, OT, referencia del modulo de
         -- origen (CU-107, ej. "Terreno: OBRA-2026-015"), evidencia de la merma.
         -- Sesión 15: también la venta de un despacho (CU-127), el traslado (D60) y el ajuste por conteo (D53).
         CASE WHEN x.factura_numero IS NOT NULL THEN 'factura'
              WHEN mi.orden_trabajo_id_orden IS NOT NULL THEN 'ot'
              WHEN mot.movimiento_inventario_motivo_movimiento_nombre = 'despacho_venta'
                   AND mi.movimiento_inventario_referencia_origen IS NOT NULL THEN 'venta'
              WHEN mi.movimiento_inventario_referencia_origen LIKE 'TRASLADO-%' THEN 'traslado'
              WHEN mi.movimiento_inventario_referencia_origen LIKE 'CONTEO-%' THEN 'conteo'
              WHEN mi.movimiento_inventario_modulo_origen <> 'inventario' THEN 'origen'
              WHEN mi.movimiento_inventario_evidencia_url IS NOT NULL THEN 'evidencia'
         END AS documento_tipo,
         CASE WHEN x.factura_numero IS NOT NULL THEN x.factura_numero
              WHEN mi.orden_trabajo_id_orden IS NOT NULL THEN mi.orden_trabajo_id_orden::text
              WHEN mot.movimiento_inventario_motivo_movimiento_nombre = 'despacho_venta'
                   AND mi.movimiento_inventario_referencia_origen IS NOT NULL THEN mi.movimiento_inventario_referencia_origen
              WHEN mi.movimiento_inventario_referencia_origen LIKE 'TRASLADO-%'
                THEN substring(mi.movimiento_inventario_referencia_origen FROM 10)
              WHEN mi.movimiento_inventario_referencia_origen LIKE 'CONTEO-%'
                THEN substring(mi.movimiento_inventario_referencia_origen FROM 8)
              WHEN mi.movimiento_inventario_modulo_origen <> 'inventario'
                THEN initcap(mi.movimiento_inventario_modulo_origen) || ': ' ||
                     COALESCE(mi.movimiento_inventario_referencia_origen, 'sin referencia')
              ELSE mi.movimiento_inventario_evidencia_url
         END AS documento_ref
       ${HISTORIAL_FROM}
       ORDER BY mi.movimiento_inventario_fecha_hora DESC, mi.movimiento_inventario_id_movimiento DESC
       LIMIT $8 OFFSET $9`,
      [...filtros, limit, offset]
    );
    // descripcion_motivo y evidencia_url venían de una SEGUNDA consulta a la
    // misma tabla, envuelta en try/catch "por si las columnas no existen".
    // Existen las dos y están en el DDL, así que ahora salen en el SELECT
    // principal: una consulta menos por request y sin un catch que se tragaba
    // errores reales.
    if (!paginado) return res.json(rows);

    // CU-31 Exc 2: el total permite paginar en el servidor y avisar si supera 500
    const { rows: cnt } = await query(`SELECT count(*)::int AS total ${HISTORIAL_FROM}`, filtros);
    res.json({ movimientos: rows, total: cnt[0].total, page, limit });
  } catch (err) {
    console.error('Error listando movimientos:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/movimientos/catalogos
 * Tipos y motivos de movimiento para los formularios
 */
async function catalogos(req, res) {
  try {
    const [tipos, motivos, clasificaciones] = await Promise.all([
      query(`SELECT movimiento_inventario_tipo_movimiento_id_tipo_movimiento AS id,
                    movimiento_inventario_tipo_movimiento_nombre AS nombre
             FROM movimiento_inventario_tipo_movimiento ORDER BY nombre`),
      query(`SELECT movimiento_inventario_motivo_movimiento_id_motivo_movimiento AS id,
                    movimiento_inventario_motivo_movimiento_nombre AS nombre,
                    movimiento_inventario_clasificacion_salida_id_clasificacion_salida AS clasificacion_id
             FROM movimiento_inventario_motivo_movimiento ORDER BY nombre`),
      query(`SELECT movimiento_inventario_clasificacion_salida_id_clasificacion_salida AS id,
                    movimiento_inventario_clasificacion_salida_nombre AS nombre
             FROM movimiento_inventario_clasificacion_salida ORDER BY nombre`),
    ]);
    res.json({
      tipos: tipos.rows,
      motivos: motivos.rows,
      clasificaciones: clasificaciones.rows,
    });
  } catch (err) {
    console.error('Error obteniendo catalogos:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/movimientos/entrada
 * Registrar entrada de stock (FR-18, FR-22)
 */
async function registrarEntrada(req, res) {
  const {
    sku, bodega_id, cantidad,
    proveedor_id, numero_lote, fecha_vencimiento,
    tipo_movimiento_id, precio_unitario,
    anaquel_id,                                  // OPUS-5: anaquel destino (opcional)
    factura_id, factura_numero, factura_fecha,   // CU-28/CU-32
    fecha_pedido, fecha_recepcion,               // CU-62
    tipo_entrada = 'compra', descripcion_motivo  // D66: compra o devolución de obra
  } = req.body;

  const userId = req.user.id;

  if (!sku || !bodega_id || !cantidad || !tipo_movimiento_id) {
    return res.status(400).json({ error: 'SKU, bodega, cantidad y tipo de movimiento son requeridos' });
  }
  if (cantidad <= 0) {
    return res.status(400).json({ error: 'La cantidad debe ser mayor a 0' });
  }

  // CU-32 Exc 1: si se proporciona uno, ambos son obligatorios
  if ((factura_numero && !factura_fecha) || (!factura_numero && factura_fecha)) {
    return res.status(400).json({
      error: 'Para asociar una factura debe ingresar tanto el número de factura como la fecha de emisión.'
    });
  }

  // factura_compra.proveedor_id_proveedor es NOT NULL: sin proveedor el INSERT
  // reventaba con un 500 genérico. Detectado al escribir los tests.
  if (factura_numero && !proveedor_id) {
    return res.status(400).json({
      error: 'Para asociar una factura debe indicar el proveedor.'
    });
  }

  // CU-32 Exc 2: validar formato y rango de la fecha de factura
  if (factura_fecha) {
    const fechaFactura = new Date(factura_fecha);
    if (isNaN(fechaFactura.getTime())) {
      return res.status(400).json({ error: 'La fecha de emisión de la factura no tiene un formato válido.' });
    }
    const hoy = new Date();
    hoy.setHours(23, 59, 59, 999);
    if (fechaFactura > hoy) {
      return res.status(400).json({ error: 'La fecha de emisión de la factura no puede ser una fecha futura.' });
    }
  }

  // CU-62: fecha del pedido al proveedor y fecha de recepción. El formulario ya las
  // pedía, pero no se enviaban: la recepción quedaba siempre "hoy" y el pedido se perdía.
  if ((fecha_pedido && !FECHA_ISO.test(fecha_pedido)) || (fecha_recepcion && !FECHA_ISO.test(fecha_recepcion))) {
    return res.status(400).json({ error: 'Las fechas de pedido y de recepción deben tener el formato AAAA-MM-DD.' });
  }
  if (fecha_recepcion && fecha_recepcion > hoyLocal()) {
    return res.status(400).json({ error: 'La fecha de recepción no puede ser una fecha futura.' });
  }
  if (fecha_pedido && fecha_pedido > (fecha_recepcion || hoyLocal())) {
    return res.status(400).json({ error: 'La fecha del pedido no puede ser posterior a la recepción.' });
  }

  // D66: dos tipos de entrada. Compra: proveedor, precio, fecha del pedido y factura
  // obligatorios (D56). Devolución de obra: vuelve material despachado o consumido; no
  // lleva proveedor, precio ni factura, y resta del consumo (motivo devolucion_consumo).
  if (!['compra', 'devolucion'].includes(tipo_entrada)) {
    return res.status(400).json({ error: 'El tipo de entrada debe ser compra o devolución de obra.' });
  }
  const esDevolucion = tipo_entrada === 'devolucion';
  const descripcion = String(descripcion_motivo ?? '').trim();
  if (descripcion.length > 255) return res.status(400).json({ error: 'La descripción admite hasta 255 caracteres.' });
  if (esDevolucion) {
    if (!descripcion) return res.status(400).json({ error: 'Indique de qué obra o venta vuelve el material.' });
    if (proveedor_id || precio_unitario || factura_id || factura_numero || fecha_pedido) {
      return res.status(400).json({ error: 'Una devolución de obra no lleva proveedor, precio, factura ni fecha de pedido.' });
    }
  } else {
    const faltan = [];
    if (!proveedor_id) faltan.push('el proveedor');
    if (!(parseFloat(precio_unitario) > 0)) faltan.push('el precio unitario (mayor que 0)');
    if (!fecha_pedido) faltan.push('la fecha del pedido');
    if (!factura_id && !(factura_numero && factura_fecha)) faltan.push('la factura (número y fecha de emisión)');
    if (faltan.length) return res.status(400).json({ error: `En una compra falta ${faltan.join(', ')}.` });
  }

  try {
    /* ══════════════════════════════════════════════════════════════════
       Todo lo que escribe (lote + factura_compra + movimiento_inventario +
       inventario_bodega + historial_precio_material) va en UNA transaccion.
       Antes eran llamadas sueltas: si fallaba a mitad quedaba, por ejemplo, el
       lote y la factura creados pero sin movimiento ni stock.
       ══════════════════════════════════════════════════════════════════ */
    const r = await conTransaccion(async (client) => {
      // El material debe existir
      const { rows: mat } = await client.query(
        `SELECT material_sku, material_estado FROM material WHERE material_sku = $1`, [sku]
      );
      if (mat.length === 0) {
        throw new ErrorNegocio(404, { error: 'Material no encontrado' });
      }
      // CU-30 Exc 3: un producto inactivo o dado de baja no admite movimientos
      if (mat[0].material_estado !== 'activo') {
        throw new ErrorNegocio(400, { error: mensajeInactivo(sku) });
      }

      // OPUS-5: el anaquel destino, si se informa, debe pertenecer a la bodega destino
      if (anaquel_id) {
        const { rows: anaquel } = await client.query(
          `SELECT anaquel_id_anaquel, bodega_id_bodega FROM anaquel WHERE anaquel_id_anaquel = $1`,
          [anaquel_id]
        );
        if (anaquel.length === 0) {
          throw new ErrorNegocio(404, { error: 'El anaquel indicado no existe' });
        }
        if (String(anaquel[0].bodega_id_bodega) !== String(bodega_id)) {
          throw new ErrorNegocio(400, { error: 'El anaquel seleccionado no pertenece a la bodega de destino' });
        }
      }

      /* ── Lote: reusar el existente o crear uno nuevo ── */
      let loteId;
      if (numero_lote) {
        const { rows: loteExist } = await client.query(
          `SELECT lote_id_lote FROM lote WHERE lote_numero_lote = $1`, [numero_lote]
        );
        if (loteExist.length > 0) {
          loteId = loteExist[0].lote_id_lote;
        } else {
          // CU-62: la recepción es la informada; el ingreso sigue siendo now() (ordena el FIFO)
          const { rows: loteNuevo } = await client.query(
            `INSERT INTO lote (lote_numero_lote, lote_fecha_ingreso, lote_fecha_vencimiento,
                               lote_fecha_recepcion, lote_estado, proveedor_id_proveedor)
             VALUES ($1, now(), $2, COALESCE($4::date, now()), 'activo', $3)
             RETURNING lote_id_lote`,
            [numero_lote, fecha_vencimiento || null, proveedor_id || null, fecha_recepcion || null]
          );
          loteId = loteNuevo[0].lote_id_lote;
        }
      } else {
        // Lote con numero automatico LOTE-YYYYMMDD-{id}
        const { rows: loteGen } = await client.query(
          `INSERT INTO lote (lote_fecha_ingreso, lote_fecha_recepcion, lote_estado, proveedor_id_proveedor)
           VALUES (now(), COALESCE($2::date, now()), 'activo', $1)
           RETURNING lote_id_lote`,
          [proveedor_id || null, fecha_recepcion || null]
        );
        loteId = loteGen[0].lote_id_lote;
        const fechaStr = hoyLocal().replace(/-/g, '');   // fecha local (toISOString daba mañana de noche)
        await client.query(
          `UPDATE lote SET lote_numero_lote = $1 WHERE lote_id_lote = $2`,
          [`LOTE-${fechaStr}-${loteId}`, loteId]
        );
      }

      /* ── CU-62: fecha del pedido al proveedor (el precio es opcional) ── */
      if (fecha_pedido) {
        await client.query(
          `INSERT INTO lote_fecha_pedido (lote_fecha_pedido_fecha_pedido, lote_fecha_pedido_precio_unitario, lote_id_lote)
           VALUES ($1, $2, $3)`,
          [fecha_pedido, precio_unitario || null, loteId]
        );
      }

      /* ── Factura de compra (CU-28/CU-32) ── */
      let facturaId = null;
      if (factura_numero) {
        // CU-32 Exc 3: numero de factura duplicado. Va DENTRO de la transaccion
        // para que dos entradas simultaneas no creen la misma factura dos veces.
        // D66: una factura trae varios productos: la del MISMO proveedor y fecha se reutiliza.
        const { rows: facDup } = await client.query(
          `SELECT factura_compra_id_factura AS id, proveedor_id_proveedor::text AS proveedor,
                  to_char(factura_compra_fecha_emision, 'YYYY-MM-DD') AS fecha
           FROM factura_compra WHERE factura_compra_numero_factura = $1`, [factura_numero]
        );
        if (facDup.length > 0) {
          const d = facDup[0];
          if (d.proveedor !== String(proveedor_id) || (factura_fecha && d.fecha !== String(factura_fecha).slice(0, 10))) {
            throw new ErrorNegocio(409, {
              error: 'El número de factura "' + factura_numero + '" ya está registrado ' +
                     (d.proveedor !== String(proveedor_id) ? 'con otro proveedor' : `con otra fecha de emisión (${d.fecha})`) + '. Verifique el documento.'
            });
          }
          facturaId = d.id;
        }
      }

      if (factura_id) {
        facturaId = factura_id;
      } else if (facturaId) {
        // D66: factura existente del mismo proveedor: el lote nuevo también apunta a ella
        await client.query(`UPDATE lote SET factura_compra_id_factura = $1 WHERE lote_id_lote = $2`, [facturaId, loteId]);
      } else if (factura_numero && factura_fecha) {
        const { rows: facNueva } = await client.query(
          `INSERT INTO factura_compra (
             factura_compra_numero_factura, factura_compra_fecha_emision, proveedor_id_proveedor
           ) VALUES ($1, $2, $3)
           RETURNING factura_compra_id_factura AS id`,
          [factura_numero, factura_fecha, proveedor_id || null]
        );
        facturaId = facNueva[0].id;
        await client.query(
          `UPDATE lote SET factura_compra_id_factura = $1 WHERE lote_id_lote = $2`,
          [facturaId, loteId]
        );
      }

      /* ── Movimiento de entrada ── */
      // D66: la compra lleva compra_proveedor; la devolución, devolucion_consumo (resta del consumo)
      const motivoId = esDevolucion ? await motivoDevolucionConsumo(client) : await motivoMovimientoId(client, 'compra_proveedor');
      const { rows: mov } = await client.query(
        `INSERT INTO movimiento_inventario (
           movimiento_inventario_cantidad, movimiento_inventario_estado,
           material_sku, bodega_id_bodega, lote_id_lote,
           usuario_id_usuario, movimiento_inventario_tipo_movimiento_id_tipo_movimiento,
           factura_compra_id_factura_compra, movimiento_inventario_motivo_movimiento_id_motivo_movimiento,
           movimiento_inventario_descripcion_motivo
         ) VALUES ($1, 'completado', $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING movimiento_inventario_id_movimiento AS id`,
        [cantidad, sku, bodega_id, loteId, userId, tipo_movimiento_id, facturaId, motivoId, descripcion || null]
      );

      /* ── Stock (OPUS-5: con anaquel destino) ──
         Sin queryConReintento: conTransaccion ya reintenta la transaccion COMPLETA
         ante 40001/40P01, que es lo unico que sirve dentro de una transaccion. */
      await client.query(
        `INSERT INTO inventario_bodega
           (material_sku, lote_id_lote, bodega_id_bodega, inventario_bodega_cantidad_fisica, anaquel_id_anaquel)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (material_sku, lote_id_lote, bodega_id_bodega)
         DO UPDATE SET inventario_bodega_cantidad_fisica =
                         inventario_bodega.inventario_bodega_cantidad_fisica + EXCLUDED.inventario_bodega_cantidad_fisica,
                       anaquel_id_anaquel =
                         COALESCE(EXCLUDED.anaquel_id_anaquel, inventario_bodega.anaquel_id_anaquel)`,
        [sku, loteId, bodega_id, cantidad, anaquel_id || null]
      );

      /* ── SONNET-9: historial de precios cuando se informa precio + proveedor ── */
      if (precio_unitario && proveedor_id) {
        await client.query(
          `INSERT INTO historial_precio_material
             (material_sku, proveedor_id_proveedor, precio_unitario, fecha_vigencia_desde, fuente, factura_compra_id, lote_fecha_pedido_id, usuario_id_usuario)
           VALUES ($1, $2, $3, CURRENT_DATE, 'factura', $4, NULL, $5)`,
          [sku, proveedor_id, precio_unitario, facturaId, userId]
        );
      }

      return { movimientoId: mov[0].id, loteId };
    });

    /* ── Post-commit: auditoria y efectos secundarios (no deben revertir la entrada) ── */
    auditoria.registrar(req.user?.id, 'registrar_entrada',
      `SKU: ${sku}, cantidad: ${cantidad}, bodega: ${bodega_id}` + (anaquel_id ? `, anaquel: ${anaquel_id}` : ''));
    generarAlertasAutomaticas().catch(e => console.warn('Alertas:', e.message));

    // CU-114: Verificar si hay alertas de faltante activas para este SKU
    let alertas_faltante = [];
    try {
      const { rows: alertaRows } = await query(
        `SELECT afp.alerta_faltante_pedido_id_alerta_faltante AS id,
                afp.alerta_faltante_pedido_cantidad_disponible AS cantidad_disponible,
                afp.alerta_faltante_pedido_cantidad_requerida AS cantidad_requerida,
                afp.alerta_faltante_pedido_estado AS estado,
                afp.proyecto_id_proyecto AS proyecto_id
         FROM alerta_faltante_pedido afp
         WHERE afp.material_sku = $1
           AND afp.alerta_faltante_pedido_estado IN ('activa', 'en_gestion')
           -- CU-124: las de insumo especial no se resuelven por stock: se VINCULAN a su venta
           AND afp.alerta_faltante_pedido_origen = 'faltante'`,
        [sku]
      );
      alertas_faltante = alertaRows;

      // CU-114: Auto-resolver alertas si el stock ahora cubre el requerimiento
      if (alertaRows.length > 0) {
        const { rows: stockRows } = await query(
          `SELECT COALESCE(SUM(inventario_bodega_cantidad_fisica - inventario_bodega_cantidad_reservada), 0) AS disponible
           FROM inventario_bodega WHERE material_sku = $1`,
          [sku]
        );
        const stockActual = parseFloat(stockRows[0]?.disponible || 0);

        for (const alerta of alertaRows) {
          const requerido = parseFloat(alerta.cantidad_requerida || 0);
          if (stockActual >= requerido) {
            await query(
              `UPDATE alerta_faltante_pedido
               SET alerta_faltante_pedido_estado = 'resuelta',
                   alerta_faltante_pedido_cantidad_disponible = $2
               WHERE alerta_faltante_pedido_id_alerta_faltante = $1`,
              [alerta.id, stockActual]
            );
            auditoria.registrar(req.user?.id, 'auto_resolver_faltante',
              `Alerta #${alerta.id} resuelta automáticamente tras ingreso de ${sku}. Stock actual: ${stockActual}`);
          } else {
            // CU-114 CP2: Stock aumentó pero no cubre requerimiento — marcar en gestión
            const disponibleAnterior = parseFloat(alerta.cantidad_disponible || 0);
            if (stockActual > disponibleAnterior) {
              await query(
                `UPDATE alerta_faltante_pedido
                 SET alerta_faltante_pedido_estado = 'en_gestion',
                     alerta_faltante_pedido_cantidad_disponible = $2
                 WHERE alerta_faltante_pedido_id_alerta_faltante = $1`,
                [alerta.id, stockActual]
              );
              auditoria.registrar(req.user?.id, 'actualizar_faltante',
                `Alerta #${alerta.id} actualizada a en_gestion tras ingreso de ${sku}. Stock: ${disponibleAnterior} → ${stockActual} (requerido: ${requerido})`);
            }
          }
        }

        // Refrescar lista tras auto-resolución
        const { rows: alertasPostResolve } = await query(
          `SELECT alerta_faltante_pedido_id_alerta_faltante AS id,
                  alerta_faltante_pedido_estado AS estado
           FROM alerta_faltante_pedido
           WHERE material_sku = $1
             AND alerta_faltante_pedido_estado IN ('activa', 'en_gestion')
             AND alerta_faltante_pedido_origen = 'faltante'`,
          [sku]
        );
        alertas_faltante = alertasPostResolve;
      }
    } catch (e) {
      console.warn('CU-114: Error consultando alertas faltante:', e.message);
    }

    // CU-114: Buscar proveedor con mejor tiempo de reposición para aviso
    let proveedor_info = null;
    try {
      const { rows: provRows } = await query(
        `SELECT p.proveedor_nombre_proveedor AS nombre,
                mp.material_proveedor_tiempo_reposicion AS tiempo_reposicion
         FROM material_proveedor mp
         JOIN proveedor p ON p.proveedor_id_proveedor = mp.proveedor_id_proveedor
         WHERE mp.material_sku = $1
         ORDER BY mp.material_proveedor_proveedor_principal DESC,
                  mp.material_proveedor_tiempo_reposicion ASC NULLS LAST
         LIMIT 1`,
        [sku]
      );
      if (provRows.length > 0) proveedor_info = provRows[0];
    } catch { /* dato opcional de la respuesta: si falla, se omite */ }

    // CU-124: si es un insumo especial, las ventas que lo esperan (o Exc 1: stock transitorio)
    let insumo_especial = null;
    // D66: una devolución de obra no es la recepción de una compra
    if (!esDevolucion) try {
      insumo_especial = await insumosEspeciales.alRecibir({
        sku, cantidad, movimientoId: r.movimientoId, loteId: r.loteId, bodegaId: bodega_id,
      });
    } catch (e) {
      console.warn('CU-124: no se pudieron consultar las ventas del insumo especial:', e.message);
    }

    res.status(201).json({
      message: 'Entrada registrada correctamente',
      movimiento_id: r.movimientoId,
      lote_id: r.loteId,
      ...(insumo_especial && { insumo_especial }),
      ...(alertas_faltante.length > 0 && {
        alertas_faltante,
        aviso_faltantes: `Existen ${alertas_faltante.length} alerta(s) de faltante activa(s) para este SKU. Considere resolverlas.`,
        ...(proveedor_info && { proveedor_sugerido: proveedor_info })
      })
    });
  } catch (err) {
    responderError(res, err, 'Error registrando entrada:');
  }
}

/** D61: motivos que /salida no acepta, con el flujo que corresponde. */
const MOTIVOS_DE_OTRO_FLUJO = {
  traslado_bodega: 'Un traslado entre bodegas se registra eligiendo la categoría Traslado y la bodega de destino.',
  despacho_venta: 'La salida por despacho de una venta se registra desde Instalaciones, al confirmar la salida del transporte.',
};

/**
 * POST /api/movimientos/salida
 * Registrar salida de stock (FR-19, FR-24, FR-25). D61: motivo obligatorio.
 */
async function registrarSalida(req, res) {
  const {
    sku, bodega_id, cantidad,
    tipo_movimiento_id, motivo_id, descripcion_motivo, evidencia_url
  } = req.body;

  const userId = req.user.id;

  if (!sku || !bodega_id || !cantidad || !tipo_movimiento_id) {
    return res.status(400).json({ error: 'SKU, bodega, cantidad y tipo de movimiento son requeridos' });
  }
  if (cantidad <= 0) {
    return res.status(400).json({ error: 'La cantidad debe ser mayor a 0' });
  }
  // D61: el motivo es obligatorio. Es lo único que dice si la salida es una merma
  // (evidencia y aprobación de gerencia) y si cuenta como consumo: sin él, una merma
  // pasaba como salida común.
  if (!motivo_id) {
    return res.status(400).json({ error: 'Seleccione el motivo de la salida.' });
  }

  try {
    /* ══════════════════════════════════════════════════════════════════
       El descuento FIFO y el INSERT del movimiento van en UNA transaccion.
       Antes eran llamadas sueltas: si fallaba el INSERT del movimiento, el
       stock ya estaba descontado y no quedaba registro de por que.
       ══════════════════════════════════════════════════════════════════ */
    const r = await conTransaccion(async (client) => {
      // CU-30 Exc 3: un producto inactivo o dado de baja no admite movimientos.
      // Se decide antes de tocar stock. (Un SKU inexistente sigue cayendo en
      // "stock insuficiente" mas abajo, como antes.)
      const { rows: mat } = await client.query(
        `SELECT material_estado FROM material WHERE material_sku = $1`, [sku]
      );
      if (mat.length > 0 && mat[0].material_estado !== 'activo') {
        throw new ErrorNegocio(400, { error: mensajeInactivo(sku) });
      }

      /* ── Clasificacion del motivo: merma/perdida (CU-68.1 / SONNET-8) ── */
      const { rows: clasif } = await client.query(
        `SELECT mot.movimiento_inventario_motivo_movimiento_nombre AS motivo,
                cs.movimiento_inventario_clasificacion_salida_nombre AS nombre
         FROM movimiento_inventario_motivo_movimiento mot
         LEFT JOIN movimiento_inventario_clasificacion_salida cs
              ON cs.movimiento_inventario_clasificacion_salida_id_clasificacion_salida
               = mot.movimiento_inventario_clasificacion_salida_id_clasificacion_salida
         WHERE mot.movimiento_inventario_motivo_movimiento_id_motivo_movimiento = $1`,
        [motivo_id]
      );
      if (!clasif.length) throw new ErrorNegocio(400, { error: 'El motivo seleccionado no existe.' });
      // D61: estos motivos son de sus propios flujos (D60 traslado, CU-127 despacho)
      if (MOTIVOS_DE_OTRO_FLUJO[clasif[0].motivo]) {
        throw new ErrorNegocio(400, { error: MOTIVOS_DE_OTRO_FLUJO[clasif[0].motivo] });
      }
      const nombre = clasif[0].nombre?.toLowerCase() || '';
      const esMerma = nombre.includes('pérdida') || nombre.includes('perdida') || nombre.includes('merma');

      // SONNET-8 (Req #2): toda merma/pérdida requiere enlace a evidencia fotográfica
      if (esMerma) {
        if (!evidencia_url || !evidencia_url.trim()) {
          throw new ErrorNegocio(400, { error: 'Debe adjuntar un enlace a evidencia fotográfica para registrar una merma o pérdida.' });
        }
        if (!/^https?:\/\//i.test(evidencia_url.trim())) {
          throw new ErrorNegocio(400, { error: 'El enlace de evidencia debe ser una URL válida (debe comenzar con http:// o https://).' });
        }
      }

      let esMermaCritica = false;
      if (esMerma) {
        const { rows: matInfo } = await client.query(
          `SELECT material_material_critico AS es_critico FROM material WHERE material_sku = $1`, [sku]
        );
        esMermaCritica = matInfo[0]?.es_critico === true && req.user?.rol !== 'gerencia';
      }

      const estadoMov = esMermaCritica ? 'pendiente_aprobacion' : 'completado';

      /* ── Descuento FIFO con bloqueo de filas ──
         El SELECT ... FOR UPDATE hace que el chequeo de stock y el descuento sean
         atomicos: dos salidas simultaneas del mismo material ya no pueden leer el
         mismo disponible y dejar el stock en negativo. */
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
        [sku, bodega_id]
      );

      const disponible = lotes.reduce((acc, l) => acc + parseFloat(l.disponible), 0);
      if (cantidad > disponible + 1e-9) {
        throw new ErrorNegocio(400, {
          error: `Stock insuficiente. Disponible: ${disponible}`,
          stock_disponible: disponible
        });
      }

      let restante = parseFloat(cantidad);
      for (const lote of lotes) {
        if (restante <= 1e-9) break;
        const descontar = Math.min(restante, parseFloat(lote.disponible));
        await client.query(
          `UPDATE inventario_bodega
           SET inventario_bodega_cantidad_fisica = inventario_bodega_cantidad_fisica - $1
           WHERE material_sku = $2 AND lote_id_lote = $3 AND bodega_id_bodega = $4`,
          [descontar, sku, lote.lote_id_lote, bodega_id]
        );
        restante -= descontar;
      }

      /* ── Movimiento de salida ──
         Ya no hay fallback "por si las columnas no existen": descripcion_motivo y
         evidencia_url estan en el DDL desde SONNET-8, y dentro de una transaccion
         un INSERT fallido la aborta, asi que el catch-y-reintento no funcionaria. */
      const { rows: mov } = await client.query(
        `INSERT INTO movimiento_inventario (
           movimiento_inventario_cantidad, movimiento_inventario_estado,
           material_sku, bodega_id_bodega,
           usuario_id_usuario,
           movimiento_inventario_tipo_movimiento_id_tipo_movimiento,
           movimiento_inventario_motivo_movimiento_id_motivo_movimiento,
           movimiento_inventario_descripcion_motivo,
           movimiento_inventario_evidencia_url
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING movimiento_inventario_id_movimiento AS id`,
        [cantidad, estadoMov, sku, bodega_id, userId, tipo_movimiento_id,
         motivo_id || null, descripcion_motivo || null, evidencia_url || null]
      );

      return { movimientoId: mov[0].id, esMermaCritica };
    });

    /* ── Post-commit: efectos secundarios ── */
    // CU-68.1: notificar a gerencia si es merma crítica pendiente
    if (r.esMermaCritica) {
      const { notificarPorRol } = require('./notificacionesController');
      notificarPorRol({
        tipo: 'merma_pendiente',
        mensaje: `Merma de producto crítico (${sku}) pendiente de aprobación. Cantidad: ${cantidad}`,
        origen: 'movimientos',
        rol: 'gerencia'
      });
    }

    auditoria.registrar(req.user?.id, 'registrar_salida', `SKU: ${sku}, cantidad: ${cantidad}, bodega: ${bodega_id}`);
    generarAlertasAutomaticas().catch(e => console.warn('Alertas:', e.message));

    res.status(201).json({
      message: r.esMermaCritica
        ? 'Merma registrada como pendiente de aprobación. Se notificó a Gerencia.'
        : 'Salida registrada correctamente',
      movimiento_id: r.movimientoId,
      pendiente_aprobacion: r.esMermaCritica
    });
  } catch (err) {
    responderError(res, err, 'Error registrando salida:');
  }
}

/* ── D60: traslado entre bodegas ── */

const MOTIVO_TRASLADO = 'traslado_bodega';
const PREFIJO_TRASLADO = 'TRASLADO-';
const esTraslado = (m) => String(m.movimiento_inventario_referencia_origen || '').startsWith(PREFIJO_TRASLADO);

/**
 * POST /api/movimientos/traslado
 * Body: { sku, bodega_origen_id, bodega_destino_id, cantidad, descripcion_motivo? }
 *
 * D60: mueve stock de una bodega a otra en UNA transacción. Descuenta por FIFO en el
 * origen (solo lo disponible: lo reservado no se traslada) y suma EL MISMO LOTE en el
 * destino, así conserva su fecha de ingreso y el FIFO no se desordena. Por cada lote
 * movido registra un par salida + entrada con el motivo 'traslado_bodega' (clasificación
 * Traslado: no cuenta como consumo) y la referencia TRASLADO-<id de la primera salida>,
 * que une el par. No es una compra: no toca facturas, precios ni insumos especiales.
 * Antes eran dos llamadas sueltas desde la pantalla (salida y entrada): si la entrada
 * fallaba el stock desaparecía, la salida contaba como consumo y el lote se perdía.
 */
async function registrarTraslado(req, res) {
  const b = req.body || {};
  const sku = String(b.sku ?? '').trim();
  const origen = Number(b.bodega_origen_id);
  const destino = Number(b.bodega_destino_id);
  const cantidad = Number(String(b.cantidad ?? '').replace(',', '.'));
  const descripcion = String(b.descripcion_motivo ?? '').trim();

  if (!sku) return res.status(400).json({ error: 'Seleccione el producto a trasladar.' });
  if (!Number.isInteger(origen) || origen <= 0) return res.status(400).json({ error: 'Seleccione la bodega de origen.' });
  if (!Number.isInteger(destino) || destino <= 0) return res.status(400).json({ error: 'Seleccione la bodega de destino.' });
  if (origen === destino) return res.status(400).json({ error: 'La bodega de destino debe ser distinta de la de origen.' });
  if (!Number.isFinite(cantidad) || cantidad <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor que 0.' });
  if (descripcion.length > 255) return res.status(400).json({ error: 'La descripción admite hasta 255 caracteres.' });

  try {
    const r = await conTransaccion(async (client) => {
      /* ── Validar todo antes de tocar stock ── */
      const { rows: mat } = await client.query(`SELECT material_estado AS estado FROM material WHERE material_sku = $1`, [sku]);
      if (!mat.length) throw new ErrorNegocio(404, { error: `El producto ${sku} no existe.` });
      if (mat[0].estado !== 'activo') throw new ErrorNegocio(400, { error: mensajeInactivo(sku) });

      const { rows: bods } = await client.query(
        `SELECT bodega_id_bodega::int AS id, bodega_nombre_bodega AS nombre, bodega_estado AS estado
         FROM bodega WHERE bodega_id_bodega = ANY($1::bigint[])`, [[origen, destino]]
      );
      const bodega = (id) => bods.find(x => x.id === id);
      for (const [id, rol] of [[origen, 'origen'], [destino, 'destino']]) {
        if (!bodega(id)) throw new ErrorNegocio(404, { error: `La bodega de ${rol} no existe.` });
        if (!['activo', 'activa'].includes(bodega(id).estado)) {
          throw new ErrorNegocio(400, { error: `La bodega de ${rol} (${bodega(id).nombre}) no está activa.` });
        }
      }

      const tipoSalida = await tipoMovimientoId(client, 'salida');
      const tipoEntrada = await tipoMovimientoId(client, 'entrada');
      const motivo = await motivoMovimientoId(client, MOTIVO_TRASLADO);
      if (!tipoSalida || !tipoEntrada || !motivo) {
        throw new ErrorNegocio(500, { error: `Falta el motivo "${MOTIVO_TRASLADO}" o los tipos entrada/salida en el catálogo. Avise al administrador del sistema.` });
      }

      // FIFO con FOR UPDATE; lanza "Stock insuficiente" (400) antes de descontar nada
      const { lotes } = await descontarFifo(client, sku, origen, cantidad);

      const texto = descripcion || `Traslado de ${bodega(origen).nombre} a ${bodega(destino).nombre}`;
      const ids = [];
      for (const l of lotes) {
        await client.query(
          `INSERT INTO inventario_bodega (material_sku, lote_id_lote, bodega_id_bodega, inventario_bodega_cantidad_fisica)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (material_sku, lote_id_lote, bodega_id_bodega)
           DO UPDATE SET inventario_bodega_cantidad_fisica =
                           inventario_bodega.inventario_bodega_cantidad_fisica + EXCLUDED.inventario_bodega_cantidad_fisica`,
          [sku, l.lote_id, destino, l.cantidad]
        );
        for (const [tipo, bid] of [[tipoSalida, origen], [tipoEntrada, destino]]) {
          const { rows } = await client.query(
            `INSERT INTO movimiento_inventario (movimiento_inventario_cantidad, movimiento_inventario_estado, material_sku,
               bodega_id_bodega, lote_id_lote, usuario_id_usuario, movimiento_inventario_tipo_movimiento_id_tipo_movimiento,
               movimiento_inventario_motivo_movimiento_id_motivo_movimiento, movimiento_inventario_descripcion_motivo,
               movimiento_inventario_referencia_origen)
             VALUES ($1, 'completado', $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING movimiento_inventario_id_movimiento AS id`,
            [l.cantidad, sku, bid, l.lote_id, req.user.id, tipo, motivo, texto, ids.length ? `${PREFIJO_TRASLADO}${ids[0]}` : PREFIJO_TRASLADO]
          );
          ids.push(rows[0].id);
        }
      }
      // La referencia de la primera salida se completa con su propio id
      await client.query(
        `UPDATE movimiento_inventario SET movimiento_inventario_referencia_origen = $1
         WHERE movimiento_inventario_id_movimiento = $2`, [`${PREFIJO_TRASLADO}${ids[0]}`, ids[0]]
      );
      return { referencia: `${PREFIJO_TRASLADO}${ids[0]}`, lotes: lotes.length, origen: bodega(origen).nombre, destino: bodega(destino).nombre };
    });

    await auditoria.registrar(req.user.id, 'registrar_traslado',
      `${r.referencia}: ${sku} ${cantidad} de ${r.origen} a ${r.destino} (${r.lotes} lote(s))`);
    generarAlertasAutomaticas().catch(e => console.warn('Alertas:', e.message));

    res.status(201).json({
      message: `Traslado registrado: ${cantidad} de ${sku} de ${r.origen} a ${r.destino}.`,
      referencia: r.referencia,
      lotes: r.lotes,
    });
  } catch (err) {
    responderError(res, err, 'Error registrando el traslado:');
  }
}

/**
 * Un movimiento con lo que necesita motivoNoReversible: sus columnas, `tipo_nombre` y
 * `motivo_nombre`. Lo comparten revertir (CU-44) y authController.reautenticar (CU-42).
 */
const SELECT_MOVIMIENTO =
  `SELECT mi.*, tm.movimiento_inventario_tipo_movimiento_nombre AS tipo_nombre,
          mot.movimiento_inventario_motivo_movimiento_nombre AS motivo_nombre
   FROM movimiento_inventario mi
   LEFT JOIN movimiento_inventario_tipo_movimiento tm
          ON tm.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
           = mi.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
   LEFT JOIN movimiento_inventario_motivo_movimiento mot
          ON mot.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
           = mi.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
   WHERE mi.movimiento_inventario_id_movimiento = $1`;

/**
 * Carga un movimiento y lo BLOQUEA, para que dos reversiones (o una reversión y
 * una aprobación de merma) simultáneas no puedan procesar el mismo dos veces.
 */
async function cargarMovimientoBloqueado(client, id) {
  const { rows } = await client.query(`${SELECT_MOVIMIENTO} FOR UPDATE OF mi`, [id]);
  if (rows.length === 0) throw new ErrorNegocio(404, { error: 'Movimiento no encontrado' });
  return rows[0];
}

/** Suma `cantidad` (puede ser negativa) al stock de un lote concreto. */
async function ajustarStockLote(client, sku, bodegaId, loteId, cantidad) {
  const { rowCount } = await client.query(
    `UPDATE inventario_bodega
     SET inventario_bodega_cantidad_fisica = inventario_bodega_cantidad_fisica + $1
     WHERE material_sku = $2 AND lote_id_lote = $3 AND bodega_id_bodega = $4`,
    [cantidad, sku, loteId, bodegaId]
  );
  return rowCount > 0;
}

/**
 * CU-44: por qué un movimiento NO se puede revertir, o null si se puede.
 * `m` son las columnas de movimiento_inventario más `tipo_nombre` y `motivo_nombre`
 * (SELECT_MOVIMIENTO).
 *
 * La usa también authController.reautenticar (CU-42), para rechazar ANTES de
 * pedir la contraseña: el CU verifica la Excepción 1 antes de la autorización.
 */
function motivoNoReversible(m) {
  const estado = m.movimiento_inventario_estado;
  const tipo   = String(m.tipo_nombre || '').trim().toLowerCase();

  if (estado === 'revertido') {
    return 'Este movimiento ya fue anulado por reversión: no se puede revertir dos veces.';
  }
  if (m.movimiento_inventario_id_revertido) {
    return `Este movimiento es la reversión del #${m.movimiento_inventario_id_revertido} y no se puede revertir.`;
  }
  if (estado === 'pendiente_aprobacion') {
    return 'Esta merma está pendiente de aprobación: apruébela o recházela en vez de revertirla.';
  }
  if (estado === 'rechazado') {
    return 'Esta merma fue rechazada y su stock ya se devolvió: no hay nada que revertir.';
  }
  if (!['completado', 'confirmado'].includes(estado)) {
    return `Un movimiento en estado "${estado}" no se puede revertir.`;
  }
  // Revertirlo aquí devolvería el stock, pero la OT seguiría con el consumo
  // registrado y su próxima corrección movería el stock por una diferencia falsa.
  if (m.orden_trabajo_id_orden) {
    return `Este movimiento es un consumo de la OT #${m.orden_trabajo_id_orden}: ` +
           'corríjalo desde la OT para que el consumo registrado y el stock sigan cuadrando.';
  }
  // D60: revertir solo una mitad de un traslado duplicaría o haría desaparecer stock
  if (esTraslado(m)) {
    return 'Este movimiento es parte de un traslado entre bodegas: corríjalo con otro traslado en sentido contrario.';
  }
  // D63: una salida del despacho de una venta (CU-127). Revertirla devolvía el stock pero
  // el pedido seguía "En tránsito", y de un despacho con varios lotes solo volvía uno.
  if (m.motivo_nombre === 'despacho_venta') {
    const venta = m.movimiento_inventario_referencia_origen ? ` de la venta ${m.movimiento_inventario_referencia_origen}` : '';
    return `Esta salida es parte del despacho${venta}. Si el material vuelve de la obra, regístrelo como una entrada por devolución.`;
  }
  // En ajuste, reverso y transferencia no se sabe el sentido del movimiento
  if (tipo !== 'entrada' && tipo !== 'salida') {
    return `Los movimientos de tipo "${tipo || 'desconocido'}" no se pueden revertir.`;
  }
  if (!m.bodega_id_bodega) {
    return 'El movimiento no tiene bodega registrada: no se puede revertir.';
  }
  if (tipo === 'entrada' && !m.lote_id_lote) {
    return 'La entrada no tiene lote registrado: no se puede revertir.';
  }
  return null;
}

/**
 * CU-44: la reversión exige el token de CU-42, atado a ESTE usuario y ESTE
 * movimiento. 403 y no 401: el frontend cierra la sesión ante un 401.
 */
function verificarAutorizacion(req, movId) {
  const token = req.body?.autorizacion;
  if (!token) {
    throw new ErrorNegocio(403, { error: 'La reversión requiere autorización: reingrese su contraseña.' });
  }
  let c;
  try {
    c = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    throw new ErrorNegocio(403, { error: 'La autorización no es válida o expiró. Reingrese su contraseña.' });
  }
  if (c.tipo !== 'autorizacion' || c.accion !== 'revertir_movimiento' ||
      String(c.uid) !== String(req.user.id) || String(c.mov) !== String(movId)) {
    throw new ErrorNegocio(403, { error: 'La autorización no corresponde a este movimiento o a este usuario.' });
  }
}

/**
 * POST /api/movimientos/:id/revertir — CU-44 (FR-30), solo gerencia.
 * Body: { autorizacion }  (token de POST /api/auth/reautenticar, CU-42)
 *
 * Mueve el stock en sentido contrario, registra un movimiento INVERSO que apunta
 * al original (movimiento_inventario_id_revertido) y marca el original como
 * 'revertido' ("Anulado por Reversión" en la vista, D28). El original no se toca
 * en nada más. Todo en UNA transacción, con el original bloqueado (FOR UPDATE).
 *
 * El inverso NO copia factura, OT ni proyecto: se llega a ellos por el original.
 * Así el detalle de la factura y la cantidad_neta de la OT no cambian. Igual que
 * los 'revertido', los inversos se excluyen de consumos, rotación y stockAFecha (D23).
 */
async function revertir(req, res) {
  const { id } = req.params;

  try {
    verificarAutorizacion(req, id);

    const r = await conTransaccion(async (client) => {
      const m = await cargarMovimientoBloqueado(client, id);

      const motivo = motivoNoReversible(m);
      if (motivo) throw new ErrorNegocio(400, { error: motivo });

      const esEntrada = String(m.tipo_nombre).trim().toLowerCase() === 'entrada';
      const cantidad  = parseFloat(m.movimiento_inventario_cantidad);
      let loteInverso;

      if (esEntrada) {
        // Exc 2: revertir una entrada saca stock que puede haberse consumido ya.
        // Se comprueba ANTES: si no, el CHECK ck_inv_bod_fis reventaba con un 500
        // genérico que no explicaba nada.
        const { rows: disp } = await client.query(
          `SELECT inventario_bodega_cantidad_fisica AS fisica,
                  inventario_bodega_cantidad_reservada AS reservada
           FROM inventario_bodega
           WHERE material_sku = $1 AND lote_id_lote = $2 AND bodega_id_bodega = $3
           FOR UPDATE`,
          [m.material_sku, m.lote_id_lote, m.bodega_id_bodega]
        );
        if (disp.length === 0) {
          throw new ErrorNegocio(400, {
            error: 'Ya no existe stock de ese lote en esa bodega: no se puede revertir la entrada.',
          });
        }
        const fisica    = parseFloat(disp[0].fisica);
        const reservada = parseFloat(disp[0].reservada);
        const libre     = fisica - reservada;
        if (cantidad > libre) {
          throw new ErrorNegocio(400, {
            error: `No se puede revertir: la entrada fue de ${cantidad} y en ese lote quedan ${fisica} ` +
                   `(${reservada} reservadas, ${libre} libres). El material ya se consumió o está comprometido: ` +
                   'resuelva la diferencia antes de revertir.',
            disponible_libre: libre,
            stock_fisico: fisica,
            cantidad_reservada: reservada,
            cantidad_movimiento: cantidad,
          });
        }
        await ajustarStockLote(client, m.material_sku, m.bodega_id_bodega, m.lote_id_lote, -cantidad);
        loteInverso = m.lote_id_lote;
      } else {
        // Revertir salida: reponer stock
        let loteDestino = m.lote_id_lote;
        if (!loteDestino) {
          // Salida sin lote registrado — reponer al lote más antiguo de esa bodega
          const { rows: lote } = await client.query(
            `SELECT ib.lote_id_lote
             FROM inventario_bodega ib
             JOIN lote l ON l.lote_id_lote = ib.lote_id_lote
             WHERE ib.material_sku = $1 AND ib.bodega_id_bodega = $2
             ORDER BY l.lote_fecha_ingreso ASC NULLS LAST
             LIMIT 1`,
            [m.material_sku, m.bodega_id_bodega]
          );
          loteDestino = lote[0]?.lote_id_lote || null;
        }
        if (!loteDestino) {
          throw new ErrorNegocio(400, {
            error: 'No existe inventario de ese material en la bodega donde devolver el stock.',
          });
        }
        const ok = await ajustarStockLote(client, m.material_sku, m.bodega_id_bodega, loteDestino, cantidad);
        if (!ok) {
          throw new ErrorNegocio(400, { error: 'No se encontró la fila de inventario donde devolver el stock.' });
        }
        loteInverso = loteDestino;
      }

      // Movimiento inverso: tipo contrario, misma cantidad y bodega, el lote que
      // realmente se movió. El motivo puede no existir en una BD recién creada.
      const tipoId = await tipoMovimientoId(client, esEntrada ? 'salida' : 'entrada');
      if (!tipoId) throw new Error(`No existe el tipo de movimiento "${esEntrada ? 'salida' : 'entrada'}"`);
      const motivoId = await motivoMovimientoId(client, 'reverso_autorizado');

      const { rows: inv } = await client.query(
        `INSERT INTO movimiento_inventario (
           movimiento_inventario_cantidad, movimiento_inventario_estado,
           material_sku, bodega_id_bodega, lote_id_lote, usuario_id_usuario,
           movimiento_inventario_tipo_movimiento_id_tipo_movimiento,
           movimiento_inventario_motivo_movimiento_id_motivo_movimiento,
           movimiento_inventario_descripcion_motivo,
           movimiento_inventario_id_revertido
         ) VALUES ($1, 'completado', $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING movimiento_inventario_id_movimiento AS id`,
        [cantidad, m.material_sku, m.bodega_id_bodega, loteInverso, req.user.id,
         tipoId, motivoId, `Reversión del movimiento #${id}`, id]
      );

      await client.query(
        `UPDATE movimiento_inventario SET movimiento_inventario_estado = 'revertido'
         WHERE movimiento_inventario_id_movimiento = $1`,
        [id]
      );

      return { sku: m.material_sku, cantidad, esEntrada, inversoId: inv[0].id };
    });

    // Después del COMMIT: la auditoría usa su propia conexión y se traga los
    // errores, meterla dentro abortaría una reversión ya confirmada.
    await auditoria.registrar(req.user?.id, 'revertir_movimiento',
      `ID movimiento: ${id} (${r.esEntrada ? 'entrada' : 'salida'} de ${r.cantidad} de ${r.sku}), inverso #${r.inversoId}`);

    res.json({
      message: `Movimiento anulado por reversión. Se registró el movimiento inverso #${r.inversoId}.`,
      inverso_id: r.inversoId,
    });
  } catch (err) {
    responderError(res, err, 'Error revirtiendo movimiento:');
  }
}

/**
 * PUT /api/movimientos/:id/aprobar-merma
 * Gerencia aprueba una merma de producto crítico (CU-68.1)
 */
async function aprobarMerma(req, res) {
  const { id } = req.params;
  try {
    const { rows: mov } = await query(
      `SELECT movimiento_inventario_id_movimiento AS id,
              movimiento_inventario_estado AS estado,
              material_sku AS sku,
              movimiento_inventario_cantidad AS cantidad
       FROM movimiento_inventario WHERE movimiento_inventario_id_movimiento = $1`,
      [id]
    );

    if (mov.length === 0) {
      return res.status(404).json({ error: 'Movimiento no encontrado' });
    }
    if (mov[0].estado !== 'pendiente_aprobacion') {
      return res.status(400).json({ error: 'Este movimiento no está pendiente de aprobación' });
    }

    await query(
      `UPDATE movimiento_inventario SET movimiento_inventario_estado = 'completado'
       WHERE movimiento_inventario_id_movimiento = $1`, [id]
    );

    auditoria.registrar(req.user?.id, 'aprobar_merma', `ID: ${id}, SKU: ${mov[0].sku}, cantidad: ${mov[0].cantidad}`);
    res.json({ message: 'Merma aprobada correctamente' });
  } catch (err) {
    console.error('Error aprobando merma:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * PUT /api/movimientos/:id/rechazar-merma
 * Gerencia rechaza merma → revertir stock (CU-68.1)
 */
async function rechazarMerma(req, res) {
  const { id } = req.params;
  try {
    const { rows: mov } = await query(
      `SELECT movimiento_inventario_id_movimiento AS id,
              movimiento_inventario_estado AS estado,
              material_sku AS sku,
              movimiento_inventario_cantidad AS cantidad,
              bodega_id_bodega AS bodega_id
       FROM movimiento_inventario WHERE movimiento_inventario_id_movimiento = $1`,
      [id]
    );

    if (mov.length === 0) {
      return res.status(404).json({ error: 'Movimiento no encontrado' });
    }
    if (mov[0].estado !== 'pendiente_aprobacion') {
      return res.status(400).json({ error: 'Este movimiento no está pendiente de aprobación' });
    }

    const m = mov[0];
    let advertencia = null;

    // Devolución del stock + cambio de estado en UNA transacción: antes eran dos
    // queries sueltas y un fallo entre medio devolvía el stock sin rechazar la
    // merma (o la rechazaba sin devolver nada).
    await conTransaccion(async (client) => {
      const bloqueado = await cargarMovimientoBloqueado(client, id);
      // Se revalida bajo el bloqueo: entre el SELECT de arriba y el BEGIN otro
      // usuario pudo haberla aprobado o rechazado.
      if (bloqueado.movimiento_inventario_estado !== 'pendiente_aprobacion') {
        throw new ErrorNegocio(400, { error: 'Este movimiento no está pendiente de aprobación' });
      }

      // Devolver stock descontado (FIFO inverso: al lote más reciente)
      const { rows: lotes } = await client.query(
        `SELECT ib.lote_id_lote
         FROM inventario_bodega ib
         JOIN lote l ON l.lote_id_lote = ib.lote_id_lote
         WHERE ib.material_sku = $1 AND ib.bodega_id_bodega = $2
         ORDER BY l.lote_fecha_ingreso DESC NULLS LAST
         LIMIT 1`,
        [m.sku, m.bodega_id]
      );

      if (lotes.length > 0) {
        await ajustarStockLote(client, m.sku, m.bodega_id, lotes[0].lote_id_lote, m.cantidad);
      } else {
        advertencia = 'No existe inventario de ese material en la bodega: la merma se rechazó sin devolver stock.';
      }

      await client.query(
        `UPDATE movimiento_inventario SET movimiento_inventario_estado = 'rechazado'
         WHERE movimiento_inventario_id_movimiento = $1`,
        [id]
      );
    });

    await auditoria.registrar(req.user?.id, 'rechazar_merma', `ID: ${id}, SKU: ${m.sku}, cantidad: ${m.cantidad}`);
    res.json({
      message: 'Merma rechazada. Stock devuelto a la bodega.',
      ...(advertencia && { advertencia }),
    });
  } catch (err) {
    responderError(res, err, 'Error rechazando merma:');
  }
}

/**
 * POST /api/movimientos/verificar-mermas-pendientes
 * CU-74 CP3: Notificación de emergencia si merma lleva >24h pendiente
 */
async function verificarMermasPendientes(req, res) {
  try {
    const { rows } = await query(
      `SELECT mi.movimiento_inventario_id_movimiento AS id,
              mi.material_sku AS sku,
              mi.movimiento_inventario_cantidad AS cantidad,
              mi.movimiento_inventario_fecha_hora AS fecha
       FROM movimiento_inventario mi
       WHERE mi.movimiento_inventario_estado = 'pendiente_aprobacion'
         AND mi.movimiento_inventario_fecha_hora < now() - INTERVAL '24 hours'`
    );
    let notificadas = 0;
    for (const m of rows) {
      // Verificar si ya se envió notificación de emergencia para este movimiento
      const { rows: yaNotif } = await query(
        `SELECT 1 FROM notificacion
         WHERE notificacion_tipo_notificacion = 'merma_emergencia'
           AND notificacion_mensaje ILIKE '%ID: ' || $1 || '%'
         LIMIT 1`,
        [String(m.id)]
      );
      if (yaNotif.length > 0) continue;

      const { notificarPorRol } = require('./notificacionesController');
      notificarPorRol({
        tipo: 'merma_emergencia',
        mensaje: `EMERGENCIA: Merma de ${m.sku} (ID: ${m.id}, ${m.cantidad} uds.) lleva más de 24 horas pendiente de aprobación.`,
        origen: 'movimientos',
        rol: 'gerencia'
      });
      notificadas++;
    }
    res.json({ message: `${notificadas} notificación(es) de emergencia generada(s)`, total: notificadas });
  } catch (err) {
    console.error('Error verificando mermas pendientes:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/movimientos/vincular-ot[?aplicar=true][&incluir_sin_calce=true]
 * OPUS-9 paso 4 (backfill): vincula con su OT los movimientos de SALIDA
 * anteriores a OPUS-1, que quedaron sin orden_trabajo_id_orden.
 *
 * El vinculo se reconstruye por (material + proyecto): se busca la OT del mismo
 * proyecto que tenga ese material CON consumo real registrado. Se exigen DOS
 * condiciones, porque la columna no es decorativa (origenConsumoPrevio la usa
 * para decidir a donde devolver el stock, y eliminarMaterial marca como
 * 'revertido' TODOS los movimientos del par OT+SKU):
 *   1. UNA sola OT candidata. Con varias -> 'ambiguo', no se toca: adivinar
 *      cual fue seria inventar trazabilidad.
 *   2. Que la cantidad del movimiento NO supere el consumo real registrado en
 *      esa OT. Si lo supera -> 'cantidad_no_calza': el movimiento existe, pero
 *      no lo explica ese consumo. Se puede forzar con ?incluir_sin_calce=true.
 *
 * Por defecto es SIMULACION: hay que pasar ?aplicar=true para escribir.
 */
async function vincularOrdenesTrabajo(req, res) {
  const aplicar         = String(req.query.aplicar || '').toLowerCase() === 'true';
  const incluirSinCalce = String(req.query.incluir_sin_calce || '').toLowerCase() === 'true';

  try {
    const { rows } = await query(
      `SELECT mi.movimiento_inventario_id_movimiento AS id,
              mi.material_sku                        AS sku,
              mi.movimiento_inventario_cantidad      AS cantidad,
              mi.movimiento_inventario_fecha_hora    AS fecha_hora,
              mi.proyecto_id_proyecto                AS proyecto_id,
              (SELECT json_agg(json_build_object(
                        'ot',   mot.orden_trabajo_id_orden,
                        'real', mot.material_orden_trabajo_consumo_real)
                      ORDER BY mot.orden_trabajo_id_orden)
               FROM material_orden_trabajo mot
               JOIN orden_trabajo ot ON ot.orden_trabajo_id_orden = mot.orden_trabajo_id_orden
               WHERE mot.material_sku = mi.material_sku
                 AND ot.proyecto_id_proyecto = mi.proyecto_id_proyecto
                 AND mot.material_orden_trabajo_consumo_real IS NOT NULL) AS candidatas
       FROM movimiento_inventario mi
       JOIN movimiento_inventario_tipo_movimiento tm
            ON tm.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
             = mi.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
       WHERE mi.orden_trabajo_id_orden IS NULL
         AND mi.proyecto_id_proyecto IS NOT NULL
         AND tm.movimiento_inventario_tipo_movimiento_nombre ILIKE '%salida%'
       ORDER BY mi.movimiento_inventario_id_movimiento`
    );

    const analizados = rows.map(r => {
      const candidatas = (r.candidatas || []).map(c => ({ ot: c.ot, real: parseFloat(c.real) }));
      const cantidad   = parseFloat(r.cantidad);
      const unica      = candidatas.length === 1 ? candidatas[0] : null;
      // Tolerancia por el NUMERIC de la BD; el movimiento puede ser parcial
      // (varias salidas suman el consumo), pero nunca deberia superarlo.
      const calza      = unica ? cantidad <= unica.real + 1e-9 : false;

      const resultado = candidatas.length === 0 ? 'sin_candidata'
                      : candidatas.length > 1   ? 'ambiguo'
                      : calza                   ? 'vinculable'
                      : 'cantidad_no_calza';

      return {
        movimiento_id: r.id,
        sku: r.sku,
        cantidad,
        fecha_hora: r.fecha_hora,
        proyecto_id: r.proyecto_id,
        resultado,
        ots_candidatas: candidatas.map(c => c.ot),
        consumo_real_ot: unica ? unica.real : null,
        orden_trabajo_id: unica && (calza || incluirSinCalce) ? unica.ot : null
      };
    });

    const aVincular = analizados.filter(r => r.orden_trabajo_id != null);
    let vinculados  = 0;

    if (aplicar && aVincular.length > 0) {
      await conTransaccion(async (client) => {
        for (const r of aVincular) {
          const { rowCount } = await client.query(
            `UPDATE movimiento_inventario
             SET orden_trabajo_id_orden = $1
             WHERE movimiento_inventario_id_movimiento = $2
               AND orden_trabajo_id_orden IS NULL`,
            [r.orden_trabajo_id, r.movimiento_id]
          );
          vinculados += rowCount;
        }
      });
      await auditoria.registrar(req.user?.id, 'Backfill vínculo OT-movimientos',
        `Se vincularon ${vinculados} movimiento(s) de salida con su orden de trabajo` +
        (incluirSinCalce ? ' (incluyendo los que no calzan en cantidad)' : ''));
    }

    res.json({
      message: aplicar
        ? `Se vincularon ${vinculados} movimiento(s) con su orden de trabajo`
        : `Simulación: ${aVincular.length} movimiento(s) vinculables. Repita con ?aplicar=true para guardar.`,
      aplicado: aplicar,
      incluir_sin_calce: incluirSinCalce,
      revisados: analizados.length,
      vinculables: aVincular.length,
      vinculados,
      ambiguos:          analizados.filter(r => r.resultado === 'ambiguo').length,
      cantidad_no_calza: analizados.filter(r => r.resultado === 'cantidad_no_calza').length,
      sin_candidata:     analizados.filter(r => r.resultado === 'sin_candidata').length,
      detalle: analizados
    });
  } catch (err) {
    responderError(res, err, 'Error vinculando movimientos con OT:');
  }
}

module.exports = { listar, catalogos, registrarEntrada, registrarSalida, registrarTraslado, revertir, aprobarMerma, rechazarMerma, verificarMermasPendientes, vincularOrdenesTrabajo, motivoNoReversible, SELECT_MOVIMIENTO };
