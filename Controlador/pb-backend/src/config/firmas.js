/**
 * F-11 (D72): acciones sensibles que piden la firma de un gerente (usuario y contraseña) aunque
 * la sesión esté abierta. Lo pidió el cliente: "lo que sea sensible tiene que llevar contraseña".
 *
 * Todas activas por defecto. Una se apaga sin tocar código con la variable de entorno
 * FIRMAS_DESACTIVADAS (lista separada por comas), por ejemplo:
 *   FIRMAS_DESACTIVADAS=movimiento_manual
 * D73: salida_fecha_pasada no debería apagarse (un movimiento con fecha pasada descuadra el kárdex).
 * revertir_movimiento tampoco (CU-42 lo exige).
 *
 * Paso 1 (15/10): stock y configuración. Paso 2: el resto del catálogo de F-11 (plan, sección 4).
 * La descripción completa la frase "Para ... se necesita la autorización de un gerente".
 */
const ACCIONES_FIRMA = {
  revertir_movimiento: 'revertir un movimiento',
  movimiento_manual:   'registrar una entrada, salida o traslado',
  salida_fecha_pasada: 'registrar una salida con fecha pasada',
  aprobar_merma:       'aprobar o rechazar una merma',
  ajuste_conteo:       'ajustar el stock con un conteo',
  corregir_consumo:    'corregir el consumo de una OT cerrada',
  catalogos:           'modificar los catálogos',
  tolerancias:         'cambiar las tolerancias del conteo',
  umbrales_stock:      'cambiar el stock mínimo, máximo o crítico',
  depreciacion:        'cambiar la depreciación de una herramienta',
  reglas_integracion:  'modificar las reglas de integración',
  // Paso 2
  ot_responsable:      'cambiar el responsable de una OT',
  ot_anular:           'anular una OT',
  precio_proveedor:    'modificar un proveedor o su precio',
  eliminar_maestro:    'eliminar o reactivar un material, una bodega o un anaquel',
  receta_vigente:      'modificar una receta con más de 24 horas o cambiar su estado',
  pedido_cancelar:     'cancelar un pedido o deshacer su preparación',
  usuarios:            'modificar usuarios y permisos',
};

function desactivadas() {
  return String(process.env.FIRMAS_DESACTIVADAS || '').split(',').map(s => s.trim()).filter(Boolean);
}

/** ¿La acción pide firma? (existe en el catálogo y no está desactivada). Se lee en cada llamada. */
function firmaActiva(accion) {
  return Object.prototype.hasOwnProperty.call(ACCIONES_FIRMA, accion) && !desactivadas().includes(accion);
}

module.exports = { ACCIONES_FIRMA, firmaActiva };
