const { query } = require('../db/pool');
const { conTransaccion, ErrorNegocio, responderError } = require('../db/tx');
const { consumoNeto } = require('../db/historico');
const auditoria = require('./auditoriaController');

// CU-126: tipos del retiro de insumos (picking). No dependen del stock: el evaluador de
// stock no los cierra ni los cuenta. Nombres normalizados (minúscula, '_' → espacio).
const TIPO_UBICACION_INCORRECTA = 'ubicacion incorrecta';
const TIPO_FALTANTE_RETIRO = 'faltante en retiro';
const TIPOS_RETIRO = [TIPO_UBICACION_INCORRECTA, TIPO_FALTANTE_RETIRO];

/**
 * GET /api/alertas
 * Devuelve alertas activas calculadas en tiempo real desde el stock
 * cruzando con stock_minimo, stock_critico y tiempos de reposición (FR-32, FR-35)
 * Query params: ?prioridad=&estado=&tipo=&solo_criticos=  — los 4 se combinan con AND (OPUS-17)
 */
async function listar(req, res) {
  const { prioridad, estado, tipo } = req.query;
  // El checkbox llega como texto ('true' / '1'); cualquier otra cosa equivale a no filtrar.
  const soloCriticos = ['true', '1'].includes(String(req.query.solo_criticos).toLowerCase());
  try {
    const { rows } = await query(
      `SELECT
         a.alerta_inventario_id_alerta                                           AS id,
         a.alerta_inventario_mensaje                                             AS mensaje,
         a.alerta_inventario_fecha_generacion                                    AS fecha_generacion,
         a.alerta_inventario_fecha_est_agotamiento                               AS fecha_est_agotamiento,
         a.alerta_inventario_estado                                              AS estado,
         a.material_sku                                                          AS sku,
         m.material_nombre_material                                              AS producto,
         m.material_material_critico                                             AS es_critico,
         m.material_stock_minimo                                                 AS stock_minimo,
         m.material_stock_critico                                                AS stock_critico,
         ta.alerta_inventario_tipo_alerta_nombre                                 AS tipo,
         np.alerta_inventario_prioridad_nombre                                   AS prioridad,
         -- Stock actual consolidado
         COALESCE(SUM(ib.inventario_bodega_cantidad_fisica), 0)                  AS stock_actual,
         -- CU-48: el proveedor de la alerta (el recomendado por CU-47) si lo tiene;
         -- si no, el principal
         COALESCE(pa.proveedor_razon_social, p.proveedor_razon_social)           AS proveedor,
         CASE WHEN a.proveedor_id_proveedor IS NOT NULL
              THEN mpa.material_proveedor_tiempo_reposicion
              ELSE mp.material_proveedor_tiempo_reposicion END                   AS tiempo_reposicion,
         a.alerta_inventario_cantidad_sugerida                                   AS cantidad_sugerida,
         -- CU-57: alertas por diferencia de inventario
         a.conteo_ciclico_id_conteo                                              AS conteo_id,
         bd.bodega_nombre_bodega                                                 AS bodega,
         a.alerta_inventario_diferencia                                          AS diferencia,
         a.alerta_inventario_diferencia_pct                                      AS diferencia_pct
       FROM alerta_inventario a
       JOIN material m ON m.material_sku = a.material_sku
       LEFT JOIN bodega bd ON bd.bodega_id_bodega = a.bodega_id_bodega
       JOIN alerta_inventario_tipo_alerta ta
            ON ta.alerta_inventario_tipo_alerta_id_tipo_alerta = a.alerta_inventario_tipo_alerta_id_tipo_alerta
       JOIN alerta_inventario_nivel_prioridad np
            ON np.alerta_inventario_nivel_prioridad_id_nivel_prioridad = ta.alerta_inventario_nivel_prioridad_id
       LEFT JOIN inventario_bodega ib ON ib.material_sku = a.material_sku
       LEFT JOIN material_proveedor mp
            ON mp.material_sku = a.material_sku
           AND mp.material_proveedor_proveedor_principal = TRUE
       LEFT JOIN proveedor p ON p.proveedor_id_proveedor = mp.proveedor_id_proveedor
       LEFT JOIN proveedor pa ON pa.proveedor_id_proveedor = a.proveedor_id_proveedor
       LEFT JOIN material_proveedor mpa
            ON mpa.material_sku = a.material_sku
           AND mpa.proveedor_id_proveedor = a.proveedor_id_proveedor
       WHERE ($1::text IS NULL OR np.alerta_inventario_prioridad_nombre ILIKE $1)
         AND ($2::text IS NULL OR a.alerta_inventario_estado ILIKE $2)
         AND ($3::text IS NULL OR LOWER(ta.alerta_inventario_tipo_alerta_nombre) = LOWER($3))
         AND ($4::boolean IS NOT TRUE OR m.material_material_critico = TRUE)
       GROUP BY
         a.alerta_inventario_id_alerta, a.alerta_inventario_mensaje,
         a.alerta_inventario_fecha_generacion, a.alerta_inventario_fecha_est_agotamiento,
         a.alerta_inventario_estado, a.material_sku,
         m.material_nombre_material, m.material_material_critico,
         m.material_stock_minimo, m.material_stock_critico,
         ta.alerta_inventario_tipo_alerta_nombre,
         np.alerta_inventario_prioridad_nombre,
         p.proveedor_razon_social,
         mp.material_proveedor_tiempo_reposicion,
         pa.proveedor_razon_social,
         mpa.material_proveedor_tiempo_reposicion,
         bd.bodega_nombre_bodega
       ORDER BY
         CASE np.alerta_inventario_prioridad_nombre
           WHEN 'urgente' THEN 0
           WHEN 'alta'    THEN 1
           ELSE 2
         END,
         a.alerta_inventario_fecha_generacion ASC`,
      [prioridad || null, estado || null, tipo || null, soloCriticos]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listando alertas:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/alertas/tipos
 * Tipos de alerta disponibles para el filtro (OPUS-17). Solo devuelve los que tienen
 * al menos una alerta: el catálogo trae tipos que nunca se usan y llenarían el select
 * de opciones que no filtran nada.
 */
async function listarTipos(req, res) {
  try {
    const { rows } = await query(
      `SELECT DISTINCT ta.alerta_inventario_tipo_alerta_nombre AS nombre
         FROM alerta_inventario a
         JOIN alerta_inventario_tipo_alerta ta
              ON ta.alerta_inventario_tipo_alerta_id_tipo_alerta = a.alerta_inventario_tipo_alerta_id_tipo_alerta
        WHERE ta.alerta_inventario_tipo_alerta_nombre IS NOT NULL
        ORDER BY 1`
    );
    res.json(rows.map(r => r.nombre));
  } catch (err) {
    console.error('Error listando tipos de alerta:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/alertas/generar
 * Genera alertas automáticamente comparando stock actual vs umbrales (FR-32, FR-35)
 * Se llama después de cada movimiento de inventario
 */
async function generar(req, res) {
  try {
    const generadas = await generarAlertasAutomaticas();
    // D59: la llaman solos el Dashboard y Alertas al abrirse. Es una revisión del sistema:
    // se audita solo si generó algo (antes, la mitad de la auditoría era "0 alerta(s)").
    if (generadas > 0) {
      await auditoria.registrar(auditoria.USUARIO_SISTEMA, 'generar_alertas', `${generadas} alerta(s) generada(s)`);
    }
    res.json({ message: `${generadas} alerta(s) generada(s)`, total: generadas });
  } catch (err) {
    console.error('Error generando alertas:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * Lógica central de generación de alertas (FR-32, FR-35)
 * Reutilizable desde movimientos también
 */
async function generarAlertasAutomaticas() {
  // Obtener tipos de alerta y niveles de prioridad
  const { rows: tipos } = await query(
    `SELECT ta.alerta_inventario_tipo_alerta_id_tipo_alerta AS id,
            ta.alerta_inventario_tipo_alerta_nombre AS nombre,
            np.alerta_inventario_nivel_prioridad_id_nivel_prioridad AS prioridad_id,
            np.alerta_inventario_prioridad_nombre AS prioridad_nombre
     FROM alerta_inventario_tipo_alerta ta
     JOIN alerta_inventario_nivel_prioridad np
          ON np.alerta_inventario_nivel_prioridad_id_nivel_prioridad = ta.alerta_inventario_nivel_prioridad_id`
  );

  // Stock actual por material
  const { rows: stocks } = await query(
    `SELECT
       m.material_sku                                                    AS material_sku,
       m.material_nombre_material                                        AS nombre,
       m.material_stock_minimo                                           AS stock_minimo,
       m.material_stock_critico                                          AS stock_critico,
       m.material_stock_maximo                                           AS stock_maximo,
       m.material_material_critico                                       AS es_critico,
       COALESCE(SUM(ib.inventario_bodega_cantidad_fisica), 0)            AS stock_actual,
       mp.material_proveedor_tiempo_reposicion                           AS tiempo_reposicion
     FROM material m
     LEFT JOIN inventario_bodega ib ON ib.material_sku = m.material_sku
     LEFT JOIN material_proveedor mp
          ON mp.material_sku = m.material_sku
         AND mp.material_proveedor_proveedor_principal = TRUE
     WHERE m.material_estado = 'activo'
       AND m.material_stock_minimo IS NOT NULL
       -- CU-123: un insumo especial no genera alertas de stock (igual que en CU-47)
       AND m.material_es_rotativo IS DISTINCT FROM FALSE
     GROUP BY m.material_sku, m.material_nombre_material,
              m.material_stock_minimo, m.material_stock_critico,
              m.material_stock_maximo, m.material_material_critico,
              mp.material_proveedor_tiempo_reposicion`
  );

  let generadas = 0;
  const normalize = (str) => str.toLowerCase().replace(/_/g, ' ').trim();
  // CU-47: las alertas de reposición no las cierra ni las cuenta el generador.
  // CU-126: las del retiro de insumos tampoco (no dependen del stock).
  // Los ids van como parámetro y no como subconsulta: así cada sentencia toca una
  // sola tabla del catálogo (una subconsulta extra provocó deadlocks con el
  // TRUNCATE de los tests, porque el generador corre sin await tras los consumos).
  const idsReposicion = tipos.filter(t => ['tiempo reposicion', ...TIPOS_RETIRO].includes(normalize(t.nombre))).map(t => t.id);

  for (const s of stocks) {
    const stockActual = parseFloat(s.stock_actual);
    const stockMin    = parseFloat(s.stock_minimo  || 0);
    const stockCrit   = parseFloat(s.stock_critico || 0);

    // FIX CU-42: Solo generar alerta cuando stock está BAJO el umbral
    // Determinar si necesita alerta y qué tipo (FR-35)
    //
    // OJO: la prioridad NO se decide acá. Es una propiedad del TIPO de alerta
    // (alerta_inventario_tipo_alerta.alerta_inventario_nivel_prioridad_id), así
    // que al elegir el tipo ya queda determinada. Hasta ahora este bloque
    // calculaba un `prioridadNombre` que nunca se usaba y que hacía creer lo
    // contrario. Consecuencia a tener presente: la prioridad no puede variar
    // según si el material es crítico — es fija por tipo.
    let tipoNombre = null;

    if (stockActual <= stockCrit && stockCrit > 0) {
      tipoNombre = 'stock critico';
    } else if (stockActual <= stockMin && stockMin > 0) {
      tipoNombre = 'stock bajo minimo';
    }
    // CU-47: las alertas 'tiempo reposicion' ya no salen de aquí (antes: stock <=
    // mínimo × 1,2 con el plazo del principal). Las genera evaluarReposicion con la
    // cobertura real: días de stock contra plazo del proveedor.
    // NOTA: Se elimina la alerta de stock_maximo (sobrestock) porque generaba
    // alertas incoherentes cuando el stock estaba SOBRE el umbral (CU-42 CP1/2)

    console.log(`[Alertas] ${s.material_sku}: stock=${stockActual} min=${stockMin} crit=${stockCrit} → tipo=${tipoNombre || 'ninguno'}`);
    if (!tipoNombre) {
      // Si no necesita alerta, resolver alertas activas previas para este SKU.
      // CU-57: solo las de STOCK. Una alerta por diferencia de conteo (con
      // conteo_ciclico_id_conteo) no depende del stock actual y no se cierra sola.
      // CU-47: las de reposición tampoco; las cierra la reevaluación de cobertura.
      // CU-55 (Q2): el cierre automático registra la fecha de resolución, sin usuario
      // (el historial lo muestra como "Sistema"). Antes solo cambiaba el estado y el
      // tiempo de resolución de estas alertas —las más comunes— no se podía medir.
      // Dos sentencias de una sola tabla cada una, en una transacción.
      await conTransaccion(async (client) => {
        const { rows: cerradas } = await client.query(
          `UPDATE alerta_inventario SET alerta_inventario_estado = 'resuelta'
           WHERE material_sku = $1 AND alerta_inventario_estado = 'activa'
             AND conteo_ciclico_id_conteo IS NULL
             AND NOT (alerta_inventario_tipo_alerta_id_tipo_alerta = ANY($2::bigint[]))
           RETURNING historial_alerta_id_historial AS hist`,
          [s.material_sku, idsReposicion]
        );
        const hists = cerradas.map(c => c.hist).filter(Boolean);
        if (hists.length > 0) {
          await client.query(
            `UPDATE historial_alerta SET historial_alerta_fecha_hora_resolucion = now()
             WHERE historial_alerta_id_historial = ANY($1::bigint[])
               AND historial_alerta_fecha_hora_resolucion IS NULL`,
            [hists]
          );
        }
      });
      continue;
    }

    // FIX CU-42 CP3: Verificar si ya existe CUALQUIER alerta activa para este SKU
    // (no solo del mismo tipo) para evitar duplicadas
    //
    // El match es EXACTO (sobre el nombre normalizado), no un `includes`. Con
    // includes, "stock critico" coincidia con DOS tipos del catalogo a la vez
    // ('stock_critico' y 'stock critico') y `find` se quedaba con el primero que
    // devolviera Postgres — un orden que la consulta no fija. O sea que el tipo de
    // las alertas nuevas dependia del orden fisico de las filas. Los duplicados ya
    // se consolidaron, pero el match exacto evita que vuelva a pasar si alguien
    // agrega un tipo con un nombre parecido.
    const tipo = tipos.find(t => normalize(t.nombre) === tipoNombre);
    if (!tipo) {
      console.warn(`[Alertas] no existe el tipo "${tipoNombre}" en el catálogo; ${s.material_sku} queda sin alerta`);
      continue;
    }

    // CU-57: una alerta por diferencia de conteo activa no impide la alerta de stock
    // CU-47: una alerta preventiva de reposición tampoco
    const { rows: existe } = await query(
      `SELECT a.alerta_inventario_id_alerta FROM alerta_inventario a
       LEFT JOIN historial_alerta ha ON ha.historial_alerta_id_historial = a.historial_alerta_id_historial
       WHERE a.material_sku = $1
         AND a.conteo_ciclico_id_conteo IS NULL
         AND NOT (a.alerta_inventario_tipo_alerta_id_tipo_alerta = ANY($2::bigint[]))
         AND (a.alerta_inventario_estado = 'activa'
              OR (a.alerta_inventario_estado = 'resuelta'
                  AND ha.historial_alerta_fecha_hora_resolucion > now() - INTERVAL '24 hours'))`,
      [s.material_sku, idsReposicion]
    );

    if (existe.length > 0) continue; // Ya existe alerta activa para este SKU

    // Crear historial para esta alerta (FR-37)
    const { rows: hist } = await query(
      `INSERT INTO historial_alerta DEFAULT VALUES
       RETURNING historial_alerta_id_historial AS id`
    );

    // Crear alerta
    await query(
      `INSERT INTO alerta_inventario (
         alerta_inventario_mensaje,
         alerta_inventario_estado,
         material_sku,
         alerta_inventario_tipo_alerta_id_tipo_alerta,
         historial_alerta_id_historial
       ) VALUES ($1, 'activa', $2, $3, $4)`,
      [
        `Stock actual (${stockActual}) ${tipoNombre === 'tiempo reposicion' ? 'próximo a umbral mínimo considerando tiempo de reposición' : tipoNombre === 'stock critico' ? 'en nivel crítico' : 'bajo el mínimo definido'}`,
        s.material_sku,
        tipo.id,
        hist[0].id
      ]
    );
    generadas++;
  }

  // CU-45: notificar a JOP sobre nuevas alertas
  if (generadas > 0) {
    try {
      const { notificarPorRol } = require('./notificacionesController');
      notificarPorRol({
        tipo: 'alerta_stock',
        mensaje: `Se generaron ${generadas} alerta(s) de inventario. Revise el panel de alertas.`,
        origen: 'alertas',
        rol: 'jop'
      });
    } catch (e) {
      console.warn('No se pudieron crear notificaciones:', e.message);
    }
  }

  // Sesión 15: una stock_critico de CU-47 ("sin stock disponible") de un producto SIN
  // stock_minimo no la evaluaba el bucle de arriba y quedaba activa aunque volviera el
  // stock. Se resuelve cuando el disponible (físico − reservado) vuelve a ser mayor que 0.
  // Las de conteo (con conteo_ciclico_id_conteo) no dependen del stock y no se tocan.
  const idCritico = tipos.find(t => normalize(t.nombre) === 'stock critico')?.id;
  if (idCritico) {
    await conTransaccion(async (client) => {
      const { rows: repuestas } = await client.query(
        `SELECT a.alerta_inventario_id_alerta AS id
         FROM alerta_inventario a
         JOIN material m ON m.material_sku = a.material_sku
         WHERE a.alerta_inventario_estado = 'activa'
           AND a.alerta_inventario_tipo_alerta_id_tipo_alerta = $1
           AND a.conteo_ciclico_id_conteo IS NULL
           AND m.material_stock_minimo IS NULL
           AND (SELECT COALESCE(SUM(ib.inventario_bodega_cantidad_fisica - ib.inventario_bodega_cantidad_reservada), 0)
                FROM inventario_bodega ib WHERE ib.material_sku = a.material_sku) > 0
         FOR UPDATE OF a`,
        [idCritico]
      );
      await resolverAlertas(client, repuestas.map(x => x.id));
    });
  }

  return generadas;
}

/**
 * PUT /api/alertas/:id/resolver
 * Marca una alerta como resuelta y registra la fecha (FR-37) y QUIÉN la resolvió
 * (CU-55). En una transacción: antes eran dos UPDATE sueltos.
 * CU-55 (Q3): una alerta ya resuelta da 400; antes se volvía a "resolver" y se
 * pisaba su fecha de resolución, que es lo que mide el historial.
 */
async function resolver(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ error: 'Alerta no encontrada' });
  }
  try {
    await conTransaccion(async (client) => {
      const { rows } = await client.query(
        `SELECT alerta_inventario_estado AS estado, historial_alerta_id_historial AS hist
         FROM alerta_inventario WHERE alerta_inventario_id_alerta = $1 FOR UPDATE`,
        [id]
      );
      if (rows.length === 0) throw new ErrorNegocio(404, { error: 'Alerta no encontrada' });
      if (rows[0].estado === 'resuelta') {
        throw new ErrorNegocio(400, { error: 'Esta alerta ya fue resuelta.' });
      }

      // Alertas antiguas sin fila de historial: se crea para poder registrar la resolución
      let hist = rows[0].hist;
      if (!hist) {
        const { rows: h } = await client.query(
          `INSERT INTO historial_alerta DEFAULT VALUES RETURNING historial_alerta_id_historial AS id`
        );
        hist = h[0].id;
        await client.query(
          `UPDATE alerta_inventario SET historial_alerta_id_historial = $2 WHERE alerta_inventario_id_alerta = $1`,
          [id, hist]
        );
      }

      await client.query(
        `UPDATE historial_alerta
         SET historial_alerta_fecha_hora_resolucion = now(), usuario_id_usuario = $2
         WHERE historial_alerta_id_historial = $1`,
        [hist, req.user.id]
      );
      await client.query(
        `UPDATE alerta_inventario SET alerta_inventario_estado = 'resuelta'
         WHERE alerta_inventario_id_alerta = $1`,
        [id]
      );
    });

    await auditoria.registrar(req.user?.id, 'resolver_alerta', `Alerta ID ${id} marcada como resuelta`);
    res.json({ message: 'Alerta marcada como resuelta' });
  } catch (err) {
    responderError(res, err, 'Error resolviendo alerta:');
  }
}

/* ══════════════════════════════════════════════════════════════════════
   CU-47: evaluación de cobertura de stock contra el plazo del proveedor
   ══════════════════════════════════════════════════════════════════════ */

const DIAS_CONSUMO = 90;   // ventana del consumo promedio diario

/** Redondea hacia arriba a 2 decimales (hay productos en kg y metros). */
const arriba2 = (v) => Math.ceil(v * 100 - 1e-9) / 100;

/** Plazo del proveedor (días hábiles, V2) → días corridos, para compararlo con la cobertura. */
const plazoCorrido = (habiles) => Math.ceil(habiles * 7 / 5);

/** Fecha local YYYY-MM-DD de hoy + n días. Nunca desde toISOString(), que es UTC. */
function fechaEnDias(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Proveedor recomendado (decisión del usuario, P7): el PRINCIPAL si tiene plazo,
 * porque por algo es el principal. Si otro entrega antes o tiene mejor precio se
 * avisa en las notas, sin montos (el rol jop no ve precios). Sin principal con
 * plazo, el de menor plazo (empate: menor precio).
 */
function elegirProveedor(provs) {
  const conPlazo = provs.filter(p => p.plazo > 0);
  const principal = provs.find(p => p.principal);
  const notas = [];

  let rec = conPlazo.find(p => p.principal);
  if (!rec) {
    rec = [...conPlazo].sort((a, b) => a.plazo - b.plazo || (a.precio ?? Infinity) - (b.precio ?? Infinity))[0] || null;
    if (rec) {
      notas.push(principal
        ? `El proveedor principal (${principal.nombre}) no tiene plazo registrado: se usa el de menor plazo.`
        : 'El producto no tiene proveedor principal: se usa el de menor plazo.');
    }
    return { rec, notas };
  }

  const masRapido = conPlazo.filter(p => p.id !== rec.id && p.plazo < rec.plazo)
    .sort((a, b) => a.plazo - b.plazo)[0];
  if (masRapido) {
    notas.push(`${masRapido.nombre} entrega en ${masRapido.plazo} días hábiles (el principal, en ${rec.plazo}).`);
  }
  const masBarato = provs.filter(p => p.id !== rec.id && p.precio != null && rec.precio != null && p.precio < rec.precio)
    .sort((a, b) => a.precio - b.precio)[0];
  if (masBarato) notas.push(`${masBarato.nombre} tiene un precio referencial menor que el principal.`);
  return { rec, notas };
}

/** Marca como resueltas las alertas indicadas y fecha su historial (FR-37). */
async function resolverAlertas(client, ids) {
  if (ids.length === 0) return;
  await client.query(
    `UPDATE historial_alerta ha SET historial_alerta_fecha_hora_resolucion = now()
     FROM alerta_inventario a
     WHERE a.historial_alerta_id_historial = ha.historial_alerta_id_historial
       AND a.alerta_inventario_id_alerta = ANY($1::bigint[])`,
    [ids]
  );
  await client.query(
    `UPDATE alerta_inventario SET alerta_inventario_estado = 'resuelta'
     WHERE alerta_inventario_id_alerta = ANY($1::bigint[])`,
    [ids]
  );
}

/**
 * Crea la alerta, o actualiza la activa del mismo tipo y SKU si ya existe
 * (no se duplican). Devuelve 'nueva' | 'actualizada'.
 */
async function upsertAlerta(client, { tipoId, sku, mensaje, fechaAgotamiento, proveedorId, cantidadSugerida }) {
  const { rows: activa } = await client.query(
    `SELECT alerta_inventario_id_alerta AS id FROM alerta_inventario
     WHERE material_sku = $1 AND alerta_inventario_tipo_alerta_id_tipo_alerta = $2
       AND alerta_inventario_estado = 'activa' AND conteo_ciclico_id_conteo IS NULL
     ORDER BY alerta_inventario_id_alerta LIMIT 1
     FOR UPDATE`,
    [sku, tipoId]
  );
  if (activa.length > 0) {
    await client.query(
      `UPDATE alerta_inventario
       SET alerta_inventario_mensaje = $2, alerta_inventario_fecha_est_agotamiento = $3,
           proveedor_id_proveedor = $4, alerta_inventario_cantidad_sugerida = $5
       WHERE alerta_inventario_id_alerta = $1`,
      [activa[0].id, mensaje, fechaAgotamiento, proveedorId, cantidadSugerida]
    );
    return 'actualizada';
  }
  const { rows: hist } = await client.query(
    `INSERT INTO historial_alerta DEFAULT VALUES RETURNING historial_alerta_id_historial AS id`
  );
  await client.query(
    `INSERT INTO alerta_inventario (
       alerta_inventario_mensaje, alerta_inventario_estado, material_sku,
       alerta_inventario_tipo_alerta_id_tipo_alerta, historial_alerta_id_historial,
       alerta_inventario_fecha_est_agotamiento, proveedor_id_proveedor, alerta_inventario_cantidad_sugerida
     ) VALUES ($1, 'activa', $2, $3, $4, $5, $6, $7)`,
    [mensaje, sku, tipoId, hist[0].id, fechaAgotamiento, proveedorId, cantidadSugerida]
  );
  return 'nueva';
}

/**
 * POST /api/alertas/reposicion/evaluar — CU-47, gerencia y jop.
 *
 * Por producto (activo, rotativo, no descontinuado, no herramienta):
 *   stock disponible = físico − reservado (P4)
 *   consumo diario   = consumo neto de los últimos 90 días ÷ 90 (P1): salidas vigentes
 *                      (sin revertidas ni inversos, sin traslados) menos las devoluciones
 *                      de consumo (motivo devolucion_consumo, o entradas con OT)
 *   Exc 3: disponible <= 0      → alerta 'stock_critico' (quiebre confirmado) (P5: va primero)
 *   Exc 2: consumo diario = 0   → "sin rotación", sin alerta
 *   Exc 1: sin proveedor activo con plazo → "pendiente de configuración", sin alerta
 *   días restantes = disponible ÷ consumo; plazo en días corridos = hábiles × 7/5 (P2)
 *   días <= plazo → alerta preventiva 'tiempo reposicion'
 *   cantidad sugerida = max(stock máximo − disponible, consumo × plazo, mínimo de compra) (P3)
 *
 * Las preventivas activas de productos que ya no están en riesgo se resuelven.
 * Todo en una transacción; la auditoría va después del COMMIT.
 */
async function evaluarReposicion(req, res) {
  try {
    const r = await conTransaccion(async (client) => {
      const { rows: tipos } = await client.query(
        `SELECT alerta_inventario_tipo_alerta_id_tipo_alerta AS id,
                LOWER(REPLACE(alerta_inventario_tipo_alerta_nombre, '_', ' ')) AS nombre
         FROM alerta_inventario_tipo_alerta`
      );
      const tipoRepo = tipos.find(t => t.nombre === 'tiempo reposicion');
      const tipoCrit = tipos.find(t => t.nombre === 'stock critico');
      if (!tipoRepo || !tipoCrit) {
        throw new Error('Faltan los tipos de alerta "tiempo reposicion" o "stock critico" en el catálogo');
      }

      const { rows: materiales } = await client.query(
        `SELECT m.material_sku AS sku, m.material_nombre_material AS nombre,
                m.material_stock_maximo AS stock_maximo,
                COALESCE(st.fisica, 0) - COALESCE(st.reservada, 0) AS disponible
         FROM material m
         LEFT JOIN (SELECT material_sku,
                           SUM(inventario_bodega_cantidad_fisica)    AS fisica,
                           SUM(inventario_bodega_cantidad_reservada) AS reservada
                    FROM inventario_bodega GROUP BY material_sku) st ON st.material_sku = m.material_sku
         WHERE m.material_estado = 'activo'
           AND m.material_es_rotativo IS DISTINCT FROM FALSE
           AND m.material_descontinuado IS NOT TRUE
           AND m.material_es_herramienta IS NOT TRUE
         ORDER BY m.material_sku`
      );

      // Misma regla de consumo que la rotación (CU-71): vive en db/historico.js
      const netoPorSku = await consumoNeto(client, {
        desde: new Date(Date.now() - DIAS_CONSUMO * 86400000),
      });

      const { rows: provRows } = await client.query(
        `SELECT mp.material_sku AS sku, mp.proveedor_id_proveedor AS id, p.proveedor_razon_social AS nombre,
                mp.material_proveedor_tiempo_reposicion AS plazo,
                mp.material_proveedor_precio_referencial AS precio,
                mp.material_proveedor_proveedor_principal AS principal,
                mp.material_proveedor_cantidad_minima AS cantidad_minima
         FROM material_proveedor mp
         JOIN proveedor p ON p.proveedor_id_proveedor = mp.proveedor_id_proveedor
         WHERE p.proveedor_estado = 'activo'`
      );
      const provsPorSku = new Map();
      for (const p of provRows) {
        const lista = provsPorSku.get(p.sku) || [];
        lista.push({
          id: p.id, nombre: p.nombre, principal: p.principal === true,
          plazo: p.plazo == null ? null : parseInt(p.plazo),
          precio: p.precio == null ? null : parseFloat(p.precio),
          cantidadMinima: p.cantidad_minima == null ? 0 : parseFloat(p.cantidad_minima),
        });
        provsPorSku.set(p.sku, lista);
      }

      const salida = {
        evaluados: materiales.length, criticas: [], preventivas: [],
        sin_rotacion: [], pendientes_configuracion: [], nuevas: 0, actualizadas: 0, resueltas: 0,
      };
      const skusPreventivos = [];

      for (const m of materiales) {
        const disponible = parseFloat(m.disponible);
        const consumoDiario = Math.max(netoPorSku.get(m.sku) || 0, 0) / DIAS_CONSUMO;
        const { rec, notas } = elegirProveedor(provsPorSku.get(m.sku) || []);
        const plazo = rec ? plazoCorrido(rec.plazo) : null;
        const stockMax = m.stock_maximo == null ? null : parseFloat(m.stock_maximo);
        const sugerida = arriba2(Math.max(
          stockMax != null ? stockMax - Math.max(disponible, 0) : 0,
          plazo ? consumoDiario * plazo : 0,
          rec ? rec.cantidadMinima : 0,
        ));
        const base = { sku: m.sku, nombre: m.nombre, stock_disponible: disponible };

        // Exc 3: quiebre confirmado (va antes que las otras excepciones, P5)
        if (disponible <= 0) {
          const mensaje = 'Quiebre de stock confirmado: sin stock disponible.' +
            (rec ? ` Reponer con ${rec.nombre} (${rec.plazo} días hábiles).` : ' Sin proveedor con plazo registrado.') +
            (notas.length ? ' ' + notas.join(' ') : '');
          const r = await upsertAlerta(client, {
            tipoId: tipoCrit.id, sku: m.sku, mensaje, fechaAgotamiento: fechaEnDias(0),
            proveedorId: rec?.id || null, cantidadSugerida: sugerida > 0 ? sugerida : null,
          });
          salida[r === 'nueva' ? 'nuevas' : 'actualizadas']++;
          salida.criticas.push({
            ...base, proveedor: rec?.nombre || null, plazo_dias_habiles: rec?.plazo ?? null,
            plazo_dias_corridos: plazo, cantidad_sugerida: sugerida > 0 ? sugerida : null, notas, alerta: r,
          });
          continue;
        }
        // Exc 2: sin rotación
        if (consumoDiario <= 0) { salida.sin_rotacion.push(base); continue; }
        // Exc 1: sin proveedor con plazo
        if (!rec) {
          salida.pendientes_configuracion.push({
            ...base,
            motivo: (provsPorSku.get(m.sku) || []).length ? 'Ningún proveedor activo tiene plazo de reposición' : 'Sin proveedor asociado',
          });
          continue;
        }

        const dias = disponible / consumoDiario;
        if (dias > plazo) continue;

        const diasTxt = Math.floor(dias * 10) / 10;
        const mensaje = `Cobertura de ${diasTxt} día(s) ≤ plazo de ${plazo} días corridos ` +
          `(${rec.plazo} hábiles) de ${rec.nombre}. Reordenar ${sugerida}.` +
          (notas.length ? ' ' + notas.join(' ') : '');
        const r = await upsertAlerta(client, {
          tipoId: tipoRepo.id, sku: m.sku, mensaje, fechaAgotamiento: fechaEnDias(Math.floor(dias)),
          proveedorId: rec.id, cantidadSugerida: sugerida,
        });
        salida[r === 'nueva' ? 'nuevas' : 'actualizadas']++;
        skusPreventivos.push(m.sku);
        salida.preventivas.push({
          ...base, dias_restantes: diasTxt, plazo_dias_corridos: plazo, plazo_dias_habiles: rec.plazo,
          proveedor: rec.nombre, cantidad_sugerida: sugerida, notas, alerta: r,
        });
      }

      // Preventivas activas que ya no corresponden (sin riesgo, quiebre, sin rotación,
      // sin configuración o producto fuera de la evaluación): se resuelven.
      const { rows: obsoletas } = await client.query(
        `SELECT alerta_inventario_id_alerta AS id FROM alerta_inventario
         WHERE alerta_inventario_estado = 'activa'
           AND alerta_inventario_tipo_alerta_id_tipo_alerta = $1
           AND NOT (material_sku = ANY($2::text[]))`,
        [tipoRepo.id, skusPreventivos]
      );
      await resolverAlertas(client, obsoletas.map(o => o.id));
      salida.resueltas = obsoletas.length;
      return salida;
    });

    const enRiesgo = r.criticas.length + r.preventivas.length;
    await auditoria.registrar(req.user?.id, 'evaluar_reposicion',
      `${enRiesgo} en riesgo (${r.criticas.length} críticos, ${r.preventivas.length} preventivos)`);

    res.json({
      message: enRiesgo === 0
        ? 'Ningún producto en riesgo de quiebre antes de la reposición.'
        : `${enRiesgo} producto(s) en riesgo: ${r.criticas.length} crítico(s) y ${r.preventivas.length} preventivo(s).`,
      en_riesgo: enRiesgo,
      ...r,
    });
  } catch (err) {
    console.error('Error evaluando reposición:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/alertas/reposicion — CU-48, gerencia y jop.
 *
 * Panel de reposición: alertas ACTIVAS 'tiempo reposicion' (preventivas) y
 * 'stock_critico' (críticas), sin las de conteo. Las críticas que creó el
 * generador automático y todavía no se evaluaron vienen sin fecha, proveedor ni
 * cantidad (Q1: se muestran igual, un quiebre es un quiebre).
 *
 *   stock_disponible = físico − reservado, al momento
 *   dias_restantes   = fecha estimada de agotamiento − hoy (la fija CU-47 al evaluar)
 *   plazo            = el del proveedor DE LA ALERTA, en hábiles y en corridos (× 7/5)
 *   categoria        = clasificación del producto (Fierro, Pintura, Madera...) (Q2)
 *
 * Orden: críticas primero; luego menos días restantes. Sin montos.
 */
async function listarReposicion(req, res) {
  try {
    const { rows } = await query(
      `SELECT a.alerta_inventario_id_alerta                                    AS id,
              a.material_sku                                                   AS sku,
              m.material_nombre_material                                       AS producto,
              cc.material_clasificacion_categoria_nombre_categoria             AS categoria,
              CASE WHEN LOWER(REPLACE(ta.alerta_inventario_tipo_alerta_nombre, '_', ' ')) = 'stock critico'
                   THEN 'critica' ELSE 'preventiva' END                        AS urgencia,
              COALESCE(st.disponible, 0)                                       AS stock_disponible,
              to_char(a.alerta_inventario_fecha_est_agotamiento, 'YYYY-MM-DD') AS fecha_agotamiento,
              a.alerta_inventario_fecha_est_agotamiento::date - CURRENT_DATE   AS dias_restantes,
              p.proveedor_razon_social                                         AS proveedor,
              mp.material_proveedor_tiempo_reposicion                          AS plazo_dias_habiles,
              a.alerta_inventario_cantidad_sugerida                            AS cantidad_sugerida,
              a.alerta_inventario_mensaje                                      AS observaciones,
              a.alerta_inventario_fecha_generacion                             AS fecha_generacion
       FROM alerta_inventario a
       JOIN material m ON m.material_sku = a.material_sku
       JOIN alerta_inventario_tipo_alerta ta
            ON ta.alerta_inventario_tipo_alerta_id_tipo_alerta = a.alerta_inventario_tipo_alerta_id_tipo_alerta
       LEFT JOIN material_clasificacion_nivel_especifico cn
              ON cn.material_clasificacion_nivel_especifico_id = m.material_clasificacion_nivel_especifico_id
       LEFT JOIN material_clasificacion_subcategoria cs2
              ON cs2.material_clasificacion_subcategoria_id = cn.material_clasificacion_subcategoria_id
       LEFT JOIN material_clasificacion_categoria cc
              ON cc.material_clasificacion_categoria_id = cs2.material_clasificacion_categoria_id
       LEFT JOIN (SELECT material_sku,
                         SUM(inventario_bodega_cantidad_fisica - inventario_bodega_cantidad_reservada) AS disponible
                  FROM inventario_bodega GROUP BY material_sku) st ON st.material_sku = a.material_sku
       LEFT JOIN proveedor p ON p.proveedor_id_proveedor = a.proveedor_id_proveedor
       LEFT JOIN material_proveedor mp
              ON mp.material_sku = a.material_sku AND mp.proveedor_id_proveedor = a.proveedor_id_proveedor
       WHERE a.alerta_inventario_estado = 'activa'
         AND a.conteo_ciclico_id_conteo IS NULL
         AND LOWER(REPLACE(ta.alerta_inventario_tipo_alerta_nombre, '_', ' ')) IN ('tiempo reposicion', 'stock critico')
       ORDER BY CASE WHEN LOWER(REPLACE(ta.alerta_inventario_tipo_alerta_nombre, '_', ' ')) = 'stock critico' THEN 0 ELSE 1 END,
                dias_restantes ASC NULLS LAST,
                m.material_nombre_material`
    );
    res.json(rows.map(r => ({
      ...r,
      stock_disponible:    parseFloat(r.stock_disponible),
      cantidad_sugerida:   r.cantidad_sugerida == null ? null : parseFloat(r.cantidad_sugerida),
      plazo_dias_corridos: r.plazo_dias_habiles == null ? null : plazoCorrido(r.plazo_dias_habiles),
    })));
  } catch (err) {
    console.error('Error listando alertas de reposición:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/* ══════════════════════════════════════════════════════════════════════
   CU-55: historial de alertas (inventario, incluidas las de conteo)
   ══════════════════════════════════════════════════════════════════════ */

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;
const LIMITE_HISTORIAL = 500;
// CU-76: la exportación trae todo lo filtrado hasta el límite del CSV, más una
// fila para que la vista sepa que se pasó (Exc 1)
const LIMITE_EXPORTACION = 10000;

// FROM y WHERE compartidos por la página y el resumen (el resumen cubre TODO lo filtrado)
const HISTORIAL_FROM = `
  FROM alerta_inventario a
  JOIN material m ON m.material_sku = a.material_sku
  JOIN alerta_inventario_tipo_alerta ta
       ON ta.alerta_inventario_tipo_alerta_id_tipo_alerta = a.alerta_inventario_tipo_alerta_id_tipo_alerta
  JOIN alerta_inventario_nivel_prioridad np
       ON np.alerta_inventario_nivel_prioridad_id_nivel_prioridad = ta.alerta_inventario_nivel_prioridad_id
  LEFT JOIN historial_alerta ha ON ha.historial_alerta_id_historial = a.historial_alerta_id_historial
  LEFT JOIN usuario u ON u.usuario_id_usuario = ha.usuario_id_usuario
  WHERE ($1::date IS NULL OR a.alerta_inventario_fecha_generacion >= $1::date)
    AND ($2::date IS NULL OR a.alerta_inventario_fecha_generacion < ($2::date + INTERVAL '1 day'))
    AND ($3::text IS NULL OR LOWER(ta.alerta_inventario_tipo_alerta_nombre) = LOWER($3))
    AND ($4::text IS NULL OR a.material_sku ILIKE '%' || $4 || '%' OR m.material_nombre_material ILIKE '%' || $4 || '%')`;

// Segundos entre generación y resolución; NULL si la alerta no tiene fecha de resolución
const SQL_SEGUNDOS = `EXTRACT(EPOCH FROM (ha.historial_alerta_fecha_hora_resolucion - a.alerta_inventario_fecha_generacion))`;

/**
 * GET /api/alertas/historial?desde=&hasta=&tipo=&producto= — CU-55.
 *
 * El rango se aplica a la fecha de GENERACIÓN. Exc 2: inicio posterior al fin, o
 * fechas futuras → 400 ("hoy" en fecha local, nunca desde toISOString()).
 * Por alerta: fechas, producto, tipo, severidad (prioridad del tipo), estado,
 * tiempo de resolución y quién la resolvió:
 *   usuario            → resolución manual (desde CU-55 se registra)
 *   'Sistema'          → cierre automático con fecha (generador o reevaluación)
 *   'Sin registro'     → resuelta antes de que se guardara la fecha (datos antiguos)
 * Exc 3: las activas salen "Pendiente", tiempo en curso, y no entran al promedio.
 * `total_sistema` (sin filtros) distingue la Exc 1 de "sin coincidencias".
 * CU-76: con ?exportar=1 devuelve hasta 10.001 filas en vez de 500.
 */
async function historial(req, res) {
  const desde    = req.query.desde || null;
  const hasta    = req.query.hasta || null;
  const tipo     = req.query.tipo || null;
  const producto = (req.query.producto || '').trim() || null;
  const limite   = req.query.exportar === '1' ? LIMITE_EXPORTACION + 1 : LIMITE_HISTORIAL;

  if ((desde && !FECHA_ISO.test(desde)) || (hasta && !FECHA_ISO.test(hasta))) {
    return res.status(400).json({ error: 'Las fechas deben tener el formato AAAA-MM-DD.' });
  }
  if (desde && hasta && desde > hasta) {
    return res.status(400).json({ error: 'La fecha de inicio es posterior a la fecha de fin. Corrija el rango.' });
  }
  if ((desde && desde > fechaEnDias(0)) || (hasta && hasta > fechaEnDias(0))) {
    return res.status(400).json({ error: 'El rango incluye fechas futuras. Corrija el rango.' });
  }

  const filtros = [desde, hasta, tipo, producto];
  try {
    const { rows } = await query(
      `SELECT a.alerta_inventario_id_alerta                AS id,
              a.alerta_inventario_fecha_generacion         AS fecha_generacion,
              ha.historial_alerta_fecha_hora_resolucion    AS fecha_resolucion,
              a.material_sku                               AS sku,
              m.material_nombre_material                   AS producto,
              ta.alerta_inventario_tipo_alerta_nombre      AS tipo,
              np.alerta_inventario_prioridad_nombre        AS severidad,
              a.alerta_inventario_estado                   AS estado,
              u.usuario_username                           AS usuario,
              ${SQL_SEGUNDOS}                              AS segundos
       ${HISTORIAL_FROM}
       ORDER BY a.alerta_inventario_fecha_generacion DESC, a.alerta_inventario_id_alerta DESC
       LIMIT ${limite}`,
      filtros
    );

    const { rows: resu } = await query(
      `SELECT count(*)::int                                                          AS total,
              count(*) FILTER (WHERE a.alerta_inventario_estado = 'resuelta')::int   AS resueltas,
              count(*) FILTER (WHERE a.alerta_inventario_estado <> 'resuelta')::int  AS pendientes,
              count(*) FILTER (WHERE a.alerta_inventario_estado = 'resuelta' AND ${SQL_SEGUNDOS} >= 0)::int AS con_tiempo,
              AVG(${SQL_SEGUNDOS}) FILTER (WHERE a.alerta_inventario_estado = 'resuelta' AND ${SQL_SEGUNDOS} >= 0) AS promedio
       ${HISTORIAL_FROM}`,
      filtros
    );
    const { rows: sistema } = await query(`SELECT count(*)::int AS n FROM alerta_inventario`);

    const alertas = rows.map(r => {
      const resuelta = r.estado === 'resuelta';
      const segundos = resuelta && r.segundos != null && parseFloat(r.segundos) >= 0 ? Math.round(parseFloat(r.segundos)) : null;
      return {
        id: r.id, fecha_generacion: r.fecha_generacion, fecha_resolucion: resuelta ? r.fecha_resolucion : null,
        sku: r.sku, producto: r.producto, tipo: r.tipo, severidad: r.severidad,
        estado: resuelta ? 'Resuelta' : 'Pendiente',
        en_curso: !resuelta,
        tiempo_resolucion_segundos: segundos,
        resuelta_por: !resuelta ? null
          : r.fecha_resolucion == null ? 'Sin registro'
          : r.usuario || 'Sistema',
      };
    });

    const s = resu[0];
    res.json({
      resumen: {
        total: s.total, resueltas: s.resueltas, pendientes: s.pendientes,
        resueltas_con_tiempo: s.con_tiempo,
        tiempo_promedio_segundos: s.promedio == null ? null : Math.round(parseFloat(s.promedio)),
      },
      alertas,
      limitado: s.total > limite,
      total_sistema: sistema[0].n,
    });
  } catch (err) {
    console.error('Error consultando historial de alertas:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = { listar, listarTipos, generar, resolver, generarAlertasAutomaticas, evaluarReposicion, listarReposicion, historial,
                   TIPO_UBICACION_INCORRECTA, TIPO_FALTANTE_RETIRO, TIPOS_RETIRO, resolverAlertas };
