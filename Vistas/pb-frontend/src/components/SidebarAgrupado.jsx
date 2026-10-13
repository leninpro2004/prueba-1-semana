import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { getInitials, getRoleLabel } from '../utils/user';
import { COLLAPSE_KEY } from '../utils/session';
import { LOGO_SIMBOLO } from '../config/marca';

/**
 * F-25a' (D82, N-14): menú agrupado por dominio con acordeón (lineamientos de composición, sección 1;
 * DashboardWrapper de Finanzas). Se ve con "Vista: Nueva". Mismas entradas y mismas reglas por rol que
 * Sidebar.jsx; cuando el cliente elija, queda uno solo de los dos.
 * Se abre un grupo a la vez; al navegar queda abierto el de la pantalla actual. Colapsado (solo íconos)
 * no hay grupos: se ven todos los ítems, como en el menú actual.
 */

const Icono = ({ children }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">{children}</svg>
);

const I = {
  panel:        <Icono><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></Icono>,
  productos:    <Icono><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></Icono>,
  bodegas:      <Icono><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></Icono>,
  movimientos:  <Icono><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></Icono>,
  conteos:      <Icono><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><polyline points="9 14 11 16 15 12"/></Icono>,
  reservas:     <Icono><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></Icono>,
  ordenes:      <Icono><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></Icono>,
  checklist:    <Icono><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></Icono>,
  recetas:      <Icono><path d="M9 3h6"/><path d="M10 3v5L5 18a2 2 0 002 3h10a2 2 0 002-3l-5-10V3"/><line x1="7.5" y1="14" x2="16.5" y2="14"/></Icono>,
  pinturas:     <Icono><path d="M18 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3z"/><path d="M6 3v18"/><path d="M3 8h6"/></Icono>,
  herramientas: <Icono><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></Icono>,
  instalacion:  <Icono><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></Icono>,
  proveedores:  <Icono><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></Icono>,
  alertas:      <Icono><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></Icono>,
  faltantes:    <Icono><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></Icono>,
  reportes:     <Icono><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></Icono>,
  usuarios:     <Icono><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></Icono>,
  catalogos:    <Icono><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><line x1="14" y1="17" x2="20" y2="17"/><line x1="17" y1="14" x2="17" y2="20"/></Icono>,
  integracion:  <Icono><rect x="2" y="3" width="8" height="8" rx="1"/><rect x="14" y="13" width="8" height="8" rx="1"/><path d="M10 7h4a2 2 0 012 2v4"/><polyline points="13 10 16 13 19 10"/></Icono>,
  simulador:    <Icono><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 21h8"/><polyline points="9 9 7 11 9 13"/><polyline points="15 9 17 11 15 13"/></Icono>,
  pedidos:      <Icono><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"/></Icono>,
  produccion:   <Icono><path d="M2 20h20"/><path d="M4 20V10l5 3V10l5 3V6l6 4v10"/></Icono>,
  admin:        <Icono><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></Icono>,
};

/**
 * Menú por grupos. `ver(rol)` repite las reglas de Sidebar.jsx (que a su vez siguen al backend).
 * `page` es el texto que activa el ítem, como en el menú actual (pathname.includes(page)).
 */
const MENU = [
  { id: 'panel', item: { page: 'dashboard', to: '/', label: 'Panel', icono: I.panel } },
  { id: 'stock', label: 'Stock', icono: I.productos, items: [
    { page: 'productos',   to: '/productos',             label: 'Productos',      icono: I.productos },
    { page: 'bodegas',     to: '/bodegas',               label: 'Bodegas',        icono: I.bodegas },
    { page: 'movimientos', to: '/movimientos/historial', label: 'Movimientos',    icono: I.movimientos },
    { page: 'conteos',     to: '/conteos',               label: 'Conteo cíclico', icono: I.conteos,
      ver: rol => ['gerencia', 'administrador', 'jop'].includes(rol) },
    { page: 'reservas',    to: '/reservas',              label: 'Reservas',       icono: I.reservas },
  ] },
  { id: 'produccion', label: 'Producción', icono: I.produccion, items: [
    { page: 'ordenes',      to: '/ordenes',              label: 'Órdenes de trabajo', icono: I.ordenes },
    { page: 'pedidos',      to: '/pedidos/checklist',    label: 'Checklist de OT',    icono: I.checklist },
    { page: 'recetas',      to: '/recetas',              label: 'Recetas',            icono: I.recetas },
    { page: 'pinturas',     to: '/pinturas/seguimiento', label: 'Pinturas',           icono: I.pinturas },
    { page: 'herramientas', to: '/herramientas',         label: 'Herramientas',       icono: I.herramientas },
  ] },
  { id: 'compras', label: 'Pedidos y compras', icono: I.pedidos, items: [
    { page: 'instalacion', to: '/instalacion',  label: 'Pedidos de instalación', icono: I.instalacion,
      ver: rol => ['gerencia', 'jop'].includes(rol) },
    { page: 'proveedores', to: '/proveedores',  label: 'Proveedores',            icono: I.proveedores },
  ] },
  { id: 'alertas', label: 'Alertas', icono: I.alertas, items: [
    { page: 'alertas',   to: '/alertas',           label: 'Alertas',   icono: I.alertas },
    { page: 'faltantes', to: '/alertas/faltantes', label: 'Faltantes', icono: I.faltantes },
  ] },
  { id: 'reportes', item: { page: 'reportes', to: '/reportes', label: 'Reportes', icono: I.reportes } },
  { id: 'admin', label: 'Administración', icono: I.admin, ver: rol => rol !== 'jop', items: [
    { page: 'usuarios',    to: '/usuarios',    label: 'Usuarios',    icono: I.usuarios },
    { page: 'catalogos',   to: '/catalogos',   label: 'Catálogos',   icono: I.catalogos, ver: rol => rol === 'gerencia' },
    // F-07 (#23): fuera del menú en producción; la página sigue disponible por URL
    { page: 'integracion', to: '/integracion', label: 'Integración', icono: I.integracion,
      ver: rol => import.meta.env.DEV && ['gerencia', 'administrador'].includes(rol) },
  ] },
  // CU-107: simulador solo en desarrollo, para cualquier rol
  { id: 'pruebas', label: 'Pruebas', icono: I.simulador, ver: () => import.meta.env.DEV, items: [
    { page: 'modulo-externo', to: '/pruebas/modulo-externo', label: 'Simulador de módulo', icono: I.simulador },
  ] },
];

export default function SidebarAgrupado({ mobileOpen, onOpenApodo, onOpenPass }) {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  // Grupo abierto a mano; vale solo para la ruta en que se abrió (al navegar manda la ruta)
  const [abierto, setAbierto] = useState({ id: null, pathname: null });

  // Restaurar estado colapsado guardado (body.sidebar-collapsed)
  useEffect(() => {
    if (localStorage.getItem(COLLAPSE_KEY) === 'true') {
      document.body.classList.add('sidebar-collapsed');
    }
    return () => document.body.classList.remove('sidebar-collapsed');
  }, []);

  // Cerrar menú de usuario al hacer clic fuera
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuOpen]);

  const toggleCollapse = () => {
    const collapsed = document.body.classList.toggle('sidebar-collapsed');
    localStorage.setItem(COLLAPSE_KEY, collapsed);
  };

  const activo = (page) => page === 'dashboard' ? pathname === '/' : pathname.includes(page);
  const visible = (x) => !x.ver || x.ver(user?.rol);

  const grupos = MENU
    .filter(visible)
    .map(g => g.items ? { ...g, items: g.items.filter(visible) } : g)
    .filter(g => g.item || g.items.length > 0);

  const grupoDeRuta = grupos.find(g => g.items?.some(i => activo(i.page)))?.id ?? null;
  const grupoAbierto = abierto.pathname === pathname ? abierto.id : grupoDeRuta;
  const alternar = (id) => setAbierto({ id: grupoAbierto === id ? null : id, pathname });

  const enlace = (i, hijo = false) => (
    <Link key={i.to} className={'sidebar-item' + (hijo ? ' sidebar-item-hijo' : ' sidebar-item-raiz') + (activo(i.page) ? ' active' : '')}
      to={i.to} data-tooltip={i.label}>
      {i.icono}
      <span className="sidebar-item-label">{i.label}</span>
    </Link>
  );

  return (
    <aside className={'sidebar sidebar-agrupado' + (mobileOpen ? ' open' : '')} id="sidebar">

      {/* Logo */}
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon con-imagen"><img src={LOGO_SIMBOLO} alt="" /></div>
        <div className="sidebar-logo-text">
          <div className="sidebar-logo-name">Puertas Blindadas</div>
          <div className="sidebar-logo-sub">Sistema de Inventario</div>
        </div>
      </div>

      <nav className="sidebar-nav">
        {grupos.map(g => g.item ? enlace(g.item) : (
          <section key={g.id} className={'sidebar-grupo' + (grupoAbierto === g.id ? ' abierto' : '')}>
            <button type="button" className="sidebar-grupo-btn" aria-expanded={grupoAbierto === g.id}
              aria-controls={`menu-grupo-${g.id}`} onClick={() => alternar(g.id)}>
              {g.icono}
              <span className="sidebar-grupo-label">{g.label}</span>
              <svg className="sidebar-grupo-flecha" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
            <div className="sidebar-grupo-items" id={`menu-grupo-${g.id}`}>
              {g.items.map(i => enlace(i, true))}
            </div>
          </section>
        ))}
      </nav>

      {/* Footer (igual que Sidebar.jsx) */}
      <div className="sidebar-footer">

        <div className="sidebar-toggle" id="sidebar-toggle-btn" title="Colapsar menú" onClick={toggleCollapse}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </div>

        <div
          className="sidebar-user-btn"
          id="sidebar-user-btn"
          onClick={e => { e.stopPropagation(); setMenuOpen(o => !o); }}
        >
          <div className="sidebar-avatar" id="sidebar-avatar">{getInitials(user)}</div>
          <div className="sidebar-user-info">
            <div className="sidebar-user-name" id="sidebar-user-name">{user?.apodo || user?.username || user?.nombre}</div>
            <div className="sidebar-user-role" id="sidebar-user-role">{getRoleLabel(user)}</div>
          </div>
        </div>

        <div className={'sidebar-user-menu' + (menuOpen ? ' open' : '')} id="sidebar-user-menu">
          <div className="sidebar-user-menu-item" id="menu-cambiar-apodo" onClick={() => { setMenuOpen(false); onOpenApodo(); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/>
              <circle cx="12" cy="7" r="4"/>
            </svg>
            Cambiar apodo
          </div>
          <div className="sidebar-user-menu-item" id="menu-cambiar-pass" onClick={() => { setMenuOpen(false); onOpenPass(); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0110 0v4"/>
            </svg>
            Cambiar contraseña
          </div>
          <div className="sidebar-user-menu-item danger" id="logout-btn" onClick={() => logout()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            Cerrar sesión
          </div>
        </div>

      </div>

    </aside>
  );
}
