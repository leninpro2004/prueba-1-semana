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

/**
 * F-07 (#20): monto en CLP con signo menos si es negativo (-1250 → "-$1.250"; 1250 → "$1.250").
 * Para impactos donde la pérdida se muestra negativa. Igual que el CSV (formatoClp).
 */
export function formatMoneySigno(val) {
  if (val == null || val === '' || isNaN(val)) return '—';
  const n = Math.round(parseFloat(val));
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('es-CL');
}

/* ── Etiquetas legibles de valores guardados en snake_case o sin tildes (sesión 15b) ──
   Solo para mostrar: los filtros y las comparaciones siguen usando el valor guardado. */
const ETIQUETAS = {
  pendiente: 'Pendiente', en_curso: 'En curso', finalizada: 'Finalizada', cancelada: 'Cancelada',
  revertido: 'Revertido', pendiente_aprobacion: 'Pendiente de aprobación',
  'stock critico': 'Stock crítico', 'stock bajo minimo': 'Stock bajo mínimo', 'stock maximo': 'Stock sobre el máximo',
  'diferencia inventario': 'Diferencia de inventario', 'diferencia inventario critica': 'Diferencia de inventario crítica',
  'faltante en retiro': 'Faltante en retiro', 'tiempo reposicion': 'Tiempo de reposición',
  'ubicacion incorrecta': 'Ubicación incorrecta',
};

/** 'en_curso' → 'En curso', 'stock_critico' → 'Stock crítico'; lo desconocido, sin guiones bajos y con mayúscula. */
export function etiqueta(v) {
  if (v == null || v === '') return '—';
  const s = String(v);
  const conocida = ETIQUETAS[s] ?? ETIQUETAS[s.replace(/_/g, ' ').toLowerCase()];
  if (conocida) return conocida;
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
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

/**
 * F-17: nombre corto para las tablas densas (material o proveedor). Si el texto pasa de `max`
 * caracteres (con 5 de holgura) se corta en la última palabra completa que cabe, sin dejar al final un conector
 * ("de", "con"...) ni puntuación, y se agrega "…". El nombre completo va en el title
 * (components/NombreCorto.jsx). Es un corte mecánico: un nombre corto escrito a mano es DDL-06.
 */
const CONECTORES = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'con', 'y', 'e', 'o', 'para', 'en', 'a', 'al', 'por', 'sin']);
export function nombreCorto(texto, max = 30) {
  const t = String(texto ?? '').trim().replace(/\s+/g, ' ');
  // Cortar 2 o 3 letras no ahorra espacio y sí borra el final, que suele ser la medida
  if (t.length <= max + 5) return t;
  const palabras = t.slice(0, max).split(' ');
  if (t[max] !== ' ' && palabras.length > 1) palabras.pop();   // la última quedó cortada a la mitad
  while (palabras.length > 1 && CONECTORES.has(palabras[palabras.length - 1].toLowerCase())) palabras.pop();
  const corto = palabras.join(' ').replace(/[\s,;:.\-–(]+$/, '');
  return (corto || t.slice(0, max)) + '…';
}
