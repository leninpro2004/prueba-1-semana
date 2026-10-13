import { Link } from 'react-router-dom';

/**
 * F-25a' (lineamientos de composición, secciones 3 y 4): tarjeta de indicador. El título identifica y el
 * número resume. Tono: 'naranja' (por defecto) o 'peligro' para la franja superior y el ícono.
 * Con `ruta`, la tarjeta completa lleva a la pantalla del indicador.
 */
export function KpiCard({ titulo, valor, periodo, icono, tono = 'naranja', ruta, descripcion }) {
  const contenido = (
    <>
      {icono && <span className="kpi2-icono">{icono}</span>}
      <p className="kpi2-titulo">{titulo}</p>
      <p className="kpi2-valor">{valor ?? '—'}</p>
      {periodo && <p className="kpi2-periodo">{periodo}</p>}
      {descripcion && <p className="kpi2-descripcion">{descripcion}</p>}
    </>
  );
  const clase = `kpi2 kpi2-${tono}`;
  return ruta
    ? <Link to={ruta} className={clase}>{contenido}</Link>
    : <article className={clase}>{contenido}</article>;
}

/** Grilla de indicadores: 1 columna en móvil, 2 en tablet, 4 en escritorio. */
export function KpiGrid({ children }) {
  return <section className="kpi2-grid">{children}</section>;
}
