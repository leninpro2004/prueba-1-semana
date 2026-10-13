/**
 * F-03: carga inicial desde la plantilla Excel. Instrucciones: README.md (misma carpeta).
 *
 *   npm run importar -- <archivo.xlsx> --usuario <usuario> [--aplicar] [--fecha AAAA-MM-DD] [--reporte <ruta.csv>]
 *
 * Sin --aplicar solo SIMULA: valida todo, ejecuta la carga dentro de una transacción y
 * la revierte. No queda nada en la BD. El reporte (CSV) lista cada error y aviso con
 * su hoja, fila y campo, y en la simulación los SKU que se crearían.
 * La conexión sale del .env (DB_NAME, DB_HOST...): revisar a qué base apunta antes de aplicar.
 */
const path = require('path');
const fs = require('fs');
// Antes del pool: pool.js lee la conexión de process.env al cargarse
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const db = require('../../src/db/pool');
const { importar, reporteCsv } = require('./importador');

function leerArgumentos(argv) {
  const args = { archivo: null, aplicar: false, usuario: null, fecha: null, reporte: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--aplicar') args.aplicar = true;
    else if (a === '--usuario') args.usuario = argv[++i];
    else if (a === '--fecha') args.fecha = argv[++i];
    else if (a === '--reporte') args.reporte = argv[++i];
    else if (!a.startsWith('--') && !args.archivo) args.archivo = a;
    else throw new Error(`Argumento no reconocido: ${a}`);
  }
  return args;
}

async function main() {
  let args;
  try {
    args = leerArgumentos(process.argv.slice(2));
    if (!args.archivo || !args.usuario) throw new Error('Faltan el archivo o el usuario.');
  } catch (err) {
    console.error(err.message);
    console.error('Uso: npm run importar -- <archivo.xlsx> --usuario <usuario> [--aplicar] [--fecha AAAA-MM-DD] [--reporte <ruta.csv>]');
    process.exitCode = 1;
    await db.pool.end();
    return;
  }

  const archivo = path.resolve(args.archivo);
  const reporte = path.resolve(args.reporte || path.join(path.dirname(archivo), 'reporte-importacion.csv'));
  console.log(`Base de datos: ${process.env.DB_NAME || 'puertas_blindadas'} en ${process.env.DB_HOST || 'localhost'}`);
  console.log(`Archivo:       ${archivo}`);
  console.log(`Modo:          ${args.aplicar ? 'APLICAR (escribe en la base)' : 'simulación (no escribe nada)'}\n`);

  try {
    const r = await importar(archivo, { aplicar: args.aplicar, usuario: args.usuario, fecha: args.fecha, db });
    fs.writeFileSync(reporte, reporteCsv(r), 'utf8');

    console.log(`Errores: ${r.errores.length} · Avisos: ${r.avisos.length}`);
    for (const e of r.errores.slice(0, 15)) {
      console.log(`  ✗ ${e.hoja ? `${e.hoja}, fila ${e.fila}` : 'general'}${e.campo ? ` (${e.campo})` : ''}: ${e.mensaje}`);
    }
    if (r.errores.length > 15) console.log(`  … y ${r.errores.length - 15} más en el reporte.`);
    if (r.resumen) {
      const s = r.resumen;
      console.log(`\n${r.aplicado ? 'Cargado' : 'Se cargaría'}: ${s.productos} productos, ${s.movimientos} entradas de stock, ` +
                  `${s.bodegas} bodegas, ${s.anaqueles} anaqueles, ${s.proveedores} proveedores, ` +
                  `${s.precios} precios, ${s.categorias_generales} categorías generales y ${s.clasificaciones} clasificaciones nuevas.`);
    }
    if (r.errores.length) console.log('\nNo se cargó nada. Corrija los errores y vuelva a simular.');
    else if (!r.aplicado) console.log('\nSimulación sin errores. Para cargar, repita el comando con --aplicar.');
    console.log(`\nReporte: ${reporte}`);
    if (r.errores.length) process.exitCode = 1;
  } catch (err) {
    console.error(`\nNo se pudo importar: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
}

if (require.main === module) main();
