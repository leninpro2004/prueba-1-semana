/**
 * Formatea una cantidad numérica para mostrar al usuario.
 * - Enteros: sin decimales (4.0000 → "4")
 * - Decimales: máximo 2 decimales (2.5000 → "2,5" / 10.125 → "10,13")
 * - Separador de miles con punto (estilo CL)
 */
export function formatQty(val) {
  if (val == null || val === '' || isNaN(val)) return '—';
  const n = parseFloat(val);
  if (Number.isInteger(n)) return n.toLocaleString('es-CL');
  return n.toLocaleString('es-CL', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/**
 * Formatea un monto en CLP (sin decimales, con separador de miles).
 * - 1250000 → "$1.250.000"
 * - null → "—"
 */
export function formatMoney(val) {
  if (val == null || val === '' || isNaN(val)) return '—';
  return '$' + Math.round(parseFloat(val)).toLocaleString('es-CL');
}

/* ── Fechas en hora LOCAL ──
   Nunca toISOString() ni cortar el texto de un timestamp por la 'T': el backend manda
   los timestamps en UTC, y de noche en Chile (desde las 20:00 o 21:00) eso ya es el día
   siguiente. Ya causó varios bugs. */

const dos = (n) => String(n).padStart(2, '0');
const aTexto = (d) => `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;

/** 'AAAA-MM-DD' local de hoy + n días (n negativo = hacia atrás). */
export function hoyLocal(n = 0) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return aTexto(d);
}

/**
 * 'AAAA-MM-DD' local de un timestamp o fecha del backend; '—' si no hay.
 * Un 'AAAA-MM-DD' puro (columna DATE como texto) se devuelve tal cual: new Date() lo
 * leería como medianoche UTC y en Chile mostraría el día anterior.
 */
export function fechaLocal(v) {
  if (!v) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return String(v);
  const d = new Date(v);
  return isNaN(d) ? '—' : aTexto(d);
}

/** 'AAAA-MM-DD HH:MM' (con `segundos`, ':SS') local de un timestamp del backend; '—' si no hay. */
export function fechaHoraLocal(v, segundos = false) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d)) return '—';
  return `${aTexto(d)} ${dos(d.getHours())}:${dos(d.getMinutes())}${segundos ? ':' + dos(d.getSeconds()) : ''}`;
}

/** Valor para un <input type="datetime-local">: 'AAAA-MM-DDTHH:MM' en hora local. */
export function datetimeLocal(d = new Date()) {
  return `${aTexto(d)}T${dos(d.getHours())}:${dos(d.getMinutes())}`;
}
