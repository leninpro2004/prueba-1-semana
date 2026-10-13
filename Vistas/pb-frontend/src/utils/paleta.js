import { useSyncExternalStore } from 'react';

/**
 * F-25a (D82): esquema de colores para que el cliente compare la paleta oficial con la de Finanzas.
 * Los dos juegos de tokens viven en global.css; aquí solo se marca <html data-paleta="...">.
 * Es una preferencia visual del navegador (localStorage), no estado de sesión. También se activa con
 * ?paleta=finanzas en la URL. Cuando el cliente elija, se borran este archivo, el selector y el juego que no quedó.
 */
const CLAVE = 'pb_paleta';

export const PALETAS = [
  { valor: 'oficial',  etiqueta: 'Oficial' },
  { valor: 'finanzas', etiqueta: 'Finanzas' },
];

const valida = (p) => PALETAS.some(x => x.valor === p);

export function leerPaleta() {
  try {
    const url = new URLSearchParams(window.location.search).get('paleta');
    if (valida(url)) {
      localStorage.setItem(CLAVE, url);
      return url;
    }
    const guardada = localStorage.getItem(CLAVE);
    if (valida(guardada)) return guardada;
  } catch { /* sin almacenamiento: queda la oficial */ }
  return 'oficial';
}

export function aplicarPaleta(paleta) {
  const p = valida(paleta) ? paleta : 'oficial';
  if (p === 'oficial') delete document.documentElement.dataset.paleta;
  else document.documentElement.dataset.paleta = p;
  try { localStorage.setItem(CLAVE, p); } catch { /* sin almacenamiento: dura hasta recargar */ }
}

/**
 * F-25a' (D82, N-14): composición de la vista para la misma demo. 'nueva' cambia el menú (agrupado por
 * dominio) y el Dashboard (encabezado, tarjetas KPI y secciones, como el Dashboard M7 de Finanzas).
 * Se marca <html data-vista="nueva"> y se avisa con un evento para que Layout y Dashboard cambien sin recargar.
 */
const CLAVE_VISTA = 'pb_vista';
const EVENTO_VISTA = 'pb-vista';

export const VISTAS = [
  { valor: 'actual', etiqueta: 'Actual' },
  { valor: 'nueva',  etiqueta: 'Nueva' },
];

const vistaValida = (v) => VISTAS.some(x => x.valor === v);

export function leerVista() {
  try {
    const url = new URLSearchParams(window.location.search).get('vista');
    if (vistaValida(url)) {
      localStorage.setItem(CLAVE_VISTA, url);
      return url;
    }
    const guardada = localStorage.getItem(CLAVE_VISTA);
    if (vistaValida(guardada)) return guardada;
  } catch { /* sin almacenamiento: queda la actual */ }
  return 'actual';
}

export function aplicarVista(vista) {
  const v = vistaValida(vista) ? vista : 'actual';
  if (v === 'actual') delete document.documentElement.dataset.vista;
  else document.documentElement.dataset.vista = v;
  try { localStorage.setItem(CLAVE_VISTA, v); } catch { /* sin almacenamiento: dura hasta recargar */ }
  window.dispatchEvent(new Event(EVENTO_VISTA));
}

const suscribirVista = (avisar) => {
  window.addEventListener(EVENTO_VISTA, avisar);
  return () => window.removeEventListener(EVENTO_VISTA, avisar);
};

/** Vista vigente ('actual' o 'nueva'); el componente se vuelve a dibujar al cambiarla. */
export function useVista() {
  return useSyncExternalStore(suscribirVista, () => document.documentElement.dataset.vista || 'actual');
}
