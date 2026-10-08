const { query } = require('../db/pool');
const { ErrorNegocio, conTransaccion, responderError } = require('../db/tx');
const auditoria = require('./auditoriaController');

/**
 * Recetas / plantillas por tipo de puerta (OPUS-19, Req #7; módulo en CU-102, D37).
 *
 * Una receta ES una fila de producto_terminado mas sus materiales en
 * material_producto_terminado. Son la plantilla de insumos: la OT la carga como
 * consumo estimado y se ajusta a mano desde ahí.
 *
 * CU-102 (D37):
 *  - Versiones = DUPLICAR una receta. Con "reemplaza", la original queda inactiva y
 *    apunta a la nueva (producto_terminado_reemplazada_por). No se borran recetas:
 *    se desactivan (otros módulos las referencian con FK blandas).
 *  - Edición: libre para gerencia y jop durante 24 h desde la creación; después solo
 *    gerencia y con motivo. Editar NO reinicia el plazo.
 *  - Cada insumo tiene un ÁREA obligatoria (R1, cambia D37): la OT carga solo los de su área.
 *    Sin área, un insumo se cargaría en todas las OT de la puerta y se descontaría varias veces.
 *
 * MERMA: material_producto_terminado_merma_estimada se interpreta como FRACCION
 * (0.2 = 20%), que es como estan cargados los datos. La cantidad que se lleva a la
 * OT es cantidad * (1 + merma).
 */

const HORAS_EDICION_LIBRE = 24;

/**
 * Materiales de una receta, con la cantidad ya ajustada por merma.
 * $2 = área: undefined/null trae todos; un id trae solo los de esa área (R1).
 * es_pintura: en la OT su consumo real sale del seguimiento de pinturas, no de "Guardar".
 */
const SQL_MATERIALES = `
  SELECT
    mpt.material_sku                                    AS sku,
    m.material_nombre_material                          AS nombre,
    m.material_estado                                   AS estado_material,
    m.material_material_critico                         AS es_critico,
    um.material_unidad_medida_nombre                    AS unidad,
    mpt.material_producto_terminado_cantidad_estimada   AS cantidad_base,
    COALESCE(mpt.material_producto_terminado_merma_estimada, 0) AS merma,
    ROUND(
      COALESCE(mpt.material_producto_terminado_cantidad_estimada, 0)
      * (1 + COALESCE(mpt.material_producto_terminado_merma_estimada, 0))
    , 4)                                                AS cantidad_con_merma,
    mpt.area_trabajo_id_area                            AS area_id,
    at.area_trabajo_nombre_area                         AS area,
    (m.es_material_pintura_custom IS TRUE OR m.es_material_pintura_no_custom IS TRUE) AS es_pintura
  FROM material_producto_terminado mpt
  JOIN material m ON m.material_sku = mpt.material_sku
  LEFT JOIN material_unidad_medida um
         ON um.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
  LEFT JOIN area_trabajo at ON at.area_trabajo_id_area = mpt.area_trabajo_id_area
  WHERE mpt.producto_terminado_id_producto = $1
    AND ($2::bigint IS NULL OR mpt.area_trabajo_id_area = $2::bigint)
  ORDER BY m.material_nombre_material`;

const materialesDe = (db, id, areaId = null) => db.query(SQL_MATERIALES, [id, areaId]).then(r => r.rows);

/** Cabecera de la receta con lo que necesita la vista para decidir qué ofrecer. */
const SQL_CABECERA = `
  SELECT pt.producto_terminado_id_producto     AS id,
         pt.producto_terminado_codigo_producto AS codigo,
         pt.producto_terminado_nombre_producto AS nombre,
         pt.producto_terminado_tipo_producto   AS tipo,
         pt.producto_terminado_activo          AS activo,
         pt.producto_terminado_fecha_creacion  AS fecha_creacion,
         pt.producto_terminado_fecha_creacion + make_interval(hours => ${HORAS_EDICION_LIBRE}) AS edicion_libre_hasta,
         now() < pt.producto_terminado_fecha_creacion + make_interval(hours => ${HORAS_EDICION_LIBRE}) AS en_plazo,
         pt.producto_terminado_reemplazada_por AS reemplazada_por_id,
         rp.producto_terminado_nombre_producto AS reemplazada_por_nombre
  FROM producto_terminado pt
  LEFT JOIN producto_terminado rp ON rp.producto_terminado_id_producto = pt.producto_terminado_reemplazada_por`;

/**
 * GET /api/recetas
 * Recetas activas con su cantidad de materiales. ?incluir_inactivos=true suma las inactivas.
 */
async function listar(req, res) {
  const incluirInactivos = ['true', '1'].includes(String(req.query.incluir_inactivos).toLowerCase());
  try {
    const { rows } = await query(
      `SELECT c.*, COALESCE(r.materiales, 0) AS total_materiales, r.total_unidades
       FROM (${SQL_CABECERA}) c
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS materiales,
                SUM(COALESCE(mpt.material_producto_terminado_cantidad_estimada, 0)
                    * (1 + COALESCE(mpt.material_producto_terminado_merma_estimada, 0))) AS total_unidades
         FROM material_producto_terminado mpt
         WHERE mpt.producto_terminado_id_producto = c.id
       ) r ON TRUE
       WHERE ($1::boolean IS TRUE OR c.activo = TRUE)
       ORDER BY c.activo DESC, c.nombre`,
      [incluirInactivos]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listando recetas:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/** Carga la cabecera del producto; lanza 404 si no existe. Con `bloquear`, FOR UPDATE. */
async function cargarProducto(id, client = null, bloquear = false) {
  const ejecutar = client ? client.query.bind(client) : query;
  if (bloquear) {
    await ejecutar(`SELECT 1 FROM producto_terminado WHERE producto_terminado_id_producto = $1 FOR UPDATE`, [id]);
  }
  const { rows } = await ejecutar(`${SQL_CABECERA} WHERE pt.producto_terminado_id_producto = $1`, [id]);
  if (rows.length === 0) throw new ErrorNegocio(404, { error: 'Receta no encontrada' });
  return rows[0];
}

/**
 * GET /api/recetas/:id[?area_id=]
 * Receta completa: cabecera + materiales con cantidad base, merma, área y cantidad final.
 * Con area_id (la OT que elige la receta a mano) solo los de esa área más los sin área.
 */
async function obtener(req, res) {
  const { id } = req.params;
  const areaId = req.query.area_id == null || req.query.area_id === '' ? null : String(req.query.area_id);
  if (!/^\d+$/.test(String(id)) || (areaId != null && !/^\d+$/.test(areaId))) {
    return res.status(400).json({ error: 'El id de la receta y el área deben ser numéricos' });
  }
  try {
    const producto = await cargarProducto(id);
    const materiales = await materialesDe({ query }, id, areaId);
    // Versiones anteriores: las recetas que esta reemplazó
    const { rows: reemplaza } = await query(
      `SELECT producto_terminado_id_producto AS id, producto_terminado_nombre_producto AS nombre
       FROM producto_terminado WHERE producto_terminado_reemplazada_por = $1 ORDER BY 1`,
      [id]
    );
    res.json({ producto, materiales, total_materiales: materiales.length, reemplaza_a: reemplaza });
  } catch (err) {
    responderError(res, err, 'Error obteniendo receta:');
  }
}

const MAX_PUERTAS = 1000;

/**
 * GET /api/recetas/por-orden/:otId[?receta_id=&puertas=]
 * Receta que se precarga en la pestaña Consumo de la OT (R1). Solo lee.
 *   1. ?receta_id: la que el usuario buscó ("Buscar otra").
 *   2. La receta ya guardada en la OT.
 *   3. La cadena OT -> especificacion_puerta -> producto_terminado.
 * Si no hay receta devuelve 200 con `motivo_sin_receta` en vez de un error: la vista
 * necesita distinguir "esta OT no tiene producto" de "el endpoint fallo".
 * Solo trae los insumos del área de la OT, con la cantidad para `puertas` puertas:
 * cantidad * (1 + merma) * puertas.
 */
async function recetaPorOrden(req, res) {
  const { otId } = req.params;
  const recetaPedida = req.query.receta_id == null || req.query.receta_id === '' ? null : String(req.query.receta_id);
  const puertasPedidas = req.query.puertas == null || req.query.puertas === '' ? null : String(req.query.puertas);
  if (!/^\d+$/.test(String(otId)) || (recetaPedida != null && !/^\d+$/.test(recetaPedida))) {
    return res.status(400).json({ error: 'El id de la orden de trabajo y el de la receta deben ser numéricos' });
  }
  if (puertasPedidas != null && (!/^\d+$/.test(puertasPedidas) || +puertasPedidas < 1 || +puertasPedidas > MAX_PUERTAS)) {
    return res.status(400).json({ error: `La cantidad de puertas debe ser un número entero entre 1 y ${MAX_PUERTAS}.` });
  }
  try {
    const { rows: ot } = await query(
      `SELECT ot.orden_trabajo_id_orden AS id,
              ot.orden_trabajo_estado   AS estado,
              ot.area_trabajo_id_area   AS area_id,
              a.area_trabajo_nombre_area AS area,
              ot.producto_terminado_id_producto AS receta_id,
              ot.orden_trabajo_cantidad_puertas AS cantidad_puertas,
              ot.especificaciones_puerta_id_especificacion_puerta AS especificacion_id,
              esp.modelo_puerta         AS modelo,
              esp.producto_terminado_id AS producto_id
       FROM orden_trabajo ot
       LEFT JOIN area_trabajo a ON a.area_trabajo_id_area = ot.area_trabajo_id_area
       LEFT JOIN terreno.especificacion_puerta esp
              ON esp.id_especificacion_puerta = ot.especificaciones_puerta_id_especificacion_puerta
       WHERE ot.orden_trabajo_id_orden = $1`,
      [otId]
    );
    if (ot.length === 0) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });

    const orden = ot[0];
    const puertas = Number(puertasPedidas ?? orden.cantidad_puertas ?? 1);
    const base = {
      orden: { id: orden.id, estado: orden.estado, modelo: orden.modelo, area_id: orden.area_id, area: orden.area,
               receta_id: orden.receta_id, cantidad_puertas: orden.cantidad_puertas },
      puertas,
    };

    let recetaId, origen;
    if (recetaPedida) { recetaId = recetaPedida; origen = 'elegida'; }
    else if (orden.receta_id) { recetaId = orden.receta_id; origen = 'ot'; }
    else if (!orden.especificacion_id) {
      return res.json({
        ...base, producto: null, materiales: [], origen: null,
        motivo_sin_receta: 'La orden de trabajo no tiene una especificación de puerta asociada. Busque la receta.'
      });
    } else if (!orden.producto_id) {
      return res.json({
        ...base, producto: null, materiales: [], origen: null,
        motivo_sin_receta: `La especificación #${orden.especificacion_id}` +
          `${orden.modelo ? ` (${orden.modelo})` : ''} no tiene un producto terminado asignado. Busque la receta.`
      });
    } else { recetaId = orden.producto_id; origen = 'especificacion'; }

    const producto = await cargarProducto(recetaId);
    if (!producto.activo) {
      return res.json({
        ...base, producto, materiales: [], origen,
        motivo_sin_receta: `La receta "${producto.nombre}" está inactiva` +
          (producto.reemplazada_por_nombre ? ` (reemplazada por "${producto.reemplazada_por_nombre}").` : '.') +
          ' Elija otra receta.'
      });
    }
    const materiales = (await materialesDe({ query }, recetaId, orden.area_id)).map(m => ({
      ...m, cantidad_total: Math.round(parseFloat(m.cantidad_con_merma) * puertas * 10000) / 10000,
    }));
    if (materiales.length === 0) {
      return res.json({
        ...base, producto, materiales: [], origen,
        motivo_sin_receta: `La receta "${producto.nombre}" no tiene materiales para el área de esta orden de trabajo` +
          (orden.area ? ` (${orden.area}).` : '.')
      });
    }
    res.json({ ...base, producto, materiales, origen, motivo_sin_receta: null });
  } catch (err) {
    responderError(res, err, 'Error resolviendo la receta de la OT:');
  }
}

/* ══════════════════════════════════════════════════════════════════════
   CU-102: validaciones compartidas por crear y editar
   ══════════════════════════════════════════════════════════════════════ */

/** Un insumo de la receta quedó igual que el guardado (misma cantidad, merma y área). */
const sinCambios = (i, a) => !!a && Math.abs(i.cantidad - a.cantidad) < 1e-9
  && Math.abs(i.merma - a.merma) < 1e-9 && String(i.areaId) === String(a.areaId);

/**
 * Valida el lote COMPLETO antes de escribir (lección de OPUS-4): o se guarda todo o
 * nada. Devuelve [{ sku, cantidad, merma, areaId }] o lanza 400 con todos los errores.
 *  - Exc 1: el SKU existe, está activo y no es herramienta (una herramienta no se consume).
 *  - Exc 3: cantidad > 0 (el CHECK de la BD permite 0). Merma: fracción entre 0 y 1.
 *  - Sin repetidos; área de producción activa y obligatoria (R1).
 *  - Sesión 15: `actuales` (Map sku → { cantidad, merma, areaId } de la receta guardada)
 *    permite CONSERVAR un material inactivo que ya estaba, sin cambios; igual que la OT
 *    (R1). Agregarlo o modificarlo se rechaza.
 */
async function validarMateriales(client, materiales, actuales = new Map()) {
  if (!Array.isArray(materiales) || materiales.length === 0) {
    throw new ErrorNegocio(400, { error: 'La receta debe tener al menos un insumo.' });
  }
  const errores = [];
  const vistos  = new Set();
  const items   = [];

  materiales.forEach((item, i) => {
    const fila     = i + 1;
    const sku      = String(item?.sku || '').trim();
    const cantidad = parseFloat(item?.cantidad_base);
    const merma    = item?.merma == null || item.merma === '' ? 0 : parseFloat(item.merma);
    const areaTxt  = item?.area_id == null || item.area_id === '' ? null : String(item.area_id);

    if (!sku) { errores.push({ fila, sku: null, campo: 'sku', error: 'Falta el producto' }); return; }
    if (isNaN(cantidad) || cantidad <= 0) {
      errores.push({ fila, sku, campo: 'cantidad_base', error: 'La cantidad debe ser mayor que cero' });
      return;
    }
    if (isNaN(merma) || merma < 0) {
      errores.push({ fila, sku, campo: 'merma', error: 'La merma debe ser un número mayor o igual a cero' });
      return;
    }
    // La merma es una FRACCION: 0.2 = 20%. Un 20 aqui multiplicaria la cantidad por 21.
    if (merma >= 1) {
      errores.push({ fila, sku, campo: 'merma', error: 'La merma se expresa como fracción (0.2 = 20%), debe ser menor que 1' });
      return;
    }
    // R1: el área es obligatoria (un insumo sin área se descontaría en todas las OT de la puerta)
    if (areaTxt == null) {
      errores.push({ fila, sku, campo: 'area_id', error: 'Indique el área donde se consume el insumo' });
      return;
    }
    if (!/^\d+$/.test(areaTxt)) {
      errores.push({ fila, sku, campo: 'area_id', error: 'El área no es válida' });
      return;
    }
    if (vistos.has(sku)) {
      errores.push({ fila, sku, campo: 'sku', error: 'El producto viene repetido en la receta' });
      return;
    }
    vistos.add(sku);
    items.push({ fila, sku, cantidad, merma, areaId: areaTxt });
  });

  if (items.length > 0) {
    const { rows: mats } = await client.query(
      `SELECT material_sku AS sku, material_estado AS estado, material_es_herramienta AS herramienta
       FROM material WHERE material_sku = ANY($1::text[])`,
      [items.map(i => i.sku)]
    );
    const porSku = new Map(mats.map(m => [m.sku, m]));
    const areasPedidas = [...new Set(items.map(i => i.areaId).filter(Boolean))];
    const { rows: areas } = areasPedidas.length
      ? await client.query(
          `SELECT area_trabajo_id_area::text AS id FROM area_trabajo
           WHERE area_trabajo_id_area = ANY($1::bigint[])
             AND area_trabajo_activo IS NOT FALSE
             -- CU-120 (D44): los insumos de instalación viajan con el pedido, no los consume una OT
             AND area_trabajo_clasificacion IN ('produccion', 'instalacion')`,
          [areasPedidas])
      : { rows: [] };
    const areasValidas = new Set(areas.map(a => a.id));

    for (const i of items) {
      const m = porSku.get(i.sku);
      if (!m) {
        errores.push({ fila: i.fila, sku: i.sku, campo: 'sku', error: 'El SKU no existe en el catálogo' });
      } else if (m.estado !== 'activo' && !sinCambios(i, actuales.get(i.sku))) {
        errores.push({ fila: i.fila, sku: i.sku, campo: 'sku',
          error: actuales.has(i.sku)
            ? 'El producto está inactivo: puede quedar como estaba, pero no modificarse. Para cambiarlo, reemplácelo'
            : 'El producto está inactivo o dado de baja: no se puede agregar' });
      } else if (m.herramienta === true) {
        errores.push({ fila: i.fila, sku: i.sku, campo: 'sku', error: 'Es una herramienta: no se consume en una receta' });
      }
      if (i.areaId && !areasValidas.has(i.areaId)) {
        errores.push({ fila: i.fila, sku: i.sku, campo: 'area_id', error: 'El área no es un área activa de producción o de instalación' });
      }
    }
  }

  if (errores.length > 0) {
    throw new ErrorNegocio(400, {
      error: errores.length === 1
        ? `No se guardó nada: ${errores[0].sku ?? 'fila ' + errores[0].fila} — ${errores[0].error}.`
        : `No se guardó nada: ${errores.length} insumo(s) de la receta tienen problemas.`,
      errores,
    });
  }
  return items;
}

/**
 * Nombre (máx. 200) y código (máx. 80) obligatorios. El código identifica el tipo de
 * puerta de forma estable: se guarda en MAYÚSCULAS y es único sin distinguir
 * mayúsculas (D37). Lanza 400/409.
 */
async function validarCabecera(client, { nombre, codigo }, excluirId = null) {
  const n = String(nombre ?? '').trim();
  const c = String(codigo ?? '').trim().toUpperCase();
  if (!n) throw new ErrorNegocio(400, { error: 'El nombre de la receta es obligatorio.', campo: 'nombre' });
  if (n.length > 200) throw new ErrorNegocio(400, { error: 'El nombre no puede superar 200 caracteres.', campo: 'nombre' });
  if (!c) throw new ErrorNegocio(400, { error: 'El código de la receta es obligatorio.', campo: 'codigo' });
  if (c.length > 80) throw new ErrorNegocio(400, { error: 'El código no puede superar 80 caracteres.', campo: 'codigo' });
  {
    const { rows } = await client.query(
      `SELECT 1 FROM producto_terminado
       WHERE LOWER(producto_terminado_codigo_producto) = LOWER($1)
         AND ($2::bigint IS NULL OR producto_terminado_id_producto <> $2::bigint)`,
      [c, excluirId]
    );
    if (rows.length) throw new ErrorNegocio(409, { error: `Ya existe una receta con el código "${c}".`, campo: 'codigo' });
  }
  return { nombre: n, codigo: c };
}

async function insertarMateriales(client, id, items) {
  for (const { sku, cantidad, merma, areaId } of items) {
    await client.query(
      `INSERT INTO material_producto_terminado
         (material_sku, producto_terminado_id_producto,
          material_producto_terminado_cantidad_estimada,
          material_producto_terminado_merma_estimada, area_trabajo_id_area)
       VALUES ($1, $2, $3, $4, $5)`,
      [sku, id, cantidad, merma, areaId]
    );
  }
}

/**
 * POST /api/recetas — CU-102, gerencia y jop.
 * Body: { nombre, codigo?, tipo?, materiales: [{ sku, cantidad_base, merma?, area_id? }] }
 */
async function crear(req, res) {
  const { tipo, materiales } = req.body || {};
  try {
    const r = await conTransaccion(async (client) => {
      const cab   = await validarCabecera(client, req.body || {});
      const items = await validarMateriales(client, materiales);
      const { rows } = await client.query(
        `INSERT INTO producto_terminado (producto_terminado_nombre_producto, producto_terminado_codigo_producto,
                                         producto_terminado_tipo_producto, producto_terminado_activo)
         VALUES ($1, $2, $3, TRUE) RETURNING producto_terminado_id_producto AS id`,
        [cab.nombre, cab.codigo, tipo ? String(tipo).trim() : null]
      );
      await insertarMateriales(client, rows[0].id, items);
      return { id: rows[0].id, nombre: cab.nombre, insumos: items.length };
    });

    await auditoria.registrar(req.user?.id, 'crear_receta', `Receta #${r.id} ${r.nombre}: ${r.insumos} insumo(s)`);
    res.status(201).json({ message: `Receta "${r.nombre}" creada con ${r.insumos} insumo(s).`, id: r.id });
  } catch (err) {
    responderError(res, err, 'Error creando receta:');
  }
}

/**
 * PUT /api/recetas/:id — gerencia y jop (CU-102, D37).
 * Reemplaza la lista de materiales y, si vienen, el nombre, código y tipo (patrón
 * de presencia: un campo omitido se conserva).
 * Regla de edición: dentro de las 24 h desde la creación, gerencia y jop; después
 * solo gerencia y con `motivo`. Editar no cambia la fecha de creación. Una receta
 * inactiva no se edita: se reactiva o se duplica.
 * Body: { materiales, nombre?, codigo?, tipo?, motivo? }
 */
async function actualizar(req, res) {
  const { id } = req.params;
  const body = req.body || {};
  const motivo = String(body.motivo ?? '').trim();

  if (!/^\d+$/.test(String(id))) {
    return res.status(400).json({ error: 'El id de la receta debe ser numérico' });
  }

  try {
    const r = await conTransaccion(async (client) => {
      const producto = await cargarProducto(id, client, true);

      if (!producto.activo) {
        throw new ErrorNegocio(400, { error: 'La receta está inactiva: reactívela o duplíquela para modificarla.' });
      }
      if (!producto.en_plazo) {
        if (req.user?.rol !== 'gerencia') {
          throw new ErrorNegocio(403, {
            error: `Pasaron más de ${HORAS_EDICION_LIBRE} horas desde que se creó la receta: solo gerencia puede editarla. ` +
                   'Si el proceso cambió, duplíquela como nueva versión.',
            codigo: 'FUERA_DE_PLAZO',
          });
        }
        if (!motivo) {
          throw new ErrorNegocio(400, {
            error: `La receta tiene más de ${HORAS_EDICION_LIBRE} horas: indique el motivo de la corrección.`,
            campo: 'motivo', codigo: 'MOTIVO_REQUERIDO',
          });
        }
      }

      /* ── Fase 1: validar todo antes de tocar la tabla ── */
      const { rows: guardados } = await client.query(
        `SELECT material_sku AS sku, material_producto_terminado_cantidad_estimada::float AS cantidad,
                COALESCE(material_producto_terminado_merma_estimada, 0)::float AS merma, area_trabajo_id_area AS area
         FROM material_producto_terminado WHERE producto_terminado_id_producto = $1`, [id]
      );
      const actuales = new Map(guardados.map(g => [g.sku, { cantidad: g.cantidad, merma: g.merma, areaId: g.area }]));
      const items = await validarMateriales(client, body.materiales, actuales);
      const cambiaCabecera = 'nombre' in body || 'codigo' in body || 'tipo' in body;
      const cab = cambiaCabecera
        ? await validarCabecera(client, {
            nombre: 'nombre' in body ? body.nombre : producto.nombre,
            codigo: 'codigo' in body ? body.codigo : producto.codigo,
          }, id)
        : null;

      /* ── Fase 2: reemplazar la receta ── */
      if (cab) {
        await client.query(
          `UPDATE producto_terminado
           SET producto_terminado_nombre_producto = $2, producto_terminado_codigo_producto = $3,
               producto_terminado_tipo_producto = $4
           WHERE producto_terminado_id_producto = $1`,
          [id, cab.nombre, cab.codigo, 'tipo' in body ? (String(body.tipo ?? '').trim() || null) : producto.tipo]
        );
      }
      await client.query(`DELETE FROM material_producto_terminado WHERE producto_terminado_id_producto = $1`, [id]);
      await insertarMateriales(client, id, items);
      return { producto, guardados: items.length, fueraDePlazo: !producto.en_plazo };
    });

    await auditoria.registrar(req.user?.id, 'editar_receta',
      `Receta #${id} ${r.producto.codigo || r.producto.nombre}: ${r.guardados} insumo(s)` +
      (r.fueraDePlazo ? `. Motivo: ${motivo}` : ''));

    res.json({
      message: `Receta actualizada con ${r.guardados} insumo(s).`,
      producto: await cargarProducto(id),
      materiales: await materialesDe({ query }, id),
    });
  } catch (err) {
    responderError(res, err, 'Error actualizando receta:');
  }
}

/**
 * Siguiente versión libre para duplicar (D37): <base>-V<n> y "<nombre> v<n>".
 * Si el código ya termina en -V<n> se sigue esa numeración; si no, empieza en V2.
 * Se revisan TODAS las recetas (activas e inactivas) y se sube el número hasta
 * encontrar un código libre.
 */
async function sugerencia(db, original) {
  const matchCod = /^(.*)-V(\d+)$/i.exec(original.codigo || '');
  const baseCod = matchCod ? matchCod[1] : (original.codigo || `RECETA-${original.id}`);
  let n = matchCod ? parseInt(matchCod[2], 10) + 1 : 2;
  const { rows } = await db.query(
    `SELECT UPPER(producto_terminado_codigo_producto) AS codigo FROM producto_terminado
     WHERE UPPER(producto_terminado_codigo_producto) LIKE UPPER($1) || '-V%'`,
    [baseCod]
  );
  const ocupados = new Set(rows.map(r => r.codigo));
  while (ocupados.has(`${baseCod}-V${n}`.toUpperCase())) n++;
  // "Puerta ABC v2" o "Puerta ABC (v2)" → "Puerta ABC"
  const baseNom = String(original.nombre || '').replace(/\s*\(?v\d+\)?$/i, '').trim();
  return { codigo: `${baseCod}-V${n}`.toUpperCase(), nombre: `${baseNom} v${n}` };
}

/** GET /api/recetas/:id/sugerencia-duplicado — { codigo, nombre } para el diálogo de duplicar. */
async function sugerenciaDuplicado(req, res) {
  const { id } = req.params;
  if (!/^\d+$/.test(String(id))) {
    return res.status(400).json({ error: 'El id de la receta debe ser numérico' });
  }
  try {
    const original = await cargarProducto(id);
    res.json(await sugerencia({ query }, original));
  } catch (err) {
    responderError(res, err, 'Error sugiriendo código de duplicado:');
  }
}

/**
 * POST /api/recetas/:id/duplicar — CU-102 Exc 2 ("nueva versión conservando la anterior").
 * Copia la cabecera y los insumos (con su área) en una receta nueva, con fecha de hoy.
 * Con `reemplaza: true`, la original queda inactiva y apunta a la nueva.
 * Body: { codigo, nombre?, reemplaza? } — el código es obligatorio; la vista propone el de
 * GET /recetas/:id/sugerencia-duplicado.
 */
async function duplicar(req, res) {
  const { id } = req.params;
  const body = req.body || {};
  const reemplaza = body.reemplaza === true;

  if (!/^\d+$/.test(String(id))) {
    return res.status(400).json({ error: 'El id de la receta debe ser numérico' });
  }

  try {
    const r = await conTransaccion(async (client) => {
      const original = await cargarProducto(id, client, true);
      if (reemplaza && !original.activo) {
        throw new ErrorNegocio(400, { error: 'La receta original ya está inactiva: no se puede reemplazar.' });
      }
      const cab = await validarCabecera(client, {
        nombre: body.nombre ?? (await sugerencia(client, original)).nombre,
        codigo: body.codigo,
      });

      const { rows } = await client.query(
        `INSERT INTO producto_terminado (producto_terminado_nombre_producto, producto_terminado_codigo_producto,
           producto_terminado_tipo_producto, producto_terminado_requerimientos_certificacion,
           producto_terminado_requerimientos_medidas, producto_terminado_requerimientos_produccion,
           producto_terminado_requerimientos_instalacion, producto_terminado_activo)
         SELECT $2, $3, producto_terminado_tipo_producto, producto_terminado_requerimientos_certificacion,
                producto_terminado_requerimientos_medidas, producto_terminado_requerimientos_produccion,
                producto_terminado_requerimientos_instalacion, TRUE
         FROM producto_terminado WHERE producto_terminado_id_producto = $1
         RETURNING producto_terminado_id_producto AS id`,
        [id, cab.nombre, cab.codigo]
      );
      const nuevo = rows[0].id;
      const { rowCount } = await client.query(
        `INSERT INTO material_producto_terminado
           (material_sku, producto_terminado_id_producto, material_producto_terminado_cantidad_estimada,
            material_producto_terminado_merma_estimada, area_trabajo_id_area)
         SELECT material_sku, $2, material_producto_terminado_cantidad_estimada,
                material_producto_terminado_merma_estimada, area_trabajo_id_area
         FROM material_producto_terminado WHERE producto_terminado_id_producto = $1`,
        [id, nuevo]
      );
      if (reemplaza) {
        await client.query(
          `UPDATE producto_terminado SET producto_terminado_activo = FALSE, producto_terminado_reemplazada_por = $2
           WHERE producto_terminado_id_producto = $1`,
          [id, nuevo]
        );
      }
      return { original, nuevo, nombre: cab.nombre, insumos: rowCount };
    });

    await auditoria.registrar(req.user?.id, 'duplicar_receta',
      `Receta #${id} → #${r.nuevo} ${r.nombre}` + (reemplaza ? ' (reemplaza a la original)' : ''));

    res.status(201).json({
      message: `Receta "${r.nombre}" creada a partir de "${r.original.nombre}" con ${r.insumos} insumo(s).` +
               (reemplaza ? ' La original quedó inactiva.' : ''),
      id: r.nuevo,
    });
  } catch (err) {
    responderError(res, err, 'Error duplicando receta:');
  }
}

/**
 * PUT /api/recetas/:id/estado — CU-102: desactivar (ya no se vende) o reactivar.
 * No se borran recetas. Reactivar quita el "reemplazada por": vuelve a ofrecerse.
 * Body: { activo: boolean }
 */
async function cambiarEstado(req, res) {
  const { id } = req.params;
  const activo = req.body?.activo;
  if (!/^\d+$/.test(String(id))) {
    return res.status(400).json({ error: 'El id de la receta debe ser numérico' });
  }
  if (typeof activo !== 'boolean') {
    return res.status(400).json({ error: 'Indique si la receta queda activa o inactiva.' });
  }
  try {
    const r = await conTransaccion(async (client) => {
      const producto = await cargarProducto(id, client, true);
      if (producto.activo === activo) {
        throw new ErrorNegocio(400, { error: activo ? 'La receta ya está activa.' : 'La receta ya está inactiva.' });
      }
      await client.query(
        `UPDATE producto_terminado
         SET producto_terminado_activo = $2,
             producto_terminado_reemplazada_por = CASE WHEN $2 THEN NULL ELSE producto_terminado_reemplazada_por END
         WHERE producto_terminado_id_producto = $1`,
        [id, activo]
      );
      return producto;
    });
    await auditoria.registrar(req.user?.id, activo ? 'reactivar_receta' : 'desactivar_receta', `Receta #${id} ${r.nombre}`);
    res.json({ message: activo ? `Receta "${r.nombre}" reactivada.` : `Receta "${r.nombre}" desactivada.` });
  } catch (err) {
    responderError(res, err, 'Error cambiando el estado de la receta:');
  }
}

/**
 * POST /api/recetas/:id/cargar-en-ot/:otId?modo=faltantes|reemplazar
 * Carga la receta como consumos ESTIMADOS de la OT.
 *
 * modo=faltantes (default): solo agrega los materiales que la OT todavia no tiene.
 *   Es el no destructivo — no pisa un estimado que alguien ajusto a mano.
 * modo=reemplazar: sobrescribe el estimado de todos los materiales de la receta.
 *   Los materiales de la OT que NO estan en la receta no se tocan en ningun modo.
 * CU-102: solo recetas activas, y solo los insumos del área de la OT más los sin área.
 */
async function cargarEnOT(req, res) {
  const { id, otId } = req.params;
  const modo = String(req.query.modo || 'faltantes').toLowerCase();

  if (!/^\d+$/.test(String(id)) || !/^\d+$/.test(String(otId))) {
    return res.status(400).json({ error: 'Los identificadores deben ser numéricos' });
  }
  if (!['faltantes', 'reemplazar'].includes(modo)) {
    return res.status(400).json({ error: "El modo debe ser 'faltantes' o 'reemplazar'" });
  }

  try {
    const r = await conTransaccion(async (client) => {
      const producto = await cargarProducto(id, client);
      if (!producto.activo) {
        throw new ErrorNegocio(400, {
          error: `La receta "${producto.nombre}" está inactiva` +
                 (producto.reemplazada_por_nombre ? ` (reemplazada por "${producto.reemplazada_por_nombre}")` : '') + '.',
        });
      }

      const { rows: ot } = await client.query(
        `SELECT orden_trabajo_estado AS estado, area_trabajo_id_area AS area_id
         FROM orden_trabajo WHERE orden_trabajo_id_orden = $1`,
        [otId]
      );
      if (ot.length === 0) throw new ErrorNegocio(404, { error: 'Orden de trabajo no encontrada' });
      if (['finalizada', 'completada', 'cerrada', 'cancelada'].includes(String(ot[0].estado).toLowerCase())) {
        throw new ErrorNegocio(400, { error: 'No se pueden cargar estimaciones en una orden cerrada o cancelada' });
      }

      const receta = await materialesDe(client, id, ot[0].area_id);
      if (receta.length === 0) {
        throw new ErrorNegocio(400, {
          error: `El producto "${producto.nombre}" no tiene materiales cargados en su receta para el área de esta OT`
        });
      }

      const resultados = [];
      let agregados = 0, actualizados = 0, omitidos = 0;

      for (const m of receta) {
        const cantidad = parseFloat(m.cantidad_con_merma);

        const { rows: previo } = await client.query(
          `SELECT material_orden_trabajo_consumo_estimado AS estimado
           FROM material_orden_trabajo
           WHERE material_sku = $1 AND orden_trabajo_id_orden = $2
           FOR UPDATE`,
          [m.sku, otId]
        );
        const existia = previo.length > 0 && previo[0].estimado != null;

        if (existia && modo === 'faltantes') {
          omitidos++;
          resultados.push({
            sku: m.sku, nombre: m.nombre, resultado: 'omitido',
            cantidad: parseFloat(previo[0].estimado),   // lo que la OT ya tenia
            cantidad_receta: cantidad,                  // lo que la receta habria puesto
            anterior: parseFloat(previo[0].estimado),
            motivo: 'La OT ya tenía un estimado para este material'
          });
          continue;
        }

        await client.query(
          `INSERT INTO material_orden_trabajo
             (material_sku, orden_trabajo_id_orden, material_orden_trabajo_consumo_estimado)
           VALUES ($1, $2, $3)
           ON CONFLICT (material_sku, orden_trabajo_id_orden)
           DO UPDATE SET material_orden_trabajo_consumo_estimado = EXCLUDED.material_orden_trabajo_consumo_estimado`,
          [m.sku, otId, cantidad]
        );

        if (existia) { actualizados++; } else { agregados++; }
        resultados.push({
          sku: m.sku, nombre: m.nombre,
          resultado: existia ? 'actualizado' : 'agregado',
          cantidad,
          cantidad_base: parseFloat(m.cantidad_base),
          merma: parseFloat(m.merma),
          anterior: existia ? parseFloat(previo[0].estimado) : null
        });
      }

      return { producto, resultados, agregados, actualizados, omitidos };
    });

    await auditoria.registrar(req.user?.id, 'cargar_receta_en_ot',
      `OT #${otId} ← receta ${r.producto.codigo || r.producto.nombre} (modo ${modo}): ` +
      `${r.agregados} agregado(s), ${r.actualizados} actualizado(s), ${r.omitidos} omitido(s)`);

    res.json({
      message: `Receta "${r.producto.nombre}" cargada: ${r.agregados} agregado(s), ` +
               `${r.actualizados} actualizado(s), ${r.omitidos} omitido(s).`,
      modo,
      producto: r.producto,
      agregados: r.agregados,
      actualizados: r.actualizados,
      omitidos: r.omitidos,
      resultados: r.resultados
    });
  } catch (err) {
    responderError(res, err, 'Error cargando receta en la OT:');
  }
}

module.exports = { listar, obtener, recetaPorOrden, crear, actualizar, duplicar, sugerenciaDuplicado, cambiarEstado, cargarEnOT };
