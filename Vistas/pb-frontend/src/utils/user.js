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

/** Etiqueta de rol mostrada en el sidebar (layout.js) */
export function getRoleLabel(user) {
  return user?.rol === 'gerencia' ? 'Gerencia' : 'JOP';
}

/**
 * D50 (sesión 15): los montos (precios, costos, valores, valorización) se ocultan a jop y
 * técnico. Es la misma regla que ocultaMontos() del backend, que es la que manda: aquí solo
 * se evita mostrar columnas o enlaces que llegarían vacíos.
 */
export function ocultaMontos(user) {
  return ['jop', 'tecnico'].includes(user?.rol);
}
