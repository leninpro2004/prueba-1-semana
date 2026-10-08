import { ErrorExportacion, formatoClp, formatoFecha } from './csvExport';

/**
 * Exportación de reportes a PDF en el navegador (D35, opción B con jsPDF).
 *
 * Usa las MISMAS columnas que el CSV ({ titulo, formato } o texto), pero con
 * formatos para leer en papel: fecha-hora "27/09/2026 14:05" (no ISO) y números
 * con separador de miles. jsPDF se carga recién al exportar (import dinámico):
 * quien nunca exporta no descarga la librería.
 *
 * Documento: encabezado (sistema, título, subtítulo, fecha de generación),
 * resumen (pares etiqueta/valor), gráficos, tabla con encabezado repetido en cada
 * página, notas y "Página N de M". Horizontal si la tabla tiene más de 7 columnas.
 */

export const LIMITE_FILAS_PDF = 2000;

const dos = (n) => String(n).padStart(2, '0');

function fechaHora(v) {
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return `${dos(d.getDate())}/${dos(d.getMonth() + 1)}/${d.getFullYear()} ${dos(d.getHours())}:${dos(d.getMinutes())}`;
}

const FORMATOS = {
  fecha: formatoFecha,
  timestamp: fechaHora,
  clp: formatoClp,
  numero: (v) => {
    const n = Number(v);
    return isNaN(n) ? String(v) : n.toLocaleString('es-CL', { maximumFractionDigits: 2 });
  },
  texto: (v) => String(v),
};

/**
 * Las fuentes estándar de PDF solo traen el juego de caracteres de Windows
 * (acentos y ñ sí). Lo demás sale como basura: se reemplaza por su equivalente.
 */
const REEMPLAZOS = { '≥': '>=', '≤': '<=', '−': '-', '→': '->', '⚠': '!', '✓': 'Sí' };
function texto(v) {
  return String(v ?? '')
    .replace(/[≥≤−→⚠✓]/g, c => REEMPLAZOS[c])
    // fuera de Latin-1 y de las comillas/guiones tipográficos de Windows-1252
    .replace(/[^\n -ÿ–—‘’“”…€]/g, '');
}

/**
 * Arma el documento. Pura respecto del DOM: recibe los gráficos ya convertidos a
 * imagen ({ titulo, dataUrl, ancho, alto }), así se puede probar fuera del navegador.
 */
export function construirPDF({ jsPDF, autoTable }, { titulo, subtitulo, resumen = [], imagenes = [], headers, rows, notas = [] }) {
  const columnas = headers.map(h => (typeof h === 'string' ? { titulo: h } : h));
  const formatear = columnas.map(c => FORMATOS[c.formato] || FORMATOS.texto);
  const doc = new jsPDF({ orientation: columnas.length > 7 ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
  const ancho = doc.internal.pageSize.getWidth();
  const alto  = doc.internal.pageSize.getHeight();
  const m = 14;
  const util = ancho - 2 * m;
  const gris = [110, 110, 110];

  // Encabezado
  doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...gris);
  doc.text(texto('Puertas Blindadas — Módulo Inventario'), m, 11);
  doc.setFont('helvetica', 'bold').setFontSize(15).setTextColor(30, 30, 30);
  doc.text(texto(titulo), m, 19);
  let y = 19;
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(60, 60, 60);
  if (subtitulo) {
    const lineas = doc.splitTextToSize(texto(subtitulo), util);
    doc.text(lineas, m, y + 6);
    y += 6 + (lineas.length - 1) * 4.5;
  }
  doc.setFontSize(8).setTextColor(...gris);
  doc.text(`Generado el ${fechaHora(new Date())}`, m, y + 5);
  y += 10;

  // Resumen: pares etiqueta / valor en una tabla sin bordes, en dos columnas
  if (resumen.length) {
    const filas = [];
    for (let i = 0; i < resumen.length; i += 2) {
      const [a, b] = [resumen[i], resumen[i + 1]];
      filas.push([texto(a[0]), texto(a[1]), b ? texto(b[0]) : '', b ? texto(b[1]) : '']);
    }
    autoTable(doc, {
      startY: y, body: filas, theme: 'plain', margin: { left: m, right: m },
      styles: { fontSize: 9, cellPadding: 1.2 },
      columnStyles: { 0: { textColor: gris }, 1: { fontStyle: 'bold' }, 2: { textColor: gris }, 3: { fontStyle: 'bold' } },
    });
    y = doc.lastAutoTable.finalY + 4;
  }

  // Gráficos: al ancho útil, sin pasar de 95 mm de alto
  for (const img of imagenes) {
    let w = util, h = util * (img.alto / img.ancho);
    if (h > 95) { h = 95; w = h * (img.ancho / img.alto); }
    if (y + h + 8 > alto - 14) { doc.addPage(); y = 16; }
    if (img.titulo) {
      doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(40, 40, 40);
      doc.text(texto(img.titulo), m, y + 3);
      y += 5;
    }
    doc.addImage(img.dataUrl, 'PNG', m, y, w, h);
    y += h + 5;
  }

  // Tabla principal
  const derecha = {};
  columnas.forEach((c, i) => { if (c.formato === 'numero' || c.formato === 'clp') derecha[i] = { halign: 'right' }; });
  autoTable(doc, {
    startY: y, margin: { left: m, right: m, bottom: 16 },
    head: [columnas.map(c => texto(c.titulo))],
    body: rows.map(r => r.map((v, i) => (v == null || v === '' ? '' : texto(formatear[i](v))))),
    styles: { fontSize: 8, cellPadding: 1.5, overflow: 'linebreak' },
    headStyles: { fillColor: [232, 131, 58], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [247, 247, 247] },
    columnStyles: derecha,
  });
  y = doc.lastAutoTable.finalY + 5;

  // Notas al pie de la tabla
  if (notas.length) {
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...gris);
    for (const n of notas) {
      const lineas = doc.splitTextToSize(texto(n), util);
      if (y + lineas.length * 3.8 > alto - 14) { doc.addPage(); y = 16; }
      doc.text(lineas, m, y);
      y += lineas.length * 3.8 + 1.5;
    }
  }

  // Pie: página N de M
  const paginas = doc.getNumberOfPages();
  for (let p = 1; p <= paginas; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...gris);
    doc.text(`Página ${p} de ${paginas}`, ancho - m, alto - 8, { align: 'right' });
  }
  return doc;
}

/**
 * Genera y descarga el PDF. Lanza ErrorExportacion con el mensaje para el usuario.
 * `graficos`: [{ titulo, svg }] con el elemento <svg> (vía ref); los que no estén
 * montados se omiten.
 */
export async function exportarPDF({ tipo, titulo, subtitulo, resumen, graficos = [], headers, rows, notas }) {
  if (!rows || rows.length === 0) throw new ErrorExportacion('No hay datos para exportar.');
  if (rows.length > LIMITE_FILAS_PDF) {
    throw new ErrorExportacion(
      `El reporte tiene ${rows.length.toLocaleString('es-CL')} filas y el PDF admite hasta ` +
      `${LIMITE_FILAS_PDF.toLocaleString('es-CL')}. Acote los filtros o use Exportar CSV.`
    );
  }
  try {
    const [{ jsPDF }, { autoTable }, { svgAPng }] = await Promise.all([
      import('jspdf'), import('jspdf-autotable'), import('../components/Charts'),
    ]);
    const imagenes = [];
    for (const g of graficos) {
      if (!g.svg) continue;
      imagenes.push({ titulo: g.titulo, ...await svgAPng(g.svg) });
    }
    const doc = construirPDF({ jsPDF, autoTable }, { titulo, subtitulo, resumen, imagenes, headers, rows, notas });
    const f = new Date();
    doc.save(`reporte-${tipo}-${f.getFullYear()}-${dos(f.getMonth() + 1)}-${dos(f.getDate())}.pdf`);
  } catch (err) {
    if (err instanceof ErrorExportacion) throw err;
    console.error('Error generando PDF:', err);
    throw new ErrorExportacion('No se pudo generar el PDF. Intente nuevamente.');
  }
}
