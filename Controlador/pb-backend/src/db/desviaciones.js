/**
 * Fórmula de desviación de consumo, única para el comparativo de la OT (CU-92) y
 * los diferenciales procesados (CU-103). Dos implementaciones de la misma fórmula
 * terminan dando números distintos para la misma OT.
 */

const EPS = 1e-9;

/**
 * Desviación de un ítem: real − estimado, en unidades y en % del estimado.
 * Devuelve null si no hay consumo real registrado (no se puede comparar).
 *  - estimado vacío o 0 → tipo 'sin_base', sin porcentaje (CU-103 Exc 2): todo lo
 *    consumido es no planificado, así que la desviación absoluta es el real.
 *  - > 0 'sobre_gasto', < 0 'ahorro', 0 'sin_desviacion'.
 * `pct` va sin redondear: cada llamador redondea a lo que muestra.
 */
function calcularDiferencial(estimado, real) {
  if (real == null || real === '') return null;
  const r = parseFloat(real);
  const e = estimado == null || estimado === '' ? 0 : parseFloat(estimado);
  const abs = r - e;
  if (e <= EPS) return { estimado: e, real: r, abs, pct: null, tipo: 'sin_base' };
  const tipo = abs > EPS ? 'sobre_gasto' : abs < -EPS ? 'ahorro' : 'sin_desviacion';
  return { estimado: e, real: r, abs, pct: (abs / e) * 100, tipo };
}

module.exports = { calcularDiferencial };
