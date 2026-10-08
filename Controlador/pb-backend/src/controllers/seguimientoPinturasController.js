const { query } = require('../db/pool');
const { ErrorNegocio, conTransaccion, responderError } = require('../db/tx');
const {
  tipoMovimientoId, motivoMovimientoId, motivoDevolucionConsumo,
  descontarFifo, reponerFifo, insertarMovimiento, resolverBodega,
} = require('../db/stock');
const auditoria = require('./auditoriaController');
const { ESTADOS_OT_CERRADA } = require('./ordenesTrabajoController');

/* ======================================================================
   OPUS-11 (Req #3) — Seguimiento de pinturas por peso de envase.

   Cada fila de seguimiento_pintura es UN retiro: se pesa el envase al salir de
   bodega y al devolverlo. El consumo es la resta, y queda NULL mientras el
   envase no vuelve (un retiro abierto tiene consumo desconocido, no "todo el
   envase"), asi que los reportes solo suman retiros cerrados.

   OPUS-16: el consumo AHORA SI descuenta stock. Las pinturas se llevan en
   KILOGRAMOS, asi que el consumo medido en gramos se descuenta dividiendo por
   1000 — exacto, universal y sin ningun dato de densidad que alguien tenga que
   cargar y mantener (una densidad mal cargada descuadra el stock en silencio).

   REGLAS del movimiento de stock, todas dentro de conTransaccion():
     · un retiro ABIERTO no descuenta nada: el consumo todavia es desconocido, y
       descontar el envase entero para despues reingresarlo seria el doble de
       movimientos por uso;
     · el ajuste se hace SIEMPRE por la DIFERENCIA contra stock_descontado_kg,
       nunca por la cantidad completa. Es exactamente el bug que costo corregir en
       OPUS-1 (modo 'actualizar' descontaba dos veces);
     · anular devuelve al stock lo que este seguimiento hubiera descontado.
   ====================================================================== */

/** Las pinturas se llevan en kilogramos y el envase se pesa en gramos. */
const GRAMOS_POR_KG = 1000;

/** Redondeo a 4 decimales, que es la escala de inventario_bodega. */
const aKg = (gramos) => Math.round((gramos / GRAMOS_POR_KG) * 10000) / 10000;

/** Un material es pintura si tiene alguno de los dos flags del modelo. */
const ES_PINTURA = `(m.es_material_pintura_custom = TRUE OR m.es_material_pintura_no_custom = TRUE)`;

/** Color con el que se identifica la pintura en el catalogo. */
const COLOR_CATALOGO = `COALESCE(m.material_pintura_pintura_custom, m.material_pintura_no_custom)`;

/** SELECT comun de una fila de seguimiento, con sus JOINs. */
const SELECT_SEGUIMIENTO = `
  SELECT
    sp.seguimiento_pintura_id                AS id,
    sp.material_sku                          AS sku,
    m.material_nombre_material               AS material,
    ${COLOR_CATALOGO}                        AS color_catalogo,
    m.es_material_pintura_custom             AS es_custom,
    sp.orden_trabajo_id_orden                AS orden_trabajo_id,
    p.codigo_proyecto                        AS proyecto_codigo,
    sp.area_trabajo_id                       AS area_id,
    at.area_trabajo_nombre_area              AS area,
    sp.fecha_uso                             AS fecha_uso,
    sp.fecha_devolucion                      AS fecha_devolucion,
    sp.peso_entrada_gr                       AS peso_entrada_gr,
    sp.peso_salida_gr                        AS peso_salida_gr,
    sp.peso_consumido_gr                     AS peso_consumido_gr,
    sp.color_aplicado                        AS color_aplicado,
    sp.superficie_m2                         AS superficie_m2,
    CASE WHEN sp.peso_consumido_gr IS NOT NULL AND sp.superficie_m2 > 0
         THEN ROUND(sp.peso_consumido_gr / sp.superficie_m2, 2)
    END                                      AS rendimiento_gr_m2,
    sp.observacion                           AS observacion,
    u.usuario_username                       AS usuario,
    (sp.peso_salida_gr IS NULL)              AS abierto,
    sp.estado                                AS estado,
    sp.bodega_id_bodega                      AS bodega_id,
    b.bodega_nombre_bodega                   AS bodega,
    sp.stock_descontado_kg                   AS stock_descontado_kg,
    sp.movimiento_inventario_id_movimiento   AS movimiento_id
  FROM seguimiento_pintura sp
  JOIN material m       ON m.material_sku = sp.material_sku
  LEFT JOIN bodega b    ON b.bodega_id_bodega = sp.bodega_id_bodega
  LEFT JOIN orden_trabajo ot ON ot.orden_trabajo_id_orden = sp.orden_trabajo_id_orden
  LEFT JOIN terreno.proyecto p ON p.id_proyecto = ot.proyecto_id_proyecto
  LEFT JOIN area_trabajo at ON at.area_trabajo_id_area = sp.area_trabajo_id
  LEFT JOIN usuario u   ON u.usuario_id_usuario = sp.usuario_id_usuario`;

/** Resumen de una lista de seguimientos ya normalizada. */
function resumirSeguimientos(filas) {
  // Un anulado conserva sus pesos pero ya no representa consumo: su stock se devolvió.
  const cerrados  = filas.filter(f => !f.abierto && f.estado !== 'anulado');
  const consumido = cerrados.reduce((a, f) => a + (f.peso_consumido_gr || 0), 0);
  const superficie = cerrados.reduce((a, f) => a + (f.superficie_m2 || 0), 0);
  return {
    total_registros: filas.length,
    abiertos: filas.filter(f => f.abierto && f.estado !== 'anulado').length,
    cerrados: cerrados.length,
    anulados: filas.filter(f => f.estado === 'anulado').length,
    stock_descontado_kg: Math.round(cerrados.reduce((a, f) => a + (f.stock_descontado_kg || 0), 0) * 10000) / 10000,
    // Solo los retiros cerrados: un envase que no volvio todavia no tiene consumo
    consumido_gr: Math.round(consumido * 100) / 100,
    superficie_m2: Math.round(superficie * 100) / 100,
    rendimiento_gr_m2: superficie > 0 ? Math.round((consumido / superficie) * 100) / 100 : null,
  };
}

/** Convierte una fila cruda a numeros de JS. */
function normalizar(r) {
  return {
    ...r,
    peso_entrada_gr:   r.peso_entrada_gr   != null ? parseFloat(r.peso_entrada_gr) : null,
    peso_salida_gr:    r.peso_salida_gr    != null ? parseFloat(r.peso_salida_gr) : null,
    peso_consumido_gr: r.peso_consumido_gr != null ? parseFloat(r.peso_consumido_gr) : null,
    superficie_m2:     r.superficie_m2     != null ? parseFloat(r.superficie_m2) : null,
    rendimiento_gr_m2: r.rendimiento_gr_m2 != null ? parseFloat(r.rendimiento_gr_m2) : null,
    stock_descontado_kg: r.stock_descontado_kg != null ? parseFloat(r.stock_descontado_kg) : 0,
  };
}

/* ──────────────────────────────────────────────────────────────────────
   OPUS-16 — movimiento de stock
   ────────────────────────────────────────────────────────────────────── */

/** Carga el seguimiento bloqueado, para que dos correcciones simultaneas no se pisen. */
async function cargarSeguimientoBloqueado(client, id) {
  const { rows } = await client.query(
    `SELECT sp.seguimiento_pintura_id AS id, sp.material_sku AS sku,
            sp.peso_entrada_gr, sp.peso_salida_gr, sp.peso_consumido_gr,
            sp.bodega_id_bodega AS bodega_id, sp.estado,
            sp.stock_descontado_kg, sp.orden_trabajo_id_orden AS ot_id,
            sp.movimiento_inventario_id_movimiento AS movimiento_id,
            ot.proyecto_id_proyecto AS proyecto_id
     FROM seguimiento_pintura sp
     LEFT JOIN orden_trabajo ot ON ot.orden_trabajo_id_orden = sp.orden_trabajo_id_orden
     WHERE sp.seguimiento_pintura_id = $1
     FOR UPDATE OF sp`,
    [id]
  );
  if (rows.length === 0) throw new ErrorNegocio(404, { error: 'Registro de seguimiento no encontrado' });
  return rows[0];
}

/** Lote al que conviene devolver: el del movimiento que genero este seguimiento. */
async function loteDelMovimiento(client, movimientoId) {
  if (!movimientoId) return null;
  const { rows } = await client.query(
    `SELECT lote_id_lote FROM movimiento_inventario
     WHERE movimiento_inventario_id_movimiento = $1`,
    [movimientoId]
  );
  return rows[0]?.lote_id_lote || null;
}

/**
 * Lleva el stock descontado por ESTE seguimiento desde lo que ya descontó hasta
 * `consumoGr`. Mueve SOLO la diferencia y genera el movimiento correspondiente.
 *
 * Devuelve { delta_kg, movimiento_id, advertencia } — `advertencia` cuando el stock
 * no se pudo mover (p. ej. no queda ninguna fila de inventario donde devolverlo),
 * en vez de callarlo como hacía el código anterior en casos parecidos.
 */
async function ajustarStock(client, seg, consumoGr, usuarioId, etiqueta) {
  const objetivoKg = consumoGr == null ? 0 : aKg(consumoGr);
  const yaKg  = parseFloat(seg.stock_descontado_kg || 0);
  const delta = Math.round((objetivoKg - yaKg) * 10000) / 10000;

  if (Math.abs(delta) < 1e-9) return { delta_kg: 0, movimiento_id: null, advertencia: null };

  // Sin bodega no hay de dónde descontar ni a dónde devolver
  const bodegaId = seg.bodega_id || await resolverBodega(client, seg.sku, null);

  // Antes de tocar stock: sin el motivo de devolución, la entrada no restaría del consumo
  const tipo = delta > 0 ? 'salida' : 'entrada';
  const motivoId = delta > 0
    ? await motivoMovimientoId(client, 'consumo_produccion')
    : await motivoDevolucionConsumo(client);

  let loteId = null;
  let advertencia = null;

  if (delta > 0) {
    // Se consumió más: descontar la diferencia
    const r = await descontarFifo(client, seg.sku, bodegaId, delta);
    loteId = r.lote_principal;
  } else {
    // Se consumió menos (o se anula): devolver la diferencia
    loteId = await reponerFifo(client, seg.sku, bodegaId, -delta,
      await loteDelMovimiento(client, seg.movimiento_id));
    if (!loteId) {
      advertencia = `No se pudo devolver ${-delta} kg al inventario: ${seg.sku} no tiene ninguna ` +
                    `ubicación en la bodega ${bodegaId}. Regularice el stock manualmente.`;
    }
  }

  const movimientoId = await insertarMovimiento(client, {
    cantidad: Math.abs(delta),
    sku: seg.sku,
    bodegaId,
    loteId,
    usuarioId,
    tipoId: await tipoMovimientoId(client, tipo),
    motivoId,
    descripcion: `${etiqueta} · seguimiento de pintura #${seg.id}` +
                 (seg.ot_id ? ` · OT #${seg.ot_id}` : ''),
    proyectoId: seg.proyecto_id || null,
    otId: seg.ot_id || null,
  });

  await client.query(
    `UPDATE seguimiento_pintura
     SET stock_descontado_kg = $1, movimiento_inventario_id_movimiento = $2, bodega_id_bodega = $3
     WHERE seguimiento_pintura_id = $4`,
    [objetivoKg, movimientoId, bodegaId, seg.id]
  );

  return { delta_kg: delta, movimiento_id: movimientoId, advertencia };
}

/** Valida y normaliza una superficie opcional. */
function leerSuperficie(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = parseFloat(valor);
  if (isNaN(n) || n <= 0) throw new ErrorNegocio(400, { error: 'La superficie debe ser un número mayor a 0' });
  return n;
}

/** Valida un peso de envase de vuelta contra el de salida. */
function leerPesoSalida(valor, entrada) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = parseFloat(valor);
  if (isNaN(n) || n < 0) {
    throw new ErrorNegocio(400, { error: 'El peso de salida debe ser un número mayor o igual a 0' });
  }
  if (n > entrada) {
    throw new ErrorNegocio(400, {
      error: `El envase salió pesando ${entrada} gr; no puede volver pesando ${n} gr.`,
    });
  }
  return n;
}

/** Valida el material: debe existir y ser pintura. */
async function cargarPintura(client, sku) {
  const { rows } = await client.query(
    `SELECT m.material_sku, m.material_nombre_material AS nombre, m.material_estado AS estado,
            ${ES_PINTURA} AS es_pintura, ${COLOR_CATALOGO} AS color
     FROM material m WHERE m.material_sku ILIKE $1`,
    [sku]
  );
  if (rows.length === 0) {
    throw new ErrorNegocio(404, { error: 'El SKU no corresponde a un producto registrado' });
  }
  if (!rows[0].es_pintura) {
    throw new ErrorNegocio(400, {
      error: `${rows[0].nombre} no está registrado como pintura. El seguimiento por peso solo aplica a pinturas.`,
    });
  }
  return rows[0];
}

/**
 * POST /api/seguimiento-pinturas
 * Registrar el retiro de un envase de pintura.
 * Body: { sku, peso_entrada_gr, bodega_id?, orden_trabajo_id?, area_trabajo_id?,
 *         color_aplicado?, superficie_m2?, observacion?, peso_salida_gr? }
 *
 * peso_salida_gr es opcional: permite registrar un uso ya cerrado de una sola vez,
 * y en ese caso el stock se descuenta en el acto.
 */
async function registrar(req, res) {
  const {
    sku, peso_entrada_gr, peso_salida_gr, bodega_id, orden_trabajo_id, area_trabajo_id,
    color_aplicado, superficie_m2, observacion,
  } = req.body;

  const entrada = parseFloat(peso_entrada_gr);
  if (!sku || isNaN(entrada) || entrada <= 0) {
    return res.status(400).json({ error: 'El SKU y un peso de entrada mayor a 0 son requeridos' });
  }

  try {
    const r = await conTransaccion(async (client) => {
      const salida     = leerPesoSalida(peso_salida_gr, entrada);
      const superficie = leerSuperficie(superficie_m2);
      const mat        = await cargarPintura(client, sku);

      // D65: la OT debe estar abierta y el área del registro es la de la OT. Sin OT, el área
      // es obligatoria, para que el consumo quede atribuido en los reportes.
      let areaId = area_trabajo_id || null;
      if (orden_trabajo_id) {
        const { rows: ot } = await client.query(
          `SELECT orden_trabajo_estado AS estado, area_trabajo_id_area::text AS area
           FROM orden_trabajo WHERE orden_trabajo_id_orden = $1`,
          [orden_trabajo_id]
        );
        if (ot.length === 0) throw new ErrorNegocio(404, { error: 'Orden de trabajo no encontrada' });
        if (ESTADOS_OT_CERRADA.includes(String(ot[0].estado).toLowerCase())) {
          throw new ErrorNegocio(400, { error: `La OT #${orden_trabajo_id} está ${ot[0].estado}: el retiro de pintura se registra en una OT abierta.` });
        }
        if (areaId && String(areaId) !== ot[0].area) {
          throw new ErrorNegocio(400, { error: `El área no corresponde a la OT #${orden_trabajo_id}: el retiro queda en el área de la OT.` });
        }
        areaId = ot[0].area;
      } else if (!areaId) {
        throw new ErrorNegocio(400, { error: 'Sin OT, indique el área que usa la pintura.' });
      }
      if (area_trabajo_id) {
        const { rows: area } = await client.query(
          `SELECT area_trabajo_id_area FROM area_trabajo WHERE area_trabajo_id_area = $1`,
          [area_trabajo_id]
        );
        if (area.length === 0) throw new ErrorNegocio(404, { error: 'Área de trabajo no encontrada' });
      }
      if (bodega_id) {
        const { rows: b } = await client.query(
          `SELECT bodega_id_bodega FROM bodega WHERE bodega_id_bodega = $1`, [bodega_id]
        );
        if (b.length === 0) throw new ErrorNegocio(404, { error: 'Bodega no encontrada' });
      }

      const { rows } = await client.query(
        `INSERT INTO seguimiento_pintura
           (material_sku, orden_trabajo_id_orden, area_trabajo_id, peso_entrada_gr, peso_salida_gr,
            fecha_devolucion, color_aplicado, superficie_m2, usuario_id_usuario, observacion,
            bodega_id_bodega, estado)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $5::numeric IS NULL THEN NULL ELSE now() END,
                 $6, $7, $8, $9, $10, $11)
         RETURNING seguimiento_pintura_id AS id, peso_consumido_gr`,
        [
          mat.material_sku, orden_trabajo_id || null, areaId,
          entrada, salida, color_aplicado || mat.color || null, superficie,
          req.user?.id || null, observacion || null, bodega_id || null,
          salida != null ? 'cerrado' : 'abierto',
        ]
      );

      const consumido = rows[0].peso_consumido_gr != null ? parseFloat(rows[0].peso_consumido_gr) : null;

      // Un retiro abierto no descuenta: el consumo todavía es desconocido.
      let ajuste = { delta_kg: 0, advertencia: null };
      if (consumido != null) {
        const seg = {
          id: rows[0].id, sku: mat.material_sku, bodega_id: bodega_id || null,
          stock_descontado_kg: 0, movimiento_id: null,
          ot_id: orden_trabajo_id || null, proyecto_id: null,
        };
        if (seg.ot_id) {
          const { rows: p } = await client.query(
            `SELECT proyecto_id_proyecto AS id FROM orden_trabajo WHERE orden_trabajo_id_orden = $1`,
            [seg.ot_id]
          );
          seg.proyecto_id = p[0]?.id || null;
        }
        ajuste = await ajustarStock(client, seg, consumido, req.user?.id, 'Consumo de pintura');
      }

      return { id: rows[0].id, consumido, ajuste, nombre: mat.nombre };
    });

    await auditoria.registrar(req.user?.id, 'Registrar uso de pintura',
      `Pintura ${sku}: entrada ${entrada} gr` +
      (r.consumido != null
        ? `, consumo ${r.consumido} gr (${r.ajuste.delta_kg} kg descontados)`
        : ' (envase sin devolver)') +
      (orden_trabajo_id ? `, OT #${orden_trabajo_id}` : ''));

    res.status(201).json({
      message: r.consumido != null
        ? `Uso registrado. Consumo: ${r.consumido} gr (${r.ajuste.delta_kg} kg descontados del stock).`
        : 'Retiro registrado. Al devolver el envase, registre su peso para calcular el consumo y descontar el stock.',
      id: r.id,
      peso_consumido_gr: r.consumido,
      stock_descontado_kg: r.ajuste.delta_kg,
      advertencia: r.ajuste.advertencia,
    });
  } catch (err) {
    responderError(res, err, 'Error registrando uso de pintura:');
  }
}

/**
 * PUT /api/seguimiento-pinturas/:id/devolver
 * Registrar el peso del envase al devolverlo. El consumo lo calcula la BD y el
 * stock se descuenta en la misma transacción.
 * Body: { peso_salida_gr, bodega_id?, superficie_m2?, color_aplicado?, observacion? }
 */
async function devolver(req, res) {
  const { id } = req.params;
  const { peso_salida_gr, bodega_id, superficie_m2, color_aplicado, observacion } = req.body;

  if (peso_salida_gr === undefined || peso_salida_gr === null || peso_salida_gr === '') {
    return res.status(400).json({ error: 'El peso de salida debe ser un número mayor o igual a 0' });
  }

  try {
    const r = await conTransaccion(async (client) => {
      const seg = await cargarSeguimientoBloqueado(client, id);

      if (seg.estado === 'anulado') {
        throw new ErrorNegocio(400, { error: 'Este seguimiento está anulado. No se puede devolver el envase.' });
      }
      if (seg.peso_salida_gr != null) {
        throw new ErrorNegocio(400, {
          error: 'Este envase ya fue devuelto. Para cambiar los pesos use la corrección del registro.',
        });
      }

      const entrada    = parseFloat(seg.peso_entrada_gr);
      const salida     = leerPesoSalida(peso_salida_gr, entrada);
      const superficie = leerSuperficie(superficie_m2);

      if (bodega_id) {
        const { rows: b } = await client.query(
          `SELECT bodega_id_bodega FROM bodega WHERE bodega_id_bodega = $1`, [bodega_id]
        );
        if (b.length === 0) throw new ErrorNegocio(404, { error: 'Bodega no encontrada' });
        seg.bodega_id = bodega_id;
      }

      const { rows } = await client.query(
        `UPDATE seguimiento_pintura SET
           peso_salida_gr   = $1,
           fecha_devolucion = now(),
           superficie_m2    = COALESCE($2, superficie_m2),
           color_aplicado   = COALESCE($3, color_aplicado),
           observacion      = COALESCE($4, observacion),
           bodega_id_bodega = COALESCE($5, bodega_id_bodega),
           estado           = 'cerrado'
         WHERE seguimiento_pintura_id = $6
         RETURNING peso_consumido_gr, superficie_m2`,
        [salida, superficie, color_aplicado || null, observacion || null, bodega_id || null, id]
      );

      const consumido = parseFloat(rows[0].peso_consumido_gr);
      const ajuste = await ajustarStock(client, seg, consumido, req.user?.id, 'Consumo de pintura');
      const sup = rows[0].superficie_m2 != null ? parseFloat(rows[0].superficie_m2) : null;

      return { consumido, sup, ajuste, sku: seg.sku };
    });

    await auditoria.registrar(req.user?.id, 'Devolver envase de pintura',
      `Seguimiento #${id} (${r.sku}): consumo ${r.consumido} gr, ${r.ajuste.delta_kg} kg descontados del stock`);

    res.json({
      message: `Envase devuelto. Consumo: ${r.consumido} gr (${r.ajuste.delta_kg} kg descontados del stock).`,
      id: parseInt(id),
      peso_consumido_gr: r.consumido,
      stock_descontado_kg: r.ajuste.delta_kg,
      rendimiento_gr_m2: r.sup > 0 ? Math.round((r.consumido / r.sup) * 100) / 100 : null,
      advertencia: r.ajuste.advertencia,
    });
  } catch (err) {
    responderError(res, err, 'Error devolviendo envase de pintura:');
  }
}

/**
 * PUT /api/seguimiento-pinturas/:id
 * Corregir un seguimiento ya registrado (OPUS-16: "si se equivocan y actualizan
 * la cantidad"). El stock se mueve por la DIFERENCIA, nunca por la cantidad
 * completa — es el bug de OPUS-1, que descontaba dos veces al actualizar.
 * Body: { peso_entrada_gr?, peso_salida_gr?, superficie_m2?, color_aplicado?, observacion? }
 */
async function corregir(req, res) {
  const { id } = req.params;
  const { peso_entrada_gr, peso_salida_gr, superficie_m2, color_aplicado, observacion } = req.body;

  try {
    const r = await conTransaccion(async (client) => {
      const seg = await cargarSeguimientoBloqueado(client, id);
      if (seg.estado === 'anulado') {
        throw new ErrorNegocio(400, { error: 'Este seguimiento está anulado y ya no se puede corregir.' });
      }

      let entrada = parseFloat(seg.peso_entrada_gr);
      if (peso_entrada_gr !== undefined && peso_entrada_gr !== null && peso_entrada_gr !== '') {
        entrada = parseFloat(peso_entrada_gr);
        if (isNaN(entrada) || entrada <= 0) {
          throw new ErrorNegocio(400, { error: 'El peso de entrada debe ser un número mayor a 0' });
        }
      }

      // Si no se informa, se conserva el que ya tenía (y se revalida contra la entrada nueva)
      const salidaCruda = (peso_salida_gr === undefined) ? seg.peso_salida_gr : peso_salida_gr;
      const salida = leerPesoSalida(salidaCruda, entrada);
      const superficie = leerSuperficie(superficie_m2);

      const { rows } = await client.query(
        `UPDATE seguimiento_pintura SET
           peso_entrada_gr  = $1,
           peso_salida_gr   = $2,
           fecha_devolucion = CASE WHEN $2::numeric IS NULL THEN NULL
                                   ELSE COALESCE(fecha_devolucion, now()) END,
           superficie_m2    = COALESCE($3, superficie_m2),
           color_aplicado   = COALESCE($4, color_aplicado),
           observacion      = COALESCE($5, observacion),
           estado           = CASE WHEN $2::numeric IS NULL THEN 'abierto' ELSE 'cerrado' END
         WHERE seguimiento_pintura_id = $6
         RETURNING peso_consumido_gr`,
        [entrada, salida, superficie, color_aplicado || null, observacion || null, id]
      );

      const consumido = rows[0].peso_consumido_gr != null ? parseFloat(rows[0].peso_consumido_gr) : null;
      const anterior  = seg.peso_consumido_gr != null ? parseFloat(seg.peso_consumido_gr) : null;
      const ajuste = await ajustarStock(client, seg, consumido, req.user?.id, 'Corrección de consumo de pintura');

      return { consumido, anterior, ajuste, sku: seg.sku };
    });

    await auditoria.registrar(req.user?.id, 'Corregir seguimiento de pintura',
      `Seguimiento #${id} (${r.sku}): consumo ${r.anterior ?? 'sin devolver'} gr → ${r.consumido ?? 'sin devolver'} gr ` +
      `(ajuste de stock ${r.ajuste.delta_kg} kg)`);

    res.json({
      message: `Seguimiento corregido. ` +
        (r.ajuste.delta_kg === 0
          ? 'El stock no cambió.'
          : r.ajuste.delta_kg > 0
            ? `Se descontaron ${r.ajuste.delta_kg} kg adicionales del stock.`
            : `Se devolvieron ${-r.ajuste.delta_kg} kg al stock.`),
      id: parseInt(id),
      peso_consumido_gr: r.consumido,
      consumo_anterior_gr: r.anterior,
      ajuste_stock_kg: r.ajuste.delta_kg,
      advertencia: r.ajuste.advertencia,
    });
  } catch (err) {
    responderError(res, err, 'Error corrigiendo seguimiento de pintura:');
  }
}

/**
 * PUT /api/seguimiento-pinturas/:id/anular
 * Anula un seguimiento y devuelve al stock lo que hubiera descontado.
 * No se borra la fila: el registro sigue siendo historial, marcado como anulado.
 * Body: { motivo? }
 */
async function anular(req, res) {
  const { id } = req.params;
  const { motivo } = req.body || {};

  try {
    const r = await conTransaccion(async (client) => {
      const seg = await cargarSeguimientoBloqueado(client, id);
      if (seg.estado === 'anulado') {
        throw new ErrorNegocio(400, { error: 'Este seguimiento ya está anulado.' });
      }

      // Llevar lo descontado a cero devuelve el stock con una entrada
      // 'devolucion_consumo'. Los movimientos anteriores NO se marcan revertidos:
      // salidas y devolución, todos vigentes, suman cero igual que el stock, y el
      // consumo neto también queda en cero. Antes se marcaba solo el último
      // (seg.movimiento_id, leído antes del ajuste) y el historial descuadraba.
      const ajuste = await ajustarStock(client, seg, 0, req.user?.id, 'Anulación de consumo de pintura');

      await client.query(
        `UPDATE seguimiento_pintura
         SET estado = 'anulado',
             observacion = COALESCE(observacion || ' · ', '') || $1
         WHERE seguimiento_pintura_id = $2`,
        [`ANULADO: ${motivo || 'sin motivo informado'}`, id]
      );

      return { ajuste, sku: seg.sku, devuelto: -ajuste.delta_kg };
    });

    await auditoria.registrar(req.user?.id, 'Anular seguimiento de pintura',
      `Seguimiento #${id} (${r.sku}) anulado. Se devolvieron ${r.devuelto} kg al stock. ` +
      `Motivo: ${motivo || 'sin motivo informado'}`);

    res.json({
      message: r.devuelto > 0
        ? `Seguimiento anulado. Se devolvieron ${r.devuelto} kg al stock.`
        : 'Seguimiento anulado. No había stock descontado que devolver.',
      id: parseInt(id),
      devuelto_kg: r.devuelto,
      advertencia: r.ajuste.advertencia,
    });
  } catch (err) {
    responderError(res, err, 'Error anulando seguimiento de pintura:');
  }
}

/**
 * GET /api/seguimiento-pinturas/catalogo
 * Lo que necesitan los formularios: pinturas activas y areas de trabajo.
 * Se devuelven TODAS las pinturas activas, con o sin stock — a diferencia de
 * /materiales/pinturas-sobrantes, que filtra por stock > 0 y por lo tanto haria
 * desaparecer del historial una pintura que se acabo.
 */
async function catalogo(req, res) {
  try {
    const [pinturas, areas] = await Promise.all([
      query(
        `SELECT m.material_sku AS sku,
                m.material_nombre_material AS nombre,
                ${COLOR_CATALOGO} AS color,
                m.es_material_pintura_custom AS es_custom,
                m.material_estado AS estado,
                um.material_unidad_medida_nombre AS unidad,
                COALESCE((SELECT SUM(ib.inventario_bodega_cantidad_fisica)
                          FROM inventario_bodega ib WHERE ib.material_sku = m.material_sku), 0) AS stock
         FROM material m
         LEFT JOIN material_unidad_medida um
                ON um.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
         WHERE ${ES_PINTURA} AND m.material_estado = 'activo'
         ORDER BY m.material_nombre_material`
      ),
      query(
        `SELECT area_trabajo_id_area AS id, area_trabajo_nombre_area AS nombre
         FROM area_trabajo WHERE area_trabajo_activo = TRUE
         ORDER BY area_trabajo_nombre_area`
      ),
    ]);

    res.json({
      pinturas: pinturas.rows.map(p => ({ ...p, stock: parseFloat(p.stock) })),
      areas: areas.rows,
    });
  } catch (err) {
    console.error('Error obteniendo catálogo de pinturas:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/seguimiento-pinturas
 * Query params: ?sku=&orden_trabajo_id=&area_trabajo_id=&desde=&hasta=
 *               &estado=abierto|cerrado|anulado|todos
 * Los anulados NO salen por defecto: siguen siendo historial, pero no consumo.
 */
async function listar(req, res) {
  const { sku, orden_trabajo_id, area_trabajo_id, desde, hasta, estado } = req.query;

  if (orden_trabajo_id && isNaN(parseInt(orden_trabajo_id))) {
    return res.status(400).json({ error: 'orden_trabajo_id debe ser numérico' });
  }

  const soloAbiertos = estado === 'abierto' ? true : estado === 'cerrado' ? false : null;
  // 'anulado' los muestra solos; 'todos' los incluye; cualquier otro caso los oculta
  const incluirAnulados = estado === 'anulado' ? 'solo' : estado === 'todos' ? 'si' : 'no';

  try {
    const { rows } = await query(
      `${SELECT_SEGUIMIENTO}
       WHERE ($1::text   IS NULL OR sp.material_sku ILIKE $1)
         AND ($2::bigint IS NULL OR sp.orden_trabajo_id_orden = $2::bigint)
         AND ($3::bigint IS NULL OR sp.area_trabajo_id = $3::bigint)
         AND ($4::date   IS NULL OR sp.fecha_uso >= $4::date)
         AND ($5::date   IS NULL OR sp.fecha_uso < ($5::date + INTERVAL '1 day'))
         AND ($6::boolean IS NULL OR (sp.peso_salida_gr IS NULL) = $6::boolean)
         AND CASE $7::text
               WHEN 'solo' THEN sp.estado = 'anulado'
               WHEN 'si'   THEN TRUE
               ELSE sp.estado <> 'anulado'
             END
       ORDER BY sp.fecha_uso DESC, sp.seguimiento_pintura_id DESC`,
      [sku || null, orden_trabajo_id || null, area_trabajo_id || null,
       desde || null, hasta || null, soloAbiertos, incluirAnulados]
    );

    const seguimientos = rows.map(normalizar);
    res.json({ resumen: resumirSeguimientos(seguimientos), seguimientos });
  } catch (err) {
    console.error('Error listando seguimiento de pinturas:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/seguimiento-pinturas/material/:sku
 * Historial de usos de una pintura concreta, con acumulados.
 */
async function historialPorMaterial(req, res) {
  const { sku } = req.params;

  try {
    const { rows: mat } = await query(
      `SELECT m.material_sku AS sku, m.material_nombre_material AS nombre,
              ${COLOR_CATALOGO} AS color, ${ES_PINTURA} AS es_pintura,
              COALESCE((SELECT SUM(ib.inventario_bodega_cantidad_fisica)
                        FROM inventario_bodega ib WHERE ib.material_sku = m.material_sku), 0) AS stock
       FROM material m WHERE m.material_sku ILIKE $1`,
      [sku]
    );
    if (mat.length === 0) {
      return res.status(404).json({ error: 'El SKU no corresponde a un producto registrado' });
    }

    const { rows } = await query(
      `${SELECT_SEGUIMIENTO}
       WHERE sp.material_sku ILIKE $1 AND sp.estado <> 'anulado'
       ORDER BY sp.fecha_uso DESC, sp.seguimiento_pintura_id DESC`,
      [sku]
    );

    const seguimientos = rows.map(normalizar);
    const resumen = resumirSeguimientos(seguimientos);
    const cerrados = seguimientos.filter(s => !s.abierto);

    res.json({
      material: {
        ...mat[0],
        stock: parseFloat(mat[0].stock),
      },
      resumen: {
        ...resumen,
        // Sirve para detectar usos anormales: se comparan contra este promedio
        consumo_promedio_gr: cerrados.length > 0
          ? Math.round((resumen.consumido_gr / cerrados.length) * 100) / 100
          : null,
      },
      seguimientos,
    });
  } catch (err) {
    console.error('Error consultando historial de pintura:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/seguimiento-pinturas/reporte?desde=&hasta=&agrupar=material|color|area|ot
 * Consumo del periodo agrupado, con rendimiento gr/m2 cuando hay superficie.
 * Solo cuenta retiros CERRADOS: los abiertos no tienen consumo medido.
 */
async function reporteConsumo(req, res) {
  const { desde, hasta } = req.query;
  const agrupar = ['material', 'color', 'area', 'ot'].includes(req.query.agrupar)
    ? req.query.agrupar : 'material';

  const GRUPOS = {
    material: { clave: 'sp.material_sku',           etiqueta: `m.material_nombre_material` },
    color:    { clave: `COALESCE(sp.color_aplicado, ${COLOR_CATALOGO}, 'Sin color')`, etiqueta: `COALESCE(sp.color_aplicado, ${COLOR_CATALOGO}, 'Sin color')` },
    area:     { clave: `COALESCE(at.area_trabajo_nombre_area, 'Sin área')`, etiqueta: `COALESCE(at.area_trabajo_nombre_area, 'Sin área')` },
    ot:       { clave: `COALESCE(sp.orden_trabajo_id_orden::text, 'Sin OT')`, etiqueta: `COALESCE('OT #' || sp.orden_trabajo_id_orden::text, 'Sin OT')` },
  };
  const g = GRUPOS[agrupar];

  try {
    const { rows } = await query(
      `SELECT ${g.clave}   AS clave,
              ${g.etiqueta} AS etiqueta,
              COUNT(*)                        AS usos,
              SUM(sp.peso_consumido_gr)       AS consumido_gr,
              AVG(sp.peso_consumido_gr)       AS promedio_gr,
              MAX(sp.peso_consumido_gr)       AS maximo_gr,
              SUM(sp.superficie_m2)           AS superficie_m2,
              CASE WHEN SUM(sp.superficie_m2) > 0
                   THEN ROUND(SUM(sp.peso_consumido_gr) / SUM(sp.superficie_m2), 2)
              END                             AS rendimiento_gr_m2
       FROM seguimiento_pintura sp
       JOIN material m ON m.material_sku = sp.material_sku
       LEFT JOIN area_trabajo at ON at.area_trabajo_id_area = sp.area_trabajo_id
       WHERE sp.peso_consumido_gr IS NOT NULL
         AND sp.estado <> 'anulado'
         AND ($1::date IS NULL OR sp.fecha_uso >= $1::date)
         AND ($2::date IS NULL OR sp.fecha_uso < ($2::date + INTERVAL '1 day'))
       GROUP BY ${g.clave}, ${g.etiqueta}
       ORDER BY SUM(sp.peso_consumido_gr) DESC`,
      [desde || null, hasta || null]
    );

    const grupos = rows.map(r => ({
      clave: r.clave,
      etiqueta: r.etiqueta,
      usos: parseInt(r.usos),
      consumido_gr: parseFloat(r.consumido_gr),
      promedio_gr: Math.round(parseFloat(r.promedio_gr) * 100) / 100,
      maximo_gr: parseFloat(r.maximo_gr),
      superficie_m2: r.superficie_m2 != null ? parseFloat(r.superficie_m2) : null,
      rendimiento_gr_m2: r.rendimiento_gr_m2 != null ? parseFloat(r.rendimiento_gr_m2) : null,
    }));

    const consumidoTotal = grupos.reduce((a, x) => a + x.consumido_gr, 0);
    const superficieTotal = grupos.reduce((a, x) => a + (x.superficie_m2 || 0), 0);

    // Los retiros sin devolver no entran al reporte: decirlo, no esconderlo
    const { rows: pend } = await query(
      `SELECT COUNT(*) AS abiertos FROM seguimiento_pintura
       WHERE peso_salida_gr IS NULL
         AND estado <> 'anulado'
         AND ($1::date IS NULL OR fecha_uso >= $1::date)
         AND ($2::date IS NULL OR fecha_uso < ($2::date + INTERVAL '1 day'))`,
      [desde || null, hasta || null]
    );

    res.json({
      agrupar,
      periodo: { desde: desde || null, hasta: hasta || null },
      resumen: {
        consumido_gr: Math.round(consumidoTotal * 100) / 100,
        superficie_m2: Math.round(superficieTotal * 100) / 100,
        rendimiento_gr_m2: superficieTotal > 0 ? Math.round((consumidoTotal / superficieTotal) * 100) / 100 : null,
        usos: grupos.reduce((a, x) => a + x.usos, 0),
        retiros_abiertos: parseInt(pend[0].abiertos),
      },
      grupos,
    });
  } catch (err) {
    console.error('Error generando reporte de consumo de pintura:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = {
  registrar, devolver, corregir, anular,
  listar, catalogo, historialPorMaterial, reporteConsumo,
};
