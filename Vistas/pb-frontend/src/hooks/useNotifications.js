import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API } from '../services/api';

/** Mapeo tipo/origen → ruta React (antes rutas .html en layout.js). */
export function obtenerDestinoNotif(n) {
  const tipo = (n.tipo || '').toLowerCase();
  const origen = (n.origen || '').toLowerCase();
  // CU-83: la programación de activación/desactivación de cuentas vive en Usuarios,
  // no en Reportes > Programación (el "programacion" genérico de más abajo la confundía).
  if (tipo === 'programacion_desactivacion' || tipo === 'programacion_activacion')
    return '/usuarios';
  if (tipo.includes('alerta_stock') || tipo.includes('stock_bajo') || tipo.includes('faltante'))
    return '/alertas';
  if (tipo.includes('merma'))
    return '/movimientos/historial';
  if (tipo.includes('programacion') || tipo.includes('instalacion'))
    return '/reportes/programacion';
  if (tipo.includes('pedido') || tipo.includes('checklist'))
    return '/pedidos/checklist';
  if (tipo.includes('usuario') || tipo.includes('cuenta'))
    return '/usuarios';
  if (origen === 'alertas')
    return '/alertas';
  if (origen === 'movimientos')
    return '/movimientos/historial';
  return '';
}

/**
 * El backend guarda el JSON crudo {accion, usuario_id, fecha} como `mensaje` de
 * programacion_desactivacion/activacion, porque esa misma fila también sirve de
 * payload para /usuarios/procesar-programaciones (ver usuariosController.js). Acá
 * solo se traduce a texto legible para mostrarlo; el mensaje original no se toca.
 */
export function formatearMensajeNotif(n) {
  const tipo = (n.tipo || '').toLowerCase();
  if (tipo === 'programacion_desactivacion' || tipo === 'programacion_activacion') {
    try {
      const data = JSON.parse(n.mensaje);
      const accionTexto = data.accion === 'desactivar' ? 'Desactivación' : 'Activación';
      const fecha = data.fecha ? new Date(data.fecha).toLocaleString('es-CL') : 'fecha desconocida';
      return `${accionTexto} programada para el usuario #${data.usuario_id} el ${fecha}`;
    } catch {
      return n.mensaje; // si el formato cambiara, no ocultar el mensaje original
    }
  }
  return n.mensaje;
}

/**
 * CU-45: campana de notificaciones. Polling del resumen cada 60 s con cleanup.
 */
export function useNotifications() {
  const navigate = useNavigate();
  const [noLeidas, setNoLeidas] = useState(0);
  const [lista, setLista] = useState(null);   // null = cargando
  const [error, setError] = useState(false);

  const cargarResumen = useCallback(async () => {
    try {
      const data = await API.notificaciones.resumen();
      setNoLeidas(data && data.no_leidas > 0 ? data.no_leidas : 0);
    } catch { /* silencio si API no disponible aún */ }
  }, []);

  const cargarLista = useCallback(async () => {
    setError(false);
    try {
      const notifs = await API.notificaciones.listar({ limit: '20' });
      setLista(Array.isArray(notifs) ? notifs : []);
    } catch {
      setError(true);
      setLista([]);
    }
  }, []);

  const marcarTodas = useCallback(async () => {
    try {
      await API.notificaciones.marcarTodasLeidas();
      cargarResumen();
      cargarLista();
    } catch { /* silencio */ }
  }, [cargarResumen, cargarLista]);

  const navegar = useCallback(async (n) => {
    const destino = obtenerDestinoNotif(n);
    try {
      await API.notificaciones.marcarLeida(n.id);
      setLista(prev => prev ? prev.map(x => (x.id === n.id ? { ...x, estado: 'leida' } : x)) : prev);
      setNoLeidas(c => (c > 1 ? c - 1 : 0));
    } catch { /* silencio */ }
    if (destino) navigate(destino);
    return destino;
  }, [navigate]);

  useEffect(() => {
    cargarResumen();
    const id = setInterval(cargarResumen, 60000);
    return () => clearInterval(id);
  }, [cargarResumen]);

  return { noLeidas, lista, error, cargarLista, marcarTodas, navegar };
}
