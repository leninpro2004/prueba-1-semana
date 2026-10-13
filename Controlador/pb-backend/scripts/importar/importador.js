/**
 * F-03: importador masivo de la carga inicial (productos, bodegas, proveedores,
 * precios y stock) desde la plantilla Excel. Uso: scripts/importar/README.md.
 *
 * Tres pasos, siempre en este orden:
 *  1. leerLibro():  lee las hojas y normaliza las celdas. No toca la BD.
 *  2. validar():    revisa cada fila contra la BD (solo lee) y arma el plan.
 *                   Junta TODOS los errores, no se detiene en el primero.
 *  3. aplicarPlan(): escribe el plan dentro de UNA transacción. Si algo falla no
 *                   queda nada. La simulación ejecuta este mismo paso y lo revierte,
 *                   así que también detecta lo que solo la BD sabe (CHECK, UNIQUE).
 *
 * El stock inicial entra como movimientos de entrada con motivo 'carga_inicial'
 * (D78), nunca con un INSERT suelto en inventario_bodega: stockAFecha() reconstruye
 * desde los movimientos.
 *
 * Idempotente: un producto, bodega o proveedor que ya existe (mismo nombre
 * normalizado) se reutiliza, y si es un producto se omite con su stock. Correr dos
 * veces el mismo archivo no duplica nada.
 */
const ExcelJS = require('exceljs');
const { conTransaccion } = require('../../src/db/tx');
const { tipoMovimientoId, motivoMovimientoId, insertarMovimiento } = require('../../src/db/stock');
const { generarCodigoInterno, generarSku } = require('../../src/db/codigos');
const auditoria = require('../../src/controllers/auditoriaController');

const { COLUMNAS } = require('./columnas');

const MOTIVO_CARGA = 'carga_inicial';
const NIVEL_POR_DEFECTO = 'General';
const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

/* Abreviaturas de unidad que se ven en los Excel del cliente. Se resuelven contra el
   catálogo por nombre: si la unidad no existe en la BD, la fila sale con error. */
const ALIAS_UNIDAD = {
  m: 'metro', mt: 'metro', mts: 'metro', metros: 'metro',
  kg: 'kilogramo', kgs: 'kilogramo', kilo: 'kilogramo', kilos: 'kilogramo', kilogramos: 'kilogramo',
  un: 'unidad', und: 'unidad', unid: 'unidad', unidades: 'unidad', u: 'unidad',
  l: 'litro', lt: 'litro', lts: 'litro', litros: 'litro',
  planchas: 'plancha',
};

/* ════════════════════════ Utilidades ════════════════════════ */

/** Minúsculas, sin tildes y con un solo espacio: así se comparan los nombres. */
function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Valor plano de una celda de exceljs (fórmulas, texto enriquecido, hipervínculos). */
function valorCelda(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return valorCelda(v.result);
    if (Array.isArray(v.richText)) return valorCelda(v.richText.map(t => t.text).join(''));
    if ('text' in v) return valorCelda(v.text);
    if ('error' in v) return null;
    return null;
  }
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  return v;
}

/** Número de una celda: acepta 1.5, "1,5" y "1.234,5". Devuelve NaN si no es número. */
function aNumero(v) {
  if (typeof v === 'number') return v;
  let t = String(v).replace(/\s/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : NaN;
}

/** S/N de una celda. null = vacío; undefined = valor que no se entiende. */
function aSiNo(v) {
  if (v == null) return null;
  if (typeof v === 'boolean') return v;
  const t = normalizar(v);
  if (['s', 'si', 'true', 'verdadero', '1', 'x'].includes(t)) return true;
  if (['n', 'no', 'false', 'falso', '0'].includes(t)) return false;
  return undefined;
}

/** Texto de una celda (los números de una columna de texto se aceptan tal cual). */
function aTexto(v) {
  if (v == null) return null;
  // exceljs entrega las fechas a medianoche UTC: se leen en UTC para no correr el día
  if (v instanceof Date) return `${v.getUTCDate()}/${v.getUTCMonth() + 1}/${v.getUTCFullYear()}`;
  return String(v).trim() || null;
}

/* ════════════════════════ 1. Leer ════════════════════════ */

/**
 * Lee la plantilla. `origen` es la ruta del archivo o un Buffer (los tests no
 * escriben archivos). Devuelve { hojas: { productos: [{ fila, datos }], ... }, errores }.
 * La fila 1 de cada hoja son los títulos; se reconocen sin importar mayúsculas,
 * tildes ni el asterisco de obligatoria. Las filas vacías se saltan.
 */
async function leerLibro(origen) {
  const libro = new ExcelJS.Workbook();
  if (Buffer.isBuffer(origen)) await libro.xlsx.load(origen);
  else await libro.xlsx.readFile(origen);

  const hojas = {};
  const errores = [];
  for (const [nombreHoja, columnas] of Object.entries(COLUMNAS)) {
    hojas[nombreHoja] = [];
    const hoja = libro.worksheets.find(h => normalizar(h.name) === nombreHoja);
    if (!hoja) {
      if (nombreHoja === 'productos') {
        errores.push({ hoja: nombreHoja, fila: null, campo: null, mensaje: 'Falta la hoja "productos".' });
      }
      continue;
    }

    // Columna de cada clave según el título de la fila 1
    const indice = {};
    hoja.getRow(1).eachCell((celda, col) => {
      const titulo = normalizar(valorCelda(celda.value)).replace(/\*/g, '').trim();
      const def = columnas.find(c => normalizar(c.titulo) === titulo);
      if (def) indice[def.clave] = col;
    });
    for (const c of columnas.filter(c => c.obligatoria && !indice[c.clave])) {
      errores.push({ hoja: nombreHoja, fila: 1, campo: c.titulo, mensaje: `Falta la columna "${c.titulo}".` });
    }

    for (let f = 2; f <= hoja.rowCount; f++) {
      const fila = hoja.getRow(f);
      const datos = {};
      let vacia = true;
      for (const c of columnas) {
        const v = indice[c.clave] ? valorCelda(fila.getCell(indice[c.clave]).value) : null;
        datos[c.clave] = v;
        if (v != null) vacia = false;
      }
      if (!vacia) hojas[nombreHoja].push({ fila: f, datos });
    }
  }
  return { hojas, errores };
}

/* ════════════════════════ 2. Validar ════════════════════════ */

/** Catálogos y datos existentes que la validación necesita (solo lectura). */
async function cargarExistentes(db) {
  const q = async (sql) => (await db.query(sql)).rows;
  const [unidades, funcionales, generales, materiales, bodegas, anaqueles, proveedores, matProv, motivo] =
    await Promise.all([
      q(`SELECT material_unidad_medida_id_unidad_medida AS id, material_unidad_medida_nombre AS nombre
         FROM material_unidad_medida`),
      q(`SELECT material_categoria_funcional_id_categoria_funcional AS id, material_categoria_funcional_nombre AS nombre
         FROM material_categoria_funcional`),
      q(`SELECT material_categoria_general_id_categoria_general AS id, material_categoria_general_nombre AS nombre
         FROM material_categoria_general`),
      q(`SELECT material_sku AS sku, material_nombre_material AS nombre FROM material`),
      q(`SELECT bodega_id_bodega AS id, bodega_nombre_bodega AS nombre FROM bodega`),
      q(`SELECT anaquel_id_anaquel AS id, anaquel_descripcion AS nombre, bodega_id_bodega AS bodega FROM anaquel`),
      q(`SELECT proveedor_id_proveedor AS id, proveedor_razon_social AS nombre,
                proveedor_doc_identidad_rut_proveedor_opcional AS rut
         FROM proveedor`),
      q(`SELECT material_sku AS sku, proveedor_id_proveedor AS proveedor,
                material_proveedor_proveedor_principal AS principal
         FROM material_proveedor`),
      q(`SELECT 1 FROM movimiento_inventario_motivo_movimiento
         WHERE movimiento_inventario_motivo_movimiento_nombre = '${MOTIVO_CARGA}'`),
    ]);
  const porNombre = (filas) => new Map(filas.map(r => [normalizar(r.nombre), r]));
  return {
    unidades: porNombre(unidades),
    funcionales: porNombre(funcionales),
    generales: porNombre(generales),
    materiales: porNombre(materiales),
    skus: new Map(materiales.map(m => [m.sku.toUpperCase(), m])),
    bodegas: porNombre(bodegas),
    anaqueles: anaqueles,
    proveedores: porNombre(proveedores),
    ruts: new Set(proveedores.filter(p => p.rut).map(p => normalizar(p.rut).replace(/[.\s]/g, ''))),
    matProv,
    hayMotivoCarga: motivo.length > 0,
  };
}

function resolverUnidad(texto, unidades) {
  const n = normalizar(texto).replace(/\.$/, '');
  return unidades.get(n) || unidades.get(ALIAS_UNIDAD[n]) || null;
}

/**
 * Revisa todas las filas y arma el plan. No escribe.
 * Devuelve { errores, avisos, plan }. Con errores, el plan no se aplica.
 */
async function validar(db, hojas, { usuario, fecha } = {}) {
  const errores = [];
  const avisos = [];
  const error = (hoja, fila, campo, mensaje) => errores.push({ hoja, fila, campo, mensaje });
  const aviso = (hoja, fila, campo, mensaje) => avisos.push({ hoja, fila, campo, mensaje });
  const ex = await cargarExistentes(db);

  if (!ex.hayMotivoCarga) {
    error(null, null, null, `Falta el motivo de movimiento "${MOTIVO_CARGA}" en el catálogo (ver ddl/catalogos_inventario.sql).`);
  }

  /* ── Usuario y fecha de la carga ── */
  let usuarioId = null;
  if (!usuario) {
    error(null, null, null, 'Indique el usuario que hace la carga (--usuario).');
  } else {
    const { rows } = await db.query(
      `SELECT usuario_id_usuario AS id, usuario_estado_cuenta AS estado FROM usuario WHERE usuario_username = $1`,
      [usuario]
    );
    if (!rows.length) error(null, null, null, `No existe el usuario "${usuario}".`);
    else if (rows[0].estado !== 'activo') error(null, null, null, `El usuario "${usuario}" no está activo.`);
    else usuarioId = rows[0].id;
  }
  // "Hoy" lo da la BD: la conexión usa la hora de Chile (C-05) y la EC2 corre en UTC
  const { rows: [{ hoy }] } = await db.query(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS hoy`);
  const fechaCarga = fecha || hoy;
  if (!FECHA_ISO.test(fechaCarga) || isNaN(new Date(fechaCarga).getTime())) {
    error(null, null, null, 'La fecha de la carga debe tener el formato AAAA-MM-DD.');
  } else if (fechaCarga > hoy) {
    error(null, null, null, 'La fecha de la carga no puede ser futura.');
  }

  /* ── Bodegas y anaqueles (hoja bodegas) ── */
  const bodegas = new Map();   // nombre normalizado -> { nombre, id?, direccion, anaqueles: Map }
  const bodegaDe = (nombre) => {
    const n = normalizar(nombre);
    if (!bodegas.has(n)) {
      const existente = ex.bodegas.get(n);
      bodegas.set(n, { nombre: existente ? existente.nombre : nombre, id: existente?.id ?? null, direccion: null, anaqueles: new Map() });
    }
    return bodegas.get(n);
  };
  const anaquelDe = (bodega, descripcion) => {
    const n = normalizar(descripcion);
    if (!bodega.anaqueles.has(n)) {
      const existente = bodega.id
        ? ex.anaqueles.find(a => String(a.bodega) === String(bodega.id) && normalizar(a.nombre) === n)
        : null;
      bodega.anaqueles.set(n, { nombre: descripcion, id: existente?.id ?? null });
    }
    return bodega.anaqueles.get(n);
  };
  for (const { fila, datos } of hojas.bodegas || []) {
    const nombre = aTexto(datos.bodega);
    if (!nombre) { error('bodegas', fila, 'bodega', 'Falta el nombre de la bodega.'); continue; }
    if (nombre.length > 150) { error('bodegas', fila, 'bodega', 'El nombre admite hasta 150 caracteres.'); continue; }
    const b = bodegaDe(nombre);
    if (datos.direccion != null) b.direccion = aTexto(datos.direccion);
    if (datos.anaquel != null) anaquelDe(b, aTexto(datos.anaquel));
  }

  /* ── Proveedores ── */
  const proveedores = new Map();   // nombre normalizado -> { id?, datos }
  const rutsArchivo = new Map();
  for (const { fila, datos } of hojas.proveedores || []) {
    const razon = aTexto(datos.razon_social);
    if (!razon) { error('proveedores', fila, 'razón social', 'Falta la razón social.'); continue; }
    const n = normalizar(razon);
    if (proveedores.has(n)) { error('proveedores', fila, 'razón social', `"${razon}" está repetido en la hoja (fila ${proveedores.get(n).fila}).`); continue; }
    const existente = ex.proveedores.get(n);
    if (existente) {
      aviso('proveedores', fila, 'razón social', `"${razon}" ya existe: se usa el registrado y no se modifica.`);
      proveedores.set(n, { fila, id: existente.id, nombre: existente.nombre });
      continue;
    }
    const p = {
      fila, id: null, nombre: razon,
      rut: aTexto(datos.rut), rubro: aTexto(datos.rubro), tipo: aTexto(datos.tipo), pais: aTexto(datos.pais),
      contacto: aTexto(datos.contacto), correo: aTexto(datos.correo), telefono: aTexto(datos.telefono),
    };
    const largos = [['razón social', razon, 200], ['RUT', p.rut, 20], ['tipo', p.tipo, 150], ['país', p.pais, 100],
                    ['contacto', p.contacto, 100], ['correo', p.correo, 254], ['teléfono', p.telefono, 30]];
    const largo = largos.find(([, v, max]) => v && v.length > max);
    if (largo) { error('proveedores', fila, largo[0], `Admite hasta ${largo[2]} caracteres.`); continue; }
    if (p.correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.correo)) { error('proveedores', fila, 'correo', 'El correo no tiene un formato válido.'); continue; }
    if (p.rut) {
      const r = normalizar(p.rut).replace(/[.\s]/g, '');
      if (ex.ruts.has(r)) { error('proveedores', fila, 'RUT', `El RUT ${p.rut} ya está registrado en otro proveedor.`); continue; }
      if (rutsArchivo.has(r)) { error('proveedores', fila, 'RUT', `El RUT ${p.rut} está repetido en la hoja (fila ${rutsArchivo.get(r)}).`); continue; }
      rutsArchivo.set(r, fila);
    }
    proveedores.set(n, p);
  }

  /* ── Productos y su stock ── */
  const productos = new Map();   // nombre normalizado -> producto nuevo
  const stock = [];               // { fila, producto, bodega, anaquel, cantidad }
  const omitidos = new Set();     // nombres normalizados que ya existían
  const ubicaciones = new Map();  // producto|bodega -> fila (para detectar duplicados)
  for (const { fila, datos } of hojas.productos || []) {
    const nombre = aTexto(datos.nombre);
    if (!nombre) { error('productos', fila, 'nombre', 'Falta el nombre del producto.'); continue; }
    const n = normalizar(nombre);
    const faltan = errores.length;

    // Mismas reglas que la pantalla de productos: si no, el producto importado no se podría editar
    if (nombre.length < 3 || nombre.length > 100) error('productos', fila, 'nombre', 'El nombre debe tener entre 3 y 100 caracteres.');

    // Ya existe en el sistema: se omite con su stock (idempotencia)
    if (ex.materiales.has(n)) {
      if (!omitidos.has(n)) {
        aviso('productos', fila, 'nombre', `"${nombre}" ya existe (SKU ${ex.materiales.get(n).sku}): se omite, también su cantidad.`);
        omitidos.add(n);
      }
      continue;
    }

    // Cantidad y ubicación (vale para la primera fila del producto y las siguientes)
    let cantidad = null;
    if (datos.cantidad != null) {
      cantidad = aNumero(datos.cantidad);
      if (isNaN(cantidad) || cantidad < 0) { error('productos', fila, 'cantidad', `"${datos.cantidad}" no es una cantidad válida (número mayor o igual a 0).`); cantidad = null; }
    }
    const nombreBodega = aTexto(datos.bodega);
    const nombreAnaquel = aTexto(datos.anaquel);
    if (cantidad > 0 && !nombreBodega) error('productos', fila, 'bodega', 'Con cantidad mayor a 0, la bodega es obligatoria.');
    if (nombreAnaquel && !nombreBodega) error('productos', fila, 'anaquel', 'El anaquel necesita su bodega.');
    let bodega = null, anaquel = null;
    if (nombreBodega) {
      bodega = bodegas.get(normalizar(nombreBodega)) || (ex.bodegas.has(normalizar(nombreBodega)) ? bodegaDe(nombreBodega) : null);
      if (!bodega) error('productos', fila, 'bodega', `La bodega "${nombreBodega}" no existe ni está en la hoja "bodegas".`);
      else if (nombreAnaquel) {
        anaquel = bodega.anaqueles.get(normalizar(nombreAnaquel)) ||
          (ex.anaqueles.some(a => String(a.bodega) === String(bodega.id) && normalizar(a.nombre) === normalizar(nombreAnaquel))
            ? anaquelDe(bodega, nombreAnaquel) : null);
        if (!anaquel) error('productos', fila, 'anaquel', `El anaquel "${nombreAnaquel}" no existe en la bodega "${nombreBodega}" ni está en la hoja "bodegas".`);
      }
    }
    if (bodega) {
      const clave = `${n}|${normalizar(bodega.nombre)}`;
      if (ubicaciones.has(clave)) {
        error('productos', fila, 'bodega', `"${nombre}" ya tiene una fila en la bodega "${bodega.nombre}" (fila ${ubicaciones.get(clave)}). Sume las cantidades en una sola fila.`);
      } else ubicaciones.set(clave, fila);
    }

    // Fila siguiente de un producto ya definido: solo aporta stock
    if (productos.has(n)) {
      const previo = productos.get(n);
      const otros = ['unidad', 'categoria', 'subcategoria', 'categoria_funcional', 'categoria_general']
        .filter(c => datos[c] != null && normalizar(datos[c]) !== normalizar(previo.datos[c]));
      if (otros.length) aviso('productos', fila, otros.join(', '), `Distinto de la fila ${previo.fila}: se usan los datos de esa fila.`);
      if (errores.length === faltan && cantidad > 0) stock.push({ fila, producto: previo, bodega, anaquel, cantidad });
      continue;
    }

    // Primera fila del producto: sus datos de catálogo
    const p = { fila, datos, nombre, n };
    p.descripcion = aTexto(datos.descripcion);
    p.presentacion = aTexto(datos.presentacion);
    if (p.presentacion && p.presentacion.length > 150) error('productos', fila, 'presentación', 'Admite hasta 150 caracteres.');

    const unidad = datos.unidad != null ? resolverUnidad(datos.unidad, ex.unidades) : null;
    if (datos.unidad == null) error('productos', fila, 'unidad', 'Falta la unidad de medida.');
    else if (!unidad) error('productos', fila, 'unidad', `La unidad "${datos.unidad}" no existe. Válidas: ${[...ex.unidades.values()].map(u => u.nombre).join(', ')}.`);
    p.unidadId = unidad?.id ?? null;

    // Categoría funcional: obligatoria y del catálogo (Herramienta, Insumo, Materia Prima)
    p.categoria_funcional = null;
    if (datos.categoria_funcional == null) error('productos', fila, 'categoría funcional', 'Falta la categoría funcional.');
    else {
      const c = ex.funcionales.get(normalizar(datos.categoria_funcional));
      if (!c) error('productos', fila, 'categoría funcional', `"${datos.categoria_funcional}" no existe. Válidas: ${[...ex.funcionales.values()].map(x => x.nombre).join(', ')}.`);
      else p.categoria_funcional = c.id;
    }

    // Categoría general: obligatoria; si no existe se crea (es la que muestra la lista de productos)
    p.categoria_general = null;
    p.categoriaGeneralNueva = null;
    const general = aTexto(datos.categoria_general);
    if (!general) error('productos', fila, 'categoría general', 'Falta la categoría general.');
    else if (general.length > 150) error('productos', fila, 'categoría general', 'Admite hasta 150 caracteres.');
    else if (ex.generales.has(normalizar(general))) p.categoria_general = ex.generales.get(normalizar(general)).id;
    else p.categoriaGeneralNueva = general;

    // Clasificación: categoría y subcategoría obligatorias; nivel vacío = "General"
    p.categoria = aTexto(datos.categoria);
    p.subcategoria = aTexto(datos.subcategoria);
    p.nivel = aTexto(datos.nivel) || NIVEL_POR_DEFECTO;
    if (!p.categoria) error('productos', fila, 'categoría', 'Falta la categoría de la clasificación.');
    if (!p.subcategoria) error('productos', fila, 'subcategoría', 'Falta la subcategoría de la clasificación.');
    for (const [campo, titulo] of [['categoria', 'categoría'], ['subcategoria', 'subcategoría'], ['nivel', 'nivel']]) {
      if (p[campo] && p[campo].length > 150) error('productos', fila, titulo, 'Admite hasta 150 caracteres.');
    }

    for (const [campo, titulo] of [['critico', 'crítico S/N'], ['especial', 'especial S/N'], ['herramienta', 'herramienta S/N']]) {
      const v = aSiNo(datos[campo]);
      if (v === undefined) error('productos', fila, titulo, `"${datos[campo]}" no es S ni N.`);
      p[campo] = v === true;
    }
    if (p.especial && !p.descripcion) error('productos', fila, 'descripción', 'En un insumo especial la descripción es obligatoria.');

    p.stockMinimo = null;
    if (datos.stock_minimo != null) {
      const v = aNumero(datos.stock_minimo);
      if (isNaN(v) || v < 0) error('productos', fila, 'stock mínimo', `"${datos.stock_minimo}" no es un número mayor o igual a 0.`);
      else if (p.especial) aviso('productos', fila, 'stock mínimo', 'Un insumo especial no lleva stock mínimo: se ignora.');
      else p.stockMinimo = v;
    }

    if (errores.length > faltan) continue;
    productos.set(n, p);
    if (cantidad > 0) stock.push({ fila, producto: p, bodega, anaquel, cantidad });
  }

  /* ── Precios por proveedor ── */
  const precios = [];
  const pares = new Map();
  const principales = new Map();
  for (const { fila, datos } of hojas.precios || []) {
    const nomProd = aTexto(datos.producto);
    const nomProv = aTexto(datos.proveedor);
    if (!nomProd) { error('precios', fila, 'producto', 'Falta el producto.'); continue; }
    if (!nomProv) { error('precios', fila, 'proveedor', 'Falta el proveedor.'); continue; }
    const faltan = errores.length;

    // El producto: nuevo de este archivo, o existente por nombre o SKU
    const np = normalizar(nomProd);
    const nuevo = productos.get(np);
    const existente = ex.materiales.get(np) || ex.skus.get(nomProd.toUpperCase());
    if (!nuevo && !existente) error('precios', fila, 'producto', `"${nomProd}" no está en la hoja "productos" ni en el sistema.`);

    const nv = normalizar(nomProv);
    const prov = proveedores.get(nv) || (ex.proveedores.has(nv) ? { id: ex.proveedores.get(nv).id, nombre: ex.proveedores.get(nv).nombre } : null);
    if (!prov) error('precios', fila, 'proveedor', `"${nomProv}" no está en la hoja "proveedores" ni en el sistema.`);

    const precio = datos.precio != null ? aNumero(datos.precio) : NaN;
    if (!(precio > 0)) error('precios', fila, 'precio', 'El precio debe ser un número mayor que 0.');
    let tiempo = null, minima = null;
    if (datos.tiempo_reposicion != null) {
      tiempo = aNumero(datos.tiempo_reposicion);
      if (!Number.isInteger(tiempo) || tiempo < 0) error('precios', fila, 'tiempo de reposición', 'Debe ser un número entero de días, mayor o igual a 0.');
    }
    if (datos.compra_minima != null) {
      minima = aNumero(datos.compra_minima);
      if (isNaN(minima) || minima < 1) error('precios', fila, 'compra mínima', 'Debe ser un número mayor o igual a 1.');
    }
    const principal = aSiNo(datos.principal);
    if (principal === undefined) error('precios', fila, 'principal S/N', `"${datos.principal}" no es S ni N.`);
    if (errores.length > faltan) continue;

    const claveProd = nuevo ? `nuevo:${np}` : `sku:${existente.sku}`;
    const clavePar = `${claveProd}|${prov.id ?? 'nuevo:' + nv}`;
    if (pares.has(clavePar)) { error('precios', fila, 'proveedor', `El par producto y proveedor está repetido (fila ${pares.get(clavePar)}).`); continue; }
    pares.set(clavePar, fila);

    if (!nuevo && prov.id && ex.matProv.some(mp => mp.sku === existente.sku && String(mp.proveedor) === String(prov.id))) {
      aviso('precios', fila, 'proveedor', `"${nomProd}" ya tiene registrado a "${prov.nombre}": se omite.`);
      continue;
    }
    if (principal === true) {
      if (principales.has(claveProd)) { error('precios', fila, 'principal S/N', `"${nomProd}" ya tiene proveedor principal (fila ${principales.get(claveProd)}).`); continue; }
      if (!nuevo && ex.matProv.some(mp => mp.sku === existente.sku && mp.principal)) {
        error('precios', fila, 'principal S/N', `"${nomProd}" ya tiene un proveedor principal en el sistema.`); continue;
      }
      principales.set(claveProd, fila);
    }
    precios.push({ fila, producto: nuevo || null, skuExistente: nuevo ? null : existente.sku, proveedor: prov,
                   precio, tiempo, minima, principal: principal === true });
  }

  return {
    errores, avisos,
    plan: { usuarioId, fecha: fechaCarga, hoy, bodegas, proveedores, productos, stock, precios },
  };
}

/* ════════════════════════ 3. Aplicar ════════════════════════ */

// F-23b: prefijoSku y generarSku viven en src/db/codigos.js (los usa también el alta rápida de caja chica).

/** Busca por nombre normalizado o crea una fila de la clasificación. Devuelve su id. */
async function clasificacionId(client, cache, nivel, nombre, padreId) {
  const clave = `${nivel}|${padreId ?? ''}|${normalizar(nombre)}`;
  if (cache.has(clave)) return cache.get(clave);
  const tablas = {
    categoria:    { tabla: 'material_clasificacion_categoria', id: 'material_clasificacion_categoria_id',
                    nombre: 'material_clasificacion_categoria_nombre_categoria', padre: null },
    subcategoria: { tabla: 'material_clasificacion_subcategoria', id: 'material_clasificacion_subcategoria_id',
                    nombre: 'material_clasificacion_subcategoria_nombre_subcategoria', padre: 'material_clasificacion_categoria_id' },
    nivel:        { tabla: 'material_clasificacion_nivel_especifico', id: 'material_clasificacion_nivel_especifico_id',
                    nombre: 'material_clasificacion_nivel_especifico_nombre_nivel_especifico', padre: 'material_clasificacion_subcategoria_id' },
  }[nivel];
  const { rows } = await client.query(
    `SELECT ${tablas.id} AS id, ${tablas.nombre} AS nombre FROM ${tablas.tabla}` +
    (tablas.padre ? ` WHERE ${tablas.padre} = $1` : ''),
    tablas.padre ? [padreId] : []
  );
  let id = rows.find(r => normalizar(r.nombre) === normalizar(nombre))?.id;
  let creada = false;
  if (!id) {
    const r = await client.query(
      `INSERT INTO ${tablas.tabla} (${tablas.nombre}${tablas.padre ? ', ' + tablas.padre : ''})
       VALUES ($1${tablas.padre ? ', $2' : ''}) RETURNING ${tablas.id} AS id`,
      tablas.padre ? [nombre, padreId] : [nombre]
    );
    id = r.rows[0].id;
    creada = true;
  }
  cache.set(clave, id);
  return creada ? { id, creada } : id;
}

/**
 * Escribe el plan con el `client` de una transacción abierta. Devuelve el resumen
 * de lo creado. Recibe el plan validado: aquí no se revalida nada.
 */
async function aplicarPlan(client, plan) {
  const resumen = { bodegas: 0, anaqueles: 0, proveedores: 0, categorias_generales: 0, clasificaciones: 0, productos: 0,
                    precios: 0, movimientos: 0, skus: [] };

  const tipoEntrada = await tipoMovimientoId(client, 'entrada');
  const motivoCarga = await motivoMovimientoId(client, MOTIVO_CARGA);
  if (!tipoEntrada || !motivoCarga) throw new Error(`Falta el tipo "entrada" o el motivo "${MOTIVO_CARGA}" en el catálogo.`);

  /* Bodegas y anaqueles */
  for (const b of plan.bodegas.values()) {
    if (!b.id) {
      const { rows } = await client.query(
        `INSERT INTO bodega (bodega_nombre_bodega, bodega_direccion, bodega_estado)
         VALUES ($1, $2, 'activa') RETURNING bodega_id_bodega AS id`,
        [b.nombre, b.direccion]
      );
      b.id = rows[0].id;
      resumen.bodegas++;
    }
    for (const a of b.anaqueles.values()) {
      if (a.id) continue;
      const { rows } = await client.query(
        `INSERT INTO anaquel (anaquel_descripcion, bodega_id_bodega) VALUES ($1, $2) RETURNING anaquel_id_anaquel AS id`,
        [a.nombre, b.id]
      );
      a.id = rows[0].id;
      resumen.anaqueles++;
    }
  }

  /* Proveedores */
  for (const p of plan.proveedores.values()) {
    if (p.id) continue;
    const { rows } = await client.query(
      `INSERT INTO proveedor (proveedor_razon_social, proveedor_estado, proveedor_doc_identidad_rut_proveedor_opcional,
                              proveedor_rubro, proveedor_tipo_proveedor, proveedor_pais, proveedor_contacto_primer_nombre)
       VALUES ($1, 'activo', $2, $3, $4, $5, $6) RETURNING proveedor_id_proveedor AS id`,
      [p.nombre, p.rut, p.rubro, p.tipo, p.pais, p.contacto]
    );
    p.id = rows[0].id;
    if (p.correo) await client.query(`INSERT INTO proveedor_contacto_correo VALUES ($1, $2)`, [p.id, p.correo]);
    if (p.telefono) await client.query(`INSERT INTO proveedor_contacto_telefono VALUES ($1, $2)`, [p.id, p.telefono]);
    resumen.proveedores++;
  }

  /* Productos: clasificación, material y código de barras */
  const cache = new Map();
  const idDe = (r) => {
    if (typeof r === 'object') { resumen.clasificaciones++; return r.id; }
    return r;
  };
  const generales = new Map();   // categorías generales creadas en esta carga
  for (const p of plan.productos.values()) {
    if (p.categoriaGeneralNueva) {
      const clave = normalizar(p.categoriaGeneralNueva);
      if (!generales.has(clave)) {
        const { rows } = await client.query(
          `INSERT INTO material_categoria_general (material_categoria_general_nombre) VALUES ($1)
           RETURNING material_categoria_general_id_categoria_general AS id`,
          [p.categoriaGeneralNueva]
        );
        generales.set(clave, rows[0].id);
        resumen.categorias_generales++;
      }
      p.categoria_general = generales.get(clave);
    }
    const cat = idDe(await clasificacionId(client, cache, 'categoria', p.categoria, null));
    const sub = idDe(await clasificacionId(client, cache, 'subcategoria', p.subcategoria, cat));
    const nivelId = idDe(await clasificacionId(client, cache, 'nivel', p.nivel, sub));
    p.sku = await generarSku(client, p.categoria, p.nombre);
    await client.query(
      `INSERT INTO material (
         material_sku, material_nombre_material, material_descripcion, material_presentacion,
         material_stock_minimo, material_material_critico, material_es_rotativo, material_es_herramienta,
         material_estado, material_unidad_medida_id_unidad_medida,
         material_categoria_general_id_categoria_general, material_categoria_funcional_id_categoria_funcional,
         material_clasificacion_nivel_especifico_id, material_presentacion_fecha_modificacion
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'activo', $9, $10, $11, $12,
                 CASE WHEN $4::varchar IS NULL THEN NULL ELSE now() END)`,
      [p.sku, p.nombre, p.descripcion, p.presentacion, p.stockMinimo, p.critico, !p.especial, p.herramienta,
       p.unidadId, p.categoria_general, p.categoria_funcional, nivelId]
    );
    p.codigoBarras = await generarCodigoInterno(client, p.sku);
    resumen.productos++;
    resumen.skus.push({ fila: p.fila, nombre: p.nombre, sku: p.sku, codigo_barras: p.codigoBarras });
  }

  /* Precios: proveedor del material + historial (fuente importacion) */
  for (const r of plan.precios) {
    const sku = r.producto ? r.producto.sku : r.skuExistente;
    await client.query(
      `INSERT INTO material_proveedor (material_sku, proveedor_id_proveedor, material_proveedor_tiempo_reposicion,
                                       material_proveedor_precio_referencial, material_proveedor_proveedor_principal,
                                       material_proveedor_cantidad_minima)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sku, r.proveedor.id, r.tiempo, r.precio, r.principal, r.minima]
    );
    await client.query(
      `INSERT INTO historial_precio_material
         (material_sku, proveedor_id_proveedor, precio_unitario, fecha_vigencia_desde, fuente, usuario_id_usuario)
       VALUES ($1, $2, $3, $4, 'importacion', $5)`,
      [sku, r.proveedor.id, r.precio, plan.fecha, plan.usuarioId]
    );
    resumen.precios++;
  }

  /* Stock inicial: un lote por fila, con la fecha de la carga (entra primero en el FIFO) */
  const sufijo = plan.fecha.replace(/-/g, '');
  const esHoy = plan.fecha === plan.hoy;
  for (const s of plan.stock) {
    const { rows: lote } = await client.query(
      `INSERT INTO lote (lote_fecha_ingreso, lote_fecha_recepcion, lote_estado)
       VALUES ($1, $1, 'activo') RETURNING lote_id_lote AS id`,
      [plan.fecha]
    );
    const loteId = lote[0].id;
    await client.query(`UPDATE lote SET lote_numero_lote = $1 WHERE lote_id_lote = $2`, [`CARGA-${sufijo}-${loteId}`, loteId]);

    const movId = await insertarMovimiento(client, {
      cantidad: s.cantidad, sku: s.producto.sku, bodegaId: s.bodega.id, loteId,
      usuarioId: plan.usuarioId, tipoId: tipoEntrada, motivoId: motivoCarga,
      descripcion: `Carga inicial (fila ${s.fila} de la planilla)`, otId: null,
    });
    // Con una fecha pasada, el movimiento queda en esa fecha (a medianoche) para que
    // stockAFecha() vea el stock desde ese día.
    if (!esHoy) {
      await client.query(
        `UPDATE movimiento_inventario SET movimiento_inventario_fecha_hora = $1::date
         WHERE movimiento_inventario_id_movimiento = $2`,
        [plan.fecha, movId]
      );
    }
    await client.query(
      `INSERT INTO inventario_bodega (material_sku, lote_id_lote, bodega_id_bodega,
                                      inventario_bodega_cantidad_fisica, anaquel_id_anaquel)
       VALUES ($1, $2, $3, $4, $5)`,
      [s.producto.sku, loteId, s.bodega.id, s.cantidad, s.anaquel?.id ?? null]
    );
    resumen.movimientos++;
  }

  return resumen;
}

/** Señal para revertir la transacción de la simulación después de ejecutarla entera. */
class FinSimulacion extends Error {
  constructor(resumen) { super('simulación'); this.resumen = resumen; }
}

/**
 * Punto de entrada. `origen`: ruta o Buffer. Opciones: { aplicar, usuario, fecha, db }.
 * `db` es el módulo db/pool (o un client) para las lecturas de la validación.
 * Devuelve { aplicado, errores, avisos, resumen }. Con errores nunca escribe.
 */
async function importar(origen, { aplicar = false, usuario, fecha, db } = {}) {
  const lectura = await leerLibro(origen);
  const { errores, avisos, plan } = await validar(db, lectura.hojas, { usuario, fecha });
  errores.unshift(...lectura.errores);
  if (errores.length) return { aplicado: false, errores, avisos, resumen: null };

  let resumen;
  try {
    resumen = await conTransaccion(async (client) => {
      const r = await aplicarPlan(client, plan);
      if (!aplicar) throw new FinSimulacion(r);
      return r;
    });
  } catch (err) {
    if (err instanceof FinSimulacion) return { aplicado: false, errores, avisos, resumen: err.resumen };
    errores.push({ hoja: null, fila: null, campo: null, mensaje: `La base de datos rechazó la carga: ${err.message}` });
    return { aplicado: false, errores, avisos, resumen: null };
  }

  // Auditoría después del COMMIT, nunca dentro de la transacción
  await auditoria.registrar(plan.usuarioId, 'importar_carga_inicial',
    `Carga inicial (${plan.fecha}): ${resumen.productos} productos, ${resumen.movimientos} entradas de stock, ` +
    `${resumen.bodegas} bodegas, ${resumen.proveedores} proveedores, ${resumen.precios} precios`);
  return { aplicado: true, errores, avisos, resumen };
}

/** Reporte CSV (separador ;, con BOM para que Excel en español lo abra bien). */
function reporteCsv({ errores, avisos, resumen }) {
  const celda = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lineas = [['tipo', 'hoja', 'fila', 'campo', 'mensaje', 'sku', 'codigo_barras'].join(';')];
  for (const [tipo, lista] of [['error', errores], ['aviso', avisos]]) {
    for (const e of lista) lineas.push([tipo, e.hoja, e.fila, e.campo, e.mensaje, '', ''].map(celda).join(';'));
  }
  for (const s of resumen?.skus || []) {
    lineas.push(['creado', 'productos', s.fila, 'nombre', s.nombre, s.sku, s.codigo_barras].map(celda).join(';'));
  }
  return '﻿' + lineas.join('\r\n') + '\r\n';
}

module.exports = { COLUMNAS, MOTIVO_CARGA, importar, leerLibro, validar, aplicarPlan, reporteCsv, normalizar };
