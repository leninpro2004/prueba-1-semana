const { query } = require('../db/pool');
const { ErrorNegocio, conTransaccion, responderError } = require('../db/tx');
const { tipoMovimientoId, motivoDevolucionConsumo, descontarFifo, reponerFifo } = require('../db/stock');
const auditoria = require('./auditoriaController');
const { generarAlertasAutomaticas } = require('./alertasController');

/**
 * CU-108: reglas de integracion entre modulos (V1, docs/sprint/decisiones.md).
 *
 *  - Sin tablas nuevas: una regla es un par (modulo de origen, perfil) y cada tipo
 *    de movimiento permitido es una fila de perfil_permiso que apunta al permiso
 *    ('inventario', '<tipo>_desde_<modulo>'). Los permisos se crean al guardar.
 *  - La regla esta ACTIVA si tiene al menos un tipo activo. Quitar un tipo o
 *    desactivar la regla pone perfil_permiso_activo = FALSE (no borra). Solo
 *    "Eliminar" borra sus filas, para corregir una regla creada por error.
 *  - El perfil de un usuario se obtiene por el NOMBRE de su rol (no por
 *    usuario.perfil_id_perfil, descuadrado con los booleanos). Ver
 *    docs/sprint/migracion-permisos.md.
 */

const PERMISO_MODULO = 'inventario';

// Los mismos valores que acepta el CHECK de movimiento_inventario_modulo_origen
const MODULOS_ORIGEN = { terreno: 'Terreno', finanzas: 'Finanzas' };

// Tipos que CU-107 sabe registrar. Tienen que existir en movimiento_inventario_tipo_movimiento.
const TIPOS_INTEGRABLES = ['entrada', 'salida'];

// CU-108 Exc 3: "operaciones en curso" = movimientos del modulo en los ultimos N dias
const DIAS_OPERACIONES_EN_CURSO = 30;

/**
 * Rol de un usuario, con la MISMA prioridad que el login (authController):
 * gerencia > tecnico > administrador > secretaria > jop.
 */
const ROL_DEL_USUARIO_SQL = `
  CASE WHEN u.usuario_es_gerencia      THEN 'gerencia'
       WHEN u.usuario_es_tecnico       THEN 'tecnico'
       WHEN u.usuario_es_administrador THEN 'administrador'
       WHEN u.usuario_es_secretaria    THEN 'secretaria'
       ELSE 'jop' END`;

const accionDe = (tipo, modulo) => `${tipo}_desde_${modulo}`;
const ACCION_RE = /^([a-z]+)_desde_([a-z]+)$/;

/** Tipos integrables que existen en el catalogo de tipos de movimiento. */
async function tiposDisponibles(q) {
  const { rows } = await q(
    `SELECT movimiento_inventario_tipo_movimiento_nombre AS nombre
     FROM movimiento_inventario_tipo_movimiento
     WHERE movimiento_inventario_tipo_movimiento_nombre = ANY($1)`,
    [TIPOS_INTEGRABLES]
  );
  const existentes = new Set(rows.map(r => r.nombre));
  return TIPOS_INTEGRABLES.filter(t => existentes.has(t));
}

/** Reglas agrupadas por (modulo, perfil), con los tipos activos de cada una. */
async function leerReglas(q) {
  const { rows } = await q(
    `SELECT p.permiso_accion AS accion, pf.perfil_id_perfil AS perfil_id,
            pf.perfil_nombre_perfil AS perfil, pp.perfil_permiso_activo AS activo
     FROM perfil_permiso pp
     JOIN permiso p ON p.permiso_id_permiso = pp.permiso_id_permiso
     JOIN perfil pf ON pf.perfil_id_perfil  = pp.perfil_id_perfil
     WHERE p.permiso_modulo = $1 AND p.permiso_accion LIKE '%\\_desde\\_%'`,
    [PERMISO_MODULO]
  );
  const reglas = new Map();
  for (const r of rows) {
    const m = ACCION_RE.exec(r.accion);
    if (!m || !MODULOS_ORIGEN[m[2]]) continue;
    const [, tipo, modulo] = m;
    const clave = `${modulo}|${r.perfil_id}`;
    if (!reglas.has(clave)) {
      reglas.set(clave, { modulo, modulo_nombre: MODULOS_ORIGEN[modulo], perfil_id: Number(r.perfil_id), perfil: r.perfil, tipos: [] });
    }
    if (r.activo) reglas.get(clave).tipos.push(tipo);
  }
  return [...reglas.values()]
    .map(r => ({ ...r, tipos: TIPOS_INTEGRABLES.filter(t => r.tipos.includes(t)), activa: r.tipos.length > 0 }))
    .sort((a, b) => a.modulo.localeCompare(b.modulo) || a.perfil.localeCompare(b.perfil));
}

/**
 * GET /api/integracion/reglas   (gerencia y administrador)
 * Reglas vigentes + las opciones del formulario. Cada perfil trae cuantos usuarios
 * activos tienen ese rol: un perfil sin usuarios se marca en la vista, porque una
 * regla para el nunca aplicaria.
 */
async function listarReglas(req, res) {
  try {
    const [reglas, tipos, perfiles] = await Promise.all([
      leerReglas(query),
      tiposDisponibles(query),
      query(
        `SELECT pf.perfil_id_perfil AS id, pf.perfil_nombre_perfil AS nombre,
                (SELECT count(*) FROM usuario u
                 WHERE u.usuario_estado_cuenta IN ('activo','activa')
                   AND ${ROL_DEL_USUARIO_SQL} = pf.perfil_nombre_perfil)::int AS usuarios
         FROM perfil pf ORDER BY pf.perfil_nombre_perfil`
      ),
    ]);
    res.json({
      reglas,
      modulos: Object.entries(MODULOS_ORIGEN).map(([valor, nombre]) => ({ valor, nombre })),
      perfiles: perfiles.rows.map(p => ({ ...p, id: Number(p.id) })),
      tipos,
    });
  } catch (err) {
    responderError(res, err, 'Error listando reglas de integración:');
  }
}

/** Valida el cuerpo comun de POST y PUT. Devuelve { modulo, perfilId, tipos } o lanza 400. */
async function validarCuerpo(body, tiposValidos, { permitirVacio }) {
  const modulo = String(body?.modulo ?? '').trim();
  if (!MODULOS_ORIGEN[modulo]) {
    throw new ErrorNegocio(400, { error: 'Seleccione un módulo de origen válido (Terreno o Finanzas).', campo: 'modulo' });
  }
  const perfilId = Number(body?.perfil_id);
  if (!Number.isInteger(perfilId) || perfilId <= 0) {
    throw new ErrorNegocio(400, { error: 'Seleccione un rol.', campo: 'perfil_id' });
  }
  if (!Array.isArray(body?.tipos)) {
    throw new ErrorNegocio(400, { error: 'Indique los tipos de movimiento permitidos.', campo: 'tipos' });
  }
  const tipos = [...new Set(body.tipos.map(t => String(t).trim()))];
  const invalido = tipos.find(t => !tiposValidos.includes(t));
  if (invalido) {
    throw new ErrorNegocio(400, { error: `Tipo de movimiento no permitido: "${invalido}". Use ${tiposValidos.join(' o ')}.`, campo: 'tipos' });
  }
  if (!permitirVacio && tipos.length === 0) {
    throw new ErrorNegocio(400, { error: 'Seleccione al menos un tipo de movimiento.', campo: 'tipos' });
  }
  return { modulo, perfilId, tipos: TIPOS_INTEGRABLES.filter(t => tipos.includes(t)) };
}

/**
 * Estado actual de la regla (modulo, perfil). Bloquea la fila del perfil para que
 * dos cambios simultaneos sobre el mismo perfil se apliquen uno detras de otro.
 */
async function estadoRegla(client, modulo, perfilId) {
  const { rows: pf } = await client.query(
    `SELECT perfil_nombre_perfil AS nombre FROM perfil WHERE perfil_id_perfil = $1 FOR UPDATE`, [perfilId]
  );
  if (!pf.length) throw new ErrorNegocio(400, { error: 'El rol seleccionado no existe.', campo: 'perfil_id' });
  const { rows } = await client.query(
    `SELECT p.permiso_accion AS accion, pp.perfil_permiso_activo AS activo
     FROM perfil_permiso pp JOIN permiso p ON p.permiso_id_permiso = pp.permiso_id_permiso
     WHERE pp.perfil_id_perfil = $1 AND p.permiso_modulo = $2 AND p.permiso_accion = ANY($3)`,
    [perfilId, PERMISO_MODULO, TIPOS_INTEGRABLES.map(t => accionDe(t, modulo))]
  );
  const activos = rows.filter(r => r.activo).map(r => ACCION_RE.exec(r.accion)[1]);
  return {
    perfil: pf[0].nombre,
    existe: rows.length > 0,
    tipos: TIPOS_INTEGRABLES.filter(t => activos.includes(t)),
  };
}

/** Deja activos exactamente `tipos` para (modulo, perfil). Crea el permiso si falta. */
async function aplicarTipos(client, modulo, perfilId, tipos) {
  for (const tipo of TIPOS_INTEGRABLES) {
    const accion = accionDe(tipo, modulo);
    if (tipos.includes(tipo)) {
      await client.query(
        `INSERT INTO permiso (permiso_modulo, permiso_accion, permiso_descripcion, permiso_nombre_del_permiso)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (permiso_modulo, permiso_accion) DO NOTHING`,
        [PERMISO_MODULO, accion,
         `CU-108: registrar ${tipo === 'entrada' ? 'entradas' : 'salidas'} de inventario desde ${MODULOS_ORIGEN[modulo]}`,
         `inv_${accion}`]
      );
      await client.query(
        `INSERT INTO perfil_permiso (perfil_id_perfil, permiso_id_permiso, perfil_permiso_activo)
         SELECT $1, permiso_id_permiso, TRUE FROM permiso WHERE permiso_modulo = $2 AND permiso_accion = $3
         ON CONFLICT (perfil_id_perfil, permiso_id_permiso) DO UPDATE SET perfil_permiso_activo = TRUE`,
        [perfilId, PERMISO_MODULO, accion]
      );
    } else {
      await client.query(
        `UPDATE perfil_permiso pp SET perfil_permiso_activo = FALSE
         FROM permiso p
         WHERE p.permiso_id_permiso = pp.permiso_id_permiso
           AND pp.perfil_id_perfil = $1 AND p.permiso_modulo = $2 AND p.permiso_accion = $3
           AND pp.perfil_permiso_activo`,
        [perfilId, PERMISO_MODULO, accion]
      );
    }
  }
}

/** Otras reglas activas del modulo (de otros perfiles). */
async function otrasReglasActivas(client, modulo, perfilId) {
  const { rows } = await client.query(
    `SELECT count(DISTINCT pp.perfil_id_perfil)::int AS n
     FROM perfil_permiso pp JOIN permiso p ON p.permiso_id_permiso = pp.permiso_id_permiso
     WHERE pp.perfil_permiso_activo AND pp.perfil_id_perfil <> $1
       AND p.permiso_modulo = $2 AND p.permiso_accion = ANY($3)`,
    [perfilId, PERMISO_MODULO, TIPOS_INTEGRABLES.map(t => accionDe(t, modulo))]
  );
  return rows[0].n;
}

/** CU-108 Exc 3: movimientos registrados desde el modulo en los ultimos dias. */
async function operacionesEnCurso(client, modulo) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS movimientos, max(movimiento_inventario_fecha_hora) AS ultimo
     FROM movimiento_inventario
     WHERE movimiento_inventario_modulo_origen = $1
       AND movimiento_inventario_fecha_hora >= now() - make_interval(days => $2)`,
    [modulo, DIAS_OPERACIONES_EN_CURSO]
  );
  return rows[0];
}

const listaTipos = (tipos) => tipos.length ? tipos.join(', ') : 'sin tipos';

/**
 * Aplica el cambio y audita DESPUES del COMMIT. `validar(client, actual)` corre
 * dentro de la transaccion, antes de escribir, y lanza ErrorNegocio si corresponde.
 */
async function guardarRegla(req, res, { permitirVacio, validar, mensaje }) {
  try {
    const tiposValidos = await tiposDisponibles(query);
    const { modulo, perfilId, tipos } = await validarCuerpo(req.body, tiposValidos, { permitirVacio });

    const r = await conTransaccion(async (client) => {
      const actual = await estadoRegla(client, modulo, perfilId);
      await validar(client, actual, { modulo, perfilId, tipos });
      const sinCambios = actual.tipos.join() === tipos.join();
      if (!sinCambios) await aplicarTipos(client, modulo, perfilId, tipos);
      return { actual, sinCambios };
    });

    const regla = `${MODULOS_ORIGEN[modulo]} · ${r.actual.perfil}`;
    if (r.sinCambios) {
      return res.json({ message: `La regla ${regla} no tenía cambios.`, reglas: await leerReglas(query) });
    }
    await auditoria.registrar(req.user.id, 'Integración entre módulos',
      `${regla}: ${listaTipos(r.actual.tipos)} → ${tipos.length ? tipos.join(', ') : 'desactivada'}`);
    res.json({ message: mensaje(regla, tipos, r.actual), reglas: await leerReglas(query) });
  } catch (err) {
    responderError(res, err, 'Error guardando regla de integración:');
  }
}

/**
 * POST /api/integracion/reglas   (gerencia y administrador)
 * Body: { modulo, perfil_id, tipos: ['entrada','salida'], actualizar? }
 * Exc 2: si ya hay una regla ACTIVA para ese modulo y rol, 409 con la vigente;
 * se reenvia con actualizar: true para reemplazar sus tipos.
 */
function crearRegla(req, res) {
  return guardarRegla(req, res, {
    permitirVacio: false,
    validar: async (_client, actual, { modulo }) => {
      if (actual.tipos.length && req.body?.actualizar !== true) {
        throw new ErrorNegocio(409, {
          error: `Ya existe una regla activa para ${MODULOS_ORIGEN[modulo]} y el rol ${actual.perfil}.`,
          codigo: 'REGLA_EXISTENTE',
          regla: { modulo, modulo_nombre: MODULOS_ORIGEN[modulo], perfil: actual.perfil, tipos: actual.tipos },
        });
      }
    },
    mensaje: (regla, _tipos, actual) => actual.tipos.length ? `Regla ${regla} actualizada.` : `Regla ${regla} guardada.`,
  });
}

/**
 * PUT /api/integracion/reglas   (gerencia y administrador)
 * Body: { modulo, perfil_id, tipos, confirmar? }. tipos vacio = desactivar la regla.
 * Exc 3: desactivar la ultima regla activa de un modulo con movimientos en los
 * ultimos 30 dias → 409 con el detalle; se reenvia con confirmar: true.
 */
function actualizarRegla(req, res) {
  return guardarRegla(req, res, {
    permitirVacio: true,
    validar: async (client, actual, { modulo, perfilId, tipos }) => {
      if (!actual.existe) {
        throw new ErrorNegocio(404, { error: `No existe una regla para ${MODULOS_ORIGEN[modulo]} y el rol ${actual.perfil}.` });
      }
      const desactiva = tipos.length === 0 && actual.tipos.length > 0;
      if (desactiva && req.body?.confirmar !== true) await exigirSinOperaciones(client, modulo, perfilId, 'desactiva');
    },
    mensaje: (regla, tipos) => tipos.length ? `Regla ${regla} actualizada.` : `Regla ${regla} desactivada.`,
  });
}

/**
 * CU-108 Exc 3: si la regla es la ultima activa del modulo y el modulo registro
 * movimientos en los ultimos 30 dias, 409 con el detalle (se confirma y se reenvia).
 */
async function exigirSinOperaciones(client, modulo, perfilId, verbo) {
  if (await otrasReglasActivas(client, modulo, perfilId) > 0) return;
  const op = await operacionesEnCurso(client, modulo);
  if (op.movimientos > 0) {
    throw new ErrorNegocio(409, {
      error: `Es la última regla activa de ${MODULOS_ORIGEN[modulo]} y ese módulo registró ${op.movimientos} ` +
             `movimiento(s) de inventario en los últimos ${DIAS_OPERACIONES_EN_CURSO} días. Si la ${verbo}, ` +
             `${MODULOS_ORIGEN[modulo]} no podrá registrar más movimientos.`,
      codigo: 'OPERACIONES_EN_CURSO',
      operaciones: { modulo, modulo_nombre: MODULOS_ORIGEN[modulo], movimientos: op.movimientos, ultimo: op.ultimo, dias: DIAS_OPERACIONES_EN_CURSO },
    });
  }
}

/**
 * DELETE /api/integracion/reglas   (gerencia y administrador)
 * Body: { modulo, perfil_id, confirmar? }. Para corregir una regla creada por error:
 * modulo y rol no se editan. Borra sus filas de perfil_permiso; los permisos quedan
 * en el catalogo (los comparten otras reglas). Los movimientos no apuntan a la regla,
 * asi que no se pierde nada: la auditoria conserva que existio.
 * Exc 3 igual que al desactivar, si la regla estaba activa.
 */
async function eliminarRegla(req, res) {
  try {
    const { modulo, perfilId } = await validarCuerpo({ ...req.body, tipos: [] }, TIPOS_INTEGRABLES, { permitirVacio: true });
    const actual = await conTransaccion(async (client) => {
      const a = await estadoRegla(client, modulo, perfilId);
      if (!a.existe) {
        throw new ErrorNegocio(404, { error: `No existe una regla para ${MODULOS_ORIGEN[modulo]} y el rol ${a.perfil}.` });
      }
      if (a.tipos.length && req.body?.confirmar !== true) await exigirSinOperaciones(client, modulo, perfilId, 'elimina');
      await client.query(
        `DELETE FROM perfil_permiso pp USING permiso p
         WHERE p.permiso_id_permiso = pp.permiso_id_permiso
           AND pp.perfil_id_perfil = $1 AND p.permiso_modulo = $2 AND p.permiso_accion = ANY($3)`,
        [perfilId, PERMISO_MODULO, TIPOS_INTEGRABLES.map(t => accionDe(t, modulo))]
      );
      return a;
    });

    const regla = `${MODULOS_ORIGEN[modulo]} · ${actual.perfil}`;
    await auditoria.registrar(req.user.id, 'Integración entre módulos',
      `${regla}: eliminada (${actual.tipos.length ? 'permitía: ' + actual.tipos.join(', ') : 'estaba inactiva'})`);
    res.json({ message: `Regla ${regla} eliminada.`, reglas: await leerReglas(query) });
  } catch (err) {
    responderError(res, err, 'Error eliminando regla de integración:');
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   CU-107: movimientos de inventario registrados desde otro módulo
   Contrato para los otros grupos: docs/sprint/api-integracion.md
   ══════════════════════════════════════════════════════════════════════════ */

const MAX_TEXTO = 100;          // referencia_origen y clave_envio son VARCHAR(100)
const MAX_DESCRIPCION = 500;
const MAX_CANTIDAD = 1e8;       // movimiento_inventario_cantidad NUMERIC(12,4)
const CANTIDAD_RE = /^\d+(\.\d{1,4})?$/;

/**
 * Perfil del usuario = el de igual NOMBRE que su rol (V1). Es el único punto que
 * cambia en la migración a perfiles (docs/sprint/migracion-permisos.md): ahí pasa
 * a leer usuario.perfil_id_perfil.
 */
async function perfilDelUsuario(client, user) {
  const { rows } = await client.query(
    `SELECT perfil_id_perfil AS id FROM perfil WHERE perfil_nombre_perfil = $1`, [user?.rol ?? '']
  );
  return rows[0]?.id ?? null;
}

/** ¿Hay una regla ACTIVA de CU-108 que permita este tipo desde este módulo al perfil? */
async function reglaPermite(client, perfilId, modulo, tipo) {
  if (!perfilId) return false;
  const { rows } = await client.query(
    `SELECT 1 FROM perfil_permiso pp JOIN permiso p ON p.permiso_id_permiso = pp.permiso_id_permiso
     WHERE pp.perfil_id_perfil = $1 AND pp.perfil_permiso_activo
       AND p.permiso_modulo = $2 AND p.permiso_accion = $3`,
    [perfilId, PERMISO_MODULO, accionDe(tipo, modulo)]
  );
  return rows.length > 0;
}

const texto = (v) => (v === undefined || v === null ? '' : String(v).trim());

/** Exc 3: formato de los campos. Devuelve la lista de errores (vacía si todo está bien). */
function erroresDeCampos(b) {
  const errores = [];
  const agregar = (campo, error) => errores.push({ campo, error });

  if (!texto(b.sku)) agregar('sku', 'Indique el SKU del producto.');

  const cant = texto(b.cantidad).replace(',', '.');
  if (!cant) agregar('cantidad', 'Indique la cantidad.');
  else if (!CANTIDAD_RE.test(cant) || Number(cant) <= 0) agregar('cantidad', 'La cantidad debe ser un número mayor que 0, con hasta 4 decimales.');
  else if (Number(cant) >= MAX_CANTIDAD) agregar('cantidad', 'La cantidad es demasiado grande.');

  const bodega = texto(b.bodega_id);
  if (!bodega) agregar('bodega_id', 'Indique la bodega.');
  else if (!/^\d+$/.test(bodega)) agregar('bodega_id', 'La bodega no es válida.');

  const ref = texto(b.referencia);
  if (!ref) agregar('referencia', 'Indique la referencia de la operación (ej. número de obra o de nota de venta).');
  else if (ref.length > MAX_TEXTO) agregar('referencia', `La referencia no puede superar ${MAX_TEXTO} caracteres.`);

  const clave = texto(b.clave_envio);
  if (!clave) agregar('clave_envio', 'Indique la clave de envío (un identificador único por operación, ej. un UUID).');
  else if (clave.length > MAX_TEXTO) agregar('clave_envio', `La clave de envío no puede superar ${MAX_TEXTO} caracteres.`);

  if (texto(b.descripcion).length > MAX_DESCRIPCION) agregar('descripcion', `La descripción no puede superar ${MAX_DESCRIPCION} caracteres.`);
  return errores;
}

const camposInvalidos = (campos) => new ErrorNegocio(400, {
  error: 'Hay campos con error: ' + campos.map(c => c.error).join(' '),
  codigo: 'CAMPOS_INVALIDOS',
  campos,
});

/** Movimiento ya registrado con esta clave de envío (idempotencia), o null. */
async function envioRegistrado(db, modulo, clave) {
  const { rows } = await db.query(
    `SELECT mi.movimiento_inventario_id_movimiento AS id, mi.movimiento_inventario_estado AS estado,
            mi.material_sku AS sku, mi.movimiento_inventario_cantidad AS cantidad,
            mi.bodega_id_bodega AS bodega_id, mi.movimiento_inventario_referencia_origen AS referencia,
            mi.movimiento_inventario_fecha_hora AS fecha_hora,
            LOWER(tm.movimiento_inventario_tipo_movimiento_nombre) AS tipo
     FROM movimiento_inventario mi
     JOIN movimiento_inventario_tipo_movimiento tm
       ON tm.movimiento_inventario_tipo_movimiento_id_tipo_movimiento = mi.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
     WHERE mi.movimiento_inventario_modulo_origen = $1 AND mi.movimiento_inventario_clave_envio = $2`,
    [modulo, clave]
  );
  return rows[0] || null;
}

/** Respuesta a un reenvío: mismos datos → el original (200); datos distintos → 409. */
function respuestaReenvio(previo, e) {
  const mismo = previo.tipo === e.tipo && previo.sku === e.sku && Number(previo.cantidad) === e.cantidad
    && Number(previo.bodega_id) === e.bodegaId && previo.referencia === e.referencia;
  if (!mismo) {
    throw new ErrorNegocio(409, {
      error: `La clave de envío "${e.clave}" ya se usó para otro movimiento (#${previo.id}) con datos distintos. ` +
             'Cada operación debe tener su propia clave.',
      codigo: 'CLAVE_REUTILIZADA',
      movimiento_id: Number(previo.id),
    });
  }
  return {
    message: `Este envío ya fue registrado (movimiento #${previo.id}). No se registró de nuevo.`,
    repetido: true,
    movimiento_id: Number(previo.id),
    estado: previo.estado,
    fecha_hora: previo.fecha_hora,
  };
}

/** Disponible (físico - reservado) de un SKU en una bodega. */
async function disponibleEn(db, sku, bodegaId) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(inventario_bodega_cantidad_fisica - inventario_bodega_cantidad_reservada), 0) AS d
     FROM inventario_bodega WHERE material_sku = $1 AND bodega_id_bodega = $2`,
    [sku, bodegaId]
  );
  return parseFloat(rows[0].d);
}

/**
 * Entrada desde otro módulo = DEVOLUCIÓN de consumo (decisión de la sesión 10): material
 * que vuelve de una obra o de una venta. Lleva el motivo 'devolucion_consumo' (resta del
 * consumo en los reportes) y vuelve al lote más antiguo del SKU en la bodega, como las
 * devoluciones de OT. Si la bodega no tiene lotes de ese SKU, se crea uno.
 */
async function devolverAlStock(client, sku, bodegaId, cantidad) {
  const lote = await reponerFifo(client, sku, bodegaId, cantidad, null);
  if (lote) return lote;
  const { rows } = await client.query(
    `INSERT INTO lote (lote_fecha_ingreso, lote_fecha_recepcion, lote_estado)
     VALUES (now(), now(), 'activo') RETURNING lote_id_lote`
  );
  const loteId = rows[0].lote_id_lote;
  await client.query(
    `UPDATE lote SET lote_numero_lote = 'LOTE-' || to_char(now(), 'YYYYMMDD') || '-' || lote_id_lote
     WHERE lote_id_lote = $1`, [loteId]
  );
  await client.query(
    `INSERT INTO inventario_bodega (material_sku, lote_id_lote, bodega_id_bodega, inventario_bodega_cantidad_fisica)
     VALUES ($1, $2, $3, $4)`,
    [sku, loteId, bodegaId, cantidad]
  );
  return loteId;
}

/**
 * POST /api/integracion/movimientos   (cualquier usuario autenticado; lo decide la regla de CU-108)
 * Body: { modulo, tipo, sku, cantidad, bodega_id, referencia, clave_envio, descripcion? }
 * El usuario es el del token que reenvía el módulo de origen (login común).
 *
 * Orden de validación (nada toca el stock antes de pasarlas todas):
 *   módulo y tipo (400) → regla de CU-108 (403, Exc 1) → campos (400, Exc 3) →
 *   clave de envío ya usada (200 repetido / 409) → bodega (400, Exc 3) →
 *   SKU existente y activo (404, Exc 2) → stock si es salida (409, Exc 4).
 */
async function registrarMovimiento(req, res) {
  const b = req.body || {};
  const modulo = texto(b.modulo).toLowerCase();
  const tipo = texto(b.tipo).toLowerCase();

  try {
    const base = [];
    if (!MODULOS_ORIGEN[modulo]) base.push({ campo: 'modulo', error: `Módulo de origen no válido. Use: ${Object.keys(MODULOS_ORIGEN).join(', ')}.` });
    if (!TIPOS_INTEGRABLES.includes(tipo)) base.push({ campo: 'tipo', error: `Tipo de movimiento no válido. Use: ${TIPOS_INTEGRABLES.join(', ')}.` });
    if (base.length) throw camposInvalidos(base);

    const r = await conTransaccion(async (client) => {
      // Exc 1: la regla de CU-108
      const perfilId = await perfilDelUsuario(client, req.user);
      if (!(await reglaPermite(client, perfilId, modulo, tipo))) {
        throw new ErrorNegocio(403, {
          error: `No tiene permisos para registrar ${tipo === 'entrada' ? 'entradas' : 'salidas'} de inventario ` +
                 `desde ${MODULOS_ORIGEN[modulo]} con el rol ${req.user?.rol || 'desconocido'}. Solicite a Gerencia que configure la regla.`,
          codigo: 'SIN_PERMISO',
        });
      }

      // Exc 3: formato de los campos
      const errores = erroresDeCampos(b);
      if (errores.length) throw camposInvalidos(errores);
      const e = {
        tipo, sku: texto(b.sku), cantidad: Number(texto(b.cantidad).replace(',', '.')),
        bodegaId: Number(texto(b.bodega_id)), referencia: texto(b.referencia),
        clave: texto(b.clave_envio), descripcion: texto(b.descripcion) || null,
      };

      // Idempotencia: la misma clave ya se registró
      const previo = await envioRegistrado(client, modulo, e.clave);
      if (previo) return { reenvio: respuestaReenvio(previo, e) };

      // Exc 3: bodega existente y activa
      const { rows: bod } = await client.query(
        `SELECT bodega_estado FROM bodega WHERE bodega_id_bodega = $1`, [e.bodegaId]
      );
      if (!bod.length) throw camposInvalidos([{ campo: 'bodega_id', error: `La bodega ${e.bodegaId} no existe.` }]);
      if (!['activo', 'activa'].includes(bod[0].bodega_estado)) throw camposInvalidos([{ campo: 'bodega_id', error: `La bodega ${e.bodegaId} no está activa.` }]);

      // Exc 2: SKU existente y activo
      const { rows: mat } = await client.query(
        `SELECT material_estado FROM material WHERE material_sku = $1`, [e.sku]
      );
      if (!mat.length || mat[0].material_estado !== 'activo') {
        throw new ErrorNegocio(404, {
          error: `El producto "${e.sku}" no fue reconocido: ` +
                 (mat.length ? 'está inactivo en el catálogo de inventario.' : 'no existe en el catálogo de inventario.'),
          codigo: 'SKU_NO_RECONOCIDO',
        });
      }

      // Exc 4 (salida) o devolución (entrada)
      let loteId, motivoId = null;
      if (tipo === 'salida') {
        try {
          loteId = (await descontarFifo(client, e.sku, e.bodegaId, e.cantidad)).lote_principal;
        } catch (err) {
          if (err instanceof ErrorNegocio && err.payload?.stock_disponible !== undefined) {
            throw new ErrorNegocio(409, {
              error: `Stock insuficiente de ${e.sku} en la bodega ${e.bodegaId}. Disponible: ${err.payload.stock_disponible}.`,
              codigo: 'STOCK_INSUFICIENTE',
              stock_disponible: err.payload.stock_disponible,
            });
          }
          throw err;
        }
      } else {
        motivoId = await motivoDevolucionConsumo(client);
        loteId = await devolverAlStock(client, e.sku, e.bodegaId, e.cantidad);
      }

      const { rows: mov } = await client.query(
        `INSERT INTO movimiento_inventario (
           movimiento_inventario_cantidad, movimiento_inventario_estado,
           material_sku, bodega_id_bodega, lote_id_lote, usuario_id_usuario,
           movimiento_inventario_tipo_movimiento_id_tipo_movimiento,
           movimiento_inventario_motivo_movimiento_id_motivo_movimiento,
           movimiento_inventario_descripcion_motivo,
           movimiento_inventario_modulo_origen, movimiento_inventario_referencia_origen,
           movimiento_inventario_clave_envio
         ) VALUES ($1, 'completado', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING movimiento_inventario_id_movimiento AS id`,
        [e.cantidad, e.sku, e.bodegaId, loteId, req.user.id, await tipoMovimientoId(client, tipo),
         motivoId, e.descripcion, modulo, e.referencia, e.clave]
      );
      return { e, movimientoId: Number(mov[0].id), disponible: await disponibleEn(client, e.sku, e.bodegaId) };
    });

    if (r.reenvio) return res.json(r.reenvio);

    const { e } = r;
    auditoria.registrar(req.user.id, 'registrar_movimiento_externo',
      `${MODULOS_ORIGEN[modulo]} · ${tipo} · SKU: ${e.sku}, cantidad: ${e.cantidad}, bodega: ${e.bodegaId}, ref: ${e.referencia} (mov #${r.movimientoId})`);
    generarAlertasAutomaticas().catch(err => console.warn('Alertas:', err.message));

    res.status(201).json({
      message: `${tipo === 'entrada' ? 'Entrada' : 'Salida'} registrada en inventario (movimiento #${r.movimientoId}).`,
      repetido: false,
      movimiento_id: r.movimientoId,
      modulo, tipo, sku: e.sku, cantidad: e.cantidad, bodega_id: e.bodegaId, referencia: e.referencia,
      stock_disponible: r.disponible,
    });
  } catch (err) {
    // Dos envíos simultáneos con la misma clave: el índice único deja pasar uno; el otro es un reenvío
    if (err.code === '23505' && err.constraint === 'uk_mov_inv_clave_envio') {
      try {
        const previo = await envioRegistrado({ query }, modulo, texto(b.clave_envio));
        if (previo) {
          return res.json(respuestaReenvio(previo, {
            tipo, sku: texto(b.sku), cantidad: Number(texto(b.cantidad).replace(',', '.')),
            bodegaId: Number(texto(b.bodega_id)), referencia: texto(b.referencia), clave: texto(b.clave_envio),
          }));
        }
      } catch (e2) {
        return responderError(res, e2, 'Error registrando movimiento desde otro módulo:');
      }
    }
    responderError(res, err, 'Error registrando movimiento desde otro módulo:');
  }
}

module.exports = {
  listarReglas, crearRegla, actualizarRegla, eliminarRegla, registrarMovimiento,
  PERMISO_MODULO, MODULOS_ORIGEN, TIPOS_INTEGRABLES, ROL_DEL_USUARIO_SQL, accionDe,
};
