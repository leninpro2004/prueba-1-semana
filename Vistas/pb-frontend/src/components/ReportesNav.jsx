import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

/**
 * B-08: navegación única entre reportes (pestañas arriba de cada reporte y el índice /reportes).
 * `roles` repite la regla del backend (routes/reportes.js); null = todos los roles.
 * `grupo` y `icono` los usa el índice (tarjetas agrupadas por tema).
 */
const icono = (...trazos) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
       aria-hidden="true">{trazos.map((d, i) => <path key={i} d={d} />)}</svg>
);

export const GRUPOS_REPORTES = ['Stock', 'Producción', 'Valor del inventario'];

export const REPORTES = [
  { ruta: '/reportes/movimientos', titulo: 'Movimientos', roles: null, grupo: 'Stock',
    descripcion: 'Entradas, salidas y traslados por período.',
    icono: icono('M7 10h14l-4-4', 'M17 14H3l4 4') },
  { ruta: '/reportes/mermas', titulo: 'Mermas', roles: null, grupo: 'Stock',
    descripcion: 'Pérdidas, daños y productos no recuperables.',
    icono: icono('M4 7h16', 'M10 11v6M14 11v6', 'M5 7l1 12a2 2 0 002 2h8a2 2 0 002-2l1-12', 'M9 7V4h6v3') },
  { ruta: '/reportes/rotacion', titulo: 'Rotación', roles: ['gerencia', 'jop'], grupo: 'Stock',
    descripcion: 'Frecuencia de uso, para detectar stock que no se mueve.',
    icono: icono('M20 11a8 8 0 00-14.9-3M4 4v4h4', 'M4 13a8 8 0 0014.9 3M20 20v-4h-4') },
  { ruta: '/reportes/consumo-area', titulo: 'Consumo por área', roles: null, grupo: 'Producción',
    descripcion: 'Materiales consumidos por cada área de trabajo.',
    icono: icono('M3 21h18', 'M5 21V10l5 3v-3l5 3V5h4v16') },
  { ruta: '/reportes/programacion', titulo: 'Programación semanal', roles: null, grupo: 'Producción',
    descripcion: 'Órdenes de trabajo de la semana con sus materiales.',
    icono: icono('M6 5h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2z', 'M16 3v4M8 3v4M4 11h16') },
  { ruta: '/reportes/desviaciones', titulo: 'Desviaciones', roles: ['gerencia', 'jop'], grupo: 'Producción',
    descripcion: 'Dónde se gasta más de lo estimado en las OT.',
    icono: icono('M3 17l6-6 4 4 8-8', 'M14 7h7v7') },
  { ruta: '/reportes/valorizacion', titulo: 'Valorización', roles: ['gerencia'], grupo: 'Valor del inventario',
    descripcion: 'Valor económico del stock actual.',
    icono: icono('M12 3a9 9 0 110 18 9 9 0 010-18z', 'M14.8 9a2 2 0 00-1.8-1h-2a2 2 0 000 4h2a2 2 0 010 4h-2a2 2 0 01-1.8-1', 'M12 6v2m0 8v2') },
  { ruta: '/reportes/historico', titulo: 'Histórico', roles: ['gerencia'], grupo: 'Valor del inventario',
    descripcion: 'Valor del inventario al cierre de cada período.',
    icono: icono('M4 19h16', 'M4 15l4-6 4 2 4-5 4 4') },
];

/** Reportes que puede abrir el usuario. */
export const reportesPara = (user) => REPORTES.filter(r => !r.roles || r.roles.includes(user?.rol));

export default function ReportesNav() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  return (
    <nav className="tabs tabs-scroll" aria-label="Reportes" style={{ marginBottom: 16 }}>
      <Link to="/reportes" className={'tab' + (pathname === '/reportes' ? ' active' : '')}>Todos</Link>
      {reportesPara(user).map(r => (
        <Link key={r.ruta} to={r.ruta} className={'tab' + (pathname.startsWith(r.ruta) ? ' active' : '')}>{r.titulo}</Link>
      ))}
    </nav>
  );
}
