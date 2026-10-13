/**
 * F-03: genera plantilla.xlsx a partir de las columnas del importador, para que la
 * plantilla y el importador nunca digan cosas distintas.
 *
 *   npm run plantilla        (escribe scripts/importar/plantilla.xlsx)
 *
 * No necesita la BD.
 */
const path = require('path');
const ExcelJS = require('exceljs');
const { COLUMNAS } = require('./columnas');

const INSTRUCCIONES = [
  ['Cómo llenar esta planilla'],
  [],
  ['Hoja', 'Qué va'],
  ['productos', 'Una fila por producto y bodega. Si un producto está en dos bodegas, use dos filas con el mismo nombre y la cantidad de cada una. El sistema genera el SKU y el código de barras: no los escriba.'],
  ['bodegas', 'Las bodegas y anaqueles nuevos. Las que ya existen en el sistema no hace falta repetirlas.'],
  ['proveedores', 'Los proveedores nuevos. Un proveedor ya registrado (misma razón social) se usa tal cual.'],
  ['precios', 'El precio de cada producto con cada proveedor. El producto se escribe igual que en la hoja productos (o su SKU si ya existe).'],
  [],
  ['Columna', 'Cómo se llena'],
  ['Columnas con *', 'Obligatorias.'],
  ['unidad', 'Una de las unidades del sistema: unidad, metro, kilogramo, litro, plancha. También sirven m, kg, un, lt.'],
  ['categoría / subcategoría / nivel', 'Clasificación del producto (obligatoria). Si no existen, se crean. Nivel vacío = "General".'],
  ['categoría general', 'Obligatoria. Es la que se ve en la lista de productos (por ejemplo Herrajes, Insumos, EPP). Si no existe, se crea.'],
  ['categoría funcional', 'Obligatoria: Herramienta, Insumo o Materia Prima.'],
  ['crítico / especial / herramienta', 'S o N. Vacío = N. Un producto especial (no rotativo) exige descripción y no lleva stock mínimo.'],
  ['stock mínimo', 'Bajo esta cantidad el sistema avisa. Vacío = sin alerta.'],
  ['cantidad', 'Stock contado, en la unidad del producto (no en cajas). Decimales con coma o punto. Con cantidad, la bodega es obligatoria.'],
  ['precio', 'Precio unitario neto en pesos, por la unidad del producto.'],
  ['tiempo de reposición', 'Días que tarda el proveedor en entregar.'],
  [],
  ['Ejemplo (hoja productos)', 'nombre: Cerradura multilock sin pestillo · unidad: unidad · categoría: Herrajes · subcategoría: Cerraduras · categoría funcional: Insumo · categoría general: Herrajes · bodega: Bodega 2 · cantidad: 195'],
  ['nombre', 'Entre 3 y 100 caracteres.'],
];

async function generar(destino) {
  const libro = new ExcelJS.Workbook();
  libro.creator = 'Puertas Blindadas — Inventario';

  const guia = libro.addWorksheet('instrucciones');
  for (const fila of INSTRUCCIONES) guia.addRow(fila);
  guia.getColumn(1).width = 32;
  guia.getColumn(2).width = 110;
  guia.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
  guia.getRow(1).font = { bold: true, size: 14 };
  for (const n of [3, 9]) guia.getRow(n).font = { bold: true };

  for (const [nombre, columnas] of Object.entries(COLUMNAS)) {
    const hoja = libro.addWorksheet(nombre, { views: [{ state: 'frozen', ySplit: 1 }] });
    hoja.columns = columnas.map(c => ({ header: c.titulo + (c.obligatoria ? ' *' : ''), key: c.clave, width: c.ancho }));
    const titulos = hoja.getRow(1);
    titulos.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    titulos.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF676767' } };
    columnas.forEach((c, i) => {
      if (c.obligatoria) titulos.getCell(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFE8F01' } };
      if (c.siNo) {
        // Lista S/N en las primeras 1000 filas
        const letra = hoja.getColumn(i + 1).letter;
        for (let f = 2; f <= 1000; f++) {
          hoja.getCell(`${letra}${f}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"S,N"'] };
        }
      }
    });
  }
  await libro.xlsx.writeFile(destino);
  return destino;
}

if (require.main === module) {
  generar(path.join(__dirname, 'plantilla.xlsx'))
    .then(d => console.log(`Plantilla generada: ${d}`))
    .catch(err => { console.error(err.message); process.exitCode = 1; });
}

module.exports = { generar };
