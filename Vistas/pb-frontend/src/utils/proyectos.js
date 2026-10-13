/**
 * F-24: los proyectos de prueba (capacitación y marcha blanca) se reconocen por su código, que
 * empieza con PRY-PRUEBA (ddl/datos_prueba/). Es una marca de datos de prueba, no un nombre de negocio.
 */
const PREFIJO_PRUEBA = 'PRY-PRUEBA';

export const esProyectoDePrueba = (codigo) =>
  typeof codigo === 'string' && codigo.trim().toUpperCase().startsWith(PREFIJO_PRUEBA);
