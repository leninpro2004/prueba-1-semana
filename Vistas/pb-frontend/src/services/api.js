/**
 * api.js — Cliente centralizado para comunicarse con el backend.
 * Conversión 1:1 de Vistas/puertas-blindadas/shared/api.js a módulo ES.
 *
 * Uso:
 *   import { API } from '../services/api';
 *   const materiales = await API.materiales.listar();
 */
import { getToken, USER_KEY, OPS_KEY } from '../utils/session';

export const API_BASE = 'http://localhost:3000/api';

/* ── Manejo de 401 vía router ─────────────────────────── */
// El HTML original hacía window.location.href = 'login.html'.
// En React, AuthContext registra aquí un handler que usa navigate('/login').
let unauthorizedHandler = null;
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

/* ── Auth helpers ─────────────────────────────────────── */
function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${getToken()}`,
  };
}

/**
 * Wrapper genérico de fetch con manejo de errores.
 * Si el servidor devuelve 401 redirige al login (vía router).
 */
export async function apiFetch(path, opciones = {}) {
  // CU-42: sinCola evita que una petición con contraseña quede guardada en la
  // cola offline de sessionStorage (y se reenvíe sola más tarde).
  const { sinCola = false, ...options } = opciones;
  let res;
  try {
    res = await fetch(API_BASE + path, {
      ...options,
      headers: { ...authHeaders(), ...options.headers },
    });
  } catch {
    // CU-106 CP3: Encolar operación pendiente si es una mutación (POST/PUT/DELETE)
    if (!sinCola && options.method && ['POST', 'PUT', 'DELETE'].includes(options.method.toUpperCase())) {
      try {
        const pendientes = JSON.parse(sessionStorage.getItem(OPS_KEY) || '[]');
        pendientes.push({ path, options: { ...options, headers: undefined }, timestamp: Date.now() });
        sessionStorage.setItem(OPS_KEY, JSON.stringify(pendientes));
      } catch { /* silencio */ }
      throw new Error('No se pudo conectar con el servidor. La operación fue encolada y se reintentará cuando se restablezca la conexión.');
    }
    // CU-66 CP2: Mensaje claro cuando el servidor no responde
    throw new Error('No se pudo conectar con el servidor. Verifique su conexión e intente nuevamente.');
  }

  if (res.status === 401) {
    sessionStorage.removeItem(USER_KEY);
    // OPUS-8: el cuerpo del 401 puede traer codigo CUENTA_DESACTIVADA, para que el
    // login explique POR QUE se cerro la sesion en vez de aparecer sin mas.
    let detalle = null;
    try { detalle = await res.clone().json(); } catch { /* sin cuerpo */ }
    if (unauthorizedHandler) unauthorizedHandler(detalle);
    else window.location.href = '/login';
    return null;
  }

  const data = await res.json();

  // CU-96 CP3: 409 Conflict devuelve datos del conflicto para que el frontend decida
  if (res.status === 409) {
    return data;
  }

  if (!res.ok) {
    // OPUS-1: el cuerpo del error viaja adjunto (ej: listado de bodegas cuando
    // el material tiene stock en varias) para que la vista pueda usarlo.
    const err = new Error(data.error || `Error ${res.status}`);
    err.payload = data;
    err.status  = res.status;
    throw err;
  }

  return data;
}

// Mismo filtrado que el original: descarta params falsy
const qsOf = (params = {}) =>
  new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v))
  ).toString();

/* ── API ──────────────────────────────────────────────── */

export const API = {

  /* ── Auth ── */
  auth: {
    login: (username, password) =>
      fetch(API_BASE + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }).then(r => r.json()),

    cambiarPassword: (password_actual, password_nueva) =>
      apiFetch('/auth/cambiar-password', {
        method: 'POST',
        sinCola: true,   // sesión 15: sin conexión, las contraseñas no quedan en la cola offline
        body: JSON.stringify({ password_actual, password_nueva }),
      }),

    // OPUS-8: estado de la cuenta para el cierre de sesión en vivo
    sessionStatus: () => apiFetch('/auth/session-status'),

    // CU-42: devuelve { autorizacion } para revertir ESE movimiento (5 min)
    reautenticar: (password, movimientoId) =>
      apiFetch('/auth/reautenticar', {
        method: 'POST',
        sinCola: true,
        body: JSON.stringify({ password, accion: 'revertir_movimiento', movimiento_id: movimientoId }),
      }),

    // CU-77
    solicitarRecuperacion: (username) =>
      fetch(API_BASE + '/auth/solicitar-recuperacion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      }).then(r => r.json()),

    resetearPassword: (token, password_nueva) =>
      fetch(API_BASE + '/auth/resetear-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password_nueva }),
      }).then(r => r.json()),
  },

  /* ── Materiales ── */
  materiales: {
    listar: (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/materiales' + (qs ? '?' + qs : ''));
    },
    obtener:          (sku)    => apiFetch(`/materiales/${sku}`),
    crear:            (data)   => apiFetch('/materiales', { method: 'POST', body: JSON.stringify(data) }),
    actualizar:       (sku, data) => apiFetch(`/materiales/${sku}`, { method: 'PUT', body: JSON.stringify(data) }),
    eliminar:         (sku)        => apiFetch(`/materiales/${sku}`, { method: 'DELETE' }),
    unidades:         ()       => apiFetch('/materiales/catalogos/unidades'),
    categorias:       ()       => apiFetch('/materiales/catalogos/categorias'),
    // Incremento 2
    reactivar:        (sku)    => apiFetch(`/materiales/${sku}/reactivar`, { method: 'PUT' }),
    duplicar:         (data)   => apiFetch('/materiales/duplicar', { method: 'POST', body: JSON.stringify(data) }),
    historialPrecios: (sku)    => apiFetch(`/materiales/${sku}/historial-precios`),
    precios:          (sku, params = {}) => {
      const qs = qsOf(params);
      return apiFetch(`/materiales/${sku}/precios` + (qs ? '?' + qs : ''));
    },
    pinturasSobrantes: ()      => apiFetch('/materiales/pinturas-sobrantes'),
    // CU-60: vincular o actualizar proveedor. Un 409 trae { duplicado, vigentes } (Exc 2)
    vincularProveedor: (sku, data) => apiFetch(`/materiales/${sku}/proveedores`, { method: 'POST', body: JSON.stringify(data) }),
    // CU-65: comparativa de proveedores del producto (sin precios para jop)
    compararProveedores: (sku) => apiFetch(`/materiales/${encodeURIComponent(sku)}/comparar-proveedores`),
  },

  /* ── Códigos de barras (CU-30) ── */
  codigos: {
    // Busca por código de barras y, si no está, por SKU. 404 = código desconocido (Exc 1)
    resolver:         (valor)  => apiFetch(`/codigos/${encodeURIComponent(valor)}`),
    generar:          (sku)    => apiFetch(`/codigos/${encodeURIComponent(sku)}/generar`, { method: 'POST' }),
  },

  /* ── Conteo cíclico (CU-37) ── */
  conteos: {
    listar: (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/conteos' + (qs ? '?' + qs : ''));
    },
    // Productos de la bodega SIN stock teórico (conteo ciego) + conteo de hoy si existe (Exc 3)
    preparar:         (bodegaId) => apiFetch(`/conteos/bodega/${bodegaId}/preparar`),
    // Un 409 (ya hay conteo hoy y falta justificación) llega como datos: { error, conteo_existente }
    crear:            (data)   => apiFetch('/conteos', { method: 'POST', body: JSON.stringify(data) }),
    obtener:          (id)     => apiFetch(`/conteos/${id}`),
    // CU-43 (solo gerencia): vista previa o resultado guardado; procesar registra las diferencias.
    // Un 409 al procesar (ya procesado, Exc 3) llega como datos: { error, procesado: true }
    diferencias:      (id)     => apiFetch(`/conteos/${id}/diferencias`),
    procesar:         (id)     => apiFetch(`/conteos/${id}/procesar`, { method: 'POST' }),
    // D53 (solo gerencia): aprueba el ajuste del stock por la diferencia. { skus: [...], motivo }
    ajustar:          (id, data) => apiFetch(`/conteos/${id}/ajustes`, { method: 'POST', body: JSON.stringify(data) }),
    // D10 (sesión 4): tolerancias editables por gerencia
    tolerancias:      ()       => apiFetch('/conteos/tolerancias'),
    actualizarTolerancias: (data) => apiFetch('/conteos/tolerancias', { method: 'PUT', body: JSON.stringify(data) }),
    // CU-57: alertas de las diferencias fuera de tolerancia. Un 409 (ya generadas) llega como datos
    generarAlertas:   (id)     => apiFetch(`/conteos/${id}/alertas`, { method: 'POST' }),
  },

  /* ── Pedidos de instalación (CU-120 → 119): la venta de Finanzas y su despacho ── */
  pedidosVenta: {
    listar:    ()         => apiFetch('/pedidos-venta'),
    obtener:   (id)       => apiFetch(`/pedidos-venta/${id}`),
    // { bodega_id, lineas: [{ sku, cantidad, origen }] }: crea o modifica (Exc 3). Un 409 llega como datos
    vincular:  (id, data) => apiFetch(`/pedidos-venta/${id}/vinculacion`, { method: 'PUT', body: JSON.stringify(data) }),
    // CU-119. 409 (YA_PREPARADO, Exc 3) llega como datos: { fecha_preparado, preparado_por }
    preparar:  (id)       => apiFetch(`/pedidos-venta/${id}/preparado`, { method: 'PUT' }),
    // CU-126: retiro por insumo. 409 (YA_RETIRADO, Exc 2; PEDIDO_AVANZADO) llega como datos: { retirado_por, fecha_retiro }
    retirar:   (id, sku, cantidad) => apiFetch(`/pedidos-venta/${id}/retiro/${encodeURIComponent(sku)}`,
                                               { method: 'PUT', body: JSON.stringify({ cantidad }) }),
    // CU-126 Exc 1: el insumo no está en la ubicación indicada. Mismo 409 que retirar
    reportarUbicacion: (id, sku, observacion) => apiFetch(`/pedidos-venta/${id}/retiro/${encodeURIComponent(sku)}/ubicacion`,
                                               { method: 'POST', body: JSON.stringify({ observacion }) }),
    // D51: lo retirado de un insumo vuelve al anaquel (preparado o en carga)
    devolver:  (id, sku)  => apiFetch(`/pedidos-venta/${id}/devolucion/${encodeURIComponent(sku)}`, { method: 'PUT' }),
    // D51 (solo gerencia): de preparado o en carga a vinculado, con motivo
    deshacerPreparado: (id, motivo) => apiFetch(`/pedidos-venta/${id}/deshacer-preparado`, { method: 'PUT', body: JSON.stringify({ motivo }) }),
    // D51 (solo gerencia): venta cancelada → libera todas sus reservas y el pedido queda cancelado
    cancelar:  (id, motivo) => apiFetch(`/pedidos-venta/${id}/cancelar`, { method: 'PUT', body: JSON.stringify({ motivo }) }),
    // CU-125: empleados activos [{ rut, nombre, cargo }]. El RUT es solo el valor del selector: no se muestra (D47)
    empleados: () => apiFetch('/pedidos-venta/empleados'),
    // CU-125. 409 llega como datos: CARGA_INICIADA (Exc 2, reenviar con sumar: true) o YA_RESPONSABLE, con { responsables }
    iniciarCarga: (id, empleado_rut, sumar = false) => apiFetch(`/pedidos-venta/${id}/carga`,
                                               { method: 'POST', body: JSON.stringify({ empleado_rut, sumar }) }),
    // CU-127: salida definitiva. 409 (YA_DESPACHADO, Exc 2) llega como datos: { fecha_despacho, despachado_por }
    despachar: (id, observacion) => apiFetch(`/pedidos-venta/${id}/salida`,
                                               { method: 'PUT', body: JSON.stringify({ observacion }) }),
    // CU-121: q = número de venta o SKU. 404 (Exc 2) se lanza; sin datos (Exc 1) llega con sin_datos y mensaje
    trazabilidad: (q) => apiFetch(`/pedidos-venta/trazabilidad?q=${encodeURIComponent(q)}`),
  },

  /* ── Integración entre módulos (CU-108) ── */
  integracion: {
    reglas:           ()       => apiFetch('/integracion/reglas'),
    // Un 409 llega como datos: { codigo: 'REGLA_EXISTENTE', regla } (Exc 2) → reenviar con actualizar: true
    crearRegla:       (data)   => apiFetch('/integracion/reglas', { method: 'POST', body: JSON.stringify(data) }),
    // tipos: [] desactiva. 409 { codigo: 'OPERACIONES_EN_CURSO', operaciones } (Exc 3) → reenviar con confirmar: true
    actualizarRegla:  (data)   => apiFetch('/integracion/reglas', { method: 'PUT', body: JSON.stringify(data) }),
    // { modulo, perfil_id, confirmar? }: corrige una regla creada por error. Mismo 409 (Exc 3) que al desactivar
    eliminarRegla:    (data)   => apiFetch('/integracion/reglas', { method: 'DELETE', body: JSON.stringify(data) }),
    // CU-107 (lo usan Terreno y Finanzas; aquí, el simulador). Un 409 llega como datos:
    // { codigo: 'STOCK_INSUFICIENTE' | 'CLAVE_REUTILIZADA' }. Sin cola offline: el reintento lo decide el módulo de origen.
    registrarMovimiento: (data) => apiFetch('/integracion/movimientos', { method: 'POST', body: JSON.stringify(data), sinCola: true }),
  },

  /* ── Bodegas ── */
  bodegas: {
    listar:           ()       => apiFetch('/bodegas'),
    obtener:          (id)     => apiFetch(`/bodegas/${id}`),
    stockConsolidado: (id)     => apiFetch(`/bodegas/${id}/stock-consolidado`),
    crear:            (data)   => apiFetch('/bodegas', { method: 'POST', body: JSON.stringify(data) }),
    actualizar:       (id, data) => apiFetch(`/bodegas/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    eliminar:         (id)       => apiFetch(`/bodegas/${id}`, { method: 'DELETE' }),
    // Incremento 2
    crearAnaquel:     (id, data) => apiFetch(`/bodegas/${id}/anaqueles`, { method: 'POST', body: JSON.stringify(data) }),
    editarAnaquel:    (id, anaquelId, data) => apiFetch(`/bodegas/${id}/anaqueles/${anaquelId}`, { method: 'PUT', body: JSON.stringify(data) }),
    eliminarAnaquel:  (id, anaquelId) => apiFetch(`/bodegas/${id}/anaqueles/${anaquelId}`, { method: 'DELETE' }),
  },

  /* ── Movimientos ── */
  movimientos: {
    listar: (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/movimientos' + (qs ? '?' + qs : ''));
    },
    catalogos:        ()       => apiFetch('/movimientos/catalogos'),
    entrada:          (data)   => apiFetch('/movimientos/entrada', { method: 'POST', body: JSON.stringify(data) }),
    salida:           (data)   => apiFetch('/movimientos/salida',  { method: 'POST', body: JSON.stringify(data) }),
    traslado:         (data)   => apiFetch('/movimientos/traslado', { method: 'POST', body: JSON.stringify(data) }),   // D60
    // CU-42: `autorizacion` es el token de API.auth.reautenticar (se exige en CU-44)
    revertir:         (id, autorizacion) => apiFetch(`/movimientos/${id}/revertir`, { method: 'POST', body: JSON.stringify({ autorizacion }) }),
    // Incremento 2 — CU-68.1
    aprobarMerma:     (id)     => apiFetch(`/movimientos/${id}/aprobar-merma`,  { method: 'PUT' }),
    rechazarMerma:    (id)     => apiFetch(`/movimientos/${id}/rechazar-merma`, { method: 'PUT' }),
    // CU-74 CP3: Verificar mermas pendientes >24h
    verificarMermasPendientes: () => apiFetch('/movimientos/verificar-mermas-pendientes', { method: 'POST' }),
    // OPUS-9 (Req #1): backfill del vínculo OT ↔ movimientos (simula salvo aplicar = true)
    vincularOT: (aplicar = false) => apiFetch('/movimientos/vincular-ot' + (aplicar ? '?aplicar=true' : ''), { method: 'POST' }),
  },

  /* ── Proveedores ── */
  proveedores: {
    listar: (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/proveedores' + (qs ? '?' + qs : ''));
    },
    obtener:          (id)     => apiFetch(`/proveedores/${id}`),
    crear:            (data)   => apiFetch('/proveedores', { method: 'POST', body: JSON.stringify(data) }),
    actualizar:       (id, data) => apiFetch(`/proveedores/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    cambiarEstado:    (id, estado) => apiFetch(`/proveedores/${id}/estado`, { method: 'PUT', body: JSON.stringify({ estado }) }),
    eliminar:         (id)     => apiFetch(`/proveedores/${id}`, { method: 'DELETE' }),
    // CU-62: plazo real de entrega y cumplimiento (sin montos)
    cumplimiento:     (id)     => apiFetch(`/proveedores/${id}/cumplimiento`),
    // CU-63: métricas comparativas de cumplimiento entre proveedores
    metricas:         (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/proveedores/metricas' + (qs ? '?' + qs : ''));
    },
    // CU-61: historial de precios del proveedor (solo gerencia)
    precios:          (id, params = {}) => {
      const qs = qsOf(params);
      return apiFetch(`/proveedores/${id}/precios` + (qs ? '?' + qs : ''));
    },
  },

  /* ── Reportes ── */
  reportes: {
    movimientos: (params = {}) => apiFetch('/reportes/movimientos?' + qsOf(params)),
    mermas:      (params = {}) => apiFetch('/reportes/mermas?' + qsOf(params)),
    // Incremento 2
    valorizacion: ()           => apiFetch('/reportes/valorizacion'),
    listarAreas:  ()           => apiFetch('/reportes/areas'),
    consumoArea:  (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/reportes/consumo-area' + (qs ? '?' + qs : ''));
    },
    // OPUS-12 (Req #4): datos preprocesados para los gráficos
    consumoAreaGrafico: (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/reportes/consumo-area/grafico' + (qs ? '?' + qs : ''));
    },
    // OPUS-7: params ?rango=1s|2s|1m|3m|1a y ?semana_inicio=YYYY-MM-DD
    programacionSemanal: (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/reportes/programacion-semanal' + (qs ? '?' + qs : ''));
    },
    // CU-122
    exportarProgramacion: (params = {}) => {
      const token = getToken();
      const qs = qsOf(params);
      return fetch(API_BASE + '/reportes/programacion-semanal/exportar' + (qs ? '?' + qs : ''), {
        headers: { 'Authorization': 'Bearer ' + token }
      });
    },
    exportarProgramacionPDF: (params = {}) => {
      const token = getToken();
      const qs = qsOf(params);
      return fetch(API_BASE + '/reportes/programacion-semanal/exportar-pdf' + (qs ? '?' + qs : ''), {
        headers: { 'Authorization': 'Bearer ' + token }
      });
    },
    // CU-71: ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD (gerencia y jop)
    rotacion: (params = {}) => apiFetch('/reportes/rotacion?' + qsOf(params)),
    // CU-75: ?anio=AAAA (solo gerencia: montos en CLP)
    historico: (anio) => apiFetch('/reportes/historico?' + qsOf({ anio })),
    // CU-104: ?desde=&hasta=&area_id= (gerencia y jop; jop sin montos)
    desviaciones: (params = {}) => apiFetch('/reportes/desviaciones?' + qsOf(params)),
  },

  /* ── Alertas ── */
  alertas: {
    listar: (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/alertas' + (qs ? '?' + qs : ''));
    },
    tipos:    ()   => apiFetch('/alertas/tipos'),
    generar:  ()   => apiFetch('/alertas/generar', { method: 'POST' }),
    resolver: (id) => apiFetch(`/alertas/${id}/resolver`, { method: 'PUT' }),
    // CU-47: evaluación de cobertura contra el plazo del proveedor (gerencia y jop)
    evaluarReposicion: () => apiFetch('/alertas/reposicion/evaluar', { method: 'POST' }),
    // CU-48: panel de alertas de reposición activas (gerencia y jop)
    reposicion:        () => apiFetch('/alertas/reposicion'),
    // CU-55: historial de alertas con tiempos de resolución
    historial:         (params = {}) => apiFetch('/alertas/historial?' + qsOf(params)),
  },

  /* ── Recetas / plantillas por tipo de puerta (OPUS-19) ── */
  recetas: {
    listar:      (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/recetas' + (qs ? '?' + qs : ''));
    },
    // CU-102 / R1: ?area_id= trae solo los insumos de esa área
    obtener:     (id, params = {}) => {
      const qs = qsOf(params);
      return apiFetch(`/recetas/${id}` + (qs ? '?' + qs : ''));
    },
    // R1: receta precargada en la pestaña Consumo. params: { receta_id?, puertas? }
    porOrden:    (otId, params = {}) => {
      const qs = qsOf(params);
      return apiFetch(`/recetas/por-orden/${otId}` + (qs ? '?' + qs : ''));
    },
    // CU-102: módulo de recetas (gerencia y jop)
    crear:       (data)     => apiFetch('/recetas', { method: 'POST', body: JSON.stringify(data) }),
    actualizar:  (id, data) => apiFetch(`/recetas/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    duplicar:    (id, data) => apiFetch(`/recetas/${id}/duplicar`, { method: 'POST', body: JSON.stringify(data) }),
    sugerenciaDuplicado: (id) => apiFetch(`/recetas/${id}/sugerencia-duplicado`),
    cambiarEstado: (id, activo) => apiFetch(`/recetas/${id}/estado`, { method: 'PUT', body: JSON.stringify({ activo }) }),
    cargarEnOT:  (id, otId, modo = 'faltantes') =>
      apiFetch(`/recetas/${id}/cargar-en-ot/${otId}?modo=${modo}`, { method: 'POST' }),
  },

  /* ── Auditoría ── */
  auditoria: {
    acciones: () => apiFetch('/auditoria/acciones'),
  },

  /* ── Pedidos ── */
  pedidos: {
    listar: (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/pedidos' + (qs ? '?' + qs : ''));
    },
    checklist: (id)        => apiFetch(`/pedidos/${id}/checklist`),
    reservar:  (id, data)  => apiFetch(`/pedidos/${id}/reservar`, { method: 'POST', body: JSON.stringify(data) }),
    // CU-110
    reportarDiscrepancia: (id, data) => apiFetch(`/pedidos/${id}/discrepancia`, { method: 'POST', body: JSON.stringify(data) }),
  },

  /* ── Usuarios ── */
  usuarios: {
    listar: (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/usuarios' + (qs ? '?' + qs : ''));
    },
    crear:             (data)   => apiFetch('/usuarios', { method: 'POST', body: JSON.stringify(data) }),
    editarPermisos:    (id, data) => apiFetch(`/usuarios/${id}/permisos`, { method: 'PUT', body: JSON.stringify(data) }),
    recuperarPassword: (id)     => apiFetch(`/usuarios/${id}/recuperar-password`, { method: 'POST' }),
    auditoria: (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/usuarios/auditoria' + (qs ? '?' + qs : ''));
    },
    // CU-83.1 / CU-83.2
    programarDesactivacion: (id, data) => apiFetch(`/usuarios/${id}/programar-desactivacion`, { method: 'POST', body: JSON.stringify(data) }),
    programarActivacion:    (id, data) => apiFetch(`/usuarios/${id}/programar-activacion`,    { method: 'POST', body: JSON.stringify(data) }),
    procesarProgramaciones: ()         => apiFetch('/usuarios/procesar-programaciones',       { method: 'POST' }),
    // OPUS-8: cancelar una programación pendiente
    cancelarProgramacion:   (id, tipo) => apiFetch(`/usuarios/${id}/programacion?tipo=${tipo}`, { method: 'DELETE' }),
  },

  /* ════════════════════════════════════════════════════════
     INCREMENTO 2
     ════════════════════════════════════════════════════════ */

  /* ── Facturas ── */
  facturas: {
    listar: (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/facturas' + (qs ? '?' + qs : ''));
    },
    obtener:        (id)     => apiFetch(`/facturas/${id}`),
    crear:          (data)   => apiFetch('/facturas', { method: 'POST', body: JSON.stringify(data) }),
    buscarNumero:   (numero) => apiFetch(`/facturas/buscar-numero/${encodeURIComponent(numero)}`),
  },

  /* ── Notificaciones ── */
  notificaciones: {
    listar: (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/notificaciones' + (qs ? '?' + qs : ''));
    },
    resumen:         ()   => apiFetch('/notificaciones/resumen'),
    marcarLeida:     (id) => apiFetch(`/notificaciones/${id}/leer`, { method: 'PUT' }),
    marcarTodasLeidas: () => apiFetch('/notificaciones/leer-todas', { method: 'PUT' }),
  },

  /* ── Reservas ── */
  reservas: {
    listar: (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/reservas' + (qs ? '?' + qs : ''));
    },
    // CU-132: motivo opcional (D48); solo gerencia y jop
    liberar: (id, motivo) => apiFetch(`/reservas/${id}/liberar`, { method: 'PUT', body: JSON.stringify({ motivo }) }),
    anular:  (id, motivo) => apiFetch(`/reservas/${id}/anular`,  { method: 'PUT', body: JSON.stringify({ motivo }) }),
    // CU-131: ventas aprobadas con material suelto, vista previa y reserva. 409 llega como datos:
    // STOCK_INSUFICIENTE (Exc 2, reenviar con parcial: true) o YA_RESERVADA / SIN_RESERVABLES (Exc 3)
    ventas:        ()                   => apiFetch('/reservas/ventas'),
    ventaPreview:  (id)                 => apiFetch(`/reservas/ventas/${id}`),
    reservarVenta: (id, parcial = false) => apiFetch(`/reservas/ventas/${id}`, { method: 'POST', body: JSON.stringify({ parcial }) }),
  },

  /* ── Alertas Faltantes ── */
  alertasFaltantes: {
    listar: (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/alertas-faltantes' + (qs ? '?' + qs : ''));
    },
    generar:         ()          => apiFetch('/alertas-faltantes/generar', { method: 'POST' }),
    obtener:         (id)        => apiFetch(`/alertas-faltantes/${id}`),
    emitirSolicitud: (id, data)  => apiFetch(`/alertas-faltantes/${id}/solicitud`, { method: 'PUT', body: JSON.stringify(data || {}) }),
    resolver:        (id, data)  => apiFetch(`/alertas-faltantes/${id}/resolver`,  { method: 'PUT', body: JSON.stringify(data) }),
    // CU-122: insumos especiales vendidos (gerencia). ?estado=abiertas|cerradas|todas
    insumosEspeciales:        (params = {}) => apiFetch('/alertas-faltantes/insumos-especiales?' + qsOf(params)),
    revisarInsumosEspeciales: ()            => apiFetch('/alertas-faltantes/insumos-especiales/revisar', { method: 'POST' }),
    reemplazarInsumoEspecial: (id, data)    => apiFetch(`/alertas-faltantes/insumos-especiales/${id}/reemplazar`, { method: 'POST', body: JSON.stringify(data) }),
    // CU-124: { movimiento_id } o { lote_id, bodega_id } + asignaciones [{ alerta_id, cantidad }] (gerencia y jop)
    vincularInsumoEspecial:   (data)        => apiFetch('/alertas-faltantes/insumos-especiales/vincular', { method: 'POST', body: JSON.stringify(data) }),
    lotesInsumoEspecial:      (id)          => apiFetch(`/alertas-faltantes/insumos-especiales/${id}/lotes`),
  },

  /* ── Seguimiento de pinturas (OPUS-11, Req #3) ── */
  seguimientoPinturas: {
    listar: (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/seguimiento-pinturas' + (qs ? '?' + qs : ''));
    },
    catalogo:  ()          => apiFetch('/seguimiento-pinturas/catalogo'),
    registrar: (data)      => apiFetch('/seguimiento-pinturas', { method: 'POST', body: JSON.stringify(data) }),
    devolver:  (id, data)  => apiFetch(`/seguimiento-pinturas/${id}/devolver`, { method: 'PUT', body: JSON.stringify(data) }),
    // OPUS-16: las dos mueven stock por la diferencia
    corregir:  (id, data)  => apiFetch(`/seguimiento-pinturas/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    anular:    (id, data = {}) => apiFetch(`/seguimiento-pinturas/${id}/anular`, { method: 'PUT', body: JSON.stringify(data) }),
    historial: (sku)       => apiFetch(`/seguimiento-pinturas/material/${encodeURIComponent(sku)}`),
    reporte:   (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/seguimiento-pinturas/reporte' + (qs ? '?' + qs : ''));
    },
  },

  /* ── Herramientas (OPUS-10, Req #5) ── */
  herramientas: {
    listar: (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/herramientas' + (qs ? '?' + qs : ''));
    },
    actualizar: (sku, data) => apiFetch(`/herramientas/${encodeURIComponent(sku)}`, { method: 'PUT', body: JSON.stringify(data) }),
    // OPUS-13: depreciación, asignaciones y mantenimiento
    catalogo: () => apiFetch('/herramientas/catalogo'),
    reporte:  () => apiFetch('/herramientas/reporte'),
    depreciacion:        (sku)       => apiFetch(`/herramientas/${encodeURIComponent(sku)}/depreciacion`),
    configurarDepreciacion: (sku, data) => apiFetch(`/herramientas/${encodeURIComponent(sku)}/depreciacion`, { method: 'PUT', body: JSON.stringify(data) }),
    asignar:             (sku, data) => apiFetch(`/herramientas/${encodeURIComponent(sku)}/asignar`, { method: 'POST', body: JSON.stringify(data) }),
    devolverAsignacion:  (id, data)  => apiFetch(`/herramientas/asignaciones/${id}/devolver`, { method: 'PUT', body: JSON.stringify(data || {}) }),
    asignaciones: (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/herramientas/asignaciones' + (qs ? '?' + qs : ''));
    },
    registrarMantenimiento: (sku, data) => apiFetch(`/herramientas/${encodeURIComponent(sku)}/mantenimiento`, { method: 'POST', body: JSON.stringify(data) }),
    mantenimientos: (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/herramientas/mantenimientos' + (qs ? '?' + qs : ''));
    },
  },

  /* ── Órdenes de Trabajo ── */
  ordenesTrabajo: {
    listar: (params = {}) => {
      const qs = qsOf(params);
      return apiFetch('/ordenes-trabajo' + (qs ? '?' + qs : ''));
    },
    consumos:          (id)       => apiFetch(`/ordenes-trabajo/${id}/consumos`),
    // OPUS-9 (Req #1): movimientos de inventario generados por esta OT
    movimientos:       (id, params = {}) => {
      const qs = qsOf(params);
      return apiFetch(`/ordenes-trabajo/${id}/movimientos` + (qs ? '?' + qs : ''));
    },
    registrarConsumo:  (id, data) => apiFetch(`/ordenes-trabajo/${id}/consumos`, { method: 'POST', body: JSON.stringify(data) }),
    registrarEstimados:(id, data) => apiFetch(`/ordenes-trabajo/${id}/estimados`, { method: 'PUT', body: JSON.stringify(data) }),
    comparativo:       (id)       => apiFetch(`/ordenes-trabajo/${id}/comparativo`),
    costos:            (id)       => apiFetch(`/ordenes-trabajo/${id}/costos`),
    rentabilidad:      (id, margen) => apiFetch(`/ordenes-trabajo/${id}/rentabilidad?margen=${margen}`),
    editarConsumo:     (id, sku, data) => apiFetch(`/ordenes-trabajo/${id}/consumos/${encodeURIComponent(sku)}`, { method: 'PUT', body: JSON.stringify(data) }),
    eliminarMaterial:  (id, sku)    => apiFetch(`/ordenes-trabajo/${id}/materiales/${encodeURIComponent(sku)}`, { method: 'DELETE' }),
    asignarEmpleadoTentativo: (id, empleado_id) => apiFetch(`/ordenes-trabajo/${id}/empleado-tentativo`, { method: 'PUT', body: JSON.stringify({ empleado_id }) }),
    // CU-103: finalizar la OT y procesar sus diferenciales (gerencia y jop)
    finalizar:         (id) => apiFetch(`/ordenes-trabajo/${id}/finalizar`, { method: 'PUT' }),
    diferenciales:     (id) => apiFetch(`/ordenes-trabajo/${id}/diferenciales`),
    procesarDiferenciales: (id) => apiFetch(`/ordenes-trabajo/${id}/diferenciales`, { method: 'POST' }),
    // R1: pestaña Consumo. { receta_id?, cantidad_puertas?, reemplazar_receta?, bodega_id?, lineas: [{ sku, estimado, real }] }
    // Un 409 (RECETA_DISTINTA) llega como datos: se confirma y se reenvía con reemplazar_receta: true
    guardarConsumo:    (id, data) => apiFetch(`/ordenes-trabajo/${id}/consumo`, { method: 'PUT', body: JSON.stringify(data) }),
    // D54 (solo gerencia): corrige el consumo real de una OT cerrada. { lineas: [{ sku, real }], motivo, bodega_id? }
    corregirConsumo:   (id, data) => apiFetch(`/ordenes-trabajo/${id}/correccion`, { method: 'PUT', body: JSON.stringify(data) }),
  },

};
