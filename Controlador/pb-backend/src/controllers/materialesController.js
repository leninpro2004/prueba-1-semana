const { query } = require('../db/pool');
const { ocultaMontos } = require('../middleware/auth');
const { ErrorNegocio, conTransaccion, responderError } = require('../db/tx');
const auditoria = require('./auditoriaController');
const { generarCodigoInterno } = require('../db/codigos');
const { consultarEntregas, resumirEntregas } = require('../db/entregas');
const { TIPOS_RETIRO } = require('./alertasController');

const PRESENTACION_MAX = 150;

/**
 * CU-19: valida la presentacion comercial. Devuelve { valor } recortado o { error }.
 * Exc 1: no vacia ni solo espacios. Exc 2: maximo 150 caracteres.
 */
function validarPresentacion(presentacion) {
  const valor = typeof presentacion === 'string' ? presentacion.trim() : '';
  if (!valor) {
    return { error: 'Complete la presentación: indica el formato de empaque para facilitar la recepción en bodega.' };
  }
  if (valor.length > PRESENTACION_MAX) {
    return { error: `La presentación no puede superar los ${PRESENTACION_MAX} caracteres (tiene ${valor.length}). Acorte la descripción.` };
  }
  return { valor };
}

/* CU-123: insumo especial / no rotativo (material_es_rotativo = FALSE). No tiene
   umbrales de reposición ni alertas de stock, y su descripción es obligatoria
   (se compra a pedido: el proveedor necesita saber qué es). */
const MSG_DESCRIPCION_ESPECIAL = 'Complete la descripción: un insumo especial se compra a pedido y el proveedor necesita saber qué es.';

/**
 * CU-123: resuelve las alertas activas de stock y reposición de un material que
 * pasó a ser especial, fechando su historial. Las de diferencia de conteo (CU-57)
 * no dependen de los umbrales y se dejan; las del retiro de insumos (CU-126) tampoco.
 * Va dentro de la transacción del cambio.
 */
async function resolverAlertasDeStock(client, sku) {
  const { rows: tiposRetiro } = await client.query(
    `SELECT alerta_inventario_tipo_alerta_id_tipo_alerta AS id FROM alerta_inventario_tipo_alerta
     WHERE LOWER(REPLACE(alerta_inventario_tipo_alerta_nombre, '_', ' ')) = ANY($1::text[])`,
    [TIPOS_RETIRO]
  );
  const { rows } = await client.query(
    `SELECT alerta_inventario_id_alerta AS id, historial_alerta_id_historial AS hist
     FROM alerta_inventario
     WHERE material_sku = $1 AND alerta_inventario_estado = 'activa' AND conteo_ciclico_id_conteo IS NULL
       AND NOT (alerta_inventario_tipo_alerta_id_tipo_alerta = ANY($2::bigint[]))
     FOR UPDATE`,
    [sku, tiposRetiro.map(t => t.id)]
  );
  if (rows.length === 0) return 0;
  const hists = rows.map(r => r.hist).filter(Boolean);
  if (hists.length > 0) {
    await client.query(
      `UPDATE historial_alerta SET historial_alerta_fecha_hora_resolucion = now()
       WHERE historial_alerta_id_historial = ANY($1::bigint[]) AND historial_alerta_fecha_hora_resolucion IS NULL`,
      [hists]
    );
  }
  await client.query(
    `UPDATE alerta_inventario SET alerta_inventario_estado = 'resuelta'
     WHERE alerta_inventario_id_alerta = ANY($1::bigint[])`,
    [rows.map(r => r.id)]
  );
  return rows.length;
}

/**
 * GET /api/materiales
 * Lista todos los materiales con stock consolidado
 * Query params: ?buscar=&categoria=&estado=
 */
async function listar(req, res) {
  const { buscar, categoria, estado } = req.query;
  try {
    const { rows } = await query(
      `SELECT
         m.material_sku                                        AS sku,
         m.material_nombre_material                            AS nombre,
         m.material_descripcion                                AS descripcion,
         m.material_estado                                     AS estado,
         m.material_material_critico                           AS es_critico,
         m.material_es_rotativo                                AS es_rotativo,   -- CU-123
         m.material_descontinuado                              AS descontinuado, -- CU-122
         m.material_stock_minimo                               AS stock_minimo,
         m.material_stock_maximo                               AS stock_maximo,
         m.material_stock_critico                              AS stock_critico,
         m.material_presentacion                               AS presentacion,
         -- CU-30: codigo de barras interno (uno por SKU)
         (SELECT c.material_codigo_barras FROM material_codigo_barras c
          WHERE c.material_sku = m.material_sku LIMIT 1)       AS codigo_barras,
         u.material_unidad_medida_nombre                       AS unidad_medida,
         cg.material_categoria_general_nombre                  AS categoria_general,
         cf.material_categoria_funcional_nombre                AS categoria_funcional,
         -- Stock consolidado: suma de todas las bodegas
         COALESCE(SUM(ib.inventario_bodega_cantidad_fisica), 0)    AS stock_total,
         COALESCE(SUM(ib.inventario_bodega_cantidad_reservada), 0) AS stock_reservado
       FROM material m
       LEFT JOIN material_unidad_medida u
              ON u.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
       LEFT JOIN material_categoria_general cg
              ON cg.material_categoria_general_id_categoria_general = m.material_categoria_general_id_categoria_general
       LEFT JOIN material_categoria_funcional cf
              ON cf.material_categoria_funcional_id_categoria_funcional = m.material_categoria_funcional_id_categoria_funcional
       LEFT JOIN material_clasificacion_nivel_especifico cn
              ON cn.material_clasificacion_nivel_especifico_id = m.material_clasificacion_nivel_especifico_id
       LEFT JOIN material_clasificacion_subcategoria cs2
              ON cs2.material_clasificacion_subcategoria_id = cn.material_clasificacion_subcategoria_id
       LEFT JOIN material_clasificacion_categoria cc
              ON cc.material_clasificacion_categoria_id = cs2.material_clasificacion_categoria_id
       LEFT JOIN inventario_bodega ib
              ON ib.material_sku = m.material_sku
       WHERE ($1::text IS NULL OR
              m.material_sku ILIKE '%' || $1 || '%' OR
              m.material_nombre_material ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR cg.material_categoria_general_nombre ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR m.material_estado = $3)
       GROUP BY
         m.material_sku, m.material_nombre_material, m.material_descripcion,
         m.material_estado, m.material_material_critico, m.material_es_rotativo, m.material_descontinuado,
         m.material_stock_minimo, m.material_stock_maximo, m.material_stock_critico,
         m.material_presentacion,
         u.material_unidad_medida_nombre,
         cg.material_categoria_general_nombre,
         cf.material_categoria_funcional_nombre,
         cc.material_clasificacion_categoria_nombre_categoria,
         cs2.material_clasificacion_subcategoria_nombre_subcategoria,
         cn.material_clasificacion_nivel_especifico_nombre_nivel_especifico
       ORDER BY m.material_nombre_material`,
      [buscar || null, categoria || null, estado || null]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listando materiales:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/materiales/:sku
 * Detalle de un material con stock por bodega
 */
async function obtener(req, res) {
  const { sku } = req.params;
  try {
    // Datos del material
    const { rows: mat } = await query(
      `SELECT
         m.material_sku                              AS sku,
         m.material_nombre_material                  AS nombre,
         m.material_descripcion                      AS descripcion,
         m.material_estado                           AS estado,
         m.material_material_critico                 AS es_critico,
         m.material_stock_minimo                     AS stock_minimo,
         m.material_stock_maximo                     AS stock_maximo,
         m.material_stock_critico                    AS stock_critico,
         m.material_presentacion                     AS presentacion,
         m.material_presentacion_fecha_modificacion  AS presentacion_fecha_modificacion,
         -- CU-30: codigo de barras interno (uno por SKU)
         (SELECT c.material_codigo_barras FROM material_codigo_barras c
          WHERE c.material_sku = m.material_sku LIMIT 1) AS codigo_barras,
         m.material_es_rotativo                                                  AS es_rotativo,
         m.material_descontinuado                                                AS descontinuado,   -- CU-122
         m.material_clasificacion_nivel_especifico_id                             AS clasificacion_nivel_id,
         m.material_unidad_medida_id_unidad_medida                               AS unidad_medida_id,
         m.material_categoria_general_id_categoria_general                       AS categoria_general_id,
         m.material_categoria_funcional_id_categoria_funcional                   AS categoria_funcional_id,
         u.material_unidad_medida_nombre                                          AS unidad_medida,
         cg.material_categoria_general_nombre                                     AS categoria_general,
         cf.material_categoria_funcional_nombre                                   AS categoria_funcional,
         cc.material_clasificacion_categoria_nombre_categoria                     AS clasificacion_categoria,
         cs2.material_clasificacion_subcategoria_nombre_subcategoria              AS clasificacion_subcategoria,
         cn.material_clasificacion_nivel_especifico_nombre_nivel_especifico       AS clasificacion_nivel
       FROM material m
       LEFT JOIN material_unidad_medida u
              ON u.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
       LEFT JOIN material_categoria_general cg
              ON cg.material_categoria_general_id_categoria_general = m.material_categoria_general_id_categoria_general
       LEFT JOIN material_categoria_funcional cf
              ON cf.material_categoria_funcional_id_categoria_funcional = m.material_categoria_funcional_id_categoria_funcional
       LEFT JOIN material_clasificacion_nivel_especifico cn
              ON cn.material_clasificacion_nivel_especifico_id = m.material_clasificacion_nivel_especifico_id
       LEFT JOIN material_clasificacion_subcategoria cs2
              ON cs2.material_clasificacion_subcategoria_id = cn.material_clasificacion_subcategoria_id
       LEFT JOIN material_clasificacion_categoria cc
              ON cc.material_clasificacion_categoria_id = cs2.material_clasificacion_categoria_id
       WHERE m.material_sku ILIKE $1`,
      [sku]
    );

    if (mat.length === 0) {
      return res.status(404).json({ error: 'Material no encontrado' });
    }

    // Stock por bodega
    const { rows: stock } = await query(
      `SELECT
         b.bodega_id_bodega                        AS bodega_id,
         b.bodega_nombre_bodega                    AS bodega_nombre,
         b.bodega_estado                           AS bodega_estado,
         SUM(ib.inventario_bodega_cantidad_fisica)    AS cantidad_fisica,
         SUM(ib.inventario_bodega_cantidad_reservada) AS cantidad_reservada
       FROM inventario_bodega ib
       JOIN bodega b ON b.bodega_id_bodega = ib.bodega_id_bodega
       WHERE ib.material_sku = $1
       GROUP BY b.bodega_id_bodega, b.bodega_nombre_bodega, b.bodega_estado
       ORDER BY b.bodega_nombre_bodega`,
      [sku]
    );

    // Proveedores del material
    const { rows: proveedores } = await query(
      `SELECT
         p.proveedor_id_proveedor                    AS id,
         p.proveedor_razon_social                    AS nombre,
         mp.material_proveedor_tiempo_reposicion     AS tiempo_reposicion,
         mp.material_proveedor_precio_referencial    AS precio_referencial,
         mp.material_proveedor_cantidad_minima       AS cantidad_minima,
         mp.material_proveedor_proveedor_principal   AS es_principal
       FROM material_proveedor mp
       JOIN proveedor p ON p.proveedor_id_proveedor = mp.proveedor_id_proveedor
       WHERE mp.material_sku = $1
       ORDER BY mp.material_proveedor_proveedor_principal DESC`,
      [sku]
    );

    // Montos ocultos a jop y técnico en el BACKEND (no solo en la vista; D50)
    if (ocultaMontos(req)) {
      for (const p of proveedores) delete p.precio_referencial;
    }

    res.json({ ...mat[0], stock_por_bodega: stock, proveedores });
  } catch (err) {
    console.error('Error obteniendo material:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/materiales
 * Crear nuevo material
 */
async function crear(req, res) {
  const {
    sku, nombre, descripcion, presentacion,
    stock_minimo, stock_maximo, stock_critico,
    es_critico, es_rotativo, estado,
    unidad_medida_id, categoria_general_id, categoria_funcional_id
  } = req.body;

  // CU-123 Exc 1: se nombran todos los campos que faltan, no solo el primero
  const especial = es_rotativo === false;
  const faltan = [
    !String(sku || '').trim() && 'SKU',
    !String(nombre || '').trim() && 'nombre',
    !unidad_medida_id && 'unidad de medida',
    especial && !String(descripcion || '').trim() && 'descripción',
  ].filter(Boolean);
  if (faltan.length > 0) {
    return res.status(400).json({
      error: `Complete los campos obligatorios: ${faltan.join(', ')}.` +
             (especial && faltan.includes('descripción') ? ' En un insumo especial la descripción es obligatoria.' : ''),
      campos_faltantes: faltan,
    });
  }

  // CU-19: la presentacion es opcional al crear; si viene con texto, se valida el largo
  let presentacionVal = null;
  if (typeof presentacion === 'string' && presentacion.trim()) {
    const v = validarPresentacion(presentacion);
    if (v.error) return res.status(400).json({ error: v.error });
    presentacionVal = v.valor;
  }

  // Forzar SKU en mayúsculas siempre
  const skuUpper = sku.toUpperCase();

  const { clasificacion_nivel_especifico_id } = req.body;

  try {
    // CU-30: el material y su codigo de barras interno se crean juntos, en una transaccion
    const codigo = await conTransaccion(async (client) => {
      // Verificar duplicado case-insensitive antes del INSERT.
      // CU-123 Exc 2: se muestra el producto existente y se sugiere reclasificarlo.
      const { rows: dup } = await client.query(
        `SELECT material_sku AS sku, material_nombre_material AS nombre, material_estado AS estado,
                material_es_rotativo AS es_rotativo
         FROM material WHERE UPPER(material_sku) = $1`,
        [skuUpper]
      );
      if (dup.length > 0) {
        const e = dup[0];
        const tipo = e.es_rotativo === false ? 'insumo especial' : 'producto estándar';
        throw new ErrorNegocio(409, {
          error: `El SKU ${e.sku} ya existe en el catálogo como ${tipo}: "${e.nombre}"` +
                 (e.estado !== 'activo' ? ` (${e.estado})` : '') +
                 '. Si corresponde, cambie su clasificación en lugar de crear uno nuevo.',
          existente: e,
        });
      }

      await client.query(
        `INSERT INTO material (
           material_sku, material_nombre_material, material_descripcion,
           material_presentacion, material_stock_minimo, material_stock_maximo,
           material_stock_critico, material_material_critico, material_es_rotativo,
           material_estado, material_unidad_medida_id_unidad_medida,
           material_categoria_general_id_categoria_general,
           material_categoria_funcional_id_categoria_funcional,
           material_clasificacion_nivel_especifico_id,
           material_presentacion_fecha_modificacion
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                   CASE WHEN $4::varchar IS NULL THEN NULL ELSE now() END)`,
        [
          skuUpper, nombre, descripcion || null, presentacionVal,
          // CU-123: un insumo especial no tiene umbrales, aunque vengan en el cuerpo
          !especial && stock_minimo != null ? parseFloat(stock_minimo) : null,
          !especial && stock_maximo != null ? parseFloat(stock_maximo) : null,
          !especial && stock_critico != null ? parseFloat(stock_critico) : null,
          Boolean(es_critico),
          !especial,
          estado || 'activo',
          parseInt(unidad_medida_id),
          categoria_general_id ? parseInt(categoria_general_id) : null,
          categoria_funcional_id ? parseInt(categoria_funcional_id) : null,
          clasificacion_nivel_especifico_id ? parseInt(clasificacion_nivel_especifico_id) : null
        ]
      );
      return generarCodigoInterno(client, skuUpper);
    });
    await auditoria.registrar(req.user?.id, 'Crear material',
      `Material "${nombre}" creado (SKU: ${skuUpper})${especial ? ' como insumo especial' : ''}`);
    res.status(201).json({ message: 'Material creado correctamente', sku, codigo_barras: codigo });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'El SKU ya existe en el sistema' });
    }
    responderError(res, err, 'Error creando material:');
  }
}

/**
 * PUT /api/materiales/:sku
 * Actualizar material (SKU no se puede cambiar)
 */
async function actualizar(req, res) {
  const { sku } = req.params;
  const {
    nombre, descripcion, presentacion,
    stock_minimo, stock_maximo, stock_critico,
    es_critico, es_rotativo, estado,
    unidad_medida_id, categoria_general_id, categoria_funcional_id
  } = req.body;

  // CU-19: patron de presencia SOLO para la presentacion. Omitida = se conserva.
  // Enviada = se valida; no se puede borrar (Exc 1 gana sobre "enviado vacio se limpia").
  const presentacionEnviada = presentacion !== undefined;
  let presentacionVal = null;
  if (presentacionEnviada) {
    const v = validarPresentacion(presentacion);
    if (v.error) return res.status(400).json({ error: v.error });
    presentacionVal = v.valor;
  }

  // Patron de presencia: un campo omitido se conserva; uno enviado vacio o null se limpia.
  // Antes estos 7 campos se escribian siempre, y un PUT parcial (vincular proveedor)
  // dejaba en NULL descripcion, stocks, categorias y clasificacion del producto.
  const enviado = (campo) => Object.prototype.hasOwnProperty.call(req.body, campo);

  try {
    // CU-123: ¿el material queda como insumo especial? Lo enviado manda; si no, lo guardado.
    const { rows: actual } = await query(
      `SELECT material_sku AS sku, material_es_rotativo AS es_rotativo, material_descripcion AS descripcion
       FROM material WHERE material_sku ILIKE $1`,
      [sku]
    );
    if (actual.length === 0) return res.status(404).json({ error: 'Material no encontrado' });
    const especial = enviado('es_rotativo') && es_rotativo != null
      ? !es_rotativo
      : actual[0].es_rotativo === false;
    const descripcionFinal = enviado('descripcion') ? descripcion : actual[0].descripcion;
    if (especial && !String(descripcionFinal || '').trim()) {
      return res.status(400).json({ error: MSG_DESCRIPCION_ESPECIAL, campos_faltantes: ['descripción'] });
    }
    // Un especial no tiene umbrales: no se validan y se guardan en NULL (ver el UPDATE)
    if (!especial) {
      // Validar stock_critico >= 0
      if (stock_critico != null && parseFloat(stock_critico) < 0) {
        return res.status(400).json({ error: 'El stock crítico debe ser mayor o igual a 0 y menor al stock mínimo.' });
      }
      // CU-13: validar stock_critico < stock_minimo
      if (stock_critico != null && stock_minimo != null) {
        if (parseFloat(stock_critico) >= parseFloat(stock_minimo)) {
          return res.status(400).json({ error: 'El stock crítico debe ser mayor o igual a 0 y menor al stock mínimo.' });
        }
      }
      // CU-13 Exc 3: si se envía stock_critico sin stock_minimo, verificar que exista en BD
      if (stock_critico != null && stock_minimo == null) {
        // Si el minimo viene en null explicito, se esta borrando: no cuenta el de la BD
        if (enviado('stock_minimo')) {
          return res.status(400).json({ error: 'Debe definir primero el stock mínimo antes de configurar el stock crítico' });
        }
        const { rows: mat } = await query(
          `SELECT material_stock_minimo FROM material WHERE material_sku ILIKE $1`, [sku]
        );
        if (mat.length > 0 && mat[0].material_stock_minimo == null) {
          return res.status(400).json({ error: 'Debe definir primero el stock mínimo antes de configurar el stock crítico' });
        }
        if (mat.length > 0 && mat[0].material_stock_minimo != null &&
            parseFloat(stock_critico) >= parseFloat(mat[0].material_stock_minimo)) {
          return res.status(400).json({ error: 'El stock crítico debe ser mayor o igual a 0 y menor al stock mínimo.' });
        }
      }
      // Caso inverso: se envia un minimo nuevo y el critico se omite, asi que se conserva el
      // de la BD. Ese critico guardado tambien tiene que quedar por debajo del minimo nuevo.
      if (stock_minimo != null && !enviado('stock_critico')) {
        const { rows: mat } = await query(
          `SELECT material_stock_critico FROM material WHERE material_sku ILIKE $1`, [sku]
        );
        if (mat.length > 0 && mat[0].material_stock_critico != null &&
            parseFloat(mat[0].material_stock_critico) >= parseFloat(stock_minimo)) {
          return res.status(400).json({ error: 'El stock crítico debe ser mayor o igual a 0 y menor al stock mínimo.' });
        }
      }
    }

    // CU-123: el cambio y el cierre de las alertas de stock de un especial, juntos
    const r = await conTransaccion(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE material SET
           material_nombre_material                              = COALESCE($1, material_nombre_material),
           material_descripcion                                  = CASE WHEN $16::boolean THEN $2::text ELSE material_descripcion END,
           -- CU-19: la fecha se mueve solo si la presentacion cambia de verdad.
           -- Las dos lecturas de material_presentacion ven el valor ANTERIOR al UPDATE.
           material_presentacion_fecha_modificacion              = CASE WHEN $15::boolean AND $3::varchar IS DISTINCT FROM material_presentacion
                                                                        THEN now() ELSE material_presentacion_fecha_modificacion END,
           material_presentacion                                 = CASE WHEN $15::boolean THEN $3::varchar ELSE material_presentacion END,
           material_stock_minimo                                 = CASE WHEN $17::boolean THEN $4::numeric ELSE material_stock_minimo END,
           material_stock_maximo                                 = CASE WHEN $18::boolean THEN $5::numeric ELSE material_stock_maximo END,
           material_stock_critico                                = CASE WHEN $19::boolean THEN $6::numeric ELSE material_stock_critico END,
           material_material_critico                             = COALESCE($7, material_material_critico),
           material_es_rotativo                                  = COALESCE($8, material_es_rotativo),
           material_estado                                       = COALESCE($9, material_estado),
           material_unidad_medida_id_unidad_medida               = COALESCE($10, material_unidad_medida_id_unidad_medida),
           material_categoria_general_id_categoria_general       = CASE WHEN $20::boolean THEN $11::bigint ELSE material_categoria_general_id_categoria_general END,
           material_categoria_funcional_id_categoria_funcional   = CASE WHEN $21::boolean THEN $12::bigint ELSE material_categoria_funcional_id_categoria_funcional END,
           material_clasificacion_nivel_especifico_id            = CASE WHEN $22::boolean THEN $13::bigint ELSE material_clasificacion_nivel_especifico_id END,
           -- CU-122 Exc 1: descontinuado (no se vuelve a comprar); omitido = se conserva
           material_descontinuado                                = COALESCE($23::boolean, material_descontinuado)
         WHERE material_sku ILIKE $14`,
        [
          nombre || null,
          descripcion !== undefined ? (descripcion || null) : null,
          presentacionVal,
          !especial && stock_minimo != null ? parseFloat(stock_minimo) : null,
          !especial && stock_maximo != null ? parseFloat(stock_maximo) : null,
          !especial && stock_critico != null ? parseFloat(stock_critico) : null,
          es_critico != null ? Boolean(es_critico) : null,
          es_rotativo != null ? Boolean(es_rotativo) : null,
          estado || null,
          unidad_medida_id ? parseInt(unidad_medida_id) : null,
          categoria_general_id ? parseInt(categoria_general_id) : null,
          categoria_funcional_id ? parseInt(categoria_funcional_id) : null,
          req.body.clasificacion_nivel_especifico_id ? parseInt(req.body.clasificacion_nivel_especifico_id) : null,
          sku,
          presentacionEnviada,
          enviado('descripcion'),
          especial || enviado('stock_minimo'),
          especial || enviado('stock_maximo'),
          especial || enviado('stock_critico'),
          enviado('categoria_general_id'),
          enviado('categoria_funcional_id'),
          enviado('clasificacion_nivel_especifico_id'),
          req.body.descontinuado != null ? Boolean(req.body.descontinuado) : null,
        ]
      );
      if (rowCount === 0) throw new ErrorNegocio(404, { error: 'Material no encontrado' });
      return { alertasResueltas: especial ? await resolverAlertasDeStock(client, actual[0].sku) : 0 };
    });

    // CU-60: vincular un proveedor ya no pasa por este PUT: tiene su propio endpoint,
    // POST /materiales/:sku/proveedores (vincularProveedor), transaccional.

    await auditoria.registrar(req.user?.id, 'Editar material', `Material SKU ${sku} actualizado` +
      (especial ? ` (insumo especial; ${r.alertasResueltas} alerta(s) de stock resuelta(s))` : ''));
    res.json({
      message: 'Material actualizado correctamente' +
               (r.alertasResueltas > 0 ? `. Se resolvieron ${r.alertasResueltas} alerta(s) de stock: un insumo especial no las genera.` : ''),
      alertas_resueltas: r.alertasResueltas,
    });
  } catch (err) {
    responderError(res, err, 'Error actualizando material:');
  }
}

/**
 * CU-60: valida los valores comerciales de la relacion producto-proveedor (Exc 1).
 * Los tres son obligatorios y positivos. Devuelve { valores } o { error, campo }.
 */
function validarValoresComerciales({ precio, tiempo_reposicion, cantidad_minima }) {
  const p = Number(precio);
  if (precio == null || precio === '' || !Number.isFinite(p) || p <= 0) {
    return { campo: 'precio', error: 'El precio unitario debe ser un monto mayor a cero.' };
  }
  const t = Number(tiempo_reposicion);
  if (tiempo_reposicion == null || tiempo_reposicion === '' || !Number.isInteger(t) || t < 1) {
    return { campo: 'tiempo_reposicion', error: 'El tiempo de reposición debe ser un número entero de días hábiles, de al menos 1.' };
  }
  const c = Number(cantidad_minima);
  if (cantidad_minima == null || cantidad_minima === '' || !Number.isFinite(c) || c < 1) {
    return { campo: 'cantidad_minima', error: 'La cantidad mínima de pedido debe ser al menos 1.' };
  }
  return { valores: { precio: p, tiempo_reposicion: t, cantidad_minima: c } };
}

/**
 * POST /api/materiales/:sku/proveedores   (solo gerencia)
 * CU-60: vincula un proveedor al producto con precio, plazo y cantidad minima.
 * Body: { proveedor_id, precio, tiempo_reposicion, cantidad_minima, confirmar }
 *
 * Si la relacion ya existe y no viene `confirmar`, responde 409 con los valores
 * vigentes y no escribe nada (Exc 2). Con `confirmar`, actualiza la relacion y, si
 * el precio cambio, cierra el precio anterior en el historial (fecha_vigencia_hasta)
 * y abre uno nuevo desde hoy. Todo en una transaccion.
 */
async function vincularProveedor(req, res) {
  const proveedorId = parseInt(req.body?.proveedor_id);
  if (!proveedorId) {
    return res.status(400).json({ campo: 'proveedor_id', error: 'Seleccione un proveedor.' });
  }
  const v = validarValoresComerciales(req.body || {});
  if (v.error) return res.status(400).json({ campo: v.campo, error: v.error });
  const { precio, tiempo_reposicion, cantidad_minima } = v.valores;
  const confirmar = req.body?.confirmar === true;

  try {
    const r = await conTransaccion(async (client) => {
      const { rows: mat } = await client.query(
        `SELECT material_sku FROM material WHERE material_sku ILIKE $1`, [req.params.sku]
      );
      if (mat.length === 0) throw new ErrorNegocio(404, { error: 'Material no encontrado' });
      const sku = mat[0].material_sku;

      const { rows: prov } = await client.query(
        `SELECT proveedor_razon_social AS nombre FROM proveedor WHERE proveedor_id_proveedor = $1`, [proveedorId]
      );
      if (prov.length === 0) throw new ErrorNegocio(404, { error: 'Proveedor no encontrado' });

      const { rows: actual } = await client.query(
        `SELECT material_proveedor_precio_referencial AS precio,
                material_proveedor_tiempo_reposicion  AS tiempo_reposicion,
                material_proveedor_cantidad_minima    AS cantidad_minima
         FROM material_proveedor
         WHERE material_sku = $1 AND proveedor_id_proveedor = $2
         FOR UPDATE`,
        [sku, proveedorId]
      );

      // ── Relacion nueva ──
      if (actual.length === 0) {
        const { rows: otros } = await client.query(
          `SELECT 1 FROM material_proveedor WHERE material_sku = $1 LIMIT 1`, [sku]
        );
        await client.query(
          `INSERT INTO material_proveedor (material_sku, proveedor_id_proveedor,
             material_proveedor_tiempo_reposicion, material_proveedor_precio_referencial,
             material_proveedor_cantidad_minima, material_proveedor_proveedor_principal)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [sku, proveedorId, tiempo_reposicion, precio, cantidad_minima, otros.length === 0]
        );
        await client.query(
          `INSERT INTO historial_precio_material
             (material_sku, proveedor_id_proveedor, precio_unitario, fecha_vigencia_desde, fuente, usuario_id_usuario)
           VALUES ($1, $2, $3, CURRENT_DATE, 'manual', $4)`,
          [sku, proveedorId, precio, req.user?.id || null]
        );
        return { sku, proveedor: prov[0].nombre, creado: true };
      }

      // ── Relacion existente: Exc 2, se confirma antes de actualizar ──
      const vigentes = {
        precio:            actual[0].precio != null ? parseFloat(actual[0].precio) : null,
        tiempo_reposicion: actual[0].tiempo_reposicion,
        cantidad_minima:   actual[0].cantidad_minima != null ? parseFloat(actual[0].cantidad_minima) : null,
      };
      if (!confirmar) {
        throw new ErrorNegocio(409, {
          error: `El proveedor "${prov[0].nombre}" ya está vinculado a este producto. Confirme para actualizar sus valores.`,
          duplicado: true,
          vigentes,
        });
      }

      await client.query(
        `UPDATE material_proveedor
         SET material_proveedor_precio_referencial = $3,
             material_proveedor_tiempo_reposicion  = $4,
             material_proveedor_cantidad_minima    = $5
         WHERE material_sku = $1 AND proveedor_id_proveedor = $2`,
        [sku, proveedorId, precio, tiempo_reposicion, cantidad_minima]
      );

      if (vigentes.precio !== precio) {
        // El precio anterior queda en el historial con su fecha de termino
        const { rowCount: cerrados } = await client.query(
          `UPDATE historial_precio_material SET fecha_vigencia_hasta = CURRENT_DATE
           WHERE material_sku = $1 AND proveedor_id_proveedor = $2 AND fecha_vigencia_hasta IS NULL`,
          [sku, proveedorId]
        );
        // Relaciones antiguas pueden tener precio sin fila en el historial: se registra
        // el valor anterior igual, cerrado hoy, porque su fecha de inicio no se conoce.
        if (cerrados === 0 && vigentes.precio != null) {
          await client.query(
            `INSERT INTO historial_precio_material
               (material_sku, proveedor_id_proveedor, precio_unitario, fecha_vigencia_desde,
                fecha_vigencia_hasta, fuente, usuario_id_usuario)
             VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE, 'manual', $4)`,
            [sku, proveedorId, vigentes.precio, req.user?.id || null]
          );
        }
        await client.query(
          `INSERT INTO historial_precio_material
             (material_sku, proveedor_id_proveedor, precio_unitario, fecha_vigencia_desde, fuente, usuario_id_usuario)
           VALUES ($1, $2, $3, CURRENT_DATE, 'manual', $4)`,
          [sku, proveedorId, precio, req.user?.id || null]
        );
      }
      return { sku, proveedor: prov[0].nombre, creado: false, anteriores: vigentes };
    });

    // Auditoria despues del COMMIT. registro_afectado es VARCHAR(100): detalle corto.
    const a = r.anteriores;
    const detalle = r.creado
      ? `SKU ${r.sku} / prov #${proveedorId}: precio ${precio}, plazo ${tiempo_reposicion}, mín ${cantidad_minima}`
      : `SKU ${r.sku} / prov #${proveedorId}: precio ${a.precio}→${precio}, plazo ${a.tiempo_reposicion}→${tiempo_reposicion}, mín ${a.cantidad_minima}→${cantidad_minima}`;
    await auditoria.registrar(req.user?.id, r.creado ? 'Vincular proveedor' : 'Actualizar proveedor', detalle.slice(0, 100));

    res.status(r.creado ? 201 : 200).json({
      message: r.creado ? 'Proveedor vinculado correctamente.' : 'Valores del proveedor actualizados. El precio anterior quedó en el historial.',
    });
  } catch (err) {
    responderError(res, err, 'Error vinculando proveedor:');
  }
}

/**
 * GET /api/materiales/catalogos/unidades
 * Lista unidades de medida para los formularios
 */
async function listarUnidades(req, res) {
  try {
    const { rows } = await query(
      `SELECT
         material_unidad_medida_id_unidad_medida AS id,
         material_unidad_medida_nombre           AS nombre
       FROM material_unidad_medida
       ORDER BY material_unidad_medida_nombre`
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listando unidades:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/materiales/catalogos/categorias
 * Lista categorías generales, funcionales y clasificación en cascada
 */
async function listarCategorias(req, res) {
  try {
    const [generales, funcionales, clasCateg, clasSub, clasNiv] = await Promise.all([
      query(`SELECT material_categoria_general_id_categoria_general AS id,
                    material_categoria_general_nombre AS nombre
             FROM material_categoria_general ORDER BY nombre`),
      query(`SELECT material_categoria_funcional_id_categoria_funcional AS id,
                    material_categoria_funcional_nombre AS nombre
             FROM material_categoria_funcional ORDER BY nombre`),
      query(`SELECT material_clasificacion_categoria_id AS id,
                    material_clasificacion_categoria_nombre_categoria AS nombre
             FROM material_clasificacion_categoria ORDER BY nombre`),
      query(`SELECT material_clasificacion_subcategoria_id AS id,
                    material_clasificacion_subcategoria_nombre_subcategoria AS nombre,
                    material_clasificacion_subcategoria_es_color_custom AS es_color_custom,
                    material_clasificacion_categoria_id AS categoria_id
             FROM material_clasificacion_subcategoria ORDER BY nombre`),
      query(`SELECT material_clasificacion_nivel_especifico_id AS id,
                    material_clasificacion_nivel_especifico_nombre_nivel_especifico AS nombre,
                    material_clasificacion_subcategoria_id AS subcategoria_id
             FROM material_clasificacion_nivel_especifico ORDER BY nombre`),
    ]);
    res.json({
      generales:      generales.rows,
      funcionales:    funcionales.rows,
      clasificacion:  {
        categorias:    clasCateg.rows,
        subcategorias: clasSub.rows,
        niveles:       clasNiv.rows,
      }
    });
  } catch (err) {
    console.error('Error listando categorias:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}


/**
 * DELETE /api/materiales/:sku
 * Elimina un material si no tiene movimientos ni stock.
 * Si tiene movimientos o stock, solo lo desactiva (CU-04)
 * Solo gerencia puede ejecutar esta acción.
 */
async function eliminar(req, res) {
  const { sku } = req.params;
  try {
    // Verificar si tiene movimientos asociados
    const { rows: movs } = await query(
      `SELECT COUNT(*) AS total FROM movimiento_inventario WHERE material_sku = $1`, [sku]
    );
    // Verificar si tiene stock en alguna bodega
    const { rows: stock } = await query(
      `SELECT COALESCE(SUM(inventario_bodega_cantidad_fisica), 0) AS total
       FROM inventario_bodega WHERE material_sku = $1`, [sku]
    );

    const tieneMovimientos = parseInt(movs[0].total) > 0;
    const tieneStock       = parseFloat(stock[0].total) > 0;

    if (tieneMovimientos || tieneStock) {
      // Solo desactivar — no eliminar físicamente
      await query(
        `UPDATE material SET material_estado = 'inactivo' WHERE material_sku = $1`, [sku]
      );
      await auditoria.registrar(req.user?.id, 'Desactivar material', `Material SKU ${sku} desactivado (motivo: tenía ${tieneMovimientos ? 'movimientos registrados' : 'stock en bodega'})`);
      return res.json({
        eliminado: false,
        desactivado: true,
        message: 'El producto tiene ' +
          (tieneMovimientos ? 'movimientos asociados' : 'stock registrado') +
          '. Fue desactivado en lugar de eliminado.'
      });
    }

    // Sin movimientos ni stock: eliminar físicamente.
    // CU-30: primero su codigo de barras (FK fk_cod_bar_mat), en la misma transaccion.
    const rowCount = await conTransaccion(async (client) => {
      await client.query(`DELETE FROM material_codigo_barras WHERE material_sku = $1`, [sku]);
      const r = await client.query(`DELETE FROM material WHERE material_sku = $1`, [sku]);
      return r.rowCount;
    });
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Material no encontrado' });
    }
    await auditoria.registrar(req.user?.id, 'Eliminar material', `Material SKU ${sku} eliminado permanentemente del sistema`);
    return res.json({ eliminado: true, desactivado: false, message: 'Producto eliminado correctamente.' });
  } catch (err) {
    console.error('Error eliminando material:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * PUT /api/materiales/:sku/reactivar
 * Reactivar producto desactivado (CU-XX UR 1.1)
 */
async function reactivar(req, res) {
  const { sku } = req.params;
  try {
    const { rows: mat } = await query(
      `SELECT material_estado FROM material WHERE material_sku ILIKE $1`, [sku]
    );
    if (mat.length === 0) {
      return res.status(404).json({ error: 'Material no encontrado' });
    }
    // Exc 1: ya activo
    if (mat[0].material_estado === 'activo') {
      return res.status(400).json({ error: 'El producto ya se encuentra activo. La acción no es necesaria.' });
    }

    await query(
      `UPDATE material SET material_estado = 'activo' WHERE material_sku ILIKE $1`, [sku]
    );
    await auditoria.registrar(req.user?.id, 'Reactivar material', `Material SKU ${sku} reactivado`);
    res.json({ message: 'Producto reactivado correctamente' });
  } catch (err) {
    console.error('Error reactivando material:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/materiales/duplicar
 * Duplicar producto existente (CU-XX UR 1.2)
 * Body: { sku_base, sku_nuevo }
 */
async function duplicar(req, res) {
  const { sku_base, sku_nuevo } = req.body;

  if (!sku_base || !sku_nuevo) {
    return res.status(400).json({ error: 'SKU base y SKU nuevo son requeridos' });
  }

  const skuNuevoUpper = sku_nuevo.toUpperCase();

  try {
    // Obtener producto base
    const { rows: base } = await query(
      `SELECT * FROM material WHERE material_sku ILIKE $1`, [sku_base]
    );

    // Exc 1: producto base no existe
    if (base.length === 0) {
      return res.status(404).json({ error: 'El producto base no fue encontrado. No se puede duplicar.' });
    }

    // Exc 2: SKU nuevo ya existe
    const { rows: dup } = await query(
      `SELECT material_sku FROM material WHERE UPPER(material_sku) = $1`, [skuNuevoUpper]
    );
    if (dup.length > 0) {
      return res.status(409).json({ error: 'El SKU ya existe en el sistema. Ingrese un código distinto.' });
    }

    const b = base[0];
    // CU-30: la copia recibe su propio codigo de barras, en la misma transaccion
    const codigo = await conTransaccion(async (client) => {
      await client.query(
        `INSERT INTO material (
           material_sku, material_nombre_material, material_descripcion,
           material_presentacion, material_stock_minimo, material_stock_maximo,
           material_stock_critico, material_material_critico, material_es_rotativo,
           material_estado, material_unidad_medida_id_unidad_medida,
           material_categoria_general_id_categoria_general,
           material_categoria_funcional_id_categoria_funcional,
           material_clasificacion_nivel_especifico_id,
           es_material_pintura_custom, material_pintura_pintura_custom,
           es_material_pintura_no_custom, material_pintura_no_custom
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'activo',$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          skuNuevoUpper,
          b.material_nombre_material + ' (copia)',
          b.material_descripcion,
          b.material_presentacion,
          b.material_stock_minimo,
          b.material_stock_maximo,
          b.material_stock_critico,
          b.material_material_critico,
          b.material_es_rotativo,
          b.material_unidad_medida_id_unidad_medida,
          b.material_categoria_general_id_categoria_general,
          b.material_categoria_funcional_id_categoria_funcional,
          b.material_clasificacion_nivel_especifico_id,
          b.es_material_pintura_custom,
          b.material_pintura_pintura_custom,
          b.es_material_pintura_no_custom,
          b.material_pintura_no_custom
        ]
      );
      return generarCodigoInterno(client, skuNuevoUpper);
    });

    await auditoria.registrar(req.user?.id, 'Duplicar material', `Material duplicado desde SKU ${sku_base} → nuevo SKU ${skuNuevoUpper}`);
    res.status(201).json({ message: 'Producto duplicado correctamente', sku: skuNuevoUpper, codigo_barras: codigo });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'El SKU ya existe en el sistema' });
    }
    console.error('Error duplicando material:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/materiales/:sku/historial-precios
 * Historial de precios derivado de lotes y facturas (CU-16)
 */
async function historialPrecios(req, res) {
  const { sku } = req.params;
  try {
    // Verificar que el producto existe
    const { rows: mat } = await query(
      `SELECT material_sku FROM material WHERE material_sku ILIKE $1`, [sku]
    );
    if (mat.length === 0) {
      return res.status(404).json({ error: 'Material no encontrado' });
    }

    // SONNET-9: historial desde historial_precio_material (antes: JOIN complejo con lote_fecha_pedido)
    const { rows } = await query(
      `SELECT
         hpm.fecha_vigencia_desde   AS fecha,
         hpm.precio_unitario        AS precio_unitario,
         hpm.fuente                 AS fuente,
         p.proveedor_razon_social   AS proveedor,
         fc.factura_compra_numero_factura AS factura
       FROM historial_precio_material hpm
       JOIN proveedor p ON p.proveedor_id_proveedor = hpm.proveedor_id_proveedor
       LEFT JOIN factura_compra fc ON fc.factura_compra_id_factura = hpm.factura_compra_id
       WHERE hpm.material_sku ILIKE $1
       ORDER BY hpm.fecha_vigencia_desde DESC, hpm.historial_precio_id DESC`,
      [sku]
    );

    // CU-16 Exc 1: sin datos históricos
    if (rows.length === 0) {
      // Devolver al menos el precio referencial actual
      const { rows: ref } = await query(
        `SELECT mp.material_proveedor_precio_referencial AS precio,
                p.proveedor_razon_social AS proveedor
         FROM material_proveedor mp
         JOIN proveedor p ON p.proveedor_id_proveedor = mp.proveedor_id_proveedor
         WHERE mp.material_sku ILIKE $1
         ORDER BY mp.material_proveedor_proveedor_principal DESC`,
        [sku]
      );
      if (ref.length > 0 && ref[0].precio) {
        return res.json({
          historial: [],
          precio_actual: ref[0],
          mensaje: 'Solo existe el precio referencial actual. No hay datos históricos de compra.'
        });
      } else {
        return res.json({
          historial: [],
          precio_actual: null,
          mensaje: 'No hay información de precios disponible para este producto.'
        });
      }
    }

    res.json({ historial: rows });
  } catch (err) {
    console.error('Error obteniendo historial precios:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/materiales/:sku/precios
 * Historial de precios paginado y filtrable (SONNET-9).
 * Query params: ?desde=&hasta=&proveedor_id=&page=&limit=
 */
async function listarPrecios(req, res) {
  const { sku } = req.params;
  const { desde, hasta, proveedor_id, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  try {
    const { rows: mat } = await query(
      `SELECT material_sku FROM material WHERE material_sku ILIKE $1`, [sku]
    );
    if (mat.length === 0) {
      return res.status(404).json({ error: 'Material no encontrado' });
    }

    // CU-64: variacion respecto del precio anterior del MISMO proveedor, calculada
    // sobre el historial completo del producto antes de filtrar y paginar.
    const { rows } = await query(
      `WITH h AS (
         SELECT hpm.*,
                LAG(hpm.precio_unitario) OVER (PARTITION BY hpm.proveedor_id_proveedor
                  ORDER BY hpm.fecha_vigencia_desde, hpm.historial_precio_id) AS precio_anterior,
                COUNT(*) OVER (PARTITION BY hpm.proveedor_id_proveedor)::int   AS registros_producto
         FROM historial_precio_material hpm
         WHERE hpm.material_sku ILIKE $1
       )
       SELECT
         h.historial_precio_id    AS id,
         h.fecha_vigencia_desde   AS fecha,
         h.precio_unitario        AS precio_unitario,
         h.precio_anterior        AS precio_anterior,
         h.precio_unitario - h.precio_anterior AS variacion_abs,
         CASE WHEN h.precio_anterior > 0
              THEN round((h.precio_unitario - h.precio_anterior) / h.precio_anterior * 100, 2) END AS variacion_pct,
         h.registros_producto     AS registros_producto,
         h.moneda                 AS moneda,
         h.fuente                 AS fuente,
         h.proveedor_id_proveedor AS proveedor_id,
         p.proveedor_razon_social AS proveedor,
         fc.factura_compra_numero_factura AS factura,
         COUNT(*) OVER() AS total_registros
       FROM h
       JOIN proveedor p ON p.proveedor_id_proveedor = h.proveedor_id_proveedor
       LEFT JOIN factura_compra fc ON fc.factura_compra_id_factura = h.factura_compra_id
       WHERE ($2::date IS NULL OR h.fecha_vigencia_desde >= $2::date)
         AND ($3::date IS NULL OR h.fecha_vigencia_desde <= $3::date)
         AND ($4::bigint IS NULL OR h.proveedor_id_proveedor = $4::bigint)
       ORDER BY h.fecha_vigencia_desde DESC, h.historial_precio_id DESC
       LIMIT $5 OFFSET $6`,
      [sku, desde || null, hasta || null, proveedor_id || null, limit, offset]
    );

    const total = rows.length > 0 ? parseInt(rows[0].total_registros, 10) : 0;
    res.json({
      precios: rows.map(({ total_registros, ...r }) => r),
      total,
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
    });
  } catch (err) {
    console.error('Error obteniendo precios:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/materiales/pinturas-sobrantes
 * Lista pinturas sobrantes con stock (CU-125)
 */
async function pinturasSobrantes(req, res) {
  try {
    const { rows } = await query(
      `SELECT
         m.material_sku                               AS sku,
         m.material_nombre_material                   AS nombre,
         m.es_material_pintura_custom                 AS es_custom,
         m.material_pintura_pintura_custom            AS color_custom,
         m.es_material_pintura_no_custom              AS es_no_custom,
         m.material_pintura_no_custom                 AS color_no_custom,
         m.material_estado                            AS estado,
         u.material_unidad_medida_nombre              AS unidad,
         COALESCE(SUM(ib.inventario_bodega_cantidad_fisica), 0)    AS stock_total,
         COALESCE(SUM(ib.inventario_bodega_cantidad_reservada), 0) AS stock_reservado
       FROM material m
       LEFT JOIN material_unidad_medida u
              ON u.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
       LEFT JOIN inventario_bodega ib ON ib.material_sku = m.material_sku
       WHERE (m.es_material_pintura_custom = TRUE OR m.es_material_pintura_no_custom = TRUE)
         AND m.material_estado = 'activo'
       GROUP BY m.material_sku, m.material_nombre_material,
                m.es_material_pintura_custom, m.material_pintura_pintura_custom,
                m.es_material_pintura_no_custom, m.material_pintura_no_custom,
                m.material_estado, u.material_unidad_medida_nombre
       HAVING COALESCE(SUM(ib.inventario_bodega_cantidad_fisica), 0) > 0
       ORDER BY m.material_nombre_material`
    );

    // CU-125 Exc 1
    if (rows.length === 0) {
      return res.json({ pinturas: [], mensaje: 'No existen pinturas registradas como sobrantes' });
    }

    // CU-134 CP2/CP3: Role-based field restriction — JOP should not see cost fields
    const userRole = req.user?.rol || req.user?.perfil || '';
    const isJop = userRole.toLowerCase() === 'jop';

    const pinturas = isJop
      ? rows.map(({ stock_reservado, ...rest }) => rest)  // JOP: hide reserved stock detail
      : rows;

    res.json({ pinturas });
  } catch (err) {
    console.error('Error listando pinturas sobrantes:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/materiales/:sku/comparar-proveedores — CU-65 (UR 7.5).
 *
 * Por proveedor vinculado: precio vigente (= precio referencial de CU-60, Q1),
 * plazo prometido, plazo real promedio y % de cumplimiento de ESTE producto con
 * ese proveedor (consulta base de CU-62, Q4), cantidad mínima y los datos que
 * faltan (Exc 3).
 *
 * Destaques (Q3, por criterio): "menor costo" entre los que tienen precio; "menor
 * plazo" por plazo REAL promedio entre los que tienen historial de entregas. Un
 * empate destaca a todos. Sin destaques con menos de dos proveedores (Exc 1).
 * Montos: al rol jop no se le envía el precio ni el destaque de costo (Q2).
 */
async function compararProveedores(req, res) {
  const { sku } = req.params;
  const esJop = ocultaMontos(req);   // D50: también técnico
  try {
    const { rows: mat } = await query(
      `SELECT material_sku AS sku, material_nombre_material AS nombre FROM material WHERE material_sku = $1`, [sku]
    );
    if (mat.length === 0) return res.status(404).json({ error: 'Material no encontrado' });

    const { rows: provs } = await query(
      `SELECT p.proveedor_id_proveedor                    AS id,
              p.proveedor_razon_social                    AS nombre,
              p.proveedor_estado                          AS estado,
              mp.material_proveedor_proveedor_principal   AS es_principal,
              mp.material_proveedor_precio_referencial    AS precio,
              mp.material_proveedor_tiempo_reposicion     AS plazo,
              mp.material_proveedor_cantidad_minima       AS cantidad_minima
       FROM material_proveedor mp
       JOIN proveedor p ON p.proveedor_id_proveedor = mp.proveedor_id_proveedor
       WHERE mp.material_sku = $1
       ORDER BY mp.material_proveedor_proveedor_principal DESC, p.proveedor_razon_social`,
      [sku]
    );

    // Entregas RECIBIDAS de este producto, por proveedor
    const porProveedor = new Map();
    for (const e of await consultarEntregas({ sku })) {
      if (e.fecha_recepcion == null) continue;
      const k = String(e.proveedor_id);
      if (!porProveedor.has(k)) porProveedor.set(k, []);
      porProveedor.get(k).push(e);
    }

    const filas = provs.map(p => {
      const entregas = porProveedor.get(String(p.id)) || [];
      const r = entregas.length ? resumirEntregas(entregas) : null;
      const precio = p.precio == null || parseFloat(p.precio) <= 0 ? null : parseFloat(p.precio);
      const fila = {
        proveedor_id: p.id,
        nombre: p.nombre,
        estado: p.estado,
        es_principal: p.es_principal === true,
        precio,
        plazo_prometido: p.plazo == null ? null : parseInt(p.plazo),
        plazo_real_promedio: r ? r.promedio_dias : null,
        cumplimiento_pct: r ? r.cumplimiento_pct : null,
        entregas: r ? r.entregas : 0,
        cantidad_minima: p.cantidad_minima == null ? null : parseFloat(p.cantidad_minima),
        faltantes: [],
      };
      if (precio == null && !esJop) fila.faltantes.push('precio vigente');
      if (fila.entregas === 0) fila.faltantes.push('historial de entregas');
      if (esJop) delete fila.precio;
      return fila;
    });

    const alternativas = filas.length >= 2;
    const minimos = (campo) => {
      const conDato = filas.filter(f => f[campo] != null);
      if (!alternativas || conDato.length === 0) return [];
      const min = Math.min(...conDato.map(f => f[campo]));
      return conDato.filter(f => f[campo] === min).map(f => f.proveedor_id);
    };
    const destaques = { menor_plazo: minimos('plazo_real_promedio') };
    if (!esJop) destaques.menor_costo = minimos('precio');

    res.json({ sku: mat[0].sku, producto: mat[0].nombre, alternativas, proveedores: filas, destaques });
  } catch (err) {
    console.error('Error comparando proveedores:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = {
  listar, obtener, crear, actualizar, eliminar,
  listarUnidades, listarCategorias,
  reactivar, duplicar, historialPrecios, listarPrecios, pinturasSobrantes,
  vincularProveedor, compararProveedores
};
