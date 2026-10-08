const { query } = require('../db/pool');
const { ErrorNegocio, conTransaccion, responderError } = require('../db/tx');
const auditoria = require('./auditoriaController');
const { TOLERANCIAS_INICIALES, TIPOS_TOLERANCIA, UMBRAL_MAXIMO_PCT } = require('../config/conteo');
const { tipoMovimientoId, motivoMovimientoId, descontarFifo, reponerFifo } = require('../db/stock');
const { generarAlertasAutomaticas } = require('./alertasController');

/** D53: referencia de los movimientos de ajuste de un conteo ('CONTEO-<id>'). La usa también el historial (CU-31). */
const PREFIJO_AJUSTE = 'CONTEO-';

/**
 * CU-37: conteo ciclico de inventario por bodega (decisiones D6 a D9).
 *
 *  - Por BODEGA. Productos de la bodega = materiales con fila en inventario_bodega
 *    para esa bodega, aunque hoy tengan 0 (contar 0 tambien confirma algo).
 *  - Conteo CIEGO: el stock teorico nunca se envia mientras se cuenta ni en el
 *    detalle de este CU. Lo muestra CU-43.
 *  - El teorico se guarda AL CONFIRMAR (D6): si CU-43 comparara contra el stock
 *    actual, los movimientos posteriores al conteo aparecerian como diferencias falsas.
 *    Es la cantidad FISICA: las reservas no cambian lo que hay en el estante.
 *  - Sin borrador en la BD (opcion A de la sesion 4): el conteo se registra de una
 *    vez al confirmar. El avance mientras se cuenta lo guarda el navegador.
 */

const MAX_DECIMALES = 4;          // conteo_ciclico_detalle_cantidad_contada NUMERIC(12,4)
const MAX_CANTIDAD = 1e8;         // NUMERIC(12,4) admite hasta 99.999.999,9999
const MAX_OBSERVACION = 500;

/**
 * CU-37 Exc 1: cantidad vacia = no contado (null); si viene, numero >= 0 con
 * hasta 4 decimales. Devuelve { valor } o { error }.
 */
function validarCantidad(cantidad) {
  if (cantidad === null || cantidad === undefined || cantidad === '') return { valor: null };
  const texto = String(cantidad).trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(texto)) return { error: 'debe ser un número igual o mayor a cero' };
  const n = Number(texto);
  if (!Number.isFinite(n) || n >= MAX_CANTIDAD) return { error: 'es demasiado grande' };
  const decimales = (texto.split('.')[1] || '').length;
  if (decimales > MAX_DECIMALES) return { error: `admite como máximo ${MAX_DECIMALES} decimales` };
  return { valor: texto };
}

/** Bodega + productos registrados en ella (sin teorico). */
async function productosDeBodega(q, bodegaId) {
  const { rows } = await q(
    `SELECT m.material_sku                  AS sku,
            m.material_nombre_material      AS nombre,
            m.material_estado               AS estado,
            u.material_unidad_medida_nombre AS unidad_medida,
            (SELECT c.material_codigo_barras FROM material_codigo_barras c
             WHERE c.material_sku = m.material_sku LIMIT 1) AS codigo_barras
     FROM material m
     LEFT JOIN material_unidad_medida u
            ON u.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
     WHERE m.material_sku IN (SELECT DISTINCT material_sku FROM inventario_bodega WHERE bodega_id_bodega = $1)
     ORDER BY m.material_nombre_material`,
    [bodegaId]
  );
  return rows;
}

/** Conteo confirmado hoy para la bodega (CU-37 Exc 3), o null. */
async function conteoDeHoy(q, bodegaId) {
  const { rows } = await q(
    `SELECT c.conteo_ciclico_id_conteo  AS id,
            c.conteo_ciclico_fecha_hora AS fecha_hora,
            u.usuario_username          AS usuario
     FROM conteo_ciclico c
     LEFT JOIN usuario u ON u.usuario_id_usuario = c.usuario_id_usuario
     WHERE c.bodega_id_bodega = $1
       AND c.conteo_ciclico_estado <> 'borrador'
       AND c.conteo_ciclico_fecha_hora::date = CURRENT_DATE
     ORDER BY c.conteo_ciclico_fecha_hora DESC
     LIMIT 1`,
    [bodegaId]
  );
  return rows[0] || null;
}

/**
 * GET /api/conteos/bodega/:id/preparar
 * Lo que la pantalla necesita para empezar a contar: productos de la bodega (sin
 * teorico) y el conteo de hoy si ya existe (Exc 3).
 */
async function preparar(req, res) {
  const bodegaId = parseInt(req.params.id);
  if (!Number.isInteger(bodegaId)) return res.status(400).json({ error: 'Bodega inválida' });
  try {
    const { rows: bod } = await query(
      `SELECT bodega_id_bodega AS id, bodega_nombre_bodega AS nombre, bodega_estado AS estado
       FROM bodega WHERE bodega_id_bodega = $1`,
      [bodegaId]
    );
    if (bod.length === 0) return res.status(404).json({ error: 'Bodega no encontrada' });

    const productos = await productosDeBodega(query, bodegaId);
    // Exc 2: bodega sin productos asignados
    if (productos.length === 0) {
      return res.status(400).json({
        error: `La bodega ${bod[0].nombre} no tiene productos registrados. No hay nada que contar.`,
      });
    }
    const conteo_hoy = await conteoDeHoy(query, bodegaId);
    res.json({ bodega: bod[0], productos, conteo_hoy });
  } catch (err) {
    console.error('Error preparando conteo:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/conteos
 * Body: { bodega_id, justificacion?, lineas: [{ sku, cantidad, observacion? }] }
 * Registra el conteo confirmado, con el teorico tomado en este momento.
 */
async function crear(req, res) {
  const { bodega_id, lineas } = req.body;
  const justificacion = typeof req.body.justificacion === 'string' ? req.body.justificacion.trim() : '';
  const bodegaId = parseInt(bodega_id);

  if (!Number.isInteger(bodegaId)) {
    return res.status(400).json({ error: 'Seleccione la bodega a contar.' });
  }
  if (!Array.isArray(lineas) || lineas.length === 0) {
    return res.status(400).json({ error: 'El conteo no tiene productos.' });
  }

  // Exc 1 y formato de las lineas: se valida TODO antes de abrir la transaccion
  const porSku = new Map();
  for (const l of lineas) {
    const sku = typeof l?.sku === 'string' ? l.sku.trim().toUpperCase() : '';
    if (!sku) return res.status(400).json({ error: 'Hay una línea sin SKU.' });
    if (porSku.has(sku)) return res.status(400).json({ error: `El producto ${sku} está repetido en el conteo.`, sku });
    const c = validarCantidad(l.cantidad);
    if (c.error) return res.status(400).json({ error: `La cantidad de ${sku} ${c.error}.`, sku, campo: 'cantidad' });
    const observacion = typeof l.observacion === 'string' ? l.observacion.trim() : '';
    if (observacion.length > MAX_OBSERVACION) {
      return res.status(400).json({ error: `La observación de ${sku} supera los ${MAX_OBSERVACION} caracteres.`, sku, campo: 'observacion' });
    }
    porSku.set(sku, { cantidad: c.valor, observacion: observacion || null });
  }
  if (![...porSku.values()].some(l => l.cantidad !== null)) {
    return res.status(400).json({ error: 'Ingrese la cantidad contada de al menos un producto.' });
  }

  try {
    const r = await conTransaccion(async (client) => {
      const q = (text, params) => client.query(text, params);

      // FOR UPDATE sobre la bodega: dos confirmaciones simultaneas de la misma
      // bodega se ordenan, y la segunda ve la primera al revisar la Exc 3.
      const { rows: bod } = await q(
        `SELECT bodega_nombre_bodega AS nombre, bodega_estado AS estado
         FROM bodega WHERE bodega_id_bodega = $1 FOR UPDATE`,
        [bodegaId]
      );
      if (bod.length === 0) throw new ErrorNegocio(404, { error: 'Bodega no encontrada' });

      const productos = await productosDeBodega(q, bodegaId);
      // Exc 2
      if (productos.length === 0) {
        throw new ErrorNegocio(400, { error: `La bodega ${bod[0].nombre} no tiene productos registrados. No hay nada que contar.` });
      }

      // Exc 3: ya hay un conteo de esta bodega hoy → solo con justificacion
      const hoy = await conteoDeHoy(q, bodegaId);
      if (hoy && !justificacion) {
        throw new ErrorNegocio(409, {
          error: `Ya existe un conteo de ${bod[0].nombre} registrado hoy. Revíselo o indique por qué se hace otro.`,
          conteo_existente: hoy,
        });
      }

      // Los SKU enviados que no estan en la bodega deben existir en el catalogo
      const enBodega = new Set(productos.map(p => p.sku.toUpperCase()));
      const noEsperados = [...porSku.keys()].filter(s => !enBodega.has(s));
      const skuReal = new Map(productos.map(p => [p.sku.toUpperCase(), p.sku]));
      if (noEsperados.length) {
        const { rows: existen } = await q(
          `SELECT material_sku FROM material WHERE UPPER(material_sku) = ANY($1::text[])`, [noEsperados]
        );
        for (const e of existen) skuReal.set(e.material_sku.toUpperCase(), e.material_sku);
        const faltan = noEsperados.filter(s => !skuReal.has(s));
        if (faltan.length) {
          throw new ErrorNegocio(400, { error: `El producto ${faltan[0]} no existe en el catálogo.`, sku: faltan[0] });
        }
      }

      // Teorico = stock FISICO en este momento. FOR SHARE bloquea las filas de la
      // bodega hasta el COMMIT, asi ningun movimiento se cuela entre la lectura y el registro.
      await q(`SELECT 1 FROM inventario_bodega WHERE bodega_id_bodega = $1 FOR SHARE`, [bodegaId]);
      const { rows: teoricos } = await q(
        `SELECT material_sku, SUM(inventario_bodega_cantidad_fisica) AS teorico
         FROM inventario_bodega WHERE bodega_id_bodega = $1 GROUP BY material_sku`,
        [bodegaId]
      );
      const teoricoDe = new Map(teoricos.map(t => [t.material_sku.toUpperCase(), t.teorico]));

      const { rows: cab } = await q(
        `INSERT INTO conteo_ciclico (conteo_ciclico_estado, conteo_ciclico_justificacion,
                                     conteo_ciclico_fecha_confirmacion, bodega_id_bodega, usuario_id_usuario)
         VALUES ('confirmado', $1, now(), $2, $3)
         RETURNING conteo_ciclico_id_conteo AS id, conteo_ciclico_fecha_hora AS fecha_hora`,
        [justificacion || null, bodegaId, req.user.id]
      );
      const id = cab[0].id;

      let contados = 0, sinContar = 0, noEsp = 0;
      // Productos de la bodega: todos, contados o no (los no contados van con NULL
      // para que CU-43 los informe, Exc 1 de CU-43)
      for (const p of productos) {
        const l = porSku.get(p.sku.toUpperCase());
        const cantidad = l ? l.cantidad : null;
        if (cantidad === null) sinContar++; else contados++;
        await q(
          `INSERT INTO conteo_ciclico_detalle (conteo_ciclico_id_conteo, material_sku,
             conteo_ciclico_detalle_cantidad_contada, conteo_ciclico_detalle_stock_teorico,
             conteo_ciclico_detalle_no_esperado, conteo_ciclico_detalle_observacion)
           VALUES ($1, $2, $3, $4, FALSE, $5)`,
          [id, p.sku, cantidad, teoricoDe.get(p.sku.toUpperCase()) ?? 0, l?.observacion ?? null]
        );
      }
      // Exc 4: producto que no esta registrado en la bodega → no esperado, teorico 0.
      // Una linea no esperada sin cantidad no aporta nada y se descarta.
      for (const s of noEsperados) {
        const l = porSku.get(s);
        if (l.cantidad === null) continue;
        noEsp++; contados++;
        await q(
          `INSERT INTO conteo_ciclico_detalle (conteo_ciclico_id_conteo, material_sku,
             conteo_ciclico_detalle_cantidad_contada, conteo_ciclico_detalle_stock_teorico,
             conteo_ciclico_detalle_no_esperado, conteo_ciclico_detalle_observacion)
           VALUES ($1, $2, $3, 0, TRUE, $4)`,
          [id, skuReal.get(s), l.cantidad, l.observacion]
        );
      }
      return { id, fecha_hora: cab[0].fecha_hora, bodega: bod[0].nombre, contados, sinContar, noEsp };
    });

    await auditoria.registrar(req.user.id, 'Conteo cíclico',
      `Conteo #${r.id} de ${r.bodega}: ${r.contados} contados, ${r.sinContar} sin contar, ${r.noEsp} no esperados`);
    res.status(201).json({
      message: 'Conteo registrado correctamente.',
      id: r.id,
      fecha_hora: r.fecha_hora,
      contados: r.contados,
      sin_contar: r.sinContar,
      no_esperados: r.noEsp,
    });
  } catch (err) {
    responderError(res, err, 'Error registrando conteo:');
  }
}

/**
 * GET /api/conteos?bodega_id=&estado=
 * Historial de conteos, del mas reciente al mas antiguo.
 */
async function listar(req, res) {
  const bodegaId = req.query.bodega_id ? parseInt(req.query.bodega_id) : null;
  const estado = req.query.estado || null;
  try {
    const { rows } = await query(
      `SELECT c.conteo_ciclico_id_conteo       AS id,
              c.conteo_ciclico_fecha_hora      AS fecha_hora,
              c.conteo_ciclico_estado          AS estado,
              c.conteo_ciclico_resultado       AS resultado,
              c.conteo_ciclico_justificacion   AS justificacion,
              c.bodega_id_bodega               AS bodega_id,
              b.bodega_nombre_bodega           AS bodega,
              u.usuario_username               AS usuario,
              COUNT(d.material_sku)                                                     AS total_items,
              COUNT(d.conteo_ciclico_detalle_cantidad_contada)                          AS contados,
              COUNT(*) FILTER (WHERE d.conteo_ciclico_detalle_no_esperado)              AS no_esperados
       FROM conteo_ciclico c
       JOIN bodega b ON b.bodega_id_bodega = c.bodega_id_bodega
       LEFT JOIN usuario u ON u.usuario_id_usuario = c.usuario_id_usuario
       LEFT JOIN conteo_ciclico_detalle d ON d.conteo_ciclico_id_conteo = c.conteo_ciclico_id_conteo
       WHERE ($1::bigint IS NULL OR c.bodega_id_bodega = $1)
         AND ($2::text IS NULL OR c.conteo_ciclico_estado = $2)
       GROUP BY c.conteo_ciclico_id_conteo, b.bodega_nombre_bodega, u.usuario_username
       ORDER BY c.conteo_ciclico_fecha_hora DESC
       LIMIT 500`,
      [Number.isInteger(bodegaId) ? bodegaId : null, estado]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listando conteos:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/conteos/:id
 * Detalle de un conteo con las cantidades contadas. Sin teorico: la comparacion
 * es de CU-43.
 */
async function obtener(req, res) {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Conteo inválido' });
  try {
    const { rows: cab } = await query(
      `SELECT c.conteo_ciclico_id_conteo            AS id,
              c.conteo_ciclico_fecha_hora           AS fecha_hora,
              c.conteo_ciclico_fecha_confirmacion   AS fecha_confirmacion,
              c.conteo_ciclico_estado               AS estado,
              c.conteo_ciclico_resultado            AS resultado,
              c.conteo_ciclico_justificacion        AS justificacion,
              c.bodega_id_bodega                    AS bodega_id,
              b.bodega_nombre_bodega                AS bodega,
              u.usuario_username                    AS usuario,
              -- CU-57: alertas ya generadas desde este conteo
              (SELECT COUNT(*) FROM alerta_inventario a
               WHERE a.conteo_ciclico_id_conteo = c.conteo_ciclico_id_conteo)::int AS alertas_generadas
       FROM conteo_ciclico c
       JOIN bodega b ON b.bodega_id_bodega = c.bodega_id_bodega
       LEFT JOIN usuario u ON u.usuario_id_usuario = c.usuario_id_usuario
       WHERE c.conteo_ciclico_id_conteo = $1`,
      [id]
    );
    if (cab.length === 0) return res.status(404).json({ error: 'Conteo no encontrado' });

    const { rows: lineas } = await query(
      `SELECT d.material_sku                              AS sku,
              m.material_nombre_material                  AS nombre,
              un.material_unidad_medida_nombre            AS unidad_medida,
              d.conteo_ciclico_detalle_cantidad_contada   AS cantidad_contada,
              d.conteo_ciclico_detalle_no_esperado        AS no_esperado,
              d.conteo_ciclico_detalle_observacion        AS observacion
       FROM conteo_ciclico_detalle d
       JOIN material m ON m.material_sku = d.material_sku
       LEFT JOIN material_unidad_medida un
              ON un.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
       WHERE d.conteo_ciclico_id_conteo = $1
       ORDER BY d.conteo_ciclico_detalle_no_esperado, m.material_nombre_material`,
      [id]
    );
    res.json({ ...cab[0], lineas });
  } catch (err) {
    console.error('Error obteniendo conteo:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   CU-43: detectar diferencias
   ══════════════════════════════════════════════════════════════════════════ */

const PCT_MAXIMO = 9999999.99; // diferencia_inventario_diferencia_pct NUMERIC(9,2)

/**
 * Tolerancias vigentes por tipo de producto (D10, sesion 4). Si falta una fila
 * (instalacion desde cero), se usa el valor inicial de src/config/conteo.js.
 */
async function leerTolerancias(q) {
  const { rows } = await q(
    `SELECT t.tolerancia_conteo_tipo               AS tipo,
            t.tolerancia_conteo_tolerancia_pct     AS tolerancia_pct,
            t.tolerancia_conteo_umbral_critico_pct AS umbral_critico_pct,
            t.tolerancia_conteo_fecha_modificacion AS fecha_modificacion,
            u.usuario_username                     AS usuario
     FROM tolerancia_conteo t
     LEFT JOIN usuario u ON u.usuario_id_usuario = t.usuario_id_usuario`
  );
  const porTipo = Object.fromEntries(rows.map(r => [r.tipo, r]));
  const out = {};
  for (const tipo of TIPOS_TOLERANCIA) {
    const r = porTipo[tipo];
    out[tipo] = r
      ? { tolerancia_pct: parseFloat(r.tolerancia_pct), umbral_critico_pct: parseFloat(r.umbral_critico_pct),
          fecha_modificacion: r.fecha_modificacion, usuario: r.usuario, configurado: true }
      : { ...TOLERANCIAS_INICIALES[tipo], fecha_modificacion: null, usuario: null, configurado: false };
  }
  return out;
}

/** NUMERIC(12,4) de pg (string) → entero en diezmilesimas, para restar sin error de coma flotante. */
const aDiezmilesimas = (v) => Math.round(parseFloat(v) * 10000);

/**
 * Compara cada linea CONTADA contra el teorico guardado al confirmar (D6), nunca
 * contra el stock actual. Las lineas sin contar se excluyen (Exc 1).
 */
function compararLinea(l, tolerancias) {
  const t = aDiezmilesimas(l.stock_teorico);
  const c = aDiezmilesimas(l.cantidad_contada);
  const dif = c - t;
  const tol = tolerancias[l.es_critico ? 'critico' : 'no_critico'];

  let pct = null;
  if (t !== 0) {
    pct = Math.round((dif / t) * 10000) / 100;              // 2 decimales
    pct = Math.max(-PCT_MAXIMO, Math.min(PCT_MAXIMO, pct));
  }
  const clasificacion = dif < 0 ? 'faltante' : dif > 0 ? 'sobrante' : 'sin_diferencia';
  // Teorico 0 con algo contado: el % no existe, y encontrar lo que el sistema no
  // esperaba es justo lo que el conteo debe detectar → siempre fuera de tolerancia.
  const supera = t === 0 ? c > 0 : Math.abs(pct) > tol.tolerancia_pct;

  return {
    sku: l.sku, nombre: l.nombre, unidad_medida: l.unidad_medida,
    es_critico: l.es_critico, no_esperado: l.no_esperado,
    stock_teorico: t / 10000, cantidad_contada: c / 10000, diferencia: dif / 10000,
    diferencia_pct: pct, clasificacion, supera_tolerancia: supera,
    tolerancia_pct: tol.tolerancia_pct, umbral_critico_pct: tol.umbral_critico_pct,
  };
}

function resumir(lineas) {
  return {
    faltantes:        lineas.filter(l => l.clasificacion === 'faltante').length,
    sobrantes:        lineas.filter(l => l.clasificacion === 'sobrante').length,
    sin_diferencia:   lineas.filter(l => l.clasificacion === 'sin_diferencia').length,
    fuera_tolerancia: lineas.filter(l => l.supera_tolerancia).length,
  };
}

/** Lineas del conteo con los datos del material (incluye el teorico: solo para CU-43). */
async function lineasDelConteo(q, id) {
  const { rows } = await q(
    `SELECT d.material_sku                              AS sku,
            m.material_nombre_material                  AS nombre,
            un.material_unidad_medida_nombre            AS unidad_medida,
            COALESCE(m.material_material_critico, FALSE) AS es_critico,
            d.conteo_ciclico_detalle_no_esperado        AS no_esperado,
            d.conteo_ciclico_detalle_stock_teorico      AS stock_teorico,
            d.conteo_ciclico_detalle_cantidad_contada   AS cantidad_contada
     FROM conteo_ciclico_detalle d
     JOIN material m ON m.material_sku = d.material_sku
     LEFT JOIN material_unidad_medida un
            ON un.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
     WHERE d.conteo_ciclico_id_conteo = $1
     ORDER BY d.conteo_ciclico_detalle_no_esperado, m.material_nombre_material`,
    [id]
  );
  return {
    contadas:  rows.filter(r => r.cantidad_contada !== null),
    sinContar: rows.filter(r => r.cantidad_contada === null)
                   .map(r => ({ sku: r.sku, nombre: r.nombre, unidad_medida: r.unidad_medida })),
  };
}

async function cabeceraConteo(q, id, bloquear = false) {
  const { rows } = await q(
    `SELECT c.conteo_ciclico_id_conteo           AS id,
            c.conteo_ciclico_fecha_hora          AS fecha_hora,
            c.conteo_ciclico_estado              AS estado,
            c.conteo_ciclico_resultado           AS resultado,
            c.conteo_ciclico_fecha_procesamiento AS fecha_procesamiento,
            c.bodega_id_bodega                   AS bodega_id,
            b.bodega_nombre_bodega               AS bodega,
            u.usuario_username                   AS usuario,
            up.usuario_username                  AS procesado_por,
            (SELECT COUNT(*) FROM alerta_inventario a
             WHERE a.conteo_ciclico_id_conteo = c.conteo_ciclico_id_conteo)::int AS alertas_generadas
     FROM conteo_ciclico c
     JOIN bodega b ON b.bodega_id_bodega = c.bodega_id_bodega
     LEFT JOIN usuario u  ON u.usuario_id_usuario  = c.usuario_id_usuario
     LEFT JOIN usuario up ON up.usuario_id_usuario = c.usuario_procesa_id
     WHERE c.conteo_ciclico_id_conteo = $1
     ${bloquear ? 'FOR UPDATE OF c' : ''}`,
    [id]
  );
  return rows[0] || null;
}

/** Diferencias ya registradas de un conteo procesado (Exc 3: resultado anterior). */
async function diferenciasGuardadas(q, id) {
  const { rows } = await q(
    `SELECT di.material_sku                             AS sku,
            m.material_nombre_material                  AS nombre,
            un.material_unidad_medida_nombre            AS unidad_medida,
            COALESCE(m.material_material_critico, FALSE) AS es_critico,
            COALESCE(d.conteo_ciclico_detalle_no_esperado, FALSE) AS no_esperado,
            di.diferencia_inventario_stock_teorico      AS stock_teorico,
            di.diferencia_inventario_cantidad_contada   AS cantidad_contada,
            di.diferencia_inventario_diferencia         AS diferencia,
            di.diferencia_inventario_diferencia_pct     AS diferencia_pct,
            di.diferencia_inventario_clasificacion      AS clasificacion,
            di.diferencia_inventario_supera_tolerancia  AS supera_tolerancia,
            di.diferencia_inventario_tolerancia_pct     AS tolerancia_pct,
            di.diferencia_inventario_umbral_critico_pct AS umbral_critico_pct,
            -- D53: ya tiene un ajuste vigente (no revertido) de este conteo
            EXISTS (SELECT 1 FROM movimiento_inventario mi
                    WHERE mi.movimiento_inventario_referencia_origen = '${PREFIJO_AJUSTE}' || di.conteo_ciclico_id_conteo
                      AND mi.material_sku = di.material_sku
                      AND mi.movimiento_inventario_estado <> 'revertido'
                      AND mi.movimiento_inventario_id_revertido IS NULL) AS ajustado
     FROM diferencia_inventario di
     JOIN material m ON m.material_sku = di.material_sku
     LEFT JOIN material_unidad_medida un
            ON un.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
     LEFT JOIN conteo_ciclico_detalle d
            ON d.conteo_ciclico_id_conteo = di.conteo_ciclico_id_conteo AND d.material_sku = di.material_sku
     WHERE di.conteo_ciclico_id_conteo = $1
     ORDER BY no_esperado, m.material_nombre_material`,
    [id]
  );
  const num = (v) => (v === null ? null : parseFloat(v));
  return rows.map(r => ({
    ...r,
    stock_teorico: num(r.stock_teorico), cantidad_contada: num(r.cantidad_contada), diferencia: num(r.diferencia),
    diferencia_pct: num(r.diferencia_pct), tolerancia_pct: num(r.tolerancia_pct), umbral_critico_pct: num(r.umbral_critico_pct),
  }));
}

/**
 * GET /api/conteos/:id/diferencias   (soloGerencia: aqui se ve el teorico)
 * Confirmado → vista previa calculada, sin guardar nada.
 * Procesado  → las diferencias registradas (Exc 3).
 */
async function diferencias(req, res) {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Conteo inválido' });
  try {
    const conteo = await cabeceraConteo(query, id);
    if (!conteo) return res.status(404).json({ error: 'Conteo no encontrado' });
    if (conteo.estado === 'borrador') {
      return res.status(400).json({ error: 'El conteo todavía no está confirmado.' });
    }
    const { contadas, sinContar } = await lineasDelConteo(query, id);

    if (conteo.estado === 'procesado') {
      const lineas = await diferenciasGuardadas(query, id);
      return res.json({ conteo, procesado: true, lineas, sin_contar: sinContar, resumen: resumir(lineas) });
    }

    const tolerancias = await leerTolerancias(query);
    const lineas = contadas.map(l => compararLinea(l, tolerancias));
    const resumen = resumir(lineas);
    res.json({
      conteo, procesado: false, lineas, sin_contar: sinContar, resumen, tolerancias,
      resultado_previsto: resumen.fuera_tolerancia > 0 ? 'con_diferencias' : 'conforme',
    });
  } catch (err) {
    console.error('Error calculando diferencias:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/conteos/:id/procesar   (soloGerencia)
 * Registra las diferencias del conteo. Recalcula en el servidor: no confia en lo
 * que mostro la pantalla. NO ajusta el stock (la poscondicion deja el ajuste para despues).
 */
async function procesar(req, res) {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Conteo inválido' });
  try {
    const r = await conTransaccion(async (client) => {
      const q = (text, params) => client.query(text, params);
      // FOR UPDATE: dos clics simultaneos no pueden procesar dos veces el mismo conteo
      const conteo = await cabeceraConteo(q, id, true);
      if (!conteo) throw new ErrorNegocio(404, { error: 'Conteo no encontrado' });
      // Exc 3: ya procesado
      if (conteo.estado === 'procesado') {
        throw new ErrorNegocio(409, {
          error: 'Este conteo ya fue procesado. Se muestra el resultado registrado.',
          procesado: true,
        });
      }
      if (conteo.estado !== 'confirmado') {
        throw new ErrorNegocio(400, { error: 'El conteo todavía no está confirmado.' });
      }

      const tolerancias = await leerTolerancias(q);
      const { contadas } = await lineasDelConteo(q, id);
      const lineas = contadas.map(l => compararLinea(l, tolerancias));

      for (const l of lineas) {
        await q(
          `INSERT INTO diferencia_inventario (
             conteo_ciclico_id_conteo, material_sku,
             diferencia_inventario_stock_teorico, diferencia_inventario_cantidad_contada,
             diferencia_inventario_diferencia, diferencia_inventario_diferencia_pct,
             diferencia_inventario_clasificacion, diferencia_inventario_supera_tolerancia,
             diferencia_inventario_tolerancia_pct, diferencia_inventario_umbral_critico_pct,
             usuario_id_usuario)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, l.sku, l.stock_teorico, l.cantidad_contada, l.diferencia, l.diferencia_pct,
           l.clasificacion, l.supera_tolerancia, l.tolerancia_pct, l.umbral_critico_pct, req.user.id]
        );
      }

      const resumen = resumir(lineas);
      // Exc 2: todo dentro de tolerancia → conforme
      const resultado = resumen.fuera_tolerancia > 0 ? 'con_diferencias' : 'conforme';
      await q(
        `UPDATE conteo_ciclico
         SET conteo_ciclico_estado = 'procesado', conteo_ciclico_resultado = $2,
             conteo_ciclico_fecha_procesamiento = now(), usuario_procesa_id = $3
         WHERE conteo_ciclico_id_conteo = $1`,
        [id, resultado, req.user.id]
      );
      return { resultado, resumen, bodega: conteo.bodega };
    });

    await auditoria.registrar(req.user.id, 'Diferencias de conteo',
      `Conteo #${id}: ${r.resultado}, ${r.resumen.fuera_tolerancia} fuera de tolerancia`);
    res.status(201).json({
      message: r.resultado === 'conforme'
        ? 'No se detectaron discrepancias significativas. El conteo quedó registrado como conforme.'
        : `Diferencias registradas: ${r.resumen.fuera_tolerancia} producto(s) fuera de tolerancia.`,
      resultado: r.resultado,
      resumen: r.resumen,
    });
  } catch (err) {
    responderError(res, err, 'Error procesando diferencias:');
  }
}

/* ── Tolerancias (D10): las edita Gerencia ─────────────────────────────── */

/** GET /api/conteos/tolerancias */
async function obtenerTolerancias(req, res) {
  try {
    res.json(await leerTolerancias(query));
  } catch (err) {
    console.error('Error leyendo tolerancias:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

const NOMBRE_TIPO = { critico: 'productos críticos', no_critico: 'productos no críticos' };

/** Valida un porcentaje editable: numero >= 0 con hasta 2 decimales. */
function porcentaje(v) {
  const texto = String(v ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(texto)) return null;
  return Number(texto);
}

/**
 * PUT /api/conteos/tolerancias
 * Body: { critico: { tolerancia_pct, umbral_critico_pct }, no_critico: {...} } (uno o ambos)
 */
async function actualizarTolerancias(req, res) {
  const cambios = [];
  for (const tipo of TIPOS_TOLERANCIA) {
    const v = req.body?.[tipo];
    if (v === undefined) continue;
    const tol = porcentaje(v?.tolerancia_pct);
    const umb = porcentaje(v?.umbral_critico_pct);
    if (tol === null) {
      return res.status(400).json({ error: `La tolerancia de ${NOMBRE_TIPO[tipo]} debe ser un porcentaje igual o mayor a 0 (hasta 2 decimales).`, tipo, campo: 'tolerancia_pct' });
    }
    if (umb === null || umb <= tol) {
      return res.status(400).json({ error: `El umbral crítico de ${NOMBRE_TIPO[tipo]} debe ser mayor que su tolerancia (${tol} %).`, tipo, campo: 'umbral_critico_pct' });
    }
    if (umb > UMBRAL_MAXIMO_PCT) {
      return res.status(400).json({ error: `El umbral crítico de ${NOMBRE_TIPO[tipo]} no puede superar ${UMBRAL_MAXIMO_PCT} %.`, tipo, campo: 'umbral_critico_pct' });
    }
    cambios.push({ tipo, tol, umb });
  }
  if (cambios.length === 0) {
    return res.status(400).json({ error: 'No se indicó ninguna tolerancia para modificar.' });
  }

  try {
    await conTransaccion(async (client) => {
      for (const c of cambios) {
        await client.query(
          `INSERT INTO tolerancia_conteo (tolerancia_conteo_tipo, tolerancia_conteo_tolerancia_pct,
                                          tolerancia_conteo_umbral_critico_pct, tolerancia_conteo_fecha_modificacion,
                                          usuario_id_usuario)
           VALUES ($1, $2, $3, now(), $4)
           ON CONFLICT (tolerancia_conteo_tipo) DO UPDATE
             SET tolerancia_conteo_tolerancia_pct     = EXCLUDED.tolerancia_conteo_tolerancia_pct,
                 tolerancia_conteo_umbral_critico_pct = EXCLUDED.tolerancia_conteo_umbral_critico_pct,
                 tolerancia_conteo_fecha_modificacion = now(),
                 usuario_id_usuario                   = EXCLUDED.usuario_id_usuario`,
          [c.tipo, c.tol, c.umb, req.user.id]
        );
      }
    });
    await auditoria.registrar(req.user.id, 'Tolerancias de conteo',
      cambios.map(c => `${c.tipo} ${c.tol}%/${c.umb}%`).join(', '));
    res.json({ message: 'Tolerancias actualizadas. Se aplican a los conteos que se procesen desde ahora.', tolerancias: await leerTolerancias(query) });
  } catch (err) {
    responderError(res, err, 'Error actualizando tolerancias:');
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   CU-57: alertas por diferencia de inventario
   ══════════════════════════════════════════════════════════════════════════ */

// Tipos sembrados en la sesion 1. La prioridad es del TIPO (D11): alta y urgente.
const TIPO_DIFERENCIA         = 'diferencia inventario';
const TIPO_DIFERENCIA_CRITICA = 'diferencia inventario critica';

const fmt = (v) => Number(v).toLocaleString('es-CL', { maximumFractionDigits: 4 });
function mensajeAlerta(d, conteoId, anterior) {
  const pct = d.pct === null ? 'sin stock teórico' : `${d.pct > 0 ? '+' : ''}${fmt(d.pct)} %`;
  const base = `Diferencia de conteo: ${d.clasificacion} de ${fmt(Math.abs(d.diferencia))} (${pct}). ` +
               `Teórico ${fmt(d.teorico)}, contado ${fmt(d.contada)} en el conteo #${conteoId}.`;
  return anterior ? `${base} Actualiza la alerta del conteo #${anterior}.` : base;
}

/**
 * POST /api/conteos/:id/alertas   (gerencia, administrador y jop)
 * Genera las alertas de las diferencias FUERA de tolerancia de un conteo procesado.
 * Severidad segun el umbral critico guardado en cada linea por CU-43.
 */
async function generarAlertas(req, res) {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Conteo inválido' });
  try {
    const r = await conTransaccion(async (client) => {
      const q = (text, params) => client.query(text, params);
      const conteo = await cabeceraConteo(q, id, true);
      if (!conteo) throw new ErrorNegocio(404, { error: 'Conteo no encontrado' });
      if (conteo.estado !== 'procesado') {
        throw new ErrorNegocio(400, { error: 'Primero hay que registrar las diferencias del conteo (CU-43).' });
      }
      const { rows: ya } = await q(
        `SELECT COUNT(*)::int AS n FROM alerta_inventario WHERE conteo_ciclico_id_conteo = $1`, [id]
      );
      if (ya[0].n > 0) {
        throw new ErrorNegocio(409, { error: 'Las alertas de este conteo ya fueron generadas. Revíselas en el panel de alertas.', ya_generadas: ya[0].n });
      }

      const { rows: difs } = await q(
        `SELECT material_sku AS sku,
                diferencia_inventario_stock_teorico      AS teorico,
                diferencia_inventario_cantidad_contada   AS contada,
                diferencia_inventario_diferencia         AS diferencia,
                diferencia_inventario_diferencia_pct     AS pct,
                diferencia_inventario_clasificacion      AS clasificacion,
                diferencia_inventario_umbral_critico_pct AS umbral
         FROM diferencia_inventario
         WHERE conteo_ciclico_id_conteo = $1 AND diferencia_inventario_supera_tolerancia
         ORDER BY material_sku`,
        [id]
      );
      // Exc 1: nada fuera de tolerancia → no se genera nada
      if (difs.length === 0) return { creadas: 0, actualizadas: 0, criticas: 0, bodega: conteo.bodega };

      const { rows: tipos } = await q(
        `SELECT alerta_inventario_tipo_alerta_id_tipo_alerta AS id,
                LOWER(REPLACE(alerta_inventario_tipo_alerta_nombre, '_', ' ')) AS nombre
         FROM alerta_inventario_tipo_alerta
         WHERE LOWER(REPLACE(alerta_inventario_tipo_alerta_nombre, '_', ' ')) IN ($1, $2)`,
        [TIPO_DIFERENCIA, TIPO_DIFERENCIA_CRITICA]
      );
      const tipoId = Object.fromEntries(tipos.map(t => [t.nombre, t.id]));
      if (!tipoId[TIPO_DIFERENCIA] || !tipoId[TIPO_DIFERENCIA_CRITICA]) {
        throw new Error('Faltan los tipos de alerta de diferencia de inventario en el catálogo');
      }

      let creadas = 0, actualizadas = 0, criticas = 0;
      for (const raw of difs) {
        const d = {
          ...raw,
          pct: raw.pct === null ? null : parseFloat(raw.pct),
          diferencia: parseFloat(raw.diferencia), teorico: parseFloat(raw.teorico), contada: parseFloat(raw.contada),
        };
        // Exc 3: sobre el umbral critico guardado (o sin teorico) → critica
        const umbral = d.umbral === null ? null : parseFloat(d.umbral);
        const esCritica = d.pct === null || umbral === null || Math.abs(d.pct) > umbral;
        if (esCritica) criticas++;
        const tipo = tipoId[esCritica ? TIPO_DIFERENCIA_CRITICA : TIPO_DIFERENCIA];

        // Exc 2: alerta ACTIVA por diferencia del mismo producto y bodega → se actualiza
        const { rows: activa } = await q(
          `SELECT alerta_inventario_id_alerta AS id, conteo_ciclico_id_conteo AS conteo
           FROM alerta_inventario
           WHERE material_sku = $1 AND bodega_id_bodega = $2
             AND alerta_inventario_estado = 'activa'
             AND alerta_inventario_tipo_alerta_id_tipo_alerta = ANY($3::bigint[])
           ORDER BY alerta_inventario_fecha_generacion DESC
           LIMIT 1
           FOR UPDATE`,
          [d.sku, conteo.bodega_id, [tipoId[TIPO_DIFERENCIA], tipoId[TIPO_DIFERENCIA_CRITICA]]]
        );

        if (activa.length) {
          await q(
            `UPDATE alerta_inventario
             SET alerta_inventario_mensaje = $2,
                 alerta_inventario_tipo_alerta_id_tipo_alerta = $3,
                 conteo_ciclico_id_conteo = $4,
                 alerta_inventario_diferencia = $5,
                 alerta_inventario_diferencia_pct = $6,
                 usuario_id_usuario = $7,
                 alerta_inventario_fecha_generacion = now()
             WHERE alerta_inventario_id_alerta = $1`,
            [activa[0].id, mensajeAlerta(d, id, activa[0].conteo), tipo, id, d.diferencia, d.pct, req.user.id]
          );
          actualizadas++;
        } else {
          const { rows: hist } = await q(
            `INSERT INTO historial_alerta DEFAULT VALUES RETURNING historial_alerta_id_historial AS id`
          );
          await q(
            `INSERT INTO alerta_inventario (
               alerta_inventario_mensaje, alerta_inventario_estado, material_sku,
               alerta_inventario_tipo_alerta_id_tipo_alerta, historial_alerta_id_historial,
               bodega_id_bodega, conteo_ciclico_id_conteo,
               alerta_inventario_diferencia, alerta_inventario_diferencia_pct, usuario_id_usuario)
             VALUES ($1, 'activa', $2, $3, $4, $5, $6, $7, $8, $9)`,
            [mensajeAlerta(d, id, null), d.sku, tipo, hist[0].id, conteo.bodega_id, id, d.diferencia, d.pct, req.user.id]
          );
          creadas++;
        }
      }
      return { creadas, actualizadas, criticas, bodega: conteo.bodega };
    });

    const total = r.creadas + r.actualizadas;
    if (total === 0) {
      return res.json({ message: 'El conteo no arrojó diferencias fuera de tolerancia. No hay discrepancias que alertar.', ...r });
    }

    await auditoria.registrar(req.user.id, 'Alertas por diferencia',
      `Conteo #${id}: ${r.creadas} creadas, ${r.actualizadas} actualizadas, ${r.criticas} críticas`);
    // Exc 3: aviso inmediato a Gerencia, UNO por conteo con el resumen (decision de la sesion 4)
    if (r.criticas > 0) {
      const { notificarPorRol } = require('./notificacionesController');
      await notificarPorRol({
        tipo: 'diferencia_inventario',
        mensaje: `Conteo #${id} (${r.bodega}): ${r.criticas} diferencia(s) crítica(s) de inventario. Revise el panel de alertas.`,
        origen: 'conteos',
        rol: 'gerencia',
      });
    }
    res.status(201).json({
      message: `Alertas generadas: ${r.creadas} nueva(s), ${r.actualizadas} actualizada(s), ${r.criticas} crítica(s).`,
      ...r,
    });
  } catch (err) {
    responderError(res, err, 'Error generando alertas de conteo:');
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   D53: ajuste del stock desde las diferencias de un conteo procesado
   ══════════════════════════════════════════════════════════════════════════ */

const MAX_MOTIVO_AJUSTE = 255;

/**
 * POST /api/conteos/:id/ajustes   (soloGerencia) — D53
 * Body: { skus: [...], motivo }. Gerencia APRUEBA el ajuste (la aprobación es la acción): por cada SKU elegido, el
 * stock de la bodega del conteo se mueve por la DIFERENCIA registrada en CU-43 (contado − teórico), nunca hasta lo
 * contado: lo que se movió después del conteo no se pisa.
 *  - Faltante: salida por FIFO de lo LIBRE de la bodega. Si lo libre no alcanza, la línea se rechaza (lo reservado no
 *    se toca: primero se liberan o ajustan las reservas).
 *  - Sobrante: entrada al lote más antiguo del SKU en la bodega; si no tiene ninguno ("no esperado"), un lote nuevo.
 *  - Motivo 'ajuste_inventario' (no cuenta como consumo), referencia CONTEO-<id> y el motivo en la descripción.
 *    Se pueden revertir con CU-44; una línea con un ajuste vigente no se ajusta de nuevo.
 *  - Las alertas activas por diferencia de ese conteo y SKU (CU-57) quedan resueltas por quien aprueba.
 * Se valida TODO antes de tocar stock: si una línea no se puede ajustar, no se ajusta ninguna.
 */
async function ajustar(req, res) {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Conteo inválido' });
  const skus = Array.isArray(req.body?.skus) ? [...new Set(req.body.skus.map(s => String(s ?? '').trim()).filter(Boolean))] : [];
  const motivo = String(req.body?.motivo ?? '').trim();
  if (!skus.length) return res.status(400).json({ error: 'Seleccione al menos un producto para ajustar.' });
  if (!motivo) return res.status(400).json({ error: 'Indique el motivo del ajuste.' });
  if (motivo.length > MAX_MOTIVO_AJUSTE) return res.status(400).json({ error: `El motivo admite hasta ${MAX_MOTIVO_AJUSTE} caracteres.` });
  const referencia = `${PREFIJO_AJUSTE}${id}`;

  try {
    const r = await conTransaccion(async (client) => {
      const q = (text, params) => client.query(text, params);
      const conteo = await cabeceraConteo(q, id, true);
      if (!conteo) throw new ErrorNegocio(404, { error: 'Conteo no encontrado' });
      if (conteo.estado !== 'procesado') {
        throw new ErrorNegocio(400, { error: 'Primero hay que registrar las diferencias del conteo (CU-43).' });
      }
      const bodegaId = conteo.bodega_id;

      const { rows: difs } = await q(
        `SELECT di.material_sku AS sku, di.diferencia_inventario_diferencia::float AS diferencia,
                m.material_nombre_material AS nombre, m.material_estado AS estado
         FROM diferencia_inventario di JOIN material m ON m.material_sku = di.material_sku
         WHERE di.conteo_ciclico_id_conteo = $1 AND di.material_sku = ANY($2::text[])`,
        [id, skus]
      );
      const { rows: yaAjustados } = await q(
        `SELECT DISTINCT material_sku AS sku FROM movimiento_inventario
         WHERE movimiento_inventario_referencia_origen = $1 AND material_sku = ANY($2::text[])
           AND movimiento_inventario_estado <> 'revertido' AND movimiento_inventario_id_revertido IS NULL`,
        [referencia, skus]
      );
      const ajustados = new Set(yaAjustados.map(x => x.sku));
      const porSku = new Map(difs.map(d => [d.sku, d]));

      /* ── Validar todo antes de tocar stock ── */
      const errores = [];
      for (const sku of skus) {
        const d = porSku.get(sku);
        if (!d) { errores.push({ sku, error: 'No tiene una diferencia registrada en este conteo.' }); continue; }
        if (Math.abs(d.diferencia) < 1e-9) { errores.push({ sku, error: 'No tiene diferencia: no hay nada que ajustar.' }); continue; }
        if (ajustados.has(sku)) { errores.push({ sku, error: 'Ya se ajustó con este conteo. Para rehacerlo, revierta antes ese ajuste.' }); continue; }
        if (d.estado !== 'activo') { errores.push({ sku, error: 'El producto está inactivo: reactívelo para ajustar su stock.' }); continue; }
        if (d.diferencia < 0) {
          const { rows: st } = await q(
            `SELECT COALESCE(SUM(inventario_bodega_cantidad_fisica - inventario_bodega_cantidad_reservada), 0)::float AS libre,
                    COALESCE(SUM(inventario_bodega_cantidad_reservada), 0)::float AS reservado
             FROM inventario_bodega WHERE material_sku = $1 AND bodega_id_bodega = $2`,
            [sku, bodegaId]
          );
          if (-d.diferencia > st[0].libre + 1e-9) {
            errores.push({ sku, error: `Faltan ${fmt(-d.diferencia)} y en ${conteo.bodega} hay ${fmt(st[0].libre)} libre(s) ` +
                                       `(${fmt(st[0].reservado)} reservada(s)). Libere o ajuste las reservas antes de ajustar.` });
          }
        }
      }
      if (errores.length) {
        throw new ErrorNegocio(400, {
          error: errores.length === 1 ? `No se ajustó nada: ${errores[0].sku} — ${errores[0].error}` : `No se ajustó nada: ${errores.length} problema(s).`,
          errores,
        });
      }

      const tipoEntrada = await tipoMovimientoId(client, 'entrada');
      const tipoSalida = await tipoMovimientoId(client, 'salida');
      const motivoId = await motivoMovimientoId(client, 'ajuste_inventario');
      if (!tipoEntrada || !tipoSalida || !motivoId) {
        throw new ErrorNegocio(500, { error: 'Falta el motivo "ajuste_inventario" o los tipos entrada/salida en el catálogo. Avise al administrador del sistema.' });
      }

      /* ── Ajustar por la diferencia ── */
      const hechos = [];
      for (const sku of skus) {
        const d = porSku.get(sku);
        const cantidad = Math.abs(d.diferencia);
        let loteId;
        if (d.diferencia < 0) {
          loteId = (await descontarFifo(client, sku, bodegaId, cantidad)).lote_principal;
        } else {
          loteId = await reponerFifo(client, sku, bodegaId, cantidad, null);
          if (!loteId) {
            // "No esperado": el SKU no tenía lotes en esta bodega
            const { rows: l } = await q(
              `INSERT INTO lote (lote_fecha_ingreso, lote_fecha_recepcion, lote_estado) VALUES (now(), now(), 'activo')
               RETURNING lote_id_lote`
            );
            loteId = l[0].lote_id_lote;
            await q(`UPDATE lote SET lote_numero_lote = 'LOTE-' || to_char(now(), 'YYYYMMDD') || '-' || lote_id_lote WHERE lote_id_lote = $1`, [loteId]);
            await q(
              `INSERT INTO inventario_bodega (material_sku, lote_id_lote, bodega_id_bodega, inventario_bodega_cantidad_fisica)
               VALUES ($1, $2, $3, $4)`,
              [sku, loteId, bodegaId, cantidad]
            );
          }
        }
        const { rows: mov } = await q(
          `INSERT INTO movimiento_inventario (movimiento_inventario_cantidad, movimiento_inventario_estado, material_sku,
             bodega_id_bodega, lote_id_lote, usuario_id_usuario, movimiento_inventario_tipo_movimiento_id_tipo_movimiento,
             movimiento_inventario_motivo_movimiento_id_motivo_movimiento, movimiento_inventario_descripcion_motivo,
             movimiento_inventario_referencia_origen)
           VALUES ($1, 'completado', $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING movimiento_inventario_id_movimiento AS id`,
          [cantidad, sku, bodegaId, loteId, req.user.id, d.diferencia < 0 ? tipoSalida : tipoEntrada, motivoId,
           `Ajuste por el conteo #${id}: ${motivo}`, referencia]
        );
        hechos.push({ sku, nombre: d.nombre, diferencia: d.diferencia, movimiento_id: Number(mov[0].id) });
      }

      // CU-57: las alertas por diferencia de este conteo y estos SKU quedan resueltas por quien aprueba
      const { rows: alertas } = await q(
        `UPDATE alerta_inventario SET alerta_inventario_estado = 'resuelta'
         WHERE conteo_ciclico_id_conteo = $1 AND material_sku = ANY($2::text[]) AND alerta_inventario_estado = 'activa'
         RETURNING historial_alerta_id_historial AS hist`,
        [id, skus]
      );
      const hists = alertas.map(a => a.hist).filter(Boolean);
      if (hists.length) {
        await q(
          `UPDATE historial_alerta SET historial_alerta_fecha_hora_resolucion = now(), usuario_id_usuario = $2
           WHERE historial_alerta_id_historial = ANY($1::bigint[])`,
          [hists, req.user.id]
        );
      }
      return { conteo, hechos, alertas: alertas.length };
    });

    await auditoria.registrar(req.user.id, 'Ajuste por conteo',
      `Conteo #${id} (${r.conteo.bodega}): ${r.hechos.map(h => `${h.sku} ${h.diferencia > 0 ? '+' : ''}${fmt(h.diferencia)}`).join(', ')} · ${motivo}`);
    generarAlertasAutomaticas().catch(e => console.warn('Alertas:', e.message));
    res.status(201).json({
      message: `Ajuste aprobado: ${r.hechos.length} producto(s) ajustado(s) en ${r.conteo.bodega}` +
               (r.alertas ? ` y ${r.alertas} alerta(s) de diferencia resuelta(s).` : '.'),
      ajustes: r.hechos,
    });
  } catch (err) {
    responderError(res, err, 'Error ajustando el stock del conteo:');
  }
}

module.exports = { preparar, crear, listar, obtener, diferencias, procesar, obtenerTolerancias, actualizarTolerancias, generarAlertas, ajustar };
