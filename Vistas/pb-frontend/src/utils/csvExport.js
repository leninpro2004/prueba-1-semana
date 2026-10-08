/**
 * Exportación de reportes a CSV desde el frontend (SONNET-7, CU-76).
 * Genera el archivo con los datos ya cargados/filtrados en la vista — no requiere backend.
 * Formato: separador ';' y BOM UTF-8, para que Excel en español de Chile lo abra en columnas.
 *
 * CU-76: cada columna puede declarar su formato. Un encabezado es un texto (valor
 * tal cual, como antes) o { titulo, formato } con formato:
 *   'fecha'     → dd/mm/aaaa (fechas sin hora)
 *   'timestamp' → ISO 8601 con la hora local y su desfase: 2026-09-27T14:05:00-03:00
 *   'clp'       → $1.234.567
 *   'numero'    → coma decimal sin separador de miles: 12,5 (Excel es-CL lo lee como número)
 *   'texto'     → tal cual
 * Excepciones del CU: 0 filas (Exc 3) y más de LIMITE_FILAS (Exc 1) lanzan
 * ErrorExportacion con el mensaje para el usuario; cualquier otra falla se
 * traduce a "intente nuevamente" (Exc 2).
 */

export const LIMITE_FILAS = 10000;

export class ErrorExportacion extends Error {}

const dos = (n) => String(n).padStart(2, '0');

/** dd/mm/aaaa. Un 'YYYY-MM-DD' se reordena sin pasar por Date (evita el corrimiento UTC). */
export function formatoFecha(v) {
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const d = new Date(v);
  return isNaN(d) ? s : `${dos(d.getDate())}/${dos(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** ISO 8601 en hora LOCAL con desfase (toISOString daría UTC con 'Z'). */
function formatoTimestamp(v) {
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  const off = -d.getTimezoneOffset();
  const signo = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}` +
         `T${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}` +
         `${signo}${dos(Math.floor(abs / 60))}:${dos(abs % 60)}`;
}

export function formatoClp(v) {
  const n = Math.round(Number(v));
  if (isNaN(n)) return String(v);
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('es-CL');
}

function formatoNumero(v) {
  const n = Number(v);
  if (isNaN(n)) return String(v);
  // Hasta 4 decimales (las cantidades son NUMERIC(12,4)), sin notación científica
  return String(Math.round(n * 1e4) / 1e4).replace('.', ',');
}

const FORMATOS = {
  fecha: formatoFecha,
  timestamp: formatoTimestamp,
  clp: formatoClp,
  numero: formatoNumero,
  texto: (v) => String(v),
};

function escapeCampo(s) {
  return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * Texto del CSV (sin BOM). Función pura: no toca el DOM.
 * @param {Array<string|{titulo: string, formato?: string}>} headers
 * @param {Array<Array<any>>} rows
 */
export function generarCSV(headers, rows) {
  if (!rows || rows.length === 0) {
    throw new ErrorExportacion('No hay datos para exportar.');
  }
  if (rows.length > LIMITE_FILAS) {
    throw new ErrorExportacion(
      `El reporte tiene ${rows.length.toLocaleString('es-CL')} filas y el límite de exportación es ` +
      `${LIMITE_FILAS.toLocaleString('es-CL')}. Acote los filtros del reporte antes de descargar.`
    );
  }
  const columnas = headers.map(h => (typeof h === 'string' ? { titulo: h } : h));
  const formatear = columnas.map(c => FORMATOS[c.formato] || FORMATOS.texto);
  const lineas = [
    columnas.map(c => escapeCampo(c.titulo)).join(';'),
    ...rows.map(r => r.map((v, i) =>
      v == null || v === '' ? '' : escapeCampo((formatear[i] || FORMATOS.texto)(v))).join(';')),
  ];
  return lineas.join('\r\n');
}

/**
 * Genera y descarga el CSV. Lanza ErrorExportacion con el mensaje para el usuario.
 * @param {string} tipo — identificador corto del reporte (ej: 'movimientos'), usado en el nombre de archivo
 */
export function exportarCSV(tipo, headers, rows) {
  try {
    const csv = generarCSV(headers, rows);
    // Fecha LOCAL. Con toISOString() (UTC) el archivo salía fechado al día
    // siguiente desde media tarde en Chile (UTC-4/-3) — detectado en OPUS-12.
    const f = new Date();
    const fecha = `${f.getFullYear()}-${dos(f.getMonth() + 1)}-${dos(f.getDate())}`;
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reporte-${tipo}-${fecha}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    if (err instanceof ErrorExportacion) throw err;   // Exc 1 y 3: su mensaje llega tal cual
    console.error('Error generando CSV:', err);
    throw new ErrorExportacion('No se pudo generar el archivo. Intente nuevamente.');  // Exc 2
  }
}
