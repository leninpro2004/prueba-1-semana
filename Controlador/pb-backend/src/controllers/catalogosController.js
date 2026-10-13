const { query } = require('../db/pool');
const { ErrorNegocio, conTransaccion, responderError } = require('../db/tx');
const { SQL_ESTADOS_OT_CERRADA } = require('../db/estadosOT');
const auditoria = require('./auditoriaController');

/**
 * F-04: mantenedor de áreas de trabajo, unidades de medida y motivos de movimiento (solo gerencia).
 * La clasificación de materiales (B-14) está en clasificacionController.
 *
 *  - Áreas: se crean, renombran, reclasifican y activan/desactivan; no se borran (las usan OT y recetas).
 *    El código las reconoce por su clasificación, nunca por el nombre. CU-120 necesita al menos una
 *    área activa de instalación.
 *  - Unidades: se crean y renombran; se borran solo si ningún producto las usa.
 *  - Motivos: el código busca algunos por su NOMBRE (MOTIVOS_DEL_SISTEMA). Esos no se renombran; se
 *    pueden borrar (sin movimientos, con contraseña de gerencia) y restaurar. Los demás se crean,
 *    renombran y borran libremente. Un motivo se comporta según su clasificación de salida.
 *
 * Sin columna "activo" en unidades y motivos (DDL-05 no recomendado).
 */

const CLASIFICACIONES_AREA = ['produccion', 'instalacion', 'logistica'];

/**
 * Motivos que el código busca por nombre (motivoMovimientoId en db/stock.js y consultas por nombre).
 * `funcion`: lo que deja de funcionar sin él. `categoria`: su clasificación de salida en
 * catalogos_inventario.sql (null = motivo de entrada), para sugerirla al restaurar.
 */
const MOTIVOS_DEL_SISTEMA = [
  { clave: 'compra_proveedor',    categoria: null,                funcion: 'las entradas de compra (manuales y por factura)' },
  { clave: 'consumo_produccion',  categoria: 'produccion',        funcion: 'el consumo de las OT y del seguimiento de pinturas' },
  { clave: 'devolucion_consumo',  categoria: null,                funcion: 'corregir a la baja o anular consumos de OT y pinturas' },
  { clave: 'despacho_venta',      categoria: 'produccion',        funcion: 'la salida del transporte de los pedidos de instalación' },
  { clave: 'traslado_bodega',     categoria: 'traslado',          funcion: 'los traslados entre bodegas' },
  { clave: 'ajuste_inventario',   categoria: 'ajuste_inventario', funcion: 'los ajustes del conteo cíclico' },
  { clave: 'reverso_autorizado',  categoria: null,                funcion: 'revertir movimientos' },
  { clave: 'perdida_herramienta', categoria: 'merma',             funcion: 'registrar la pérdida de una herramienta' },
  { clave: 'baja_herramienta',    categoria: 'merma',             funcion: 'dar de baja una herramienta' },
  { clave: 'carga_inicial',       categoria: null,                funcion: 'el importador de la carga inicial' },
  { clave: 'compra_caja_chica',   categoria: null,                funcion: 'las entradas de material comprado con caja chica' },
];
const SISTEMA_POR_CLAVE = new Map(MOTIVOS_DEL_SISTEMA.map(m => [m.clave, m]));

const claveDe = (nombre) => {
  const n = String(nombre ?? '').trim().toLowerCase();
  return SISTEMA_POR_CLAVE.has(n) ? n : null;
};

/**
 * motivoMovimientoId busca con ILIKE '%clave%' (y '_' vale por cualquier carácter): un motivo nuevo
 * cuyo nombre contenga una clave podría tomarse por el del sistema. Devuelve la clave con que choca.
 */
function chocaConClave(nombre) {
  return MOTIVOS_DEL_SISTEMA.find(m => new RegExp(m.clave.replace(/_/g, '.'), 'i').test(nombre))?.clave ?? null;
}

const esTraslado = (nombreClasificacion) => String(nombreClasificacion ?? '').toLowerCase().includes('traslado');

function idDe(valor, que) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) throw new ErrorNegocio(400, { error: `${que} no es válido.` });
  return n;
}

function validarNombre(nombre, max) {
  const valor = typeof nombre === 'string' ? nombre.trim() : '';
  if (!valor) throw new ErrorNegocio(400, { error: 'Escribe un nombre.' });
  if (valor.length > max) throw new ErrorNegocio(400, { error: `El nombre no puede superar los ${max} caracteres.` });
  return valor;
}

/** 409 si ya existe otro con ese nombre (sin distinguir mayúsculas). */
async function verificarNombreLibre(client, tabla, colId, colNombre, nombre, excluirId) {
  const { rows } = await client.query(
    `SELECT 1 FROM ${tabla} WHERE LOWER(TRIM(${colNombre})) = LOWER($1) AND ($2::bigint IS NULL OR ${colId} <> $2)`,
    [nombre, excluirId ?? null]
  );
  if (rows.length) throw new ErrorNegocio(409, { error: `Ya existe "${nombre}". Usa otro nombre.` });
}

/* ══════════════════════════════ Áreas ══════════════════════════════ */

const AREA = { tabla: 'area_trabajo', id: 'area_trabajo_id_area', nombre: 'area_trabajo_nombre_area' };

function validarClasificacionArea(valor) {
  if (!CLASIFICACIONES_AREA.includes(valor)) {
    throw new ErrorNegocio(400, { error: 'La clasificación del área debe ser producción, instalación o logística.' });
  }
  return valor;
}

/** GET /api/catalogos/areas — con OT (abiertas y totales) y líneas de receta de cada una. */
async function listarAreas(req, res) {
  try {
    const { rows } = await query(
      `SELECT a.area_trabajo_id_area AS id, a.area_trabajo_nombre_area AS nombre,
              a.area_trabajo_clasificacion AS clasificacion, a.area_trabajo_activo AS activo,
              (SELECT COUNT(*)::int FROM orden_trabajo o WHERE o.area_trabajo_id_area = a.area_trabajo_id_area) AS ots,
              (SELECT COUNT(*)::int FROM orden_trabajo o WHERE o.area_trabajo_id_area = a.area_trabajo_id_area
                 AND COALESCE(o.orden_trabajo_estado, '') NOT IN (${SQL_ESTADOS_OT_CERRADA})) AS ots_abiertas,
              (SELECT COUNT(*)::int FROM material_producto_terminado m
                 WHERE m.area_trabajo_id_area = a.area_trabajo_id_area) AS lineas_receta
       FROM area_trabajo a
       ORDER BY a.area_trabajo_activo DESC, LOWER(a.area_trabajo_nombre_area)`
    );
    res.json({ areas: rows, clasificaciones: CLASIFICACIONES_AREA });
  } catch (err) {
    responderError(res, err, 'Error listando áreas:');
  }
}

/** POST /api/catalogos/areas — Body: { nombre, clasificacion } */
async function crearArea(req, res) {
  try {
    const nombre = validarNombre(req.body?.nombre, 150);
    const clasificacion = validarClasificacionArea(req.body?.clasificacion);
    const creada = await conTransaccion(async (client) => {
      await verificarNombreLibre(client, AREA.tabla, AREA.id, AREA.nombre, nombre, null);
      const { rows } = await client.query(
        `INSERT INTO area_trabajo (area_trabajo_nombre_area, area_trabajo_clasificacion, area_trabajo_activo)
         VALUES ($1, $2, TRUE) RETURNING area_trabajo_id_area AS id`,
        [nombre, clasificacion]
      );
      return { id: rows[0].id, nombre, clasificacion, activo: true };
    });
    await auditoria.registrar(req.user?.id, 'crear_area', `Área #${creada.id}: ${nombre} (${clasificacion})`);
    res.status(201).json(creada);
  } catch (err) {
    responderError(res, err, 'Error creando área:');
  }
}

/**
 * PUT /api/catalogos/areas/:id — Body: { nombre?, clasificacion?, activo? }. Lo omitido se conserva.
 * La última área activa de instalación no se desactiva ni se reclasifica (CU-120 la busca).
 */
async function actualizarArea(req, res) {
  try {
    const id = idDe(req.params.id, 'El área');
    const body = req.body || {};
    const cambios = {};
    if ('nombre' in body) cambios.nombre = validarNombre(body.nombre, 150);
    if ('clasificacion' in body) cambios.clasificacion = validarClasificacionArea(body.clasificacion);
    if ('activo' in body) {
      if (typeof body.activo !== 'boolean') throw new ErrorNegocio(400, { error: 'El estado del área no es válido.' });
      cambios.activo = body.activo;
    }
    if (!Object.keys(cambios).length) throw new ErrorNegocio(400, { error: 'No hay cambios que guardar.' });

    const r = await conTransaccion(async (client) => {
      // Se bloquean todas las de instalación: dos cambios simultáneos no pueden dejar CU-120 sin área.
      await client.query(`SELECT 1 FROM area_trabajo WHERE area_trabajo_clasificacion = 'instalacion' FOR UPDATE`);
      const { rows } = await client.query(
        `SELECT area_trabajo_nombre_area AS nombre, area_trabajo_clasificacion AS clasificacion, area_trabajo_activo AS activo
         FROM area_trabajo WHERE area_trabajo_id_area = $1 FOR UPDATE`, [id]);
      if (!rows.length) throw new ErrorNegocio(404, { error: 'El área no existe.' });
      const antes = rows[0];
      const despues = { ...antes, ...cambios };

      const dejaInstalacion = antes.clasificacion === 'instalacion' && antes.activo !== false &&
        (despues.clasificacion !== 'instalacion' || despues.activo === false);
      if (dejaInstalacion) {
        const { rows: otras } = await client.query(
          `SELECT COUNT(*)::int AS n FROM area_trabajo
           WHERE area_trabajo_clasificacion = 'instalacion' AND area_trabajo_activo IS NOT FALSE AND area_trabajo_id_area <> $1`,
          [id]);
        if (otras[0].n === 0) {
          throw new ErrorNegocio(409, {
            error: `"${antes.nombre}" es la única área activa de instalación: los pedidos de instalación la necesitan. ` +
                   'Se puede renombrar, pero para desactivarla o cambiarle la clasificación primero crea o activa otra de instalación.',
          });
        }
      }
      if ('nombre' in cambios) await verificarNombreLibre(client, AREA.tabla, AREA.id, AREA.nombre, cambios.nombre, id);

      await client.query(
        `UPDATE area_trabajo SET area_trabajo_nombre_area = $1, area_trabajo_clasificacion = $2, area_trabajo_activo = $3
         WHERE area_trabajo_id_area = $4`,
        [despues.nombre, despues.clasificacion, despues.activo, id]
      );
      return { antes, despues };
    });

    const { antes, despues } = r;
    const partes = [];
    if (antes.nombre !== despues.nombre) partes.push(`${antes.nombre} → ${despues.nombre}`);
    if (antes.clasificacion !== despues.clasificacion) partes.push(`clasificación ${antes.clasificacion} → ${despues.clasificacion}`);
    if (antes.activo !== despues.activo) partes.push(despues.activo ? 'activada' : 'desactivada');
    await auditoria.registrar(req.user?.id, 'editar_area', `Área #${id}: ${despues.nombre}${partes.length ? ` (${partes.join('; ')})` : ''}`);
    res.json({ id, ...despues });
  } catch (err) {
    responderError(res, err, 'Error editando área:');
  }
}

/* ═════════════════════════════ Unidades ═════════════════════════════ */

const UNIDAD = { tabla: 'material_unidad_medida', id: 'material_unidad_medida_id_unidad_medida', nombre: 'material_unidad_medida_nombre' };

/** GET /api/catalogos/unidades — con la cantidad de productos que usa cada una. */
async function listarUnidades(req, res) {
  try {
    const { rows } = await query(
      `SELECT u.material_unidad_medida_id_unidad_medida AS id, u.material_unidad_medida_nombre AS nombre,
              (SELECT COUNT(*)::int FROM material m
                 WHERE m.material_unidad_medida_id_unidad_medida = u.material_unidad_medida_id_unidad_medida) AS usos
       FROM material_unidad_medida u ORDER BY LOWER(u.material_unidad_medida_nombre)`
    );
    res.json(rows);
  } catch (err) {
    responderError(res, err, 'Error listando unidades:');
  }
}

/** POST /api/catalogos/unidades — Body: { nombre } */
async function crearUnidad(req, res) {
  try {
    const nombre = validarNombre(req.body?.nombre, 100);
    const creada = await conTransaccion(async (client) => {
      await verificarNombreLibre(client, UNIDAD.tabla, UNIDAD.id, UNIDAD.nombre, nombre, null);
      const { rows } = await client.query(
        `INSERT INTO material_unidad_medida (material_unidad_medida_nombre) VALUES ($1)
         RETURNING material_unidad_medida_id_unidad_medida AS id`, [nombre]);
      return { id: rows[0].id, nombre };
    });
    await auditoria.registrar(req.user?.id, 'crear_unidad', `Unidad #${creada.id}: ${nombre}`);
    res.status(201).json(creada);
  } catch (err) {
    responderError(res, err, 'Error creando unidad:');
  }
}

/** PUT /api/catalogos/unidades/:id — Body: { nombre } */
async function actualizarUnidad(req, res) {
  try {
    const id = idDe(req.params.id, 'La unidad');
    const nombre = validarNombre(req.body?.nombre, 100);
    const antes = await conTransaccion(async (client) => {
      const { rows } = await client.query(
        `SELECT material_unidad_medida_nombre AS nombre FROM material_unidad_medida
         WHERE material_unidad_medida_id_unidad_medida = $1 FOR UPDATE`, [id]);
      if (!rows.length) throw new ErrorNegocio(404, { error: 'La unidad no existe.' });
      await verificarNombreLibre(client, UNIDAD.tabla, UNIDAD.id, UNIDAD.nombre, nombre, id);
      await client.query(
        `UPDATE material_unidad_medida SET material_unidad_medida_nombre = $1
         WHERE material_unidad_medida_id_unidad_medida = $2`, [nombre, id]);
      return rows[0].nombre;
    });
    await auditoria.registrar(req.user?.id, 'editar_unidad', `Unidad #${id}: ${antes} → ${nombre}`);
    res.json({ id, nombre });
  } catch (err) {
    responderError(res, err, 'Error editando unidad:');
  }
}

/** DELETE /api/catalogos/unidades/:id — solo si ningún producto la usa. */
async function eliminarUnidad(req, res) {
  try {
    const id = idDe(req.params.id, 'La unidad');
    const nombre = await conTransaccion(async (client) => {
      const { rows } = await client.query(
        `SELECT material_unidad_medida_nombre AS nombre FROM material_unidad_medida
         WHERE material_unidad_medida_id_unidad_medida = $1 FOR UPDATE`, [id]);
      if (!rows.length) throw new ErrorNegocio(404, { error: 'La unidad no existe.' });
      const { rows: uso } = await client.query(
        `SELECT COUNT(*)::int AS n FROM material WHERE material_unidad_medida_id_unidad_medida = $1`, [id]);
      if (uso[0].n > 0) {
        throw new ErrorNegocio(409, {
          error: `No se puede borrar "${rows[0].nombre}": la usa${uso[0].n === 1 ? '' : 'n'} ${uso[0].n} producto${uso[0].n === 1 ? '' : 's'}. Cámbiale el nombre o cambia la unidad de esos productos.`,
          usos: uso[0].n,
        });
      }
      await client.query(`DELETE FROM material_unidad_medida WHERE material_unidad_medida_id_unidad_medida = $1`, [id]);
      return rows[0].nombre;
    });
    await auditoria.registrar(req.user?.id, 'eliminar_unidad', `Unidad #${id}: ${nombre}`);
    res.json({ ok: true });
  } catch (err) {
    responderError(res, err, 'Error borrando unidad:');
  }
}

/* ═════════════════════════════ Motivos ══════════════════════════════ */

const MOTIVO_COL_CLASIF = 'movimiento_inventario_clasificacion_salida_id_clasificacion_sal';

/** Clasificación de salida por id (o 400). */
async function clasificacionSalida(client, id) {
  const { rows } = await client.query(
    `SELECT movimiento_inventario_clasificacion_salida_nombre AS nombre FROM movimiento_inventario_clasificacion_salida
     WHERE movimiento_inventario_clasificacion_salida_id_clasificacion_sal = $1`, [id]);
  if (!rows.length) throw new ErrorNegocio(400, { error: 'La categoría del motivo no existe.' });
  return rows[0].nombre;
}

/**
 * Motivo por id con su clave del sistema (o null) y la cantidad de movimientos que lo usan; null si no existe.
 * La usa también validarBorrableMotivo, para rechazar ANTES de pedir la firma.
 */
async function motivoConUso(client, id, bloquear = false) {
  const { rows } = await client.query(
    `SELECT movimiento_inventario_motivo_movimiento_nombre AS nombre FROM movimiento_inventario_motivo_movimiento
     WHERE movimiento_inventario_motivo_movimiento_id_motivo_movimiento = $1${bloquear ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows.length) return null;
  const { rows: uso } = await client.query(
    `SELECT COUNT(*)::int AS n FROM movimiento_inventario
     WHERE movimiento_inventario_motivo_movimiento_id_motivo_movimiento = $1`, [id]);
  return { id, nombre: rows[0].nombre, clave: claveDe(rows[0].nombre), usos: uso[0].n };
}

/** Error de negocio si el motivo no se puede borrar (no existe o tiene movimientos); null si se puede. */
function motivoNoBorrable(m) {
  if (!m) return new ErrorNegocio(404, { error: 'El motivo no existe (quizás alguien lo borró).' });
  if (m.usos > 0) {
    return new ErrorNegocio(409, {
      error: `No se puede borrar "${m.nombre}": lo usa${m.usos === 1 ? '' : 'n'} ${m.usos} movimiento${m.usos === 1 ? '' : 's'}.` +
             (m.clave ? '' : ' Se puede renombrar.'),
      usos: m.usos,
    });
  }
  return null;
}

/** GET /api/catalogos/motivos — motivos con su uso, clasificaciones de salida y motivos del sistema que faltan. */
async function listarMotivos(req, res) {
  try {
    const [motivos, clasificaciones] = await Promise.all([
      query(`SELECT mot.movimiento_inventario_motivo_movimiento_id_motivo_movimiento AS id,
                    mot.movimiento_inventario_motivo_movimiento_nombre AS nombre,
                    mot.${MOTIVO_COL_CLASIF} AS clasificacion_id,
                    cs.movimiento_inventario_clasificacion_salida_nombre AS clasificacion,
                    (SELECT COUNT(*)::int FROM movimiento_inventario mi
                       WHERE mi.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
                           = mot.movimiento_inventario_motivo_movimiento_id_motivo_movimiento) AS usos
             FROM movimiento_inventario_motivo_movimiento mot
             LEFT JOIN movimiento_inventario_clasificacion_salida cs
                    ON cs.movimiento_inventario_clasificacion_salida_id_clasificacion_sal = mot.${MOTIVO_COL_CLASIF}
             ORDER BY LOWER(mot.movimiento_inventario_motivo_movimiento_nombre)`),
      query(`SELECT movimiento_inventario_clasificacion_salida_id_clasificacion_sal AS id,
                    movimiento_inventario_clasificacion_salida_nombre AS nombre
             FROM movimiento_inventario_clasificacion_salida ORDER BY LOWER(movimiento_inventario_clasificacion_salida_nombre)`),
    ]);

    const lista = motivos.rows.map(m => {
      const clave = claveDe(m.nombre);
      return { ...m, clave, funcion: clave ? SISTEMA_POR_CLAVE.get(clave).funcion : null };
    });
    const presentes = new Set(lista.map(m => m.clave).filter(Boolean));
    const clasif = clasificaciones.rows.map(c => ({ ...c, es_traslado: esTraslado(c.nombre) }));
    const faltantes = MOTIVOS_DEL_SISTEMA.filter(m => !presentes.has(m.clave)).map(m => ({
      clave: m.clave,
      funcion: m.funcion,
      clasificacion_id: m.categoria
        ? clasif.find(c => c.nombre.toLowerCase() === m.categoria)?.id ?? null
        : null,
    }));
    res.json({ motivos: lista, clasificaciones: clasif, faltantes });
  } catch (err) {
    responderError(res, err, 'Error listando motivos:');
  }
}

/** POST /api/catalogos/motivos — Body: { nombre, clasificacion_id }. Solo motivos de salida (sin traslado). */
async function crearMotivo(req, res) {
  try {
    const nombre = validarNombre(req.body?.nombre, 150);
    const choque = chocaConClave(nombre);
    if (choque) {
      throw new ErrorNegocio(400, { error: `El nombre se confunde con el motivo del sistema "${choque}". Usa otro nombre.` });
    }
    const clasifId = idDe(req.body?.clasificacion_id, 'La categoría del motivo');
    const creado = await conTransaccion(async (client) => {
      const clasif = await clasificacionSalida(client, clasifId);
      if (esTraslado(clasif)) {
        throw new ErrorNegocio(400, { error: 'Los traslados usan su propio motivo: elige otra categoría.' });
      }
      await verificarNombreLibre(client, 'movimiento_inventario_motivo_movimiento',
        'movimiento_inventario_motivo_movimiento_id_motivo_movimiento', 'movimiento_inventario_motivo_movimiento_nombre', nombre, null);
      const { rows } = await client.query(
        `INSERT INTO movimiento_inventario_motivo_movimiento (movimiento_inventario_motivo_movimiento_nombre, ${MOTIVO_COL_CLASIF})
         VALUES ($1, $2) RETURNING movimiento_inventario_motivo_movimiento_id_motivo_movimiento AS id`,
        [nombre, clasifId]);
      return { id: rows[0].id, nombre, clasificacion: clasif };
    });
    await auditoria.registrar(req.user?.id, 'crear_motivo', `Motivo #${creado.id}: ${nombre} (${creado.clasificacion})`);
    res.status(201).json(creado);
  } catch (err) {
    responderError(res, err, 'Error creando motivo:');
  }
}

/** PUT /api/catalogos/motivos/:id — Body: { nombre?, clasificacion_id? }. Los del sistema no se editan. */
async function actualizarMotivo(req, res) {
  try {
    const id = idDe(req.params.id, 'El motivo');
    const body = req.body || {};
    const nombre = 'nombre' in body ? validarNombre(body.nombre, 150) : null;
    const clasifId = 'clasificacion_id' in body ? idDe(body.clasificacion_id, 'La categoría del motivo') : null;
    if (nombre == null && clasifId == null) throw new ErrorNegocio(400, { error: 'No hay cambios que guardar.' });
    if (nombre != null) {
      const choque = chocaConClave(nombre);
      if (choque) {
        throw new ErrorNegocio(400, { error: `El nombre se confunde con el motivo del sistema "${choque}". Usa otro nombre.` });
      }
    }

    const r = await conTransaccion(async (client) => {
      const actual = await motivoConUso(client, id, true);
      if (!actual) throw new ErrorNegocio(404, { error: 'El motivo no existe (quizás alguien lo borró).' });
      if (actual.clave) {
        throw new ErrorNegocio(409, {
          error: `"${actual.nombre}" es un motivo del sistema: el sistema lo busca por ese nombre y no se puede editar.`,
        });
      }
      let clasif = null;
      if (clasifId != null) {
        clasif = await clasificacionSalida(client, clasifId);
        if (esTraslado(clasif)) {
          throw new ErrorNegocio(400, { error: 'Los traslados usan su propio motivo: elige otra categoría.' });
        }
      }
      if (nombre != null) {
        await verificarNombreLibre(client, 'movimiento_inventario_motivo_movimiento',
          'movimiento_inventario_motivo_movimiento_id_motivo_movimiento', 'movimiento_inventario_motivo_movimiento_nombre', nombre, id);
      }
      await client.query(
        `UPDATE movimiento_inventario_motivo_movimiento
         SET movimiento_inventario_motivo_movimiento_nombre = COALESCE($1, movimiento_inventario_motivo_movimiento_nombre),
             ${MOTIVO_COL_CLASIF} = COALESCE($2, ${MOTIVO_COL_CLASIF})
         WHERE movimiento_inventario_motivo_movimiento_id_motivo_movimiento = $3`,
        [nombre, clasifId, id]);
      return { antes: actual.nombre, despues: nombre ?? actual.nombre, clasif };
    });

    const partes = [];
    if (r.antes !== r.despues) partes.push(`${r.antes} → ${r.despues}`);
    if (r.clasif) partes.push(`categoría ${r.clasif}`);
    await auditoria.registrar(req.user?.id, 'editar_motivo', `Motivo #${id}: ${r.despues} (${partes.join('; ')})`);
    res.json({ id, nombre: r.despues });
  } catch (err) {
    responderError(res, err, 'Error editando motivo:');
  }
}

/**
 * Middleware de DELETE /motivos/:id, antes de la firma (F-11): un motivo que no existe o tiene
 * movimientos se rechaza sin pedir la firma, así no se gasta. eliminarMotivo lo vuelve a comprobar.
 */
async function validarBorrableMotivo(req, res, next) {
  try {
    const error = motivoNoBorrable(await motivoConUso({ query }, idDe(req.params.id, 'El motivo')));
    if (error) throw error;
    next();
  } catch (err) {
    responderError(res, err, 'Error validando el borrado del motivo:');
  }
}

/**
 * DELETE /api/catalogos/motivos/:id — solo si ningún movimiento lo usa. Pide la firma de catálogos
 * (F-11), también para un motivo del sistema (antes pedía la contraseña aparte, CU-42).
 */
async function eliminarMotivo(req, res) {
  try {
    const id = idDe(req.params.id, 'El motivo');
    const r = await conTransaccion(async (client) => {
      const m = await motivoConUso(client, id, true);
      const error = motivoNoBorrable(m);
      if (error) throw error;
      await client.query(
        `DELETE FROM movimiento_inventario_motivo_movimiento WHERE movimiento_inventario_motivo_movimiento_id_motivo_movimiento = $1`,
        [id]);
      return m;
    });
    await auditoria.registrar(req.user?.id, r.clave ? 'eliminar_motivo_sistema' : 'eliminar_motivo',
      `Motivo #${id}: ${r.nombre}${r.clave ? ` (deja de funcionar: ${SISTEMA_POR_CLAVE.get(r.clave).funcion})` : ''}`);
    res.json({ ok: true });
  } catch (err) {
    responderError(res, err, 'Error borrando motivo:');
  }
}

/** POST /api/catalogos/motivos/restaurar — Body: { clave, clasificacion_id|null }. Vuelve a crear un motivo del sistema. */
async function restaurarMotivo(req, res) {
  try {
    const clave = claveDe(req.body?.clave);
    if (!clave) throw new ErrorNegocio(400, { error: 'Ese no es un motivo del sistema.' });
    const clasifId = req.body?.clasificacion_id == null || req.body.clasificacion_id === ''
      ? null : idDe(req.body.clasificacion_id, 'La categoría del motivo');

    const creado = await conTransaccion(async (client) => {
      const { rows: hay } = await client.query(
        `SELECT 1 FROM movimiento_inventario_motivo_movimiento
         WHERE LOWER(TRIM(movimiento_inventario_motivo_movimiento_nombre)) = $1`, [clave]);
      if (hay.length) throw new ErrorNegocio(409, { error: `El motivo "${clave}" ya existe.` });
      if (clasifId != null) await clasificacionSalida(client, clasifId);
      const { rows } = await client.query(
        `INSERT INTO movimiento_inventario_motivo_movimiento (movimiento_inventario_motivo_movimiento_nombre, ${MOTIVO_COL_CLASIF})
         VALUES ($1, $2) RETURNING movimiento_inventario_motivo_movimiento_id_motivo_movimiento AS id`,
        [clave, clasifId]);
      return { id: rows[0].id, nombre: clave };
    });
    await auditoria.registrar(req.user?.id, 'restaurar_motivo', `Motivo #${creado.id}: ${clave}`);
    res.status(201).json(creado);
  } catch (err) {
    responderError(res, err, 'Error restaurando motivo:');
  }
}

module.exports = {
  listarAreas, crearArea, actualizarArea,
  listarUnidades, crearUnidad, actualizarUnidad, eliminarUnidad,
  listarMotivos, crearMotivo, actualizarMotivo, eliminarMotivo, restaurarMotivo, validarBorrableMotivo,
};
