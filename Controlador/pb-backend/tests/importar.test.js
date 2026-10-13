const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const db = require('./helpers/db');
const { stockAFecha } = require('../src/db/historico');
const { importar, reporteCsv } = require('../scripts/importar/importador');
const { COLUMNAS } = require('../scripts/importar/columnas');

/**
 * Importador de la carga inicial (F-03, D78).
 *
 * Lo que se protege:
 *  - simular no deja NADA en la BD, aunque ejecute la carga completa;
 *  - una fila inválida aborta todo: no hay cargas a medias;
 *  - el stock entra como movimientos 'carga_inicial', así que stockAFecha(hoy)
 *    coincide con el stock real;
 *  - reimportar el mismo archivo no duplica productos ni stock.
 *
 * Los libros se arman en memoria (Buffer): los tests no escriben archivos.
 * La semilla trae la Bodega Test (1) con su anaquel "Estante A", el Proveedor Test
 * (1) y el material "Material con dos lotes" (MAT-FIFO).
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await db.cerrar(); });

const USUARIO = 'gerente.test';

/** Libro con las hojas indicadas: { productos: [{ nombre: ..., cantidad: ... }], ... } */
async function libro(hojas) {
  const wb = new ExcelJS.Workbook();
  for (const [nombre, filas] of Object.entries(hojas)) {
    const columnas = COLUMNAS[nombre];
    const hoja = wb.addWorksheet(nombre);
    hoja.addRow(columnas.map(c => c.titulo + (c.obligatoria ? ' *' : '')));
    for (const f of filas) hoja.addRow(columnas.map(c => f[c.clave] ?? null));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Lo que todo producto necesita (las mismas reglas que la pantalla de productos). */
const BASE = { unidad: 'unidad', categoria: 'Insumos', subcategoria: 'Varios', categoria_funcional: 'Insumo', categoria_general: 'Insumos' };

const CERRADURA = {
  nombre: 'Cerradura multilock sin pestillo', unidad: 'un', categoria: 'Herrajes', subcategoria: 'Cerraduras',
  categoria_funcional: 'Insumo', categoria_general: 'Herrajes', critico: 'S', stock_minimo: 10, bodega: 'Bodega 2', anaquel: 'Repisa 1', cantidad: 195,
};
const COMPLETO = {
  productos: [
    CERRADURA,
    { ...CERRADURA, anaquel: null, bodega: 'Bodega Test', cantidad: '9,5' },   // mismo producto, otra bodega
    { ...BASE, nombre: 'Lija madera 80', subcategoria: 'Abrasivos', bodega: 'bodega test', cantidad: 10 },
    { ...BASE, nombre: 'Taladro', categoria: 'Equipos', subcategoria: 'Herramienta y equipo', categoria_funcional: 'Herramienta',
      categoria_general: 'Equipos', herramienta: 'S' },   // sin stock
  ],
  bodegas: [{ bodega: 'Bodega 2', anaquel: 'Repisa 1', direccion: 'Galpón 2' }],
  proveedores: [{ razon_social: 'Cerrajería Sur', rut: '76.123.456-7', correo: 'ventas@sur.cl', telefono: '+56 9 1234 5678' }],
  precios: [
    { producto: 'Cerradura multilock sin pestillo', proveedor: 'Cerrajería Sur', precio: 12500, tiempo_reposicion: 7, principal: 'S' },
    { producto: 'MAT-FIFO', proveedor: 'Cerrajería Sur', precio: 800 },   // material que ya existía, por SKU
  ],
};

async function material(nombre) {
  const { rows } = await db.query(
    `SELECT m.material_sku AS sku, m.material_material_critico AS critico, m.material_es_herramienta AS herramienta,
            m.material_stock_minimo AS minimo, n.material_clasificacion_nivel_especifico_nombre_nivel_especifico AS nivel,
            s.material_clasificacion_subcategoria_nombre_subcategoria AS sub,
            cb.material_codigo_barras AS codigo
     FROM inventario.material m
     LEFT JOIN inventario.material_clasificacion_nivel_especifico n
            ON n.material_clasificacion_nivel_especifico_id = m.material_clasificacion_nivel_especifico_id
     LEFT JOIN inventario.material_clasificacion_subcategoria s
            ON s.material_clasificacion_subcategoria_id = n.material_clasificacion_subcategoria_id
     LEFT JOIN inventario.material_codigo_barras cb ON cb.material_sku = m.material_sku
     WHERE m.material_nombre_material = $1`, [nombre]);
  return rows[0] || null;
}

/** Foto de las tablas que el importador escribe. */
async function conteos() {
  const tablas = ['material', 'material_codigo_barras', 'bodega', 'anaquel', 'proveedor', 'material_proveedor',
                  'historial_precio_material', 'lote', 'movimiento_inventario', 'inventario_bodega',
                  'material_clasificacion_categoria', 'material_clasificacion_subcategoria',
                  'material_clasificacion_nivel_especifico'];
  const r = {};
  for (const t of tablas) r[t] = await db.contar(`inventario.${t}`);
  return r;
}

describe('simulación', () => {
  test('ejecuta la carga completa, informa lo que crearía y no deja nada en la BD', async () => {
    const antes = await conteos();
    const r = await importar(await libro(COMPLETO), { usuario: USUARIO, db });

    assert.deepEqual(r.errores, []);
    assert.equal(r.aplicado, false);
    assert.equal(r.resumen.productos, 3);
    assert.equal(r.resumen.movimientos, 3);
    assert.equal(r.resumen.precios, 2);
    assert.equal(r.resumen.skus.length, 3);
    assert.deepEqual(await conteos(), antes);
  });

  test('el reporte CSV lista errores con hoja, fila y campo', async () => {
    const r = await importar(await libro({ productos: [{ nombre: 'Sin unidad', cantidad: 3 }] }), { usuario: USUARIO, db });
    const csv = reporteCsv(r);
    assert.match(csv, /"error";"productos";"2";"unidad"/);
    assert.match(csv, /"error";"productos";"2";"bodega"/);
  });
});

describe('aplicar', () => {
  test('crea materiales con SKU y código de barras, clasificación, precios y stock por movimientos', async () => {
    const r = await importar(await libro(COMPLETO), { aplicar: true, usuario: USUARIO, db });
    assert.deepEqual(r.errores, []);
    assert.equal(r.aplicado, true);

    const cerradura = await material('Cerradura multilock sin pestillo');
    assert.match(cerradura.sku, /^HER-CERRAD-\d{3}$/);
    assert.ok(cerradura.sku.length >= 4 && cerradura.sku.length <= 16);
    assert.match(cerradura.codigo, /^2\d{11}$/);
    assert.equal(cerradura.critico, true);
    assert.equal(parseFloat(cerradura.minimo), 10);
    assert.equal(cerradura.sub, 'Cerraduras');
    assert.equal(cerradura.nivel, 'General');

    // Dos filas = dos bodegas, con decimales con coma
    assert.equal((await db.stockDe(cerradura.sku)).fisica, 204.5);
    const taladro = await material('Taladro');
    assert.equal(taladro.herramienta, true);
    assert.equal((await db.stockDe(taladro.sku)).fisica, 0);

    // El stock entra como entradas 'carga_inicial', una por fila
    assert.equal(await db.contar('inventario.movimiento_inventario mi JOIN inventario.movimiento_inventario_motivo_movimiento m ' +
      'ON m.movimiento_inventario_motivo_movimiento_id_motivo_movimiento = mi.movimiento_inventario_motivo_movimiento_id_motivo_movimiento',
      `m.movimiento_inventario_motivo_movimiento_nombre = 'carga_inicial'`), 3);

    // Anaquel nuevo en la bodega nueva
    const { rows: ub } = await db.query(
      `SELECT b.bodega_nombre_bodega AS bodega, a.anaquel_descripcion AS anaquel
       FROM inventario.inventario_bodega ib JOIN inventario.bodega b ON b.bodega_id_bodega = ib.bodega_id_bodega
       LEFT JOIN inventario.anaquel a ON a.anaquel_id_anaquel = ib.anaquel_id_anaquel
       WHERE ib.material_sku = $1 ORDER BY b.bodega_nombre_bodega`, [cerradura.sku]);
    assert.deepEqual(ub, [{ bodega: 'Bodega 2', anaquel: 'Repisa 1' }, { bodega: 'Bodega Test', anaquel: null }]);

    // Precio: proveedor del material + historial con fuente importacion (también del material que ya existía)
    const { rows: precios } = await db.query(
      `SELECT mp.material_sku AS sku, mp.material_proveedor_precio_referencial::float AS precio,
              mp.material_proveedor_proveedor_principal AS principal, h.fuente
       FROM inventario.material_proveedor mp
       JOIN inventario.proveedor p ON p.proveedor_id_proveedor = mp.proveedor_id_proveedor
       JOIN inventario.historial_precio_material h
         ON h.material_sku = mp.material_sku AND h.proveedor_id_proveedor = mp.proveedor_id_proveedor
       WHERE p.proveedor_razon_social = 'Cerrajería Sur' ORDER BY mp.material_sku`);
    assert.deepEqual(precios, [
      { sku: cerradura.sku, precio: 12500, principal: true, fuente: 'importacion' },
      { sku: 'MAT-FIFO', precio: 800, principal: false, fuente: 'importacion' },
    ].sort((a, b) => a.sku.localeCompare(b.sku)));

    assert.deepEqual(await db.descuadresDeReservas(), []);
  });

  test('stockAFecha(hoy) = stock real después de importar; antes de la carga, 0', async () => {
    await importar(await libro(COMPLETO), { aplicar: true, usuario: USUARIO, db });
    const cerradura = await material('Cerradura multilock sin pestillo');

    const manana = new Date(Date.now() + 24 * 3600 * 1000);
    const reconstruido = await stockAFecha(db, manana);
    assert.equal(reconstruido.get(cerradura.sku), (await db.stockDe(cerradura.sku)).fisica);

    const ayer = new Date(Date.now() - 24 * 3600 * 1000);
    assert.equal((await stockAFecha(db, ayer)).get(cerradura.sku), 0);
  });

  test('con fecha pasada, el lote y el movimiento quedan en esa fecha', async () => {
    await importar(await libro({ productos: [{ ...BASE, nombre: 'Lija madera 80', bodega: 'Bodega Test', cantidad: 4 }] }),
      { aplicar: true, usuario: USUARIO, fecha: '2026-10-01', db });
    const { sku } = await material('Lija madera 80');
    const { rows } = await db.query(
      `SELECT to_char(l.lote_fecha_ingreso, 'YYYY-MM-DD') AS lote,
              to_char(mi.movimiento_inventario_fecha_hora, 'YYYY-MM-DD') AS mov
       FROM inventario.movimiento_inventario mi JOIN inventario.lote l ON l.lote_id_lote = mi.lote_id_lote
       WHERE mi.material_sku = $1`, [sku]);
    assert.deepEqual(rows, [{ lote: '2026-10-01', mov: '2026-10-01' }]);
    assert.equal((await stockAFecha(db, '2026-10-02')).get(sku), 4);
    assert.equal((await stockAFecha(db, '2026-10-01')).get(sku), 0);
  });

  test('una fila inválida aborta todo: no se carga nada', async () => {
    const antes = await conteos();
    const hojas = { ...COMPLETO, productos: [...COMPLETO.productos, { nombre: 'Malo', unidad: 'galaxias', cantidad: -1 }] };
    const r = await importar(await libro(hojas), { aplicar: true, usuario: USUARIO, db });

    assert.equal(r.aplicado, false);
    assert.ok(r.errores.some(e => e.fila === 6 && e.campo === 'unidad'));
    assert.ok(r.errores.some(e => e.fila === 6 && e.campo === 'cantidad'));
    assert.deepEqual(await conteos(), antes);
  });

  test('reimportar el mismo archivo no duplica productos ni stock', async () => {
    const archivo = await libro(COMPLETO);
    await importar(archivo, { aplicar: true, usuario: USUARIO, db });
    const despues = await conteos();

    const r = await importar(archivo, { aplicar: true, usuario: USUARIO, db });
    assert.deepEqual(r.errores, []);
    assert.equal(r.resumen.productos, 0);
    assert.equal(r.resumen.movimientos, 0);
    assert.equal(r.resumen.precios, 0);
    assert.ok(r.avisos.some(a => /ya existe/.test(a.mensaje)));
    assert.deepEqual(await conteos(), despues);
  });

  test('SKU correlativo cuando dos productos comparten la raíz', async () => {
    await importar(await libro({ productos: [
      { ...BASE, nombre: 'Broca 4 mm', subcategoria: 'Brocas' },
      { ...BASE, nombre: 'Broca 6 mm', subcategoria: 'Brocas' },
    ] }), { aplicar: true, usuario: USUARIO, db });
    assert.equal((await material('Broca 4 mm')).sku, 'INS-BROCA-001');
    assert.equal((await material('Broca 6 mm')).sku, 'INS-BROCA-002');
    // La clasificación se crea una sola vez
    assert.equal(await db.contar('inventario.material_clasificacion_subcategoria',
      `material_clasificacion_subcategoria_nombre_subcategoria = 'Brocas'`), 1);
  });
});

describe('validaciones', () => {
  async function errores(hojas, opciones = {}) {
    return (await importar(await libro(hojas), { usuario: USUARIO, db, ...opciones })).errores;
  }

  test('usuario inexistente y fecha futura', async () => {
    const e = await errores({ productos: [] }, { usuario: 'nadie', fecha: '2999-01-01' });
    assert.ok(e.some(x => /No existe el usuario/.test(x.mensaje)));
    assert.ok(e.some(x => /futura/.test(x.mensaje)));
  });

  test('el mismo producto dos veces en la misma bodega es error (hay que sumar)', async () => {
    const e = await errores({ productos: [
      { ...BASE, nombre: 'Bisagras', bodega: 'Bodega Test', cantidad: 21 },
      { ...BASE, nombre: 'BISAGRAS ', bodega: 'Bodega Test', cantidad: 880 },
    ] });
    assert.ok(e.some(x => x.fila === 3 && x.campo === 'bodega'));
  });

  test('bodega o categoría funcional que no existen, S/N inválido, especial sin descripción', async () => {
    const e = await errores({ productos: [
      { ...BASE, nombre: 'Producto A', bodega: 'Bodega Fantasma', cantidad: 1 },
      { ...BASE, nombre: 'Producto B', categoria_funcional: 'Inexistente', critico: 'quizás' },
      { ...BASE, nombre: 'Producto C', especial: 'S' },
      { ...BASE, nombre: 'Producto D', subcategoria: null },
    ] });
    assert.ok(e.some(x => x.fila === 2 && x.campo === 'bodega'));
    assert.ok(e.some(x => x.fila === 3 && x.campo === 'categoría funcional'));
    assert.ok(e.some(x => x.fila === 3 && x.campo === 'crítico S/N'));
    assert.ok(e.some(x => x.fila === 4 && x.campo === 'descripción'));
    assert.ok(e.some(x => x.fila === 5 && x.campo === 'subcategoría'));
  });

  test('precios: producto o proveedor desconocidos y precio no positivo; un par ya registrado se omite', async () => {
    const e = await errores({
      productos: [{ ...BASE, nombre: 'Escudo dorado' }],
      precios: [
        { producto: 'No existe', proveedor: 'Proveedor Test', precio: 100 },
        { producto: 'Escudo dorado', proveedor: 'Otro', precio: 100 },
        { producto: 'Escudo dorado', proveedor: 'Proveedor Test', precio: 0 },
        { producto: 'MAT-FIFO', proveedor: 'Proveedor Test', precio: 10, principal: 'S' },
      ],
    });
    assert.ok(e.some(x => x.hoja === 'precios' && x.fila === 2 && x.campo === 'producto'));
    assert.ok(e.some(x => x.hoja === 'precios' && x.fila === 3 && x.campo === 'proveedor'));
    assert.ok(e.some(x => x.hoja === 'precios' && x.fila === 4 && x.campo === 'precio'));
    // MAT-FIFO ya tiene a Proveedor Test: se omite con aviso, no es error
    assert.ok(!e.some(x => x.hoja === 'precios' && x.fila === 5));
  });

  test('las mismas reglas que la pantalla: nombre de 3 a 100, categoría general, funcional y clasificación', async () => {
    const e = await errores({ productos: [
      { ...BASE, nombre: 'AB' },
      { ...BASE, nombre: 'X'.repeat(101) },
      { nombre: 'Sin categorías', unidad: 'unidad' },
    ] });
    assert.ok(e.some(x => x.fila === 2 && x.campo === 'nombre'));
    assert.ok(e.some(x => x.fila === 3 && x.campo === 'nombre'));
    for (const campo of ['categoría general', 'categoría funcional', 'categoría', 'subcategoría']) {
      assert.ok(e.some(x => x.fila === 4 && x.campo === campo), campo);
    }
  });

  test('una categoría general nueva se crea una sola vez y queda en el material', async () => {
    await importar(await libro({ productos: [
      { ...BASE, nombre: 'Guantes cabritilla', categoria_general: 'EPP' },
      { ...BASE, nombre: 'Pechera soldador', categoria_general: 'epp' },
    ] }), { aplicar: true, usuario: USUARIO, db });
    const { rows } = await db.query(
      `SELECT cg.material_categoria_general_nombre AS general, count(*)::int AS n
       FROM inventario.material m JOIN inventario.material_categoria_general cg
         ON cg.material_categoria_general_id_categoria_general = m.material_categoria_general_id_categoria_general
       WHERE m.material_nombre_material IN ('Guantes cabritilla', 'Pechera soldador') GROUP BY 1`);
    assert.deepEqual(rows, [{ general: 'EPP', n: 2 }]);
  });

  test('RUT repetido con uno ya registrado', async () => {
    await db.query(`UPDATE inventario.proveedor SET proveedor_doc_identidad_rut_proveedor_opcional = '76.123.456-7'
                    WHERE proveedor_id_proveedor = 1`);
    const e = await errores({ productos: [], proveedores: [{ razon_social: 'Nuevo', rut: '76123456-7' }] });
    assert.ok(e.some(x => x.hoja === 'proveedores' && x.campo === 'RUT'));
  });

  test('sin la hoja productos, error claro', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('otra');
    const r = await importar(Buffer.from(await wb.xlsx.writeBuffer()), { usuario: USUARIO, db });
    assert.ok(r.errores.some(x => /Falta la hoja "productos"/.test(x.mensaje)));
  });
});
