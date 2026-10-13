/** Iniciales del usuario, misma lógica que layout.js */
export function getInitials(user) {
  if (!user?.nombre) return '--';
  return user.nombre
    .split(' ')
    .map(n => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/** Etiqueta de rol mostrada en el sidebar (B-15: antes todo lo que no era gerencia salía "JOP") */
const ETIQUETAS_ROL = {
  gerencia: 'Gerencia',
  jop: 'JOP',
  tecnico: 'Técnico',
  administrador: 'Administrador',
  secretaria: 'Secretaría',
};
export function getRoleLabel(user) {
  return ETIQUETAS_ROL[user?.rol] || '—';
}

/** B-19: los 5 roles que se asignan en Usuarios (crear y editar), con lo que puede hacer cada uno. */
export const ROLES_USUARIO = [
  { valor: 'gerencia',      ayuda: 'acceso completo; aprueba y autoriza' },
  { valor: 'jop',           ayuda: 'opera inventario y OT, sin ver costos' },
  { valor: 'administrador', ayuda: 'opera inventario y ve costos' },
  { valor: 'tecnico',       ayuda: 'solo consulta, sin ver costos' },
  { valor: 'secretaria',    ayuda: 'solo consulta' },
].map(r => ({ ...r, etiqueta: ETIQUETAS_ROL[r.valor] }));

/**
 * B-05 (D81): el apodo se guarda en el navegador, por usuario, sin tocar el username.
 * Persiste entre sesiones en el mismo equipo. localStorage puede fallar (modo privado):
 * entonces simplemente no hay apodo.
 */
const claveApodo = (id) => `pb_apodo_${id}`;
export function getApodo(id) {
  try { return localStorage.getItem(claveApodo(id)) || null; } catch { return null; }
}
export function setApodo(id, apodo) {
  try {
    if (apodo) localStorage.setItem(claveApodo(id), apodo);
    else localStorage.removeItem(claveApodo(id));
  } catch { /* sin almacenamiento: el apodo dura lo que la pestaña */ }
}

/**
 * D50 (sesión 15): los montos (precios, costos, valores, valorización) se ocultan a jop y
 * técnico. Es la misma regla que ocultaMontos() del backend, que es la que manda: aquí solo
 * se evita mostrar columnas o enlaces que llegarían vacíos.
 */
export function ocultaMontos(user) {
  return ['jop', 'tecnico'].includes(user?.rol);
}
