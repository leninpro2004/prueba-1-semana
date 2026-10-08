/** Pedidos de instalación (CU-120 → 127): etiquetas compartidas por la lista y el detalle. */

export const ESTADO_DESPACHO = {
  sin_vincular: { texto: 'Sin vincular', badge: 'badge-gray' },
  vinculado:    { texto: 'Vinculado',    badge: 'badge-info' },
  preparado:    { texto: 'Preparado',    badge: 'badge-success' },
  en_carga:     { texto: 'En carga',     badge: 'badge-warning' },
  en_transito:  { texto: 'En tránsito',  badge: 'badge-orange' },
  cancelado:    { texto: 'Cancelado',    badge: 'badge-gray' },   // D51: venta cancelada, reservas liberadas
};

export const estadoDespacho = (e) => ESTADO_DESPACHO[e] || { texto: e || '—', badge: 'badge-gray' };

/** D51: Finanzas no fijó el valor de una venta cancelada (las mismas variantes que el backend). */
export const ventaCancelada = (estadoPedido) =>
  ['cancelada', 'cancelado', 'anulada', 'anulado'].includes(String(estadoPedido || '').toLowerCase());

/** Fecha dd-mm-aaaa de una columna DATE (sin pasar por UTC). */
export const fechaCorta = (v) => {
  if (!v) return '—';
  const [a, m, d] = String(v).slice(0, 10).split('-');
  return `${d}-${m}-${a}`;
};

export const fechaHora = (v) => (v ? new Date(v).toLocaleString('es-CL', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '—');
