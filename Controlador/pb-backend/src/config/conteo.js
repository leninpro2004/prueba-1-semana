/**
 * CU-43 / CU-57: tolerancias del conteo ciclico (decision D10, cambiada en la sesion 4).
 *
 * Los valores VIGENTES viven en la tabla tolerancia_conteo y los edita Gerencia
 * desde la aplicacion. Estos son solo los valores INICIALES: los inserta la
 * migracion, y el backend los usa si la tabla esta vacia (instalacion desde cero,
 * porque el DDL no lleva datos). Son valores de partida a validar con el cliente.
 *
 *  - tolerancia: diferencia porcentual hasta la que se considera ruido normal
 *    (se registra, sin alerta).
 *  - umbral critico: sobre este porcentaje la alerta de CU-57 es critica.
 */
const TOLERANCIAS_INICIALES = {
  critico:    { tolerancia_pct: 1, umbral_critico_pct: 5 },
  no_critico: { tolerancia_pct: 5, umbral_critico_pct: 20 },
};

const TIPOS_TOLERANCIA = Object.keys(TOLERANCIAS_INICIALES);

// Limites de los valores editables (los mismos que el CHECK ck_tol_conteo_val)
const UMBRAL_MAXIMO_PCT = 1000;

module.exports = { TOLERANCIAS_INICIALES, TIPOS_TOLERANCIA, UMBRAL_MAXIMO_PCT };
