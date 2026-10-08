/** CU-37: formato compartido por las pantallas de conteo. */

const ESTADOS = {
  borrador:   { label: 'Borrador',   cls: 'badge-gray' },
  confirmado: { label: 'Confirmado', cls: 'badge-info' },
  procesado:  { label: 'Procesado',  cls: 'badge-success' },
};

export const badgeEstado = (estado) => {
  const e = ESTADOS[estado] || { label: estado, cls: 'badge-gray' };
  return <span className={'badge ' + e.cls}>{e.label}</span>;
};

export const fechaHora = (v) => (v ? new Date(v).toLocaleString('es-CL', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '—');
