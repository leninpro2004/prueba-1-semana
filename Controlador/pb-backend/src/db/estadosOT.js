/**
 * Estados de una orden de trabajo (F-28). orden_trabajo_estado no tiene CHECK (sería DDL-08,
 * no recomendado): esta es la única lista de referencia en el backend.
 *
 *  pendiente  → recién creada (F-06)
 *  en_curso   → en producción
 *  finalizada → terminada por jop o gerencia (CU-103)
 *  cancelada  → anulada (F-28); conserva su historial
 *  completada, cerrada → valores heredados que el código siempre trató como terminados
 */
const ESTADO_OT_CANCELADA = 'cancelada';

/** Una OT en cualquiera de estos estados no está abierta: no admite consumos ni cambios. */
const ESTADOS_OT_CERRADA = [ESTADO_OT_CANCELADA, 'finalizada', 'completada', 'cerrada'];

/** La misma lista para un `NOT IN (...)` dentro de un SQL fijo (son constantes, no datos del usuario). */
const SQL_ESTADOS_OT_CERRADA = ESTADOS_OT_CERRADA.map(e => `'${e}'`).join(', ');

module.exports = { ESTADO_OT_CANCELADA, ESTADOS_OT_CERRADA, SQL_ESTADOS_OT_CERRADA };
